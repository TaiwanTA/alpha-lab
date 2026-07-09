import { test, expect, describe, mock } from "bun:test";
import { generateReport, type DDependencies } from "../../agent/d.ts";
import type { Signal } from "../../lib/types.ts";

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: "sig-1",
    slug: null,
    title: "Ackman on NVDA",
    description: "Ackman mentioned NVDA position",
    importance: 4,
    status: "tracking",
    tags: ["nvda"],
    source_items: ["tw1"],
    created_at: new Date("2026-07-08"),
    updated_at: new Date("2026-07-08"),
    ...overrides,
  };
}

function makeFakeDeps(opts: {
  active?: Signal[];
  matured?: Signal[];
  observations?: Array<{ text: string; score?: number }>;
  llmContent?: string;
  preReport?: string | null;
  writeThrows?: Error;
}): DDependencies {
  // 用 closure 的 writtenReports map 让 writeReport / readReportIfExists 共享 in-memory state
  // 这样 post 测试可以模拟「先前已写过 pre report」的狀態
  const writtenReports = new Map<string, string>();
  if (opts.preReport !== undefined && opts.preReport !== null) {
    writtenReports.set("drafts/reports/2026-07-09-pre.md", opts.preReport);
  }

  return {
    getActiveSignals: mock(async () => opts.active ?? []),
    getSignalsByStatus: mock(async (_status: string) => opts.matured ?? []),
    recallHindsight: mock(async (_q: string, _o?: any) => opts.observations ?? []),
    ask: mock(async (_prompt: string, _opts?: any) => ({
      content: opts.llmContent ?? "default markdown content",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
    })),
    writeReport: mock(async (path: string, content: string) => {
      if (opts.writeThrows) throw opts.writeThrows;
      writtenReports.set(path, content);
    }),
    readReportIfExists: mock(async (path: string) => {
      return writtenReports.get(path) ?? null;
    }),
  };
}

describe("D agent generateReport — pre", () => {
  test("writes pre-market report with date in filename", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      llmContent: "# 盘前报告 — 2026-07-09\n\n## 重点\n- something",
    });
    const today = new Date("2026-07-09T13:00:00Z"); // 09:00 ET

    const result = await generateReport("pre", deps, today);
    expect(result.type).toBe("pre");
    expect(result.reportPath).toBe("drafts/reports/2026-07-09-pre.md");
    expect(deps.writeReport).toHaveBeenCalledTimes(1);
    const [path, content] = (deps.writeReport as any).mock.calls[0];
    expect(path).toBe("drafts/reports/2026-07-09-pre.md");
    expect(content).toContain("盘前报告");
  });

  test("pre market uses only getActiveSignals (not matured)", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal({ title: "Active one" })],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    expect(deps.getActiveSignals).toHaveBeenCalledTimes(1);
    expect(deps.getSignalsByStatus).not.toHaveBeenCalled();
  });

  test("no active signals — still writes report (LLM prompted with empty)", async () => {
    const deps = makeFakeDeps({
      active: [],
      llmContent: "no major signals today",
    });
    const result = await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    expect(deps.writeReport).toHaveBeenCalled();
    expect(result.reportLength).toBeGreaterThan(0);
  });
});

describe("D agent generateReport — post", () => {
  test("reads today's pre-market report and includes it in prompt", async () => {
    const preReport = "# 盘前报告 — 2026-07-09\n\n## 预测\n- NVDA will go up";
    const deps = makeFakeDeps({
      active: [makeSignal()],
      preReport,
    });
    await generateReport("post", deps, new Date("2026-07-09T22:00:00Z"));

    expect(deps.getSignalsByStatus).toHaveBeenCalledWith("matured");
    const askCall = (deps.ask as any).mock.calls[0];
    const userPrompt = askCall[0];
    expect(userPrompt).toContain("NVDA will go up");
  });

  test("post does not fail when pre-market report missing", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      preReport: null,
      llmContent: "post without pre",
    });
    const result = await generateReport("post", deps, new Date("2026-07-09T22:00:00Z"));
    expect(result.reportPath).toBe("drafts/reports/2026-07-09-post.md");
    expect(deps.writeReport).toHaveBeenCalled();
  });

  test("post uses active + matured signals", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal({ title: "ActiveSignal one", description: "active-desc" })],
      matured: [makeSignal({ title: "MaturedSignal one", description: "matured-desc", status: "matured" })],
    });
    await generateReport("post", deps, new Date("2026-07-09T22:00:00Z"));
    expect(deps.getSignalsByStatus).toHaveBeenCalledWith("matured");
    const askCall = (deps.ask as any).mock.calls[0];
    const userPrompt = askCall[0];
    // Spec: prompt includes signal title + description (no id),
    // so we assert on those distinct values instead
    expect(userPrompt).toContain("ActiveSignal one");
    expect(userPrompt).toContain("active-desc");
    expect(userPrompt).toContain("MaturedSignal one");
    expect(userPrompt).toContain("matured-desc");
  });
});

describe("D agent generateReport — recall dedup", () => {
  test("recall observations across signals are deduplicated by text", async () => {
    const signal1 = makeSignal({ title: "Sig1" });
    const signal2 = makeSignal({ title: "Sig2" });
    const deps = makeFakeDeps({
      active: [signal1, signal2],
      observations: [
        { text: "duplicate observation", score: 0.9 },
        { text: "duplicate observation", score: 0.8 },
      ],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    // recallHindsight called per signal, but prompt should have 1 unique
    const askCall = (deps.ask as any).mock.calls[0];
    const userPrompt = askCall[0];
    const occurrences = (userPrompt.match(/duplicate observation/g) || []).length;
    expect(occurrences).toBe(1);
  });

  test("recall is bounded by top 10 signals (LLM contention)", async () => {
    const deps = makeFakeDeps({
      active: Array.from({ length: 15 }, (_, i) => makeSignal({ id: `sig-${i}`, title: `Sig${i}` })),
      observations: [{ text: "obs" }],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    expect(deps.recallHindsight).toHaveBeenCalledTimes(10);
  });
});

describe("D agent generateReport — error handling", () => {
  test("propagates LLM errors (no silent catch on no choices etc)", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
    });
    (deps.ask as any) = mock(async () => {
      throw new Error("LLM API error 500");
    });
    await expect(
      generateReport("pre", deps, new Date("2026-07-09T13:00:00Z")),
    ).rejects.toThrow(/LLM API error 500/);
  });

  test("writeReport error propagates (no catch)", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      writeThrows: new Error("disk full"),
    });
    await expect(
      generateReport("pre", deps, new Date("2026-07-09T13:00:00Z")),
    ).rejects.toThrow(/disk full/);
  });
});

describe("D agent generateReport — filename & format", () => {
  test("pre filename uses YYYY-MM-DD", async () => {
    const deps = makeFakeDeps({});
    const result = await generateReport("pre", deps, new Date("2026-12-31T15:00:00Z"));
    expect(result.reportPath).toMatch(/^drafts\/reports\/\d{4}-\d{2}-\d{2}-pre\.md$/);
  });

  test("post filename uses YYYY-MM-DD", async () => {
    const deps = makeFakeDeps({});
    const result = await generateReport("post", deps, new Date("2026-12-31T22:00:00Z"));
    expect(result.reportPath).toMatch(/^drafts\/reports\/\d{4}-\d{2}-\d{2}-post\.md$/);
  });
});
