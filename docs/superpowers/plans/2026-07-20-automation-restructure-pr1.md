# Automation 目錄重整（PR 1）實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `automation/scripts/` + `automation/scripts/phase4/` 兩層重整為 `automation/{commands,agents,tools,lib}/` 四層按職責分層，同步更新 11 個測試 + 7 個 DAG YAML 的 import 路徑，刪 2 個孤兒 .sh 檔，不改任何業務邏輯，154 個測試 baseline 必須完整通過。

**Architecture:** 純 move + import 修正。DAG step `run` 路徑從 `scripts/X.ts` 改為 `commands/X.ts`，拿掉 `export PATH="$HOME/.bun/bin:$PATH"`。`phase4/tools.ts` 拆成 6 檔（一 tool 一檔 + `toolkit.ts` factory + `index.ts` barrel）；`phase4/pi-research.ts` 併入 `buildPrompt` 後改名 `agents/research.ts`。

**Tech Stack:** TypeScript on Bun 1.3.14, Dagu 2.10.7

## Global Constraints

- 不改任何業務邏輯、型別簽名、測試斷言。純 move + import path 修正
- Bun 1.3.14 為權威 runtime；`bun test` + `bun run typecheck` 必須通過
- 154 個測試為 stable baseline，不能 drop
- 7 個 DAG YAML 必須 `dagu validate` 通過
- 拆檔時 export 符號必須完全對齊原本 `phase4/tools.ts` 的 exports
- `createResearchToolkit` 工具的 `recalled`/`retained` gate state 為 toolkit-local mutable state，不可外洩到 module level
- commit 訊息繁中，遵守 repo convention（看 git log）
- **不做**：Dockerfile 不動、compose.yml 不動、clone-publish.sh/git-askpass.sh/setup-vm.sh 不動（PR 2/3 處理）

## File Structure

PR 1 後的最終結構：

```
automation/
├── commands/
│   ├── ingest-events.ts
│   ├── research-next-event.ts
│   ├── open-next-paper-bet.ts
│   ├── settle-paper-bets.ts
│   ├── calibrate-signals.ts
│   ├── publish-next-research.ts
│   ├── publish-draft.ts
│   ├── materialize-research-candidate.ts
│   └── migrate-phase4.ts
├── agents/
│   └── research.ts
├── tools/
│   ├── read-event.ts
│   ├── recall-memory.ts
│   ├── retain-event-memory.ts
│   ├── lookup-adjusted-close.ts
│   ├── record-research.ts
│   ├── toolkit.ts
│   └── index.ts
├── lib/
│   ├── db.ts
│   ├── hindsight.ts
│   ├── twelve-data.ts
│   ├── x-client.ts
│   └── contracts.ts
├── dags/                      ← 7 個 YAML，路徑指向 commands/
├── config/
├── migrations/
└── tests/                     ← 11 個測試，import 路徑更新
```

被刪：
- `automation/scripts/clone-fixture.sh`（孤兒，無引用）
- `automation/scripts/verify-compose.sh`（孤兒，無引用）

被保留不動：
- `automation/scripts/clone-publish.sh`（PR 2 處理）
- `automation/scripts/git-askpass.sh`（PR 2 處理）
- `automation/scripts/setup-vm.sh`（PR 3 處理）

PR 1 完成後 `automation/scripts/` 仍存在但只剩 3 個 .sh，PR 2/3 繼續清。

---

## Task 1: 建立 tools/ 拆檔（最關鍵，風險最高）

把 `automation/scripts/phase4/tools.ts`（425 行、14.6KB）拆成 6 個檔 + barrel。這個 task 最關鍵，因為拆檔過程必須保留 `createResearchToolkit` 對 `recalled` / `retained` gate state 的 closure 存取。

**Files:**
- Create: `automation/tools/read-event.ts`
- Create: `automation/tools/recall-memory.ts`
- Create: `automation/tools/retain-event-memory.ts`
- Create: `automation/tools/lookup-adjusted-close.ts`
- Create: `automation/tools/record-research.ts`
- Create: `automation/tools/toolkit.ts`
- Create: `automation/tools/index.ts`
- Keep (暫時不刪): `automation/scripts/phase4/tools.ts` — Task 6 才刪

**Interfaces:**

每個 tool 檔匯出一個 factory function，回傳 `AgentTool<...>`。factory 簽名：
- `read-event.ts`: `createReadEventTool(ctx: ResearchToolContext): AgentTool<...>`
- `recall-memory.ts`: `createRecallMemoryTool(ctx: ResearchToolContext): AgentTool<...>` + 回傳 `{ tool, markRecalled }` 讓 toolkit factory 控制 gate
- `retain-event-memory.ts`: `createRetainEventMemoryTool(ctx: ResearchToolContext): AgentTool<...>` + 回傳 `{ tool, markRetained }` 同上
- `lookup-adjusted-close.ts`: `createLookupAdjustedCloseTool(ctx: ResearchToolContext): AgentTool<...>`
- `record-research.ts`: `createRecordResearchTool(ctx: ResearchToolContext, gate: { recalled: boolean, retained: boolean }): AgentTool<...>` — record_research 接收 gate 物件，執行後 reset flags

`toolkit.ts` 匯出：
- `createResearchToolkit(ctx: ResearchToolContext): ResearchToolkit` — 組合 5 個 tool factory
- `ResearchToolContext` interface（從原 tools.ts 搬）
- `ResearchToolkit` interface（從原 tools.ts 搬）
- `RecordResearchInput` / `RecordResearchDirection` / `ReadEventDetails` / `ResearchEventPayload` 類型
- type-narrowing helpers（`requireObject` / `requireString` / `requireNumber` / `requireStringArray` / `requireDirection`）：內部用，不 export
- `normalizeCandidateMarkdown` helper：內部用，不 export

`index.ts` barrel re-export：
```typescript
export {
  createResearchToolkit,
  type ResearchToolContext,
  type ResearchToolkit,
  type RecordResearchInput,
  type RecordResearchDirection,
  type ReadEventDetails,
  type ResearchEventPayload,
} from "./toolkit.ts";
export type { HindsightClient } from "../lib/hindsight.ts";
export type { TwelveDataClient } from "../lib/twelve-data.ts";
```

### Gate state 設計

原 `createResearchToolkit` 用 closure 內 `let recalled = false; let retained = false;`。拆檔後這個 state 用一個 mutable 物件傳給 `createRecordResearchTool`：

```typescript
// 在 toolkit.ts 的 createResearchToolkit 內
export function createResearchToolkit(ctx: ResearchToolContext): ResearchToolkit {
  // Per-context gate state — record_research 執行後 reset，確保同一 context
  // 後續 record_research 必須重新 roundtrip memory。
  const gate = { recalled: false, retained: false };
  // helper: createRecallMemoryTool 執行完寫 gate.recalled = true
  //         createRetainEventMemoryTool 執行完寫 gate.retained = true
  //         createRecordResearchTool 接收 gate, 執行前檢查, 成功後 reset

  const tools: AgentTool<any, any>[] = [
    createReadEventTool(ctx),
    createRecallMemoryTool(ctx, gate),
    createRetainEventMemoryTool(ctx, gate),
    createLookupAdjustedCloseTool(ctx),
    createRecordResearchTool(ctx, gate),
  ];
  return { tools, executionMode: "sequential" };
}
```

- [ ] **Step 1: 建立 `automation/tools/read-event.ts`**

```typescript
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
```

- [ ] **Step 2: 建立 `automation/tools/recall-memory.ts`**

```typescript
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
```

- [ ] **Step 3: 建立 `automation/tools/retain-event-memory.ts`**

```typescript
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
```

- [ ] **Step 4: 建立 `automation/tools/lookup-adjusted-close.ts`**

```typescript
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
```

- [ ] **Step 5: 建立 `automation/tools/record-research.ts`**

```typescript
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
```

- [ ] **Step 6: 建立 `automation/tools/toolkit.ts`**（factory + 共用 helpers + 類型）

```typescript
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
// External client re-exports (kept here for backwards import compatibility
// so callers importing from tools barrel see the same surfaces).
// ---------------------------------------------------------------------------

export type { HindsightClient } from "../lib/hindsight.ts";
export type { TwelveDataClient } from "../lib/twelve-data.ts";

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
```

- [ ] **Step 7: 建立 `automation/tools/index.ts` barrel**

```typescript
// automation/tools/index.ts
//
// Barrel re-export for the research toolkit. Callers import from
// here so the internal file split is invisible.

export {
  createResearchToolkit,
  type ResearchToolContext,
  type ResearchToolkit,
  type RecordResearchInput,
  type RecordResearchDirection,
  type ReadEventDetails,
  type ResearchEventPayload,
} from "./toolkit.ts";
export type { HindsightClient } from "../lib/hindsight.ts";
export type { TwelveDataClient } from "../lib/twelve-data.ts";
```

註：barrel 從 `../lib/hindsight.ts` re-export，所以這個 task 依賴 Task 2 先把 `hindsight.ts` 搬到位。實際執行時要去 Task 2 的 ../lib/ 路徑。

- [ ] **Step 8: 暫時不刪 `automation/scripts/phase4/tools.ts`，先驗證新檔能被其他 task 引用**

  Task 6 在所有 callers 改完後才刪舊檔，避免 import cycle 或遺漏。

- [ ] **Step 9: 跑 typecheck 驗證新檔案本身沒 type 錯誤**

  舊檔還在，typecheck 應該仍通過；新檔還沒被任何 caller import，但本身必須能被 Bun direct parse。

  ```
  cd automation && bun run typecheck
  ```
  Expected: PASS（跟 baseline 一致）

- [ ] **Step 10: Commit**

  ```bash
  git add automation/tools/
  git commit -m "refactor(tools): 拆 phase4/tools.ts 為 tools/{read-event,recall-memory,retain-event-memory,lookup-adjusted-close,record-research,toolkit,index}.ts

  一 tool 一檔, factory createResearchToolkit 組合 5 個 tool。
  recall/retain/record 透過共享 gate 物件傳遞 closure state,
  保留原可觀察行為 (record_research 執行後 reset flags)。
  helpers (requireObject/requireString/normalizeCandidateMarkdown)
  留在 toolkit.ts 內 export 給各 tool 檔使用。

  舊 phase4/tools.ts 暫時保留, Task 6 才刪。"
  ```

---

## Task 2: 搬 lib/ 與 agents/research.ts

把 `phase4/` 內 shared infra 5 檔搬到 `lib/`，`pi-research.ts` + `buildPrompt` 合併搬到 `agents/research.ts`。

**Files:**
- Create: `automation/lib/db.ts` ← `automation/scripts/phase4/db.ts`
- Create: `automation/lib/contracts.ts` ← `automation/scripts/phase4/contracts.ts`
- Create: `automation/lib/hindsight.ts` ← `automation/scripts/phase4/hindsight.ts`
- Create: `automation/lib/twelve-data.ts` ← `automation/scripts/phase4/twelve-data.ts`
- Create: `automation/lib/x-client.ts` ← `automation/scripts/phase4/x-client.ts`
- Create: `automation/agents/research.ts` ← `automation/scripts/phase4/pi-research.ts` + `buildPrompt`（從 `scripts/research-next-event.ts:176-223` 抽出併入）
- Keep (暫時不刪): `automation/scripts/phase4/*.ts` 原 7 檔（Task 6 才刪）

**Interfaces:**

這個 task 不改變任何 export 符號。`lib/db.ts` 必須 export 跟原本 `phase4/db.ts` 完全相同的符號（`db` / `closeDb` / `applyMigration` / `LedgerDb` 等）。

搬運過程：
1. `git mv automation/scripts/phase4/db.ts automation/lib/db.ts`（保留 git history）
2. 編輯 `automation/lib/db.ts`，把內部 import `./contracts.ts` 改為同目錄（仍是 `./contracts.ts`，因為 contracts 也搬到 lib/ 了；不過 db.ts import 別的 phase4 檔的路徑要改，例如如果 import hinge `./hindsight.ts` 仍是同層 `./hindsight.ts`）。**關鍵**：檢查每個搬遷檔的 internal imports 是否需要改路徑
3. 同方式搬其他 4 個 lib 檔
4. `pi-research.ts` 改名 `research.ts` 搬到 `agents/`，同時：
   - 內部 import `./tools.ts` 改為 `../tools/index.ts`（barrel）
   - 內部 import `./hindsight.ts` / `./twelve-data.ts` 改為 `../lib/hindsight.ts` / `../lib/twelve-data.ts`
   - 從 `scripts/research-next-event.ts` 抽出 `buildPrompt(event: SignalEventRow): string` 函式（line 176-223）+ 其用到的 imports，併入 `agents/research.ts`
5. 從 `scripts/research-next-event.ts` 刪除 `buildPrompt` 函式定義，改成 `import { buildPrompt } from "../agents/research.ts"`

**`SignalEventRow` 等 type 的 cross-file 依賴**：`buildPrompt` 接收 `SignalEventRow`，這個 type 來自 `lib/db.ts`。`agents/research.ts` 必須 import `type SignalEventRow` from `../lib/db.ts`。

- [ ] **Step 1: 用 `git mv` 搬 5 個 lib 檔**

  ```bash
  mkdir -p automation/lib automation/agents
  git mv automation/scripts/phase4/db.ts automation/lib/db.ts
  git mv automation/scripts/phase4/contracts.ts automation/lib/contracts.ts
  git mv automation/scripts/phase4/hindsight.ts automation/lib/hindsight.ts
  git mv automation/scripts/phase4/twelve-data.ts automation/lib/twelve-data.ts
  git mv automation/scripts/phase4/x-client.ts automation/lib/x-client.ts
  ```

- [ ] **Step 2: 修正每個 lib 檔的 internal import 路徑**

  原本 5 個 lib 檔在 `phase4/` 同層，互相 import 用 `./X.ts`。搬完仍在同層 `lib/`，所以 lib 檔之間的 import 路徑不變。

  **但要檢查**：每個 lib 檔是否 import 過其他東西（例如 `contracts.ts` → 別的）。讀每個檔 head 30 行確認 import sources。

  執行：
  ```bash
  cd automation && head -30 lib/db.ts lib/contracts.ts lib/hindsight.ts lib/twelve-data.ts lib/x-client.ts
  ```
  Expected: lib 檔之間互相 import 用 `./X.ts`，無需改動（同層搬遷）。

- [ ] **Step 3: 用 `git mv` 搬 `pi-research.ts` 到 `agents/research.ts`**

  ```bash
  git mv automation/scripts/phase4/pi-research.ts automation/agents/research.ts
  ```

- [ ] **Step 4: 修正 `automation/agents/research.ts` 的 internal import**

  讀檔頭，原本 import `./tools.ts` / `./hindsight.ts` / `./twelve-data.ts` 都在 `phase4/` 同層。搬到 `agents/` 後：

  原 import:
  ```typescript
  import { createResearchToolkit, ... } from "./tools.ts";
  import type { HindsightClient } from "./hindsight.ts";
  import type { TwelveDataClient } from "./twelve-data.ts";
  ```

  改為:
  ```typescript
  import { createResearchToolkit, ... } from "../tools/index.ts";
  import type { HindsightClient } from "../lib/hindsight.ts";
  import type { TwelveDataClient } from "../lib/twelve-data.ts";
  ```

  Edit tool 修正每個 import line。

- [ ] **Step 5: 從 `scripts/research-next-event.ts` 抽出 `buildPrompt` 併入 `agents/research.ts`**

  讀 `automation/scripts/research-next-event.ts:176-223`（`buildPrompt` 函式 + 它用到的 imports / helpers）。

  從 `scripts/research-next-event.ts` 刪除：
  - `buildPrompt` 函式定義（line 176-223）
  - 若有 `buildPrompt` 專用的 helper / import（例如某個只在 buildPrompt 用的常數），一併抽出

  把函式貼到 `automation/agents/research.ts` tail（在 `assertRunPersisted` 之後），並：
  - 加 `import type { SignalEventRow } from "../lib/db.ts";`（如果 research.ts 還沒 import）
  - 在 `agents/research.ts` export `buildPrompt`

  從 `scripts/research-next-event.ts`（即將搬到 `commands/research-next-event.ts`，但 Task 3 才搬）刪除 `buildPrompt` 定義後，加：
  ```typescript
  import { buildPrompt } from "../agents/research.ts";
  ```
  找原本 `buildPrompt` 在 `main()` 內的呼叫點，確認仍能找到。

  **重要**：Task 3 還沒搬 `research-next-event.ts`，所以這個 step 先在 `scripts/research-next-event.ts` 改 import，Task 3 搬完後路徑不變（`../agents/research.ts` 從 `automation/scripts/` 看是 `../agents/research.ts`，搬到 `automation/commands/` 後仍是 `../agents/research.ts`，路徑剛好不變）。

  Wait — 檢查路徑：`automation/scripts/research-next-event.ts` import `../agents/research.ts` 是 `automation/agents/research.ts`，正確。搬到 `automation/commands/research-next-event.ts` 後 import `../agents/research.ts` 是 `automation/agents/research.ts`，仍正確。**路徑剛好不變**。

- [ ] **Step 6: 跑 typecheck**

  ```
  cd automation && bun run typecheck
  ```
  Expected: 可能會 fail，因為舊 `phase4/` 目錄內還剩 `pi-research.ts` 沒了（已搬走），但 callers 還沒更新路徑。**預期失敗**，記下錯誤訊息供 Task 3-5 修正。

- [ ] **Step 7: Commit**

  ```bash
  git add -A automation/lib automation/agents automation/scripts
  git commit -m "refactor(lib,agents): 搬 phase4 lib 到 lib/, pi-research 改 research.ts 並併入 buildPrompt

  - db / contracts / hindsight / twelve-data / x-client 搬到 lib/,
    同層互相 import 路徑不變
  - pi-research.ts 改名 research.ts 搬到 agents/, import 改為
    ../tools/ 跟 ../lib/
  - 從 scripts/research-next-event.ts 抽 buildPrompt 併入
    agents/research.ts, command 改 import (路徑剛好不變)

  舊 phase4/*.ts 7 檔暫時保留, Task 6 才刪。typecheck 預期
  fail (callers 還沒改), 後續 task 修正。"
  ```

---

## Task 3: 搬 9 個 *.ts CLI 到 commands/

把 `automation/scripts/*.ts`（9 個 CLI 入口）搬到 `automation/commands/`，修正 import 路徑。

**Files:**
- Move: `automation/scripts/ingest-events.ts` → `automation/commands/ingest-events.ts`
- Move: `automation/scripts/research-next-event.ts` → `automation/commands/research-next-event.ts`
- Move: `automation/scripts/open-next-paper-bet.ts` → `automation/commands/open-next-paper-bet.ts`
- Move: `automation/scripts/settle-paper-bets.ts` → `automation/commands/settle-paper-bets.ts`
- Move: `automation/scripts/calibrate-signals.ts` → `automation/commands/calibrate-signals.ts`
- Move: `automation/scripts/publish-next-research.ts` → `automation/commands/publish-next-research.ts`
- Move: `automation/scripts/publish-draft.ts` → `automation/commands/publish-draft.ts`
- Move: `automation/scripts/materialize-research-candidate.ts` → `automation/commands/materialize-research-candidate.ts`
- Move: `automation/scripts/migrate-phase4.ts` → `automation/commands/migrate-phase4.ts`

**Interfaces:**

9 個 CLI 從 `automation/scripts/` 搬到 `automation/commands/`，import 路徑：
- `./phase4/X.ts` → `../lib/X.ts`
- `./phase4/tools.ts` → `../tools/index.ts`（或者 `../tools/toolkit.ts`）
- `./phase4/pi-research.ts` → `../agents/research.ts`
- `./X.ts` (其他 CLI 之間互引) → `./X.ts`（同層，不變；例如 `settle-paper-bets.ts` import `./open-next-paper-bet.ts`，搬到 commands/ 後還是同層）

每個 CLI 對應的 import 修改：

| CLI 檔 | 舊 import | 新 import |
|---|---|---|
| `ingest-events.ts` | `./phase4/x-client.ts` + `./phase4/db.ts` | `../lib/x-client.ts` + `../lib/db.ts` |
| `open-next-paper-bet.ts` | `./phase4/db.ts` + `./phase4/contracts.ts` + `./phase4/twelve-data.ts` | `../lib/db.ts` + `../lib/contracts.ts` + `../lib/twelve-data.ts` |
| `settle-paper-bets.ts` | `./phase4/db.ts` + `./phase4/twelve-data.ts` + `./open-next-paper-bet.ts` | `../lib/db.ts` + `../lib/twelve-data.ts` + `./open-next-paper-bet.ts`（內部同層不變） |
| `calibrate-signals.ts` | `./phase4/db.ts` | `../lib/db.ts` |
| `publish-next-research.ts` | `./phase4/db.ts` | `../lib/db.ts` |
| `publish-draft.ts` | （無 phase4 依賴，純 gray-matter） | 不變 |
| `materialize-research-candidate.ts` | `./phase4/db.ts` | `../lib/db.ts` |
| `migrate-phase4.ts` | `./phase4/db.ts` | `../lib/db.ts` |
| `research-next-event.ts` | `./phase4/pi-research.ts` + `./phase4/hindsight.ts` + `./phase4/twelve-data.ts` + `./phase4/db.ts` + `./phase4/tools.ts` | `../agents/research.ts` + `../lib/hindsight.ts` + `../lib/twelve-data.ts` + `../lib/db.ts` + `../tools/index.ts` |

- [ ] **Step 1: 用 `git mv` 搬 9 個 CLI 檔**

  ```bash
  mkdir -p automation/commands
  for f in ingest-events research-next-event open-next-paper-bet settle-paper-bets calibrate-signals publish-next-research publish-draft materialize-research-candidate migrate-phase4; do
    git mv "automation/scripts/${f}.ts" "automation/commands/${f}.ts"
  done
  ```

- [ ] **Step 2: 在每個 CLI 檔內修正 import 路徑**

  按上表對每個檔做 Edit。每個 CLI 檔讀 head 找 import 區塊，逐一行替換。

- [ ] **Step 3: 從 `scripts/research-next-event.ts` 刪 `buildPrompt` 函式定義**

  Task 2 Step 5 已經把 `buildPrompt` 抽走，但原檔內可能還有殘留 `function buildPrompt(...) { ... }`。確認已刪除。

  如果 Task 2 已執行完成，`buildPrompt` 函式定義應該已不在 `scripts/research-next-event.ts`；現在搬完 `research-next-event.ts` 它的進口要有 `import { buildPrompt } from "../agents/research.ts";`。

- [ ] **Step 4: 跑 typecheck**

  ```
  cd automation && bun run typecheck
  ```
  Expected: 應該大幅好轉。剩下測試檔 import 還沒改（Task 4），可能還有 fail。

- [ ] **Step 5: Commit**

  ```bash
  git add -A automation/commands
  git commit -m "refactor(commands): 搬 9 個 *.ts CLI 到 commands/, 修正 import 路徑

  - ./phase4/X.ts → ../lib/X.ts
  - ./phase4/tools.ts → ../tools/index.ts
  - ./phase4/pi-research.ts → ../agents/research.ts
  - CLI 之間互引 (./X.ts) 同層搬遷, 路徑不變

  9 個檔: ingest-events / research-next-event / open-next-paper-bet /
  settle-paper-bets / calibrate-signals / publish-next-research /
  publish-draft / materialize-research-candidate / migrate-phase4"
  ```

---

## Task 4: 更新 11 個測試 import 路徑

**Files:**
- Modify: `automation/tests/phase4-bets.test.ts`
- Modify: `automation/tests/phase4-calibration.test.ts`
- Modify: `automation/tests/phase4-contracts.test.ts`
- Modify: `automation/tests/phase4-db-regressions.test.ts`
- Modify: `automation/tests/phase4-hindsight.test.ts`
- Modify: `automation/tests/phase4-pi-research.test.ts`
- Modify: `automation/tests/phase4-publication.test.ts`
- Modify: `automation/tests/phase4-tools.test.ts`
- Modify: `automation/tests/phase4-twelve-data.test.ts`
- Modify: `automation/tests/phase4-x-client.test.ts`
- Modify: `automation/tests/publish-draft.test.ts`

**Interfaces:**

每個測試檔的 import 路徑改：

| 測試檔 | 舊 import | 新 import |
|---|---|---|
| `phase4-bets.test.ts` | `../scripts/phase4/db.ts` | `../lib/db.ts` |
| `phase4-bets.test.ts` | `../scripts/open-next-paper-bet.ts` | `../commands/open-next-paper-bet.ts` |
| `phase4-calibration.test.ts` | `../scripts/calibrate-signals.ts` | `../commands/calibrate-signals.ts` |
| `phase4-contracts.test.ts` | `../scripts/phase4/contracts.ts` | `../lib/contracts.ts` |
| `phase4-db-regressions.test.ts` | `../scripts/phase4/db.ts` | `../lib/db.ts` |
| `phase4-hindsight.test.ts` | `../scripts/phase4/hindsight.ts` | `../lib/hindsight.ts` |
| `phase4-pi-research.test.ts` | `../scripts/phase4/pi-research.ts` | `../agents/research.ts` |
| `phase4-publication.test.ts` | `../scripts/publish-draft.ts` | `../commands/publish-draft.ts` |
| `phase4-tools.test.ts` | `../scripts/phase4/tools.ts` | `../tools/index.ts` |
| `phase4-twelve-data.test.ts` | `../scripts/phase4/twelve-data.ts` | `../lib/twelve-data.ts` |
| `phase4-x-client.test.ts` | `../scripts/phase4/x-client.ts` | `../lib/x-client.ts` |
| `publish-draft.test.ts` | `../scripts/publish-draft.ts` | `../commands/publish-draft.ts` |
| `phase4-contracts.test.ts` | `../scripts/open-next-paper-bet.ts` (如有) | `../commands/open-next-paper-bet.ts` |
| 等 |（每個檔讀 import 區塊 individually 確認） | |

- [ ] **Step 1: 對每個測試檔，用 Edit tool 替換 import 路徑**

  對每個檔：
  1. 讀檔頭 30 行找 import 區塊
  2. 找到 `from "../scripts/phase4/X.ts"` 或 `from "../scripts/X.ts"`
  3. 替換為 `from "../lib/X.ts"` / `from "../commands/X.ts"` / `from "../tools/index.ts"` / `from "../agents/research.ts"`

- [ ] **Step 2: 跑 typecheck**

  ```
  cd automation && bun run typecheck
  ```
  Expected: PASS（所有 import 路徑都改完，新檔結構完整）

- [ ] **Step 3: 跑完整測試**

  ```
  cd automation && bun test
  ```
  Expected: 154 tests pass（baseline）

  **重要**：如果有測試 fail，先檢查是否為 import path 遺漏，而不是測試本身的 bug。Task 1-3 的拆檔必須不動任何業務邏輯；如果有測試 fail 表示拆檔抽換出錯（例如 gate state 不對、helper 未 export）。

- [ ] **Step 4: Commit**

  ```bash
  git add automation/tests
  git commit -m "refactor(tests): 更新 11 個測試的 import 路徑

  - ../scripts/phase4/* → ../lib/*
  - ../scripts/phase4/tools.ts → ../tools/index.ts
  - ../scripts/phase4/pi-research.ts → ../agents/research.ts
  - ../scripts/X.ts (CLI) → ../commands/X.ts

  154 tests pass, typecheck pass。"
  ```

---

## Task 5: 更新 7 個 DAG YAML 路徑

**Files:**
- Modify: `automation/dags/ingest-events.yaml`
- Modify: `automation/dags/research-next-event.yaml`
- Modify: `automation/dags/open-next-paper-bet.yaml`
- Modify: `automation/dags/settle-paper-bets.yaml`
- Modify: `automation/dags/calibrate-signals.yaml`
- Modify: `automation/dags/publish-next-research.yaml`
- Modify: `automation/dags/blog-publish.yaml`

**Interfaces:**

每個 DAG 內兩處改：

1. `run:` 區塊內 `bun run scripts/X.ts` → `bun run commands/X.ts`
2. 拿掉 `export PATH="$HOME/.bun/bin:$PATH"` 這行（bun 是 image 內 /usr/local/bin/bun，已在 default PATH）

特例：
- `blog-publish.yaml` 有多處 `/opt/alpha-lab/automation/scripts/X.ts` → `/opt/alpha-lab/automation/commands/X.ts`（保留絕對路徑，因為 blog-publish 子 DAG 用絕對路徑）
- `blog-publish.yaml` 的 `bash /opt/alpha-lab/automation/scripts/clone-publish.sh` **不動**（PR 2 才處理）
- `blog-publish.yaml` 的 `clone-publish.sh` 內 `GIT_ASKPASS=/opt/alpha-lab/automation/scripts/git-askpass.sh` **不動**（PR 2 才處理）

- [ ] **Step 1: 對每個 DAG YAML，用 Edit tool 替換路徑**

  對每個檔做三項替換：
  1. `bun run scripts/X.ts` → `bun run commands/X.ts`
  2. `bun /opt/alpha-lab/automation/scripts/X.ts` → `bun /opt/alpha-lab/automation/commands/X.ts`（絕對路徑的情況，主要是 blog-publish.yaml + publish-next-research.yaml）
  3. 移除 `export PATH="$HOME/.bun/bin:$PATH"` 行

  以 `ingest-events.yaml` 為例：
  ```yaml
  # before
  run: |
    set -euo pipefail
    export PATH="$HOME/.bun/bin:$PATH"
    bun run scripts/ingest-events.ts

  # after
  run: |
    set -euo pipefail
    bun run commands/ingest-events.ts
  ```

- [ ] **Step 2: `dagu validate` 每個 DAG**

  ```
  for f in automation/dags/*.yaml; do
    dagu validate "$f"
  done
  ```
  Expected: 7 個都 `OK`

  註：`dagu validate` 命令在本地需要 dagu binary。若無，可 `docker run --rm -v $(pwd)/automation/dags:/dags ghcr.io/dagucloud/dagu:2.10.7 validate /dags/ingest-events.yaml` 驗證 schema。

- [ ] **Step 3: Commit**

  ```bash
  git add automation/dags
  git commit -m "refactor(dags): 路徑 scripts/X.ts → commands/X.ts, 移除 export PATH

  - 9 個 step run: bun run scripts/X.ts → bun run commands/X.ts
  - 拿掉 export PATH=\"\\$HOME/.bun/bin:\\$PATH\"
    (bun 後續在 image base 走 /usr/local/bin/bun, 已在 default PATH)
  - blog-publish.yaml 的 clone-publish.sh / git-askpass.sh 路徑
    不動, PR 2 處理

  dagu validate 7 個 DAG 全通過。"
  ```

---

## Task 6: 刪除舊檔 + 清掉 phase4/ 子目錄

**Files:**
- Delete: `automation/scripts/phase4/tools.ts`（Task 1 完成後已無引用）
- Delete: `automation/scripts/phase4/db.ts`、`contracts.ts`、`hindsight.ts`、`twelve-data.ts`、`x-client.ts`、`pi-research.ts`（Task 2-4 完成後已無引用）
- Delete: `automation/scripts/phase4/` 目錄本身（空目錄）
- Delete: `automation/scripts/clone-fixture.sh`（孤兒，無引用）
- Delete: `automation/scripts/verify-compose.sh`（孤兒，無引用）
- Keep: `automation/scripts/clone-publish.sh`、`automation/scripts/git-askpass.sh`、`automation/scripts/setup-vm.sh`（PR 2/3 才處理）

**Interfaces:**

刪除前必須 100% 確認沒有任何 caller 還在 import 舊路徑。

- [ ] **Step 1: 用 grep 確認舊路徑已無引用**

  ```bash
  cd automation
  grep -rn "scripts/phase4" --include="*.ts" --include="*.yaml" --include="*.yml" --include="*.md" .
  grep -rn "phase4/" --include="*.ts" tests/ commands/ agents/ tools/ lib/ 2>/dev/null
  ```
  Expected: 無輸出（所有引用都已改為新路徑）

  如果有殘留引用，回頭修該檔。

- [ ] **Step 2: 刪除 7 個舊 phase4 檔 + 目錄**

  ```bash
  rm automation/scripts/phase4/tools.ts
  rm automation/scripts/phase4/db.ts
  rm automation/scripts/phase4/contracts.ts
  rm automation/scripts/phase4/hindsight.ts
  rm automation/scripts/phase4/twelve-data.ts
  rm automation/scripts/phase4/x-client.ts
  rm automation/scripts/phase4/pi-research.ts
  rmdir automation/scripts/phase4  # 應該是空目錄
  ```

  注意：用 `rm` 而不是 `git rm`，因為這些檔案有可能是 git 透過 mv 搬走後就視為已刪。檢查 `git status` 確認狀態。

  採 repo convention「不被 git 保護的檔案用 mv 替代 rm，放到 .delete/[相對路徑]」？此規則針對「不被 git 保護的檔案」；這些檔案已被 git tracked，刪除時走 `git rm` 安全。但 user preference 說明「如果包含在歷史中，這是安全的」——這些檔案都在 git history 內，git rm 安全。

  實際用 `git rm`：
  ```bash
  git rm automation/scripts/phase4/tools.ts
  # ... 其他 6 個
  ```

- [ ] **Step 3: 刪除 2 個孤兒 .sh**

  ```bash
  git rm automation/scripts/clone-fixture.sh
  git rm automation/scripts/verify-compose.sh
  ```

- [ ] **Step 4: 跑 typecheck + 完整測試**

  ```
  cd automation && bun run typecheck
  cd automation && bun test
  ```
  Expected: typecheck PASS、154 tests pass

- [ ] **Step 5: Commit**

  ```bash
  git add -A
  git commit -m "refactor(phase4): 刪除舊 phase4/ 目錄 + 孤兒 shell

  - 刪 7 個舊檔: tools / db / contracts / hindsight / twelve-data /
    x-client / pi-research (已搬到 lib/ tools/ agents/)
  - 刪 automation/scripts/phase4/ 空目錄
  - 刪 2 個孤兒 .sh: clone-fixture.sh (fixture DAG 已退役) /
    verify-compose.sh (ops/deploy-dagu.sh 已不存在)

  scripts/ 剩 3 個 .sh: clone-publish.sh / git-askpass.sh /
  setup-vm.sh (PR 2/3 處理)。

  typecheck + 154 tests pass。"
  ```

---

## Task 7: 整體驗證 + PR 準備

- [ ] **Step 1: 跑完整 PR gate 驗證**

  ```bash
  cd automation && bun run typecheck
  cd automation && bun test
  for f in automation/dags/*.yaml; do dagu validate "$f"; done
  ```

  Expected:
  - `bun run typecheck` PASS
  - `bun test` 154 tests pass
  - 7 個 DAG validate OK

- [ ] **Step 2: 確認最終目錄結構**

  ```bash
  tree automation -I node_modules -L 2
  ```
  Expected: 看到 `commands/` `agents/` `tools/` `lib/` `dags/` `config/` `migrations/` `tests/`，`scripts/` 只剩 3 個 .sh

  ```bash
  ls automation/scripts/
  ```
  Expected:
  ```
  clone-publish.sh  git-askpass.sh  setup-vm.sh
  ```

- [ ] **Step 3: 確認沒有殘留舊路徑引用**

  ```bash
  cd automation
  grep -rn "scripts/phase4\|phase4/" --include="*.ts" --include="*.yaml" --include="*.yml" .
  grep -rn "scripts/[a-z-]\+\.ts" --include="*.yaml" --include="*.yml" dags/
  ```
  Expected: 無輸出

- [ ] **Step 4: 建立 PR**

  ```bash
  git checkout -b refactor/automation-layout-pr1
  git push -u origin refactor/automation-layout-pr1
  gh pr create \
    --base main \
    --head refactor/automation-layout-pr1 \
    --title "refactor: automation 目錄重整 (PR 1/3)" \
    --body "..."
  ```

  PR body 應包含：
  - 變更摘要：4 層職責分層 + 7 個舊檔刪除 + 11 測試 + 7 DAG 路徑同步
  - 驗證清單：typecheck / 154 tests / dagu validate
  - 不做的事：Dockerfile 不動、compose.yml 不動、setup-vm.sh 不動（指向 PR 2/3）
  - 設計文件引用：`docs/superpowers/specs/2026-07-20-automation-restructure-design.md`

- [ ] **Step 5: 等 CI + Kilo/CodeRabbit review**

  按 `AGENTS.md` PR gate：CI build + `bun run typecheck` + `bun test` + Kilo Code Review (`@kilo-code-bot`) + CodeRabbit。`python skill://github-pr-master/wait.py --pr <N>` 等 CI + Kilo。

  處理 review comments，確認 mergeState `CLEAN`、0 unresolved threads 後 squash-merge。

## Self-Review

### Spec coverage

| Spec 區段 | Task |
|---|---|
| 目錄結構 `automation/{commands,agents,tools,lib}/` | Task 1-3 |
| `scripts/` 目錄退場（PR 1 部分：刪 4 個，剩 3 個 .sh） | Task 6 |
| `phase4/tools.ts` 拆 6 檔 + barrel | Task 1 |
| `phase4/pi-research.ts` → `agents/research.ts` | Task 2 |
| `buildPrompt` 併入 `agents/research.ts` | Task 2 |
| 11 個測試 import 路徑更新 | Task 4 |
| 7 個 DAG YAML `scripts/X.ts` → `commands/X.ts` + 拿掉 `export PATH` | Task 5 |
| 刪 `clone-fixture.sh` + `verify-compose.sh` | Task 6 |
| 154 tests baseline | Task 4, Task 7 |
| `dagu validate` 7 DAG | Task 5, Task 7 |

### Placeholder scan

無 placeholder。每個 step 都有實際的 import 路徑、commit message、驗證指令。

### Type consistency

- `ResearchToolContext` interface `event: ResearchEventPayload` — 在 `toolkit.ts` 定義，`read-event.ts` / `recall-memory.ts` 等 import
- `gate: { recalled: boolean; retained: boolean }` — 在 `toolkit.ts` factory 內建立，傳給 3 個 tool factory，所有地方用同一形狀
- `buildPrompt(event: SignalEventRow): string` — `SignalEventRow` 來自 `lib/db.ts`，`agents/research.ts` import

### 風險點

1. **Task 1 拆檔的 `gate` 物件傳遞**：原本是 closure `let` 變數，現在改為共享物件。語意一致（mutable state 同 context 內共享），但必須確認測試沒有仰賴 closure 內部細節。`phase4-tools.test.ts` 所有 stub 都是 inject dependency，不會直接戳 gate，所以安全。

2. **Task 2 buildPrompt 抽出**：`buildPrompt` 用到哪些 helper / imports 必須完整搬到 `agents/research.ts`。實作時讀 `scripts/research-next-event.ts:176-223` 完整範圍（含 line 36-50 imports 中與 buildPrompt 相關的）。

3. **Task 5 DAG `working_dir` 不變**：DAG YAML `working_dir: /opt/alpha-lab/automation` 在 image 內仍然正確（image bake 後這個路徑就是 `WORKDIR`）。只有 `run` 路徑內的相對路徑要改。

4. **Task 6 `git rm` vs `rm`**：user preference 規則「不被 git 保護的檔案用 mv 替代 rm 放到 .delete/」。`automation/scripts/phase4/*.ts` 是 git tracked，刪除走 `git rm` 安全。
