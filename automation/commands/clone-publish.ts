#!/usr/bin/env bun
// automation/commands/clone-publish.ts
//
// 由 Dagu `blog-publish` 子 DAG 的 `checkout` step 呼叫，把遠端 main
// 拉進 `./workspace/publish`，作為發布 worktree。
//
// 不使用 Dagu 2.10.7 內建 git.checkout — go-git 對 fine-grained PAT 失敗。
// token 走 GIT_ASKPASS 協定（不透過 argv / URL），避免漏到 ps / log。
//
// 取代舊 automation/scripts/clone-publish.sh + git-askpass.sh 兩個 shell
// wrapper。askpass 邏輯內聯：產生 PID-suffixed 臨時 askpass script，
// chmod 0700，finally 必刪。kill -9 殘留檔名含 PID 不重名，下次不影響。
//
// 注意：catch 不直接 process.exit()，否則會繞過 finally 導致 askpass
// 殘留（含 token）。用 exitCode 變數，最後统一 exit。

import { parseArgs } from "node:util";

const args = parseArgs({
  options: {
    workspace: { type: "string", default: "./workspace/publish" },
    branch: { type: "string", default: "main" },
  },
});

const workspace = args.values.workspace;
const branch = args.values.branch;

const token = process.env.GIT_READ_TOKEN;
if (!token || token.length === 0) {
  console.error("clone-publish: GIT_READ_TOKEN 必須設定在環境變數");
  process.exit(2);
}

const REMOTE = "https://x-access-token@github.com/TaiwanTA/alpha-lab.git";

// askpass helper：寫入臨時檔（0700、PID-suffixed），finally 必刪。
// 檔名含 PID 避免並發衝突；kill -9 殘留可手動清理。
const tmpAskpass = `${process.env.HOME ?? "/tmp"}/.git-askpass-${process.pid}.sh`;
const askpassBody = `#!/bin/sh
case "$1" in
  Username*) printf 'x-access-token\\n' ;;
  *)         printf '%s\\n' "$GIT_READ_TOKEN" ;;
esac
`;
await Bun.write(tmpAskpass, askpassBody);
await Bun.$`chmod 0700 ${tmpAskpass}`.quiet();

let exitCode = 0;
try {
  // rm -rf 用 --workspace 參數，避免硬編碼 ./workspace；mkdir -p 父目錄。
  await Bun.$`rm -rf ${workspace}`.quiet();
  await Bun.$`mkdir -p ${workspace}`.quiet();
  console.error(`clone-publish: branch=${branch} → ${workspace}`);
  await Bun.$`git clone --depth 1 -b ${branch} ${REMOTE} ${workspace}`
    .env({
      ...Bun.env,
      GIT_ASKPASS: tmpAskpass,
      GIT_ASKPASS_REQUIRE_FORCE: "1",
      GIT_TERMINAL_PROMPT: "0",
    })
    .quiet();
  console.error("clone-publish: clone 完成");
} catch (err) {
  // Bun.$ throws ShellError (Error subclass); narrow via `in` before access.
  let stderr = "";
  if (err instanceof Error && "stderr" in err) {
    stderr = String(err.stderr);
  }
  if (err instanceof Error && "exitCode" in err) {
    const candidate = err.exitCode;
    if (typeof candidate === "number") exitCode = candidate;
  }
  if (exitCode === 0) exitCode = 1;
  console.error("clone-publish: clone 失敗:", stderr.slice(0, 500));
} finally {
  // cleanup 失敗不可覆蓋原本的 exitCode；吞掉錯誤只 log warning。
  try {
    await Bun.$`rm -f ${tmpAskpass}`.quiet();
  } catch (cleanupErr) {
    console.error(
      "clone-publish: 警告 — 清理 askpass 臨時檔失敗:",
      cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
    );
  }
}

process.exit(exitCode);
