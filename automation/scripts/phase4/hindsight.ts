// automation/scripts/phase4/hindsight.ts
//
// Fail-closed Hindsight client. Two endpoints only, both against the
// `alpha-lab` bank:
//
//   POST /v1/default/banks/alpha-lab/memories           (retain)
//   POST /v1/default/banks/alpha-lab/memories/recall    (recall)
//
// v0.8.4 wire protocol (per https://hindsight.vectorize.io/developer/api/retain
// and https://hindsight.vectorize.io/developer/api/recall):
//
//   retain  request body  : { items: [{ content, context?, ... }] }
//   retain  response shape: { success: boolean, bank_id: string,
//                             items_count: number, async?: boolean,
//                             usage?: { input_tokens, output_tokens, total_tokens } }
//
//   recall  request body  : { query: string, ... }
//   recall  response shape: { results: RecallResult[] }
//   RecallResult fields   : { id, text, type?, context?, metadata?,
//                             tags?, entities?, occurred_start?,
//                             occurred_end?, mentioned_at?,
//                             document_id?, chunk_id? }
//
// The brief requires:
//   - reject malformed responses rather than silently producing an
//     empty memory list
//   - 4xx/5xx surface as Error messages so the research command
//     fails loud (no partial persistence)
//
// `HindsightConfig` is the resolved environment shape; `HindsightClient`
// is the public surface the rest of the pipeline uses.

export interface HindsightConfig {
  baseUrl: string;
  apiKey: string | null;
  bankId: string;
}

/** A single memory returned by Hindsight recall. The full v0.8.4
 *  RecallResult carries many more fields (type, context, metadata,
 *  tags, entities, occurred_start / occurred_end, mentioned_at,
 *  document_id, chunk_id); the research pipeline consumes only
 *  `id` + `text` and keeps the raw record under `raw` so downstream
 *  code can introspect the rest without a separate type. */
export interface HindsightRecallResult {
  id: string;
  text: string;
  raw: Record<string, unknown>;
}

/** Synchronous retain response per v0.8.4 docs. `usage` is present
 *  for synchronous operations only and may be absent for async
 *  ingestion; the client treats both shapes as valid. */
export interface HindsightRetainResponse {
  success: boolean;
  bankId: string;
  itemsCount: number;
  async: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** Recall response — top-level `results` array per v0.8.4 docs. */
export interface HindsightRecallResponse {
  results: HindsightRecallResult[];
}

export interface HindsightClient {
  retain(content: string, context: string): Promise<HindsightRetainResponse>;
  recall(query: string): Promise<HindsightRecallResponse>;
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Resolve Hindsight config from process env. Reads HINDSIGHT_BASE_URL,
 *  HINDSIGHT_API_KEY (optional), HINDSIGHT_BANK_ID. Throws when the
 *  base URL is missing — fail-closed. */
export function loadHindsightConfig(
  env: Record<string, string | undefined> = process.env,
): HindsightConfig {
  const baseUrl = env.HINDSIGHT_BASE_URL;
  if (!baseUrl || baseUrl.trim().length === 0) {
    throw new Error("HINDSIGHT_BASE_URL is required");
  }
  const bankId = env.HINDSIGHT_BANK_ID?.trim() || "alpha-lab";
  const apiKeyRaw = env.HINDSIGHT_API_KEY?.trim();
  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey: apiKeyRaw && apiKeyRaw.length > 0 ? apiKeyRaw : null,
    bankId,
  };
}

// ---------------------------------------------------------------------------
// Response validators — strict, fail-closed on any malformed shape
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRetainResponse(raw: unknown): HindsightRetainResponse {
  if (!isRecord(raw)) {
    throw new Error("hindsight retain: response is not a JSON object");
  }
  const success = raw.success;
  if (typeof success !== "boolean") {
    throw new Error(
      "hindsight retain: response is missing boolean 'success'",
    );
  }
  if (success === false) {
    throw new Error(
      "hindsight retain: response reports success=false; refusing to treat as accepted",
    );
  }
  const bankId = raw.bank_id;
  if (typeof bankId !== "string" || bankId.length === 0) {
    throw new Error(
      "hindsight retain: response is missing string 'bank_id'",
    );
  }
  const itemsCount = raw.items_count;
  if (typeof itemsCount !== "number" || !Number.isFinite(itemsCount)) {
    throw new Error(
      "hindsight retain: response is missing finite number 'items_count'",
    );
  }
  const asyncFlag = raw.async;
  if (typeof asyncFlag !== "boolean") {
    throw new Error(
      "hindsight retain: response is missing boolean 'async'",
    );
  }
  let usage: HindsightRetainResponse["usage"];
  if (raw.usage !== undefined) {
    if (!isRecord(raw.usage)) {
      throw new Error("hindsight retain: response 'usage' is not an object");
    }
    const inputTokens = raw.usage.input_tokens;
    const outputTokens = raw.usage.output_tokens;
    const totalTokens = raw.usage.total_tokens;
    if (
      typeof inputTokens !== "number" ||
      typeof outputTokens !== "number" ||
      typeof totalTokens !== "number" ||
      !Number.isFinite(inputTokens) ||
      !Number.isFinite(outputTokens) ||
      !Number.isFinite(totalTokens)
    ) {
      throw new Error(
        "hindsight retain: response 'usage' is missing finite input_tokens / output_tokens / total_tokens",
      );
    }
    usage = { inputTokens, outputTokens, totalTokens };
  }
  return { success, bankId, itemsCount, async: asyncFlag, usage };
}

function parseRecallResult(
  value: unknown,
  idx: number,
): HindsightRecallResult {
  if (!isRecord(value)) {
    throw new Error(
      `hindsight recall: results[${idx}] is not a JSON object`,
    );
  }
  const id = value.id;
  const text = value.text;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `hindsight recall: results[${idx}] is missing string 'id'`,
    );
  }
  if (typeof text !== "string") {
    throw new Error(
      `hindsight recall: results[${idx}].text must be a string`,
    );
  }
  return { id, text, raw: value };
}

function parseRecallResponse(raw: unknown): HindsightRecallResponse {
  if (!isRecord(raw)) {
    throw new Error("hindsight recall: response is not a JSON object");
  }
  if (!Array.isArray(raw.results)) {
    throw new Error(
      "hindsight recall: response is missing array 'results'",
    );
  }
  const results = raw.results.map((value: unknown, idx: number) =>
    parseRecallResult(value, idx),
  );
  return { results };
}

// ---------------------------------------------------------------------------
// HTTP plumbing — shared by retain + recall
// ---------------------------------------------------------------------------

async function hindsightRequest(
  config: HindsightConfig,
  path: string,
  body: unknown,
): Promise<unknown> {
  const url = `${config.baseUrl}/v1/default/banks/${encodeURIComponent(
    config.bankId,
  )}/${path}`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `hindsight ${path} failed: ${response.status} ${response.statusText} — ${text}`,
    );
  }
  let raw: unknown;
  try {
    raw = await response.json();
  } catch (err) {
    throw new Error(
      `hindsight ${path} failed: response is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHindsightClient(
  config: HindsightConfig,
): HindsightClient {
  return {
    async retain(content, context) {
      // v0.8.4 retain body: { items: [{ content, context, ... }] }
      const raw = await hindsightRequest(config, "memories", {
        items: [{ content, context }],
      });
      return parseRetainResponse(raw);
    },
    async recall(query) {
      // v0.8.4 recall body: { query }
      const raw = await hindsightRequest(config, "memories/recall", {
        query,
      });
      return parseRecallResponse(raw);
    },
  };
}