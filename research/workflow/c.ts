// C workflow 包裝:per-signal 研究事件追蹤,業務邏輯 inline(為什麼 inline 見 workflow/b.ts 頭註)。
//
// 一個 cWorkflow run = 對一個 signal 跑一次 C agent。C 本身冪等,trigger 失敗重試安全。

import { sql } from "bun";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { HindsightClient, HindsightError } from "../lib/hindsight-client.ts";
import type { HindsightMemory } from "../lib/hindsight-client.ts";
import type { Signal, ItemRow } from "../lib/types.ts";
import type { ResearchFinding } from "../agent/lib/types.ts";
import { ask } from "../agent/lib/llm.ts";
import type { AskResult } from "../agent/lib/llm.ts";
import { initDb, getSignalById, updateSignalStatus } from "../lib/db.ts";

const HINDSIGHT_BANK_ID = "alpha-lab";
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

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

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
    : items.map((i) => `[${i.external_id}] ${i.context}`).join("\n\n---\n\n");
  const priorObs = priorObservations.length === 0
    ? "(none yet)"
    : priorObservations.map((o, i) =>
      `${i + 1}. ${o.text}${o.score ? ` (score: ${o.score.toFixed(2)})` : ""}`,
    ).join("\n");
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

function validateFinding(raw: unknown):
  | { ok: true; value: ResearchFinding }
  | { ok: false; error: string } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, error: "observation is not an object" };
  }
  const f = raw as Record<string, unknown>;
  if (typeof f.observation !== "string" || f.observation.length === 0 || f.observation.length > 2000) {
    return { ok: false, error: "observation text invalid" };
  }
  if (!Array.isArray(f.entities) || !f.entities.every((e) => typeof e === "string")) {
    return { ok: false, error: "entities invalid" };
  }
  if (!Array.isArray(f.tags) || !f.tags.every((t) => typeof t === "string")) {
    return { ok: false, error: "tags invalid" };
  }
  if (typeof f.source !== "string" || f.source.length > 200) {
    return { ok: false, error: "source invalid" };
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

interface ResearchStepResult {
  signalId: string;
  observationsRetained: number;
  observationsFailed: number;
  reportPath: string;
}

// 用 default deps equivalent(沒 logger)做 research 內部邏輯
async function researchLogic(signalId: string): Promise<ResearchStepResult> {
  const signal = await getSignalById(signalId);
  if (signal === null) {
    throw new Error(`Signal not found: ${signalId}`);
  }
  console.log(`[C-workflow] start signal=${signal.id} status=${signal.status}`);

  const items = await fetchItemsByExternalIds(signal.source_items);
  console.log(`[C-workflow] fetched source_items=${items.length}`);

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
      console.log(`[C-workflow] created Hindsight bank`);
    } else {
      throw err;
    }
  }

  const recallQuery = signal.title + (signal.description.length > 0 ? " " + signal.description : "");
  const prior = await hindsight.recall(HINDSIGHT_BANK_ID, recallQuery, {
    limit: 10,
    tags: signal.tags,
  });
  console.log(`[C-workflow] recalled=${prior.length}`);

  const userPrompt = buildUserPrompt(signal, items, prior);
  const llmResult: AskResult = await ask(userPrompt, {
    system: SYSTEM_PROMPT,
    json: true,
    temperature: 0.4,
    maxTokens: 3000,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResult.content);
  } catch (err) {
    throw new Error(
      `LLM did not return valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`LLM JSON root is not an object`);
  }
  const obsField = (parsed as Record<string, unknown>).observations;
  if (!Array.isArray(obsField)) {
    throw new Error(`LLM JSON missing 'observations' array`);
  }

  let retained = 0;
  let failed = 0;
  const validFindings: ResearchFinding[] = [];
  const runStartIso = new Date().toISOString();
  let obsIndex = 0;
  for (const rawObs of obsField) {
    const v = validateFinding(rawObs);
    if (!v.ok) {
      console.log(`[C-workflow] skipping invalid observation: ${v.error}`);
      continue;
    }
    const documentId = `signal-${signal.id}-${runStartIso}-${obsIndex}`;
    obsIndex++;
    try {
      await hindsight.retain(HINDSIGHT_BANK_ID, {
        text: v.value.observation,
        context: signal.title,
        type: "observation",
        occurred_start: runStartIso,
        occurred_end: runStartIso,
        entities: [...new Set(v.value.entities)],
        tags: [...new Set([...signal.tags, ...v.value.tags, `signal:${signal.id}`])],
        document_id: documentId,
      });
      retained++;
      validFindings.push(v.value);
    } catch (err) {
      failed++;
      console.log(`[C-workflow] failed retain: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`[C-workflow] retained=${retained} total=${obsField.length} failed=${failed}`);

  // write markdown report
  const titleSlug = slugify(signal.title) || "signal";
  const idSuffix = signal.id.replace(/-/g, "").slice(0, 8);
  const slug = `${titleSlug}-${idSuffix}`;
  const reportPath = `drafts/event-tracking/${slug}.md`;
  const reportContent = generateReportMarkdown(signal, items, prior, validFindings);
  const fullPath = join(process.cwd(), reportPath);
  const dir = fullPath.slice(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, reportContent, "utf-8");
  console.log(`[C-workflow] wrote ${reportPath}`);

  // status update
  if (signal.status === "discovered") {
    await updateSignalStatus(signal.id, "tracking");
    console.log(`[C-workflow] signal status discovered→tracking`);
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
  lines.push(`- **Tags**: ${signal.tags.length ? signal.tags.join(", ") : "(none)"}`);
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

async function researchStep(signalId: string): Promise<ResearchStepResult> {
  "use step";
  await initDb();
  return await researchLogic(signalId);
}

export async function cWorkflow(signalId: string): Promise<ResearchStepResult> {
  "use workflow";
  console.log(`[C-workflow] run signal=${signalId}`);
  const result = await researchStep(signalId);
  console.log(
    `[C-workflow] done signal=${signalId} retained=${result.observationsRetained} path=${result.reportPath}`,
  );
  return result;
}
