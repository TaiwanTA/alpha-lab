// automation/tools/toolkit.ts
//
// Toolkit factory + shared types + type-narrowing helpers for the
// Phase 4 research runner toolkit.
//
// Five tools are exposed (one per file in tools/), nothing else:
//   read_event            — return the claimed event's raw payload
//   recall_memory         — Hindsight recall (`alpha-lab` bank)
//   retain_event_memory   — Hindsight retain (`alpha-lab` bank)
//   lookup_adjusted_close — Twelve Data adjusted close
//   record_research       — sink: persist one `research_runs` row
//
// The toolkit runs tools sequentially and refuses to call
// record_research until both recall_memory and retain_event_memory
// have run at least once during the same research run. This guards
// the contract that every persisted research row was preceded by a
// memory roundtrip.

import type {
  AgentTool,
  ToolExecutionMode,
} from "@earendil-works/pi-agent-core";

import type { HindsightClient } from "../lib/hindsight.ts";
import type { TwelveDataClient } from "../lib/twelve-data.ts";

import { createReadEventTool } from "./read-event.ts";
import { createRecallMemoryTool } from "./recall-memory.ts";
import { createRetainEventMemoryTool } from "./retain-event-memory.ts";
import { createLookupAdjustedCloseTool } from "./lookup-adjusted-close.ts";
import { createRecordResearchTool } from "./record-research.ts";

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
  ticker: string | null;
  direction: RecordResearchDirection | null;
  confidence: number;
  rationale: string;
  sourceCitations: string[];
  candidateMarkdown: string | null;
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
// Type-narrowing helpers — `AgentTool.execute` receives `params: unknown`
// per the pi-agent-core contract, so each tool narrows its own input.
// ---------------------------------------------------------------------------

export function requireObject(value: unknown, toolName: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${toolName}: params must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
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

export function requireNumber(
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

export function requireStringArray(
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

export function requireDirection(
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
// Candidate normalization keeps the persisted markdown compatible with the
// publisher's strict frontmatter and source-section contract.
// ---------------------------------------------------------------------------

export function normalizeCandidateMarkdown(
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
// Toolkit factory
// ---------------------------------------------------------------------------

export function createResearchToolkit(ctx: ResearchToolContext): ResearchToolkit {
  // Per-context gate: a fresh toolkit cannot call record_research
  // until both memory tools have been invoked. Each successful
  // recall / retain flips its flag; record_research clears the
  // flags after a successful sink write so a follow-up research
  // round in the same context (rare, but possible) must roundtrip
  // through memory again before it can record again.
  const gate = { recalled: false, retained: false };

  const tools: AgentTool<any, any>[] = [
    createReadEventTool(ctx),
    createRecallMemoryTool(ctx, gate),
    createRetainEventMemoryTool(ctx, gate),
    createLookupAdjustedCloseTool(ctx),
    createRecordResearchTool(ctx, gate),
  ];

  return {
    tools,
    executionMode: "sequential",
  };
}
