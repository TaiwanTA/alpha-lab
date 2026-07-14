#!/usr/bin/env bash
# 由 Dagu `blog-publish` 子 DAG 的 `checkout` step 呼叫,把
# 遠端 worktree 拉進 `./workspace/publish`。跟 clone-fixture.sh
# 是同一套 git + token 機制,差在目的目錄:
#   - clone-fixture.sh → ./workspace/app  (研究端)
#   - clone-publish.sh  → ./workspace/publish (發布端)
# 子 DAG 用這個 wrapper 取代 Dagu 內建的 git.checkout,因為
# Dagu 2.10.7 的 go-git 不支援 fine-grained PAT。
#
# 分支說明:這裡 clone `rebuild/integrate` 而不是 main,因為
# `automation/` 目錄 (含 automation/scripts/publish-draft.ts
# 跟 publish 端測試 fixtures) 目前只存在 integration 分支。
# main 有 blog 但沒有 publisher。blog-publish.yaml 的 push
# 步驟也對應到 rebuild/integrate,讓整個 round trip 都在
# 同一個分支上。merge 之後把這裡的 clone ref 跟 push ref 同步
# 改回 main 即可。
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
echo "=== publish-clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN} ref=rebuild/integrate"
rm -rf ./workspace
mkdir -p ./workspace
git clone --depth 1 -b rebuild/integrate \
  "https://x-access-token@github.com/TaiwanTA/alpha-lab.git" \
  ./workspace/publish
