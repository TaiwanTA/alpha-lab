// automation/tools/lookup-adjusted-close.ts
//
// lookup_adjusted_close tool — Fetch the daily, split- and dividend-
// adjusted close for a ticker at or before the given date from Twelve Data.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ResearchToolContext } from "./toolkit.ts";
import { requireObject, requireString } from "./toolkit.ts";

const LookupAdjustedCloseParameters = Type.Object({
  ticker: Type.String({ minLength: 1 }),
  date: Type.String({ minLength: 1, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});

export function createLookupAdjustedCloseTool(
  ctx: ResearchToolContext,
): AgentTool<typeof LookupAdjustedCloseParameters, unknown> {
  return {
    name: "lookup_adjusted_close",
    label: "Lookup adjusted close",
    description:
      "Fetch the daily, split- and dividend-adjusted close for a ticker at or before the given date from Twelve Data.",
    parameters: LookupAdjustedCloseParameters,
    async execute(
      _toolCallId,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      const obj = requireObject(params, "lookup_adjusted_close");
      const ticker = requireString(obj, "ticker", "lookup_adjusted_close");
      if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker)) {
        throw new Error(
          `lookup_adjusted_close: ticker must match /^[A-Z0-9.\\-]{1,16}$/ (uppercase letters, digits, dot, dash)`,
        );
      }
      const date = requireString(obj, "date", "lookup_adjusted_close");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(
          `lookup_adjusted_close: date must be in YYYY-MM-DD format`,
        );
      }
      const result = await ctx.twelveData.fetchAdjustedClose(ticker, date);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
