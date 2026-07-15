#!/usr/bin/env bun

import { SQL } from "bun";
import { LedgerDb, type PaperBetRow, type ResearchRunRow } from "./phase4/db.ts";
import { qualifiesForBet, type MarketSession, type ResearchDirection } from "./phase4/contracts.ts";
import {
  fetchAdjustedCloseSessions,
  loadTwelveDataConfig,
  type AdjustedCloseSession,
} from "./phase4/twelve-data.ts";

export const PRICE_SOURCE = "twelve-data:1day:adjust=all";

export type ClaimedQualifyingRun = Pick<
  ResearchRunRow,
  "id" | "event_id" | "ticker" | "direction" | "confidence" | "source_citations"
> & { published_at: Date };

export type PaperBetInsert = Omit<PaperBetRow, "id" | "opened_at" | "status">;

export interface OpeningDependencies {
  claimNextQualifying(owner: string): Promise<ClaimedQualifyingRun | null>;
  fetchSessions(ticker: string, startDate: string): Promise<MarketSession[]>;
  insertBetAndAcceptRun(input: PaperBetInsert, owner: string): Promise<string>;
  releaseToAccepted(id: string, owner: string): Promise<void>;
  owner?: string;
}

export interface SettlementDependencies {
  listOpen(): Promise<PaperBetRow[]>;
  fetchSessions(ticker: string, startDate: string): Promise<MarketSession[]>;
  settle(input: {
    paperBetId: string;
    exitPrice: number;
    exitPriceSource: string;
    returnPct: number;
    outcome: "win" | "loss";
  }): Promise<unknown>;
  markUnresolved(input: { paperBetId: string; reason: string }): Promise<unknown>;
}

export function calculateReturn(
  direction: ResearchDirection,
  entryPrice: number,
  exitPrice: number,
): number {
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
    throw new Error("entry price must be finite and positive");
  }
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) {
    throw new Error("exit price must be finite and positive");
  }
  const raw = (exitPrice - entryPrice) / entryPrice;
  return direction === "long" ? raw : -raw;
}

function newYorkDateAndSecond(instant: Date): { date: string; second: number } {
  if (!Number.isFinite(instant.getTime())) throw new Error("event timestamp is invalid");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    second: Number(values.hour) * 3600 + Number(values.minute) * 60 + Number(values.second),
  };
}

export function chooseEntrySession(
  publishedAt: Date,
  returnedSessions: MarketSession[],
): MarketSession | null {
  const event = newYorkDateAndSecond(publishedAt);
  const sorted = [...returnedSessions].sort((left, right) => left.date.localeCompare(right.date));
  const eventDayIndex = sorted.findIndex((session) => session.date >= event.date);
  if (eventDayIndex < 0) return null;
  const first = sorted[eventDayIndex];
  if (first?.date !== event.date || event.second <= 16 * 3600) return first ?? null;
  return sorted[eventDayIndex + 1] ?? null;
}

export async function openPaperBet(
  deps: OpeningDependencies,
): Promise<
  | { action: "none" }
  | { action: "opened"; researchRunId: string; paperBetId: string }
> {
  const owner = deps.owner ?? crypto.randomUUID();
  const run = await deps.claimNextQualifying(owner);
  if (!run) return { action: "none" };
  try {
    if (!qualifiesForBet({
      status: "accepted",
      ticker: run.ticker,
      direction: run.direction ?? undefined,
      confidence: run.confidence ?? Number.NaN,
      sourceCitations: run.source_citations,
    })) {
      throw new Error(`research run ${run.id} does not qualify for a paper bet`);
    }
    const ticker = run.ticker!.trim().toUpperCase();
    const direction = run.direction!;
    const confidence = run.confidence!;
    const eventDate = newYorkDateAndSecond(run.published_at).date;
    const sessions = await deps.fetchSessions(ticker, eventDate);
    const entry = chooseEntrySession(run.published_at, sessions);
    if (!entry) throw new Error(`no required returned session for ${ticker}`);
    const paperBetId = await deps.insertBetAndAcceptRun({
      research_run_id: run.id,
      event_id: run.event_id,
      ticker,
      direction,
      confidence,
      entry_session_date: entry.date,
      entry_price: entry.adjustedClose,
      entry_price_source: PRICE_SOURCE,
    }, owner);
    return { action: "opened", researchRunId: run.id, paperBetId };
  } catch (error) {
    await deps.releaseToAccepted(run.id, owner);
    throw error;
  }
}

export function isTerminalUnavailablePrice(error: unknown): boolean {
  return error instanceof Error && /^terminal unavailable price:/i.test(error.message);
}

export async function settleOpenBets(deps: SettlementDependencies): Promise<{
  examined: number;
  settled: number;
  alreadySettled: number;
  unresolved: number;
  pending: number;
}> {
  const bets = await deps.listOpen();
  let settled = 0;
  let alreadySettled = 0;
  let unresolved = 0;
  let pending = 0;
  for (const bet of bets) {
    let sessions: MarketSession[];
    try {
      sessions = await deps.fetchSessions(bet.ticker, bet.entry_session_date);
    } catch (error) {
      if (!isTerminalUnavailablePrice(error)) throw error;
      await deps.markUnresolved({ paperBetId: bet.id, reason: (error as Error).message });
      unresolved += 1;
      continue;
    }
    const exit = sessions
      .filter((session) => session.date >= bet.entry_session_date)
      .sort((left, right) => left.date.localeCompare(right.date))[29];
    if (!exit) {
      pending += 1;
      continue;
    }
    const returnPct = calculateReturn(bet.direction, bet.entry_price, exit.adjustedClose);
    try {
      await deps.settle({
        paperBetId: bet.id,
        exitPrice: exit.adjustedClose,
        exitPriceSource: PRICE_SOURCE,
        returnPct,
        outcome: returnPct > 0 ? "win" : "loss",
      });
      settled += 1;
    } catch (error) {
      // 23505 (unique_violation) on bet_outcomes.paper_bet_id means a
      // sibling worker raced this loop and persisted an outcome first.
      // listOpen() returns status='open' rows; a concurrent settler can
      // flip that to 'settled' between read and write. Treat the duplicate
      // outcome as "already settled" and continue — counting it would
      // mask the race, throwing would abort the whole batch and strand
      // every later bet in 'open'.
      if (error instanceof SQL.PostgresError && error.code === "23505") {
        alreadySettled += 1;
        continue;
      }
      throw error;
    }
  }
  return { examined: bets.length, settled, alreadySettled, unresolved, pending };
}

async function claimNextQualifying(owner: string): Promise<ClaimedQualifyingRun | null> {
  const rows = await LedgerDb.db`
    WITH recoverable_target AS (
      SELECT candidate.research_run_id
      FROM paper_bet_opening_claims candidate
      WHERE candidate.claimed_at < now() - interval '30 minutes'
      ORDER BY candidate.claimed_at ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    ), recoverable AS (
      UPDATE paper_bet_opening_claims claim
      SET claim_owner = ${owner}, claimed_at = now()
      FROM recoverable_target
      WHERE claim.research_run_id = recoverable_target.research_run_id
      RETURNING claim.research_run_id
    ), next_run AS (
      SELECT rr.id
      FROM research_runs rr
      WHERE rr.status = 'accepted'
        AND rr.ticker IS NOT NULL
        AND rr.direction IN ('long','short')
        AND rr.confidence IS NOT NULL
        AND jsonb_array_length(rr.source_citations) > 0
        AND NOT EXISTS (SELECT 1 FROM paper_bets pb WHERE pb.research_run_id = rr.id)
        AND NOT EXISTS (SELECT 1 FROM paper_bet_opening_claims claim WHERE claim.research_run_id = rr.id)
        AND NOT EXISTS (SELECT 1 FROM recoverable)
      ORDER BY rr.created_at ASC
      FOR UPDATE OF rr SKIP LOCKED
      LIMIT 1
    ), inserted_claim AS (
      INSERT INTO paper_bet_opening_claims (research_run_id, claim_owner)
      SELECT id, ${owner} FROM next_run
      ON CONFLICT (research_run_id) DO NOTHING
      RETURNING research_run_id
    ), claimed AS (
      SELECT research_run_id FROM recoverable
      UNION ALL
      SELECT research_run_id FROM inserted_claim
    )
    SELECT rr.id, rr.event_id, rr.ticker, rr.direction,
           rr.confidence::text AS confidence, rr.source_citations,
           se.published_at
    FROM research_runs rr
    JOIN claimed claim ON claim.research_run_id = rr.id
    JOIN signal_events se ON se.id = rr.event_id
    LIMIT 1
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: row.id as string,
    event_id: row.event_id as string,
    ticker: row.ticker as string,
    direction: row.direction as ResearchDirection,
    confidence: Number(row.confidence),
    source_citations: row.source_citations as string[],
    published_at: row.published_at as Date,
  };
}

async function releaseOpeningClaim(id: string, owner: string): Promise<void> {
  await LedgerDb.db`
    DELETE FROM paper_bet_opening_claims
    WHERE research_run_id = ${id} AND claim_owner = ${owner}
  `;
}
async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const marketConfig = loadTwelveDataConfig();
  const result = await openPaperBet({
    claimNextQualifying,
    fetchSessions: (ticker, startDate) => fetchAdjustedCloseSessions(marketConfig, ticker, startDate),
    insertBetAndAcceptRun: (input, owner) => LedgerDb.PaperBet.insertAndAcceptRun(input, owner),
    releaseToAccepted: releaseOpeningClaim,
  });
  console.log(JSON.stringify(result));
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => LedgerDb.closeDb());
}

export type { AdjustedCloseSession };
