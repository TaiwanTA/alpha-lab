#!/usr/bin/env bash
# Hindsight retain wrapper for Dagu.
#
# Reads a facts JSON document from $1 (file path) and POSTs it to
# the Hindsight retain endpoint for bank $HINDSIGHT_BANK_ID. Used
# during the fixture-research DAG to retain the offline fixture's
# `safe-publish.md` content as facts.
#
# This script runs inside the alpha-lab-dagu container, so
# HINDSIGHT_BASE_URL must point to a Hindsight address reachable
# from the container (typically the docker network alias
# `http://hindsight-hindsight-1:8888`). The DAG step's `env:` block
# and the compose's `environment:` block both set this.
set -eo pipefail

INPUT="${1:?usage: hindsight-retain.sh <facts-file>}"
: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL must be set in the dagu container env}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in the dagu container env}"
: "${HINDSIGHT_API_KEY:=}"

if [ ! -f "$INPUT" ]; then
  echo "input not found: $INPUT" >&2
  exit 2
fi

echo "=== hindsight-retain === bank=$HINDSIGHT_BANK_ID file=$INPUT"
curl -fsS -X POST \
  -H "Content-Type: application/json" \
  ${HINDSIGHT_API_KEY:+-H "Authorization: Bearer $HINDSIGHT_API_KEY"} \
  --data-binary "@${INPUT}" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories"
