// DB 整合測試:連到 alpha_lab_test 資料庫
// 跑測試前請先建 DB:
//   docker exec alpha-lab-postgres createdb -U alpha alpha_lab_test
//   DATABASE_URL=postgres://alpha:...@localhost:5432/alpha_lab_test bun run migrate
//   DATABASE_URL=postgres://alpha:...@localhost:5432/alpha_lab_test bun test tests/lib/db.test.ts

import { test, expect, beforeAll, beforeEach, describe } from "bun:test";
import { sql } from "bun";
import {
  insertItems,
  haveItems,
  getFetchState,
  upsertFetchState,
  insertSignal,
  getSignalById,
  getSignalsByStatus,
  getActiveSignals,
  updateSignalStatus,
  updateSignal,
} from "../../lib/db.ts";
import { runMigrations } from "../../lib/migrator.ts";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "migrations");

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL must be set (point to alpha_lab_test) for db tests",
    );
  }
  await runMigrations(MIGRATIONS_DIR);
});

beforeEach(async () => {
  await sql`TRUNCATE items, fetch_state, signals, schema_migrations RESTART IDENTITY CASCADE`;
  await runMigrations(MIGRATIONS_DIR);
});

function makeItem(overrides: Partial<Parameters<typeof insertItems>[0][0]> = {}) {
  return {
    source_type: "x_user_timeline",
    source_label: "@BillAckman",
    external_id: "1",
    external_parent: null,
    created_at: new Date("2025-07-07T00:00:00Z"),
    context: "default context",
    raw_payload: { id: "1" },
    ...overrides,
  };
}

describe("insertItems", () => {
  test("inserts new items and returns count", async () => {
    const inserted = await insertItems([makeItem()]);
    expect(inserted).toBe(1);

    const rows = await sql<{ context: string }[]>`SELECT context FROM items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toBe("default context");
  });

  test("is idempotent on conflict (same source_type + external_id)", async () => {
    await insertItems([makeItem({ context: "first" })]);
    const second = await insertItems([makeItem({ context: "second" })]);
    expect(second).toBe(0);

    const rows = await sql<{ context: string }[]>`SELECT context FROM items`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.context).toBe("first"); // first one wins
  });

  test("does not insert raw_payload", async () => {
    await insertItems([makeItem({ raw_payload: { sensitive: "data" } })]);
    const rows = await sql<Record<string, unknown>[]>`SELECT * FROM items`;
    expect(rows[0]).not.toHaveProperty("raw_payload");
  });

  test("handles empty input", async () => {
    const inserted = await insertItems([]);
    expect(inserted).toBe(0);
  });
});

describe("haveItems", () => {
  test("returns set of existing external_ids", async () => {
    await insertItems([
      makeItem({ external_id: "1" }),
      makeItem({ external_id: "2" }),
    ]);

    const have = await haveItems("x_user_timeline", ["1", "2", "3", "4"]);
    expect(have.has("1")).toBe(true);
    expect(have.has("2")).toBe(true);
    expect(have.has("3")).toBe(false);
    expect(have.has("4")).toBe(false);
    expect(have.size).toBe(2);
  });

  test("returns empty set for empty input", async () => {
    const have = await haveItems("x_user_timeline", []);
    expect(have.size).toBe(0);
  });

  test("scoped by source_type", async () => {
    await insertItems([makeItem({ source_type: "x", external_id: "1" })]);
    const have = await haveItems("y", ["1"]);
    expect(have.has("1")).toBe(false);
  });
});

describe("fetch_state", () => {
  test("upsertFetchState creates row when not exists", async () => {
    await upsertFetchState({
      source_type: "x_user_timeline",
      source_key: "user-1",
      source_label: "@user1",
      last_external_id: null,
      last_run_at: null,
      last_status: null,
    });

    const got = await getFetchState("x_user_timeline", "user-1");
    expect(got?.source_label).toBe("@user1");
    expect(got?.last_external_id).toBeNull();
  });

  test("upsertFetchState updates existing row", async () => {
    const base = {
      source_type: "x_user_timeline",
      source_key: "user-1",
      source_label: "@user1",
      last_external_id: null as string | null,
      last_run_at: null as Date | null,
      last_status: null as string | null,
    };
    await upsertFetchState(base);
    await upsertFetchState({
      ...base,
      last_external_id: "100",
      last_status: "ok",
    });

    const got = await getFetchState("x_user_timeline", "user-1");
    expect(got?.last_external_id).toBe("100");
    expect(got?.last_status).toBe("ok");
  });

  test("getFetchState returns null when not exists", async () => {
    const got = await getFetchState("x_user_timeline", "nonexistent");
    expect(got).toBeNull();
  });
});

describe("signals", () => {
  test("insertSignal creates a row with defaults", async () => {
    const signal = await insertSignal({
      title: "Ackman tweets about NVDA",
      description: "Ackman mentioned NVDA in 3 tweets today",
    });
    expect(signal.id).toBeDefined();
    expect(signal.importance).toBe(3); // default
    expect(signal.status).toBe("discovered"); // default
    expect(signal.tags).toEqual([]); // default empty array
    expect(signal.source_items).toEqual([]); // default empty array
    expect(signal.created_at).toBeDefined();
    expect(signal.updated_at).toBeDefined();
  });

  test("insertSignal respects custom importance and tags", async () => {
    const signal = await insertSignal({
      title: "Fed rate decision imminent",
      description: "FOMC meeting tomorrow",
      importance: 5,
      tags: ["macro", "fed"],
      source_items: ["tw-1", "tw-2"],
    });
    expect(signal.importance).toBe(5);
    expect(signal.tags).toEqual(["macro", "fed"]);
    expect(signal.source_items).toEqual(["tw-1", "tw-2"]);
  });

  test("getSignalById returns the signal", async () => {
    const inserted = await insertSignal({ title: "Test", description: "d" });
    const got = await getSignalById(inserted.id);
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Test");
  });

  test("getSignalById returns null for nonexistent", async () => {
    const got = await getSignalById("00000000-0000-0000-0000-000000000000");
    expect(got).toBeNull();
  });

  test("getSignalsByStatus filters correctly", async () => {
    await insertSignal({ title: "A", description: "d", status: "discovered" });
    await insertSignal({ title: "B", description: "d", status: "tracking" });
    await insertSignal({ title: "C", description: "d", status: "matured" });

    const discovered = await getSignalsByStatus("discovered");
    expect(discovered.every((s) => s.status === "discovered")).toBe(true);
    expect(discovered.some((s) => s.title === "A")).toBe(true);
  });

  test("getActiveSignals returns discovered + tracking only", async () => {
    await insertSignal({ title: "D1", description: "d", status: "discovered" });
    await insertSignal({ title: "T1", description: "d", status: "tracking" });
    await insertSignal({ title: "M1", description: "d", status: "matured" });
    await insertSignal({ title: "F1", description: "d", status: "faded" });

    const active = await getActiveSignals();
    expect(active.every((s) => s.status === "discovered" || s.status === "tracking")).toBe(true);
    expect(active.some((s) => s.title === "D1")).toBe(true);
    expect(active.some((s) => s.title === "T1")).toBe(true);
    expect(active.every((s) => s.title !== "M1")).toBe(true);
    expect(active.every((s) => s.title !== "F1")).toBe(true);
  });

  test("updateSignalStatus changes status and bumps updated_at", async () => {
    const inserted = await insertSignal({ title: "S", description: "d" });
    const originalUpdatedAt = inserted.updated_at;
    // Wait a tiny bit to ensure updated_at changes
    await new Promise((r) => setTimeout(r, 10));
    await updateSignalStatus(inserted.id, "tracking");
    const got = await getSignalById(inserted.id);
    expect(got!.status).toBe("tracking");
    expect(got!.updated_at.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  test("updateSignal changes arbitrary fields", async () => {
    const inserted = await insertSignal({ title: "Old", description: "old desc", importance: 2 });
    await updateSignal(inserted.id, { title: "New", importance: 5 });
    const got = await getSignalById(inserted.id);
    expect(got!.title).toBe("New");
    expect(got!.importance).toBe(5);
    expect(got!.description).toBe("old desc"); // unchanged
  });

  test("importance CHECK constraint rejects 0", async () => {
    await expect(
      insertSignal({ title: "Bad", description: "d", importance: 0 }),
    ).rejects.toThrow();
  });

  test("importance CHECK constraint rejects 6", async () => {
    await expect(
      insertSignal({ title: "Bad", description: "d", importance: 6 }),
    ).rejects.toThrow();
  });

  test("status CHECK constraint rejects invalid value", async () => {
    await expect(
      insertSignal({ title: "Bad", description: "d", status: "nonexistent" }),
    ).rejects.toThrow();
  });

  test("insertSignal accepts valid status", async () => {
    const validStatuses = ["discovered", "tracking", "matured", "faded", "invalid"] as const;
    for (const status of validStatuses) {
      const signal = await insertSignal({ title: "T", description: "d", status });
      expect(signal.status).toBe(status);
    }
  });

  test("updateSignal rejects invalid importance", async () => {
    const inserted = await insertSignal({ title: "T", description: "d" });
    await expect(
      updateSignal(inserted.id, { importance: 99 as any }),
    ).rejects.toThrow(/importance/);
  });

  test("updateSignal rejects NaN importance", async () => {
    const inserted = await insertSignal({ title: "T", description: "d" });
    await expect(
      updateSignal(inserted.id, { importance: NaN }),
    ).rejects.toThrow(/importance/);
  });
});
