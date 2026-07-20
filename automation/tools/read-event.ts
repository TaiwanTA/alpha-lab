// automation/tools/read-event.ts
//
// read_event tool — return the claimed event's raw payload.
//
// Exposes the signal_event currently being researched (id, investor,
// source URL, content) to the agent so it has the context needed to
// start the research loop.

import { Type } from "typebox";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";

import type { ReadEventDetails, ResearchToolContext } from "./toolkit.ts";
import { requireObject } from "./toolkit.ts";

const ReadEventParameters = Type.Object({});

export function createReadEventTool(
  ctx: ResearchToolContext,
): AgentTool<typeof ReadEventParameters, ReadEventDetails> {
  return {
    name: "read_event",
    label: "Read event",
    description:
      "Return the raw payload (id, investor, source URL, content) of the signal_event currently being researched.",
    parameters: ReadEventParameters,
    async execute(
      _toolCallId,
      params: unknown,
    ): Promise<AgentToolResult<ReadEventDetails>> {
      requireObject(params, "read_event");
      const event = ctx.event;
      const details: ReadEventDetails = {
        id: event.id,
        investor: event.investor,
        sourceUrl: event.sourceUrl,
        rawContent: event.rawContent,
      };
      return {
        content: [{ type: "text", text: JSON.stringify(details) }],
        details,
      };
    },
  };
}
