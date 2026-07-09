// D workflow 包裝:盤前 / 盤後報告生產,業務邏輯 inline(為什麼見 workflow/b.ts 頭註)。
//
// type ∈ "pre" | "post"。產出檔案路徑由本檔內 reportPath 邏輯決定,
// 寫到 drafts/reports/<YYYY-MM-DD>-<type>.md。

import { join, dirname } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { HindsightClient, HindsightError } from "../lib/hindsight-client.ts";
import type { Signal } from "../lib/types.ts";
import { ask } from "../agent/lib/llm.ts";
import type { AskResult } from "../agent/lib/llm.ts";
import { initDb, getActiveSignals, getSignalsByStatus } from "../lib/db.ts";

const HINDSIGHT_BANK_ID = "alpha-lab";
const DEFAULT_BANK_MISSION =
  "Investor signal research — shared observations across agent runs.";
const REPORTS_DIR = "drafts/reports";
const MAX_SIGNALS_FOR_RECALL = 10;
const MAX_OBSERVATIONS_IN_PROMPT = 20;
const MAX_TITLE_LEN = 200;
const MAX_DESC_LEN = 1000;
const MAX_TAG_LEN = 100;
const MIN_LLM_CONTENT_LEN = 10;

const PRE_SYSTEM_PROMPT = `You are a US pre-market stock report writer for an investor research project.

Inputs:
1. Active signals we are tracking (with descriptions + tags).
2. Recent observations recalled from long-term memory about these signals.
3. Today's date (US ET).

Your job: write a structured pre-market report predicting what to watch during today's US trading session.

Format (markdown, follow strictly):

# 盘前报告 — <YYYY-MM-DD>

## 重点观察
- **<最重要 signal title>**:<1-2 sentence 为什么今天要 watch>
- **<次要 signal title>**:<...>

## 预测
- <具体预测 1:with direction + scope>

## 风险
- <不可忽略的反向信号 / 整体 market 风险>

## 持续追踪中
- <列出 其他 active signals 但今天没主要触发可能 的>

If no active signals or prior observations, write a short report saying "no major signals to watch today".

Keep it concise: 200-400 words total. Tight, actionable, no fluff.`;

const POST_SYSTEM_PROMPT = `You are a US post-market stock report writer for an investor research project.

Inputs:
1. Active signals we are tracking.
2. Recent observations recalled from long-term memory.
3. Today's pre-market report (use this as the prediction to check against today's session).
4. Today's date.

Your job: write a structured post-market report.

Format (markdown, follow strictly):

# 盘后报告 — <YYYY-MM-DD>

## 盘前预测检讨
- ✓ <命中 的 prediction>:<1 sentence 为什么命中>
- ✗ <失误 的 prediction>:<1 sentence 为什么失误>
(如果盘前 report 没有可检视的 prediction,写 "no verifiable predictions in pre-market report")

## 今日观察
- <今日 actually 发生的事 relevant to active signals>

## 信号状态变更建议
- <如果有 signal importance/status 应该调整,明确指出(但你不直接改 DB,只是建议)>

## 明日盯盘
- <明日要 watch 的 signal + 触发条件>

Keep it concise: 250-500 words total. Ground every conclusion in specific signals or observations, no generic market commentary.`;

function formatDateET(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

function sanitize(s: string, maxLen: number): string {
  return s.replace(/\s+/g, " ").slice(0, maxLen);
}

function buildPreMarketPrompt(
  today: Date,
  signals: Signal[],
  observations: Array<{ text: string; score?: number }>,
): string {
  const observedText = observations.length === 0
    ? "(no observations recalled)"
    : observations.slice(0, MAX_OBSERVATIONS_IN_PROMPT).map((o, i) =>
      `${i + 1}. ${sanitize(o.text, 500)}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`,
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${sanitize(s.title, MAX_TITLE_LEN)}: ${sanitize(s.description, MAX_DESC_LEN)} (tags: ${s.tags.map((t) => sanitize(t, MAX_TAG_LEN)).join(", ") || "none"})`,
    ).join("\n");

  return `Today's date (ET): ${formatDateET(today)}

Active signals (status: discovered or tracking):
${signalsText}

Recent observations from long-term memory:
${observedText}

Write the pre-market report markdown. Follow the format in system prompt strictly.`;
}

function buildPostMarketPrompt(
  today: Date,
  signals: Signal[],
  observations: Array<{ text: string; score?: number }>,
  preMarketReport: string | null,
): string {
  const preReportText = preMarketReport === null
    ? "(no pre-market report found for today)"
    : preMarketReport;
  const observedText = observations.length === 0
    ? "(no observations recalled)"
    : observations.slice(0, MAX_OBSERVATIONS_IN_PROMPT).map((o, i) =>
      `${i + 1}. ${sanitize(o.text, 500)}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`,
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${sanitize(s.title, MAX_TITLE_LEN)}: ${sanitize(s.description, MAX_DESC_LEN)} (tags: ${s.tags.map((t) => sanitize(t, MAX_TAG_LEN)).join(", ") || "none"})`,
    ).join("\n");

  return `Today's date (ET): ${formatDateET(today)}

Active signals (status: discovered or tracking, or matured):
${signalsText}

Recent observations from long-term memory (recall):
${observedText}

Today's pre-market report:
${preReportText}

Write the post-market report markdown. Compare it with the pre-market report.`;
}

function reportPath(type: "pre" | "post", date: Date): string {
  return `drafts/reports/${formatDateET(date)}-${type}.md`;
}

interface DStepResult {
  type: "pre" | "post";
  reportPath: string;
  reportLength: number;
}

async function generateReportLogic(type: "pre" | "post"): Promise<DStepResult> {
  const now = new Date();
  const active = await getActiveSignals();
  let signals = active;
  if (type === "post") {
    const matured = await getSignalsByStatus("matured");
    signals = [...active, ...matured];
  }
  signals = signals
    .slice()
    .sort((a, b) =>
      b.importance - a.importance ||
      b.created_at.getTime() - a.created_at.getTime(),
    )
    .slice(0, MAX_SIGNALS_FOR_RECALL);
  console.log(`[D-workflow] type=${type} signals=${signals.length}`);

  // ensure bank
  const hindsight = new HindsightClient(
    process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888",
  );
  try {
    await hindsight.getBank(HINDSIGHT_BANK_ID);
  } catch (err) {
    if (err instanceof HindsightError && err.status === 404) {
      await hindsight.createBank({
        bank_id: HINDSIGHT_BANK_ID,
        name: "Alpha Lab",
        mission: DEFAULT_BANK_MISSION,
      });
      console.log(`[D-workflow] created Hindsight bank`);
    } else {
      throw err;
    }
  }

  const recallQueries = signals.map((signal) => ({
    query: signal.title,
    options: { limit: 5, tags: signal.tags },
  }));
  const recallResults = await Promise.all(
    recallQueries.map((q) => hindsight.recall(HINDSIGHT_BANK_ID, q.query, q.options)),
  );
  const allObservations: Array<{ text: string; score?: number }> = [];
  const seenTexts = new Set<string>();
  for (const recalled of recallResults) {
    for (const o of recalled) {
      if (!seenTexts.has(o.text)) {
        seenTexts.add(o.text);
        allObservations.push(o);
      }
    }
  }
  console.log(`[D-workflow] recalled=${allObservations.length}`);

  const baseDir = process.env.REPORTS_BASE_DIR ?? join(process.cwd(), REPORTS_DIR);

  let preMarketReport: string | null = null;
  if (type === "post") {
    const prePath = reportPath("pre", now);
    const filename = dirname(prePath) === "." ? prePath : prePath.split("/").pop()!;
    const fullPrePath = join(baseDir, filename);
    try {
      preMarketReport = await readFile(fullPrePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        preMarketReport = null;
      } else {
        throw err;
      }
    }
  }

  const systemPrompt = type === "pre" ? PRE_SYSTEM_PROMPT : POST_SYSTEM_PROMPT;
  const userPrompt = type === "pre"
    ? buildPreMarketPrompt(now, signals, allObservations)
    : buildPostMarketPrompt(now, signals, allObservations, preMarketReport);

  const llmResult: AskResult = await ask(userPrompt, {
    system: systemPrompt,
    temperature: 0.5,
    maxTokens: 3000,
  });

  const content = llmResult.content;
  const trimmedLength = content.trim().length;
  if (trimmedLength < MIN_LLM_CONTENT_LEN) {
    throw new Error(
      `LLM returned empty/too-short content (trimmed ${trimmedLength} chars, raw ${content.length}). Not writing report.`,
    );
  }
  const path = reportPath(type, now);
  const filename = dirname(path) === "." ? path : path.split("/").pop()!;
  const fullPath = join(baseDir, filename);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, "utf-8");
  console.log(`[D-workflow] wrote ${path} chars=${content.length}`);

  return {
    type,
    reportPath: path,
    reportLength: content.length,
  };
}

async function generateReportStep(type: "pre" | "post"): Promise<DStepResult> {
  "use step";
  await initDb();
  return await generateReportLogic(type);
}

function isValidType(t: string): t is "pre" | "post" {
  return t === "pre" || t === "post";
}

export async function dWorkflow(type: string): Promise<DStepResult> {
  "use workflow";
  if (!isValidType(type)) {
    throw new Error(`Invalid report type: ${type}. Must be 'pre' or 'post'.`);
  }
  console.log(`[D-workflow] run type=${type}`);
  const result = await generateReportStep(type);
  console.log(`[D-workflow] done type=${type} path=${result.reportPath} chars=${result.reportLength}`);
  return result;
}
