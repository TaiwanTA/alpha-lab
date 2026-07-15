#!/usr/bin/env bun

import { LedgerDb } from "./phase4/db.ts";
import {
  fetchAdjustedCloseSessions,
  loadTwelveDataConfig,
} from "./phase4/twelve-data.ts";
import {
  PRICE_SOURCE,
  settleOpenBets,
  type SettlementDependencies,
} from "./open-next-paper-bet.ts";

export { calculateReturn, isTerminalUnavailablePrice, settleOpenBets } from "./open-next-paper-bet.ts";
export type { SettlementDependencies } from "./open-next-paper-bet.ts";

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL?.trim()) throw new Error("DATABASE_URL is required");
  const marketConfig = loadTwelveDataConfig();
  const deps: SettlementDependencies = {
    listOpen: () => LedgerDb.PaperBet.listOpen(),
    fetchSessions: (ticker, startDate) => fetchAdjustedCloseSessions(marketConfig, ticker, startDate),
    settle: ({ paperBetId, exitPrice, exitPriceSource, returnPct, outcome }) =>
      LedgerDb.PaperBet.settle(paperBetId, {
        exit_price: exitPrice,
        exit_price_source: exitPriceSource,
        return_pct: returnPct,
        outcome,
        reason: null,
      }),
    markUnresolved: ({ paperBetId, reason }) =>
      LedgerDb.PaperBet.settle(paperBetId, {
        exit_price: null,
        exit_price_source: null,
        return_pct: null,
        outcome: "unresolved",
        reason,
      }),
  };
  const result = await settleOpenBets(deps);
  console.log(JSON.stringify({ ...result, priceSource: PRICE_SOURCE }));
}

if (import.meta.main) {
  main()
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(async () => LedgerDb.closeDb());
}
