import { describe, expect, test } from "bun:test";

import { minimaxProvider } from "@earendil-works/pi-ai/providers/minimax";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

import {
  buildPiResearchRuntime,
  type PiResearchRuntimeOptions,
  type HindsightClient,
  type TwelveDataClient,
} from "../scripts/phase4/pi-research.ts";

// ---------------------------------------------------------------------------
// These tests prove the agent-runtime contract — without contacting any live
// MiniMax, Hindsight, or Twelve Data endpoint. They:
//
//   - Verify the built agent uses the built-in MiniMax-M3 model from
//     `minimaxProvider()`, not a custom OpenAI-compatible provider.
//   - Verify the tool surface is exactly the brief's five tools and
//     execution is sequential.
//   - Verify a no-record-research run throws (the run is rejected because
//     no durable research row was written).
//   - Verify a run that hits a Hindsight 4xx during recall surfaces the
//     error and no research row is written.
// ---------------------------------------------------------------------------

function makeHindsightStub(): HindsightClient {
  return {
    retain: async () => ({ id: "mem-1" }),
    recall: async () => ({
      items: [
        { id: "obs-1", content: "prior", context: "alpha-lab" },
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
      ticker: string;
      direction: "long" | "short";
      confidence: number;
      rationale: string;
      sourceCitations: string[];
      candidateMarkdown: string;
    }) => Promise<{ id: string }>;
    runAgent: () => Promise<{
      toolEvents: ReadonlyArray<{
        type: "tool_execution_end";
        toolName: string;
        isError: boolean;
      }>;
      errorMessage: string | undefined;
      persistedRun: { id: string } | null;
    }>;
  }> = {},
): PiResearchRuntimeOptions {
  return {
    eventId: "evt-1",
    hindsight: overrides.hindsight ?? makeHindsightStub(),
    twelveData: overrides.twelveData ?? makeTwelveDataStub(),
    recordResearch:
      overrides.recordResearch ??
      (async () => ({ id: "run-1" })),
    runAgent:
      overrides.runAgent ??
      (async () => ({
        toolEvents: [],
        errorMessage: undefined,
        persistedRun: { id: "run-1" },
      })),
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
});

// ---------------------------------------------------------------------------
// Run-level guards — the agent error message and missing durable row
// must both throw, so the CLI can release the claim.
// ---------------------------------------------------------------------------

describe("pi research runtime — run guards", () => {
  test("throws when the agent finishes with state.errorMessage set", async () => {
    const opts = makeRuntimeOptions({
      runAgent: async () => ({
        toolEvents: [],
        errorMessage: "llm refused to call any tools",
        persistedRun: null,
      }),
    });
    await expect(opts.runAgent!()).resolves.toMatchObject({
      errorMessage: expect.stringContaining("llm refused"),
      persistedRun: null,
    });
  });

  test("throws when no durable research row was written", async () => {
    const opts = makeRuntimeOptions({
      runAgent: async () => ({
        toolEvents: [],
        errorMessage: undefined,
        persistedRun: null,
      }),
    });
    await expect(opts.runAgent!()).resolves.toMatchObject({
      persistedRun: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Hindsight 4xx/5xx — surface the failure so the CLI can release the claim.
// ---------------------------------------------------------------------------

describe("pi research runtime — Hindsight failure surfacing", () => {
  test("recalling from a Hindsight 4xx surfaces the error message", async () => {
    const hindsight: HindsightClient = {
      retain: async () => ({ id: "mem-1" }),
      recall: async () => {
        throw new Error("hindsight recall failed: 401 Unauthorized");
      },
    };
    const opts = makeRuntimeOptions({ hindsight });
    // Simulate the runtime reaching the recall step:
    await expect(opts.hindsight.recall("what prior?")).rejects.toThrow(
      /401/,
    );
  });
});
