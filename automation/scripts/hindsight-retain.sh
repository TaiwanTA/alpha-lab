#!/usr/bin/env bash
# Hindsight retain wrapper for Dagu.
#
# Reads a facts JSON document from $1 (file path) and POSTs it to
# the Hindsight retain endpoint for bank $HINDSIGHT_BANK_ID. Used
# during the fixture-research DAG to retain the offline fixture's
# `safe-publish.md` content as facts.
#
# Hindsight v0.8.4 retain schema: the request body is
# `{"items": [{"content": "...", "context": "..."}, ...]}`.
# The `facts` alias is NOT accepted; the field is `items`.
# The endpoint is `POST /v1/default/banks/{bank_id}/memories`.
#
# Env resolution: this wrapper runs as a child of the dagu process
# (which is on the host's network namespace). The dagu service
# unit's EnvironmentFile is /etc/alpha-lab/dagu.env; we source it
# here to get HINDSIGHT_BASE_URL etc.  dagu 2.10.7 does not
# propagate process env into run-step shells, so the source is
# explicit.
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

# Diagnostic on stderr; stdout is the contract (Hindsight JSON
# response).
echo "=== hindsight-retain === bank=$HINDSIGHT_BANK_ID file=$INPUT" >&2

# Bash array avoids word-splitting if HINDSIGHT_API_KEY ever
# contains whitespace or shell metacharacters (the env file is
# root:alpha-lab-dagu 0440; defensive all the same).
CURL_ARGS=(-fsS -X POST -H "Content-Type: application/json")
if [[ -n "${HINDSIGHT_API_KEY}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${HINDSIGHT_API_KEY}")
fi
CURL_ARGS+=(--data-binary "@${INPUT}")

curl "${CURL_ARGS[@]}" \
  "${HINDSIGHT_BASE_URL}/v1/default/banks/${HINDSIGHT_BANK_ID}/memories"
