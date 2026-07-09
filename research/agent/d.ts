// D agent:盘前/盘后报告生产
//   pre  = 美股开盘前固定时间(默认 09:30 ET 前)→ 写当日预测
//   post = 美股收盘后固定时间(16:00 ET 后)→ 写盘后分析 + 盘前报告检讨
//   每日一次,由 systemd timer 触发(Step 7 才实作)
//   一次只生一个报告,呼叫者决定 --type
//
// 不做:信号发现(B)、信号研究(C)、排程(systemd timer)、写入 signal 状态。

import { ask } from "./lib/llm.ts";
import type { AskResult } from "./lib/llm.ts";
import {
  HindsightClient,
  HindsightError,
} from "../lib/hindsight-client.ts";
import type { Signal } from "../lib/types.ts";
import { join, dirname } from "node:path";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createLogger } from "../lib/logger.ts";

const HINDSIGHT_BANK_ID = "alpha-lab";
const dLog = createLogger("D");
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

// 真的美東 timezone conversion(用 Intl.DateTimeFormat 拿 America/New_York 的
// date parts,handle DST),不再靠 UTC slice(日內跨午夜會錯)
// Kilo PR #8 Gemini高 + Kilo CRITICAL:之前的 toISOString().slice(0,10) 在美東
// 凌晨会对应 UTC 的前一天,post-market 会读到昨天的 pre-market report
function formatDateET(date: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA format = YYYY-MM-DD(刚好我们想要的格式)
  return fmt.format(date);
}

// 从 signal + 回忆 组 prompt user content
function sanitize(s: string, maxLen: number): string {
  // 砍掉换行(避免破坏 markdown 结构),限制长度避免 LLM context 爆
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
      `${i + 1}. ${sanitize(o.text, 500)}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${sanitize(s.title, MAX_TITLE_LEN)}: ${sanitize(s.description, MAX_DESC_LEN)} (tags: ${s.tags.map((t) => sanitize(t, MAX_TAG_LEN)).join(", ") || "none"})`
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
      `${i + 1}. ${sanitize(o.text, 500)}${o.score ? ` (score ${o.score.toFixed(2)})` : ""}`
    ).join("\n");
  const signalsText = signals.length === 0
    ? "(no active signals)"
    : signals.map((s) =>
      `- [${s.importance}/5] ${sanitize(s.title, MAX_TITLE_LEN)}: ${sanitize(s.description, MAX_DESC_LEN)} (tags: ${s.tags.map((t) => sanitize(t, MAX_TAG_LEN)).join(", ") || "none"})`
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
  // Kilo PR #8 WARNING:D 之前没 ensureHindsightBank(若 D 比 C 先跑会炸)
  ensureHindsightBank: () => Promise<void>;
}

export type ReportType = "pre" | "post";

export interface ReportResult {
  type: ReportType;
  reportPath: string;
  reportLength: number; // markdown 字元數(UTF-16 code units,非實際 word count)
}

// 主 D agent 函数
export async function generateReport(
  type: ReportType,
  deps: DDependencies,
  now: Date = new Date(),
): Promise<ReportResult> {
  // 1. 拿 active signals(pre 模式只看 active = discovered + tracking;
  //    post 模式还加 matured)
  const active = await deps.getActiveSignals();
  let signals = active;
  if (type === "post") {
    const matured = await deps.getSignalsByStatus("matured");
    signals = [...active, ...matured];
  }
  // Kilo PR #8 WARNING:post 模式之前 merge active + matured 之后才 slice(0,10),
  // 没按 importance 排序。改成:先 sort importance DESC,再取 top 10
  // Kilo PR #8 iter 2 SUGGESTION:加 created_at 作 tiebreaker 確保同 importance 時順序穩定
  signals = signals
    .slice()
    .sort((a, b) =>
      b.importance - a.importance ||
      b.created_at.getTime() - a.created_at.getTime()
    )
    .slice(0, MAX_SIGNALS_FOR_RECALL);
  dLog
    .withMetadata({ type, signal_count: signals.length })
    .info("report start");

  // 2. Hindsight bank 确保存在(D 可能比 C 先跑,bank 不存在会让 recall 全失败)
  //    Kilo PR #8 WARNING:之前完全没 ensureBank
  await deps.ensureHindsightBank();

  // 3. 从 hindsight recall 所有 signal 相关 观察(一次 recall 多一点,跨 signal)
  //    用每个 signal.title 查 N=5 条,合并去重
  //    Kilo PR #8 SUGGESTION + Gemini:之前 sequential await 10 次,改成 Promise.all
  const recallQueries = signals.map((signal) => ({
    query: signal.title,
    options: { limit: 5, tags: signal.tags },
  }));
  const recallResults = await Promise.all(
    recallQueries.map((q) => deps.recallHindsight(q.query, q.options)),
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
  dLog
    .withMetadata({ count: allObservations.length })
    .info("recalled observations");

  // 4. 取今天 pre-market report(产 post part 才需要)
  let preMarketReport: string | null = null;
  if (type === "post") {
    const prePath = reportPath("pre", now);
    preMarketReport = await deps.readReportIfExists(prePath);
  }

  // 5. 选 prompt + LLM call
  const systemPrompt = type === "pre" ? PRE_SYSTEM_PROMPT : POST_SYSTEM_PROMPT;
  const userPrompt = type === "pre"
    ? buildPreMarketPrompt(now, signals, allObservations)
    : buildPostMarketPrompt(now, signals, allObservations, preMarketReport);

  const llmResult = await deps.ask(userPrompt, {
    system: systemPrompt,
    temperature: 0.5,
    maxTokens: 3000,
  });

  // 6. 不解析 LLM output 结构,直接写进 markdown(LLM 已 follow format)
  const content = llmResult.content;
  // Kilo PR #8 iter 2:trim 之后才检查长度,避免纯空白字串通过
  const trimmedLength = content.trim().length;
  if (trimmedLength < MIN_LLM_CONTENT_LEN) {
    throw new Error(
      `LLM returned empty/too-short content (trimmed ${trimmedLength} chars, raw ${content.length}). Not writing report.`,
    );
  }
  const path = reportPath(type, now);
  await deps.writeReport(path, content);
  dLog
    .withMetadata({ type, path, chars: content.length })
    .info("report written");

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
  let bankEnsured = false;

  // 用一個固定 base dir 不靠 process.cwd()(Kilo PR #8 WARNING:cwd 不一致會
  // silent fallback 看不到 today 的 pre report)
  const baseDir = process.env.REPORTS_BASE_DIR ?? join(process.cwd(), REPORTS_DIR);

  return {
    getActiveSignals,
    getSignalsByStatus,
    recallHindsight: (query, options) => hindsight.recall(HINDSIGHT_BANK_ID, query, options),
    ask,
    writeReport: async (path, content) => {
      // path 是相對 REPORTS_DIR 的子路徑(其實只有 'drafts/reports/<name>.md'),
      // 我們直接 resolve to baseDir
      const filename = dirname(path) === "." ? path : path.split("/").pop()!;
      const fullPath = join(baseDir, filename);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    },
    readReportIfExists: async (path) => {
      try {
        const filename = dirname(path) === "." ? path : path.split("/").pop()!;
        const fullPath = join(baseDir, filename);
        return await readFile(fullPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
    ensureHindsightBank: async () => {
      if (bankEnsured) return;
      try {
        await hindsight.getBank(HINDSIGHT_BANK_ID);
      } catch (err) {
        // 同 C agent pattern:只在 404 時 createBank
        if (err instanceof HindsightError && err.status === 404) {
          await hindsight.createBank({
            bank_id: HINDSIGHT_BANK_ID,
            name: "Alpha Lab",
            mission: DEFAULT_BANK_MISSION,
          });
          dLog
            .withMetadata({ bank_id: HINDSIGHT_BANK_ID })
            .info("created Hindsight bank");
        } else {
          throw err;
        }
      }
      bankEnsured = true;
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
    dLog.error("Usage: bun run d.ts --type=pre");
    dLog.error("       bun run d.ts --type=post");
    process.exit(1);
  }

  const deps = await getDefaultDeps();
  const result = await generateReport(type, deps);
  dLog
    .withMetadata({
      type: result.type,
      path: result.reportPath,
      chars: result.reportLength,
    })
    .info("final");
  process.exit(0);
}

// 只在直接执行(bun run d.ts)时跑 main,被 import 时不跑
if (import.meta.main) {
  main(process.argv.slice(2)).catch((err) => {
    dLog.withError(err).error("failed");
    process.exit(1);
  });
}
