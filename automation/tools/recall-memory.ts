// automation/tools/recall-memory.ts
//
// recall_memory tool — Recall prior observations from the alpha-lab
// Hindsight bank for the given query.
//
// The toolkit gate requires this tool to have run at least once before
// record_research may persist — markRecalled() flips the gate flag
// only on a successful Hindsight roundtrip.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ResearchToolContext } from "./toolkit.ts";
import { requireObject, requireString } from "./toolkit.ts";

const RecallMemoryParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
});

export function createRecallMemoryTool(
  ctx: ResearchToolContext,
  gate: { recalled: boolean; retained: boolean },
): AgentTool<typeof RecallMemoryParameters, unknown> {
  return {
    name: "recall_memory",
    label: "Recall memory",
    description:
      "Recall prior observations from the alpha-lab Hindsight bank for the given query.",
    parameters: RecallMemoryParameters,
    async execute(
      _toolCallId,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      const obj = requireObject(params, "recall_memory");
      const query = requireString(obj, "query", "recall_memory");
      const result = await ctx.hindsight.recall(query);
      gate.recalled = true;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
