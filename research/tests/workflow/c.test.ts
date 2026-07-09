// C workflow test:
//   workflow/c.ts::cWorkflow(signalId) 對一個 signal 跑 research。
//   本測試驗證 manifest 包含 cWorkflow + researchStep。

import { test, expect, describe } from "bun:test";
import { cWorkflow } from "../../workflow/c.ts";
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

describe("C workflow (workflow/c.ts)", () => {
  test("cWorkflow accepts signalId argument and has workflowId", () => {
    expect(typeof cWorkflow).toBe("function");
    const wf = cWorkflow as unknown as { workflowId?: string };
    expect(wf.workflowId).toBeDefined();
    expect(wf.workflowId).toContain("cWorkflow");
  });

  test("SDK manifest contains cWorkflow + researchStep", () => {
    const wfEntry = manifest.workflows["workflow/c.ts"]!["cWorkflow"]!;
    expect(wfEntry.workflowId).toBe("workflow//./workflow/c//cWorkflow");
    const step = manifest.steps["workflow/c.ts"]!["researchStep"]!;
    expect(step.stepId).toBe("step//./workflow/c//researchStep");
  });
});
