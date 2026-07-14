#!/usr/bin/env bash
# 由 Dagu `fixture-research` DAG 的 `hindsight_recall` step
# 呼叫。從 $1 讀 query 字串,POST 到 Hindsight 的 recall
# endpoint,目標 bank 是 $HINDSIGHT_BANK_ID,回應的 JSON
# 寫到 stdout。fixture 流程用這個在 hermes 起草之前撈
# 先前 retain 過的 observations。
#
# Hindsight v0.8.4 recall schema (從 /openapi.json 來):
# request body 是 `{"query": "..."}`。可選欄位有
# `types`、`budget`、`max_tokens`。沒有 `limit` 欄位,
# 結果數量由 `max_tokens` 控制 (預設 4096)。
#
# 環境變數讀取:見 hindsight-retain.sh。
set -eo pipefail
set +u
if [[ ! -f /etc/alpha-lab/dagu.env ]]; then
  echo "/etc/alpha-lab/dagu.env not found" >&2
  exit 2
fi
. /etc/alpha-lab/dagu.env
set -u

QUERY="${1:?usage: hindsight-recall.sh <query>}"
: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL must be set in /etc/alpha-lab/dagu.env}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in /etc/alpha-lab/dagu.env}"
: "${HINDSIGHT_API_KEY:=}"

# 診斷訊息走 stderr;stdout 是合約內容 (Hindsight 的 JSON
# 回應)。dagu 把 stdout 收成 step 的 output。
echo "=== hindsight-recall === bank=$HINDSIGHT_BANK_ID query_len=${#QUERY}" >&2

CURL_ARGS=(-fsS -X POST -H "Content-Type: application/json")
if [[ -n "${HINDSIGHT_API_KEY}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${HINDSIGHT_API_KEY}")
fi
CURL_ARGS+=(-d "$(jq -nc --arg q "$QUERY" '{query: $q}')")

curl "${CURL_ARGS[@]}" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories/recall"
