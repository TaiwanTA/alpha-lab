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

import { parseArgs } from "node:util";

const args = parseArgs({
  options: {
    workspace: { type: "string", default: "./workspace/publish" },
    branch: { type: "string", default: "main" },
  },
});

const token = process.env.GIT_READ_TOKEN;
if (!token || token.length === 0) {
  console.error("clone-publish: GIT_READ_TOKEN 必須設定在環境變數");
  process.exit(2);
}

const REMOTE = "https://x-access-token@github.com/TaiwanTA/alpha-lab.git";

// askpass helper：寫入臨時檔（0700、PID-suffixed），執行完 finally 刪除。
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

try {
  await Bun.$`rm -rf ./workspace`.quiet();
  await Bun.$`mkdir -p ./workspace`.quiet();
  console.error(
    `clone-publish: branch=${args.values.branch} → ${args.values.workspace}`,
  );
  await Bun.$`git clone --depth 1 -b ${args.values.branch} ${REMOTE} ${args.values.workspace}`
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
  let code = 1;
  if (err instanceof Error && "stderr" in err) {
    stderr = String(err.stderr);
  }
  if (err instanceof Error && "exitCode" in err) {
    const candidate = err.exitCode;
    if (typeof candidate === "number") code = candidate;
  }
  console.error("clone-publish: clone 失敗:", stderr.slice(0, 500));
  process.exit(code);
} finally {
  await Bun.$`rm -f ${tmpAskpass}`.quiet();
}

process.exit(0);
