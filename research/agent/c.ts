// C agent:per-signal 研究事件追蹤
//   一個 agent 一次只處理一個 signal(ADR-001 核心原則)
//   1. 讀 signal 本體 + 相關 items(items.external_id 跟 signal.source_items 對得上)
//   2. recall Hindsight bank「alpha-lab」之前對這 signal 的 observations
//   3. 喂 LLM 綜合分析 → 產生新 observations(JSON)
//   4. 把新 observations 寫進 Hindsight(每條 retain 一次,跨 run 共享)
//   5. 產生 markdown draft 寫到 drafts/event-tracking/<slug>.md
//   6. 把 signal.status 從 discovered 改 tracking
//
// 不做:B(發現訊號)、D(盤前盤後報告)、排程(systemd timer)。

import { ask } from "./lib/llm.ts";
import type { AskResult } from "./lib/llm.ts";
import {
  HindsightClient,
  HindsightError,
  type HindsightMemory,
} from "../lib/hindsight-client.ts";
import type { Signal, ItemRow } from "../lib/types.ts";
import type { ResearchFinding } from "./lib/types.ts";
import { sql } from "bun";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createLogger } from "../lib/logger.ts";

const HINDSIGHT_BANK_ID = "alpha-lab";
const cLog = createLogger("C");
const DEFAULT_BANK_MISSION =
  "Investor signal research — observations from C agent that should be shared across runs.";

const SYSTEM_PROMPT = `You are a per-signal research agent for an investor research project.

Given:
- One signal we are tracking (title, description, importance, tags)
- The source tweets that triggered this signal (with their content)
- Prior observations recalled from long-term memory (if any)

Your job: synthesize NEW observations about this signal that are worth tracking long-term.

What makes a good observation:
- Specific, falsifiable claims about the signal's development
- Mentions of dates / numbers / entities when available (so we can verify later)
- Distinguishes between Ackman's stated view vs market reaction vs fundamentals
- Highlights what to watch in coming days/weeks to confirm/refute the signal

What does NOT count as an observation:
- Restating the original signal verbatim
- Generic commentary ("markets reacted today")
- Things already covered in prior observations (avoid duplicates)

Output strictly this JSON shape (no markdown):
{
  "observations": [
    {
      "observation": "the actual text of the observation",
      "entities": ["nvda", "ackman"],
      "tags": ["earnings", "position-sizing"],
      "source": "tw id from the input items, or 'inferred' if synthesis"
    }
  ]
}

If no new observations worth recording, output: {"observations": []}`;

interface LlmObservationResponse {
  observations: ResearchFinding[];
}

// DI bundle
export interface CDependencies {
  getSignal: (signalId: string) => Promise<Signal | null>;
  getSourceItems: (sourceItems: string[]) => Promise<ItemRow[]>;
  recallHindsight: (
    query: string,
    options?: { limit?: number; tags?: string[] },
  ) => Promise<Array<{ id?: string; text: string; score?: number }>>;
  retainHindsight: (memory: HindsightMemory) => Promise<unknown>;
  ensureHindsightBank: () => Promise<void>;
  ask: (
    prompt: string,
    options?: {
      system?: string;
      model?: string;
      temperature?: number;
      maxTokens?: number;
      json?: boolean;
      timeout?: number;
    },
  ) => Promise<AskResult>;
  writeReport: (path: string, content: string) => Promise<void>;
  updateSignalStatus: (signalId: string, status: string) => Promise<void>;
}

export interface ResearchResult {
  signalId: string;
  observationsRetained: number;
  observationsFailed: number;
  reportPath: string;
}

// 從 signal.source_items(string[]) 查回 items 行(ItemRow)
// 因為 source_items 是存 external_ids 不是 PK,要靠 source_type + external_id 查
// Bun.sql 不會自動把 JS array 轉 Postgres array,所以用 IN + sql.unsafe pattern
// (跟 haveItems / markItemsProcessed 同樣作法,見 AGENTS.md 的 Bun.sql array 雷段)
// source_type 目前硬編為 x_user_timeline;未來加 SEC 等 source 需擴展
async function fetchItemsByExternalIds(
  externalIds: string[],
  sourceType: string = "x_user_timeline",
): Promise<ItemRow[]> {
  if (externalIds.length === 0) return [];
  const idList = externalIds.map((id) => `'${escapeSqlString(id)}'`).join(",");
  return await sql<ItemRow[]>`
    SELECT source_type, source_label, external_id, external_parent,
           created_at, fetched_at, context, processed_at
    FROM items
    WHERE source_type = ${sourceType} AND external_id IN (${sql.unsafe(idList)})
    ORDER BY created_at DESC
  `;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildUserPrompt(
  signal: Signal,
  items: ItemRow[],
  priorObservations: Array<{ id?: string; text: string; score?: number }>,
): string {
  const itemTexts = items.length === 0
    ? "(no source items available)"
    : items
      .map((i) => `[${i.external_id}] ${i.context}`)
      .join("\n\n---\n\n");

  const priorObs = priorObservations.length === 0
    ? "(none yet)"
    : priorObservations
      .map((o, i) =>
        `${i + 1}. ${o.text}${o.score ? ` (score: ${o.score.toFixed(2)})` : ""}`
      )
      .join("\n");

  return `Signal we are tracking:
- Title: ${signal.title}
- Description: ${signal.description}
- Importance: ${signal.importance}/5
- Tags: ${signal.tags.join(", ") || "(none)"}
- Status: ${signal.status}

Source tweets that triggered this signal:
${itemTexts}

Prior observations from long-term memory (avoid duplicating these):
${priorObs}

Synthesize NEW observations. Respond with JSON only.`;
}

function validateFinding(
  raw: unknown,
): { ok: true; value: ResearchFinding } | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "observation is not an object" };
  }
  const f = raw as Record<string, unknown>;

  if (typeof f.observation !== "string" || f.observation.length === 0) {
    return { ok: false, error: `invalid observation: ${typeof f.observation}` };
  }
  if (f.observation.length > 2000) {
    return {
      ok: false,
      error: `observation too long (${f.observation.length} > 2000)`,
    };
  }

  if (!Array.isArray(f.entities)) {
    return { ok: false, error: "entities is not array" };
  }
  // Kilo SUGGESTION:對 entities / tags 字串做長度檢查(防 LLM 給超常字串)
  const MAX_ENTITY_LEN = 100;
  for (const e of f.entities as unknown[]) {
    if (typeof e !== "string") {
      return { ok: false, error: "entities contains non-string" };
    }
    if (e.length > MAX_ENTITY_LEN) {
      return { ok: false, error: `entity too long: ${e.length} > ${MAX_ENTITY_LEN}` };
    }
  }

  if (!Array.isArray(f.tags)) {
    return { ok: false, error: "tags is not array" };
  }
  const MAX_TAG_LEN = 100;
  for (const t of f.tags as unknown[]) {
    if (typeof t !== "string") {
      return { ok: false, error: "tags contains non-string" };
    }
    if (t.length > MAX_TAG_LEN) {
      return { ok: false, error: `tag too long: ${t.length} > ${MAX_TAG_LEN}` };
    }
  }

  if (typeof f.source !== "string") {
    return { ok: false, error: `invalid source: ${typeof f.source}` };
  }
  if ((f.source as string).length > 200) {
    return { ok: false, error: `source too long: ${(f.source as string).length} > 200` };
  }

  return {
    ok: true,
    value: {
      observation: f.observation,
      entities: f.entities as string[],
      tags: f.tags as string[],
      source: f.source,
    },
  };
}

// 主 C agent 函式
//   signalId:UUID-formatted string
//   deps:DI bundle(預設用真 DB + Hindsight + LLM)
export async function research(
  signalId: string,
  deps: CDependencies,
): Promise<ResearchResult> {
  // 1. 讀 signal
  const signal = await deps.getSignal(signalId);
  if (signal === null) {
    throw new Error(`Signal not found: ${signalId}`);
  }
  cLog
    .withMetadata({
      signal_id: signal.id,
      title: signal.title,
      status: signal.status,
    })
    .info("research starting");

  // 2. 拿 source items(from signal.source_items external_ids)
  const items = await deps.getSourceItems(signal.source_items);
  cLog.withMetadata({ count: items.length }).info("fetched source items");

  // 3. Hindsight bank 確保存在
  await deps.ensureHindsightBank();

  // 4. recall 之前的 observations(用 signal title 作 query)
  const recallQuery = signal.title +
    (signal.description.length > 0 ? " " + signal.description : "");
  const prior = await deps.recallHindsight(recallQuery, {
    limit: 10,
    tags: signal.tags,
  });
  cLog
    .withMetadata({ count: prior.length })
    .info("recalled prior observations from Hindsight");

  // 5. 喂 LLM
  const userPrompt = buildUserPrompt(signal, items, prior);
  const llmResult = await deps.ask(userPrompt, {
    system: SYSTEM_PROMPT,
    json: true,
    temperature: 0.4, // 觀察綜合要偏 deterministic
    maxTokens: 3000,
  });

  // 6. 解析 + validate findings
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : err}. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(
      `LLM JSON root is not an object. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }
  const obsField = (parsed as Record<string, unknown>).observations;
  if (!Array.isArray(obsField)) {
    throw new Error(
      `LLM JSON missing 'observations' array. Content first 300 chars: ${llmResult.content.slice(0, 300)}`,
    );
  }

  // 7. 寫進 Hindsight(逐條 validate → retain)
  let retained = 0;
  let failed = 0;
  const validFindings: ResearchFinding[] = [];
  const runStartIso = new Date().toISOString();
  let obsIndex = 0;
  for (const rawObs of obsField) {
    const v = validateFinding(rawObs);
    if (!v.ok) {
      cLog
        .withMetadata({ reason: v.error, observation: rawObs })
        .error("skipping invalid observation");
      continue;
    }
    // Kilo PR #7 CRITICAL:document_id 在 run 內要唯一,
    // 否則同 run 多條 observation 互相 upsert 覆蓋 → 加 per-observation index
    const documentId = `signal-${signal.id}-${runStartIso}-${obsIndex}`;
    obsIndex++;
    try {
      await deps.retainHindsight({
        text: v.value.observation,
        context: signal.title,
        type: "observation",
        occurred_start: runStartIso,
        occurred_end: runStartIso,
        // Kilo SUGGESTION:entities / tags 合併後去重,避免重複
        entities: [...new Set(v.value.entities)],
        tags: [...new Set([...signal.tags, ...v.value.tags, `signal:${signal.id}`])],
        document_id: documentId,
      });
      retained++;
      // Kilo PR #7 (iteration 2) WARNING:只能 push 已成功 retain 的 finding;
      // 否則 generateReportMarkdown 會把 retain 失敗的 observation 列為 new
      validFindings.push(v.value);
    } catch (err) {
      failed++;
      cLog.withError(err).error("failed to retain observation");
    }
  }
  cLog
    .withMetadata({
      retained,
      total: obsField.length,
      failed,
    })
    .info("retained observations into Hindsight");

  // 8. 寫 markdown report draft
  // Kilo SUGGESTION:相近日的 signal 可能撞 slug → 附加 signal.id 前 8 碼保唯一
  const titleSlug = slugify(signal.title) || "signal";
  const idSuffix = signal.id.replace(/-/g, "").slice(0, 8);
  const slug = `${titleSlug}-${idSuffix}`;
  const reportPath = `drafts/event-tracking/${slug}.md`;
  const reportContent = generateReportMarkdown(
    signal,
    items,
    prior,
    validFindings,
  );
  await deps.writeReport(reportPath, reportContent);
  cLog.withMetadata({ path: reportPath }).info("report written");

  // 9. 更新 signal status → tracking(如果還沒是)
  if (signal.status === "discovered") {
    await deps.updateSignalStatus(signal.id, "tracking");
    cLog
      .withMetadata({ signal_id: signal.id, from: "discovered", to: "tracking" })
      .info("signal status updated");
  }

  return {
    signalId: signal.id,
    observationsRetained: retained,
    observationsFailed: failed,
    reportPath,
  };
}

function generateReportMarkdown(
  signal: Signal,
  items: ItemRow[],
  prior: Array<{ text: string; score?: number }>,
  newFindings: ResearchFinding[],
): string {
  const lines: string[] = [];
  lines.push(`# ${signal.title}`);
  lines.push("");
  lines.push(`> Signal tracking report — auto-generated by C agent`);
  lines.push(`> Signal ID: \`${signal.id}\``);
  lines.push(`> Generated: ${new Date().toISOString()}`);
  lines.push("");
  lines.push("## Signal");
  lines.push(`- **Importance**: ${signal.importance}/5`);
  lines.push(`- **Status**: ${signal.status}`);
  lines.push(
    `- **Tags**: ${signal.tags.length ? signal.tags.join(", ") : "(none)"}`,
  );
  lines.push(`- **Description**: ${signal.description}`);
  lines.push("");

  lines.push("## Source items");
  if (items.length === 0) {
    lines.push("(no source items found in DB)");
  } else {
    for (const item of items) {
      lines.push(`### ${item.source_label} — ${item.external_id}`);
      lines.push(`- Created at: ${item.created_at.toISOString()}`);
      lines.push("");
      lines.push("```");
      lines.push(item.context);
      lines.push("```");
      lines.push("");
    }
  }

  lines.push("## Prior observations (from Hindsight)");
  if (prior.length === 0) {
    lines.push("(none yet)");
  } else {
    for (const p of prior) {
      lines.push(
        `- ${p.text}${p.score ? ` (score: ${p.score.toFixed(2)})` : ""}`,
      );
    }
  }
  lines.push("");

  lines.push("## New observations (this run)");
  if (newFindings.length === 0) {
    lines.push("(no new observations this run)");
  } else {
    for (const f of newFindings) {
      lines.push(`- **${f.observation}**`);
      if (f.entities.length > 0) {
        lines.push(`  - Entities: ${f.entities.join(", ")}`);
      }
      if (f.tags.length > 0) {
        lines.push(`  - Tags: ${f.tags.join(", ")}`);
      }
      lines.push(`  - Source: ${f.source}`);
    }
  }
  lines.push("");

  return lines.join("\n");
}

// 預設 deps:CLI 用真 DB + Hindsight + LLM
async function getDefaultDeps(): Promise<CDependencies> {
  const { getSignalById, updateSignalStatus, initDb } = await import(
    "../lib/db.ts"
  );

  const hindsight = new HindsightClient(
    process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888",
  );
  let bankEnsured = false;

  return {
    getSignal: getSignalById,
    getSourceItems: (sourceItems: string[]) => fetchItemsByExternalIds(sourceItems),
    recallHindsight: (query, options) =>
      hindsight.recall(HINDSIGHT_BANK_ID, query, options),
    retainHindsight: (memory) => hindsight.retain(HINDSIGHT_BANK_ID, memory),
    ensureHindsightBank: async () => {
      if (bankEnsured) return;
      // Kilo WARNING:之前「任何 error 就 create」會把 5xx/網路錯當成 bank 不存在。
      // 改成只 404 時 create,其他 error 真 throw 讓 caller 知道
      try {
        await hindsight.getBank(HINDSIGHT_BANK_ID);
      } catch (err) {
        if (err instanceof HindsightError && err.status === 404) {
          await hindsight.createBank({
            bank_id: HINDSIGHT_BANK_ID,
            name: "Alpha Lab",
            mission: DEFAULT_BANK_MISSION,
          });
          cLog
            .withMetadata({ bank_id: HINDSIGHT_BANK_ID })
            .info("created Hindsight bank");
        } else {
          // 5xx / 網路錯:rethrow,不誤建 bank
          throw err;
        }
      }
      bankEnsured = true;
    },
    ask,
    writeReport: async (path, content) => {
      const fullPath = join(process.cwd(), path);
      const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
      await mkdir(dir, { recursive: true });
      await writeFile(fullPath, content, "utf-8");
    },
    updateSignalStatus,
  };
}

async function main(signalId: string): Promise<void> {
  if (!signalId) {
    cLog.error("Usage: bun run c.ts <signalId>");
    process.exit(1);
  }
  const { initDb } = await import("../lib/db.ts");
  await initDb();
  const deps = await getDefaultDeps();
  const result = await research(signalId, deps);
  cLog
    .withMetadata({
      observations_retained: result.observationsRetained,
      path: result.reportPath,
    })
    .info("final");
  process.exit(0);
}

if (import.meta.main) {
  const signalId = process.argv[2] ?? "";
  main(signalId).catch((err) => {
    cLog.withError(err).error("failed");
    process.exit(1);
  });
}
