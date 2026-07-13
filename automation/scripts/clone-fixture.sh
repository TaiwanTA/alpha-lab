#!/usr/bin/env bash
# Fixture checkout wrapper for Dagu safe-publish rebuild.
# Reads $GIT_READ_TOKEN from /etc/alpha-lab/dagu.env (EnvironmentFile for
# alpha-lab-dagu.service). dagu 2.10.7 does not propagate process env
# into run-step shells, so we source the env file ourselves.
set -eo pipefail
set +u
. /etc/alpha-lab/dagu.env
set -u
: ${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in /etc/alpha-lab/dagu.env}
export GIT_TERMINAL_PROMPT=0
echo "=== clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN}"
mkdir -p ./workspace
git clone --depth 1 -b main   "https://x-access-token:${GIT_READ_TOKEN}@github.com/TaiwanTA/alpha-lab.git"   ./workspace/app
