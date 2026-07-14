#!/usr/bin/env bash
# Git askpass helper for Dagu safe-publish.
#
# Invoked by git when GIT_ASKPASS is set and the remote challenges
# for credentials. Echoes the token from $GIT_READ_TOKEN (set by
# the caller via env). Used by clone-fixture.sh, clone-publish.sh,
# and the push step in blog-publish.yaml.
#
# The token is sourced from the caller's process env (the dagu
# step env, set by the dagu systemd EnvironmentFile
# /etc/alpha-lab/dagu.env). This script itself reads the var but
# does NOT log or echo the value beyond the final `printf` (which
# git consumes via fd 1 to satisfy the credential prompt).
#
# File mode: 0750, owner root:alpha-lab-dagu. alpha-lab-dagu needs
# read+execute (git runs this script as the calling user, which
# is alpha-lab-dagu). The token is not readable by other users.
#
# Why this exists: the prior pattern embedded the token in the
# git URL (`https://x-access-token:${TOKEN}@github.com/...`),
# which leaked the token to `ps`, dagu logs, and shell history.
# With askpass, the URL is `https://x-access-token@github.com/...`
# (username only), and the password flows over git's credential
# channel — not argv.
set -euo pipefail
: "${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in the dagu step env}"
printf '%s' "${GIT_READ_TOKEN}"
