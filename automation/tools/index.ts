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
