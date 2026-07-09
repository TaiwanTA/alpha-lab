// Bun plugin:對含 "use workflow" / "use step" directives 的檔做 client-mode
// SWC transform(經由 @workflow/swc-plugin WASM binary)。
//
// 為什麼需要:
//   Vercel Workflow SDK 仰賴 function-level metadata(如 `workflowFn.workflowId`、
//   `stepFn.stepId`)。這些欄位由 SWC plugin 在 build 時(Next.js / Vite plugin)
//   加到 function object 上。Bun 內建的 SWC 不支援外部 WASM SWC plugins,所以
//   我們用 Bun plugin API 在 file load 時做相同 transform,讓 `start(myWorkflow)`
//   能正確找到 workflowId 並送到對應的 queue topic。
//
// 載入方式:bunfig.toml `preload` — 每次 `bun run` / `bun test` 都會載入。
//
// 設計取捨:
//   - 用 SWC async transform `transform()` 而非 sync 版本 — 因為 WASM plugin
//     透過 native binding 跑,只有 async 路徑接受 `jsc.experimental.plugins`。
//   - 對不含 directive 的檔跳過(讓 Bun 內建 SWC 接管)— 等同沒 plugin。
//   - Loader 回傳 "ts" — Bun 還會跑它自己的 TS 處理,但 SWC transform 後的
//     output 已是純 JS,等於不做事。

import { plugin } from "bun";
import { transform } from "@swc/core";
import { resolve } from "node:path";

const PLUGIN_PATH = resolve(
  import.meta.dir,
  "..",
  "node_modules/@workflow/swc-plugin/swc_plugin_workflow.wasm",
);

// 快速過濾:含 directive 才送 SWC transform。SWC plugin 內部也會再檢查,但
// 這層先擋能省 transform 開銷(且讓 Bun 內建 SWC 對一般檔照平常處理)
const DIRECTIVE_RE = /(['"])use (workflow|step)\1/m;

// Filter 限定 .ts 檔(workflow source files)— 排除 .js 因為 SDK bundled
// artifacts(.well-known/workflow/v1/*.js)是 cjs 格式含 require 等,
// Bun plugin 強制 loader js 會把它們誤判為 ESM 跑解析錯誤。
// 過去 plugin 對 .js 都跑過濾,結果會讓 step.js / flow.js / webhook.js 等
// SDK-built artifact 走 plugin 路徑(直送內容給 Bun loader),反而撞"Bun 對
// ms 的 ESM-mode 解析報錯" — 把 filter 收緊到 .ts/.tsx 就解決。
plugin({
  name: "workflow-client-transform",
  setup(build) {
    build.onLoad(
      { filter: /\.(ts|tsx)$/ },
      async (args) => {
        // 跳過 node_modules — 不要對外部 dep 做 transform(workflow SDK 自己已編譯)
        if (args.path.includes("/node_modules/")) {
          return { contents: await Bun.file(args.path).text(), loader: "js" };
        }

        const source = await Bun.file(args.path).text();
        if (!DIRECTIVE_RE.test(source)) {
          return { contents: source, loader: args.path.endsWith(".tsx") ? "tsx" : "ts" };
        }

        const result = await transform(source, {
          filename: args.path,
          jsc: {
            parser: { syntax: "typescript", tsx: args.path.endsWith("x") },
            target: "es2022",
            experimental: {
              plugins: [[PLUGIN_PATH, { mode: "client" }]],
            },
          },
        });

        return { contents: result.code, loader: "js" };
      },
    );
  },
});
