#!/usr/bin/env bash
# Publish-side checkout wrapper for Dagu safe-publish rebuild.
#
# Same git+token dance as clone-fixture.sh, but clones the
# publish-side worktree (./workspace/publish) instead of the
# research-side worktree (./workspace/app). The blog-publish
# sub-DAG's checkout step delegates here for the same reason:
# Dagu 2.10.7's git.checkout uses go-git which fails on
# fine-grained PATs.
#
# Branch: we clone `rebuild/integrate` (not main) because the
# `automation/` directory — including `automation/scripts/publish-draft.ts`
# and the publish-side test fixtures — only exists on the
# integration branch. main has the blog but not the publisher.
# The push step in blog-publish.yaml also targets
# `rebuild/integrate` so the round trip stays on the same
# branch. Switch the clone ref + push ref together once
# `rebuild/integrate` is merged to main.
#
# Credential handling: see clone-fixture.sh.
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
export GIT_ASKPASS_REQUIRE_FORCE=1
echo "=== publish-clone === GIT_READ_TOKEN length: ${#GIT_READ_TOKEN} ref=rebuild/integrate"
rm -rf ./workspace
mkdir -p ./workspace
git clone --depth 1 -b rebuild/integrate \
  "https://x-access-token@github.com/TaiwanTA/alpha-lab.git" \
  ./workspace/publish
