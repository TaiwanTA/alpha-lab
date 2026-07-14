#!/usr/bin/env bash
# 由 Dagu `fixture-research` DAG 的 `checkout` step 呼叫,把
# 遠端 worktree 拉進 `./workspace/app`,供後續 Hindsight /
# Hermes / Publish 步驟使用。
#
# 環境變數:從 /etc/alpha-lab/dagu.env 讀取 $GIT_READ_TOKEN
# (該檔是 systemd unit 的 EnvironmentFile)。Dagu 2.10.7
# 不會把 process env 傳進 run-step 的子 shell,所以這裡
# 自己 source 一次。
#
# 分支說明:fixture 內容 (automation/fixtures/safe-publish.md
# 與 automation/prompts/fixture-research.md) 目前只放在
# `rebuild/integrate`,還沒合併到 `main`。merge 之前先固定
# 在這個分支;merge 之後把 `-b rebuild/integrate` 改回
# `-b main` 重新部署即可。
#
# 認證處理:token 透過 git-askpass.sh 傳給 git,URL 只放
# username `x-access-token`,密碼走 git 的 credential
# channel 而不是 argv。這樣 token 不會出現在 ps、dagu log
# 跟 shell history。
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
export GIT_ASKPASS_REQUIRE_FORCE=1  # only ask when needed; never block on stdin
echo "=== clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN} ref=rebuild/integrate"
# 清掉前次失敗 run 留下來的 stale workspace;否則 git clone
# 會因為 destination path 已經存在而中斷。
rm -rf ./workspace
mkdir -p ./workspace
git clone --depth 1 -b rebuild/integrate \
  "https://x-access-token@github.com/TaiwanTA/alpha-lab.git" \
  ./workspace/app
