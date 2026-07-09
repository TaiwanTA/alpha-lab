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

// 驗證 LLM 回傳的 candidate 是否合法
// 用 explicit validation 而不是直接 cast,讓壞資料被識別 + skip 而不是變成
// insertSignal 失敗被 try/catch 吞掉(Kilo PR #6 CRITICAL/WARNING)
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

  if (typeof c.title !== "string" || c.title.length === 0) {
    return { ok: false, error: `invalid title: ${typeof c.title}` };
  }
  if (c.title.length > 80) {
    return { ok: false, error: `title too long (${c.title.length} > 80)` };
  }
  if (typeof c.description !== "string" || c.description.length === 0) {
    return { ok: false, error: `invalid description: ${typeof c.description}` };
  }
  // importance 必須是 integer 1-5,接受 number 或 string-numeric(LLM 可能回 "4")
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
  // tags 必須是 string array(Kilo WARNING:非 string 元素會破壞 pgArrayLiteral)
  if (!Array.isArray(c.tags)) {
    return { ok: false, error: `tags is not array: ${typeof c.tags}` };
  }
  const validTags = c.tags.every((t) => typeof t === "string");
  if (!validTags) {
    return { ok: false, error: "tags contains non-string element" };
  }
  // source_item_ids 必須是 string array
  if (!Array.isArray(c.source_item_ids)) {
    return {
      ok: false,
      error: `source_item_ids is not array: ${typeof c.source_item_ids}`,
    };
  }
  const validSourceIds = c.source_item_ids.every((t) => typeof t === "string");
  if (!validSourceIds) {
    return { ok: false, error: "source_item_ids contains non-string element" };
  }
  // Kilo PR #6 review (iteration 2) WARNING:空的 source_item_ids 失去 provenance;
  // 之後 validItemIds.filter(...) 也可能成空(若 LLM 全瞎編),需要 reject 避免
  // 不附 provenance 的訊號進 DB(downstream 無法追溯到原始 item)
  if ((c.source_item_ids as string[]).length === 0) {
    return { ok: false, error: "source_item_ids is empty (no provenance)" };
  }

  // Kilo PR #6 review (iteration 2) SUGGESTION:LLM 可能回超長 description
  // 限制 800 chars(給 1-3 sentences 應該夠,過長時 reject 讓 LLM 重試)
  const MAX_DESC_LEN = 800;
  if ((c.description as string).length > MAX_DESC_LEN) {
    return {
      ok: false,
      error: `description too long (${(c.description as string).length} > ${MAX_DESC_LEN})`,
    };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : err}. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }

  // 防呆:LLM 可能回 null / 非 object / 缺 signals key(Kilo PR #6 review SUGGESTION)
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `LLM JSON root is not an object. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }
  const signalsField = (parsed as Record<string, unknown>).signals;
  if (!Array.isArray(signalsField)) {
    throw new Error(
      `LLM JSON missing 'signals' array. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }

  // 把 items 的 external_id 集合起來,用來過濾 LLM 瞎編的 source_item_ids
  const knownIds = new Set(items.map((i) => i.external_id));

  // 5. 存進 signals 表
  let newSignals = 0;
  for (const candidate of signalsField) {
    // 個別 candidate 也驗證:LLM 可能回缺欄位 / 型別錯 / importance 超出 1-5
    // 不驗的話這些壞資料會變成 insertSignal 失敗,被下方 catch 吞掉,
    // 無法區分「LLM 給的壞資料」vs「DB 真的出問題」(Kilo PR #6 review CRITICAL + WARNING)
    const validation = validateCandidate(candidate);
    if (!validation.ok) {
      console.error(
        `[B] skipping invalid candidate: ${validation.error}`,
        candidate,
      );
      continue;
    }
    const valid = validation.value;

    try {
      // 過濾掉 LLM 瞎編的 source_item_ids(只保留我們拿到的 items 的 ids)
      const validItemIds = valid.source_item_ids.filter((id) =>
        knownIds.has(id),
      );

      // Kilo WARNING:LLM 可能給出的所有 ids 都是 hallucinated,
      // validItemIds 完全空 → 訊號沒法追溯到任何真實 item,reject
      if (validItemIds.length === 0) {
        console.error(
          `[B] skipping signal "${valid.title}": all source_item_ids are unknown (LLM hallucinated)`,
        );
        continue;
      }

      await deps.insertSignal({
        title: valid.title,
        description: valid.description,
        importance: valid.importance,
        tags: valid.tags,
        source_items: validItemIds,
      });
      newSignals++;
    } catch (err) {
      console.error(
        `[B] failed to insert signal "${valid.title}":`,
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
