// A workflow test:
//   workflow/a.ts::aWorkflow() 為 use workflow directive,被 SDK 認出
//   workflowId + workflowId 在 SDK runtime 可用來 start()。
//   本測試用 DI 驗證兩件事:
//     1. aWorkflow 有 .workflowId (= client-mode SWC plugin transform 結果)
//     2. aWorkflow bundling 進 .well-known/workflow/v1/{flow,step}.js 後,SDK
//        manifest 認得 workflow//./workflow/a//aWorkflow。
//
// 我們不在這裡直接 call aWorkflow()(那需要 HTTP roundtrip + 真 DB / X client),
// 而是驗證 SDK manifest 包含 aWorkflow — 確保 build 階段正確執行,
// runtime 入口正確。

import { test, expect, describe } from "bun:test";
import { aWorkflow } from "../../workflow/a.ts";
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

describe("A workflow (workflow/a.ts)", () => {
  test("aWorkflow function exists and is callable", () => {
    expect(typeof aWorkflow).toBe("function");
  });

  test("aWorkflow has workflowId field (client-mode SWC transform applied)", () => {
    // Bun plugin (scripts/workflow-plugin.ts via bunfig.toml) 給
    // 含 "use workflow" 的 workflow function 加 .workflowId property
    const wf = aWorkflow as unknown as { workflowId?: string };
    expect(wf.workflowId).toBeDefined();
    expect(typeof wf.workflowId).toBe("string");
    // SWC plugin 把路徑編進 workflowId
    expect(wf.workflowId).toContain("aWorkflow");
  });

  test("SDK manifest contains aWorkflow entry from workflow build", () => {
    const fileEntry = manifest.workflows["workflow/a.ts"];
    expect(fileEntry).toBeDefined();
    const aDef = fileEntry!["aWorkflow"];
    expect(aDef).toBeDefined();
    expect(aDef!.workflowId).toBe("workflow//./workflow/a//aWorkflow");
  });

  test("SDK manifest contains pullStep from workflow/a.ts", () => {
    const fileEntry = manifest.steps["workflow/a.ts"];
    expect(fileEntry).toBeDefined();
    const pullDef = fileEntry!["pullStep"];
    expect(pullDef).toBeDefined();
    expect(pullDef!.stepId).toBe("step//./workflow/a//pullStep");
  });
});
