#!/usr/bin/env bun
// automation/scripts/research-next-event.ts
//
// Phase 4 Task 3 research CLI. Dagu's `research-next-event` DAG
// step invokes this script on a bounded-retry schedule.
//
// The script atomically claims one `signal_events` row that is
// still in the `active` status, runs the pi-agent-core research
// agent with the allowlisted toolkit, and persists exactly one
// `research_runs` row.
//
// The CLI does NOT re-derive the persisted row's thesis / ticker /
// direction / confidence / citations from the candidate frontmatter.
// It forwards the structured `record_research` arguments straight to
// the DB sink — the agent is the source of truth for those values.
//
// On failure the claim is always released back to `active` so the
// next DAG run (or the next retry) can pick it up. The script writes
// its own `research_runs.id` to stdout and ALL OTHER OUTPUT to
// stderr, so Dagu's stdout-only run-id consumer never sees log
// noise interleaved with the id.
//
// Exit discipline mirrors `migrate-phase4.ts` and `ingest-events.ts`:
// throw on missing env / config, set `process.exitCode = 1` in
// catch, and `await closeDb()` in `finally` so the connection pool
// is always flushed before the process dies.

import {
  buildPiResearchRuntime,
  assertRunPersisted,
  subscribeMaxStepsGuard,
  subscribeToolEvents,
  type PiResearchRunResult,
  type ResearchEventPayload,
} from "../agents/research.ts";
import { buildPrompt } from "../agents/research.ts";
import {
  type HindsightClient,
  loadHindsightConfig,
  createHindsightClient,
} from "../lib/hindsight.ts";
import {
  type TwelveDataClient,
  loadTwelveDataConfig,
  createTwelveDataClient,
} from "../lib/twelve-data.ts";
import {
  LedgerDb,
  closeDb,
  type SignalEventRow,
} from "../lib/db.ts";
import type { RecordResearchInput } from "../tools/index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return v;
}

function signalEventToPayload(event: SignalEventRow): ResearchEventPayload {
  return {
    id: event.id,
    investor: event.investor,
    sourceUrl: event.source_url,
    rawContent: event.raw_content,
    publishedAt: event.published_at,
    capturedAt: event.captured_at,
  };
}

/** Render the agent's final tool transcript as plain lines. Sent to
 *  STDERR — stdout is reserved for the run ID. */
function renderLogLines(
  event: SignalEventRow,
  result: PiResearchRunResult,
  persistedRunId: string | null,
): string[] {
  const out: string[] = [];
  out.push(
    `research-next-event: event_id=${event.id} investor=${event.investor}`,
  );
  out.push(
    `  model=minimax/MiniMax-M3 tool_events=${result.toolEvents.length} ` +
      `error=${result.errorMessage ?? "none"}`,
  );
  for (const evt of result.toolEvents) {
    out.push(
      `  tool=${evt.toolName} is_error=${evt.isError ? "true" : "false"}`,
    );
  }
  if (persistedRunId) {
    out.push(`  persisted_run_id=${persistedRunId}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Claim + release
// ---------------------------------------------------------------------------

interface ClaimedEvent {
  event: SignalEventRow;
  release: () => Promise<void>;
}

async function claimOneEvent(): Promise<ClaimedEvent | null> {
  // Defence in depth: skip events that already have an active
  // research_runs row (status IN ('accepted', 'processing')) even
  // if their signal_events.status somehow reverted to active. The
  // accepted-derived `processing` state is owned by a worker that
  // has called `claimNextPending`; reactivating the event while
  // that run is in flight would re-open a race window where a
  // parallel retry could insert a second accepted research_runs
  // row before the partial index re-engages.
  const event = await LedgerDb.EventRecord.claimNextActive();
  if (!event) return null;
  return {
    event,
    release: async () => {
      // Only release if no active run landed in the meantime
      // (status IN ('accepted', 'processing')). If the unique
      // partial index caught a duplicate race, leave the row in
      // `processing` — the next claim cycle will skip it via
      // the NOT EXISTS CTE and an operator can clean it up.
      const hasActive = await LedgerDb.ResearchRun.hasActiveRunForEvent(
        event.id,
      );
      if (hasActive) return;
      try {
        await LedgerDb.EventRecord.releaseToActive(event.id);
      } catch {
        // Best effort — if the release fails the row stays in
        // `processing`. A future Task 4 worker can sweep stale
        // processing rows. Swallow so we don't mask the original
        // failure.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Persist a `research_runs` row from the agent's structured
// `record_research` arguments. The CLI does NOT re-parse the
// candidate markdown frontmatter; the agent's typed arguments are
// the source of truth.
// ---------------------------------------------------------------------------

async function persistResearchRun(
  event: SignalEventRow,
  input: RecordResearchInput,
): Promise<string> {
  return LedgerDb.ResearchRun.insert({
    event_id: event.id,
    model: "minimax/MiniMax-M3",
    prompt_version: "phase4-task3-v1",
    thesis: input.thesis,
    ticker: input.ticker,
    direction: input.direction,
    confidence: input.confidence,
    rationale: input.rationale,
    source_citations: input.sourceCitations,
    candidate_markdown: input.candidateMarkdown,
    status: "accepted",
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  process.env.DATABASE_URL = databaseUrl;
  const hindsightCfg = loadHindsightConfig();
  const twelveCfg = loadTwelveDataConfig();
  const hindsight: HindsightClient = createHindsightClient(hindsightCfg);
  const twelveData: TwelveDataClient = createTwelveDataClient(twelveCfg);

  const claimed = await claimOneEvent();
  if (!claimed) {
    // Nothing to do — Dagu treats exit 0 as success, no run written.
    process.stdout.write("no-claim\n");
    return;
  }

  let persistedRunId: string | null = null;
  try {
    // Sink that persists the run AND captures the returned id so we
    // can echo it to stdout. The agent's structured arguments are
    // forwarded verbatim — no markdown reparse.
    const sink = async (
      input: RecordResearchInput,
    ): Promise<{ id: string }> => {
      const runId = await persistResearchRun(claimed.event, input);
      persistedRunId = runId;
      return { id: runId };
    };

    const runtime = buildPiResearchRuntime({
      eventId: claimed.event.id,
      event: signalEventToPayload(claimed.event),
      hindsight,
      twelveData,
      recordResearch: sink,
    });
    const agent = runtime.buildAgent();
    const { toolEvents } = subscribeToolEvents(agent);
    subscribeMaxStepsGuard(agent);
    await agent.prompt(buildPrompt(claimed.event));
    await agent.waitForIdle();

    const finalResult: PiResearchRunResult = {
      toolEvents,
      errorMessage: agent.state.errorMessage,
      persistedRun: persistedRunId ? { id: persistedRunId } : null,
    };
    assertRunPersisted(
      agent,
      finalResult.toolEvents,
      finalResult.persistedRun,
    );
    // ALL non-run-id output goes to stderr so stdout is reserved for
    // the run id (or the no-claim sentinel).
    for (const line of renderLogLines(
      claimed.event,
      finalResult,
      persistedRunId,
    )) {
      console.error(line);
    }
    process.stdout.write(`${persistedRunId}\n`);
  } catch (err) {
    await claimed.release();
    throw err;
  }
}

main()
  .catch((err) => {
    console.error(
      `research-next-event: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });