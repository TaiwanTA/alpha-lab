// D workflow test:
//   workflow/d.ts::dWorkflow(type) type ∈ "pre" | "post"。
//   本測試驗證 manifest 包含 dWorkflow + generateReportStep。

import { test, expect, describe } from "bun:test";
import { dWorkflow } from "../../workflow/d.ts";
import workflowManifest from "../../.well-known/workflow/v1/workflow-manifest.json" with { type: "json" };

interface WorkflowDef {
  workflowId: string;
}
interface StepDef {
  stepId: string;
}
interface Manifest {
  workflows: Record<string, Record<string, WorkflowDef>>;
  steps: Record<string, Record<string, StepDef>>;
}

const manifest = workflowManifest as Manifest;

describe("D workflow (workflow/d.ts)", () => {
  test("dWorkflow is callable with type argument and has workflowId", () => {
    expect(typeof dWorkflow).toBe("function");
    const wf = dWorkflow as unknown as { workflowId?: string };
    expect(wf.workflowId).toBeDefined();
    expect(wf.workflowId).toContain("dWorkflow");
  });

  test("SDK manifest contains dWorkflow + generateReportStep", () => {
    const wfEntry = manifest.workflows["workflow/d.ts"]!["dWorkflow"]!;
    expect(wfEntry.workflowId).toBe("workflow//./workflow/d//dWorkflow");
    const step = manifest.steps["workflow/d.ts"]!["generateReportStep"]!;
    expect(step.stepId).toBe("step//./workflow/d//generateReportStep");
  });
});
