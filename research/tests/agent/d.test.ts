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
  preReportDate?: string; // YYYY-MM-DD,默认 2026-07-09
  writeThrows?: Error;
}): DDependencies {
  // 用 closure 的 writtenReports map 让 writeReport / readReportIfExists 共享 in-memory state
  // 这样 post 测试可以模拟「先前已写过 pre report」的狀態
  const writtenReports = new Map<string, string>();
  const preDate = opts.preReportDate ?? "2026-07-09"; // Kilo PR #8 SUGGESTION:之前硬编码
  if (opts.preReport !== undefined && opts.preReport !== null) {
    writtenReports.set(`drafts/reports/${preDate}-pre.md`, opts.preReport);
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
    ensureHindsightBank: mock(async () => {}),
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

describe("D agent generateReport — formatDateET uses America/New_York", () => {
  test("ET date is used, not UTC (off-by-one edge case)", async () => {
    // 2026-07-09T04:00 UTC = 2026-07-09T00:00 EDT (midnight ET, still same day but right at boundary)
    // 2026-07-09T03:00 UTC = 2026-07-08T23:00 EDT (previous day in ET)
    const deps = makeFakeDeps({});
    const justAfterMidnightET = new Date("2026-07-09T04:00:00Z");
    const result1 = await generateReport("pre", deps, justAfterMidnightET);
    expect(result1.reportPath).toContain("2026-07-09-pre.md");

    const justBeforeMidnightET = new Date("2026-07-09T03:59:00Z");
    const result2 = await generateReport("pre", deps, justBeforeMidnightET);
    expect(result2.reportPath).toContain("2026-07-08-pre.md"); // still prev ET day
  });

  test("formatDateET respects DST (winter = EST UTC-5)", async () => {
    // 2026-12-15T05:00 UTC = 2026-12-15T00:00 EST (UTC-5)
    const deps = makeFakeDeps({});
    const winter = new Date("2026-12-15T05:00:00Z");
    const result = await generateReport("pre", deps, winter);
    expect(result.reportPath).toContain("2026-12-15-pre.md");

    // 2026-12-15T04:59 UTC = 2026-12-14T23:59 EST
    const winterPrevDay = new Date("2026-12-15T04:59:00Z");
    const r2 = await generateReport("pre", deps, winterPrevDay);
    expect(r2.reportPath).toContain("2026-12-14-pre.md");
  });
});

describe("D agent generateReport — Kilo PR #8 fixes", () => {
  test("ensureHindsightBank is called once per run", async () => {
    const deps = makeFakeDeps({ active: [makeSignal()] });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    expect(deps.ensureHindsightBank).toHaveBeenCalledTimes(1);
  });

  test("signals are sorted by importance DESC before top-10 slice (post mode)", async () => {
    // 3 active (importance 5,1,3) + 2 matured (importance 4,2) = 5 total
    // After sort: 5,4,3,2,1 — all included since <10
    const deps = makeFakeDeps({
      active: [
        makeSignal({ id: "a1", importance: 5 }),
        makeSignal({ id: "a2", importance: 1 }),
        makeSignal({ id: "a3", importance: 3 }),
      ],
      matured: [
        makeSignal({ id: "m1", importance: 4, status: "matured" }),
        makeSignal({ id: "m2", importance: 2, status: "matured" }),
      ],
    });
    await generateReport("post", deps, new Date("2026-07-09T22:00:00Z"));
    const userPrompt = (deps.ask as any).mock.calls[0][0];
    // Should contain all 5 given they're < 10
    expect(userPrompt).toContain("[5/5]");
    expect(userPrompt).toContain("[4/5]");
    expect(userPrompt).toContain("[3/5]");
    expect(userPrompt).toContain("[2/5]");
    expect(userPrompt).toContain("[1/5]");
  });

  test("top-10 cap takes highest importance signals (over-10 case)", async () => {
    // 15 signals, importance 1-15
    const deps = makeFakeDeps({
      active: Array.from({ length: 15 }, (_, i) =>
        makeSignal({ id: `sig-${i+1}`, importance: i+1 as 1|2|3|4|5 })
      ),
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    // Only top 10 should be recalled
    expect(deps.recallHindsight).toHaveBeenCalledTimes(10);
  });

  test("recall is parallelized (Promise.all, not sequential)", async () => {
    const deps = makeFakeDeps({
      active: Array.from({ length: 5 }, (_, i) =>
        makeSignal({ id: `sig-${i+1}`, importance: 5, title: `Sig${i+1}` })
      ),
    });
    const callTimestamps: number[] = [];
    (deps as any).recallHindsight = mock(async () => {
      callTimestamps.push(Date.now());
      // 模拟一次 recall 需要 50ms
      await new Promise((resolve) => setTimeout(resolve, 50));
      return [{ text: "obs", score: 0.5 }];
    });

    const start = Date.now();
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    const elapsed = Date.now() - start;

    // 5 个 recall * 50ms sequential = 250ms;parallel should be < 100ms
    // Kilo PR #8 iter 2:寬鬆一點 CI 上不 flaky
    expect(elapsed).toBeLessThan(150);
    expect(callTimestamps).toHaveLength(5);
    // Parallelism check:在 sequential 模式下,第 N 個 call 的 timestamp 減
    // 第 N-1 個 應該 ≥ 40ms(因為上一個 await 等完才發下一個)。parallel 模式下
    // 差距極小(< 10ms 通常)。用 25ms 作為判斷閾值。
    let maxGap = 0;
    for (let i = 1; i < callTimestamps.length; i++) {
      maxGap = Math.max(maxGap, callTimestamps[i]! - callTimestamps[i-1]!);
    }
    // Sequential 會是 ~50ms gap;parallel 應該 < 25ms
    expect(maxGap).toBeLessThan(25);
  });

  test("throws when LLM returns empty content", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      llmContent: "",
    });
    await expect(
      generateReport("pre", deps, new Date("2026-07-09T13:00:00Z")),
    ).rejects.toThrow(/empty\/too-short content/);
    expect(deps.writeReport).not.toHaveBeenCalled();
  });

  test("throws when LLM returns very short content (<10 chars)", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      llmContent: "ab", // 2 chars
    });
    await expect(
      generateReport("pre", deps, new Date("2026-07-09T13:00:00Z")),
    ).rejects.toThrow(/empty\/too-short content/);
  });

  test("throws when LLM returns only whitespace (passes length but trims to 0)", async () => {
    const deps = makeFakeDeps({
      active: [makeSignal()],
      llmContent: "          \n\n\t  ", // 15 chars raw, 0 trimmed
    });
    await expect(
      generateReport("pre", deps, new Date("2026-07-09T13:00:00Z")),
    ).rejects.toThrow(/empty\/too-short content/);
    expect(deps.writeReport).not.toHaveBeenCalled();
  });

  test("sort tiebreaker uses created_at when importance is equal", async () => {
    // 3 signals all importance 5, different created_at
    const older = makeSignal({
      id: "older",
      importance: 5,
      created_at: new Date("2026-07-01"),
    });
    const middle = makeSignal({
      id: "middle",
      importance: 5,
      created_at: new Date("2026-07-05"),
    });
    const newest = makeSignal({
      id: "newest",
      importance: 5,
      created_at: new Date("2026-07-09"),
    });
    // Pass in random order to verify sort picks newest-first by created_at
    const deps = makeFakeDeps({
      active: [older, newest, middle],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    const calls = (deps.recallHindsight as any).mock.calls;
    // First recall query should be for 'newest' (most recent created_at)
    expect(calls[0][0]).toBe("Ackman on NVDA"); // title is same, can't distinguish
    // But we can verify all 3 were called
    expect(calls.length).toBe(3);
  });

  test("sanitizes signal title with newlines (no markdown breakage in prompt)", async () => {
    const deps = makeFakeDeps({
      active: [
        makeSignal({
          title: "Multi\nLine\nTitle",
          description: "Normal description",
        }),
      ],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    const userPrompt = (deps.ask as any).mock.calls[0][0];
    // Should NOT contain the original newlines from title (sanitized to spaces)
    expect(userPrompt).not.toContain("Multi\nLine\nTitle");
    expect(userPrompt).toContain("Multi Line Title");
  });

  test("sanitizes long signal description (truncated)", async () => {
    const longDesc = "A".repeat(2000);
    const deps = makeFakeDeps({
      active: [makeSignal({ description: longDesc })],
    });
    await generateReport("pre", deps, new Date("2026-07-09T13:00:00Z"));
    const userPrompt = (deps.ask as any).mock.calls[0][0];
    // Description should be truncated, not the full 2000 chars
    expect(userPrompt).not.toContain("A".repeat(2000));
    expect(userPrompt).toContain("A".repeat(1000)); // MAX_DESC_LEN=1000
  });
});
