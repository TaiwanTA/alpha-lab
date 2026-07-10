#!/usr/bin/env bash
# alpha-lab VM 部署腳本
#
# 用途:從 local workspace 部署最新 research/ + blog/ 到 VM,steps:
#   1. tar local code(排除 node_modules / .env / logs / drafts 等本地 artefact)
#   2. scp tar 到 VM
#   3. SSH 進 VM,解開、chown、復原 .env、bun install
#   4. 跑 migrate + workflow:setup + workflow:build
#   5. patch systemd unit(__PUBLISH_USER__ → 實際 user)+ cp 到 /etc/systemd/system
#   6. daemon-reload + restart workflow-server service
#   7. 驗證 /health
#
# 用法:
#   ./scripts/deploy-vm.sh                # 完整部署(含 systemd)
#   ./scripts/deploy-vm.sh --skip-systemd # 只 sync code + rebuild,不動 systemd
#   ./scripts/deploy-vm.sh --skip-build   # 只 sync code,不 bun install / migrate / build
#
# 前置條件:
#   - 已通過 `gcloud auth login` 跟 `gcloud config set project g6online-352310`
#   - VM 上 bun 已裝在 ~/.bun/bin
#   - VM 上 .env 已存在(首次部署需手動建立)
#   - alpha-lab-postgres container 已在 VM 上跑著
#
# 不做的事:
#   - 不會覆蓋 VM 上的 .env(secrets 只在 VM 維護)
#   - 不會自動 enable/disable systemd timer(部署只 restart service,timer 保持原狀)
#   - 不會 git push / merge(部署前 main 分支已經有最新 code)

set -euo pipefail

# ---- 參數解析 ----
SKIP_SYSTEMD=false
SKIP_BUILD=false
for arg in "$@"; do
  case "$arg" in
    --skip-systemd) SKIP_SYSTEMD=true ;;
    --skip-build) SKIP_BUILD=true ;;
    -h|--help)
      sed -n '2,/^$/p' "$0"
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 1
      ;;
  esac
done

# ---- 常數 ----
ZONE="asia-east1-b"
INSTANCE="alpha-lab"
PROJECT="g6online-352310"
VM_DEPLOY_DIR="/opt/alpha-lab"
VM_RESEARCH_DIR="${VM_DEPLOY_DIR}/research"
SSH_CMD="gcloud compute ssh --zone ${ZONE} ${INSTANCE} --project ${PROJECT}"
SCP_CMD="gcloud compute scp --zone ${ZONE}"

LOCAL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAR_FILE="/tmp/alpha-lab-deploy-$$.tar.gz"

echo "[1/7] packaging local code → ${TAR_FILE}"
cd "${LOCAL_ROOT}"
tar --exclude='research/node_modules' \
    --exclude='research/.env' \
    --exclude='research/.env.local' \
    --exclude='research/logs' \
    --exclude='research/drafts' \
    --exclude='research/.tmp-bundles' \
    --exclude='research/.well-known' \
    --exclude='research/.test-pg' \
    --exclude='research/.swc' \
    --exclude='research/.wf-bundles' \
    --exclude='research/bun.lock' \
    --exclude='blog/node_modules' \
    --exclude='blog/dist' \
    --exclude='blog/.astro' \
    --exclude='.git' \
    --exclude='*.log' \
    -czf "${TAR_FILE}" research/ blog/
echo "    $(du -h "${TAR_FILE}" | cut -f1) packaged"

echo "[2/7] scp tar to VM"
${SCP_CMD} "${TAR_FILE}" "${INSTANCE}:/tmp/alpha-lab-deploy.tar.gz" --project "${PROJECT}"
rm -f "${TAR_FILE}"

echo "[3/7] extract on VM + restore .env + chown"
${SSH_CMD} --command "
set -e
VM_USER=\$(whoami)
TIMESTAMP=\$(date +%Y%m%d-%H%M%S)

# 備份舊 research(含 .env),只在 research/ 存在時做
if [ -d '${VM_RESEARCH_DIR}' ]; then
  sudo cp -a '${VM_RESEARCH_DIR}' '${VM_RESEARCH_DIR}.bak.\${TIMESTAMP}'
  echo \"    backed up to ${VM_RESEARCH_DIR}.bak.\${TIMESTAMP}\"
fi

# 解開新 code(sudo 因為 /opt 通常 root-owned)
sudo mkdir -p '${VM_DEPLOY_DIR}'
sudo rm -rf '${VM_RESEARCH_DIR}'
sudo tar -xzf /tmp/alpha-lab-deploy.tar.gz -C '${VM_DEPLOY_DIR}/'
sudo chown -R \${VM_USER}:\${VM_USER} '${VM_RESEARCH_DIR}'

# 復原 .env(從剛 backup 抓)
if [ -f '${VM_RESEARCH_DIR}.bak.\${TIMESTAMP}/.env' ]; then
  cp '${VM_RESEARCH_DIR}.bak.\${TIMESTAMP}/.env' '${VM_RESEARCH_DIR}/.env'
  chmod 600 '${VM_RESEARCH_DIR}/.env'
  echo '    .env restored from backup'
else
  echo '    WARNING: no .env in backup! VM .env not set up — server will fail to start'
fi

# 復原 raw/(如果有)
if [ -d '${VM_RESEARCH_DIR}.bak.\${TIMESTAMP}/../raw' ] || [ -d '${VM_DEPLOY_DIR}/raw' ]; then
  # raw/ 在 research/ 之外的 VM_DEPLOY_DIR,不會被覆蓋,但確保 chown
  sudo chown -R \${VM_USER}:\${VM_USER} '${VM_DEPLOY_DIR}/raw' 2>/dev/null || true
fi

# 補上 workflow + logging 相關環境變數到 .env(若缺)
grep -q '^WORKFLOW_POSTGRES_URL=' '${VM_RESEARCH_DIR}/.env' 2>/dev/null || cat >> '${VM_RESEARCH_DIR}/.env' << 'ENVEOF'

# Vercel Workflow + Logging(自動 append by deploy-vm.sh)
WORKFLOW_POSTGRES_URL=postgres://alpha:change-me@localhost:5432/alpha_lab
WORKFLOW_TARGET_WORLD=@workflow/world-postgres
WORKFLOW_SERVER_PORT=8090
WORKFLOW_LOCAL_BASE_URL=http://127.0.0.1:8090
LOG_DIR=/var/log/alpha-lab
LOG_CONSOLE=false
ENVEOF
  echo '    appended workflow env vars to .env'
fi

# 從 .env 取 POSTGRES_PASSWORD 填入 WORKFLOW_POSTGRES_URL(避免 change-me 留著)
DB_PASS=\$(grep '^POSTGRES_PASSWORD=' '${VM_RESEARCH_DIR}/.env' | cut -d= -f2-)
if [ -n \"\${DB_PASS}\" ]; then
  sed -i \"s|WORKFLOW_POSTGRES_URL=.*|WORKFLOW_POSTGRES_URL=postgres://alpha:\${DB_PASS}@localhost:5432/alpha_lab|\" '${VM_RESEARCH_DIR}/.env'
fi

# 確保 LOG_DIR 存在
sudo mkdir -p /var/log/alpha-lab
sudo chown \${VM_USER}:\${VM_USER} /var/log/alpha-lab

echo '    VM code synced OK'
"

if [ "${SKIP_BUILD}" = "true" ]; then
  echo "[4-7] --skip-build, 跳過 bun install / migrate / build / systemd"
  exit 0
fi

echo "[4/7] bun install + migrate + workflow:setup + workflow:build(VM 上執行)"
${SSH_CMD} --command "
set -e
export PATH=\$HOME/.bun/bin:\$PATH
cd ${VM_RESEARCH_DIR}

echo '    bun install...'
bun install 2>&1 | tail -3

echo '    bun run migrate...'
bun run migrate 2>&1 | tail -5

echo '    bun run workflow:setup...'
bun run workflow:setup 2>&1 | tail -5

echo '    bun run workflow:build...'
bun run workflow:build 2>&1 | tail -5
echo '    build OK'
"

if [ "${SKIP_SYSTEMD}" = "true" ]; then
  echo "[5-7] --skip-systemd, 跳過 systemd unit 更新"
  echo "[7/7] 只重啟 workflow-server"
  ${SSH_CMD} --command "sudo systemctl restart alpha-lab-workflow.service"
  sleep 3
  ${SSH_CMD} --command "curl -sS http://127.0.0.1:8090/health"
  echo
  echo "Done (no systemd touched)"
  exit 0
fi

echo "[5/7] patch systemd unit(__PUBLISH_USER__ → 實際 user)+ cp"
${SSH_CMD} --command "
set -e
VM_USER=\$(whoami)

# 複製 unit 檔到 /tmp/sed patch 後 cp 到 /etc/systemd/system
sudo cp ${VM_RESEARCH_DIR}/deploy/systemd/alpha-lab-*.service /tmp/
sudo cp ${VM_RESEARCH_DIR}/deploy/systemd/alpha-lab-*.timer /tmp/
sudo sed -i \"s/__PUBLISH_USER__/\${VM_USER}/g\" /tmp/alpha-lab-*.service

# 4 個 oneshot trigger service + 1 個 workflow server
sudo cp /tmp/alpha-lab-*.service /etc/systemd/system/
sudo cp /tmp/alpha-lab-*.timer /etc/systemd/system/
sudo systemctl daemon-reload
echo '    systemd unit synced'
"

echo "[6/7] restart workflow-server"
${SSH_CMD} --command "
sudo systemctl restart alpha-lab-workflow.service
sleep 4
sudo systemctl status alpha-lab-workflow.service --no-pager 2>&1 | head -8
"

echo "[7/7] 驗證 /health"
HEALTH=$(${SSH_CMD} --command "curl -sS http://127.0.0.1:8090/health 2>&1" 2>&1)
echo "    ${HEALTH}"

if echo "${HEALTH}" | grep -q '"status":"ok"'; then
  echo "✓ 部署完成"
else
  echo "✗ server 沒回 health OK,看 journal 找原因:"
  echo "    sudo journalctl -u alpha-lab-workflow.service -n 30 --no-pager"
  exit 1
fi
