#!/usr/bin/env bun
// automation/commands/signal-manage.ts
//
// Signal priority + archive management CLI. Runs daily at 06:00 UTC
// (before research at 07:00).
//
// 1. Queries all active (non-archived) signals
// 2. For each signal, gathers recent activity:
//    - recent item count, last research_run, published blog posts
// 3. Feeds to LLM for priority change + archive decisions
// 4. Applies changes, updates descriptions with decision reasons
//
// This is the ONLY place that changes signals.priority and signals.archived_at.
//
// This is NOT an agentic loop — it makes a single LLM chat completion
// call via pi-ai's minimaxProvider().streamSimple(), then applies the
// structured JSON result to the database.
//
// Exit discipline: stdout = JSON summary (批次 CLI,無單一 run ID),stderr = logs,exitCode in catch.
// Uses process.exitCode (not hard exit) so closeDb() runs in finally.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { closeDb, SignalRecord, type SignalRow } from "../lib/db.ts";
import { parseSignalConfig } from "../lib/signal-config.ts";

import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

const CONFIG_PATH = new URL(
  "../config/signal-config.yaml",
  import.meta.url,
).pathname;

const LLM_TEMPERATURE = 0.3;
const LLM_MAX_TOKENS = 2000;
const RECENT_ITEM_DAYS = 14;

// ---------------------------------------------------------------------------
// LLM result shape
// ---------------------------------------------------------------------------

interface SignalActivity {
  signal: SignalRow;
  recentItemCount: number;
  lastResearchAt: string | null;
  lastResearchThesis: string | null;
  hasPublishedPost: boolean;
}

interface ManageResult {
  priority_changes: Array<{
    signal_id: string;
    new_priority: "high" | "low";
    reason: string;
  }>;
  archives: Array<{
    signal_id: string;
    reason: string;
  }>;
}

// ---------------------------------------------------------------------------
// Activity gathering
// ---------------------------------------------------------------------------

async function gatherActivity(signals: SignalRow[]): Promise<SignalActivity[]> {
  const since = new Date(Date.now() - RECENT_ITEM_DAYS * 86400000);

  // 並行查詢所有 signal 的 items + timeline,避免 N+1
  const activities = await Promise.all(
    signals.map(async (signal) => {
      const [items, timeline] = await Promise.all([
        SignalRecord.getItems(signal.id),
        SignalRecord.getTimeline(signal.id),
      ]);
      const recentItems = items.filter((i) => i.published_at >= since);
      const lastRun = timeline[timeline.length - 1] ?? null;

      return {
        signal,
        recentItemCount: recentItems.length,
        lastResearchAt: lastRun?.created_at.toISOString() ?? null,
        lastResearchThesis: lastRun?.thesis.slice(0, 200) ?? null,
        hasPublishedPost: timeline.some((r) => r.published_path !== null),
      } satisfies SignalActivity;
    }),
  );

  return activities;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildManagePrompt(
  activities: SignalActivity[],
  highCount: number,
  highSoftLimit: number,
): string {
  const activitiesJson = JSON.stringify(
    activities.map((a) => ({
      signal_id: a.signal.id,
      title: a.signal.title,
      description: a.signal.description.slice(0, 300),
      priority: a.signal.priority,
      created_at: a.signal.created_at.toISOString(),
      updated_at: a.signal.updated_at.toISOString(),
      recent_item_count: a.recentItemCount,
      last_research_at: a.lastResearchAt,
      last_research_thesis: a.lastResearchThesis,
      has_published_post: a.hasPublishedPost,
    })),
  );

  return [
    "You are managing signal priorities and archives.",
    "Signals are narrative entities tracked over time.",
    "You can: change priority (high/low), archive (close) signals.",
    "",
    "<signals_with_activity>",
    activitiesJson,
    "</signals_with_activity>",
    "",
    `Current high-priority count: ${highCount}`,
    `High-priority soft limit: ${highSoftLimit}`,
    "",
    "Rules:",
    "- archive signals whose event has concluded (e.g. election is over, bet settled)",
    "- demote (high→low) signals with no recent activity (0 items in 14 days)",
    "- promote (low→high) signals with sudden activity spikes",
    `- if upgrading to high and count >= soft limit (${highSoftLimit}),`,
    "  you may still upgrade with a justification, or demote an existing high signal",
    "- write reasons in Traditional Chinese (繁體中文)",
    "",
    'Output JSON: {"priority_changes":[{"signal_id":"...","new_priority":"high|low","reason":"..."}],"archives":[{"signal_id":"...","reason":"..."}]}',
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

async function runManagement(
  activities: SignalActivity[],
  highCount: number,
  highSoftLimit: number,
): Promise<ManageResult> {
  const prompt = buildManagePrompt(activities, highCount, highSoftLimit);
  const provider = minimaxProvider();
  const model = getBuiltinModel("minimax", "MiniMax-M3");
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) throw new Error("signal-manage: MINIMAX_API_KEY is not set");
  const stream = provider.streamSimple(
    model,
    { messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
    { temperature: LLM_TEMPERATURE, maxTokens: LLM_MAX_TOKENS, apiKey },
  );
  const message = await stream.result();
  const text = extractText(message.content);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("signal-manage: LLM returned no JSON");
  }
  return JSON.parse(jsonMatch[0]) as ManageResult;
}

// ---------------------------------------------------------------------------
// Apply decisions to the database
// ---------------------------------------------------------------------------

async function applyChanges(result: ManageResult): Promise<{
  priority_changed: number;
  archived: number;
}> {
  let priorityChanged = 0;
  let archived = 0;

  for (const change of result.priority_changes) {
    // LLM 可能回傳 'medium' 等不合法值;CHECK constraint 只允許 'high'|'low'
    const newPriority = change.new_priority === "high" ? "high" : "low";
    await SignalRecord.changePriority(change.signal_id, newPriority);
    await SignalRecord.appendToDescription(
      change.signal_id,
      `[${new Date().toISOString()}] 優先權變更: ${change.reason}`,
    );
    priorityChanged++;
  }

  for (const arch of result.archives) {
    await SignalRecord.archive(arch.signal_id);
    await SignalRecord.appendToDescription(
      arch.signal_id,
      `[${new Date().toISOString()}] 封存: ${arch.reason}`,
    );
    archived++;
  }

  return { priority_changed: priorityChanged, archived };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  if (!process.env.MINIMAX_API_KEY?.trim()) throw new Error("MINIMAX_API_KEY is required");

  const configPath = resolve(CONFIG_PATH);
  const configText = await readFile(configPath, "utf8");
  const config = parseSignalConfig(configText);

  const signals = await SignalRecord.listActive();
  if (signals.length === 0) {
    console.error("signal-manage: no active signals, nothing to do");
    return;
  }

  const activities = await gatherActivity(signals);
  const highCount = await SignalRecord.countByPriority("high");

  const result = await runManagement(
    activities,
    highCount,
    config.priorities.high.soft_limit,
  );
  const summary = await applyChanges(result);

  console.error(
    `signal-manage: ${summary.priority_changed} priority changes, ${summary.archived} archived`,
  );
  console.log(JSON.stringify({ ok: true, ...summary }));
}

if (import.meta.main) {
  main()
    .catch((err) => {
      console.error(`signal-manage: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await closeDb();
    });
}
