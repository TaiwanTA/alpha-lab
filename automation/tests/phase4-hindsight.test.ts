import { afterEach, describe, expect, test } from "bun:test";

import {
  createHindsightClient,
  loadHindsightConfig,
  type HindsightConfig,
} from "../scripts/phase4/hindsight.ts";

// ---------------------------------------------------------------------------
// Hindsight v0.8.4 wire-protocol tests.
//
// These tests stub `fetch` so we can assert both the request body
// shape Hindsight expects (POST .../memories with { items: [...] } for
// retain and POST .../memories/recall with { query } for recall) and
// the response shape we accept (success / bank_id / items_count for
// retain; results[].text for recall). No live service is contacted.
// ---------------------------------------------------------------------------

const ORIGINAL_FETCH = globalThis.fetch;

interface CapturedRequest {
  url: string;
  body: unknown;
}
function stubFetch(
  responder: (req: Request) => Promise<Response> | Response,
): { captured: CapturedRequest[]; restore: () => void } {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const req = input instanceof Request ? input : new Request(input, init);
    // The Hindsight client calls fetch(url, { method, headers, body: JSON.stringify(...) }).
    // Reading the body from init.body is the correct observation
    // point — cloning a Request after fetch has already started can
    // leave body unreadable from the stub's perspective.
    let body: unknown = undefined;
    const rawBody = init?.body;
    if (typeof rawBody === "string") {
      try {
        body = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
      } catch {
        body = undefined;
      }
    }
    captured.push({ url: req.url, body });
    return responder(req);
  }) as typeof fetch;
  return {
    captured,
    restore: () => {
      globalThis.fetch = ORIGINAL_FETCH;
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BASE_CONFIG: HindsightConfig = {
  baseUrl: "https://hindsight.local",
  apiKey: "test-key",
  bankId: "alpha-lab",
};

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("hindsight retain — v0.8.4 wire protocol", () => {
  test("sends POST to /memories with { items: [{ content, context }] } body", async () => {
    const { captured, restore } = stubFetch(async () =>
      jsonResponse({
        success: true,
        bank_id: "alpha-lab",
        items_count: 1,
        async: false,
      }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      const result = await client.retain("hello world", "team chat");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe(
        "https://hindsight.local/v1/default/banks/alpha-lab/memories",
      );
      expect(captured[0]?.body).toEqual({
        items: [{ content: "hello world", context: "team chat" }],
      });
      expect(result).toEqual({
        success: true,
        bankId: "alpha-lab",
        itemsCount: 1,
        async: false,
      });
    } finally {
      restore();
    }
  });

  test("rejects malformed response missing success flag", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({ bank_id: "alpha-lab", items_count: 1, async: false }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(/success/);
    } finally {
      restore();
    }
  });

  test("rejects response when success is explicitly false", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({
        success: false,
        bank_id: "alpha-lab",
        items_count: 1,
        async: false,
      }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(
        /success=false/,
      );
    } finally {
      restore();
    }
  });

  test("rejects response missing bank_id", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({ success: true, items_count: 1, async: false }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(/bank_id/);
    } finally {
      restore();
    }
  });

  test("rejects response missing items_count", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({ success: true, bank_id: "alpha-lab", async: false }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(/items_count/);
    } finally {
      restore();
    }
  });

  test("surfaces 4xx with status + body context", async () => {
    const { restore } = stubFetch(async () =>
      new Response("nope", { status: 400, statusText: "Bad Request" }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(
        /400 Bad Request/,
      );
    } finally {
      restore();
    }
  });

  test("surfaces 5xx with status + body context", async () => {
    const { restore } = stubFetch(async () =>
      new Response("down", { status: 503, statusText: "Unavailable" }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.retain("x", "y")).rejects.toThrow(/503/);
    } finally {
      restore();
    }
  });

  test("loadHindsightConfig throws when HINDSIGHT_BASE_URL is missing", () => {
    expect(() => loadHindsightConfig({})).toThrow(/HINDSIGHT_BASE_URL/);
  });

  test("loadHindsightConfig trims trailing slashes on the base URL", () => {
    const cfg = loadHindsightConfig({
      HINDSIGHT_BASE_URL: "https://hindsight.local///",
      HINDSIGHT_BANK_ID: "  alpha-lab  ",
      HINDSIGHT_API_KEY: "  key  ",
    });
    expect(cfg.baseUrl).toBe("https://hindsight.local");
    expect(cfg.bankId).toBe("alpha-lab");
    expect(cfg.apiKey).toBe("key");
  });
});

describe("hindsight recall — v0.8.4 wire protocol", () => {
  test("sends POST to /memories/recall with { query } body", async () => {
    const { captured, restore } = stubFetch(async () =>
      jsonResponse({
        results: [
          { id: "obs-1", text: "fact one", type: "world" },
          { id: "obs-2", text: "fact two", type: "experience" },
        ],
      }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      const result = await client.recall("what is happening?");
      expect(captured).toHaveLength(1);
      expect(captured[0]?.url).toBe(
        "https://hindsight.local/v1/default/banks/alpha-lab/memories/recall",
      );
      expect(captured[0]?.body).toEqual({ query: "what is happening?" });
      expect(result.results.map((r) => r.id)).toEqual(["obs-1", "obs-2"]);
      expect(result.results[0]?.text).toBe("fact one");
      expect(result.results[0]?.raw).toMatchObject({ type: "world" });
    } finally {
      restore();
    }
  });

  test("returns an empty results list (not a synthetic stub) for a 200 with no facts", async () => {
    const { restore } = stubFetch(async () => jsonResponse({ results: [] }));
    try {
      const client = createHindsightClient(BASE_CONFIG);
      const result = await client.recall("nothing matches");
      expect(result.results).toEqual([]);
    } finally {
      restore();
    }
  });

  test("rejects response missing results array", async () => {
    const { restore } = stubFetch(async () => jsonResponse({ items: [] }));
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.recall("x")).rejects.toThrow(/results/);
    } finally {
      restore();
    }
  });

  test("rejects a result entry missing id", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({ results: [{ text: "orphan fact" }] }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.recall("x")).rejects.toThrow(/missing string 'id'/);
    } finally {
      restore();
    }
  });

  test("rejects a result entry whose text is not a string", async () => {
    const { restore } = stubFetch(async () =>
      jsonResponse({ results: [{ id: "obs-1", text: 42 }] }),
    );
    try {
      const client = createHindsightClient(BASE_CONFIG);
      await expect(client.recall("x")).rejects.toThrow(/text must be a string/);
    } finally {
      restore();
    }
  });
});