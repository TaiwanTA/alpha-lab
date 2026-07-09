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
  insertSignals,
  getSignal,
  getSignalBySlug,
  listSignals,
  updateSignalStatus,
} from "../../lib/db.ts";
import { runMigrations } from "../../lib/migrator.ts";
import type { NewSignal } from "../../lib/types.ts";
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

function makeSignal(overrides: Partial<NewSignal> = {}): NewSignal {
  return {
    title: "Ackman trims NVDA",
    description: "Pershing Square Q3 13F shows reduced NVDA position",
    importance: 3,
    status: "discovered",
    tags: ["ackman", "nvda"],
    source_items: ["1001", "1002"],
    ...overrides,
  };
}

describe("signals", () => {
  test("insertSignal returns server-generated uuid", async () => {
    const id = await insertSignal(makeSignal());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    const got = await getSignal(id);
    expect(got).not.toBeNull();
    expect(got!.title).toBe("Ackman trims NVDA");
  });

  test("insertSignal rejects importance outside 1..5 (CHECK constraint)", async () => {
    // bypass TS literal-union with `as any` — 驗證 DB CHECK constraint
    const bad = { ...makeSignal(), importance: 0 } as unknown as NewSignal;
    await expect(insertSignal(bad)).rejects.toThrow();
  });

  test("insertSignal defaults status to 'discovered' when omitted", async () => {
    const { status: _ignored, ...withoutStatus } = makeSignal();
    void _ignored;
    const id = await insertSignal(withoutStatus);
    const got = await getSignal(id);
    expect(got!.status).toBe("discovered");
  });

  test("insertSignals bulk insert returns count, respects ON CONFLICT DO NOTHING", async () => {
    const first = await insertSignals([makeSignal({ title: "a" }), makeSignal({ title: "b" })]);
    expect(first).toBe(2);

    // 用 raw SQL 預先塞一個固定 id 的 row,再插同 id 測 ON CONFLICT
    await sql`
      INSERT INTO signals (id, title, description, importance, status)
      VALUES ('00000000-0000-0000-0000-000000000001', 'preset', 'preset', 3, 'discovered')
    `;

    // 第二輪帶一個 explicit id(撞 preset)+ 一個走 default id
    const conflictRow = {
      id: "00000000-0000-0000-0000-000000000001",
      ...makeSignal({ title: "should conflict" }),
    };
    const second = await insertSignals([
      conflictRow as unknown as NewSignal,
      makeSignal({ title: "c" }),
    ]);
    expect(second).toBe(1); // 只有 c 進去
  });

  test("getSignal returns null when missing", async () => {
    const got = await getSignal("00000000-0000-0000-0000-000000000000");
    expect(got).toBeNull();
  });

  test("getSignalBySlug returns the row or null", async () => {
    const id = await insertSignal(makeSignal({ slug: "ackman-nvda-cuts-2026q3" }));
    const got = await getSignalBySlug("ackman-nvda-cuts-2026q3");
    expect(got?.id).toBe(id);

    const missing = await getSignalBySlug("does-not-exist");
    expect(missing).toBeNull();
  });

  test("listSignals filters by status", async () => {
    await insertSignal(makeSignal({ title: "t1", status: "discovered" }));
    await insertSignal(makeSignal({ title: "t2", status: "tracking" }));
    await insertSignal(makeSignal({ title: "t3", status: "tracking" }));

    const tracking = await listSignals({ status: "tracking" });
    expect(tracking).toHaveLength(2);
    expect(tracking.every((s) => s.status === "tracking")).toBe(true);

    const discovered = await listSignals({ status: "discovered" });
    expect(discovered).toHaveLength(1);
  });

  test("listSignals filters by minImportance (>=)", async () => {
    await insertSignal(makeSignal({ title: "low", importance: 2 }));
    await insertSignal(makeSignal({ title: "high4", importance: 4 }));
    await insertSignal(makeSignal({ title: "high5", importance: 5 }));

    const important = await listSignals({ minImportance: 4 });
    expect(important).toHaveLength(2);
    expect(important.every((s) => s.importance >= 4)).toBe(true);
  });

  test("listSignals filters by tags (any-of via &&)", async () => {
    await insertSignal(makeSignal({ title: "nvda", tags: ["nvda", "ai"] }));
    await insertSignal(makeSignal({ title: "tsla", tags: ["tsla", "ev"] }));
    await insertSignal(makeSignal({ title: "ai-policy", tags: ["ai", "policy"] }));

    // 給 ["nvda"] 應只命中第一條(只有它有 nvda)
    const nvdaOnly = await listSignals({ tags: ["nvda"] });
    expect(nvdaOnly).toHaveLength(1);
    expect(nvdaOnly[0]!.title).toBe("nvda");

    // 給 ["ai"] 應命中第一條 + 第三條(any-of)
    const aiAny = await listSignals({ tags: ["ai"] });
    expect(aiAny).toHaveLength(2);

    // 給 ["nvda", "tsla"] 應命中前兩條
    const multi = await listSignals({ tags: ["nvda", "tsla"] });
    expect(multi).toHaveLength(2);
  });

  test("updateSignalStatus updates status and bumps updated_at", async () => {
    const id = await insertSignal(makeSignal());
    const before = await getSignal(id);
    expect(before!.status).toBe("discovered");

    // 確保 updated_at 跟 created_at 之間有可觀察的差距(now() per-statement)
    await new Promise((r) => setTimeout(r, 20));

    await updateSignalStatus(id, "tracking");
    const after = await getSignal(id);
    expect(after!.status).toBe("tracking");
    expect(after!.updated_at.getTime()).toBeGreaterThan(before!.updated_at.getTime());
  });
});
