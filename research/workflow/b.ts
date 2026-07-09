// B workflow 包裝:訊號發現邏輯 inline,跑完後對每個新 signal trigger C workflow run。
//
// 為什麼 inline(而不 import agent/b.ts 的 discover / getDefaultDeps):
//   workflow SDK 的 node-module-error plugin 在 esbuild tree-shake 之前掃整個
//   import graph。agent/b.ts 內有 `const bLog = createLogger("B")` module-level
//   side-effect → 拉 lib/logger.ts → lib/logger.ts module-level imports node:os /
//   node:fs / node:path / @loglayer/transport-log-file-rotation。整 chain 被 plugin
//   報 "You are attempting to use node:*" 拒絕 build。
//   spec 寫的 import 模式沒考慮 plugin 嚴格性,實際 viable 路徑是 inline 業務邏輯
//   到這檔(跟 a.ts pattern 一致)。agent/b.ts 的 CLI path 不動,只是 workflow
//   path 走自己 inline 版本。
//
// 設計:
//   - bWorkflow() "use workflow" orchestrate 兩個 step
//   - discoverStep() "use step" 跑 discover 業務邏輯(回傳 DiscoverResult 含 newSignalIds)
//   - triggerCForNewSignals() "use step" 對每個 signal start cWorkflow run,SDK 規定
//     start() 必須在 step function 內才可從 workflow 內呼叫
//
// 用 console.log 而非 loglayer:console 走 Node stdout,systemd 撈得到;
// 不引 lib/logger 是因為 logger module-level import node:fs 等,plugin 會報錯。

import { getUnprocessedItems, getActiveSignals, insertSignal, markItemsProcessed, initDb } from "../lib/db.ts";
import { ask } from "../agent/lib/llm.ts";
import type { AskResult } from "../agent/lib/llm.ts";
import type { ItemRow, Signal } from "../lib/types.ts";
import { start } from "workflow/api";
import { cWorkflow } from "./c.ts";

const MAX_ITEMS_PER_RUN = 50;

const SYSTEM_PROMPT = `You are a market signal discovery agent for an investor research project.

You will receive:
1. A list of recent tweets from sources this project tracks.
2. Active signals this project is already tracking (DO NOT create duplicates of these).

Your job: identify which tweets, alone or as a cluster, represent a NEW market signal worth long-term tracking.

What counts as a market signal:
- Specific stock/company: Ackman takes / mentions / discusses a position on NVDA
- Macro thesis: Ackman comments on Fed policy, rates, inflation
- Industry thesis: Ackman says something material about a sector (e.g., AI infra)
- Geopolitical: Ackman comments on tariffs, China, etc
- Strategy shift: Ackman publicly changes approach

What does NOT count as a signal:
- Generic tweets not tied to an investment thesis
- Pure retweets of others' content (no original thesis)
- Small talk, personal announcements, emoji-only replies
- Anything already covered by an active signal below

Output strictly this JSON shape (no markdown, no explanation outside JSON):
{
  "signals": [
    {
      "title": "短名 (<80 chars)",
      "description": "為什麼這是訊號 / 值得追蹤什麼,1-3 sentences",
      "importance": 1-5,
      "tags": ["tag1", "tag2"],
      "source_item_ids": ["external_id_1", "external_id_2"]
    }
  ]
}

If no new signals worth tracking, output: {"signals": []}`;

interface ValidatedCandidate {
  title: string;
  description: string;
  importance: 1 | 2 | 3 | 4 | 5;
  tags: string[];
  source_item_ids: string[];
}

function validateCandidate(raw: unknown):
  | { ok: true; value: ValidatedCandidate }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "candidate is not an object" };
  }
  const c = raw as Record<string, unknown>;

  if (typeof c.title !== "string" || c.title.length === 0 || c.title.length > 80) {
    return { ok: false, error: `invalid title: ${typeof c.title}` };
  }
  if (typeof c.description !== "string" || c.description.length === 0) {
    return { ok: false, error: `invalid description: ${typeof c.description}` };
  }
  if (c.description.length > 800) {
    return { ok: false, error: `description too long (${c.description.length} > 800)` };
  }
  const importanceNum = typeof c.importance === "string"
    ? Number(c.importance)
    : c.importance;
  if (
    typeof importanceNum !== "number" ||
    !Number.isInteger(importanceNum) ||
    importanceNum < 1 ||
    importanceNum > 5
  ) {
    return {
      ok: false,
      error: `importance must be integer 1-5, got: ${JSON.stringify(c.importance)}`,
    };
  }
  if (!Array.isArray(c.tags) || !c.tags.every((t) => typeof t === "string")) {
    return { ok: false, error: "tags invalid" };
  }
  if (
    !Array.isArray(c.source_item_ids) ||
    !c.source_item_ids.every((t) => typeof t === "string") ||
    (c.source_item_ids as string[]).length === 0
  ) {
    return { ok: false, error: "source_item_ids invalid or empty" };
  }

  return {
    ok: true,
    value: {
      title: c.title,
      description: c.description,
      importance: importanceNum as 1 | 2 | 3 | 4 | 5,
      tags: c.tags as string[],
      source_item_ids: c.source_item_ids as string[],
    },
  };
}

function buildUserPrompt(items: ItemRow[], activeSignals: Signal[]): string {
  const signalList = activeSignals.length === 0
    ? "(none yet)"
    : activeSignals.map((s) => `- ${s.title}: ${s.description}`).join("\n");
  const itemList = items.map((i) => `[${i.external_id}] ${i.context}`).join("\n\n---\n\n");
  return `Active signals already tracked (avoid duplicates):
${signalList}

Recent tweets to analyze:
${itemList}

Respond with JSON only.`;
}

interface DiscoverStepResult {
  itemsProcessed: number;
  newSignals: number;
  newSignalIds: string[];
}

// discover 業務邏輯,inline 進 step。
// 跟 agent/b.ts::discover 行為等價,但不 import lib/logger。
async function discoverLogic(): Promise<DiscoverStepResult> {
  const items = await getUnprocessedItems(MAX_ITEMS_PER_RUN);
  if (items.length === 0) {
    console.log("[B-workflow] no unprocessed items");
    return { itemsProcessed: 0, newSignals: 0, newSignalIds: [] };
  }
  const active = await getActiveSignals();
  console.log(`[B-workflow] items=${items.length} active_signals=${active.length}`);

  const userPrompt = buildUserPrompt(items, active);
  const llmResult: AskResult = await ask(userPrompt, {
    system: SYSTEM_PROMPT,
    json: true,
    temperature: 0.3,
    maxTokens: 2000,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : err}. Content: ${llmResult.content.slice(0, 300)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `LLM JSON root is not an object. Content: ${llmResult.content.slice(0, 300)}`,
    );
  }
  const signalsField = (parsed as Record<string, unknown>).signals;
  if (!Array.isArray(signalsField)) {
    throw new Error(
      `LLM JSON missing 'signals' array. Content: ${llmResult.content.slice(0, 300)}`,
    );
  }
  const knownIds = new Set(items.map((i) => i.external_id));

  let newSignals = 0;
  const newSignalIds: string[] = [];
  for (const candidate of signalsField) {
    const validation = validateCandidate(candidate);
    if (!validation.ok) {
      console.log(`[B-workflow] skipping invalid candidate: ${validation.error}`);
      continue;
    }
    const valid = validation.value;
    const validItemIds = valid.source_item_ids.filter((id) => knownIds.has(id));
    if (validItemIds.length === 0) {
      console.log(`[B-workflow] skipping signal ${valid.title}: all source_item_ids unknown`);
      continue;
    }
    try {
      const created = await insertSignal({
        title: valid.title,
        description: valid.description,
        importance: valid.importance,
        tags: valid.tags,
        source_items: validItemIds,
      });
      newSignals++;
      if (created && typeof created.id === "string" && created.id.length > 0) {
        newSignalIds.push(created.id);
      }
    } catch (err) {
      console.log(`[B-workflow] failed to insert signal ${valid.title}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // mark items processed by source_type
  const bySourceType = new Map<string, string[]>();
  for (const item of items) {
    const ids = bySourceType.get(item.source_type) ?? [];
    ids.push(item.external_id);
    bySourceType.set(item.source_type, ids);
  }
  for (const [sourceType, ids] of bySourceType) {
    await markItemsProcessed(sourceType, ids);
  }

  console.log(`[B-workflow] done items_processed=${items.length} new_signals=${newSignals}`);
  return { itemsProcessed: items.length, newSignals, newSignalIds };
}

// use step:SDK 觀察 + retry 包裝
async function discoverStep(): Promise<DiscoverStepResult> {
  "use step";
  await initDb();
  return await discoverLogic();
}

// 包 start(cWorkflow, [signalId]) 在 step 內 — SDK 規定從 workflow 內呼叫
// start() 必須在 step function 內才被 runtime 認成 child run
async function triggerCForNewSignals(signalIds: string[]): Promise<string[]> {
  "use step";
  const runIds: string[] = [];
  const failed: string[] = [];
  // 其中一個 signal trigger 失敗不中斷後續,繼續 trigger 剩下的
  // (Kilo PR #10 + Gemini:DB / 網路暫時性錯誤不該 block 其他 signals)
  for (const signalId of signalIds) {
    try {
      const run = await start(cWorkflow, [signalId]);
      runIds.push(run.runId);
      console.log(`[B-workflow] triggered C for signal=${signalId} run_id=${run.runId}`);
    } catch (err) {
      failed.push(signalId);
      console.error(
        `[B-workflow] failed to trigger C for signal=${signalId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  // Kilo PR #10 iter 2:若全部 trigger 都失敗(例如 SDK bundle 缺、workflow-plugin 沒載),
  // 代表系統性問題,往上 throw 讓 bWorkflow 中斷並進 workflow_runs 表的 failed 狀態;
  // 個別 signal 失敗還是容忍不中斷
  if (signalIds.length > 0 && failed.length === signalIds.length) {
    throw new Error(
      `all ${signalIds.length} C workflow triggers failed; signalIds=${signalIds.join(",")}`,
    );
  }
  return runIds;
}

// orchestrator:先跑 discover,再對每個新 signal trigger C workflow
export async function bWorkflow(): Promise<{
  itemsProcessed: number;
  newSignals: number;
  newSignalIds: string[];
  cRunIds: string[];
}> {
  "use workflow";
  const result = await discoverStep();
  const cRunIds = result.newSignalIds.length > 0
    ? await triggerCForNewSignals(result.newSignalIds)
    : [];
  console.log(
    `[B-workflow] done items=${result.itemsProcessed} new_signals=${result.newSignals} c_runs=${cRunIds.length}`,
  );
  return {
    itemsProcessed: result.itemsProcessed,
    newSignals: result.newSignals,
    newSignalIds: result.newSignalIds,
    cRunIds,
  };
}
