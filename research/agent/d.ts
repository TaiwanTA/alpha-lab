// D agent:盘前/盘后报告生产
//   pre  = 美股开盘前固定时间(默认 09:30 ET 前)→ 写当日预测
//   post = 美股收盘后固定时间(16:00 ET 后)→ 写盘后分析 + 盘前报告检讨
//   每日一次,由 systemd timer 触发(Step 7 才实作)
//   一次只生一个报告,呼叫者决定 --type
//
// 不做:信号发现(B)、信号研究(C)、排程(systemd timer)、写入 signal 状态。

import { ask } from "./lib/llm.ts";
import type { AskResult } from "./lib/llm.ts";
import { HindsightClient, HindsightError } from "../lib/hindsight-client.ts";
import type { Signal } from "../lib/types.ts";
import { join } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";

const HINDSIGHT_BANK_ID = "alpha-lab";

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

// 从 date 格式化 YYYY-MM-DD
// 注:toISOString 是 UTC,ET = UTC-4/5(EST/EDT),差几小时通常还是同一天,
// 极少跨午夜(MVP 先用 UTC date,够用)
function formatDateET(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// 从 signal + 回忆 组 prompt user content
function buildPreMarketPrompt(
  today: Date,
  signals: Signal[],
  observations: Array<{ text: string; score?: number }>,
): string {
  const observedText = observations.length === 0
    ? "(no observations recalled)"
    : observations.slice(0, 20).map((o, i) =>
      `${i + 1}. ${o.text}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${s.title}: ${s.description} (tags: ${s.tags.join(", ") || "none"})`
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
    : observations.slice(0, 20).map((o, i) =>
      `${i + 1}. ${o.text}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${s.title}: ${s.description} (tags: ${s.tags.join(", ") || "none"})`
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

// DI bundle
export interface DDependencies {
  getActiveSignals: () => Promise<Signal[]>;
  getSignalsByStatus: (status: string) => Promise<Signal[]>;
  recallHindsight: (query: string, options?: { limit?: number; tags?: string[] }) => Promise<Array<{ text: string; score?: number }>>;
  ask: (userPrompt: string, options?: {
    system?: string;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    json?: boolean;
    timeout?: number;
  }) => Promise<AskResult>;
  writeReport: (path: string, content: string) => Promise<void>;
  readReportIfExists: (path: string) => Promise<string | null>;
}

export type ReportType = "pre" | "post";

export interface ReportResult {
  type: ReportType;
  reportPath: string;
  reportLength: number; // 字数(len of markdown content)
}

// 主 D agent 函数
export async function generateReport(
  type: ReportType,
  deps: DDependencies,
  now: Date = new Date(),
): Promise<ReportResult> {
  // 1. 拿 active signals(pre 模式只看 active = discovered + tracking;
  //    post 模式还加 matured,因为 matured 的一天还可能 relevant)
  const active = await deps.getActiveSignals();
  let signals = active;
  if (type === "post") {
    const matured = await deps.getSignalsByStatus("matured");
    signals = [...active, ...matured];
  }
  console.log(`[D] ${type} report — ${signals.length} active+relevant signals`);

  // 2. 从 hindsight recall 所有 signal 相关 观察(一次 recall 多一点,跨 signal)
  //    用每个 signal.title 查 N=5 条,合并去重
  const allObservations: Array<{ text: string; score?: number }> = [];
  const seenTexts = new Set<string>();
  for (const signal of signals.slice(0, 10)) {  // top 10 重要 signals 以免 LLM context 爆
    const q = signal.title;
    const recalled = await deps.recallHindsight(q, { limit: 5, tags: signal.tags });
    for (const o of recalled) {
      if (!seenTexts.has(o.text)) {
        seenTexts.add(o.text);
        allObservations.push(o);
      }
    }
  }
  console.log(`[D] recalled ${allObservations.length} unique observations across signals`);

  // 3. 取今天 pre-market report(产 post part 才需要,给对照)
  let preMarketReport: string | null = null;
  if (type === "post") {
    const prePath = reportPath("pre", now);
    preMarketReport = await deps.readReportIfExists(prePath);
  }

  // 4. 选 prompt 跟 LLM call
  const systemPrompt = type === "pre" ? PRE_SYSTEM_PROMPT : POST_SYSTEM_PROMPT;
  const userPrompt = type === "pre"
    ? buildPreMarketPrompt(now, signals, allObservations)
    : buildPostMarketPrompt(now, signals, allObservations, preMarketReport);

  const llmResult = await deps.ask(userPrompt, {
    system: systemPrompt,
    temperature: 0.5,
    maxTokens: 3000,
  });

  // 5. 不解析 LLM output 结构,直接写进 markdown(LLM 已 follow format)
  const content = llmResult.content;
  const path = reportPath(type, now);
  await deps.writeReport(path, content);
  console.log(`[D] ${type} report written to ${path} (${content.length} chars)`);

  return {
    type,
    reportPath: path,
    reportLength: content.length,
  };
}

function reportPath(type: ReportType, date: Date): string {
  return `drafts/reports/${formatDateET(date)}-${type}.md`;
}

// 默认 deps
async function getDefaultDeps(): Promise<DDependencies> {
  const { initDb, getActiveSignals, getSignalsByStatus } = await import("../lib/db.ts");
  await initDb();
  const hindsight = new HindsightClient(
    process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888",
  );

  return {
    getActiveSignals,
    getSignalsByStatus,
    recallHindsight: (query, options) => hindsight.recall(HINDSIGHT_BANK_ID, query, options),
    ask,
    writeReport: async (path, content) => {
      const fullPath = join(process.cwd(), path);
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    },
    readReportIfExists: async (path) => {
      try {
        const fullPath = join(process.cwd(), path);
        return await readFile(fullPath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

async function main(args: string[]): Promise<void> {
  // 解析 --type=pre|post
  let type: ReportType | null = null;
  for (const arg of args) {
    if (arg === "--type=pre") type = "pre";
    else if (arg === "--type=post") type = "post";
  }
  if (type === null) {
    console.error("Usage: bun run d.ts --type=pre");
    console.error("       bun run d.ts --type=post");
    process.exit(1);
  }

  const deps = await getDefaultDeps();
  const result = await generateReport(type, deps);
  console.log(
    `[D] final: ${result.type} report at ${result.reportPath} (${result.reportLength} chars)`,
  );
  process.exit(0);
}

// 只在直接执行(bun run d.ts)时跑 main,被 import 时不跑
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    console.error("[D] failed:", err);
    process.exit(1);
  });
}
