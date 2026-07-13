#!/usr/bin/env bash
# Hindsight recall wrapper for Dagu.
#
# Queries the Hindsight recall endpoint for bank $HINDSIGHT_BANK_ID
# with a query string from $1, and writes the response JSON to
# stdout. Used by the fixture-research DAG to surface prior
# observations before drafting.
#
# This script runs inside the alpha-lab-dagu container; see the
# docker network alias note in hindsight-retain.sh.
set -eo pipefail

QUERY="${1:?usage: hindsight-recall.sh <query>}"
: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL must be set in the dagu container env}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in the dagu container env}"
: "${HINDSIGHT_API_KEY:=}"

echo "=== hindsight-recall === bank=$HINDSIGHT_BANK_ID query_len=${#QUERY}"
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  ${HINDSIGHT_API_KEY:+-H "Authorization: Bearer $HINDSIGHT_API_KEY"} \
  -d "$(jq -nc --arg q "$QUERY" '{query: $q, limit: 10}')" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories/recall"
