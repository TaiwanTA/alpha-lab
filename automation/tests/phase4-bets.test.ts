import { describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  calculateReturn,
  chooseEntrySession,
  openPaperBet,
  settleOpenBets,
  type OpeningDependencies,
  type SettlementDependencies,
} from "../commands/open-next-paper-bet.ts";
import type { PaperBetRow } from "../lib/db.ts";

const HERE = dirname(new URL(import.meta.url).pathname);
const MIGRATION = readFileSync(
  join(HERE, "..", "migrations", "001_phase4_event_ledger.sql"),
  "utf8",
);

function sessions(count: number, first = "2026-01-02") {
  const start = new Date(`${first}T12:00:00Z`);
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    return {
      date: date.toISOString().slice(0, 10),
      adjustedClose: 100 + index,
    };
  });
}

describe("paper-bet calculations", () => {
  test("calculates signed long and short returns", () => {
    expect(calculateReturn("long", 100, 110)).toBeCloseTo(0.1);
    expect(calculateReturn("short", 100, 110)).toBeCloseTo(-0.1);
  });

  test("uses the event-day New York session at or before 16:00", () => {
    const returned = sessions(2, "2026-07-15");
    expect(
      chooseEntrySession(new Date("2026-07-15T19:59:59Z"), returned),
    ).toEqual(returned[0]);
  });

  test("uses the next returned session after New York 16:00", () => {
    const returned = sessions(2, "2026-07-15");
    expect(
      chooseEntrySession(new Date("2026-07-15T20:00:01Z"), returned),
    ).toEqual(returned[1]);
  });
});

describe("paper-bet opening", () => {
  test("opens one qualifying accepted run from returned adjusted-close sessions", async () => {
    const inserted: unknown[] = [];
    const released: string[] = [];
    const deps: OpeningDependencies = {
      claimNextQualifying: async () => ({
        id: "run-1",
        signal_id: "signal-1",
        ticker: "abc",
        direction: "long",
        confidence: 0.8,
        source_citations: ["https://example.com/source"],
        published_at: new Date("2026-07-15T19:00:00Z"),
      }),
      fetchSessions: async () => sessions(2, "2026-07-15"),
      insertBetAndAcceptRun: async (input) => {
        inserted.push(input);
        return "bet-1";
      },
      releaseToAccepted: async (id) => { released.push(id); },
    };

    const result = await openPaperBet(deps);

    expect(result).toEqual({ action: "opened", researchRunId: "run-1", paperBetId: "bet-1" });
    expect(inserted).toEqual([
      {
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "long",
        confidence: 0.8,
        entry_session_date: "2026-07-15",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
      },
    ]);
    expect(released).toEqual([]);
  });

  test("releases the claim when no required returned session exists", async () => {
    const released: string[] = [];
    const deps: OpeningDependencies = {
      claimNextQualifying: async () => ({
        id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "short",
        confidence: 0.6,
        source_citations: ["https://example.com/source"],
        published_at: new Date("2026-07-15T21:00:00Z"),
      }),
      fetchSessions: async () => sessions(1, "2026-07-15"),
      insertBetAndAcceptRun: async () => "unexpected",
      releaseToAccepted: async (id) => { released.push(id); },
    };

    await expect(openPaperBet(deps)).rejects.toThrow(/returned session/i);
    expect(released).toEqual(["run-1"]);
  });

  test("database constraints reject duplicate research run and event/ticker bets", () => {
    expect(MIGRATION).toMatch(/research_run_id uuid NOT NULL UNIQUE/);
    expect(MIGRATION).toMatch(/UNIQUE \(event_id, ticker\)/);
  });

  test("opening claim is owner-scoped, lease-recoverable, and consumed with the bet", () => {
    const worker = readFileSync(join(HERE, "..", "commands", "open-next-paper-bet.ts"), "utf8");
    const dbSource = readFileSync(join(HERE, "..", "lib", "db.ts"), "utf8");
    expect(MIGRATION).toMatch(/paper_bet_opening_claims[\s\S]*?claim_owner text NOT NULL/);
    expect(worker).toMatch(/claimed_at < now\(\) - interval '30 minutes'/);
    expect(worker).toMatch(/WHERE research_run_id = \$\{id\} AND claim_owner = \$\{owner\}/);
    expect(dbSource).toMatch(/insertAndAcceptRun[\s\S]*?claim_owner = \$\{owner\}[\s\S]*?DELETE FROM paper_bet_opening_claims/);
  });
});

describe("paper-bet settlement", () => {
  test("does not write an outcome before 30 returned sessions", async () => {
    const writes: unknown[] = [];
    const deps: SettlementDependencies = {
      listOpen: async () => [{
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "long",
        confidence: 0.8,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      }],
      fetchSessions: async () => sessions(29),
      settle: async (input) => writes.push(input),
      markUnresolved: async (input) => writes.push(input),
    };

    const result = await settleOpenBets(deps);
    expect(result).toEqual({ examined: 1, settled: 0, alreadySettled: 0, unresolved: 0, pending: 1 });
    expect(writes).toEqual([]);
  });

  test("settles on exactly the 30th returned session", async () => {
    const writes: unknown[] = [];
    const deps: SettlementDependencies = {
      listOpen: async () => [{
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "short",
        confidence: 0.8,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      }],
      fetchSessions: async () => sessions(30),
      settle: async (input) => writes.push(input),
      markUnresolved: async (input) => writes.push(input),
    };

    const result = await settleOpenBets(deps);
    expect(result.settled).toBe(1);
    expect(writes).toEqual([{ paperBetId: "bet-1", exitPrice: 129, exitPriceSource: "twelve-data:1day:adjust=all", returnPct: -0.29, outcome: "loss" }]);
  });

  test("persists unresolved only for terminal unavailable-price errors", async () => {
    const writes: unknown[] = [];
    const deps: SettlementDependencies = {
      listOpen: async () => [{
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "DELISTED",
        direction: "long",
        confidence: 0.5,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      }],
      fetchSessions: async () => {
        throw new Error("terminal unavailable price: symbol is permanently delisted");
      },
      settle: async (input) => writes.push(input),
      markUnresolved: async (input) => writes.push(input),
    };

    const result = await settleOpenBets(deps);
    expect(result.unresolved).toBe(1);
    expect(writes).toEqual([{ paperBetId: "bet-1", reason: "terminal unavailable price: symbol is permanently delisted" }]);
  });

  test("propagates transient provider errors without fabricating an outcome", async () => {
    const writes: unknown[] = [];
    const deps: SettlementDependencies = {
      listOpen: async () => [{
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "long",
        confidence: 0.5,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      }],
      fetchSessions: async () => {
        throw new Error("twelve-data failed: 503 Service Unavailable");
      },
      settle: async (input) => writes.push(input),
      markUnresolved: async (input) => writes.push(input),
    };

    await expect(settleOpenBets(deps)).rejects.toThrow(/503/);
    expect(writes).toEqual([]);
  });

  test("treats a Postgres unique_violation as alreadySettled and continues the batch", async () => {
    // Race: listOpen returns N 'open' rows; a sibling worker lands first
    // on one of them. The losing settle call hits 23505 on
    // bet_outcomes.paper_bet_id UNIQUE. The loop must count it as
    // alreadySettled and keep going — throwing would strand every
    // later bet in 'open' for the next settlement run.
    const bets = [
      {
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "long",
        confidence: 0.8,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      },
      {
        id: "bet-2",
        research_run_id: "run-2",
        signal_id: "signal-2",
        ticker: "XYZ",
        entry_session_date: "2026-01-02",
        confidence: 0.7,
        opened_at: new Date(),
        entry_price: 50,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      },
    ];
    const writes: unknown[] = [];
    const race = new SQL.PostgresError("duplicate key value violates unique constraint", {
      code: "23505",
      constraint: "bet_outcomes_paper_bet_id_key",
    });
    let settleCalls = 0;
    const deps: SettlementDependencies = {
      listOpen: async () => bets as PaperBetRow[],
      fetchSessions: async () => sessions(30),
      settle: async (input) => {
        settleCalls += 1;
        if (settleCalls === 1) throw race;
        writes.push(input);
      },
      markUnresolved: async (input) => writes.push(input),
    };

    const result = await settleOpenBets(deps);
    expect(result).toEqual({
      examined: 2,
      settled: 1,
      alreadySettled: 1,
      unresolved: 0,
      pending: 0,
    });
    // The second bet was attempted after the race was swallowed — it
    // must have reached settle. If the loop had aborted on the
    // unique_violation, writes would be empty.
    expect(writes).toHaveLength(1);
  });

  test("propagates non-23505 settle errors without counting them", async () => {
    // Any DB error that is NOT the unique_violation must still throw,
    // otherwise a real failure (FK violation, NOT NULL, network drop)
    // would be silently swallowed and the bet would stay 'open'.
    const other = new SQL.PostgresError("foreign key violation", {
      code: "23503",
      constraint: "bet_outcomes_paper_bet_id_fkey",
    });
    const deps: SettlementDependencies = {
      listOpen: async () => [{
        id: "bet-1",
        research_run_id: "run-1",
        signal_id: "signal-1",
        ticker: "ABC",
        direction: "long",
        confidence: 0.8,
        opened_at: new Date(),
        entry_session_date: "2026-01-02",
        entry_price: 100,
        entry_price_source: "twelve-data:1day:adjust=all",
        status: "open",
      }],
      fetchSessions: async () => sessions(30),
      settle: async () => { throw other; },
      markUnresolved: async () => {},
    };
    await expect(settleOpenBets(deps)).rejects.toBe(other);
  });
});
