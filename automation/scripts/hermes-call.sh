#!/usr/bin/env bash
# 由 Dagu `fixture-research` DAG 的 `hermes` step 呼叫。
# 從 $HERMES_PROMPT (env) 讀 prompt 內文,然後在一次性容器
# 裡跑 hermes CLI。image 用 `nousresearch/hermes-agent:latest`
# (跟長駐的 hermes-hermes-1 gateway 用同一個 image)。
#
# 為什麼用 docker run --rm 而不是 docker exec:
#   bind mount 只能在 docker run 階段加,exec 階段加不了
#   (--mount / -v 對 exec 都無效)。host 上的 /opt/data 目錄是
#   模型的 minimax-oauth 設定檔位置,要把同一份設定讓一次性
#   容器內的 agent 讀到,只能 run 階段 bind 進去。
#
# Profile:預設用 `default`,這是容器內唯一配好 MiniMax-M3
# 模型的 profile。
#
# 網址覆寫:$HINDSIGHT_BASE_URL 從 dagu.env 讀進來是 host
# loopback (`http://127.0.0.1:8888`),但進到一次性容器內
# 127.0.0.1 變成容器自己的 loopback。我們覆寫成 docker 網路別名
# `hindsight-hindsight-1:8888` (同一個 hindsight-net 上的另一個
# 容器)。
#
# Entrypoint 覆寫:image 預設 entrypoint 是 s6 init,會把
# hermes gateway supervise 起來。我們用 `--entrypoint ""`
# 直接把 hermes 當 PID 1 跑,這樣 s6 不會把我們的 SIGTERM
# 當成 shutdown 訊號。
#
# 寫入目標:dagu step 的 workspace 用 :rw bind mount
# (`--user 0:0` 讓容器內的 root 對該目錄有完整權限)。
# agent 把 candidate 寫到 $ALPHA_LAB_CANDIDATE_PATH,dagu
# step 之後會 `cat` 該檔。
#
# Exit-code 處理:hermes 的 safety guard 可能會拒絕對某些
# 路徑呼叫 write_file 然後回非零,但 model 已經產生有效的
# 回應。我們用 `... || HERMES_EXIT=$?` 把 exit code 收下來
# (`set -e` 下若沒這段,docker 失敗時腳本會直接 exit,
# soft-fail 分支永遠到不了),然後分三種情況:
#   - exit 0                  → 成功
#   - exit != 0 且 candidate 存在且非空
#                            → soft fail (write-guard 拒絕,
#                              但 model 透過 stdout 給出可用
#                              的 candidate)。dagu step 視為
#                              成功;stderr 留在磁碟上供事後
#                              查看。
#   - exit != 0 且沒有 candidate
#                            → hard fail。dagu step 失敗。
# Stderr 導到 `${HOST_DIR}/.hermes-stderr.log` (mode 0600),
# 事後可查但不污染合約用的 stdout。
#
# 環境變數讀取:見 hindsight-retain.sh。
set -eo pipefail
set +u
. /etc/alpha-lab/dagu.env
set -u

: "${HERMES_PROMPT:?HERMES_PROMPT must be set by the dagu step (cat the prompt file into the env)}"
: "${ALPHA_LAB_CANDIDATE_PATH:?ALPHA_LAB_CANDIDATE_PATH must be set by the dagu step (host path)}"
: "${HERMES_PROFILE:=default}"
: "${HERMES_IMAGE:=nousresearch/hermes-agent:latest}"
: "${HERMES_DATA_HOST:=/opt/hermes/hermes/data}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in /etc/alpha-lab/dagu.env}"
: "${HINDSIGHT_API_KEY:=}"

HOST_DIR="$(dirname "$ALPHA_LAB_CANDIDATE_PATH")"
HOST_FILE="$(basename "$ALPHA_LAB_CANDIDATE_PATH")"
mkdir -p "$HOST_DIR"

if [ "${#HERMES_PROMPT}" -lt 50 ]; then
  echo "HERMES_PROMPT suspiciously short (${#HERMES_PROMPT} chars); aborting" >&2
  exit 2
fi

# 在一次性容器裡 127.0.0.1 是容器自己的 loopback,改用
# docker 網路別名。
CONTAINER_HINDSIGHT_URL="http://hindsight-hindsight-1:8888"

echo "=== hermes-call === profile=$HERMES_PROFILE prompt_len=${#HERMES_PROMPT} host_path=$ALPHA_LAB_CANDIDATE_PATH image=$HERMES_IMAGE bank=$HINDSIGHT_BANK_ID hindsight_url=$CONTAINER_HINDSIGHT_URL"

HERMES_STDERR="${HOST_DIR}/.hermes-stderr.log"
: > "$HERMES_STDERR"
chmod 0600 "$HERMES_STDERR" 2>/dev/null || true

# `--user 0:0` 讓容器內用 root,這樣 :rw bind mount 完全可用。
# stdout 走 dagu step 的 stdout (YAML 用 `stdout: { artifact }`
# 把它收成 candidate.md artifact)。
#
# 結尾的 `|| HERMES_EXIT=$?` 在 `set -e` 下把失敗吞掉,把
# exit code 收下來,讓下面的 post-run 檢查讀得到。沒這段
# 的話,docker/hermes 任何非零 exit 都會跳過 soft-fail vs
# hard-fail 的分支判斷。
HERMES_EXIT=0
docker run --rm \
  --user 0:0 \
  --entrypoint "" \
  --network hindsight-net \
  -v "${HOST_DIR}:/workspace:rw" \
  -v "${HERMES_DATA_HOST}:/opt/data" \
  -e HINDSIGHT_BASE_URL="$CONTAINER_HINDSIGHT_URL" \
  -e HINDSIGHT_API_KEY="$HINDSIGHT_API_KEY" \
  -e HINDSIGHT_BANK_ID="$HINDSIGHT_BANK_ID" \
  -e ALPHA_LAB_RUN_ID="${ALPHA_LAB_RUN_ID:-}" \
  -e ALPHA_LAB_WORKSPACE="/workspace" \
  -e ALPHA_LAB_CANDIDATE_PATH="/workspace/${HOST_FILE}" \
  -e HERMES_WRITE_SAFE_ROOT="/workspace" \
  -w /workspace \
  "$HERMES_IMAGE" \
  /opt/hermes/bin/hermes -p "$HERMES_PROFILE" -z "$HERMES_PROMPT" \
  > "$ALPHA_LAB_CANDIDATE_PATH" 2> "$HERMES_STDERR" || HERMES_EXIT=$?

# Empty candidate + non-zero exit → hard fail.
if [ ! -s "$ALPHA_LAB_CANDIDATE_PATH" ]; then
  echo "candidate file is empty or missing; hermes exited $HERMES_EXIT" >&2
  echo "see $HERMES_STDERR for details" >&2
  exit 1
fi

if [ "$HERMES_EXIT" -ne 0 ]; then
  # 非零但 candidate 存在:這是設計上的 soft-fail 路徑
  # (hermes safety guard 拒絕檔案寫入,但 model 透過 stdout
  # 給出可用的 candidate)。log warning 但 exit 0 讓 dagu
  # 不要 retry。
  echo "hermes exited $HERMES_EXIT but candidate.md was produced (likely write-guard refusal); see $HERMES_STDERR" >&2
fi

echo "wrote candidate to $ALPHA_LAB_CANDIDATE_PATH ($(wc -c < "$ALPHA_LAB_CANDIDATE_PATH") bytes)"
