// workflow HTTP server + workflow runtime background worker
//
// 啟動序:
//   1. initLogger()(std lib/logger.ts singleton)
//   2. await getWorld().start?.() — 啟 background worker(讀 queue,執行 step/flow callback)
//   3. Bun.serve(...) — listen on WORKFLOW_SERVER_PORT(default 8090)
//
// 環境變數:
//   WORKFLOW_SERVER_PORT — listen port (預設 8090)
//   WORKFLOW_LOCAL_BASE_URL — 給 queue worker 知道 call back 到哪 (預設 http://127.0.0.1:8090)
//   WORKFLOW_POSTGRES_URL、WORKFLOW_TARGET_WORLD — Postgres world 連線
//   DATABASE_URL、HINDSIGHT_BASE_URL、LLM_*、X_BEARER_TOKEN — agent business logic 用
//
// Routes:
//   POST /.well-known/workflow/v1/flow    — workflow execution (built flow.js POST handler)
//   POST /.well-known/workflow/v1/step    — step execution (built step.js POST handler)
//   ALL  /.well-known/workflow/v1/webhook/:token — webhook delivery (built webhook.js handler)
//   POST /a                                — start aWorkflow()
//   POST /b                                — start bWorkflow()
//   POST /c/:signalId                      — start cWorkflow(signalId)
//   POST /d/:type (pre|post)               — start dWorkflow(type)
//   GET  /run/:runId                       — getRun(runId) -> Run state
//   GET  /health                           — 200 {status:"ok"}
//
// Client mode SWC transform:workflow/{a,b,c,d}.ts 透過 bunfig.toml pre-load 的
// scripts/workflow-plugin.ts 在 runtime 加 .workflowId / .stepId 屬性,使
// start(workflowFn) 能正確找到 workflow ID。
//
// Graceful shutdown:
//   SIGTERM / SIGINT — 停 server + dispose file transport + exit

import { start, getRun } from "workflow/api";
import { getWorld } from "workflow/runtime";
// bunfig.toml `preload` 載入 scripts/workflow-plugin.ts,把含 "use workflow"
// / "use step" 的檔做 client-mode SWC transform。
import { aWorkflow } from "./workflow/a.ts";
import { bWorkflow } from "./workflow/b.ts";
import { cWorkflow } from "./workflow/c.ts";
import { dWorkflow } from "./workflow/d.ts";
import { initDb } from "./lib/db.ts";
import {
  initLogger,
  createLogger,
  getFileTransport,
} from "./lib/logger.ts";

// flow.js / step.js / webhook.js 由 `bun run workflow:build` (走 node + StandaloneBuilder)
// 產出。cjs 格式,export POST / HEAD / GET / ... handlers。
// 用 dynamic import + `// @ts-expect-error` 解 TypeScript "no declaration file" error。
// 產出檔不在 tsconfig include + 是 SDK-managed artifact,沒 .d.ts。
type WorkflowPostHandler = {
  POST: (req: Request) => Response | Promise<Response>;
  HEAD: (req: Request) => Response | Promise<Response>;
};
type WebhookHandlerMap = Record<string, (req: Request) => Response | Promise<Response>>;

async function loadBuiltHandlers(): Promise<{
  flow: WorkflowPostHandler;
  step: WorkflowPostHandler;
  webhook: WebhookHandlerMap;
}> {
  // @ts-expect-error -- workflow SDK 產出檔無 .d.ts
  const flowMod = await import("./.well-known/workflow/v1/flow.js");
  // @ts-expect-error -- workflow SDK 產出檔無 .d.ts
  const stepMod = await import("./.well-known/workflow/v1/step.js");
  // @ts-expect-error -- workflow SDK 產出檔無 .d.ts
  const webhookMod = await import("./.well-known/workflow/v1/webhook.js");
  return {
    flow: (flowMod as { default: WorkflowPostHandler }).default,
    step: (stepMod as { default: WorkflowPostHandler }).default,
    webhook: webhookMod as WebhookHandlerMap,
  };
}

async function startWorkflowWorld(log: ReturnType<typeof createLogger>): Promise<void> {
  const world = await getWorld();
  // 只有部分 world 有 start()(Postgres world 有 — 起 graphile-worker listener);
  // 起 self-hosted 環境必須,見 Vercel Workflow 文檔 non-vercel-runtime-branch
  await world.start?.();
  log.withMetadata({ target_world: process.env.WORKFLOW_TARGET_WORLD }).info("workflow world started");
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: "not found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });
}

function jsonError(msg: string, status: number): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function jsonOk(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function main(): Promise<void> {
  // 1. logger init(必要顯式 init 才能確定行為,例如 LOG_CONSOLE=false)
  // 但 step.js / flow.js bundle 內有 `var log = createLogger("x-client")`
  // module-level side-effect,只要 import 該檔就會 lazy-init logger — 這在
  // workflow-server.ts 自身的 import chain 更早發生(L99 載 built handlers
  // 之前),所以 state 不為 null,而 filename registry 已佔住。直接重 init
  // 會撞同一 filename。
  //
  // 解法:initLogger 已內建 `if (state) disposeState(state)`。Symbol.dispose
  // 是 async(setTimeout 等 compression)但 first init 不會壓縮,所以
  // activeFilenames.delete 在同步路徑就跑。實際驗證:重 init 會 throw
  // "already in use" — 推測 setImmediate/微任務順序問題。
  //
  // 簡單解法:先 sync 跑 delete from activeFilenames,再 call construct。

  // 先 sync 觸碰 logDir,確保 mkdir 完成
  try {
    initLogger({ logConsole: process.env.LOG_CONSOLE !== "false" });
  } catch {
    // initLogger 可能因 registry 衝突 throw — 此時 logger 已被某 module
    // lazy-init 過(state 不為 null),fallback 沿用。
    // 我們仍要拿 child logger,所以走 getLog() 拿到現有。
  }

  const log = createLogger("workflow-server");

  // build output handler 在 initLogger 之後才 import — 不延遲啟動時間
  const { flow, step, webhook } = await loadBuiltHandlers();

  // 2. workflow world init(background workers)
  await startWorkflowWorld(log);

  // 3. health record db init — pull 內會跳 initDb,跟我們 health 沒直接關係
  try {
    await initDb();
  } catch (err) {
    log.withError(err).warn("initDb failed at startup — DB schema may not be migrated yet");
  }

  // 4. Bun.serve
  const port = Number(process.env.WORKFLOW_SERVER_PORT ?? 8090);
  const server = Bun.serve({
    port,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method.toUpperCase();

      // built-in workflow runtime handlers
      if (pathname === "/.well-known/workflow/v1/flow" && (method === "POST" || method === "HEAD")) {
        return flow[method](req);
      }
      if (pathname === "/.well-known/workflow/v1/step" && (method === "POST" || method === "HEAD")) {
        return step[method](req);
      }
      // webhook — 任何 method 都過境
      const webhookMatch = pathname.match(/^\/.well-known\/workflow\/v1\/webhook\/(.+)$/);
      if (webhookMatch) {
        const handler = webhook[method];
        if (handler) return await handler(req);
        return jsonError(`method ${method} not allowed`, 405);
      }

      // 自定義 routes
      try {
        if (method === "GET" && pathname === "/health") {
          return jsonOk({ status: "ok", port });
        }

        if (method === "POST" && pathname === "/a") {
          const run = await start(aWorkflow);
          log.withMetadata({ run_id: run.runId, workflow: "a" }).info("started");
          return jsonOk({ runId: run.runId, workflow: "a" });
        }

        if (method === "POST" && pathname === "/b") {
          const run = await start(bWorkflow);
          log.withMetadata({ run_id: run.runId, workflow: "b" }).info("started");
          return jsonOk({ runId: run.runId, workflow: "b" });
        }

        // /c/:signalId — UUID 風格
        const cMatch = pathname.match(/^\/c\/([0-9a-fA-F-]+)$/);
        if (method === "POST" && cMatch) {
          const signalId = cMatch[1]!;
          const run = await start(cWorkflow, [signalId]);
          log
            .withMetadata({ run_id: run.runId, workflow: "c", signal_id: signalId })
            .info("started");
          return jsonOk({ runId: run.runId, workflow: "c", signalId });
        }

        // /d/:type ∈ pre|post
        const dMatch = pathname.match(/^\/d\/(pre|post)$/);
        if (method === "POST" && dMatch) {
          const type = dMatch[1]! as "pre" | "post";
          const run = await start(dWorkflow, [type]);
          log
            .withMetadata({ run_id: run.runId, workflow: "d", type })
            .info("started");
          return jsonOk({ runId: run.runId, workflow: "d", type });
        }

        // /d/<other> -> 400
        if (method === "POST" && pathname.startsWith("/d/")) {
          return jsonError("invalid type, must be 'pre' or 'post'", 400);
        }

        // /run/:runId
        const runMatch = pathname.match(/^\/run\/([0-9a-zA-Z_-]+)$/);
        if (method === "GET" && runMatch) {
          const runId = runMatch[1]!;
          try {
            const run = getRun(runId);
            const status = await run.status;
            return jsonOk({
              runId,
              status,
              workflowName: await run.workflowName,
              createdAt: (await run.createdAt).toISOString(),
            });
          } catch (err) {
            log.withMetadata({ run_id: runId }).withError(err).error("getRun failed");
            return jsonError(err instanceof Error ? err.message : "getRun failed", 404);
          }
        }
      } catch (err) {
        log.withMetadata({ pathname, method }).withError(err).error("handler error");
        return jsonError(err instanceof Error ? err.message : "internal error", 500);
      }

      return notFound();
    },
  });

  log
    .withMetadata({ port, url: `http://127.0.0.1:${port}` })
    .info("workflow server listening");

  // Graceful shutdown
  const shutdown = (signal: string): void => {
    log.withMetadata({ signal }).info("shutdown start");
    void (async () => {
      try {
        await server.stop(true);
      } catch (err) {
        log.withError(err).warn("server.stop failed");
      }
      try {
        const ft = getFileTransport();
        if (ft) {
          (ft as unknown as { [Symbol.dispose]: () => void })[Symbol.dispose]();
        }
      } catch (err) {
        log.withError(err).warn("file transport dispose failed");
      }
      log.info("shutdown complete");
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  // 在 initLogger 前失敗用 stderr,或已經 init 後用 log(這裡兩者兼具)
  console.error("server failed to start:", err);
  process.exit(1);
});
