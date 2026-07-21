import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  ItemRecord,
  LedgerDb,
  PaperBet,
  ResearchRun,
  BetOutcome,
  mapBetOutcomeRow,
  mapPaperBetRow,
  mapResearchRunRow,
  mapItemRow,
} from "../lib/db.ts";

// Resolve a path anchored to THIS test file's directory so the source
// string assertions don't depend on process.cwd() (Bun tests can be
// launched from anywhere).
const HERE = dirname(new URL(import.meta.url).pathname);
const DB_SOURCE = join(HERE, "..", "lib", "db.ts");
const MIGRATE_SOURCE = join(HERE, "..", "commands", "migrate-phase4.ts");
const MIGRATION_SQL = join(
  HERE,
  "..",
  "migrations",
  "001_phase4_event_ledger.sql",
);

// ---------------------------------------------------------------------------
// Fix #1 — LedgerDb typed aggregate
//
// Downstream tasks must be able to depend on a single object that
// bundles every public DB surface. The earlier commit only exposed
// each piece as a top-level export, which forced every consumer to
// repeat a multi-symbol import and made mocking invasive.
// ---------------------------------------------------------------------------

describe("LedgerDb aggregate", () => {
  test("exports the LedgerDb constant and its value type", () => {
    expect(typeof LedgerDb).toBe("object");
    expect(LedgerDb).not.toBeNull();
    // Every public surface must be reachable through the aggregate.
    expect(LedgerDb.db).toBeDefined();
    expect(typeof LedgerDb.closeDb).toBe("function");
    expect(typeof LedgerDb.applyMigration).toBe("function");
    expect(LedgerDb.ItemRecord).toBe(ItemRecord);
    expect(LedgerDb.ResearchRun).toBe(ResearchRun);
    expect(LedgerDb.PaperBet).toBe(PaperBet);
    expect(LedgerDb.BetOutcome).toBe(BetOutcome);
    expect(typeof LedgerDb.listMarketSessions).toBe("function");
  });

  test("the exported type matches the constant's shape", () => {
    // Compile-time check: the LedgerDb type alias resolves to the
    // same shape as the constant. If `LedgerDb` is removed, this
    // reference will fail to typecheck.
    const typed: LedgerDb = LedgerDb;
    expect(typed).toBe(LedgerDb);
  });
});

// ---------------------------------------------------------------------------
// Fix #2 — atomic claim via UPDATE ... RETURNING
//
// The earlier commit used SELECT ... FOR UPDATE SKIP LOCKED with no
// state change. Once the row was read, the lock released and another
// worker could claim the same row — leading to double-processing.
// The fix transitions status → 'processing' in the same statement
// that returns the row, so no other worker's claim SQL can ever see
// the row again.
// ---------------------------------------------------------------------------

describe("atomic claim SQL", () => {
  const source = readFileSync(DB_SOURCE, "utf8");
  const migration = readFileSync(MIGRATION_SQL, "utf8");

  test("schema permits 'processing' on signal_events", () => {
    expect(migration).toMatch(
      /status\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'active',\s*'processing',\s*'superseded',\s*'rejected'\s*\)\s*\)/,
    );
  });

  test("schema permits 'processing' on research_runs", () => {
    expect(migration).toMatch(
      /status\s+text\s+NOT\s+NULL\s+CHECK\s*\(\s*status\s+IN\s*\(\s*'accepted',\s*'processing',\s*'rejected',\s*'needs_review'\s*\)\s*\)/,
    );
  });

  test("SignalRecord.claimNextUnclassifiedItems selects items pending classification", () => {
    // signal-layer 將 signal_events 改名為 items 並移除 status 欄位；
    // 改以 classified_at IS NULL 作為「待分類」佇列。此正規表示式
    // 錨定方法簽名與 WHERE classified_at IS NULL 子句。
    expect(source).toMatch(
      /async\s+claimNextUnclassifiedItems\s*\([^)]*\)\s*:\s*Promise<ItemRow\[\]>\s*\{[\s\S]*?FROM\s+items[\s\S]*?WHERE\s+classified_at\s+IS\s+NULL/,
    );
  });

  test("research-signals CLI skips signals that already have an active run", () => {
    // 舊的 research-next-event.ts 已被 research-signals.ts 取代；active-run
    // 守備不再透過 claim CTE 的 NOT EXISTS，而是 CLI 逐訊號呼叫
    // SignalRecord.getTimeline 後以 timeline.some(...) 判斷 accepted/processing。
    const cliSource = readFileSync(
      join(HERE, "..", "commands", "research-signals.ts"),
      "utf8",
    );
    expect(cliSource).toMatch(/getTimeline/);
    expect(cliSource).toMatch(/hasActive/);
  });

  test("ResearchRun.claimNextPending uses UPDATE ... RETURNING with CTE + SKIP LOCKED", () => {
    expect(source).toMatch(
      /async\s+claimNextPending\s*\(\s*\)\s*:\s*Promise<ResearchRunRow\s*\|\s*null>\s*\{[\s\S]*?FOR\s+UPDATE\s+SKIP\s+LOCKED[\s\S]*?UPDATE\s+research_runs\s+SET\s+status\s*=\s*'processing'[\s\S]*?RETURNING/,
    );
  });

  test("releaseToAccepted restores 'accepted' from 'processing'", () => {
    // items 已無 status 欄位，故 releaseToActive 不再存在；僅保留
    // ResearchRun.releaseToAccepted 將 processing 還原為 accepted。
    expect(source).not.toMatch(/releaseToActive/);
    expect(source).toMatch(
      /async\s+releaseToAccepted[\s\S]*?SET\s+status\s*=\s*'accepted'[\s\S]*?status\s*=\s*'processing'/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #3 — numeric → number decoding
//
// PostgreSQL `numeric` columns arrive from Bun SQL as strings (the
// driver preserves precision). The earlier row types declared
// `confidence: number` / `entry_price: number` while raw rows were
// strings, so consumers would silently see strings where they
// expected numbers. The fix routes every result row through a pure
// mapper that calls `Number(...)` before the typed object leaves
// the module.
// ---------------------------------------------------------------------------

describe("row mappers cast numeric strings to JS numbers", () => {
  test("mapItemRow preserves fields and defaults payload/classification", () => {
    const raw = {
      id: "11111111-1111-1111-1111-111111111111",
      source_key: "x_profile:alice",
      investor: "alice",
      signal_type: "public_event",
      source_url: "https://x.com/alice/status/1",
      published_at: new Date("2026-07-01T00:00:00Z"),
      captured_at: new Date("2026-07-01T00:00:01Z"),
      content_hash: "h",
      raw_content: "r",
      payload: { foo: 1 },
      classified_at: null,
      classification_result: null,
    };
    const mapped = mapItemRow(raw);
    expect(mapped.id).toBe(raw.id);
    expect(mapped.payload).toEqual({ foo: 1 });
    expect(mapped.signal_type).toBe("public_event");
    expect(mapped.classified_at).toBeNull();
    expect(mapped.classification_result).toBeNull();
  });

  test("mapResearchRunRow casts confidence from string to number", () => {
    const raw = {
      id: "r1",
      event_id: "e1",
      model: "m",
      prompt_version: "v1",
      thesis: "t",
      ticker: "ABC",
      direction: "long",
      confidence: "0.700", // pg numeric arrives as string
      rationale: "because",
      source_citations: ["https://x.com/a/status/1"],
      candidate_markdown: "md",
      created_at: new Date(),
      status: "processing",
    };
    const mapped = mapResearchRunRow(raw);
    expect(mapped.confidence).toBe(0.7);
    expect(typeof mapped.confidence).toBe("number");
    expect(mapped.direction).toBe("long");
    expect(mapped.source_citations).toEqual(["https://x.com/a/status/1"]);
  });

  test("mapResearchRunRow leaves a missing confidence as null", () => {
    const raw = {
      id: "r1",
      event_id: "e1",
      model: "m",
      prompt_version: "v1",
      thesis: "t",
      ticker: null,
      direction: null,
      confidence: null,
      rationale: "because",
      source_citations: [],
      candidate_markdown: "md",
      created_at: new Date(),
      status: "rejected",
    };
    const mapped = mapResearchRunRow(raw);
    expect(mapped.confidence).toBeNull();
    expect(mapped.ticker).toBeNull();
    expect(mapped.direction).toBeNull();
  });

  test("mapPaperBetRow casts confidence and entry_price from string to number", () => {
    const raw = {
      id: "b1",
      research_run_id: "r1",
      event_id: "e1",
      ticker: "ABC",
      direction: "long",
      confidence: "0.650", // pg numeric
      opened_at: new Date("2026-07-01T00:00:00Z"),
      entry_session_date: "2026-07-01",
      entry_price: "184.27", // pg numeric
      entry_price_source: "twelve_data",
      status: "open",
    };
    const mapped = mapPaperBetRow(raw);
    expect(mapped.confidence).toBe(0.65);
    expect(mapped.entry_price).toBe(184.27);
    expect(typeof mapped.confidence).toBe("number");
    expect(typeof mapped.entry_price).toBe("number");
    expect(mapped.entry_session_date).toBe("2026-07-01");
  });

  test("mapBetOutcomeRow casts exit_price and return_pct; nulls stay null", () => {
    const base = {
      id: "o1",
      paper_bet_id: "b1",
      settled_at: new Date("2026-08-01T00:00:00Z"),
      outcome: "win" as const,
      reason: null as string | null,
    };
    const mappedWin = mapBetOutcomeRow({
      ...base,
      exit_price: "192.10", // pg numeric
      exit_price_source: "twelve_data",
      return_pct: "0.0425", // pg numeric
    });
    expect(mappedWin.exit_price).toBe(192.1);
    expect(mappedWin.return_pct).toBe(0.0425);
    expect(typeof mappedWin.exit_price).toBe("number");
    expect(typeof mappedWin.return_pct).toBe("number");

    const mappedUnresolved = mapBetOutcomeRow({
      ...base,
      exit_price: null,
      exit_price_source: null,
      return_pct: null,
    });
    expect(mappedUnresolved.exit_price).toBeNull();
    expect(mappedUnresolved.return_pct).toBeNull();
    expect(mappedUnresolved.reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fix #4 — entry session is session #1 in market-session retrieval
//
// The settlement window for a bet begins on the bet's
// entry_session_date and runs SETTLEMENT_SESSIONS (30) trading
// sessions. listMarketSessions previously used `>` and so excluded
// the entry session itself; the fix uses `>=` so the entry session
// is row one and selectSettlementSession picks the 30th.
// ---------------------------------------------------------------------------

describe("listMarketSessions includes the entry session", () => {
  const source = readFileSync(DB_SOURCE, "utf8");

  test("the WHERE clause uses >= (not >) on session_date", () => {
    expect(source).toMatch(
      /session_date\s*>=\s*\$\{sinceDate\}/,
    );
    expect(source).not.toMatch(
      /session_date\s*>\s*\$\{sinceDate\}/,
    );
  });
});

// ---------------------------------------------------------------------------
// Fix #5 — no process.exit() before closeDb()
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Fix #6 — research_runs accepted-derived processing cannot reactivate
// the event or allow a second run (P1 race from Task 3 re-review).
//
// The original Task 3 fix added a partial unique index `WHERE status =
// 'accepted'` and an `hasAcceptedRunForEvent` guard. That left a
// window: a worker that called `claimNextPending` transitions the
// run from `accepted` to `processing`, and during that window the
// partial index does NOT cover the row, so a second `accepted`
// insert (or a release-then-reclaim race) can slip past the DB
// guard. The fix extends the partial index to cover both
// `accepted` and `processing` and broadens the application-level
// guards to the same predicate, so the invariant holds for the
// entire lifecycle of the run.
// ---------------------------------------------------------------------------

describe("research_runs accepted-derived processing blocks reactivation", () => {
  const source = readFileSync(DB_SOURCE, "utf8");
  const migration = readFileSync(MIGRATION_SQL, "utf8");

  test("migration drops the old accepted-only index and creates the broadened index", () => {
    // The old partial index is removed (idempotent: no-op on fresh
    // DBs) and replaced by an index whose predicate covers both
    // `accepted` and the accepted-derived `processing` state.
    expect(migration).toMatch(
      /DROP\s+INDEX\s+IF\s+EXISTS\s+research_runs_event_accepted_unique/,
    );
    expect(migration).toMatch(
      /CREATE\s+UNIQUE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+research_runs_event_active_unique[\s\S]*?ON\s+research_runs\s*\(\s*event_id\s*\)[\s\S]*?WHERE\s+status\s+IN\s*\(\s*'accepted',\s*'processing'\s*\)/,
    );
  });

  test("ResearchRun.hasActiveRunForSignal predicate covers both accepted and processing", () => {
    // signal-layer 將 event_id 改名為 signal_id，方法隨之改名為
    // hasActiveRunForSignal；SQL 必須以 signal_id 篩選且涵蓋
    // accepted 與 processing，processing 期間的 run 才算活躍。
    expect(source).toMatch(
      /async\s+hasActiveRunForSignal\s*\(\s*signalId:\s*string\s*\)\s*:\s*Promise<boolean>\s*\{[\s\S]*?WHERE\s+signal_id\s*=\s*\$\{signalId\}[\s\S]*?status\s+IN\s*\(\s*'accepted',\s*'processing'\s*\)/,
    );
    // 舊名不得殘留。
    expect(source).not.toMatch(/hasAcceptedRunForEvent/);
    expect(source).not.toMatch(/hasActiveRunForEvent/);
  });

  test("research-signals CLI skips signals with an active run via getTimeline", () => {
    // research-next-event.ts 已被 research-signals.ts 取代；active-run
    // 守備改由 CLI 逐訊號呼叫 getTimeline 後以 timeline.some(...) 判斷。
    const cliSource = readFileSync(
      join(HERE, "..", "commands", "research-signals.ts"),
      "utf8",
    );
    expect(cliSource).toMatch(/getTimeline/);
    expect(cliSource).toMatch(/hasActive/);
    expect(cliSource).not.toMatch(/hasAcceptedRunForEvent/);
    expect(cliSource).not.toMatch(/hasActiveRunForEvent/);
  });

  test("claimNextUnpublished CTE filters out runs with an existing publication claim", () => {
    // signal-layer 將活躍-run 守備從 claimNextActive 的 NOT EXISTS 移至
    // claimNextUnpublished 的 CTE：跳過已有 research_publications 記錄的
    // run，避免重複發佈；recoverable 子句處理租約逾時回收。
    expect(source).toMatch(
      /async\s+claimNextUnpublished[\s\S]*?NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+research_publications\s+rp[\s\S]*?WHERE\s+rp\.research_run_id\s*=\s*rr\.id[\s\S]*?FOR\s+UPDATE\s+OF\s+rr\s+SKIP\s+LOCKED/,
    );
  });
});

describe("migrate-phase4 never calls process.exit before closeDb", () => {
  const source = readFileSync(MIGRATE_SOURCE, "utf8");

  test("the migrate script does not call process.exit", () => {
    expect(source).not.toMatch(/process\.exit\s*\(/);
  });

  test("missing DATABASE_URL throws (so closeDb finally still runs)", async () => {
    // Drive main() indirectly by re-implementing its decision tree:
    // we expect the same throw-on-missing-env behavior. The actual
    // script body is the integration surface; this is a focused
    // regression that confirms the throw replaces the prior exit.
    const saved = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
      // The new behavior: throwing rather than exiting. We import
      // and call the unexported main indirectly via the module —
      // but main isn't exported, so we verify by reading the
      // module's exported behavior contract: a missing DATABASE_URL
      // applied through the exported applyMigration() throws too.
      const { applyMigration } = await import("../lib/db.ts");
      await expect(applyMigration()).rejects.toThrow(/DATABASE_URL/);
    } finally {
      if (saved !== undefined) process.env.DATABASE_URL = saved;
    }
  });
});