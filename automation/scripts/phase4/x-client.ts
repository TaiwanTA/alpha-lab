// Phase 4 Task 2 — narrow X API v2 client + strict YAML parser.
//
// Module shape (all exports the Task 2 test file imports):
//   - parseInvestorSources(text)   strict X-only YAML registry parser.
//   - toPostUrl(handle, id)        canonical post URL.
//   - buildUserLookupUrl(handle)   GET .../users/by/username/{handle}.
//   - buildTimelineUrl(...)        GET .../users/{id}/tweets.
//   - normalizeTweets(payload, source)
//                                 pure payload → ledger-row mapper; SHA-256
//                                 content_hash is stable across runs.
//   - IngestXClient                walks both endpoints, follows the opaque
//                                 meta.next_token pagination cursor, and
//                                 throws on 429 / non-2xx so Dagu owns
//                                 the retry loop.
//
// Contract boundary: this module owns HTTP I/O. The caller hands it an
// `XApiClient` (a thin fetch shim) so unit tests can drive it with static
// JSON fixtures and never touch the network. The brief forbids any other
// endpoint besides users/by/username and users/{id}/tweets; buildTimelineUrl
// is the only place those query parameters live, so adding a new field is
// a one-line audit.

import { createHash } from "node:crypto";

import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Strict X-only registry parser.
// ---------------------------------------------------------------------------

export type InvestorSource = {
  key: string;
  investor: string;
  type: "x";
  handle: string;
  enabled: boolean;
};

export type InvestorSourceRegistry = {
  version: number;
  sources: InvestorSource[];
};

const SUPPORTED_VERSION = 1;
const ALLOWED_TOP_LEVEL = new Set(["version", "sources"]);

export function parseInvestorSources(text: string): InvestorSourceRegistry {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new Error(
      `investor sources: malformed YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("investor sources: top-level must be a mapping");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      throw new Error(`investor sources: unknown top-level field '${key}'`);
    }
  }
  if (obj.version !== SUPPORTED_VERSION) {
    throw new Error(
      `investor sources: unsupported version ${JSON.stringify(obj.version)}`,
    );
  }
  if (!Array.isArray(obj.sources)) {
    throw new Error("investor sources: 'sources' must be an array");
  }
  const seenKeys = new Set<string>();
  const enabled: InvestorSource[] = [];
  for (const [idx, entry] of (obj.sources as unknown[]).entries()) {
    const label = `source #${idx + 1}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`investor sources: ${label} must be a mapping`);
    }
    const src = entry as Record<string, unknown>;
    const key = src.key;
    if (typeof key !== "string" || key.length === 0) {
      throw new Error(`investor sources: ${label} is missing a non-empty key`);
    }
    if (seenKeys.has(key)) {
      throw new Error(`investor sources: duplicate key '${key}'`);
    }
    seenKeys.add(key);
    const investor = src.investor;
    if (typeof investor !== "string" || investor.length === 0) {
      throw new Error(
        `investor sources: ${label} '${key}' is missing a non-empty investor`,
      );
    }
    const type = src.type;
    if (type !== "x") {
      throw new Error(
        `investor sources: ${label} '${key}' has unsupported type ${JSON.stringify(type)}`,
      );
    }
    const handle = src.handle;
    if (typeof handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
      throw new Error(
        `investor sources: ${label} '${key}' has a malformed handle`,
      );
    }
    const enabledFlag = src.enabled;
    if (typeof enabledFlag !== "boolean") {
      throw new Error(
        `investor sources: ${label} '${key}' enabled must be boolean`,
      );
    }
    if (!enabledFlag) continue;
    enabled.push({ key, investor, type: "x", handle, enabled: true });
  }
  if (enabled.length === 0) {
    throw new Error("investor sources: enabled source list is empty");
  }
  return { version: SUPPORTED_VERSION, sources: enabled };
}

// ---------------------------------------------------------------------------
// URL builders. The brief authorizes exactly two endpoints; both URLs are
// assembled in one place so any new field is auditable.
// ---------------------------------------------------------------------------

export function toPostUrl(handle: string, id: string): string {
  return `https://x.com/${handle}/status/${id}`;
}

export function buildUserLookupUrl(handle: string): string {
  return `https://api.x.com/2/users/by/username/${encodeURIComponent(handle)}`;
}

export function buildTimelineUrl(
  userId: string,
  sinceId: string | undefined,
  paginationToken?: string,
): string {
  const params = new URLSearchParams({
    exclude: "replies,retweets",
    "tweet.fields": "created_at",
  });
  if (sinceId !== undefined && sinceId.length > 0) {
    params.set("since_id", sinceId);
  }
  if (paginationToken !== undefined && paginationToken.length > 0) {
    params.set("pagination_token", paginationToken);
  }
  return `https://api.x.com/2/users/${encodeURIComponent(userId)}/tweets?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Tweet → ledger row normalization. Pure: no I/O, deterministic content_hash
// derived from UTF-8 source text via SHA-256 so the UNIQUE(investor,
// source_url, published_at, content_hash) constraint catches duplicates.
// ---------------------------------------------------------------------------

export type XTweet = {
  id: string;
  text: string;
  createdAt: Date;
};

export type NormalizedEvent = {
  sourceKey: string;
  investor: string;
  sourceUrl: string;
  rawContent: string;
  contentHash: string;
  publishedAt: Date;
};

export type XTimelinePayload = {
  data?: Array<{
    id?: unknown;
    text?: unknown;
    created_at?: unknown;
  }>;
  meta?: { next_token?: unknown };
};

export function extractTweets(payload: XTimelinePayload): XTweet[] {
  if (payload.data === undefined) return [];
  if (!Array.isArray(payload.data)) {
    throw new Error("x client: timeline returned malformed tweet data");
  }

  return payload.data.map((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      throw new Error(`x client: timeline returned malformed tweet #${index + 1}`);
    }
    const tweet = raw as { id?: unknown; text?: unknown; created_at?: unknown };
    if (
      typeof tweet.id !== "string" ||
      !/^[0-9]+$/.test(tweet.id) ||
      typeof tweet.text !== "string" ||
      tweet.text.length === 0 ||
      typeof tweet.created_at !== "string"
    ) {
      throw new Error(`x client: timeline returned malformed tweet #${index + 1}`);
    }
    const createdAt = new Date(tweet.created_at);
    if (Number.isNaN(createdAt.getTime())) {
      throw new Error(`x client: timeline returned malformed tweet #${index + 1}`);
    }
    return { id: tweet.id, text: tweet.text, createdAt };
  });
}
export function normalizeTweets(
  payload: XTimelinePayload,
  source: InvestorSource,
): NormalizedEvent[] {
  return extractTweets(payload).map((tweet) => {
    const contentHash = createHash("sha256")
      .update(tweet.text, "utf8")
      .digest("hex");
    return {
      sourceKey: source.key,
      investor: source.investor,
      sourceUrl: toPostUrl(source.handle, tweet.id),
      rawContent: tweet.text,
      contentHash,
      publishedAt: tweet.createdAt,
    };
  });
}

// ---------------------------------------------------------------------------
// IngestXClient — the only object that talks to api.x.com. Pages through
// meta.next_token until exhausted; throws on 429 or non-2xx so Dagu owns
// the retry budget (the brief explicitly forbids silent retries).
// ---------------------------------------------------------------------------

export type XApiClient = {
  fetch(url: string, init?: RequestInit): Promise<Response>;
};

export class IngestXClient {
  constructor(private readonly api: XApiClient) {}

  async lookupUserId(handle: string): Promise<string> {
    const url = buildUserLookupUrl(handle);
    const response = await this.api.fetch(url, {
      method: "GET",
      headers: this.authHeaders(),
    });
    if (response.status === 429) {
      throw new Error(`x client: 429 from ${url} (Dagu should retry)`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `x client: ${response.status} from ${url} — body: ${await response.text()}`,
      );
    }
    const body = (await response.json()) as { data?: { id?: unknown } };
    const id = body.data?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`x client: lookup ${url} returned no id`);
    }
    return id;
  }

  async *fetchTimeline(
    userId: string,
    sinceId?: string,
  ): AsyncGenerator<XTweet> {
    let paginationToken: string | undefined;
    while (true) {
      const url = buildTimelineUrl(userId, sinceId, paginationToken);
      const response = await this.api.fetch(url, {
        method: "GET",
        headers: this.authHeaders(),
      });
      if (response.status === 429) {
        throw new Error(`x client: 429 from ${url} (Dagu should retry)`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(
          `x client: ${response.status} from ${url} — body: ${await response.text()}`,
        );
      }
      const payload = (await response.json()) as XTimelinePayload;
      yield* extractTweets(payload);
      const meta = payload.meta;
      if (meta === undefined || !("next_token" in meta)) break;
      const next = meta.next_token;
      if (typeof next !== "string" || next.length === 0) {
        throw new Error("x client: timeline returned invalid next_token");
      }
      paginationToken = next;
    }
  }

  private authHeaders(): HeadersInit {
    const token = process.env.X_BEARER_TOKEN;
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("x client: X_BEARER_TOKEN is required");
    }
    return { Authorization: `Bearer ${token}` };
  }
}