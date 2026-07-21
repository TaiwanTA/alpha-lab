#!/usr/bin/env bun
// automation/commands/research-signals.ts
//
// 每則訊號的研究 CLI。取代 research-next-event.ts。
// 認領一則訊號（而非事件），讀取其 items + timeline，
// 執行 pi-agent-core 研究代理，持久化 research_run，
// 並更新訊號的 description（living description）。
//
// CLI 接受 --priority (high|low) 旗標，控制要認領哪個優先級的訊號。
// 高優先級訊號每日研究；低優先級每 2 日研究。
//
// stdout 只輸出 run ID（或 no-claim sentinel）；所有日誌寫至 stderr。

import {
  buildPiResearchRuntime,
  assertRunPersisted,
  subscribeMaxStepsGuard,
  subscribeToolEvents,
  buildPrompt,
  type PiResearchRunResult,
} from "../agents/research.ts";
import {
  SignalRecord,
  ResearchRun,
  closeDb,
  type SignalRow,
  type ItemRow,
  type ResearchRunRow,
} from "../lib/db.ts";
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

// ---------------------------------------------------------------------------
// Claim a signal
// ---------------------------------------------------------------------------

interface ClaimedSignal {
  signal: SignalRow;
  items: ItemRow[];
  timeline: ResearchRunRow[];
}

async function claimOneSignal(
  priority: "high" | "low",
): Promise<ClaimedSignal | null> {
  // 列出該優先級的所有活躍訊號,逐一嘗試原子性鎖定。
  // tryClaimForResearch 插入一筆 processing research_run,
  // 利用 partial unique index 防止併發 worker 同時認領同一 signal。
  const signals = await SignalRecord.listByPriority(priority);

  for (const signal of signals) {
    const claimed = await ResearchRun.tryClaimForResearch(signal.id);
    if (!claimed) continue;

    const [items, timeline] = await Promise.all([
      SignalRecord.getItems(signal.id),
      SignalRecord.getTimeline(signal.id),
    ]);
    return { signal, items, timeline };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Persist a research_runs row from the agent's structured
// record_research arguments. The CLI does NOT re-parse the
// candidate markdown frontmatter; the agent's typed arguments are
// the source of truth.
// ---------------------------------------------------------------------------

async function persistResearchRun(
  signal: SignalRow,
  input: RecordResearchInput,
): Promise<string> {
  // finalizeClaim 更新 tryClaimForResearch 建立的 processing 列,
  // 而非插入新列(避免與 unique index 衝突)。
  const runId = await ResearchRun.finalizeClaim(signal.id, {
    model: "MiniMax-M3",
    prompt_version: "signal-layer-v1",
    thesis: input.thesis,
    ticker: input.ticker,
    direction: input.direction,
    confidence: input.confidence,
    rationale: input.rationale,
    source_citations: input.sourceCitations,
    candidate_markdown: input.candidateMarkdown ?? "",
    published_path: null,
    status: "accepted",
  });
  if (!runId) throw new Error("no processing research_run found for signal (race or stale claim)");
  return runId;
}

/** 研究完成後附加狀態日誌到訊號 description（不覆蓋原始內容）。
 *  使用 append 而非 overwrite,保留分類階段產生的訊號敘述。 */
async function updateSignalDescription(
  signal: SignalRow,
  result: PiResearchRunResult,
): Promise<void> {
  const logEntry = result.errorMessage
    ? `研究失敗：${result.errorMessage.slice(0, 200)}`
    : `最近研究完成，tool_events=${result.toolEvents.length}。`;
  await SignalRecord.appendToDescription(signal.id, logEntry);
}

/** Render the agent's final tool transcript as plain lines. Sent to
 *  STDERR — stdout is reserved for the run ID. */
function renderLogLines(
  signal: SignalRow,
  result: PiResearchRunResult,
  persistedRunId: string | null,
): string[] {
  const out: string[] = [];
  out.push(
    `research-signals: signal_id=${signal.id} title=${signal.title}`,
  );
  out.push(
    `  priority=${signal.priority} model=MiniMax-M3 ` +
      `tool_events=${result.toolEvents.length} ` +
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = requireEnv("DATABASE_URL");
  process.env.DATABASE_URL = databaseUrl;
  const hindsightCfg = loadHindsightConfig();
  const twelveCfg = loadTwelveDataConfig();
  const hindsight: HindsightClient = createHindsightClient(hindsightCfg);
  const twelveData: TwelveDataClient = createTwelveDataClient(twelveCfg);

  // 解析 --priority 旗標
  const priorityArg = process.argv.includes("--priority")
    ? process.argv[process.argv.indexOf("--priority") + 1]
    : "high";
  if (priorityArg !== "high" && priorityArg !== "low") {
    throw new Error(`invalid --priority value: ${priorityArg} (expected high|low)`);
  }
  const priority = priorityArg as "high" | "low";

  const claimed = await claimOneSignal(priority);
  if (!claimed) {
    // 沒有可認領的訊號 — exit 0，不寫入任何 run。
    process.stdout.write("no-claim\n");
    return;
  }

  let persistedRunId: string | null = null;
  try {
    const sink = async (
      input: RecordResearchInput,
    ): Promise<{ id: string }> => {
      const runId = await persistResearchRun(claimed.signal, input);
      persistedRunId = runId;
      return { id: runId };
    };

    // 建構代理 runtime — eventId 仍使用 signal.id，
    // event payload 從第一個 item 組裝（read_event 需要）。
    const firstItem = claimed.items[0];
    const runtime = buildPiResearchRuntime({
      eventId: claimed.signal.id,
      event: {
        id: claimed.signal.id,
        investor: firstItem?.investor ?? "unknown",
        sourceUrl: firstItem?.source_url ?? "",
        rawContent: claimed.items.map((i) => i.raw_content).join("\n---\n"),
        publishedAt: firstItem?.published_at ?? new Date(),
        capturedAt: firstItem?.captured_at ?? new Date(),
      },
      hindsight,
      twelveData,
      recordResearch: sink,
    });
    const agent = runtime.buildAgent();
    const { toolEvents } = subscribeToolEvents(agent);
    subscribeMaxStepsGuard(agent);
    await agent.prompt(
      buildPrompt(claimed.signal, claimed.items, claimed.timeline),
    );
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

    // 更新訊號 description — living description 反映當前狀態
    await updateSignalDescription(claimed.signal, finalResult);

    // ALL non-run-id output goes to stderr so stdout is reserved for
    // the run id (or the no-claim sentinel).
    for (const line of renderLogLines(
      claimed.signal,
      finalResult,
      persistedRunId,
    )) {
      console.error(line);
    }
    process.stdout.write(`${persistedRunId}\n`);
  } catch (err) {
    // 研究失敗 — 釋放 processing claim,讓 signal 可被下次認領
    await ResearchRun.releaseFailedClaim(claimed.signal.id);
    console.error(
      `research-signals: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(
      `research-signals: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
