#!/usr/bin/env bash
# Git askpass helper for Dagu safe-publish.
#
# Invoked by git when GIT_ASKPASS is set and the remote challenges
# for credentials. The prompt argument is the question git is
# asking (e.g. "Username for 'https://github.com'" or
# "Password for 'https://x-access-token@github.com'").
#
# We route by prompt string:
#   - Username prompt  -> emit the literal "x-access-token"
#     (matches the username already baked into the URL; this
#     lets git proceed to the password prompt without looping)
#   - Password prompt  -> emit the token from $GIT_READ_TOKEN,
#     terminated with a newline (git's askpass protocol reads
#     one line at a time; the newline is the canonical line
#     terminator)
#   - Anything else    -> same as Password (defensive fallback
#     for older git / go-git retry paths)
#
# The token is read from the caller's process env (the dagu
# step env, set by the dagu systemd EnvironmentFile
# /etc/alpha-lab/dagu.env). This script itself reads the var
# but does NOT log or echo the value beyond the final `printf`
# (which git consumes via fd 1 to satisfy the credential
# prompt).
#
# File mode: 0750, owner root:alpha-lab-dagu. alpha-lab-dagu
# needs read+execute (git runs this script as the calling user,
# which is alpha-lab-dagu). The token is not readable by other
# users.
#
# Why this exists: the prior pattern embedded the token in the
# git URL (`https://x-access-token:${TOKEN}@github.com/...`),
# which leaked the token to `ps`, dagu logs, and shell history.
# With askpass, the URL is `https://x-access-token@github.com/...`
# (username only), and the password flows over git's credential
# channel — not argv.
set -euo pipefail
: "${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in the dagu step env}"
case "${1:-}" in
  Username*) printf 'x-access-token\n' ;;
  *)         printf '%s\n' "${GIT_READ_TOKEN}" ;;
esac
