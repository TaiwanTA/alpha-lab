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
#   5. Updates the admin.yaml on the VM (the systemd unit itself
#      is already in place from the first deploy);
#   6. daemon-reload + restart if the unit changed.
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
"${SSH_CMD[@]}" --command "sudo rm -rf /opt/alpha-lab/automation.bak.\$(date +%s) 2>/dev/null; sudo mv /opt/alpha-lab/automation /opt/alpha-lab/automation.bak.\$(date +%s) 2>/dev/null || true; sudo mkdir -p /opt/alpha-lab/automation && sudo chown \$(whoami):\$(id -gn) /opt/alpha-lab/automation"
gcloud compute scp --zone "${ZONE}" "${TAR_FILE}" "${INSTANCE}:/tmp/dagu-deploy.tar.gz" --project "${PROJECT}"
rm -f "${TAR_FILE}"
"${SSH_CMD[@]}" --command "cd /opt/alpha-lab/automation && sudo tar -xzf /tmp/dagu-deploy.tar.gz --strip-components=1 --no-same-owner && sudo chown -R \$(whoami):\$(id -gn) . && sudo chmod +x scripts/*.sh && rm -f /tmp/dagu-deploy.tar.gz && echo '    extracted'"

echo "[3/5] cp DAGs to /var/lib/alpha-lab/dagu/dags/"
# Use single-quoted remote heredoc to keep globs and
# dollar-signs literal until they execute on the VM.
"${SSH_CMD[@]}" --command 'set -e
for f in /opt/alpha-lab/automation/dags/*.yaml; do
  sudo cp -f "$f" /var/lib/alpha-lab/dagu/dags/
done
sudo chown alpha-lab-dagu:alpha-lab-dagu /var/lib/alpha-lab/dagu/dags/*.yaml
sudo chmod 0644 /var/lib/alpha-lab/dagu/dags/*.yaml
ls -la /var/lib/alpha-lab/dagu/dags/ | head -20
echo "    dags copied"'

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
