// automation/tools/retain-event-memory.ts
//
// retain_event_memory tool — Persist the current event's distilled
// observation to the alpha-lab Hindsight bank.
//
// markRetained() flips the toolkit gate flag only on a successful
// Hindsight retain call.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ResearchToolContext } from "./toolkit.ts";
import { requireObject, requireString } from "./toolkit.ts";

const RetainEventMemoryParameters = Type.Object({
  content: Type.String({ minLength: 1 }),
  context: Type.String({ minLength: 1 }),
});

export function createRetainEventMemoryTool(
  ctx: ResearchToolContext,
  gate: { recalled: boolean; retained: boolean },
): AgentTool<typeof RetainEventMemoryParameters, unknown> {
  return {
    name: "retain_event_memory",
    label: "Retain event memory",
    description:
      "Persist the current event's distilled observation to the alpha-lab Hindsight bank.",
    parameters: RetainEventMemoryParameters,
    async execute(
      _toolCallId,
      params: unknown,
    ): Promise<AgentToolResult<unknown>> {
      const obj = requireObject(params, "retain_event_memory");
      const content = requireString(obj, "content", "retain_event_memory");
      const context = requireString(obj, "context", "retain_event_memory");
      const result = await ctx.hindsight.retain(content, context);
      gate.retained = true;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}
