// B agent:訊號發現
//   1. 從 items 表拿「未處理」的 tweets
//   2. 把 active signals(已追蹤)列出來,告訴 LLM「這些已存在避免重複」
//   3. 喂 LLM 分析「哪些 tweets 代表值得長期追蹤的新市場訊號」
//   4. LLM 回 JSON,逐一存進 signals 表
//   5. 標記 items processed_at = now()(不管有沒有建新 signals,被 B agent 處理過就標)
//
// 不做研究(C part)、不寫報告(D part)、不抓 X(pipeline A part 已做)。

import { ask } from "./lib/llm.ts";
import type { AskResult } from "./lib/llm.ts";
import type { SignalCandidate } from "./lib/types.ts";
import type { ItemRow, Signal } from "../lib/types.ts";
import {
  initDb,
  getUnprocessedItems,
  getActiveSignals,
  insertSignal,
  markItemsProcessed,
} from "../lib/db.ts";

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

interface LlmSignalResponse {
  signals: SignalCandidate[];
}

// B agent 用到的所有外部依賴,集中定義方便測試注入
export interface BDependencies {
  getUnprocessedItems: (limit: number) => Promise<ItemRow[]>;
  getActiveSignals: () => Promise<Signal[]>;
  insertSignal: (signal: {
    title: string;
    description: string;
    importance: 1 | 2 | 3 | 4 | 5;
    tags: string[];
    source_items: string[];
  }) => Promise<unknown>;
  markItemsProcessed: (sourceType: string, externalIds: string[]) => Promise<void>;
  ask: (prompt: string, options?: {
    system?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    timeout?: number;
  }) => Promise<AskResult>;
}

export interface DiscoverResult {
  itemsProcessed: number;
  newSignals: number;
}

function buildUserPrompt(
  items: ItemRow[],
  activeSignals: Signal[],
): string {
  const signalList = activeSignals.length === 0
    ? "(none yet)"
    : activeSignals.map((s) => `- ${s.title}: ${s.description}`).join("\n");

  const itemList = items
    .map((i) => `[${i.external_id}] ${i.context}`)
    .join("\n\n---\n\n");

  return `Active signals already tracked (avoid duplicates):
${signalList}

Recent tweets to analyze:
${itemList}

Respond with JSON only.`;
}

// 主要 B agent 函式
// 接受 deps injection,讓測試可以注入 mock
export async function discover(deps: BDependencies): Promise<DiscoverResult> {
  // 1. 拿未處理 items
  const items = await deps.getUnprocessedItems(MAX_ITEMS_PER_RUN);
  if (items.length === 0) {
    console.log("[B] no unprocessed items");
    return { itemsProcessed: 0, newSignals: 0 };
  }

  // 2. 拿 active signals(避免重複建)
  const active = await deps.getActiveSignals();
  console.log(
    `[B] processing ${items.length} items, ${active.length} active signals to avoid duplicates`,
  );

  // 3. 喂 LLM
  const userPrompt = buildUserPrompt(items, active);
  const llmResult = await deps.ask(userPrompt, {
    system: SYSTEM_PROMPT,
    json: true,
    temperature: 0.3,  // 訊號發現要偏向 deterministic
    maxTokens: 2000,
  });

  // 4. 解析 LLM 輸出
  let parsed: LlmSignalResponse;
  try {
    parsed = JSON.parse(llmResult.content) as LlmSignalResponse;
  } catch (err) {
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : err}. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }

  if (!parsed.signals || !Array.isArray(parsed.signals)) {
    throw new Error(
      `LLM JSON missing 'signals' array. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }

  // 把 items 的 external_id 集合起來,用來過濾 LLM 瞎編的 source_item_ids
  const knownIds = new Set(items.map((i) => i.external_id));

  // 5. 存進 signals 表
  let newSignals = 0;
  for (const candidate of parsed.signals) {
    try {
      // 過濾掉 LLM 瞎編的 source_item_ids(只保留我們拿到的 items 的 ids)
      const validItemIds = candidate.source_item_ids.filter((id) =>
        knownIds.has(id),
      );

      await deps.insertSignal({
        title: candidate.title,
        description: candidate.description,
        importance: candidate.importance,
        tags: candidate.tags,
        source_items: validItemIds,
      });
      newSignals++;
    } catch (err) {
      console.error(
        `[B] failed to insert signal "${candidate.title}":`,
        err,
      );
      // 一個失敗不失敗整個 run,繼續處理下一個
    }
  }

  // 6. 標記 items 已處理(不管有沒有建 signals,被 B 處理過就標)
  // 同 source_type 的 items 一起 mark(目前只有 X 一種,未來加 source 也各自一組)
  const bySourceType = new Map<string, string[]>();
  for (const item of items) {
    const ids = bySourceType.get(item.source_type) ?? [];
    ids.push(item.external_id);
    bySourceType.set(item.source_type, ids);
  }
  for (const [sourceType, ids] of bySourceType) {
    await deps.markItemsProcessed(sourceType, ids);
  }

  console.log(
    `[B] done. items processed: ${items.length}, new signals: ${newSignals}`,
  );
  return { itemsProcessed: items.length, newSignals };
}

// 預設 deps:CLI 用真 DB + LLM
function getDefaultDeps(): BDependencies {
  return {
    getUnprocessedItems,
    getActiveSignals,
    insertSignal,
    markItemsProcessed,
    ask,
  };
}

async function main(): Promise<void> {
  await initDb();
  const result = await discover(getDefaultDeps());
  console.log(
    `[B] final: ${result.newSignals} new signals, ${result.itemsProcessed} items processed`,
  );
  process.exit(0);
}

// 只在直接執行(bun run b.ts)時跑 main,被 import 時不跑
if (import.meta.main) {
  main().catch((err) => {
    console.error("[B] failed:", err);
    process.exit(1);
  });
}
