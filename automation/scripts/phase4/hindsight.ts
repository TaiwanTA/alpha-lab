// automation/scripts/phase4/hindsight.ts
//
// Fail-closed Hindsight client. Two endpoints only, both against the
// `alpha-lab` bank:
//
//   POST /v1/default/banks/alpha-lab/memories           (retain)
//   POST /v1/default/banks/alpha-lab/memories/recall    (recall)
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

export interface HindsightMemoryItem {
  id: string;
  content: string;
  context: string;
}

export interface HindsightRetainResponse {
  id: string;
}

export interface HindsightRecallResponse {
  items: HindsightMemoryItem[];
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
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("hindsight retain: response is missing string 'id'");
  }
  return { id };
}

function parseMemoryItem(value: unknown, idx: number): HindsightMemoryItem {
  if (!isRecord(value)) {
    throw new Error(
      `hindsight recall: items[${idx}] is not a JSON object`,
    );
  }
  const id = value.id;
  const content = value.content;
  const context = value.context;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `hindsight recall: items[${idx}] is missing string 'id'`,
    );
  }
  if (typeof content !== "string") {
    throw new Error(
      `hindsight recall: items[${idx}].content must be a string`,
    );
  }
  if (typeof context !== "string") {
    throw new Error(
      `hindsight recall: items[${idx}].context must be a string`,
    );
  }
  return { id, content, context };
}

function parseRecallResponse(raw: unknown): HindsightRecallResponse {
  if (!isRecord(raw)) {
    throw new Error("hindsight recall: response is not a JSON object");
  }
  if (!Array.isArray(raw.items)) {
    throw new Error(
      "hindsight recall: response is missing string[] 'items'",
    );
  }
  const items = raw.items.map((value: unknown, idx: number) =>
    parseMemoryItem(value, idx),
  );
  return { items };
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
      const raw = await hindsightRequest(config, "memories", {
        content,
        context,
      });
      return parseRetainResponse(raw);
    },
    async recall(query) {
      const raw = await hindsightRequest(config, "memories/recall", {
        query,
      });
      return parseRecallResponse(raw);
    },
  };
}
