import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  parseInvestorSources,
  toPostUrl,
  buildUserLookupUrl,
  buildTimelineUrl,
  normalizeTweets,
  IngestXClient,
  type InvestorSource,
  type XApiClient,
  type XTweet,
} from "../scripts/phase4/x-client.ts";
import { commitSourceBatch } from "../scripts/ingest-events.ts";

// ---------------------------------------------------------------------------
// parseInvestorSources — strict X-only YAML registry parser.
//
// Separate from Task 1's parseSourceRegistry (which handles a generic
// investor → sources mapping). Task 2 only ingests X timelines, so this
// parser is narrower: it rejects non-X `type`, requires a non-empty
// `handle`, refuses duplicate keys, rejects unknown top-level fields,
// and refuses to return when every enabled source has been disabled.
// ---------------------------------------------------------------------------

const BILL_YAML = `version: 1
sources:
  - key: bill-ackman-x
    investor: Bill Ackman
    type: x
    handle: BillAckman
    enabled: true
`;

describe("parseInvestorSources", () => {
  test("parses the checked-in registry and returns a flat sources array", () => {
    const parsed = parseInvestorSources(BILL_YAML);
    expect(parsed.sources).toHaveLength(1);
    expect(parsed.sources[0]).toEqual({
      key: "bill-ackman-x",
      investor: "Bill Ackman",
      type: "x",
      handle: "BillAckman",
      enabled: true,
    });
    expect(parsed.version).toBe(1);
  });

  test("filters out disabled sources when at least one remains enabled", () => {
    const yaml = `version: 1
sources:
  - key: keep
    investor: K
    type: x
    handle: KHandle
    enabled: true
  - key: drop
    investor: D
    type: x
    handle: DHandle
    enabled: false
`;
    const parsed = parseInvestorSources(yaml);
    expect(parsed.sources.map((s) => s.key)).toEqual(["keep"]);
  });

  test("rejects an empty enabled source list", () => {
    const yaml = `version: 1
sources:
  - key: a
    investor: A
    type: x
    handle: AHandle
    enabled: false
`;
    expect(() => parseInvestorSources(yaml)).toThrow(/enabled source/i);
  });

  test("rejects non-X source types", () => {
    const yaml = `version: 1
sources:
  - key: a
    investor: A
    type: rss
    handle: AHandle
    enabled: true
`;
    expect(() => parseInvestorSources(yaml)).toThrow(/type/i);
  });

  test("rejects malformed handles (empty, whitespace, or non-string)", () => {
    const emptyHandle = `version: 1
sources:
  - key: a
    investor: A
    type: x
    handle: ""
    enabled: true
`;
    expect(() => parseInvestorSources(emptyHandle)).toThrow(/handle/i);

    const whitespaceHandle = `version: 1
sources:
  - key: a
    investor: A
    type: x
    handle: "  "
    enabled: true
`;
    expect(() => parseInvestorSources(whitespaceHandle)).toThrow(/handle/i);

    const numericHandle = `version: 1
sources:
  - key: a
    investor: A
    type: x
    handle: 123
    enabled: true
`;
    expect(() => parseInvestorSources(numericHandle)).toThrow(/handle/i);
  });

  test("enforces X username grammar", () => {
    const valid = parseInvestorSources(`version: 1
sources:
  - key: valid
    investor: Valid
    type: x
    handle: A_b123456789012
    enabled: true
`);
    expect(valid.sources[0]?.handle).toBe("A_b123456789012");

    for (const handle of [
      "@BillAckman",
      "bill-ackman",
      "has space",
      "投資人",
      "abcdefghijklmnop",
    ]) {
      const yaml = `version: 1
sources:
  - key: invalid
    investor: Invalid
    type: x
    handle: ${JSON.stringify(handle)}
    enabled: true
`;
      expect(() => parseInvestorSources(yaml)).toThrow(/handle/i);
    }
  });

  test("rejects malformed YAML", () => {
    expect(() => parseInvestorSources(":\n  : -")).toThrow();
  });

  test("rejects unknown top-level fields", () => {
    const yaml = `version: 1
extra: nope
sources:
  - key: a
    investor: A
    type: x
    handle: AHandle
    enabled: true
`;
    expect(() => parseInvestorSources(yaml)).toThrow(/unknown/i);
  });

  test("rejects duplicate source keys", () => {
    const yaml = `version: 1
sources:
  - key: dup
    investor: A
    type: x
    handle: aaa
    enabled: true
  - key: dup
    investor: B
    type: x
    handle: bbb
    enabled: true
`;
    expect(() => parseInvestorSources(yaml)).toThrow(/duplicate/i);
  });

  test("rejects when sources is missing", () => {
    expect(() => parseInvestorSources("version: 1\n")).toThrow(/sources/i);
  });

  test("rejects an unsupported version", () => {
    expect(() =>
      parseInvestorSources(
        `version: 99
sources:
  - key: a
    investor: A
    type: x
    handle: aaa
    enabled: true
`,
      ),
    ).toThrow(/version/i);
  });
});

// ---------------------------------------------------------------------------
// toPostUrl — stable URL the ingestor persists into signal_events.source_url.
// ---------------------------------------------------------------------------

describe("toPostUrl", () => {
  test("builds the canonical post URL", () => {
    expect(toPostUrl("BillAckman", "123")).toBe(
      "https://x.com/BillAckman/status/123",
    );
  });
});

// ---------------------------------------------------------------------------
// URL construction — Dagu owns retries; the client must hit exactly the two
// endpoints the brief authorizes.
// ---------------------------------------------------------------------------

describe("URL builders", () => {
  test("buildUserLookupUrl hits users/by/username", () => {
    expect(buildUserLookupUrl("BillAckman")).toBe(
      "https://api.x.com/2/users/by/username/BillAckman",
    );
  });

  test("buildTimelineUrl adds exclude and tweet.fields", () => {
    const url = buildTimelineUrl("42", undefined);
    expect(url).toContain("users/42/tweets");
    expect(url).toContain("exclude=replies%2Cretweets");
    expect(url).toContain("tweet.fields=created_at");
    expect(url).not.toContain("since_id");
  });

  test("buildTimelineUrl adds since_id only when a checkpoint exists", () => {
    const url = buildTimelineUrl("42", "100");
    expect(url).toContain("since_id=100");
  });

  test("buildTimelineUrl threads pagination_token through", () => {
    const url = buildTimelineUrl("42", "100", "abc123");
    expect(url).toContain("pagination_token=abc123");
    expect(url).toContain("since_id=100");
  });
});

  test("buildTimelineUrl preserves an opaque mixed-case pagination token", () => {
    const url = new URL(buildTimelineUrl("42", "100", "AbC-DeF_123"));
    expect(url.searchParams.get("pagination_token")).toBe("AbC-DeF_123");
  });

// ---------------------------------------------------------------------------
// normalizeTweets — turn the X v2 timeline payload into the canonical
// signal_events rows. Idempotent: re-running normalization on the same
// payload yields the same hash so the UNIQUE(investor, source_url,
// published_at, content_hash) catches duplicates.
// ---------------------------------------------------------------------------

describe("normalizeTweets", () => {
  const source: InvestorSource = {
    key: "bill-ackman-x",
    investor: "Bill Ackman",
    type: "x",
    handle: "BillAckman",
    enabled: true,
  };

  test("extracts id, text, createdAt and the canonical URL", () => {
    const payload = {
      data: [
        {
          id: "100",
          text: "hello world",
          created_at: "2026-07-01T12:00:00.000Z",
        },
      ],
    };
    const rows = normalizeTweets(payload, source);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceKey: "bill-ackman-x",
      investor: "Bill Ackman",
      sourceUrl: "https://x.com/BillAckman/status/100",
      rawContent: "hello world",
      publishedAt: new Date("2026-07-01T12:00:00.000Z"),
    });
    // 64 hex chars (SHA-256, lowercase)
    expect(rows[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("throws when any returned tweet is malformed", () => {
    const malformedTweets: unknown[] = [
      null,
      { id: "", text: "empty id", created_at: "2026-07-01T12:00:00.000Z" },
      { id: 100, text: "numeric id", created_at: "2026-07-01T12:00:00.000Z" },
      { id: "abc", text: "non-numeric id", created_at: "2026-07-01T12:00:00.000Z" },
      { id: "12.34", text: "decimal id", created_at: "2026-07-01T12:00:00.000Z" },
      { id: "-1", text: "negative id", created_at: "2026-07-01T12:00:00.000Z" },
      { id: "100", created_at: "2026-07-01T12:00:00.000Z" },
      { id: "100", text: 123, created_at: "2026-07-01T12:00:00.000Z" },
      { id: "100", text: "missing date" },
      { id: "100", text: "bad date", created_at: "not-a-date" },
    ];

    for (const tweet of malformedTweets) {
      expect(() =>
        normalizeTweets({ data: [tweet] } as never, source),
      ).toThrow(/malformed tweet/i);
    }
  });

  test("produces a deterministic content_hash for identical inputs", () => {
    const payload = {
      data: [
        { id: "200", text: "deterministic", created_at: "2026-07-02T00:00:00.000Z" },
      ],
    };
    const first = normalizeTweets(payload, source)[0]?.contentHash;
    const second = normalizeTweets(payload, source)[0]?.contentHash;
    expect(first).toBe(second);
  });
});

// ---------------------------------------------------------------------------
// IngestXClient — wraps the two narrow endpoints, drives pagination through
// meta.next_token, propagates 429 and non-2xx so Dagu owns the retry loop.
// ---------------------------------------------------------------------------

describe("IngestXClient", () => {
  const originalToken = process.env.X_BEARER_TOKEN;

  beforeEach(() => {
    process.env.X_BEARER_TOKEN = "test-token";
  });

  afterEach(() => {
    if (originalToken === undefined) delete process.env.X_BEARER_TOKEN;
    else process.env.X_BEARER_TOKEN = originalToken;
  });

  function fakeClient(
    handler: (url: string, init?: RequestInit) => Promise<Response>,
  ): XApiClient {
    return {
      async fetch(url: string, init?: RequestInit): Promise<Response> {
        return handler(url, init);
      },
    };
  }

  test("lookups send Authorization: Bearer and call users/by/username", async () => {
    let capturedUrl = "";
    let capturedAuth: string | null = null;
    const api = fakeClient(async (url, init) => {
      capturedUrl = url;
      capturedAuth =
        (init?.headers as Record<string, string> | undefined)?.Authorization ??
        null;
      return new Response(JSON.stringify({ data: { id: "42" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IngestXClient(api);
    const id = await client.lookupUserId("BillAckman");
    expect(id).toBe("42");
    expect(capturedUrl).toBe("https://api.x.com/2/users/by/username/BillAckman");
    // Coerce through String(...) so TS doesn't narrow `capturedAuth`
    // to `null` after the closure's `?? null` assignment: a missing
    // header would now produce "null" and fail the assertion loud,
    // rather than silently passing a non-string overload.
    expect(String(capturedAuth)).toBe("Bearer test-token");
  });

  test("fetchTimeline honors since_id and follows opaque next_token pagination", async () => {
    const calls: string[] = [];
    const page1 = {
      data: [{ id: "300", text: "newest", created_at: "2026-07-01T12:00:00.000Z" }],
      meta: { next_token: "tok-2" },
    };
    const page2 = {
      data: [{ id: "250", text: "older", created_at: "2026-06-30T12:00:00.000Z" }],
      meta: { next_token: "tok-3" },
    };
    const page3 = {
      data: [{ id: "200", text: "oldest", created_at: "2026-06-29T12:00:00.000Z" }],
      meta: {},
    };
    const api = fakeClient(async (url) => {
      calls.push(url);
      if (calls.length === 1) {
        expect(url).toContain("since_id=200");
        expect(url).not.toContain("pagination_token");
        return new Response(JSON.stringify(page1), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (calls.length === 2) {
        expect(url).toContain("pagination_token=tok-2");
        return new Response(JSON.stringify(page2), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      expect(url).toContain("pagination_token=tok-3");
      return new Response(JSON.stringify(page3), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new IngestXClient(api);
    const tweets: XTweet[] = [];
    for await (const tweet of client.fetchTimeline("42", "200")) {
      tweets.push(tweet);
    }
    expect(tweets.map((t) => t.id)).toEqual(["300", "250", "200"]);
    expect(calls).toHaveLength(3);
  });

  test("fetchTimeline stops cleanly when next_token is absent", async () => {
    const api = fakeClient(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "1", text: "only", created_at: "2026-07-01T12:00:00.000Z" },
          ],
          meta: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new IngestXClient(api);
    const tweets: XTweet[] = [];
    for await (const tweet of client.fetchTimeline("42")) {
      tweets.push(tweet);
    }
    expect(tweets).toHaveLength(1);
  });

  test("fetchTimeline throws when next_token is present but invalid", async () => {
    const api = fakeClient(async () =>
      new Response(
        JSON.stringify({
          data: [
            { id: "1", text: "valid", created_at: "2026-07-01T12:00:00.000Z" },
          ],
          meta: { next_token: null },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = new IngestXClient(api);

    const collect = async (): Promise<void> => {
      for await (const _tweet of client.fetchTimeline("42")) {
        // Exhaust the generator so page validation runs.
      }
    };
    expect(collect()).rejects.toThrow(/next_token/i);
  });

  test("429 propagates as a thrown error so Dagu can retry", async () => {
    const api = fakeClient(async () =>
      new Response("rate limited", { status: 429 }),
    );
    const client = new IngestXClient(api);
    expect(client.lookupUserId("BillAckman")).rejects.toThrow(/429/);
  });

  test("non-2xx propagates as a thrown error", async () => {
    const api = fakeClient(async () =>
      new Response("oops", { status: 503 }),
    );
    const client = new IngestXClient(api);
    expect(client.lookupUserId("BillAckman")).rejects.toThrow(/503/);
  });
});

describe("commitSourceBatch", () => {
  test("counts only rows returned by INSERT ON CONFLICT DO NOTHING", async () => {
    const source: InvestorSource = {
      key: "bill-ackman-x",
      investor: "Bill Ackman",
      type: "x",
      handle: "BillAckman",
      enabled: true,
    };
    const events = [
      { id: "2", text: "new", createdAt: new Date("2026-07-02T00:00:00.000Z") },
      { id: "1", text: "duplicate", createdAt: new Date("2026-07-01T00:00:00.000Z") },
    ];
    let signalInsert = 0;
    const tx = async (
      stringsOrValues: TemplateStringsArray | Record<string, unknown>,
    ) => {
      if (!Array.isArray(stringsOrValues)) return "values";
      if (stringsOrValues.join("").includes("INSERT INTO signal_events")) {
        signalInsert += 1;
        return signalInsert === 1 ? [{ id: "inserted" }] : [];
      }
      return [];
    };

    const result = await commitSourceBatch(
      tx as never,
      source,
      "42",
      null,
      events,
    );

    expect(result).toEqual({ inserted: 1, cursor: "2" });
  });
});