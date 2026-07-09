// B workflow test:
//   workflow/b.ts::bWorkflow() orchestrate discoverStep() + triggerCForNewSignals(),
//   對每個新 signal 自動 trigger cWorkflow(SDK 要求 start() 必須包在 step function 內)。
//   本測試驗證:
//     1. bWorkflow function 有 .workflowId
//     2. SDK manifest 認得 bWorkflow + discoverStep + triggerCForNewSignals
//
// 不在測試內 run real bWorkflow()(那需要 LLM + Hindsight 服務),純驗 build 階段。

import { test, expect, describe } from "bun:test";
import { bWorkflow } from "../../workflow/b.ts";
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

describe("B workflow (workflow/b.ts)", () => {
  test("bWorkflow function exists with workflowId", () => {
    expect(typeof bWorkflow).toBe("function");
    const wf = bWorkflow as unknown as { workflowId?: string };
    expect(wf.workflowId).toBeDefined();
    expect(wf.workflowId).toContain("bWorkflow");
  });

  test("SDK manifest contains bWorkflow + 2 steps (discover, triggerC)", () => {
    const wfEntry = manifest.workflows["workflow/b.ts"]!["bWorkflow"]!;
    expect(wfEntry.workflowId).toBe("workflow//./workflow/b//bWorkflow");
    // 兩個 step 都建好(discoverStep 主邏輯 + triggerCForNewSignals 給 C 觸發)
    const steps = manifest.steps["workflow/b.ts"]!;
    expect(steps["discoverStep"]!.stepId).toBe("step//./workflow/b//discoverStep");
    expect(steps["triggerCForNewSignals"]!.stepId).toBe(
      "step//./workflow/b//triggerCForNewSignals",
    );
  });
});
