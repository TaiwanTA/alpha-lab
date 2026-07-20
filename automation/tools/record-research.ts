// automation/tools/record-research.ts
//
// record_research tool — Persist one research_runs row for the current
// event. Requires recall_memory and retain_event_memory to have run
// first in this toolkit (gate).

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type {
  RecordResearchInput,
  ResearchToolContext,
} from "./toolkit.ts";
import {
  normalizeCandidateMarkdown,
  requireDirection,
  requireNumber,
  requireObject,
  requireString,
  requireStringArray,
} from "./toolkit.ts";

const RecordResearchParameters = Type.Object({
  thesis: Type.String({ minLength: 1 }),
  ticker: Type.String({ minLength: 1 }),
  direction: Type.Union([Type.Literal("long"), Type.Literal("short")]),
  confidence: Type.Number(),
  rationale: Type.String({ minLength: 1 }),
  sourceCitations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  candidateMarkdown: Type.String({ minLength: 1 }),
});

export function createRecordResearchTool(
  ctx: ResearchToolContext,
  gate: { recalled: boolean; retained: boolean },
): AgentTool<typeof RecordResearchParameters, { id: string }> {
  return {
    name: "record_research",
    label: "Record research",
    description:
      "Persist one research_runs row for the current event. Requires recall_memory and retain_event_memory to have run first in this toolkit.",
    parameters: RecordResearchParameters,
    async execute(
      _toolCallId,
      params: unknown,
    ): Promise<AgentToolResult<{ id: string }>> {
      if (!gate.recalled || !gate.retained) {
        throw new Error(
          "recall_memory and retain_event_memory are required before record_research",
        );
      }
      const obj = requireObject(params, "record_research");
      const thesis = requireString(obj, "thesis", "record_research");
      const ticker = requireString(obj, "ticker", "record_research");
      if (!/^[A-Z0-9.\-]{1,16}$/.test(ticker)) {
        throw new Error(
          `record_research: ticker must match /^[A-Z0-9.\\-]{1,16}$/ (uppercase letters, digits, dot, dash)`,
        );
      }
      const direction = requireDirection(obj, "direction", "record_research");
      const confidence = requireNumber(obj, "confidence", "record_research");
      if (!Number.isFinite(confidence)) {
        throw new Error(
          `record_research: confidence must be a finite number, got ${String(confidence)}`,
        );
      }
      if (confidence < 0 || confidence > 1) {
        throw new Error(
          `record_research: confidence must be within [0, 1], got ${confidence}`,
        );
      }
      const rationale = requireString(obj, "rationale", "record_research");
      const sourceCitations = requireStringArray(
        obj,
        "sourceCitations",
        "record_research",
      );
      if (sourceCitations.length === 0) {
        throw new Error(
          "record_research: sourceCitations must contain at least one URL",
        );
      }
      for (const citation of sourceCitations) {
        if (!/^https?:\/\//.test(citation)) {
          throw new Error(
            `record_research: sourceCitations must use http:// or https:// scheme, got ${citation}`,
          );
        }
      }
      const candidateMarkdown = normalizeCandidateMarkdown(
        requireString(obj, "candidateMarkdown", "record_research"),
        sourceCitations[0]!,
      );
      const input: RecordResearchInput = {
        eventId: ctx.eventId,
        thesis,
        ticker,
        direction,
        confidence,
        rationale,
        sourceCitations,
        candidateMarkdown,
      };
      const result = await ctx.recordResearch(input);
      // Reset gates so any subsequent record_research call within
      // the same context must roundtrip through memory again.
      gate.recalled = false;
      gate.retained = false;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
