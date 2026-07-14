#!/usr/bin/env bash
# Fixture checkout wrapper for Dagu safe-publish rebuild.
# Reads $GIT_READ_TOKEN from /etc/alpha-lab/dagu.env (EnvironmentFile
# for alpha-lab-dagu.service). dagu 2.10.7 does not propagate
# process env into run-step shells, so we source the env file
# ourselves.
#
# Branch note: the fixture content (automation/fixtures/safe-publish.md
# and automation/prompts/fixture-research.md) currently lives on
# `rebuild/integrate`, not on `main`. Until that branch merges, this
# wrapper pins the checkout to `rebuild/integrate`. After merge, change
# `-b rebuild/integrate` back to `-b main` and re-deploy.
#
# Credential handling: the token is provided to git via the
# git-askpass.sh helper (GIT_ASKPASS). The URL carries only the
# username `x-access-token`; the password flows over git's
# credential channel, not through argv. This keeps the token out
# of `ps`, dagu logs, and shell history.
set -eo pipefail
set +u
if [[ ! -f /etc/alpha-lab/dagu.env ]]; then
  echo "/etc/alpha-lab/dagu.env not found" >&2
  exit 2
fi
. /etc/alpha-lab/dagu.env
set -u
: ${GIT_READ_TOKEN:?GIT_READ_TOKEN must be set in /etc/alpha-lab/dagu.env}
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS=/opt/alpha-lab/automation/scripts/git-askpass.sh
export GIT_ASKPASS_REQUIRE_FORCE=1  # only ask when needed; never block on stdin
echo "=== clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN} ref=rebuild/integrate"
# Clean any stale workspace from a prior failed run; otherwise
# git clone fails with "destination path already exists".
rm -rf ./workspace
mkdir -p ./workspace
git clone --depth 1 -b rebuild/integrate \
  "https://x-access-token@github.com/TaiwanTA/alpha-lab.git" \
  ./workspace/app
