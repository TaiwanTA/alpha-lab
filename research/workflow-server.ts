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
  //
  // 但:workflow-server.ts 間接 import `lib/logger.ts`(透過 workflow/* 內 inline
  // 邏輯保留 `createLogger` 呼叫)+ loadBuiltHandlers() 載的 SDK bundle 內也有
  // module-level `createLogger(...)` side-effect,這些會在 import chain 中觸發 logger
  // lazy init(state 從 null 變成實例)。當 main() 跑 initLogger(...) 時,雖然
  // `disposeState(prev)` 會 dispose 舊 fileTransport,但 LogFileRotationTransport
  // 內部 `Symbol.dispose` 是帶 setTimeout 的 async 解尾,第二次 `new LogFileRotationTransport`
  // 在同步路徑跑時可能還沒從 file-stream-rotator 的 registry 移除該 filename → throw。
  //
  // 解法:initLogger 用 try/catch。若 throw,代表 logger 已被 lazy-init 過(state 不為 null),
  // 沿用現有 logger 即可(production 路徑不會發生 — agent 的 import chain 不會 lazy-init,
  // 只有 workflow-server 透過 SDK bundle 才有此副作用)。
  try {
    initLogger({ logConsole: process.env.LOG_CONSOLE !== "false" });
  } catch (err) {
    // logger state 已存在(lazy-init 過),沿用即可;不能用 wLog 因還沒 createLogger
    console.warn(
      `[workflow-server] initLogger fallback to existing state: ${err instanceof Error ? err.message : String(err)}`,
    );
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
  // 驗證 port 是合法正整數,否則 Bun.serve 會 throw 難以理解的錯誤
  // (e.g. WORKFLOW_SERVER_PORT="abc" → Number("abc") = NaN → Bun.serve throw)
  const portEnv = Number(process.env.WORKFLOW_SERVER_PORT ?? 8090);
  if (!Number.isInteger(portEnv) || portEnv < 1 || portEnv > 65535) {
    log.withMetadata({ env_value: process.env.WORKFLOW_SERVER_PORT }).error(
      "WORKFLOW_SERVER_PORT must be an integer 1-65535",
    );
    process.exit(1);
  }
  const port = portEnv;
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
        // 不外露內部錯誤訊息給 client(server 只 listen 127.0.0.1 但仍避免資訊洩漏)
        return jsonError("internal error", 500);
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
