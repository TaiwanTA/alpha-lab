#!/usr/bin/env bash
# Deploy the alpha-lab dagu runtime to the GCP VM.
#
# This script:
#   1. Tars the local `automation/` directory (excluding secrets
#      and large artefacts);
#   2. Pipes the tarball over `gcloud compute ssh` to the VM;
#   3. Extracts to /opt/alpha-lab on the VM (overwriting the
#      previous deploy);
#   4. Copies the DAG files to
#      /var/lib/alpha-lab/dagu/dags/ (which dagu watches);
#   5. Sets mode 0750 root:alpha-lab-dagu on git-askpass.sh
#      (so alpha-lab-dagu can read+execute it; no other user can);
#   6. Updates the admin.yaml on the VM (the systemd unit itself
#      is already in place from the first deploy);
#   7. daemon-reload + restart.
#
# It does NOT push the git branch to origin; the user does that
# separately.
#
# Usage:
#   ./scripts/deploy-dagu.sh

set -euo pipefail

ZONE="asia-east1-b"
INSTANCE="alpha-lab"
PROJECT="g6online-352310"
SSH_CMD=(gcloud compute ssh --zone "${ZONE}" "${INSTANCE}" --project "${PROJECT}")
LOCAL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "${LOCAL_ROOT}"

echo "[1/5] packaging automation/ to /tmp/dagu-deploy.tar.gz"
TAR_FILE=$(mktemp /tmp/dagu-deploy-XXXXXX.tar.gz)
trap 'rm -f "${TAR_FILE}"' EXIT
tar --exclude='node_modules' \
    --exclude='.env' \
    --exclude='.env.local' \
    --exclude='*.log' \
    --exclude='tests/.tmp' \
    --exclude='.git' \
    -czf "${TAR_FILE}" automation/
echo "    $(du -h "${TAR_FILE}" | cut -f1) packaged"

echo "[2/5] scp tar to VM + extract"
# Capture the timestamp once so the bak dir and its removal use
# the same value. The first deploy has no prior
# /opt/alpha-lab/automation to back up, in which case the mv
# fails with "No such file or directory" — that's the legitimate
# first-deploy path, not a deploy error. After the first deploy
# any mv failure (disk full, SELinux, container holding the old
# tree) IS a deploy error and must abort before we extract on
# top of a half-moved tree.
#
# To distinguish the two cases, the remote probe checks for the
# source dir first; mv is only attempted if the dir exists.
"${SSH_CMD[@]}" --command "TS=\$(date +%s); sudo rm -rf /opt/alpha-lab/automation.bak.\$TS 2>/dev/null; if [ -d /opt/alpha-lab/automation ]; then sudo mv /opt/alpha-lab/automation /opt/alpha-lab/automation.bak.\$TS; fi; sudo mkdir -p /opt/alpha-lab/automation && sudo chown \$(whoami):\$(id -gn) /opt/alpha-lab/automation"
gcloud compute scp --zone "${ZONE}" "${TAR_FILE}" "${INSTANCE}:/tmp/dagu-deploy.tar.gz" --project "${PROJECT}"
rm -f "${TAR_FILE}"
"${SSH_CMD[@]}" --command "cd /opt/alpha-lab/automation && sudo tar -xzf /tmp/dagu-deploy.tar.gz --strip-components=1 --no-same-owner && sudo chown -R \$(whoami):\$(id -gn) . && sudo chmod +x scripts/*.sh && rm -f /tmp/dagu-deploy.tar.gz && echo '    extracted'"

echo "[3/5] cp DAGs + perms for git-askpass.sh"
# Scope shopt -s nullglob to the `for` loop only (via a subshell
# with `set +o nullglob` on exit), so the subsequent chown/chmod
# `*.yaml` lines still see the literal pattern if the dir is
# empty (in which case they should fail loudly under set -e,
# not silently chmod the empty string).
"${SSH_CMD[@]}" --command 'set -e
DAGS_SRC=/opt/alpha-lab/automation/dags
DAGS_DST=/var/lib/alpha-lab/dagu/dags
shopt -s nullglob
for f in "$DAGS_SRC"/*.yaml; do
  sudo cp -f "$f" "$DAGS_DST/"
  sudo chown alpha-lab-dagu:alpha-lab-dagu "$DAGS_DST/$(basename "$f")"
  sudo chmod 0644 "$DAGS_DST/$(basename "$f")"
done
shopt -u nullglob
ls -la "$DAGS_DST/" | head -20
echo "    dags copied"
# git-askpass.sh must be readable+executable by alpha-lab-dagu
# (git forks it as the calling user) and by no one else.
if [ -f /opt/alpha-lab/automation/scripts/git-askpass.sh ]; then
  sudo chown root:alpha-lab-dagu /opt/alpha-lab/automation/scripts/git-askpass.sh
  sudo chmod 0750 /opt/alpha-lab/automation/scripts/git-askpass.sh
  echo "    git-askpass.sh perms set"
fi'

echo "[4/5] update admin.yaml + restart dagu"
"${SSH_CMD[@]}" --command 'set -e
sudo cp /opt/alpha-lab/automation/deploy/dagu/admin.yaml /var/lib/alpha-lab/dagu/admin.yaml
sudo chown alpha-lab-dagu:alpha-lab-dagu /var/lib/alpha-lab/dagu/admin.yaml
sudo systemctl restart alpha-lab-dagu.service
sleep 4
sudo systemctl status alpha-lab-dagu.service --no-pager | head -10
echo "---"
curl -s -o /dev/null -w "GET / -> %{http_code}\n" http://127.0.0.1:8080/'

echo "[5/5] done"
