import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import {
  HindsightClient,
  HindsightError,
  type HindsightMemory,
} from "../../lib/hindsight-client.ts";

const originalFetch = globalThis.fetch;
let fetchMock: ReturnType<typeof mockFetch>;

function mockFetch(impl: (...args: any[]) => Response | Promise<Response>) {
  const calls: unknown[][] = [];
  const fn = (...args: unknown[]) => {
    calls.push(args);
    return Promise.resolve(impl(...(args as Parameters<typeof impl>)));
  };
  (fn as any).mock = { calls };
  return fn as any;
}

beforeEach(() => {
  fetchMock = mockFetch(() => new Response("{}", { status: 200 }));
  globalThis.fetch = fetchMock;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("HindsightClient.health", () => {
  test("returns true on 200", async () => {
    fetchMock = mockFetch(() => new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    expect(await client.health()).toBe(true);
  });

  test("returns false on network error", async () => {
    fetchMock = mockFetch(() => {
      throw new Error("connection refused");
    });
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    expect(await client.health()).toBe(false);
  });

  test("returns false on 500", async () => {
    fetchMock = mockFetch(() => new Response("err", { status: 500 }));
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    expect(await client.health()).toBe(false);
  });
});

describe("HindsightClient.createBank", () => {
  test("sends POST to /v1/default/banks with body", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ bank_id: "alpha-lab", name: "Alpha Lab" }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const bank = await client.createBank({
      bank_id: "alpha-lab",
      name: "Alpha Lab",
      mission: "Track investor signals",
    });

    expect(bank.bank_id).toBe("alpha-lab");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).bank_id).toBe("alpha-lab");
    expect(JSON.parse(init.body as string).mission).toBe("Track investor signals");
  });
});

describe("HindsightClient.getBank", () => {
  test("uses GET on /v1/default/banks/<id>", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ bank_id: "alpha-lab", name: "Alpha Lab" }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.getBank("alpha-lab");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test:8888/v1/default/banks/alpha-lab");
    expect(init.method).toBe("GET");
  });

  test("encodes bankId in path", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ bank_id: "x/y" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.getBank("x/y");

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://test:8888/v1/default/banks/x%2Fy");
  });
});

describe("HindsightClient.deleteBank", () => {
  test("uses DELETE on /v1/default/banks/<id>", async () => {
    fetchMock = mockFetch(() => new Response("", { status: 200 }));
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.deleteBank("alpha-lab");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test:8888/v1/default/banks/alpha-lab");
    expect(init.method).toBe("DELETE");
  });
});

describe("HindsightClient.listBanks", () => {
  test("handles array response", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify([
          { bank_id: "a", name: "A" },
          { bank_id: "b", name: "B" },
        ]),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const banks = await client.listBanks();
    expect(banks).toHaveLength(2);
    expect(banks[0]!.bank_id).toBe("a");
  });

  test("handles { banks: [...] } response", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ banks: [{ bank_id: "x", name: "X" }] }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const banks = await client.listBanks();
    expect(banks).toHaveLength(1);
    expect(banks[0]!.bank_id).toBe("x");
  });
});

describe("HindsightClient.retain", () => {
  test("sends memory to correct bank endpoint", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ id: "mem-1" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const memory: HindsightMemory = {
      text: "Ackman mentioned NVDA",
      type: "observation",
      tags: ["ackman", "nvda"],
    };
    const result = await client.retain("alpha-lab", memory);

    expect(result.id).toBe("mem-1");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://test:8888/v1/default/banks/alpha-lab/memories");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.text).toBe("Ackman mentioned NVDA");
    expect(body.type).toBe("observation");
    expect(body.tags).toEqual(["ackman", "nvda"]);
  });
});

describe("HindsightClient.recall", () => {
  test("sends query and parses results array", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({
          results: [{ id: "m1", text: "match1", score: 0.9 }],
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const results = await client.recall("alpha-lab", "NVDA position", {
      limit: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe("match1");
    expect(results[0]!.score).toBe(0.9);

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.query).toBe("NVDA position");
    expect(body.limit).toBe(5);
  });

  test("handles direct array response (no results wrapper)", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify([{ id: "m1", text: "match1" }]), {
        status: 200,
      }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const results = await client.recall("alpha-lab", "test");
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe("match1");
  });

  test("sends tags filter when provided", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.recall("alpha-lab", "test", {
      tags: ["ackman"],
      limit: 3,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.tags).toEqual(["ackman"]);
    expect(body.limit).toBe(3);
  });

  test("uses default limit 10 when not provided", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.recall("alpha-lab", "q");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.limit).toBe(10);
  });
});

describe("HindsightClient.reflect", () => {
  test("sends query and returns response", async () => {
    fetchMock = mockFetch(() =>
      new Response(
        JSON.stringify({ content: "synthesis text" }),
        { status: 200 },
      ),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const result = await client.reflect(
      "alpha-lab",
      "What does Ackman think about NVDA?",
    );

    expect(result.content).toBe("synthesis text");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://test:8888/v1/default/banks/alpha-lab/memories/reflect",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string).query).toContain("NVDA");
  });

  test("sends tags filter when provided", async () => {
    fetchMock = mockFetch(() =>
      new Response(JSON.stringify({ content: "x" }), { status: 200 }),
    );
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await client.reflect("alpha-lab", "q", { tags: ["nvda"] });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string).tags).toEqual(["nvda"]);
  });
});

describe("HindsightClient error handling", () => {
  test("throws HindsightError on 4xx", async () => {
    fetchMock = mockFetch(() => new Response("Bad request", { status: 400 }));
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await expect(client.listBanks()).rejects.toThrow(HindsightError);
  });

  test("HindsightError has status and body", async () => {
    fetchMock = mockFetch(() => new Response("Not found", { status: 404 }));
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    try {
      await client.getBank("nonexistent");
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(HindsightError);
      expect((e as HindsightError).status).toBe(404);
      expect((e as HindsightError).body).toBe("Not found");
    }
  });
});

describe("HindsightClient URL normalization", () => {
  test("constructor strips trailing slashes from baseUrl", async () => {
    let calledUrl = "";
    fetchMock = mockFetch((url: string) => {
      calledUrl = url;
      return Promise.resolve(new Response(JSON.stringify({ banks: [] }), { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888///");
    await client.listBanks();
    expect(calledUrl).toBe("http://test:8888/v1/default/banks");
  });
});

describe("HindsightClient.health body validation", () => {
  test("health returns true when body is non-empty", async () => {
    fetchMock = mockFetch(() => Promise.resolve(new Response("ok", { status: 200 })));
    globalThis.fetch = fetchMock;
    const client = new HindsightClient("http://test:8888");
    expect(await client.health()).toBe(true);
  });

  test("health returns false when body is empty", async () => {
    fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 200 })));
    globalThis.fetch = fetchMock;
    const client = new HindsightClient("http://test:8888");
    expect(await client.health()).toBe(false);
  });
});

describe("HindsightClient request retry", () => {
  test("request retries on 429", async () => {
    let callCount = 0;
    fetchMock = mockFetch(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve(new Response("rate limited", { status: 429 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ banks: [] }), { status: 200 }));
    });
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    const banks = await client.listBanks();
    expect(callCount).toBe(2);
    expect(banks).toEqual([]);
  });

  test("request gives up after maxAttempts on 5xx", async () => {
    let callCount = 0;
    fetchMock = mockFetch(() => {
      callCount++;
      return Promise.resolve(new Response("server error", { status: 500 }));
    });
    globalThis.fetch = fetchMock;

    const client = new HindsightClient("http://test:8888");
    await expect(client.listBanks()).rejects.toThrow();
    expect(callCount).toBe(3);  // maxAttempts = 3
  });
});

describe("HindsightClient response shape robustness", () => {
  test("listBanks handles malformed response gracefully (returns empty array)", async () => {
    fetchMock = mockFetch(() => Promise.resolve(new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    globalThis.fetch = fetchMock;
    const client = new HindsightClient("http://test:8888");
    const banks = await client.listBanks();
    expect(banks).toEqual([]);
  });

  test("recall handles null response gracefully", async () => {
    fetchMock = mockFetch(() => Promise.resolve(new Response("null", { status: 200 })));
    globalThis.fetch = fetchMock;
    const client = new HindsightClient("http://test:8888");
    const results = await client.recall("bank", "query");
    expect(results).toEqual([]);
  });
});
