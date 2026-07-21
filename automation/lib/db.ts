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
//   - repositories    ItemRecord / SignalRecord / ResearchRun / PaperBet / BetOutcome
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

export type ItemRow = {
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
  classified_at: Date | null;
  classification_result: Record<string, unknown> | null;
};
export type ResearchRunRow = {
  id: string;
  signal_id: string;
  model: string;
  prompt_version: string;
  thesis: string;
  ticker: string | null;
  direction: ResearchDirection | null;
  confidence: number | null;
  rationale: string;
  source_citations: string[];
  candidate_markdown: string;
  published_path: string | null;
  created_at: Date;
  status: ResearchRunStatus | "processing";
};

export type PaperBetRow = {
  id: string;
  research_run_id: string;
  signal_id: string;
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
export type RawItemRow = Omit<ItemRow, never> & {
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

export function mapItemRow(raw: Record<string, unknown>): ItemRow {
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
    classified_at:
      raw.classified_at instanceof Date
        ? raw.classified_at
        : (raw.classified_at as string | null | undefined)
          ? new Date(raw.classified_at as string)
          : null,
    classification_result:
      (raw.classification_result as Record<string, unknown> | null | undefined) ?? null,
  };
}

export function mapResearchRunRow(raw: Record<string, unknown>): ResearchRunRow {
  return {
    id: raw.id as string,
    signal_id: raw.signal_id as string,
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
    published_path:
      (raw.published_path as string | null | undefined) ?? null,
    created_at: raw.created_at as Date,
    status: raw.status as ResearchRunRow["status"],
  };
}

export function mapPaperBetRow(raw: Record<string, unknown>): PaperBetRow {
  return {
    id: raw.id as string,
    research_run_id: raw.research_run_id as string,
    signal_id: raw.signal_id as string,
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
// ItemRecord repository
// ---------------------------------------------------------------------------

export type InsertItem = Omit<ItemRow, "captured_at"> & {
  captured_at?: Date;
};

export const ItemRecord = {
  async insert(
    input: Omit<InsertItem, "id" | "captured_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO items (
        id, source_key, investor, signal_type, source_url, published_at,
        content_hash, raw_content, payload, classified_at, classification_result
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
        ${input.classified_at ?? null},
        ${input.classification_result ?? null}
      )
    `;
    return id;
  },
};

export const ResearchRun = {
  async insert(
    input: Omit<ResearchRunRow, "id" | "created_at">,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO research_runs (
        id, signal_id, model, prompt_version, thesis, ticker, direction,
        confidence, rationale, source_citations, candidate_markdown,
        published_path, status
      ) VALUES (
        ${id},
        ${input.signal_id},
        ${input.model},
        ${input.prompt_version},
        ${input.thesis},
        ${input.ticker},
        ${input.direction},
        ${input.confidence},
        ${input.rationale},
        ${input.source_citations},
        ${input.candidate_markdown},
        ${input.published_path},
        ${input.status}
      )
    `;
    return id;
  },

  /** 將 tryClaimForResearch 建立的 processing 列更新為 accepted,
   *  填入研究結果。 */
  async finalizeClaim(
    signalId: string,
    input: Omit<ResearchRunRow, "id" | "created_at" | "signal_id">,
  ): Promise<string | null> {
    const rows = await db`
      UPDATE research_runs SET
        model = ${input.model},
        prompt_version = ${input.prompt_version},
        thesis = ${input.thesis},
        ticker = ${input.ticker},
        direction = ${input.direction},
        confidence = ${input.confidence},
        rationale = ${input.rationale},
        source_citations = ${input.source_citations},
        candidate_markdown = ${input.candidate_markdown},
        published_path = ${input.published_path},
        status = ${input.status}
      WHERE signal_id = ${signalId}
        AND status = 'processing'
      RETURNING id
    `;
    const first = rows[0];
    return first ? (first as Record<string, unknown>).id as string : null;
  },

  /** Returns true when a signal already has an active research
   *  run (status IN ('accepted', 'processing')). Used by the
   *  research CLI's claim release path to decide whether the
   *  signal should be released (rare — the partial unique index
   *  also enforces this at the DB level) or left alone for an
   *  operator / sweeper. The `processing` predicate is critical:
   *  a worker that called `claimNextPending` to start paper-bet
   *  opening owns the run; a second claim race must NOT release
   *  the signal while that run is still in flight, otherwise the
   *  partial index would see a transient gap and a parallel retry
   *  could insert a second accepted run. */
  async hasActiveRunForSignal(signalId: string): Promise<boolean> {
    const rows = await db`
      SELECT 1
      FROM research_runs
      WHERE signal_id = ${signalId}
        AND status IN ('accepted', 'processing')
      LIMIT 1
    `;
    return rows.length > 0;
  },

  /** 嘗試原子性地鎖定 signal 供研究使用。
   *  插入一筆 status='processing' 的 research_run,
   *  利用 partial unique index (signal_id WHERE status IN ('accepted','processing'))
   *  防止併發 worker 同時認領同一 signal。
   *  回傳 true = 鎖定成功;false = 已有活躍 run。 */
  async tryClaimForResearch(signalId: string): Promise<boolean> {
    const id = crypto.randomUUID();
    const rows = await db`
      INSERT INTO research_runs (id, signal_id, model, prompt_version,
        thesis, ticker, direction, confidence, rationale,
        source_citations, candidate_markdown, published_path, status)
      VALUES (
        ${id}, ${signalId}, 'pending', 'signal-layer-v1',
        '', null, null, 0, '',
        '[]'::jsonb, '', null, 'processing'
      )
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  },

  /** 研究失敗時清理 processing 列,釋放 signal 供下次認領。
   *  直接刪除,因為此列沒有研究結果。 */
  async releaseFailedClaim(signalId: string): Promise<void> {
    await db`
      DELETE FROM research_runs
      WHERE signal_id = ${signalId}
        AND status = 'processing'
    `;
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
      RETURNING id, signal_id, model, prompt_version, thesis, ticker,
                direction, confidence, rationale, source_citations,
                candidate_markdown, published_path, created_at, status
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
      SELECT id, signal_id, model, prompt_version, thesis, ticker,
             direction, confidence, rationale, source_citations,
             candidate_markdown, published_path, created_at, status
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
        JOIN signals s ON s.id = rr.signal_id
        WHERE rr.status = 'accepted'
          AND rr.candidate_markdown IS NOT NULL
          AND rr.candidate_markdown != ''
          AND s.archived_at IS NULL
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
      SELECT rr.id, rr.signal_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.published_path,
             rr.created_at, rr.status
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
      SELECT rr.id, rr.signal_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.published_path,
             rr.created_at, rr.status
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
      SELECT rr.id, rr.signal_id, rr.model, rr.prompt_version, rr.thesis,
             rr.ticker, rr.direction, rr.confidence, rr.rationale,
             rr.source_citations, rr.candidate_markdown, rr.published_path,
             rr.created_at, rr.status
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
// SignalRecord — narrative entity repository
// ---------------------------------------------------------------------------

export type SignalPriority = "high" | "low";

export type SignalRow = {
  id: string;
  title: string;
  description: string;
  priority: SignalPriority;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
};

export type RawSignalRow = Omit<SignalRow, never>;

export type SignalItemRelation = "primary" | "supporting" | "context";

export type SignalItemRow = {
  signal_id: string;
  item_id: string;
  relation: SignalItemRelation | null;
  added_at: Date;
};

export function mapSignalRow(raw: Record<string, unknown>): SignalRow {
  return {
    id: String(raw.id),
    title: String(raw.title),
    description: String(raw.description),
    priority: String(raw.priority) as SignalPriority,
    created_at: new Date(raw.created_at as string),
    updated_at: new Date(raw.updated_at as string),
    archived_at: raw.archived_at ? new Date(raw.archived_at as string) : null,
  };
}

export type InsertSignal = Omit<SignalRow, "id" | "created_at" | "updated_at">;

export const SignalRecord = {
  async insert(input: InsertSignal): Promise<string> {
    const id = crypto.randomUUID();
    await db`
      INSERT INTO signals (id, title, description, priority, archived_at)
      VALUES (
        ${id},
        ${input.title},
        ${input.description},
        ${input.priority},
        ${input.archived_at}
      )
    `;
    return id;
  },

  async linkItem(
    signalId: string,
    itemId: string,
    relation: SignalItemRelation,
  ): Promise<void> {
    await db`
      INSERT INTO signal_items (signal_id, item_id, relation)
      VALUES (${signalId}, ${itemId}, ${relation})
      ON CONFLICT (signal_id, item_id) DO NOTHING
    `;
  },

  async claimNextUnclassifiedItems(
    limit: number = 50,
  ): Promise<ItemRow[]> {
    const rows = await db`
      SELECT id, source_key, investor, signal_type, source_url,
             published_at, captured_at, content_hash, raw_content,
             payload, classified_at, classification_result
      FROM items
      WHERE classified_at IS NULL
      ORDER BY captured_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r: Record<string, unknown>) => mapItemRow(r));
  },

  async markClassified(
    itemId: string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await db`
      UPDATE items
      SET classified_at = now(),
          classification_result = ${result}
      WHERE id = ${itemId}
    `;
  },

  async listActive(): Promise<SignalRow[]> {
    const rows = await db`
      SELECT id, title, description, priority, created_at, updated_at, archived_at
      FROM signals
      WHERE archived_at IS NULL
      ORDER BY priority ASC, updated_at DESC
    `;
    return rows.map((r: Record<string, unknown>) => mapSignalRow(r));
  },

  async listByPriority(priority: SignalPriority): Promise<SignalRow[]> {
    const rows = await db`
      SELECT id, title, description, priority, created_at, updated_at, archived_at
      FROM signals
      WHERE archived_at IS NULL AND priority = ${priority}
      ORDER BY updated_at DESC
    `;
    return rows.map((r: Record<string, unknown>) => mapSignalRow(r));
  },

  async findById(id: string): Promise<SignalRow | null> {
    const rows = await db`
      SELECT id, title, description, priority, created_at, updated_at, archived_at
      FROM signals
      WHERE id = ${id}
      LIMIT 1
    `;
    const first = rows[0];
    return first ? mapSignalRow(first as Record<string, unknown>) : null;
  },

  async changePriority(
    id: string,
    priority: SignalPriority,
  ): Promise<void> {
    await db`
      UPDATE signals SET priority = ${priority}, updated_at = now()
      WHERE id = ${id}
    `;
  },

  async updateDescription(id: string, description: string): Promise<void> {
    await db`
      UPDATE signals SET description = ${description}, updated_at = now()
      WHERE id = ${id}
    `;
  },

  /** 附加日誌到 description 末尾,不覆蓋原始內容。截斷至 500 字元。 */
  async appendToDescription(id: string, addition: string): Promise<void> {
    await db`
      UPDATE signals
      SET description = (
        SELECT CASE
          WHEN description IS NULL OR description = '' THEN ${addition}
          ELSE left(description || '\n' || ${addition}, 500)
        END
      ), updated_at = now()
      WHERE id = ${id}
    `;
  },

  async archive(id: string): Promise<void> {
    await db`
      UPDATE signals SET archived_at = now(), updated_at = now()
      WHERE id = ${id} AND archived_at IS NULL
    `;
  },

  async unarchive(id: string): Promise<void> {
    await db`
      UPDATE signals SET archived_at = NULL, updated_at = now()
      WHERE id = ${id}
    `;
  },

  async countByPriority(priority: SignalPriority): Promise<number> {
    const rows = await db`
      SELECT count(*)::int AS cnt
      FROM signals
      WHERE archived_at IS NULL AND priority = ${priority}
    `;
    return rows[0]?.cnt ?? 0;
  },

  async getItems(signalId: string): Promise<ItemRow[]> {
    const rows = await db`
      SELECT i.id, i.source_key, i.investor, i.signal_type, i.source_url,
             i.published_at, i.captured_at, i.content_hash, i.raw_content,
             i.payload, i.classified_at, i.classification_result
      FROM items i
      JOIN signal_items si ON si.item_id = i.id
      WHERE si.signal_id = ${signalId}
      ORDER BY i.published_at ASC
    `;
    return rows.map((r: Record<string, unknown>) => mapItemRow(r));
  },

  async getTimeline(signalId: string): Promise<ResearchRunRow[]> {
    const rows = await db`
      SELECT id, signal_id, model, prompt_version, thesis, ticker,
             direction, confidence, rationale, source_citations,
             candidate_markdown, published_path, created_at, status
      FROM research_runs
      WHERE signal_id = ${signalId}
      ORDER BY created_at ASC
    `;
    return rows.map((r: Record<string, unknown>) => mapResearchRunRow(r));
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
        id, research_run_id, signal_id, ticker, direction, confidence,
        entry_session_date, entry_price, entry_price_source, status
      ) VALUES (
        ${id},
        ${input.research_run_id},
        ${input.signal_id},
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
          id, research_run_id, signal_id, ticker, direction, confidence,
          entry_session_date, entry_price, entry_price_source, status
        ) VALUES (
          ${id},
          ${input.research_run_id},
          ${input.signal_id},
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
      SELECT id, research_run_id, signal_id, ticker, direction, confidence,
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
  ItemRecord,
  SignalRecord,
  ResearchRun,
  PaperBet,
  BetOutcome,
  listMarketSessions,
} as const;

export type LedgerDb = typeof LedgerDb;