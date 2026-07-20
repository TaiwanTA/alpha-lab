// Phase 4 typed database access.
//
// Bun's built-in SQL client (`SQL` from "bun") is the only Postgres driver
// we use; do NOT add `pg` / `postgres` / `drizzle-orm` / etc. The brief
// explicitly forbids an npm driver.
//
// Exports:
//   - db              shared `SQL` instance from DATABASE_URL
//   - closeDb         flushes the connection pool — call from CLI `finally`
//   - applyMigration  runs 001_phase4_event_ledger.sql + records it in
//                      schema_migrations; safe to re-run (idempotent)
//   - repositories    EventRecord / ResearchRun / PaperBet / BetOutcome
//                     with explicit typed inputs. They use crypto.randomUUID()
//                     for client-side ID generation and parameterized tagged
//                     SQL for every value.
//   - LedgerDb        aggregate bundling every public surface above so
//                     later tasks can depend on one typed object.
//   - row mappers     mapDbRow helpers coerce PostgreSQL `numeric` columns
//                     (returned as strings by Bun SQL) into JS numbers
//                     before typed result objects leave the module.
//   - listMarketSessions  returns trading sessions on/after the entry date,
//                     so the entry session is session #1 (per
//                     selectSettlementSession's contract).

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
    "../migrations/001_phase4_event_ledger.sql",
    import.meta.url,
  ).pathname;
  await db.file(path);
  // Use parameterized values — Bun's `db(obj)` interpolation inside a
  // tagged template is unsafe on bun 1.3.14 (verified empirically: the
  // unquoted string spills into SQL text, and Postgres rejected the
  // non-integer literal against `version text`/numeric columns).
  await db`
    INSERT INTO schema_migrations (version) VALUES (${MIGRATION_VERSION})
    ON CONFLICT (version) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Row shapes — what the DB returns after the row mappers normalize numeric
// columns to JS numbers and jsonb columns to their parsed shapes.
// ---------------------------------------------------------------------------

export type SignalEventStatus =
  | "active"
  | "processing"
  | "superseded"
  | "rejected";

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
  status: SignalEventStatus;
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
  status: ResearchRunStatus | "processing";
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

// Raw shape returned by Bun SQL before numeric casting. numeric columns
// arrive as strings (the driver does not auto-coerce them) and jsonb
// columns arrive as parsed JS values. We expose this type so tests can
// feed mappers representative raw rows.
export type RawSignalEventRow = Omit<SignalEventRow, never> & {
  payload: unknown;
  source_citations?: unknown;
};

export type RawResearchRunRow = Omit<ResearchRunRow, "confidence"> & {
  confidence: string | number | null;
};

export type RawPaperBetRow = Omit<
  PaperBetRow,
  "confidence" | "entry_price"
> & {
  confidence: string | number;
  entry_price: string | number;
};

export type RawBetOutcomeRow = Omit<
  BetOutcomeRow,
  "exit_price" | "return_pct"
> & {
  exit_price: string | number | null;
  return_pct: string | number | null;
};

// ---------------------------------------------------------------------------
// Row mappers — normalize Bun SQL output (numeric → string) into the typed
// row shapes exported above. The mappers are pure and exported so focused
// tests can drive them with synthetic raw rows.
// ---------------------------------------------------------------------------

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFiniteNumber(value: string | number | null | undefined): number {
  const n = toNumber(value);
  if (n === null) {
    throw new Error("expected a finite numeric value from PostgreSQL");
  }
  return n;
}

export function mapSignalEventRow(raw: Record<string, unknown>): SignalEventRow {
  return {
    id: raw.id as string,
    source_key: raw.source_key as string,
    investor: raw.investor as string,
    signal_type: "public_event",
    source_url: raw.source_url as string,
    published_at: raw.published_at as Date,
    captured_at: raw.captured_at as Date,
    content_hash: raw.content_hash as string,
    raw_content: raw.raw_content as string,
    payload: (raw.payload as Record<string, unknown> | null) ?? {},
    status: raw.status as SignalEventRow["status"],
    supersedes_event_id:
      (raw.supersedes_event_id as string | null | undefined) ?? null,
  };
}

export function mapResearchRunRow(raw: Record<string, unknown>): ResearchRunRow {
  return {
    id: raw.id as string,
    event_id: raw.event_id as string,
    model: raw.model as string,
    prompt_version: raw.prompt_version as string,
    thesis: raw.thesis as string,
    ticker: (raw.ticker as string | null | undefined) ?? null,
    direction: (raw.direction as ResearchDirection | null | undefined) ?? null,
    confidence: toNumber(raw.confidence as string | number | null | undefined),
    rationale: raw.rationale as string,
    source_citations: Array.isArray(raw.source_citations)
      ? (raw.source_citations as string[])
      : [],
    candidate_markdown: raw.candidate_markdown as string,
    created_at: raw.created_at as Date,
    status: raw.status as ResearchRunRow["status"],
  };
}

export function mapPaperBetRow(raw: Record<string, unknown>): PaperBetRow {
  return {
    id: raw.id as string,
    research_run_id: raw.research_run_id as string,
    event_id: raw.event_id as string,
    ticker: raw.ticker as string,
    direction: raw.direction as ResearchDirection,
    confidence: toFiniteNumber(raw.confidence as string | number),
    opened_at: raw.opened_at as Date,
    entry_session_date:
      typeof raw.entry_session_date === "string"
        ? raw.entry_session_date
        : (raw.entry_session_date as Date).toISOString().slice(0, 10),
    entry_price: toFiniteNumber(raw.entry_price as string | number),
    entry_price_source: raw.entry_price_source as string,
    status: raw.status as PaperBetRow["status"],
  };
}

export function mapBetOutcomeRow(raw: Record<string, unknown>): BetOutcomeRow {
  return {
    id: raw.id as string,
    paper_bet_id: raw.paper_bet_id as string,
    settled_at: raw.settled_at as Date,
    exit_price: toNumber(raw.exit_price as string | number | null | undefined),
    exit_price_source:
      (raw.exit_price_source as string | null | undefined) ?? null,
    return_pct: toNumber(raw.return_pct as string | number | null | undefined),
    outcome: raw.outcome as BetOutcomeRow["outcome"],
    reason: (raw.reason as string | null | undefined) ?? null,
  };
}

// ---------------------------------------------------------------------------
// EventRecord repository
// ---------------------------------------------------------------------------

export type InsertSignalEvent = Omit<SignalEventRow, "captured_at" | "status"> & {
  captured_at?: Date;
  status?: SignalEventStatus;
};

export const EventRecord = {
  async insert(
    input: Omit<InsertSignalEvent, "id" | "captured_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO signal_events (
        id, source_key, investor, signal_type, source_url, published_at,
        content_hash, raw_content, payload, status, supersedes_event_id
      ) VALUES (
        ${id},
        ${input.source_key},
        ${input.investor},
        ${input.signal_type},
        ${input.source_url},
        ${input.published_at},
        ${input.content_hash},
        ${input.raw_content},
        ${input.payload},
        ${input.status ?? "active"},
        ${input.supersedes_event_id}
      )
    `;
    return id;
  },

  /** Atomically claim the next active event for a worker. The UPDATE
   *  transitions status → 'processing' in the same statement that
   *  returns the row, so once the statement commits no other worker
   *  can pick the same row (their FOR UPDATE SKIP LOCKED + status
   *  filter will skip it).
   *
   *  The CTE also excludes events that already have an active
   *  `research_runs` row (status IN ('accepted', 'processing')),
   *  so a worker can never re-claim an event whose research is
   *  already persisted OR in flight — defence in depth alongside
   *  the `research_runs_event_active_unique` partial index. The
   *  accepted-derived `processing` state is the transient claim
   *  state owned by the next-stage worker (claimNextPending →
   *  releaseToAccepted / final settlement); excluding it here
   *  prevents a second `claimNextActive` from reactivating an
   *  event that already has an in-flight research run. */
  async claimNextActive(): Promise<SignalEventRow | null> {
    const rows = await db`
      WITH next_active AS (
        SELECT id
        FROM signal_events
        WHERE status = 'active'
          AND NOT EXISTS (
            SELECT 1
            FROM research_runs rr
            WHERE rr.event_id = signal_events.id
              AND rr.status IN ('accepted', 'processing')
          )
        ORDER BY captured_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE signal_events
      SET status = 'processing'
      WHERE id IN (SELECT id FROM next_active)
      RETURNING id, source_key, investor, signal_type, source_url,
                published_at, captured_at, content_hash, raw_content,
                payload, status, supersedes_event_id
    `;
    const first = rows[0];
    return first ? mapSignalEventRow(first as Record<string, unknown>) : null;
  },

  /** Release a claimed event back to 'active' (used when the worker
   *  could not finish processing). */
  async releaseToActive(id: string): Promise<void> {
    await db`
      UPDATE signal_events
      SET status = 'active'
      WHERE id = ${id} AND status = 'processing'
    `;
  },
};

export const ResearchRun = {
  async insert(
    input: Omit<ResearchRunRow, "id" | "created_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO research_runs (
        id, event_id, model, prompt_version, thesis, ticker, direction,
        confidence, rationale, source_citations, candidate_markdown, status
      ) VALUES (
        ${id},
        ${input.event_id},
        ${input.model},
        ${input.prompt_version},
        ${input.thesis},
        ${input.ticker},
        ${input.direction},
        ${input.confidence},
        ${input.rationale},
        ${input.source_citations},
        ${input.candidate_markdown},
        ${input.status}
      )
    `;
    return id;
  },

  /** Returns true when an event already has an active research
   *  run (status IN ('accepted', 'processing')). Used by the
   *  research CLI's claim release path to decide whether the
   *  event should be released back to `active` (rare — the
   *  partial unique index also enforces this at the DB level)
   *  or left alone for an operator / Task 4 sweeper. The
   *  `processing` predicate is critical: a worker that called
   *  `claimNextPending` to start paper-bet opening owns the
   *  run; a second `claimNextActive` race must NOT release the
   *  event back to `active` while that run is still in flight,
   *  otherwise the partial index would see a transient gap and
   *  a parallel retry could insert a second accepted run. */
  async hasActiveRunForEvent(eventId: string): Promise<boolean> {
    const rows = await db`
      SELECT 1
      FROM research_runs
      WHERE event_id = ${eventId}
        AND status IN ('accepted', 'processing')
      LIMIT 1
    `;
    return rows.length > 0;
  },

  async claimNextPending(): Promise<ResearchRunRow | null> {
    const rows = await db`
      WITH next_accepted AS (
        SELECT id
        FROM research_runs
        WHERE status = 'accepted'
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE research_runs
      SET status = 'processing'
      WHERE id IN (SELECT id FROM next_accepted)
      RETURNING id, event_id, model, prompt_version, thesis, ticker,
                direction, confidence, rationale, source_citations,
                candidate_markdown, created_at, status
    `;
    const first = rows[0];
    return first ? mapResearchRunRow(first as Record<string, unknown>) : null;
  },

  async releaseToAccepted(id: string): Promise<void> {
    await db`
      UPDATE research_runs
      SET status = 'accepted'
      WHERE id = ${id} AND status = 'processing'
    `;
  },

  async findAcceptedById(id: string): Promise<ResearchRunRow | null> {
    const rows = await db`
      SELECT id, event_id, model, prompt_version, thesis, ticker,
             direction, confidence, rationale, source_citations,
             candidate_markdown, created_at, status
      FROM research_runs
      WHERE id = ${id} AND status = 'accepted'
      LIMIT 1
    `;
    const first = rows[0];
    return first ? mapResearchRunRow(first as Record<string, unknown>) : null;
  },

  async claimNextUnpublished(owner: string): Promise<ResearchRunRow | null> {
    const rows = await db`
      WITH recoverable_target AS (
        SELECT candidate.research_run_id
        FROM research_publications candidate
        WHERE candidate.status = 'claimed'
          AND candidate.claimed_at < now() - interval '30 minutes'
        ORDER BY candidate.claimed_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), recoverable AS (
        UPDATE research_publications rp
        SET claim_owner = ${owner}, claimed_at = now()
        FROM recoverable_target
        WHERE rp.research_run_id = recoverable_target.research_run_id
        RETURNING rp.research_run_id
      ), next_accepted AS (
        SELECT rr.id
        FROM research_runs rr
        WHERE rr.status = 'accepted'
          AND NOT EXISTS (
            SELECT 1 FROM research_publications rp
            WHERE rp.research_run_id = rr.id
          )
          AND NOT EXISTS (SELECT 1 FROM recoverable)
        ORDER BY rr.created_at ASC
        FOR UPDATE OF rr SKIP LOCKED
        LIMIT 1
      ), inserted_claim AS (
        INSERT INTO research_publications (research_run_id, status, claim_owner)
        SELECT id, 'claimed', ${owner} FROM next_accepted
        ON CONFLICT (research_run_id) DO NOTHING
        RETURNING research_run_id
      ), claimed AS (
        SELECT research_run_id FROM recoverable
        UNION ALL
        SELECT research_run_id FROM inserted_claim
      )
      SELECT rr.id, rr.event_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.created_at,
             rr.status
      FROM research_runs rr
      JOIN claimed claim ON claim.research_run_id = rr.id
      LIMIT 1
    `;
    const first = rows[0];
    return first ? mapResearchRunRow(first as Record<string, unknown>) : null;
  },

  async claimNextPushed(owner: string): Promise<ResearchRunRow | null> {
    const rows = await db`
      WITH pushed_target AS (
        SELECT candidate.research_run_id
        FROM research_publications candidate
        WHERE candidate.status = 'pushed'
          AND (candidate.claim_owner IS NULL OR candidate.claimed_at < now() - interval '30 minutes')
        ORDER BY candidate.claimed_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      ), claimed AS (
        UPDATE research_publications rp
        SET claim_owner = ${owner}, claimed_at = now()
        FROM pushed_target
        WHERE rp.research_run_id = pushed_target.research_run_id
        RETURNING rp.research_run_id
      )
      SELECT rr.id, rr.event_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.created_at,
             rr.status
      FROM research_runs rr
      JOIN claimed ON claimed.research_run_id = rr.id
    `;
    const first = rows[0];
    return first ? mapResearchRunRow(first as Record<string, unknown>) : null;
  },

  async markPushed(id: string, owner: string): Promise<void> {
    await db`
      UPDATE research_publications
      SET status = 'pushed', claimed_at = now()
      WHERE research_run_id = ${id}
        AND status = 'claimed'
        AND claim_owner = ${owner}
    `;
  },

  async revertPushed(id: string, owner: string): Promise<void> {
    await db`
      UPDATE research_publications
      SET status = 'claimed'
      WHERE research_run_id = ${id}
        AND status = 'pushed'
        AND claim_owner = ${owner}
    `;
  },

  async findPublishableById(id: string, owner: string): Promise<ResearchRunRow | null> {
    const rows = await db`
      SELECT rr.id, rr.event_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.created_at,
             rr.status
      FROM research_runs rr
      JOIN research_publications rp ON rp.research_run_id = rr.id
      WHERE rr.id = ${id}
        AND rr.status IN ('accepted','processing')
        AND rp.status = 'claimed'
        AND rp.claim_owner = ${owner}
      LIMIT 1
    `;
    const first = rows[0];
    return first ? mapResearchRunRow(first as Record<string, unknown>) : null;
  },

  async releasePublicationClaim(id: string, owner: string): Promise<void> {
    await db`
      DELETE FROM research_publications
      WHERE research_run_id = ${id}
        AND status = 'claimed'
        AND claim_owner = ${owner}
    `;
  },

  async markPublished(id: string, owner: string): Promise<void> {
    await db`
      UPDATE research_publications
      SET status = 'published', published_at = now(), claim_owner = NULL
      WHERE research_run_id = ${id}
        AND status = 'pushed'
        AND claim_owner = ${owner}
    `;
  },
};

// ---------------------------------------------------------------------------
// PaperBet repository
// ---------------------------------------------------------------------------

export const PaperBet = {
  async insert(
    input: Omit<PaperBetRow, "id" | "opened_at" | "status">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO paper_bets (
        id, research_run_id, event_id, ticker, direction, confidence,
        entry_session_date, entry_price, entry_price_source, status
      ) VALUES (
        ${id},
        ${input.research_run_id},
        ${input.event_id},
        ${input.ticker},
        ${input.direction},
        ${input.confidence},
        ${input.entry_session_date},
        ${input.entry_price},
        ${input.entry_price_source},
        ${"open"}
      )
    `;
    return id;
  },

  async insertAndAcceptRun(
    input: Omit<PaperBetRow, "id" | "opened_at" | "status">,
    owner: string,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.begin(async (transaction) => {
      const claims = await transaction`
        SELECT 1 FROM paper_bet_opening_claims
        WHERE research_run_id = ${input.research_run_id}
          AND claim_owner = ${owner}
        FOR UPDATE
      `;
      if (claims.length !== 1) throw new Error("paper-bet opening claim is not owned");
      await transaction`
        INSERT INTO paper_bets (
          id, research_run_id, event_id, ticker, direction, confidence,
          entry_session_date, entry_price, entry_price_source, status
        ) VALUES (
          ${id},
          ${input.research_run_id},
          ${input.event_id},
          ${input.ticker},
          ${input.direction},
          ${input.confidence},
          ${input.entry_session_date},
          ${input.entry_price},
          ${input.entry_price_source},
          ${"open"}
        )
      `;
      await transaction`
        DELETE FROM paper_bet_opening_claims
        WHERE research_run_id = ${input.research_run_id}
          AND claim_owner = ${owner}
      `;
    });
    return id;
  },

  async settle(
    paperBetId: string,
    input: Omit<BetOutcomeRow, "id" | "paper_bet_id" | "settled_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.begin(async (transaction) => {
      await transaction`
        INSERT INTO bet_outcomes (
          id, paper_bet_id, exit_price, exit_price_source, return_pct,
          outcome, reason
        ) VALUES (
          ${id},
          ${paperBetId},
          ${input.exit_price},
          ${input.exit_price_source},
          ${input.return_pct},
          ${input.outcome},
          ${input.reason}
        )
      `;
      await transaction`
        UPDATE paper_bets
        SET status = ${input.outcome === "unresolved" ? "unresolved" : "settled"}
        WHERE id = ${paperBetId} AND status = 'open'
      `;
    });
    return id;
  },

  async listOpen(): Promise<PaperBetRow[]> {
    const rows = await db`
      SELECT id, research_run_id, event_id, ticker, direction, confidence,
             opened_at, entry_session_date, entry_price, entry_price_source,
             status
      FROM paper_bets
      WHERE status = 'open'
      ORDER BY entry_session_date ASC
    `;
    return rows.map((r: Record<string, unknown>) => mapPaperBetRow(r));
  },
};

// ---------------------------------------------------------------------------
// BetOutcome repository
// ---------------------------------------------------------------------------

export const BetOutcome = {
  async insert(
    input: Omit<BetOutcomeRow, "id" | "settled_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO bet_outcomes (
        id, paper_bet_id, exit_price, exit_price_source, return_pct,
        outcome, reason
      ) VALUES (
        ${id},
        ${input.paper_bet_id},
        ${input.exit_price},
        ${input.exit_price_source},
        ${input.return_pct},
        ${input.outcome},
        ${input.reason}
      )
    `;
    return id;
  },
};

// ---------------------------------------------------------------------------
// MarketSession helper — read-only, used by settlement.
// ---------------------------------------------------------------------------

export type MarketSessionRow = {
  date: string;
  adjusted_close: string;
};

export type RawMarketSessionRow = {
  date: string;
  adjusted_close: string | number;
};

/** Trading sessions on or after `sinceDate` (entry_session_date), so the
 *  entry session is session #1 for `selectSettlementSession`. Uses
 *  `>=` (not `>`) and includes the entry date itself. */
export async function listMarketSessions(
  ticker: string,
  sinceDate: string,
): Promise<MarketSession[]> {
  const rows = await db`
    SELECT session_date::text AS date, adjusted_close::text AS adjusted_close
    FROM market_sessions
    WHERE ticker = ${ticker} AND session_date >= ${sinceDate}
    ORDER BY session_date ASC
  `;
  return rows.map((r: RawMarketSessionRow) => ({
    date: r.date,
    adjustedClose: Number(r.adjusted_close),
  }));
}

// ---------------------------------------------------------------------------
// LedgerDb — typed aggregate bundling every public surface above so
// downstream tasks depend on a single, mockable object instead of
// importing each piece individually.
// ---------------------------------------------------------------------------

export const LedgerDb = {
  db,
  closeDb,
  applyMigration,
  EventRecord,
  ResearchRun,
  PaperBet,
  BetOutcome,
  listMarketSessions,
} as const;

export type LedgerDb = typeof LedgerDb;