#!/usr/bin/env bun
// automation/commands/signal-classify.ts
//
// Signal classification CLI. Runs as a Dagu DAG on a 1-2 hour schedule.
//
// Batch-processes unclassified items:
//   1. Queries items WHERE classified_at IS NULL (LIMIT 50)
//   2. Queries active signals (archived_at IS NULL)
//   3. Feeds both to MiniMax-M3 LLM for classification
//   4. LLM outputs: classifications (item→signal), new_signals, rejections
//   5. Writes new signals, links items, marks all items classified
//
// This is NOT an agentic loop — it makes a single LLM chat completion
// call via pi-ai's minimaxProvider().streamSimple(), then applies the
// structured JSON result to the database.
//
// Exit discipline: stdout = JSON summary (批次 CLI,無單一 run ID),stderr = logs,exitCode in catch.
// Uses process.exitCode (not hard exit) so closeDb() runs in finally.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { closeDb, SignalRecord, type ItemRow, type SignalRow } from "../lib/db.ts";

import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const CONFIG_PATH = new URL(
  "../config/signal-config.yaml",
  import.meta.url,
).pathname;

const MAX_ITEMS_PER_RUN = 50;
const LLM_TEMPERATURE = 0.3;
const LLM_MAX_TOKENS = 2000;

// ---------------------------------------------------------------------------
// LLM result shape
// ---------------------------------------------------------------------------

/** LLM 分類結果的結構 — 每個 item 必須出現在 classifications 或 rejections 中。 */
interface ClassificationResult {
  classifications: Array<{
    item_id: string;
    signal_assignments: Array<{
      signal_id: string;
      relation: "primary" | "supporting" | "context";
    }>;
  }>;
  new_signals: Array<{
    title: string;
    description: string;
    priority: "high" | "low";
  }>;
  rejections: Array<{
    item_id: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildClassifyPrompt(
  items: ItemRow[],
  signals: SignalRow[],
): string {
  const itemsJson = JSON.stringify(
    items.map((i) => ({
      id: i.id,
      investor: i.investor,
      raw_content: i.raw_content.slice(0, 500),
      source_url: i.source_url,
      published_at: i.published_at.toISOString(),
    })),
  );
  const signalsJson = JSON.stringify(
    signals.map((s) => ({
      id: s.id,
      title: s.title,
      description: s.description.slice(0, 300),
      priority: s.priority,
    })),
  );

  return [
    "You are classifying items into signals (narrative entities).",
    "An item is a raw piece of information (tweet, blog post, etc).",
    "A signal is a narrative entity that can relate to multiple items.",
    "An item can belong to multiple signals (many-to-many).",
    "",
    "<unclassified_items>",
    itemsJson,
    "</unclassified_items>",
    "",
    "<existing_signals>",
    signalsJson,
    "</existing_signals>",
    "",
    "For each item, decide:",
    "1. Does it belong to an existing signal? (use the signal's id)",
    "2. Should a new signal be created? (provide title, description, priority)",
    "3. Is it low-signal noise that should be rejected? (e.g. one-word reactions)",
    "",
    'Output valid JSON with this exact shape:',
    '{"classifications":[{"item_id":"...","signal_assignments":[{"signal_id":"existing-uuid-or-new:0","relation":"primary|supporting|context"}]}],"new_signals":[{"title":"...","description":"...","priority":"high|low"}],"rejections":[{"item_id":"...","reason":"..."}]}',
    "",
    "Rules:",
    "- every item_id in the input must appear exactly once across classifications+rejections",
    "- signal_id must be an existing signal UUID, or 'new:<index>' where <index> is the 0-based index into the new_signals array",
    "- reject items that are single-word reactions, pure links, or noise with no signal value",
    "- description must be <=500 characters",
    "- write descriptions in Traditional Chinese (繁體中文)",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// LLM call — single chat completion via pi-ai streamSimple
// ---------------------------------------------------------------------------

/** 從 AssistantMessage.content 陣列中抽取第一段純文字。 */
function extractText(content: Array<{ type: string; text?: string }>): string {
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

async function runClassification(
  items: ItemRow[],
  signals: SignalRow[],
): Promise<ClassificationResult> {
  const prompt = buildClassifyPrompt(items, signals);
  const provider = minimaxProvider();
  const model = getBuiltinModel("minimax", "MiniMax-M3");
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("signal-classify: MINIMAX_API_KEY is not set");
  const stream = provider.streamSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { temperature: LLM_TEMPERATURE, maxTokens: LLM_MAX_TOKENS, apiKey },
  );
  const message = await stream.result();
  const text = extractText(message.content);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("signal-classify: LLM returned no JSON");
  }
  return JSON.parse(jsonMatch[0]) as ClassificationResult;
}

// ---------------------------------------------------------------------------
// Apply classification result to the database
// ---------------------------------------------------------------------------

async function applyClassification(
  result: ClassificationResult,
  items: ItemRow[],
): Promise<{ signals_created: number; items_linked: number; items_rejected: number }> {
  // 建立新 signals，收集 index→id 映射供後續 linkItem 使用
  // new_signals 陣列以 0-based index 為 key
  const newSignalIds = new Map<number, string>();
  for (let i = 0; i < result.new_signals.length; i++) {
    const ns = result.new_signals[i];
    // LLM 可能回傳 'medium' 等不合法值;CHECK constraint 只允許 'high'|'low'
    const priority = ns.priority === "high" ? "high" : "low";
    const id = await SignalRecord.insert({
      title: ns.title,
      description: ns.description,
      priority,
      archived_at: null,
    });
    newSignalIds.set(i, id);
  }

  let itemsLinked = 0;
  let itemsRejected = 0;
  const processedItemIds = new Set<string>();

  for (const classification of result.classifications) {
    for (const assignment of classification.signal_assignments) {
      let signalId = assignment.signal_id;
      // LLM 用 "new:<index>" 指向 new_signals 陣列的 0-based index
      if (signalId.startsWith("new:")) {
        const idx = Number(signalId.slice(4));
        const resolved = newSignalIds.get(idx);
        if (!resolved) continue;
        signalId = resolved;
      }
      // 相容舊格式 "new"（無 index）— 跳過,留給 unmatched
      if (signalId === "new") continue;
      await SignalRecord.linkItem(
        signalId,
        classification.item_id,
        assignment.relation,
      );
      itemsLinked++;
    }
    processedItemIds.add(classification.item_id);
  }

  for (const rejection of result.rejections) {
    itemsRejected++;
    processedItemIds.add(rejection.item_id);
    await SignalRecord.markClassified(rejection.item_id, {
      rejected: true,
      reason: rejection.reason,
    });
  }

  // 標記所有已處理 items 為已分類 — 包含未被 LLM 涵蓋的 items
  for (const item of items) {
    if (!processedItemIds.has(item.id)) {
      await SignalRecord.markClassified(item.id, { status: "unmatched" });
    } else if (!result.rejections.find((r) => r.item_id === item.id)) {
      await SignalRecord.markClassified(item.id, { status: "classified" });
    }
  }

  return {
    signals_created: result.new_signals.length,
    items_linked: itemsLinked,
    items_rejected: itemsRejected,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  if (!process.env.MINIMAX_API_KEY?.trim()) throw new Error("MINIMAX_API_KEY is required");

  // 載入 signal-config.yaml 以驗證設定可用 (分類本身不需要 config，
  // 但沿用專案慣例:CLI 啟動時就 fail-loud 確認設定存在)
  const configPath = resolve(CONFIG_PATH);
  const configText = await readFile(configPath, "utf8");
  // parseSignalConfig 在其他模組已驗證;此處只讀取確保檔案存在
  void configText;

  const items = await SignalRecord.claimNextUnclassifiedItems(MAX_ITEMS_PER_RUN);
  if (items.length === 0) {
    console.error("signal-classify: no unclassified items, nothing to do");
    return;
  }

  console.error(`signal-classify: processing ${items.length} unclassified items`);

  const signals = await SignalRecord.listActive();
  const result = await runClassification(items, signals);
  const summary = await applyClassification(result, items);

  console.error(
    `signal-classify: ${summary.signals_created} signals created, ${summary.items_linked} items linked, ${summary.items_rejected} rejected`,
  );
  console.log(JSON.stringify({ ok: true, ...summary }));
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error(`signal-classify: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
