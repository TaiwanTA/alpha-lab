// automation/scripts/phase4/tools.ts
//
// Allowlisted agent toolkit for the Phase 4 research runner.
//
// Exactly five tools are exposed — nothing else:
//
//   read_event            — return the claimed event's raw payload
//   recall_memory         — Hindsight recall (`alpha-lab` bank)
//   retain_event_memory   — Hindsight retain (`alpha-lab` bank)
//   lookup_adjusted_close — Twelve Data adjusted close
//   record_research       — sink: persist one `research_runs` row
//
// The toolkit itself runs tools sequentially and refuses to call
// `record_research` until both `recall_memory` and
// `retain_event_memory` have run at least once during the same
// research run. This guards the contract that every persisted
// research row was preceded by a memory roundtrip.

import { Type } from "typebox";

import type {
  AgentTool,
  AgentToolResult,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";

import type { HindsightClient } from "./hindsight.ts";
import type { TwelveDataClient } from "./twelve-data.ts";

// ---------------------------------------------------------------------------
// Candidate normalization keeps the persisted markdown compatible with the
// publisher's strict frontmatter and source-section contract.
// ---------------------------------------------------------------------------

function normalizeCandidateMarkdown(
  markdown: string,
  sourceUrl: string,
): string {
  const opening = markdown.match(/^---\r?\n/);
  if (!opening) return markdown;
  const closingOffset = markdown.indexOf("\n---", opening[0].length);
  if (closingOffset < 0) return markdown;
  const frontmatter = markdown.slice(0, closingOffset);
  const normalizedFrontmatter = frontmatter.replace(
    /^investmentClaim:\s*(['"])(true|false)\1\s*$/m,
    "investmentClaim: $2",
  );
  let normalized = `${normalizedFrontmatter}${markdown.slice(closingOffset)}`;
  const bodyStart = normalized.indexOf("\n", closingOffset + 1) + 1;
  const body = normalized.slice(bodyStart);
  const heading = body.match(/^##\s*來源\s*$/m);
  if (!heading) {
    normalized = `${normalized.trimEnd()}\n\n## 來源\n\n- ${sourceUrl}\n`;
  } else {
    const headingOffset = body.indexOf(heading[0]);
    const afterHeading = body.slice(headingOffset + heading[0].length);
    if (!/^\s*[-*]\s+https?:\/\//m.test(afterHeading)) {
      const insertAt = bodyStart + headingOffset + heading[0].length;
      normalized = `${normalized.slice(0, insertAt)}\n\n- ${sourceUrl}${normalized.slice(insertAt)}`;
    }
  }
  return normalized;
}


// ---------------------------------------------------------------------------
// External surfaces — Hindsight and Twelve Data are injected so the
// focused tests can substitute stubs without touching the network.
// ---------------------------------------------------------------------------

export type { HindsightClient } from "./hindsight.ts";
export type { TwelveDataClient } from "./twelve-data.ts";

// ---------------------------------------------------------------------------
// Event payload the read_event tool returns. Matches the columns of
// `signal_events` minus the bookkeeping fields.
// ---------------------------------------------------------------------------

export interface ResearchEventPayload {
  id: string;
  investor: string;
  sourceUrl: string;
  rawContent: string;
  publishedAt: Date;
  capturedAt: Date;
}

// ---------------------------------------------------------------------------
// Tool input contracts
// ---------------------------------------------------------------------------

export type RecordResearchDirection = "long" | "short";

export interface RecordResearchInput {
  eventId: string;
  thesis: string;
  ticker: string;
  direction: RecordResearchDirection;
  confidence: number;
  rationale: string;
  sourceCitations: string[];
  candidateMarkdown: string;
}

export interface ReadEventDetails {
  id: string;
  investor: string;
  sourceUrl: string;
  rawContent: string;
}

// ---------------------------------------------------------------------------
// Context — all dependencies the toolkit needs are passed in.
// ---------------------------------------------------------------------------

export interface ResearchToolContext {
  eventId: string;
  /** The full event payload. Required by `read_event`; the runtime
   *  always attaches it before the toolkit is constructed. */
  event: ResearchEventPayload;
  hindsight: HindsightClient;
  twelveData: TwelveDataClient;
  recordResearch: (input: RecordResearchInput) => Promise<{ id: string }>;
}

// ---------------------------------------------------------------------------
// Result types — strict, no `unknown`.
// ---------------------------------------------------------------------------

export interface ResearchToolkit {
  tools: AgentTool<any, any>[];
  executionMode: ToolExecutionMode;
}

// ---------------------------------------------------------------------------
// Tool schemas (TypeBox).
// ---------------------------------------------------------------------------

const ReadEventParameters = Type.Object({});

const RecallMemoryParameters = Type.Object({
  query: Type.String({ minLength: 1 }),
});

const RetainEventMemoryParameters = Type.Object({
  content: Type.String({ minLength: 1 }),
  context: Type.String({ minLength: 1 }),
});

const LookupAdjustedCloseParameters = Type.Object({
  ticker: Type.String({ minLength: 1 }),
  date: Type.String({ minLength: 1, pattern: "^\\d{4}-\\d{2}-\\d{2}$" }),
});

const RecordResearchParameters = Type.Object({
  thesis: Type.String({ minLength: 1 }),
  ticker: Type.String({ minLength: 1 }),
  direction: Type.Union([Type.Literal("long"), Type.Literal("short")]),
  confidence: Type.Number(),
  rationale: Type.String({ minLength: 1 }),
  sourceCitations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  candidateMarkdown: Type.String({ minLength: 1 }),
});

// ---------------------------------------------------------------------------
// Type-narrowing helpers — `AgentTool.execute` receives `params: unknown`
// per the pi-agent-core contract, so each tool narrows its own input.
// ---------------------------------------------------------------------------

function requireObject(value: unknown, toolName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${toolName}: params must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  toolName: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${toolName}: ${key} must be a non-empty string`);
  }
  return v;
}

function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  toolName: string,
): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`${toolName}: ${key} must be a finite number`);
  }
  return v;
}

function requireStringArray(
  obj: Record<string, unknown>,
  key: string,
  toolName: string,
): string[] {
  const v = obj[key];
  if (!Array.isArray(v)) {
    throw new Error(`${toolName}: ${key} must be an array of strings`);
  }
  for (const item of v) {
    if (typeof item !== "string" || item.length === 0) {
      throw new Error(`${toolName}: ${key}[] must contain non-empty strings`);
    }
  }
  return v as string[];
}

function requireDirection(
  obj: Record<string, unknown>,
  key: string,
  toolName: string,
): RecordResearchDirection {
  const v = obj[key];
  if (v !== "long" && v !== "short") {
    throw new Error(`${toolName}: ${key} must be 'long' or 'short'`);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Toolkit factory
// ---------------------------------------------------------------------------

export function createResearchToolkit(ctx: ResearchToolContext): ResearchToolkit {
  // Per-context gate: a fresh toolkit cannot call record_research
  // until both memory tools have been invoked. Each successful
  // recall / retain flips its flag; record_research clears the
  // flags after a successful sink write so a follow-up research
  // round in the same context (rare, but possible) must roundtrip
  // through memory again before it can record again.
  let recalled = false;
  let retained = false;

  const tools: AgentTool<any, any>[] = [
    {
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
    },
    {
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
        recalled = true;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    {
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
        retained = true;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
    {
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
    },
    {
      name: "record_research",
      label: "Record research",
      description:
        "Persist one research_runs row for the current event. Requires recall_memory and retain_event_memory to have run first in this toolkit.",
      parameters: RecordResearchParameters,
      async execute(
        _toolCallId,
        params: unknown,
      ): Promise<AgentToolResult<{ id: string }>> {
        if (!recalled || !retained) {
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
        recalled = false;
        retained = false;
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      },
    },
  ];

  return {
    tools,
    executionMode: "sequential",
  };
}
