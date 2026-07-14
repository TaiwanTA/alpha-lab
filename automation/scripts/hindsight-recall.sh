#!/usr/bin/env bash
# Hindsight recall wrapper for Dagu.
#
# Queries the Hindsight recall endpoint for bank $HINDSIGHT_BANK_ID
# with a query string from $1, and writes the response JSON to
# stdout. Used by the fixture-research DAG to surface prior
# observations before drafting.
#
# Hindsight v0.8.4 recall schema (from /openapi.json): the
# request body is `{"query": "..."}`. Optional fields include
# `types`, `budget`, `max_tokens`. There is no `limit` field; the
# result count is governed by `max_tokens` (default 4096).
#
# Env resolution: see hindsight-retain.sh.
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

# Diagnostic on stderr; stdout is the contract (Hindsight JSON
# response). dagu captures stdout as the step's output.
echo "=== hindsight-recall === bank=$HINDSIGHT_BANK_ID query_len=${#QUERY}" >&2

CURL_ARGS=(-fsS -X POST -H "Content-Type: application/json")
if [[ -n "${HINDSIGHT_API_KEY}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${HINDSIGHT_API_KEY}")
fi
CURL_ARGS+=(-d "$(jq -nc --arg q "$QUERY" '{query: $q}')")

curl "${CURL_ARGS[@]}" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories/recall"
