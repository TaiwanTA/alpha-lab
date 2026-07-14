#!/usr/bin/env bash
# Hermes CLI wrapper for Dagu.
#
# Reads the prompt body from $HERMES_PROMPT (env) and runs the
# hermes CLI inside a one-shot container based on the
# `nousresearch/hermes-agent:latest` image (the same image the
# long-running `hermes-hermes-1` gateway is built on). We use
# `docker run --rm` (not `docker exec`) because bind mounts are
# only available at `docker run` time. The model config in
# /opt/data lives on a host bind-mount; we re-bind the same path
# so the agent picks up the same `minimax-oauth` config and
# profile state as the gateway.
#
# Profile: defaults to the `default` profile, which is the only
# one with the `MiniMax-M3` model configured.
#
# Network URL override: $HINDSIGHT_BASE_URL is the host-loopback
# URL (`http://127.0.0.1:8888`) when sourced from the dagu env
# file, but inside the one-shot container that 127.0.0.1 is the
# container's own loopback, not the host. We override to the
# docker network alias `hindsight-hindsight-1:8888` (other
# container on `hindsight-net`).
#
# Entrypoint override: the image's default entrypoint is an s6
# init that supervises the hermes gateway. We override with
# `--entrypoint ""` to run hermes directly as PID 1, so s6 does
# not interpret our SIGTERM as a shutdown signal.
#
# Write target: the dagu step's workspace is bind-mounted :rw
# (the wrapper uses `--user 0:0` so the in-container root can
# write to the host dir). The agent writes the candidate to
# $ALPHA_LAB_CANDIDATE_PATH; the dagu step then `cat`s it.
#
# Exit-code handling: hermes's safety guard may reject
# `write_file` to certain paths and exit non-zero even after the
# model produces a valid response. We capture the exit code and
# keep it for the post-run check:
#   - exit 0                  → success
#   - exit != 0 AND candidate on disk and non-empty
#                            → soft fail (write-guard refused the
#                              write, but the model produced a
#                              usable candidate via stdout). The
#                              dagu step succeeds; stderr is left
#                              on disk for debug.
#   - exit != 0 AND no candidate
#                            → hard fail. The dagu step fails.
# Stderr is redirected to `${WORKDIR}/.hermes-stderr.log` (mode
# 0600) so it's available for postmortem without polluting the
# contract stdout.
#
# Env resolution: see hindsight-retain.sh.
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

# Inside the one-shot container, 127.0.0.1 is the container's
# own loopback. Use the docker network alias instead.
CONTAINER_HINDSIGHT_URL="http://hindsight-hindsight-1:8888"

echo "=== hermes-call === profile=$HERMES_PROFILE prompt_len=${#HERMES_PROMPT} host_path=$ALPHA_LAB_CANDIDATE_PATH image=$HERMES_IMAGE bank=$HINDSIGHT_BANK_ID hindsight_url=$CONTAINER_HINDSIGHT_URL"

HERMES_STDERR="${HOST_DIR}/.hermes-stderr.log"
: > "$HERMES_STDERR"
chmod 0600 "$HERMES_STDERR" 2>/dev/null || true

# `--user 0:0` runs the agent as root in the container so the
# :rw bind mount is fully usable. stdout goes to the dagu
# step's stdout (which dagu captures as the `candidate.md`
# artifact via `stdout: { artifact: ... }` in the YAML).
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
  > "$ALPHA_LAB_CANDIDATE_PATH" 2> "$HERMES_STDERR"
HERMES_EXIT=$?

# Empty candidate + non-zero exit → hard fail.
if [ ! -s "$ALPHA_LAB_CANDIDATE_PATH" ]; then
  echo "candidate file is empty or missing; hermes exited $HERMES_EXIT" >&2
  echo "see $HERMES_STDERR for details" >&2
  exit 1
fi

if [ "$HERMES_EXIT" -ne 0 ]; then
  # Non-zero but candidate is present: this is the design's
  # soft-fail path (hermes safety guard rejected the file write
  # but the model produced a usable candidate via stdout). Log
  # a warning but exit 0 so dagu doesn't retry.
  echo "hermes exited $HERMES_EXIT but candidate.md was produced (likely write-guard refusal); see $HERMES_STDERR" >&2
fi

echo "wrote candidate to $ALPHA_LAB_CANDIDATE_PATH ($(wc -c < "$ALPHA_LAB_CANDIDATE_PATH") bytes)"
