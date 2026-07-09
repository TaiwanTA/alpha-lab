// workflow build script — 純 JS (Node 跑 .mjs 不吃 TS syntax)
//
// 對 workflow/ 目錄跑 workflow SDK standalone build,產出
// .well-known/workflow/v1/{flow,step,webhook}.js,然後對 CJS outputs
// 補 module.exports.default = module.exports 以利 Bun runtime 的
// ESM `await import()` 把 default 視為整個 exports 物件。
//
// 為什麼 patch:workflow SDK 預設 CJS-format 輸出 (`module.exports = __toCommonJS(...)`),
// 沒 default export。Bun 透過 `await import(...)` 載入 CJS 檔時報
// "Missing 'default' export"。Node 跑 SDK 內部 VM 用 `require(...)` 完全 OK,
// 但 Bun self-host server 必須 ESM 走 import,所以 patch 補 default。
//
// workflow:build script 在 package.json 對 `bun run workflow:build` 跑。

import { StandaloneBuilder } from "@workflow/builders";
import { readFile, writeFile } from "node:fs/promises";

async function patchDefaultExport(path) {
  const original = await readFile(path, "utf-8");
  if (original.includes("module.exports.default = module.exports")) return;
  const patched = original.trimEnd() +
    "\nmodule.exports.default = module.exports;\n";
  await writeFile(path, patched, "utf-8");
  console.log(`[workflow-build] patched default export: ${path}`);
}

async function main() {
  const config = {
    buildTarget: "standalone",
    dirs: ["./workflow"],
    workingDir: process.cwd(),
    stepsBundlePath: "./.well-known/workflow/v1/step.js",
    workflowsBundlePath: "./.well-known/workflow/v1/flow.js",
    webhookBundlePath: "./.well-known/workflow/v1/webhook.js",
    workflowManifestPath: "./.well-known/workflow/v1/workflow-manifest.json",
  };

  console.log("[workflow-build] StandaloneBuilder");
  console.log("[workflow-build] workingDir:", config.workingDir);
  console.log("[workflow-build] dirs:", config.dirs);

  const builder = new StandaloneBuilder(config);
  await builder.build();

  await patchDefaultExport(config.stepsBundlePath);
  await patchDefaultExport(config.workflowsBundlePath);

  console.log("[workflow-build] Build completed successfully!");
}

main().catch((err) => {
  console.error("[workflow-build] Build failed:", err);
  process.exit(1);
});
