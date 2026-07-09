// workflow HTTP server smoke test:
//   - 驗證 SDK manifest has expected workflows + steps shape
//   - 驗證 workflowId 在 bundling 階段被 SDK 認出(由 client-mode SWC plugin 加)
//   - 用 alpha-lab test DB(若設 WORKFLOW_SERVER_SMOKE=1)起真 server + curl health
//
// 不 mock SDK runtime —直接驗 SDK 產出 manifest 的 shape,確保 build 沒掉鏈。

import { test, expect, describe } from "bun:test";
import { sql } from "bun";
import { initDb } from "../../lib/db.ts";
import userManifest from "../../.well-known/workflow/v1/workflow-manifest.json" with { type: "json" };
import sdkManifest from "../../.well-known/workflow/v1/manifest.json" with { type: "json" };

interface WorkflowDef {
  workflowId: string;
}
interface StepDef {
  stepId: string;
}
interface UserManifest {
  workflows: Record<string, Record<string, WorkflowDef>>;
  steps: Record<string, Record<string, StepDef>>;
}
interface SdkManifest {
  steps: Record<string, Record<string, StepDef>>;
}

const userMF = userManifest as UserManifest;
const sdkMF = sdkManifest as SdkManifest;

describe("workflow build artifacts", () => {
  test("user-manifest has 4 workflows (a/b/c/d)", () => {
    expect(Object.keys(userMF.workflows).sort()).toEqual([
      "workflow/a.ts",
      "workflow/b.ts",
      "workflow/c.ts",
      "workflow/d.ts",
    ]);
  });

  test("user-manifest has 5 user step functions (pull / discover / triggerC / research / generateReport)", () => {
    const expectedFilesSteps: Record<string, string[]> = {
      "workflow/a.ts": ["pullStep"],
      "workflow/b.ts": ["discoverStep", "triggerCForNewSignals"],
      "workflow/c.ts": ["researchStep"],
      "workflow/d.ts": ["generateReportStep"],
    };
    for (const [file, stepNames] of Object.entries(expectedFilesSteps)) {
      const fileEntry = userMF.steps[file];
      expect(fileEntry).toBeDefined();
      for (const stepName of stepNames) {
        expect(fileEntry![stepName]).toBeDefined();
      }
    }
  });

  test("sdk-manifest also includes SDK builtins (fetch + response helpers)", () => {
    // SDK 內部會把 stdlib fetch / response_* 等加入 — 這是 SDK runtime 行為,
    // alpha-lab 不需直接 invoke,但 SDK bundle 必須包含
    const stdlibSteps = sdkMF.steps["node_modules/workflow/dist/stdlib.js"];
    expect(stdlibSteps).toBeDefined();
    if (!stdlibSteps) return;
    const fetchDef = stdlibSteps["fetch"];
    expect(fetchDef).toBeDefined();
    if (!fetchDef) return;
    expect(fetchDef.stepId).toBe("step//workflow@4.6.0//fetch");
  });
});

if (process.env.WORKFLOW_SERVER_SMOKE === "1") {
  describe("workflow-server HTTP smoke", () => {
    // 假設 test DB 已經 migrate over(DATABASE_URL=postgres://...alpha_lab_test)
    // 且 workflow schema 已 setup。run with:
    //   DATABASE_URL=postgres://...alpha_lab_test \
    //     bunx --package=@workflow/world-postgres bootstrap && \
    //     DATABASE_URL=postgres://...alpha_lab_test \
    //     WORKFLOW_SERVER_SMOKE=1 bun test tests/workflow/server.test.ts
    let serverProc: ReturnType<typeof Bun.spawn> | null = null;
    const TEST_PORT = 18099;

    test("/health returns 200 from real server", async () => {
      await initDb();
      serverProc = Bun.spawn({
        cmd: ["bun", "run", "workflow-server.ts"],
        cwd: import.meta.dir + "/../..",
        env: {
          ...process.env,
          WORKFLOW_SERVER_PORT: String(TEST_PORT),
          WORKFLOW_LOCAL_BASE_URL: `http://127.0.0.1:${TEST_PORT}`,
          LOG_CONSOLE: "false",
        },
        stdout: "pipe",
        stderr: "pipe",
      });

      // Wait for "listening"
      let listening = false;
      const stream = serverProc.stdout as unknown as ReadableStream<Uint8Array>;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const deadline = Date.now() + 20000;
      try {
        // race between decoder stream and timeout
        while (!listening && Date.now() < deadline) {
          const { value, done } = await Promise.race([
            reader.read(),
            new Promise<{ value?: undefined; done: true }>((resolve) =>
              setTimeout(() => resolve({ value: undefined, done: true }), 200),
            ),
          ]);
          if (!done && value) {
            const text = decoder.decode(value);
            if (text.includes("workflow server listening")) listening = true;
          }
        }
      } catch {
        // ignore
      } finally {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
      }

      expect(listening).toBe(true);
      if (!listening) {
        serverProc.kill();
        return;
      }

      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });

    test("/a returns runId + writes workflow_run row", async () => {
      if (!serverProc) return;
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/a`, { method: "POST" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { runId: string; workflow: string };
      expect(body.runId).toBeTruthy();
      expect(body.workflow).toBe("a");

      const rows = await sql<{ id: string; status: string }[]>`
        SELECT id, status FROM workflow.workflow_runs
        WHERE id = ${body.runId}
      `;
      expect(rows.length).toBe(1);
    });

    test("cleanup test server", async () => {
      if (serverProc) {
        serverProc.kill();
        await serverProc.exited;
        serverProc = null;
      }
      expect(true).toBe(true);
    });
  });
}
