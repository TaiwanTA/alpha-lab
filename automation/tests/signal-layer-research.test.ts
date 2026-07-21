// automation/tests/signal-layer-research.test.ts
//
// Signal-layer Mode 2: record_research accepts calls that carry no
// tradeable alpha (no ticker / direction / candidateMarkdown). Such
// findings describe sentiment or context that does not constitute a
// positionable signal; the research run is still persisted with the
// alpha fields set to null.

import { describe, expect, test } from "bun:test";

import {
  createResearchToolkit,
  type RecordResearchInput,
  type ResearchToolkit,
  type ResearchToolContext,
} from "../tools/index.ts";

function makeContext(
  overrides: Partial<ResearchToolContext> = {},
): {
  ctx: ResearchToolContext;
  recordResearchCalls: RecordResearchInput[];
} {
  const recordResearchCalls: RecordResearchInput[] = [];
  const recordResearch = overrides.recordResearch ??
    (async (input: RecordResearchInput) => {
      recordResearchCalls.push(input);
      return { id: "test-run-id" };
    });
  const ctx: ResearchToolContext = {
    eventId: "test-event-id",
    event: {
      id: "test-event-id",
      investor: "測試投資人",
      sourceUrl: "https://x.com/test/status/1",
      rawContent: "測試原始內容",
      publishedAt: new Date("2026-07-01T00:00:00Z"),
      capturedAt: new Date("2026-07-01T00:00:01Z"),
    },
    hindsight: {
      async recall() {
        return {
          results: [
            { id: "obs-1", text: "prior", raw: { context: "alpha-lab" } },
          ],
        };
      },
      async retain() {
        return {
          success: true,
          bankId: "alpha-lab",
          itemsCount: 1,
          async: false,
        };
      },
    } as ResearchToolContext["hindsight"],
    twelveData: {
      async fetchAdjustedClose() {
        return {
          ticker: "TEST",
          date: "2026-07-01",
          adjustedClose: 100,
          provider: "twelve-data",
          requestedInterval: "1day",
          requestedAdjust: "all",
        };
      },
    } as ResearchToolContext["twelveData"],
    recordResearch,
    ...overrides,
  };
  return { ctx, recordResearchCalls };
}

/** Run recall + retain to satisfy the gate before record_research.
 *  Both tools are async; awaiting them flips the gate flags before
 *  the test invokes record_research. */
async function satisfyGate(toolkit: ResearchToolkit): Promise<void> {
  const recall = toolkit.tools.find((t) => t.name === "recall_memory")!;
  const retain = toolkit.tools.find((t) => t.name === "retain_event_memory")!;
  await recall.execute("c1", { query: "prior?" });
  await retain.execute("c2", { content: "fixture", context: "alpha-lab" });
}
describe("record_research Mode 2 (no alpha)", () => {
  test("accepts a call without ticker/direction/candidateMarkdown", async () => {
    const { ctx, recordResearchCalls } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    await satisfyGate(toolkit);
    const recordTool = toolkit.tools.find((t) => t.name === "record_research")!;

    // Mode 2: thesis + rationale + confidence + sourceCitations, no alpha.
    await expect(
      recordTool.execute("test-call-id", {
        thesis: "測試 thesis — 不構成可交易訊號",
        rationale: "推文僅含情緒字,無標的或方向",
        confidence: 0.1,
        sourceCitations: ["https://x.com/test/status/123"],
      }),
    ).resolves.toBeDefined();

    expect(recordResearchCalls).toHaveLength(1);
    const call = recordResearchCalls[0]!;
    expect(call.ticker).toBeNull();
    expect(call.direction).toBeNull();
    expect(call.candidateMarkdown).toBeNull();
    expect(call.thesis).toBe("測試 thesis — 不構成可交易訊號");
  });

  test("Mode 1 call with full alpha still forwards ticker/direction/candidateMarkdown", async () => {
    const { ctx, recordResearchCalls } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    await satisfyGate(toolkit);
    const recordTool = toolkit.tools.find((t) => t.name === "record_research")!;

    await recordTool.execute("test-call-id", {
      thesis: "做多 AAPL — 利潤率擴張",
      ticker: "AAPL",
      direction: "long",
      confidence: 0.7,
      rationale: "iPhone 週期強勁",
      sourceCitations: ["https://x.com/test/status/123"],
      candidateMarkdown: "---\ntitle: test\ninvestmentClaim: \"true\"\n---\nbody",
    });

    expect(recordResearchCalls).toHaveLength(1);
    const call = recordResearchCalls[0]!;
    expect(call.ticker).toBe("AAPL");
    expect(call.direction).toBe("long");
    expect(call.candidateMarkdown).toContain("investmentClaim: true");
  });

  test("Mode 2 framing still rejects a malformed ticker when one is supplied", async () => {
    const { ctx } = makeContext();
    const toolkit = createResearchToolkit(ctx);
    await satisfyGate(toolkit);
    const recordTool = toolkit.tools.find((t) => t.name === "record_research")!;

    // A malformed ticker must still be rejected even without direction/candidateMarkdown.
    await expect(
      recordTool.execute("test-call-id", {
        thesis: "t",
        rationale: "r",
        confidence: 0.3,
        sourceCitations: ["https://x.com/test/status/123"],
        ticker: "aapl",
      }),
    ).rejects.toThrow(/ticker must match/);
  });
});


// ---------------------------------------------------------------------------
// Task 10: buildPrompt per-signal + two-mode instruction
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const HERE = import.meta.dir;

const RESEARCH_AGENT = readFileSync(
  join(HERE, "..", "agents", "research.ts"),
  "utf8",
);

describe("research.ts buildPrompt signal layer", () => {
  test("buildPrompt accepts signal + items + timeline parameters", () => {
    expect(RESEARCH_AGENT).toMatch(/buildPrompt/);
    expect(RESEARCH_AGENT).toMatch(/signal.*items.*timeline|SignalRow.*ItemRow.*ResearchRunRow/);
  });

  test("prompt instructs two modes (with/without alpha)", () => {
    expect(RESEARCH_AGENT).toMatch(/Mode 1|有可交易/);
    expect(RESEARCH_AGENT).toMatch(/Mode 2|無可交易|不構成/);
  });

  test("prompt instructs updating signal description", () => {
    expect(RESEARCH_AGENT).toMatch(/description.*更新|living.*description/i);
  });

  test("prompt no longer references single event", () => {
    expect(RESEARCH_AGENT).not.toMatch(/researching one signal_event/);
  });
});

// ---------------------------------------------------------------------------
// Task 11: research-signals.ts CLI
// ---------------------------------------------------------------------------

const RESEARCH_CLI = readFileSync(
  join(HERE, "..", "commands", "research-signals.ts"),
  "utf8",
);

describe("research-signals.ts CLI", () => {
  test("claims a signal (not an event)", () => {
    expect(RESEARCH_CLI).toMatch(/claim.*signal|SignalRecord/);
  });

  test("reads signal items + timeline for prompt context", () => {
    expect(RESEARCH_CLI).toMatch(/getItems|getTimeline/);
  });

  test("passes signal + items + timeline to buildPrompt", () => {
    expect(RESEARCH_CLI).toMatch(/buildPrompt\(/);
  });

  test("appends to signal description after research", () => {
    expect(RESEARCH_CLI).toMatch(/appendToDescription|update_signal/);
  });

  test("stdout outputs run ID, logs to stderr", () => {
    expect(RESEARCH_CLI).toMatch(/process\.stdout/);
    expect(RESEARCH_CLI).toMatch(/console\.error/);
  });

  test("exit 0 no-claim when no pending signals", () => {
    expect(RESEARCH_CLI).toMatch(/no-claim|nothing to do/);
  });

  test("never calls process.exit before closeDb", () => {
    expect(RESEARCH_CLI).not.toMatch(/process\.exit\(/);
    expect(RESEARCH_CLI).toMatch(/closeDb/);
  });
});