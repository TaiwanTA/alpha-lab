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
