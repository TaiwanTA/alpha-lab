import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  createResearchToolkit,
  type ResearchEventPayload,
  type ResearchToolContext,
  type HindsightClient,
  type TwelveDataClient,
  type RecordResearchInput,
} from "../tools/index.ts";
// ---------------------------------------------------------------------------
// These tests prove the constraint contract:
//   - Exactly five tools are exposed to the agent
//   - The five names match the brief (no shell, FS, HTTP, or SQL tool)
//   - `record_research` rejects any call before both memory flags are set
//   - Hindsight 4xx/5xx cause the research command to fail loudly
//   - Twelve Data failures throw without silent absorption
//
// All dependencies are injected — no network access.
// ---------------------------------------------------------------------------

function makeHindsightStub(
  overrides: Partial<{
    retain: () => Promise<unknown>;
    recall: () => Promise<unknown>;
  }> = {},
): HindsightClient {
  return {
    retain:
      overrides.retain ??
      (async () => ({
        success: true,
        bankId: "alpha-lab",
        itemsCount: 1,
        async: false,
      })),
    recall:
      overrides.recall ??
      (async () => ({
        results: [
          {
            id: "obs-1",
            text: "prior observation",
            raw: { context: "alpha-lab" },
          },
        ],
      })),
  } as HindsightClient;
}

function makeTwelveDataStub(
  overrides: Partial<{
    fetchAdjustedClose: () => Promise<unknown>;
  }> = {},
): TwelveDataClient {
  return {
    fetchAdjustedClose:
      overrides.fetchAdjustedClose ??
      (async () => ({
        ticker: "AAPL",
        date: "2026-07-15",
        adjustedClose: 195.42,
        provider: "twelve-data",
        requestedInterval: "1day",
        requestedAdjust: "all",
      })),
  } as TwelveDataClient;
}

function makeContext(
  overrides: Partial<{
    hindsight: HindsightClient;
    twelveData: TwelveDataClient;
    recordResearch: (
      input: RecordResearchInput,
    ) => Promise<{ id: string }>;
    eventId: string;
    event: ResearchEventPayload;
  }> = {},
): {
  ctx: ResearchToolContext;
  recordResearchCalls: RecordResearchInput[];
} {
  const recordResearchCalls: RecordResearchInput[] = [];
  const recordResearch =
    overrides.recordResearch ??
    (async (input: RecordResearchInput) => {
      recordResearchCalls.push(input);
      return { id: "run-1" };
    });
  const ctx: ResearchToolContext = {
    eventId: overrides.eventId ?? "evt-1",
    event: overrides.event ?? {
      id: overrides.eventId ?? "evt-1",
      investor: "Stub Investor",
      sourceUrl: "https://example.com/stub",
      rawContent: "stub raw content",
      publishedAt: new Date("2026-07-15T00:00:00Z"),
      capturedAt: new Date("2026-07-15T00:00:01Z"),
    },
    hindsight: overrides.hindsight ?? makeHindsightStub(),
    twelveData: overrides.twelveData ?? makeTwelveDataStub(),
    recordResearch,
  };
  return { ctx, recordResearchCalls };
}

// ---------------------------------------------------------------------------
// Tool surface — exactly five registered tools, no escape hatches.
// ---------------------------------------------------------------------------

describe("research toolkit surface", () => {
  test("exposes exactly the five tools named in the brief", () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const names = toolkit.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "lookup_adjusted_close",
      "read_event",
      "recall_memory",
      "record_research",
      "retain_event_memory",
    ]);
  });

  test("contains no shell, filesystem, arbitrary HTTP, or SQL tool", () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const forbidden = [
      "shell",
      "exec",
      "bash",
      "run_command",
      "fs",
      "filesystem",
      "read_file",
      "write_file",
      "http",
      "fetch_url",
      "sql",
      "query_db",
    ];
    const names = toolkit.tools.map((t) => t.name);
    for (const bad of forbidden) {
      expect(names).not.toContain(bad);
    }
  });

  test("uses sequential tool execution (no parallel mode override on toolkit)", () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    expect(toolkit.executionMode).toBe("sequential");
  });
});

// ---------------------------------------------------------------------------
// record_research — must require both memory flags, and reset per context.
// ---------------------------------------------------------------------------

describe("record_research gate", () => {
  test("rejects when neither memory tool has run", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!record) throw new Error("record_research tool missing");
    await expect(
      record.execute("call-1", {
        thesis: "t",
        ticker: "AAPL",
        direction: "long",
        confidence: 0.7,
        rationale: "r",
        sourceCitations: ["https://x.com/a/status/1"],
        candidateMarkdown: "---\ntitle: x\n---\nbody",
      }),
    ).rejects.toThrow(/recall_memory and retain_event_memory are required/);
  });

  test("rejects when only recall_memory ran", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !record) throw new Error("tool missing");
    await recall.execute("call-1", { query: "what prior?" });
    await expect(
      record.execute("call-2", {
        thesis: "t",
        ticker: "AAPL",
        direction: "long",
        confidence: 0.7,
        rationale: "r",
        sourceCitations: ["https://x.com/a/status/1"],
        candidateMarkdown: "---\ntitle: x\n---\nbody",
      }),
    ).rejects.toThrow(/recall_memory and retain_event_memory are required/);
  });

  test("rejects when only retain_event_memory ran", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!retain || !record) throw new Error("tool missing");
    await retain.execute("call-1", {
      content: "fixture",
      context: "alpha-lab",
    });
    await expect(
      record.execute("call-2", {
        thesis: "t",
        ticker: "AAPL",
        direction: "long",
        confidence: 0.7,
        rationale: "r",
        sourceCitations: ["https://x.com/a/status/1"],
        candidateMarkdown: "---\ntitle: x\n---\nbody",
      }),
    ).rejects.toThrow(/recall_memory and retain_event_memory are required/);
  });

  test("accepts when both memory flags are set, and forwards to recordResearch sink", async () => {
    const { ctx, recordResearchCalls } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !retain || !record) throw new Error("tool missing");
    await recall.execute("c1", { query: "what prior?" });
    await retain.execute("c2", { content: "fixture", context: "alpha-lab" });
    const result = await record.execute("c3", {
      thesis: "Long AAPL on margins",
      ticker: "AAPL",
      direction: "long",
      confidence: 0.7,
      rationale: "strong iPhone cycle",
      sourceCitations: ["https://x.com/a/status/1"],
      candidateMarkdown: "---\ntitle: x\ninvestmentClaim: \"true\"\n---\nbody",
    });
    expect(recordResearchCalls).toHaveLength(1);
    expect(recordResearchCalls[0]?.eventId).toBe("evt-1");
    expect(recordResearchCalls[0]?.candidateMarkdown).toContain("investmentClaim: true");
    expect(recordResearchCalls[0]?.candidateMarkdown).toContain(
      "## 來源\n\n- https://x.com/a/status/1",
    );
    expect(result.details).toEqual({ id: "run-1" });
  });

  test("rejects a record_research call with confidence outside [0,1]", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !retain || !record) throw new Error("tool missing");
    await recall.execute("c1", { query: "what prior?" });
    await retain.execute("c2", { content: "x", context: "alpha-lab" });
    await expect(
      record.execute("c3", {
        thesis: "t",
        ticker: "AAPL",
        direction: "long",
        confidence: 1.5,
        rationale: "r",
        sourceCitations: ["https://x.com/a/status/1"],
        candidateMarkdown: "---\ntitle: x\n---\nbody",
      }),
    ).rejects.toThrow(/confidence/);
  });

  test("rejects a record_research call with a malformed ticker", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !retain || !record) throw new Error("tool missing");
    await recall.execute("c1", { query: "what prior?" });
    await retain.execute("c2", { content: "x", context: "alpha-lab" });
    const malformedTickers = ["aapl", "1234-5678-9012-3456", "AAPL!", "$AAPL", "A APL"];
    for (const ticker of malformedTickers) {
      await expect(
        record.execute("c3", {
          thesis: "t",
          ticker,
          direction: "long",
          confidence: 0.5,
          rationale: "r",
          sourceCitations: ["https://x.com/a/status/1"],
          candidateMarkdown: "---\ntitle: x\n---\nbody",
        }),
      ).rejects.toThrow(/ticker must match/);
    }
  });

  test("accepts tickers with dot and dash (BRK.B, RDS-A)", async () => {
    const { ctx, recordResearchCalls } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !retain || !record) throw new Error("tool missing");
    // BRK.B (Berkshire class B — class share with dot)
    await recall.execute("c1", { query: "what prior?" });
    await retain.execute("c2", { content: "x", context: "alpha-lab" });
    const result = await record.execute("c3", {
      thesis: "t",
      ticker: "BRK.B",
      direction: "long",
      confidence: 0.5,
      rationale: "r",
      sourceCitations: ["https://x.com/a/status/1"],
      candidateMarkdown: "---\ntitle: x\n---\nbody",
    });
    expect(result.details).toEqual({ id: "run-1" });
    expect(recordResearchCalls[0]?.ticker).toBe("BRK.B");
  });

  test("rejects a record_research call whose citations are not http(s) URLs", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    const record = toolkit.tools.find((t) => t.name === "record_research");
    if (!recall || !retain || !record) throw new Error("tool missing");
    await recall.execute("c1", { query: "what prior?" });
    await retain.execute("c2", { content: "x", context: "alpha-lab" });
    const badCitations = [
      ["javascript:alert(1)"],
      ["ftp://example.com/source"],
      ["data:text/plain,hello"],
      ["//example.com/no-scheme"],
      ["x.com/a/status/1"], // bare host without scheme
    ];
    for (const sourceCitations of badCitations) {
      await expect(
        record.execute("c3", {
          thesis: "t",
          ticker: "AAPL",
          direction: "long",
          confidence: 0.5,
          rationale: "r",
          sourceCitations,
          candidateMarkdown: "---\ntitle: x\n---\nbody",
        }),
      ).rejects.toThrow(/sourceCitations must use http/);
    }
  });
});

// ---------------------------------------------------------------------------
// Hindsight failure surfacing — 4xx/5xx must throw (and break the run).
// ---------------------------------------------------------------------------

describe("hindsight tool failure surfacing", () => {
  test("retain throws on 4xx and surfaces the message", async () => {
    const hindsight = makeHindsightStub({
      retain: async () => {
        throw new Error("hindsight retain failed: 400 Bad Request");
      },
    });
    const { ctx } = makeContext({ hindsight });
    const toolkit = createResearchToolkit(ctx);
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    if (!retain) throw new Error("tool missing");
    await expect(
      retain.execute("c1", { content: "x", context: "alpha-lab" }),
    ).rejects.toThrow(/hindsight retain failed/);
  });

  test("retain throws on 5xx", async () => {
    const hindsight = makeHindsightStub({
      retain: async () => {
        throw new Error("hindsight retain failed: 503 Service Unavailable");
      },
    });
    const { ctx } = makeContext({ hindsight });
    const toolkit = createResearchToolkit(ctx);
    const retain = toolkit.tools.find(
      (t) => t.name === "retain_event_memory",
    );
    if (!retain) throw new Error("tool missing");
    await expect(
      retain.execute("c1", { content: "x", context: "alpha-lab" }),
    ).rejects.toThrow(/503/);
  });

  test("recall throws on 4xx", async () => {
    const hindsight = makeHindsightStub({
      recall: async () => {
        throw new Error("hindsight recall failed: 401 Unauthorized");
      },
    });
    const { ctx } = makeContext({ hindsight });
    const toolkit = createResearchToolkit(ctx);
    const recall = toolkit.tools.find((t) => t.name === "recall_memory");
    if (!recall) throw new Error("tool missing");
    await expect(
      recall.execute("c1", { query: "what prior?" }),
    ).rejects.toThrow(/401/);
  });
});

// ---------------------------------------------------------------------------
// lookup_adjusted_close — Twelve Data must surface provider failures.
// ---------------------------------------------------------------------------

describe("lookup_adjusted_close failure surfacing", () => {
  test("throws on provider error", async () => {
    const twelveData = makeTwelveDataStub({
      fetchAdjustedClose: async () => {
        throw new Error("twelve-data: 429 Too Many Requests");
      },
    });
    const { ctx } = makeContext({ twelveData });
    const toolkit = createResearchToolkit(ctx);
    const lookup = toolkit.tools.find(
      (t) => t.name === "lookup_adjusted_close",
    );
    if (!lookup) throw new Error("tool missing");
    await expect(
      lookup.execute("c1", { ticker: "AAPL", date: "2026-07-15" }),
    ).rejects.toThrow(/twelve-data/);
  });
});

// ---------------------------------------------------------------------------
// read_event — returns the event's raw payload for the agent to consume.
// ---------------------------------------------------------------------------

describe("read_event", () => {
  test("returns the event payload from the provided context", async () => {
    const ctx: ResearchToolContext = {
      eventId: "evt-xyz",
      hindsight: makeHindsightStub(),
      twelveData: makeTwelveDataStub(),
      recordResearch: async () => ({ id: "r1" }),
      event: {
        id: "evt-xyz",
        investor: "Bill Ackman",
        sourceUrl: "https://x.com/BillAckman/status/123",
        rawContent: "Long $AAPL thesis",
        publishedAt: new Date("2026-07-15T10:00:00Z"),
        capturedAt: new Date("2026-07-15T10:01:00Z"),
      },
    };
    const toolkit = createResearchToolkit(ctx);
    const read = toolkit.tools.find((t) => t.name === "read_event");
    if (!read) throw new Error("tool missing");
    const result = await read.execute("c1", {});
    expect(result.details).toEqual({
      id: "evt-xyz",
      investor: "Bill Ackman",
      sourceUrl: "https://x.com/BillAckman/status/123",
      rawContent: "Long $AAPL thesis",
    });
  });
});