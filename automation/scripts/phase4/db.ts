// Phase 4 typed database access.
//
// Bun's built-in SQL client (`SQL` from "bun") is the only Postgres driver
// we use; do NOT add `pg` / `postgres` / `drizzle-orm` / etc. The brief
// explicitly forbids an npm driver.
//
// Exports:
//   - db           shared `SQL` instance from DATABASE_URL
//   - applyMigration  runs 001_phase4_event_ledger.sql + records it in
//                      schema_migrations; safe to re-run (idempotent)
//   - repositories  EventRecord / ResearchRun / PaperBet / BetOutcome
//                   with explicit typed inputs. They use crypto.randomUUID()
//                   for client-side ID generation, parameterized tagged SQL
//                   for every value, and FOR UPDATE SKIP LOCKED on the
//                   claim-one-row paths so multiple workers don't race.
//   - closeDb     flushes the connection pool — call from CLI `finally`.

import { SQL } from "bun";

import type {
  MarketSession,
  ResearchDirection,
  ResearchRunStatus,
} from "./contracts.ts";

// ---------------------------------------------------------------------------
// SQL handle
// ---------------------------------------------------------------------------

export const db = new SQL(process.env.DATABASE_URL ?? "");

export async function closeDb(): Promise<void> {
  await db.close();
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

const MIGRATION_VERSION = "001_phase4_event_ledger";

export async function applyMigration(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  const path = new URL(
    "../../migrations/001_phase4_event_ledger.sql",
    import.meta.url,
  ).pathname;
  await db.file(path);
  await db`
    INSERT INTO schema_migrations ${db({ version: MIGRATION_VERSION })}
    ON CONFLICT (version) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Row shapes — what the DB returns.
// ---------------------------------------------------------------------------

export type SignalEventRow = {
  id: string;
  source_key: string;
  investor: string;
  signal_type: "public_event";
  source_url: string;
  published_at: Date;
  captured_at: Date;
  content_hash: string;
  raw_content: string;
  payload: Record<string, unknown>;
  status: "active" | "superseded" | "rejected";
  supersedes_event_id: string | null;
};

export type ResearchRunRow = {
  id: string;
  event_id: string;
  model: string;
  prompt_version: string;
  thesis: string;
  ticker: string | null;
  direction: ResearchDirection | null;
  confidence: number | null;
  rationale: string;
  source_citations: string[];
  candidate_markdown: string;
  created_at: Date;
  status: ResearchRunStatus;
};

export type PaperBetRow = {
  id: string;
  research_run_id: string;
  event_id: string;
  ticker: string;
  direction: ResearchDirection;
  confidence: number;
  opened_at: Date;
  entry_session_date: string;
  entry_price: number;
  entry_price_source: string;
  status: "open" | "settled" | "unresolved" | "cancelled";
};

export type BetOutcomeRow = {
  id: string;
  paper_bet_id: string;
  settled_at: Date;
  exit_price: number | null;
  exit_price_source: string | null;
  return_pct: number | null;
  outcome: "win" | "loss" | "unresolved";
  reason: string | null;
};

// ---------------------------------------------------------------------------
// EventRecord repository
// ---------------------------------------------------------------------------

export type InsertSignalEvent = Omit<SignalEventRow, "captured_at"> & {
  captured_at?: Date;
};

export const EventRecord = {
  async insert(input: Omit<InsertSignalEvent, "id" | "captured_at">): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO signal_events ${db({
        id,
        ...input,
      })}
    `;
    return id;
  },

  /** Claim the next active event for a worker. FOR UPDATE SKIP LOCKED makes
   *  this safe under multiple concurrent ingestors — at most one worker
   *  sees a given row in the transaction window. */
  async claimNextActive(): Promise<SignalEventRow | null> {
    const rows = await db`
      SELECT id, source_key, investor, signal_type, source_url, published_at,
             captured_at, content_hash, raw_content, payload, status,
             supersedes_event_id
      FROM signal_events
      WHERE status = 'active'
      ORDER BY captured_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------------------
// ResearchRun repository
// ---------------------------------------------------------------------------

export const ResearchRun = {
  async insert(input: Omit<ResearchRunRow, "id" | "created_at">): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO research_runs ${db({ id, ...input })}
    `;
    return id;
  },

  async claimNextPending(): Promise<ResearchRunRow | null> {
    const rows = await db`
      SELECT id, event_id, model, prompt_version, thesis, ticker, direction,
             confidence, rationale, source_citations, candidate_markdown,
             created_at, status
      FROM research_runs
      WHERE status = 'accepted'
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    return rows[0] ?? null;
  },
};

// ---------------------------------------------------------------------------
// PaperBet repository
// ---------------------------------------------------------------------------

export const PaperBet = {
  async insert(input: Omit<PaperBetRow, "id" | "opened_at" | "status">): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO paper_bets ${db({
        id,
        status: "open" as const,
        ...input,
      })}
    `;
    return id;
  },

  async listOpen(): Promise<PaperBetRow[]> {
    return db`
      SELECT id, research_run_id, event_id, ticker, direction, confidence,
             opened_at, entry_session_date, entry_price, entry_price_source,
             status
      FROM paper_bets
      WHERE status = 'open'
      ORDER BY entry_session_date ASC
    `;
  },
};

// ---------------------------------------------------------------------------
// BetOutcome repository
// ---------------------------------------------------------------------------

export const BetOutcome = {
  async insert(input: Omit<BetOutcomeRow, "id" | "settled_at">): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO bet_outcomes ${db({ id, ...input })}
    `;
    return id;
  },
};

// ---------------------------------------------------------------------------
// MarketSession helper — read-only, used by settlement.
// ---------------------------------------------------------------------------

export type MarketSessionRow = {
  date: string;
  adjusted_close: string; // pg numeric → string
};

export async function listMarketSessions(
  ticker: string,
  sinceDate: string,
): Promise<MarketSession[]> {
  const rows = await db`
    SELECT session_date::text AS date, adjusted_close::text AS adjusted_close
    FROM market_sessions
    WHERE ticker = ${ticker} AND session_date > ${sinceDate}
    ORDER BY session_date ASC
  `;
  return rows.map((r: MarketSessionRow) => ({
    date: r.date,
    adjustedClose: Number(r.adjusted_close),
  }));
}