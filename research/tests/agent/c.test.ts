import { test, expect, describe, mock } from "bun:test";
import { research, type CDependencies } from "../../agent/c.ts";
import type { Signal, ItemRow } from "../../lib/types.ts";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "signal-uuid-1",
    slug: null,
    title: "Ackman on NVDA",
    description: "Ackman mentioned NVDA position in recent tweets",
    importance: 4,
    status: "discovered",
    tags: ["nvda", "ackman"],
    source_items: ["tw1", "tw2"],
    created_at: new Date("2026-07-08"),
    updated_at: new Date("2026-07-08"),
    ...overrides,
  };
}

function makeItem(id: string): ItemRow {
  return {
    source_type: "x_user_timeline",
    source_label: "@BillAckman",
    external_id: id,
    external_parent: null,
    created_at: new Date("2026-07-09"),
    fetched_at: new Date("2026-07-09"),
    context: `Tweet by @BillAckman\n[Content]\nTest tweet ${id}`,
    raw_payload: {},
    processed_at: null,
  };
}

function makeFakeDeps(opts: {
  signal?: Signal | null;
  items?: ItemRow[];
  priorObservations?: Array<{ id?: string; text: string; score?: number }>;
  llmContent?: string;
  retainThrows?: Error;
  writeReportThrows?: Error;
  bankCreated?: boolean;
}): CDependencies {
  return {
    getSignal: mock(async (_id: string) => opts.signal ?? null),
    getSourceItems: mock(async (_ids: string[]) => opts.items ?? []),
    recallHindsight: mock(async (_q: string, _o?: any) => opts.priorObservations ?? []),
    retainHindsight: mock(async (_memory: any) => {
      if (opts.retainThrows) throw opts.retainThrows;
      return { id: "mem-1" };
    }),
    ensureHindsightBank: mock(async () => {}),
    ask: mock(async (_prompt: string, _opts?: any) => ({
      content: opts.llmContent ?? '{"observations": []}',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
    })),
    writeReport: mock(async (_path: string, _content: string) => {
      if (opts.writeReportThrows) throw opts.writeReportThrows;
    }),
    updateSignalStatus: mock(async (_id: string, _status: string) => {}),
  };
}

describe("C agent research — happy path", () => {
  test("returns 0 observations when LLM gives empty array, still writes report, still upgrades status", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      items: [makeItem("tw1"), makeItem("tw2")],
      llmContent: '{"observations": []}',
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(0);
    expect(deps.writeReport).toHaveBeenCalledTimes(1);
    expect(deps.updateSignalStatus).toHaveBeenCalledWith(signal.id, "tracking");
  });

  test("retains 2 observations when LLM returns 2 valid findings", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      items: [makeItem("tw1")],
      llmContent: JSON.stringify({
        observations: [
          {
            observation: "Ackman explicitly stated NVDA is a long position",
            entities: ["ackman", "nvda"],
            tags: ["position", "explicit"],
            source: "tw1",
          },
          {
            observation: "Implied price target zone based on tweet context",
            entities: ["nvda"],
            tags: ["price-target"],
            source: "inferred",
          },
        ],
      }),
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(2);
    expect(deps.retainHindsight).toHaveBeenCalledTimes(2);
    // Stricter: verify retain was called with type=observation
    const firstCall = (deps.retainHindsight as any).mock.calls[0][0];
    expect(firstCall.type).toBe("observation");
    expect(firstCall.text).toContain("Ackman explicitly stated");
    // Report was written
    const reportContent = (deps.writeReport as any).mock.calls[0][1];
    expect(reportContent).toContain("# Ackman on NVDA");
    expect(reportContent).toContain("Ackman explicitly stated NVDA");
  });

  test("only upgrades status from 'discovered' to 'tracking', keeps 'matured'", async () => {
    const signal = makeSignal({ status: "matured" });
    const deps = makeFakeDeps({ signal });

    await research(signal.id, deps);
    expect(deps.updateSignalStatus).not.toHaveBeenCalled();
  });
});

describe("C agent research — validation", () => {
  test("skips observation missing text", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: JSON.stringify({
        observations: [
          { entities: ["x"], tags: [], source: "tw1" },
          {
            observation: "Valid one",
            entities: [],
            tags: [],
            source: "tw1",
          },
        ],
      }),
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(1);
  });

  test("skips observation too long (> 2000 chars)", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: JSON.stringify({
        observations: [
          {
            observation: "x".repeat(2001),
            entities: [],
            tags: [],
            source: "tw1",
          },
        ],
      }),
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(0);
  });

  test("skips observation with non-string tags", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: JSON.stringify({
        observations: [
          {
            observation: "text",
            entities: [],
            tags: ["ok", 123],
            source: "tw1",
          },
        ],
      }),
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(0);
  });

  test("skips null observation entries but continues with rest", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: JSON.stringify({
        observations: [
          null,
          {
            observation: "Valid",
            entities: [],
            tags: [],
            source: "tw1",
          },
        ],
      }),
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(1);
  });
});

describe("C agent research — error handling", () => {
  test("throws when signal not found", async () => {
    const deps = makeFakeDeps({ signal: null });
    await expect(research("nonexistent-id", deps)).rejects.toThrow(
      /Signal not found/,
    );
  });

  test("throws when LLM returns invalid JSON", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: "this is not JSON",
    });
    await expect(research(signal.id, deps)).rejects.toThrow(/valid JSON/);
  });

  test("throws when LLM JSON missing observations array", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: '{"foo": "bar"}',
    });
    await expect(research(signal.id, deps)).rejects.toThrow(
      /'observations' array/,
    );
  });

  test("throws when LLM returns null root", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: "null",
    });
    await expect(research(signal.id, deps)).rejects.toThrow(/not an object/);
  });

  test("continues if first Hindsight retain fails but second succeeds", async () => {
    const signal = makeSignal();
    let callCount = 0;
    const deps: CDependencies = {
      getSignal: mock(async () => signal),
      getSourceItems: mock(async () => [makeItem("tw1")]),
      recallHindsight: mock(async () => []),
      retainHindsight: mock(async (_m: any) => {
        callCount++;
        if (callCount === 1) throw new Error("Hindsight 500");
        return { id: `mem-${callCount}` };
      }),
      ensureHindsightBank: mock(async () => {}),
      ask: mock(async () => ({
        content: JSON.stringify({
          observations: [
            {
              observation: "first will fail",
              entities: [],
              tags: [],
              source: "tw1",
            },
            {
              observation: "second will succeed",
              entities: [],
              tags: [],
              source: "tw1",
            },
          ],
        }),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
      })),
      writeReport: mock(async () => {}),
      updateSignalStatus: mock(async () => {}),
    };

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(1);
    expect(deps.retainHindsight).toHaveBeenCalledTimes(2);
  });

  test("signal status upgraded even if 0 observations", async () => {
    const signal = makeSignal();
    const deps = makeFakeDeps({
      signal,
      llmContent: '{"observations": []}',
    });

    const result = await research(signal.id, deps);
    expect(result.observationsRetained).toBe(0);
    expect(deps.updateSignalStatus).toHaveBeenCalledWith(signal.id, "tracking");
  });
});

describe("C agent research — prompt building", () => {
  test("user prompt contains signal title, description, prior observations", async () => {
    const signal = makeSignal({
      title: "Ackman NVDA",
      description: "Ackman comments on NVDA",
      tags: ["nvda"],
    });
    const deps = makeFakeDeps({
      signal,
      items: [makeItem("tw1")],
      priorObservations: [
        { text: "Ackman previously said he likes NVDA" },
      ],
    });

    await research(signal.id, deps);
    const userPrompt = (deps.ask as any).mock.calls[0][0];
    expect(userPrompt).toContain("Ackman NVDA");
    expect(userPrompt).toContain("Ackman comments on NVDA");
    expect(userPrompt).toContain("Ackman previously said he likes NVDA");
  });
});
