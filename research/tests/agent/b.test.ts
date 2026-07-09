import { test, expect, describe, mock } from "bun:test";
import { discover, type BDependencies } from "../../agent/b.ts";
import type { ItemRow, Signal } from "../../lib/types.ts";

// Helper:造 fake dep bundle
function makeFakeDeps(opts: {
  items?: ItemRow[],
  activeSignals?: Signal[],
  llmContent?: string,                          // 直接指定 LLM 回傳字串
  llmThrows?: Error,                            // LLM 直接 throw
  insertSignalThrows?: Error,                   // 第一個 insertSignal 失敗
}): BDependencies {
  let insertCallCount = 0;
  return {
    getUnprocessedItems: mock(async (_limit: number) => opts.items ?? []),
    getActiveSignals: mock(async () => opts.activeSignals ?? []),
    insertSignal: mock(async (s: any) => {
      insertCallCount++;
      if (opts.insertSignalThrows && insertCallCount === 1) {
        throw opts.insertSignalThrows;
      }
      return { id: `signal-${insertCallCount}`, ...s, created_at: new Date(), updated_at: new Date() };
    }),
    markItemsProcessed: mock(async (_st: string, _ids: string[]) => {}),
    ask: mock(async (_prompt: string, _opts?: any) => {
      if (opts.llmThrows) throw opts.llmThrows;
      return {
        content: opts.llmContent ?? '{"signals": []}',
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: "test-model",
      };
    }),
  };
}

// Helper:造 ItemRow
function makeItem(id: string, text: string = "test tweet"): ItemRow {
  return {
    source_type: "x_user_timeline",
    source_label: "@BillAckman",
    external_id: id,
    external_parent: null,
    created_at: new Date(),
    fetched_at: new Date(),
    context: `Tweet by @BillAckman (id: ${id})\nPosted: 2026-07-09T00:00:00Z\nURL: https://x.com/BillAckman/status/${id}\n\n[Content]\n${text}`,
    raw_payload: {},
    processed_at: null,
  };
}

describe("B agent discover — empty state", () => {
  test("returns 0/0 and does NOT call LLM when no unprocessed items", async () => {
    const deps = makeFakeDeps({ items: [] });
    const result = await discover(deps);
    expect(result.itemsProcessed).toBe(0);
    expect(result.newSignals).toBe(0);
    // LLM should NOT be called
    expect(deps.ask).not.toHaveBeenCalled();
    // markItemsProcessed should NOT be called
    expect(deps.markItemsProcessed).not.toHaveBeenCalled();
  });
});

describe("B agent discover — happy path", () => {
  test("inserts 1 signal when LLM returns 1 candidate, marks items processed", async () => {
    const items = [makeItem("tw1", "Ackman mentioned NVDA"), makeItem("tw2", "Other tweet")];
    const deps = makeFakeDeps({
      items,
      llmContent: JSON.stringify({
        signals: [{
          title: "Ackman on NVDA",
          description: "Ackman mentioned NVDA in a tweet",
          importance: 4,
          tags: ["nvda", "ackman"],
          source_item_ids: ["tw1"],
        }],
      }),
    });

    const result = await discover(deps);
    expect(result.itemsProcessed).toBe(2);
    expect(result.newSignals).toBe(1);
    expect(deps.insertSignal).toHaveBeenCalledTimes(1);
    // Check insert is called with the candidate
    const inserted = (deps.insertSignal as any).mock.calls[0][0];
    expect(inserted.title).toBe("Ackman on NVDA");
    expect(inserted.importance).toBe(4);
    expect(inserted.source_items).toEqual(["tw1"]);
    // Both items marked processed
    expect(deps.markItemsProcessed).toHaveBeenCalledTimes(1);
    const markArgs = (deps.markItemsProcessed as any).mock.calls[0];
    expect(markArgs[0]).toBe("x_user_timeline");
    expect(markArgs[1]).toHaveLength(2);
    expect(markArgs[1]).toContain("tw1");
    expect(markArgs[1]).toContain("tw2");
  });

  test("marks items processed even when LLM returns 0 signals", async () => {
    const items = [makeItem("tw1"), makeItem("tw2")];
    const deps = makeFakeDeps({
      items,
      llmContent: '{"signals": []}',
    });

    const result = await discover(deps);
    expect(result.itemsProcessed).toBe(2);
    expect(result.newSignals).toBe(0);
    expect(deps.insertSignal).not.toHaveBeenCalled();
    expect(deps.markItemsProcessed).toHaveBeenCalledTimes(1);
  });
});

describe("B agent discover — data filtering", () => {
  test("filters out source_item_ids not in input items", async () => {
    const items = [makeItem("tw1"), makeItem("tw2")];
    const deps = makeFakeDeps({
      items,
      llmContent: JSON.stringify({
        signals: [{
          title: "Test",
          description: "d",
          importance: 3,
          tags: ["test"],
          source_item_ids: ["tw1", "tw-bogus-not-in-items", "tw2"],
        }],
      }),
    });

    const result = await discover(deps);
    expect(result.newSignals).toBe(1);
    const inserted = (deps.insertSignal as any).mock.calls[0][0];
    // Bogus id filtered out
    expect(inserted.source_items).toHaveLength(2);
    expect(inserted.source_items).toEqual(["tw1", "tw2"]);
  });

  test("passes active signals list in user prompt to LLM", async () => {
    const items = [makeItem("tw1")];
    const active: Signal[] = [{
      id: "sig-1",
      slug: null,
      title: "Existing Ackman NVDA position",
      description: "Ackman started tracking NVDA last week",
      importance: 4,
      status: "tracking",
      tags: ["nvda"],
      source_items: ["tw-old"],
      created_at: new Date(),
      updated_at: new Date(),
    }];
    const deps = makeFakeDeps({ items, activeSignals: active });

    await discover(deps);
    expect(deps.ask).toHaveBeenCalledTimes(1);
    const promptArg = (deps.ask as any).mock.calls[0][0];
    expect(promptArg).toContain("Existing Ackman NVDA position");
    expect(promptArg).toContain("started tracking NVDA");
  });
});

describe("B agent discover — error handling", () => {
  test("continues if one signal insert fails", async () => {
    const items = [makeItem("tw1"), makeItem("tw2")];
    const deps = makeFakeDeps({
      items,
      llmContent: JSON.stringify({
        signals: [
          { title: "Sig1", description: "d1", importance: 3, tags: [], source_item_ids: ["tw1"] },
          { title: "Sig2", description: "d2", importance: 4, tags: [], source_item_ids: ["tw2"] },
        ],
      }),
      insertSignalThrows: new Error("DB constraint violation"),
    });

    const result = await discover(deps);
    // First insert failed, second succeeded
    expect(result.newSignals).toBe(1);
    expect(deps.insertSignal).toHaveBeenCalledTimes(2);
    // Both items still marked processed despite partial failure
    expect(deps.markItemsProcessed).toHaveBeenCalledTimes(1);
    expect(result.itemsProcessed).toBe(2);
  });

  test("throws when LLM returns invalid JSON", async () => {
    const items = [makeItem("tw1")];
    const deps = makeFakeDeps({
      items,
      llmContent: "this is not JSON",
    });

    await expect(discover(deps)).rejects.toThrow(/valid JSON/);
    // Items NOT marked processed when LLM output is garbled
    expect(deps.markItemsProcessed).not.toHaveBeenCalled();
  });

  test("throws when LLM JSON missing 'signals' array", async () => {
    const items = [makeItem("tw1")];
    const deps = makeFakeDeps({
      items,
      llmContent: '{"foo": "bar"}',
    });

    await expect(discover(deps)).rejects.toThrow(/'signals' array/);
    expect(deps.markItemsProcessed).not.toHaveBeenCalled();
  });

  test("throws when LLM JSON has 'signals' but not array", async () => {
    const items = [makeItem("tw1")];
    const deps = makeFakeDeps({
      items,
      llmContent: '{"signals": "not-an-array"}',
    });

    await expect(discover(deps)).rejects.toThrow(/'signals' array/);
  });
});
