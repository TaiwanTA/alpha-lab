#!/usr/bin/env bun
// automation/scripts/research-agent.ts
//
// v3 research agent — replaces hermes-call.sh and the separate
// hindsight-retain/recall DAG steps. Self-contained single-shot
// LLM agent that:
//   1. Retains fixture facts to Hindsight
//   2. Recalls prior observations from Hindsight
//   3. Calls LLM (MiniMax-M3 via OpenAI-compatible API)
//   4. Parses JSON response (with MiniMax thinking-model extraction)
//   5. Assembles candidate.md with valid frontmatter
//   6. Writes to ALPHA_LAB_CANDIDATE_PATH
//
// No Docker, no Hermes, no UID mismatch. Same MiniMax-M3 model,
// same Hindsight API — all direct fetch, no container layers.
//
// 环境变量 (from /etc/alpha-lab/dagu.env or DAG step env):
//   LLM_API_KEY         — MiniMax / OpenRouter API key
//   LLM_MODEL           — model name (default: MiniMax-M3)
//   LLM_BASE_URL        — API endpoint
//   HINDSIGHT_BASE_URL  — Hindsight endpoint (host: http://127.0.0.1:8888)
//   HINDSIGHT_API_KEY   — optional API key
//   HINDSIGHT_BANK_ID   — bank ID (default: alpha-lab-v3-fixture)
//   ALPHA_LAB_CANDIDATE_PATH — host path for candidate.md
//   ALPHA_LAB_RUN_ID    — Dagu run ID (for logging)
//   ALPHA_LAB_WORKSPACE — checked-out worktree root

// --- Types ---

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface HindsightConfig {
  baseUrl: string;
  apiKey: string;
  bankId: string;
}

interface AgentResponse {
  title: string;
  date: string;
  summary: string;
  tags: string[];
  investors: string[];
  tickers: string[];
  investmentClaim: boolean;
  body: string;
  sourceUrl: string;
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

// 从 LLM content 内 extract JSON object:
//   - 若 content 已是纯 JSON (以 { 开头), 直接回整个 content
//   - 若 content 含 markdown ```json{...}``` 或夹杂 reasoning 文字,
//     抓最后一个 {...} 区块
// 思考模型 (thinking model) 常会在 JSON 前面输出 reasoning, 造成
// consumer 的 JSON.parse 在 content 开头就失败; 这个 helper 把那段剥掉。
export function extractJsonObject(raw: string): string {
  const trimmed = raw.trim();
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // 继续尝试 extract
  }
  const lastOpen = trimmed.lastIndexOf("{");
  if (lastOpen === -1) return raw;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = lastOpen; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const candidate = trimmed.slice(lastOpen, i + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // 不是合法 JSON, 继续找下一个 }
        }
      }
    }
  }
  return raw;
}

// YAML double-quoted string escape: 反斜杠, 双引号, 换行
function yamlString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}

function yamlArray(arr: string[]): string {
  if (arr.length === 0) return "[]";
  return `[${arr.map(yamlString).join(", ")}]`;
}

// --- LLM ---

async function llmAsk(
  prompt: string,
  system: string,
  config: LlmConfig,
): Promise<string> {
  const isMiniMax =
    config.baseUrl.includes("minimaxi.chat") ||
    config.model.toLowerCase().startsWith("minimax");

  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: prompt },
    ],
    temperature: 0.4,
  };
  // MiniMax-M3 是 thinking model, 在 response_format=json_object 模式下
  // 仍会输出 reasoning 区块, 破坏 consumer 的 JSON.parse。停用 thinking,
  // 不设 response_format, 改靠 extractJsonObject 从 content 内解。
  if (isMiniMax) {
    body.thinking = { type: "disabled" };
  }

  const maxAttempts = 3;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (res.status === 408 || res.status === 429 || res.status >= 500) {
        await res.body?.cancel().catch(() => {});
        const waitMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
        await sleep(waitMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM API error ${res.status}: ${text.slice(0, 300)}`);
      }

      const data = await res.json() as {
        choices?: Array<{
          message?: { content?: string };
          finish_reason?: string;
        }>;
      };
      const choice = data.choices?.[0];
      if (!choice) throw new Error("LLM API returned no choices");
      if (choice.finish_reason === "content_filter") {
        throw new Error("LLM content blocked by provider");
      }
      const content = choice.message?.content;
      if (!content) throw new Error("LLM API returned no content");

      return extractJsonObject(content);
    } catch (err) {
      // 只 retry transient: AbortError (超时) + TypeError (网络断)
      const isTransient =
        err instanceof Error &&
        (err.name === "AbortError" || err instanceof TypeError);
      if (!isTransient) throw err;
      if (attempt >= maxAttempts - 1) {
        throw new Error(
          `LLM request failed after ${maxAttempts} attempts: ${err instanceof Error ? err.message : err}`,
        );
      }
      const waitMs = 1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      await sleep(waitMs);
    }
  }
  throw new Error(`LLM request failed after ${maxAttempts} attempts`);
}

// --- Hindsight ---

async function hindsightRetain(
  content: string,
  context: string,
  config: HindsightConfig,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const res = await fetch(
    `${config.baseUrl}/v1/default/banks/${encodeURIComponent(config.bankId)}/memories`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ items: [{ content, context }] }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hindsight retain error ${res.status}: ${text.slice(0, 200)}`);
  }
}

async function hindsightRecall(
  query: string,
  config: HindsightConfig,
): Promise<string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers["Authorization"] = `Bearer ${config.apiKey}`;

  const res = await fetch(
    `${config.baseUrl}/v1/default/banks/${encodeURIComponent(config.bankId)}/memories/recall`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ query }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Hindsight recall error ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  // Hindsight v0.8.4 响应可能是 array, {results: [...]}, 或 {memories: [...]}
  let results: unknown[];
  if (Array.isArray(data)) {
    results = data;
  } else if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    results = Array.isArray(obj.results) ? obj.results
      : Array.isArray(obj.memories) ? obj.memories
      : [];
  } else {
    results = [];
  }
  return JSON.stringify(results, null, 2);
}

// --- Candidate assembly ---

export function assembleCandidate(response: AgentResponse): string {
  const f = response;

  // 跟 publish-draft.ts 的 validateFrontmatter / validateBody 对齐:
  // 不通过这里的 validation 就不可能过 publisher gate。
  if (typeof f.title !== "string" || f.title.length === 0 || f.title.length > 200)
    throw new Error(`Invalid title: length=${f.title?.length ?? "N/A"}`);
  if (typeof f.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(f.date))
    throw new Error(`Invalid date: ${JSON.stringify(f.date)}`);
  if (typeof f.summary !== "string" || f.summary.length === 0 || f.summary.length > 500)
    throw new Error(`Invalid summary: length=${f.summary?.length ?? "N/A"}`);
  if (!Array.isArray(f.tags) || f.tags.some(t => typeof t !== "string"))
    throw new Error("tags must be an array of strings");
  if (!Array.isArray(f.investors) || f.investors.some(i => typeof i !== "string"))
    throw new Error("investors must be an array of strings");
  if (!Array.isArray(f.tickers) || f.tickers.some(t => typeof t !== "string"))
    throw new Error("tickers must be an array of strings");
  if (typeof f.investmentClaim !== "boolean")
    throw new Error(`Invalid investmentClaim: ${typeof f.investmentClaim}`);
  if (typeof f.sourceUrl !== "string" || !f.sourceUrl.startsWith("https://"))
    throw new Error(`Invalid sourceUrl: must be https://`);
  if (typeof f.body !== "string" || f.body.trim().length === 0)
    throw new Error("Body must not be empty");

  // 检查 body 不含禁止语法 (跟 publish-draft.ts validateBody 对齐)
  for (const line of f.body.split(/\r?\n/)) {
    if (/^(?:import|export)\s/i.test(line))
      throw new Error(`prohibited syntax (import/export): ${line.trim()}`);
    if (/<script/i.test(line))
      throw new Error(`prohibited syntax (<script): ${line.trim()}`);
    if (/\bon[a-z]+\s*=/i.test(line))
      throw new Error(`prohibited syntax (event attr): ${line.trim()}`);
  }

  // 组装 frontmatter + body + 来源 section
  // status 一律强制 "draft" (跟 publisher 行为一致)
  return `---
title: ${yamlString(f.title)}
date: "${f.date}"
summary: ${yamlString(f.summary)}
status: draft
tags: ${yamlArray(f.tags)}
investors: ${yamlArray(f.investors)}
tickers: ${yamlArray(f.tickers)}
investmentClaim: ${f.investmentClaim}
---

${f.body}

## 來源

- ${f.sourceUrl}
`;
}

// --- CLI entry ---

if (import.meta.main) {
  const workspace = process.env.ALPHA_LAB_WORKSPACE ?? ".";
  const candidatePath = process.env.ALPHA_LAB_CANDIDATE_PATH;
  const runId = process.env.ALPHA_LAB_RUN_ID ?? "unknown";

  const llmConfig: LlmConfig = {
    baseUrl: (process.env.LLM_BASE_URL ?? "https://api.minimaxi.chat/v1").replace(/\/+$/, ""),
    apiKey: process.env.LLM_API_KEY ?? "",
    model: process.env.LLM_MODEL ?? "MiniMax-M3",
  };
  const hindsightConfig: HindsightConfig = {
    baseUrl: (process.env.HINDSIGHT_BASE_URL ?? "http://localhost:8888").replace(/\/+$/, ""),
    apiKey: process.env.HINDSIGHT_API_KEY ?? "",
    bankId: process.env.HINDSIGHT_BANK_ID ?? "alpha-lab-v3-fixture",
  };

  if (!llmConfig.apiKey) {
    console.error("LLM_API_KEY is required");
    process.exit(2);
  }
  if (!candidatePath) {
    console.error("ALPHA_LAB_CANDIDATE_PATH is required");
    process.exit(2);
  }

  console.log(
    `=== research-agent === run_id=${runId} bank=${hindsightConfig.bankId}` +
    ` model=${llmConfig.model} candidate=${candidatePath}`,
  );

  // 1. Read fixture + prompt from the git checkout (not deployed copy)
  const fixtureContent = await Bun.file(
    `${workspace}/automation/fixtures/safe-publish.md`,
  ).text();
  const systemPrompt = await Bun.file(
    `${workspace}/automation/prompts/fixture-research.md`,
  ).text();

  // 2. Retain fixture to Hindsight
  await hindsightRetain(fixtureContent, "fixture:safe-publish", hindsightConfig);
  console.log("retained fixture to Hindsight");

  // 3. Recall prior observations
  const recallJson = await hindsightRecall(
    "alpha-lab offline fixture research",
    hindsightConfig,
  );
  console.log(`recalled ${recallJson.length} bytes from Hindsight`);

  // 4. Build LLM prompt
  const userPrompt = `## Fixture content

${fixtureContent}

## Prior observations from Hindsight

${recallJson}

## Task

Synthesize the fixture content and recalled observations into a blog post
draft. Output the JSON object described in your system prompt.`;

  // 5. Call LLM
  const llmResponse = await llmAsk(userPrompt, systemPrompt, llmConfig);
  console.log(`LLM response: ${llmResponse.length} bytes`);

  // 6. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(llmResponse);
  } catch (err) {
    console.error(`LLM did not return valid JSON: ${err}`);
    console.error(`Content first 300 chars: ${llmResponse.slice(0, 300)}`);
    process.exit(1);
  }

  // 7. Assemble candidate (validates before writing)
  let candidate: string;
  try {
    candidate = assembleCandidate(parsed as AgentResponse);
  } catch (err) {
    console.error(`Failed to assemble candidate: ${err}`);
    process.exit(1);
  }

  // 8. Write
  await Bun.write(candidatePath, candidate);
  console.log(`wrote candidate to ${candidatePath} (${candidate.length} bytes)`);
}
