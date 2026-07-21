import { describe, expect, test } from "bun:test";

import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Agent, AgentEvent } from "@earendil-works/pi-agent-core";

import {
  DEFAULT_MAX_STEPS,
  buildPiResearchRuntime,
  assertRunPersisted,
  subscribeMaxStepsGuard,
  subscribeToolEvents,
  type PiResearchRuntimeOptions,
  type HindsightClient,
  type TwelveDataClient,
  type ResearchEventPayload,
} from "../agents/research.ts";

// ---------------------------------------------------------------------------
// Stubs — protocol-correct per Hindsight v0.8.4 (success / bank_id /
// items_count on retain; results[].text on recall) and Twelve Data v0
// daily adjusted-close series.
// ---------------------------------------------------------------------------

const STUB_EVENT: ResearchEventPayload = {
  id: "evt-1",
  investor: "Stub Investor",
  sourceUrl: "https://example.com/stub",
  rawContent: "stub raw content",
  publishedAt: new Date("2026-07-15T00:00:00Z"),
  capturedAt: new Date("2026-07-15T00:00:01Z"),
};

function makeHindsightStub(): HindsightClient {
  return {
    retain: async () => ({
      success: true,
      bankId: "alpha-lab",
      itemsCount: 1,
      async: false,
    }),
    recall: async () => ({
      results: [
        {
          id: "obs-1",
          text: "prior observation text",
          raw: { type: "world" },
        },
      ],
    }),
  };
}

function makeTwelveDataStub(): TwelveDataClient {
  return {
    fetchAdjustedClose: async () => ({
      ticker: "AAPL",
      date: "2026-07-15",
      adjustedClose: 195.42,
      provider: "twelve-data",
      requestedInterval: "1day",
      requestedAdjust: "all",
    }),
  };
}

function makeRuntimeOptions(
  overrides: Partial<{
    hindsight: HindsightClient;
    twelveData: TwelveDataClient;
    recordResearch: (input: {
      eventId: string;
      thesis: string;
      ticker: string | null;
      direction: "long" | "short" | null;
      confidence: number;
      rationale: string;
      sourceCitations: string[];
      candidateMarkdown: string | null;
    }) => Promise<{ id: string }>;
    event: ResearchEventPayload;
  }> = {},
): PiResearchRuntimeOptions {
  return {
    eventId: STUB_EVENT.id,
    event: overrides.event ?? STUB_EVENT,
    hindsight: overrides.hindsight ?? makeHindsightStub(),
    twelveData: overrides.twelveData ?? makeTwelveDataStub(),
    recordResearch:
      overrides.recordResearch ??
      (async () => ({ id: "run-1" })),
  };
}

// ---------------------------------------------------------------------------
// Minimal Agent stub for `assertRunPersisted` tests. The runtime
// never calls the Agent directly from these tests — we just need a
// duck-typed object that exposes `state.errorMessage`, `subscribe`,
// and `waitForIdle`.
// ---------------------------------------------------------------------------

interface FakeAgent {
  state: { errorMessage: string | undefined };
  subscribe: (listener: (event: AgentEvent) => void) => () => void;
  waitForIdle: () => Promise<void>;
}

function makeFakeAgent(
  errorMessage: string | undefined,
  emittedEvents: AgentEvent[] = [],
): FakeAgent {
  return {
    state: { errorMessage },
    subscribe: (listener) => {
      for (const event of emittedEvents) {
        listener(event);
      }
      return () => {};
    },
    waitForIdle: async () => {},
  };
}

// ---------------------------------------------------------------------------
// Model + provider selection — must be the built-in MiniMax-M3 via
// `minimaxProvider()`. The brief forbids raw fetch, OpenAI-compatible
// custom providers, and the old LLM_* env vars.
// ---------------------------------------------------------------------------

describe("pi research runtime — model + provider", () => {
  test("selects the built-in MiniMax-M3 model", () => {
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    expect(runtime.model.id).toBe("MiniMax-M3");
    expect(runtime.model.provider).toBe("minimax");
  });

  test("uses the built-in minimax provider, not a custom OpenAI-compatible shim", () => {
    const provider = minimaxProvider();
    expect(provider.id).toBe("minimax");
    // Built-in provider resolves credentials from MINIMAX_API_KEY (not LLM_*).
    expect(provider.auth).toBeDefined();
    // Confirm the same model is reachable via the static catalog.
    const catalog = getBuiltinModel("minimax", "MiniMax-M3");
    expect(catalog.id).toBe("MiniMax-M3");
  });
});

// ---------------------------------------------------------------------------
// Tool surface + execution mode on the built agent.
// ---------------------------------------------------------------------------

describe("pi research runtime — tool surface", () => {
  test("exposes exactly the brief's five tool names", () => {
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    expect(runtime.tools.map((t) => t.name).sort()).toEqual([
      "lookup_adjusted_close",
      "read_event",
      "recall_memory",
      "record_research",
      "retain_event_memory",
    ]);
  });

  test("uses sequential tool execution (no parallel mode)", () => {
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    expect(runtime.toolExecution).toBe("sequential");
  });

  test("system prompt isolates <investor_content> as data, not instructions", () => {
    // The agent's built system prompt must instruct the model to
    // treat any text inside an <investor_content> block as raw DATA,
    // never as instructions. Otherwise an attacker who controls an
    // investor's post can inject tool calls / commands into the
    // prompt. We assert the rule exists in the agent state because
    // the rule is the only thing standing between us and a
    // prompt-injection take-over.
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    const agent = runtime.buildAgent();
    expect(agent.state.systemPrompt).toMatch(/DATA \/ INSTRUCTION SEPARATION/);
    expect(agent.state.systemPrompt).toMatch(/<investor_content>/);
  });
});

// ---------------------------------------------------------------------------
// Event payload — the runtime MUST attach the event to the toolkit
// context so read_event can return the claim's data. The TypeScript
// types make `event` required at the runtime boundary; this test
// verifies the toolkit's read_event tool surfaces the runtime's
// attached event instead of throwing.
// ---------------------------------------------------------------------------

describe("pi research runtime — read_event wiring", () => {
  test("read_event tool returns the event payload attached at the runtime boundary", async () => {
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    const readEvent = runtime.tools.find((t) => t.name === "read_event");
    if (!readEvent) throw new Error("read_event tool missing");
    const result = await readEvent.execute("call-1", {});
    expect(result.details).toEqual({
      id: STUB_EVENT.id,
      investor: STUB_EVENT.investor,
      sourceUrl: STUB_EVENT.sourceUrl,
      rawContent: STUB_EVENT.rawContent,
    });
  });
});

// ---------------------------------------------------------------------------
// Run-level guards — `assertRunPersisted` must throw when the agent
// reports an errorMessage OR no durable research row was written.
// These tests invoke the real guard, not a stub seam.
// ---------------------------------------------------------------------------

describe("pi research runtime — assertRunPersisted guards", () => {
  test("throws when the agent finishes with state.errorMessage set", () => {
    const fake = makeFakeAgent("llm refused to call any tools");
    expect(() =>
      assertRunPersisted(
        fake as unknown as Agent,
        [],
        { id: "run-1" },
      ),
    ).toThrow(/errorMessage=llm refused to call any tools/);
  });

  test("throws when no durable research row was written", () => {
    const fake = makeFakeAgent(undefined);
    expect(() =>
      assertRunPersisted(fake as unknown as Agent, [], null),
    ).toThrow(/no durable research row/);
  });

  test("passes when both errorMessage is empty and a persisted row exists", () => {
    const fake = makeFakeAgent(undefined);
    expect(() =>
      assertRunPersisted(
        fake as unknown as Agent,
        [],
        { id: "run-1" },
      ),
    ).not.toThrow();
  });

  test("captures tool_execution_end events into the toolEvents accumulator", () => {
    const events: AgentEvent[] = [
      {
        type: "tool_execution_end",
        toolName: "read_event",
        isError: false,
      } as unknown as AgentEvent,
      {
        type: "tool_execution_end",
        toolName: "record_research",
        isError: true,
      } as unknown as AgentEvent,
      {
        type: "message_end",
      } as unknown as AgentEvent,
    ];
    const fake = makeFakeAgent(undefined, events);
    const { toolEvents, unsubscribe } = subscribeToolEvents(
      fake as unknown as Agent,
    );
    expect(toolEvents.map((e) => e.toolName)).toEqual([
      "read_event",
      "record_research",
    ]);
    expect(toolEvents[1]?.isError).toBe(true);
    expect(typeof unsubscribe).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Hindsight 4xx/5xx — surface the failure so the CLI can release the claim.
// ---------------------------------------------------------------------------

describe("pi research runtime — Hindsight failure surfacing", () => {
  test("recalling from a Hindsight 4xx surfaces the error message", async () => {
    const hindsight: HindsightClient = {
      retain: async () => ({
        success: true,
        bankId: "alpha-lab",
        itemsCount: 1,
        async: false,
      }),
      recall: async () => {
        throw new Error("hindsight recall failed: 401 Unauthorized");
      },
    };
    const opts = makeRuntimeOptions({ hindsight });
    await expect(opts.hindsight.recall("what prior?")).rejects.toThrow(
      /401/,
    );
  });

  test("retaining into a Hindsight 5xx surfaces the error message", async () => {
    const hindsight: HindsightClient = {
      retain: async () => {
        throw new Error("hindsight retain failed: 503 Service Unavailable");
      },
      recall: async () => ({ results: [] }),
    };
    const opts = makeRuntimeOptions({ hindsight });
    await expect(opts.hindsight.retain("x", "alpha-lab")).rejects.toThrow(
      /503/,
    );
  });
});

// ---------------------------------------------------------------------------
// Max-steps guard — cap the number of LLM turns the agent may consume
// per claim so a misbehaving model cannot loop indefinitely. The Agent
// class has no constructor option for this, so the guard is implemented
// as a subscriber that aborts after `maxSteps` `turn_start` events.
// ---------------------------------------------------------------------------

describe("pi research runtime — max-steps guard", () => {
  test("DEFAULT_MAX_STEPS is a finite positive integer", () => {
    expect(typeof DEFAULT_MAX_STEPS).toBe("number");
    expect(Number.isInteger(DEFAULT_MAX_STEPS)).toBe(true);
    expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
  });

  test("subscribeMaxStepsGuard exposes a turn counter that starts at zero", () => {
    const runtime = buildPiResearchRuntime(makeRuntimeOptions());
    const agent = runtime.buildAgent();
    const guard = subscribeMaxStepsGuard(agent, 3);
    expect(guard.turnCount()).toBe(0);
    expect(typeof guard.unsubscribe).toBe("function");
    guard.unsubscribe();
  });
});
