#!/usr/bin/env bash
# Hermes CLI wrapper for Dagu.
#
# Reads the prompt from $1 (a file path) and invokes the hermes CLI
# inside the `hermes-hermes-1` container via `docker exec`. The
# container is on the shared `hindsight-net` docker network and is
# started by the `hermes` compose at /opt/hermes/hermes. The CLI
# uses the model configured in /opt/data/config.yaml (currently
# `MiniMax-M3` via `minimax-oauth`).
#
# Why docker exec instead of HTTP:
#   - Hermes v0.18.0 has no OpenAI-compatible HTTP endpoint. The
#     `gateway` subcommand is messaging-only; `proxy` only supports
#     nous/xai; `serve` is the JSON-RPC backend for the desktop
#     app. The CLI is the only path that uses the configured
#     `minimax-oauth` provider with the configured model.
#
# This script runs inside the alpha-lab-dagu container, which
# mounts /var/run/docker.sock so the `docker` CLI is available and
# so `docker exec hermes-hermes-1 ...` works.
set -eo pipefail

PROMPT_FILE="${1:?usage: hermes-call.sh <prompt-file>}"
PROFILE="${HERMES_PROFILE:-alpha-lab-fixture}"
: "${HINDSIGHT_BASE_URL:?HINDSIGHT_BASE_URL must be set in the dagu container env}"
: "${HINDSIGHT_BANK_ID:?HINDSIGHT_BANK_ID must be set in the dagu container env}"
: "${HINDSIGHT_API_KEY:=}"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "prompt file not found: $PROMPT_FILE" >&2
  exit 2
fi

PROMPT="$(cat "$PROMPT_FILE")"
echo "=== hermes-call === profile=$PROFILE prompt_len=${#PROMPT} bank=$HINDSIGHT_BANK_ID"

# `hermes -z PROMPT` runs the agent non-interactively with the
# given prompt and prints the agent's final answer to stdout. The
# CLI config in /opt/data/config.yaml selects the model. Profile
# `-p alpha-lab-fixture` is a single-shot session.
#
# We pass HINDSIGHT_* into the container so the hermes tooling
# (if any) can reach Hindsight over the shared docker network.
docker exec \
  -e HINDSIGHT_BASE_URL="$HINDSIGHT_BASE_URL" \
  -e HINDSIGHT_API_KEY="$HINDSIGHT_API_KEY" \
  -e HINDSIGHT_BANK_ID="$HINDSIGHT_BANK_ID" \
  hermes-hermes-1 \
  hermes -p "$PROFILE" -z "$PROMPT"
