#!/usr/bin/env bash
# 由 Dagu `blog-publish` 子 DAG 的 `checkout` step 呼叫,把
# 遠端 worktree 拉進 `./workspace/publish`。跟 clone-fixture.sh
# 是同一套 git + token 機制,差在目的目錄:
#   - clone-fixture.sh → ./workspace/app  (研究端)
#   - clone-publish.sh  → ./workspace/publish (發布端)
# 子 DAG 用這個 wrapper 取代 Dagu 內建的 git.checkout,因為
# Dagu 2.10.7 的 go-git 不支援 fine-grained PAT。
#
# 分支說明:v3 rebuild (PR #18) 之後,automation/
# (含 scripts/publish-draft.ts + fixtures) 跟著 publish 端
# 測試 fixtures 一起進 main;blog-publish.yaml 的 push ref
# 也同步指向 main,整個 round trip 都在同一個分支。
#
# 認證處理:見 clone-fixture.sh。
set -eo pipefail
set +u
if [[ ! -f /etc/alpha-lab/dagu.env ]]; then
  echo "/etc/alpha-lab/dagu.env not found" >&2
  exit 2
fi
. /etc/alpha-lab/dagu.env
set -u
: ${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in /etc/alpha-lab/dagu.env}
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/opt/alpha-lab/automation/scripts/git-askpass.sh
export GIT_ASKPASS_REQUIRE_FORCE=1
echo "=== publish-clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN} ref=main"
rm -rf ./workspace
mkdir -p ./workspace
git clone --depth 1 -b main \
  "https://x-access-token@github.com/TaiwanTA/alpha-lab.git" \
  ./workspace/publish
