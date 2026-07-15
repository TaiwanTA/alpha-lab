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
// On failure the claim is always released back to `active` so the
// next DAG run (or the next retry) can pick it up. The script
// writes its own `research_runs.id` to stdout for downstream
// observability; failures exit non-zero with no stdout payload so
// Dagu's retry policy kicks in.
//
// Exit discipline mirrors `migrate-phase4.ts` and `ingest-events.ts`:
// throw on missing env / config, set `process.exitCode = 1` in
// catch, and `await closeDb()` in `finally` so the connection pool
// is always flushed before the process dies.

import matter from "gray-matter";

import {
  buildPiResearchRuntime,
  assertRunPersisted,
  subscribeToolEvents,
  type PiResearchRunResult,
} from "./phase4/pi-research.ts";
import {
  type HindsightClient,
  loadHindsightConfig,
  createHindsightClient,
} from "./phase4/hindsight.ts";
import {
  type TwelveDataClient,
  loadTwelveDataConfig,
  createTwelveDataClient,
} from "./phase4/twelve-data.ts";
import {
  LedgerDb,
  closeDb,
  type SignalEventRow,
} from "./phase4/db.ts";
import type { RecordResearchInput } from "./phase4/tools.ts";

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

/** Render the agent's final tool transcript as plain lines. Used for
 *  Dagu's per-run log; the script's stdout is reserved for the run
 *  ID. */
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

/** Pull the citation list from the trailing `## 來源` section if
 *  present; otherwise synthesize a single-element list from the
 *  event's source URL so the candidate never lands with zero
 *  citations. */
function deriveCitations(
  event: SignalEventRow,
  candidateMarkdown: string,
): string[] {
  const match = candidateMarkdown.match(
    /##\s*來源\s*\n([\s\S]*?)(?:\n##\s|$)/,
  );
  const fromSources = match
    ? Array.from(match[1].matchAll(/https?:\/\/\S+/g)).map((m) => m[0])
    : [];
  const filtered = fromSources.filter((u) => u.length > 0);
  if (filtered.length > 0) return filtered;
  return [event.source_url];
}

function directionFromFrontmatter(value: unknown): "long" | "short" | null {
  if (value === "long" || value === "short") return value;
  return null;
}

function tickerFromFrontmatter(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toUpperCase();
  if (trimmed.length === 0) return null;
  // Accept comma-separated tickers by taking the first.
  return trimmed.split(/[,\s]+/)[0] ?? null;
}

function confidenceFromFrontmatter(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < 0 || value > 1) return null;
    return value;
  }
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n) && n >= 0 && n <= 1) return n;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claim + release
// ---------------------------------------------------------------------------

interface ClaimedEvent {
  event: SignalEventRow;
  release: () => Promise<void>;
}

async function claimOneEvent(): Promise<ClaimedEvent | null> {
  const event = await LedgerDb.EventRecord.claimNextActive();
  if (!event) return null;
  return {
    event,
    release: async () => {
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
// Persist a `research_runs` row from the agent's final candidate.
// ---------------------------------------------------------------------------

async function persistResearchRun(
  event: SignalEventRow,
  parsed: matter.GrayMatterFile<string>,
): Promise<string> {
  const fm = parsed.data as Record<string, unknown>;
  const bodyText = parsed.content.trim();
  const firstLine = bodyText.split("\n")[0] ?? "";
  const summaryText = typeof fm.summary === "string" ? fm.summary : "";
  const thesis = summaryText.length > 0 ? summaryText : firstLine.slice(0, 280);
  const ticker = tickerFromFrontmatter(fm.tickers);
  const direction =
    directionFromFrontmatter(fm.direction) ?? "long";
  const confidence =
    confidenceFromFrontmatter(fm.confidence) ??
    (typeof fm.investmentClaim === "boolean"
      ? fm.investmentClaim
        ? 0.6
        : 0.2
      : 0.5);
  const citations = deriveCitations(event, parsed.content);
  const candidateMarkdown = matter.stringify(parsed.content, fm);
  const rationale = summaryText.length > 0 ? summaryText : "see candidate body";
  const input: RecordResearchInput = {
    eventId: event.id,
    thesis,
    ticker: ticker ?? "UNKNOWN",
    direction,
    confidence,
    rationale,
    sourceCitations: citations,
    candidateMarkdown,
  };
  const runId = await LedgerDb.ResearchRun.insert({
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
  return runId;
}

// ---------------------------------------------------------------------------
// Agent prompt
// ---------------------------------------------------------------------------

function buildPrompt(event: SignalEventRow): string {
  return [
    "You are researching one signal_event.",
    `event_id: ${event.id}`,
    `investor: ${event.investor}`,
    `source_url: ${event.source_url}`,
    `published_at: ${event.published_at.toISOString()}`,
    `raw_content: ${event.raw_content}`,
    "",
    "Procedure:",
    "1. Call read_event to confirm the payload above.",
    "2. Call recall_memory with a focused query derived from the raw_content.",
    "3. Call retain_event_memory with your distilled observation (content + context).",
    "4. Call lookup_adjusted_close for any ticker you intend to cite.",
    "5. Call record_research exactly once with the final thesis, ticker,",
    "   direction (long/short), confidence in [0,1], rationale, sourceCitations,",
    "   and candidateMarkdown. The candidateMarkdown MUST start with YAML",
    "   frontmatter (`---` ... `---`) and end with a `## 來源` section that",
    "   lists every URL you cite.",
    "",
    "Do not call any other tool. Do not call record_research twice.",
  ].join("\n");
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
    // can echo it to stdout.
    const sink = async (input: RecordResearchInput): Promise<{ id: string }> => {
      const parsed = matter(input.candidateMarkdown);
      const runId = await persistResearchRun(claimed.event, parsed);
      persistedRunId = runId;
      return { id: runId };
    };

    const runtime = buildPiResearchRuntime({
      eventId: claimed.event.id,
      hindsight,
      twelveData,
      recordResearch: sink,
    });
    const agent = runtime.buildAgent();
    const { toolEvents } = subscribeToolEvents(agent);
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
    for (const line of renderLogLines(
      claimed.event,
      finalResult,
      persistedRunId,
    )) {
      console.log(line);
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
