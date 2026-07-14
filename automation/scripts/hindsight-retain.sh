#!/usr/bin/env bash
# Hindsight retain wrapper for Dagu。
#
# 由 Dagu `fixture-research` DAG 的 `hindsight_retain` step
# 呼叫。從 $1 讀 facts JSON 檔路徑,POST 到 Hindsight 的
# retain endpoint,目標 bank 是 $HINDSIGHT_BANK_ID。fixture
# 流程用這個把 offline fixture 的 `safe-publish.md` 內容
# 當 facts 灌進 Hindsight,供後續 recall 跟 hermes 參考。
#
# Hindsight v0.8.4 retain schema:request body 格式是
# `{"items": [{"content": "...", "context": "..."}, ...]}`。
# 欄位叫 `items`,不是 `facts` (會被 422 拒絕)。
# endpoint 是 `POST /v1/default/banks/{bank_id}/memories`。
#
# 環境變數讀取:這個 wrapper 是 dagu process 的子行程
# (在 host 的 network namespace)。dagu systemd unit 的
# EnvironmentFile 是 /etc/alpha-lab/dagu.env;在這裡 source
# 是因為 dagu 2.10.7 不會把 process env 傳進 run-step 的
# 子 shell。
set -eo pipefail
set +u
if [[ ! -f /etc/alpha-lab/dagu.env ]]; then
  echo "/etc/alpha-lab/dagu.env not found" >&2
  exit 2
fi
. /etc/alpha-lab/dagu.env
set -u

INPUT="${1:?usage: hindsight-retain.sh <items-file>}"
: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL must be set in /etc/alpha-lab/dagu.env}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in /etc/alpha-lab/dagu.env}"
: "${HINDSIGHT_API_KEY:=}"

if [ ! -f "$INPUT" ]; then
  echo "input not found: $INPUT" >&2
  exit 2
fi

# 診斷訊息走 stderr;stdout 是合約內容 (Hindsight 的 JSON
# 回應)。
echo "=== hindsight-retain === bank=$HINDSIGHT_BANK_ID file=$INPUT" >&2

# 用 bash array 組 curl 參數,避免 HINDSIGHT_API_KEY 萬一
# 含空白或 shell meta-char 時被 word-splitting 拆開
# (目前自架不設 key,但 dagu.env 是 root:alpha-lab-dagu
# 0440,防禦性寫法)。
CURL_ARGS=(-fsS -X POST -H "Content-Type: application/json")
if [[ -n "${HINDSIGHT_API_KEY}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${HINDSIGHT_API_KEY}")
fi
CURL_ARGS+=(--data-binary "@${INPUT}")

curl "${CURL_ARGS[@]}" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories"
