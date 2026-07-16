#!/usr/bin/env bash
# 把 alpha-lab dagu runtime 部署到 GCP VM。
#
# 注意:這是 ops script,不是 Dagu runtime 的一部分。Dagu
# step 不會叫它,只有人在 local 跑的時候用。
#
# 流程 (compose 模式):
#   1. 把 compose 檔部署到 VM 的 /etc/alpha-lab/
#   2. 從 GHCR pull 最新 runtime images (VM 必須先完成 ghcr.io
#      login,使用 read:packages scope 的 PAT)
#   3. systemctl reload alpha-lab-dagu.service,以
#      `docker compose ... up -d --force-recreate` 重建服務。
#      dags 走 bind mount /var/lib/alpha-lab/dagu/dags,資料跨
#      restart 保留。
#   4. 等兩個 container 都 running (最多 30s)
#   5. verify:systemd active + 7 個 DAG YAML 在 dags volume
#      都存在 + dagu http 200。
#
# 不做的事:
#   - 不會把整個 automation/ source tree 傳到 VM；scripts 都在 image
#   - 不會更新 admin.yaml；它已由 image bootstrap 或 state volume 保留
#   - 不會覆蓋 VM 上的 dagu.env
#   - 不會動 dags 內容 (改由 dags-sync sidecar 從 git pull)
#   - 不會動 SSH deploy key (由 setup-vm.sh 一次性處理)
#
# 第一次切換:跟 dagu native binary 模式轉換到 compose 模式
# 時,這支腳本要額外做:
#   - systemctl stop alpha-lab-dagu.service (停 native)
#   - cp automation/deploy/dagu/alpha-lab-dagu.service
#     /etc/systemd/system/alpha-lab-dagu.service (改為 compose
#     wrapper)
#   - systemctl daemon-reload + start alpha-lab-dagu.service
#   - dags 不需要搬家:/var/lib/alpha-lab/dagu/dags 在
#     native 跟 compose 模式都一樣 (bind mount 子目錄)
# 切換流程見 automation/scripts/setup-vm.sh 跟 AGENTS.md。
#
# 用法:
#   ./ops/deploy-dagu.sh
#
# Phase 4 update (Task 5 brief Step 2):step 6 verifier 從原本
# 「systemd active + dagu http 200 + dags-sync log」擴充為也
# 檢查 7 個 Phase 4 DAG YAML (`blog-publish`, `calibrate-signals`,
# `ingest-events`, `open-next-paper-bet`, `publish-next-research`,
# `research-next-event`, `settle-paper-bets`) 都已由 dags-sync
# 從 main 拉到 `/var/lib/alpha-lab/dagu/dags`。舊的
# `fixture-research` DAG 在 Phase 4 cutover 時已移除 — verifier
# 不列它,也不觸發任何 live X / LLM / blog-publish code path。
#
set -euo pipefail

ZONE="asia-east1-b"
INSTANCE="alpha-lab"
PROJECT="g6online-352310"
SSH_CMD=(gcloud compute ssh --zone "${ZONE}" "${INSTANCE}" --project "${PROJECT}")
LOCAL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "${LOCAL_ROOT}"

COMPOSE_FILE="${LOCAL_ROOT}/automation/deploy/docker-compose.yml"

echo "[1/5] 部署 canonical Compose 到 VM 正式路徑"
gcloud compute scp --zone "${ZONE}" "${COMPOSE_FILE}" \
  "${INSTANCE}:/tmp/alpha-lab-docker-compose.yml" --project "${PROJECT}"
"${SSH_CMD[@]}" --command 'set -e
sudo mkdir -p /opt/alpha-lab/automation/deploy
sudo install -m 0644 /tmp/alpha-lab-docker-compose.yml /opt/alpha-lab/automation/deploy/docker-compose.yml
rm -f /tmp/alpha-lab-docker-compose.yml
sudo test -f /etc/alpha-lab/stack.env
echo "    /opt/alpha-lab/automation/deploy/docker-compose.yml installed"'

echo "[2/5] docker compose pull"
"${SSH_CMD[@]}" --command 'set -e
sudo /usr/bin/docker compose --env-file /etc/alpha-lab/stack.env \
  -f /opt/alpha-lab/automation/deploy/docker-compose.yml pull
echo "    images pulled"'

echo "[3/5] systemctl reload alpha-lab-dagu.service"
# ExecReload 會以 canonical Compose 重建六個服務，且不刪除任何 volume。
"${SSH_CMD[@]}" --command 'set -e
sudo systemctl reload alpha-lab-dagu.service
echo "    reload issued"'

echo "[4/5] wait for six services"
"${SSH_CMD[@]}" --command 'set -e
for i in $(seq 1 60); do
  running=$(sudo docker ps --filter label=com.docker.compose.project=alpha-lab \
    --format "{{.Names}}" | grep -cE "^(alpha-lab-dagu|alpha-lab-dags-sync|hindsight|hindsight-db|alpha-lab-postgres|mastra-app)$" || true)
  if [ "${running}" -ge 6 ]; then
    echo "    six services running after ${i}s"
    break
  fi
  sleep 1
done
sudo /usr/bin/docker compose --env-file /etc/alpha-lab/stack.env \
  -f /opt/alpha-lab/automation/deploy/docker-compose.yml ps'


echo "[5/5] verify"
# Phase 4 DAG 清單 — deploy verifier 證明這 7 個 YAML
# 都已透過 dags-sync 從 main 拉到 /var/lib/alpha-lab/dagu/dags。
PHASE4_DAGS="blog-publish calibrate-signals ingest-events open-next-paper-bet publish-next-research research-next-event settle-paper-bets"
# 用 printf 把要送給 VM 的 shell command 組出來。PHASE4_DAGS
# (local variable) 在 printf argument list 展開成 DAG 清單字串;
# 其它 VM-side 變數都用單引號包住,在 VM 上才展開。
VERIFY_CMD=$(printf '%s\n' \
  'set -e' \
  'if ! sudo systemctl is-active --quiet alpha-lab-dagu.service; then' \
  '  echo "    ERROR: alpha-lab-dagu.service not active"' \
  '  sudo systemctl status alpha-lab-dagu.service --no-pager' \
  '  exit 1' \
  'fi' \
  'echo "    systemd: active"' \
  '  cd /opt/alpha-lab' \
  '  sudo test -f /etc/alpha-lab/stack.env' \
  '  compose() { sudo /usr/bin/docker compose --env-file /etc/alpha-lab/stack.env -f /opt/alpha-lab/automation/deploy/docker-compose.yml "$@"; }' \
  'missing=0' \
  "for d in ${PHASE4_DAGS}; do" \
  '  if sudo test -f "/var/lib/alpha-lab/dagu/dags/${d}.yaml"; then' \
  '    echo "    dag: ${d}.yaml present"' \
  '  else' \
  '    echo "    ERROR: dag ${d}.yaml missing in /var/lib/alpha-lab/dagu/dags"' \
  '    missing=1' \
  '  fi' \
  'done' \
  'if [ "${missing}" -ne 0 ]; then' \
  '  echo "    dags-sync tail (debug):"' \
  '  sudo docker logs --tail 20 alpha-lab-dags-sync 2>&1 | sed "s/^/      /"' \
  '  exit 1' \
  'fi' \
  '# 六個服務都必須 running；四個有 healthcheck 的服務都必須 healthy' \
  '  expected="alpha-lab-dagu alpha-lab-dags-sync hindsight hindsight-db alpha-lab-postgres mastra-app"' \
  '  for c in ${expected}; do' \
  '    state=$(sudo docker inspect -f "{{.State.Status}}" "${c}" 2>/dev/null || true)' \
  '    if [ "${state}" != "running" ]; then' \
  '      echo "    ERROR: ${c} state=${state}"' \
  '      compose ps' \
  '      exit 1' \
  '    fi' \
  '  done' \
  '  for c in hindsight hindsight-db alpha-lab-postgres mastra-app; do' \
  '    health=$(sudo docker inspect -f "{{.State.Health.Status}}" "${c}" 2>/dev/null || true)' \
  '    if [ "${health}" != "healthy" ]; then' \
  '      echo "    ERROR: ${c} health=${health}"' \
  '      sudo docker logs --tail 30 "${c}" 2>&1 | sed "s/^/      /"' \
  '      exit 1' \
  '    fi' \
  '  done' \
  '  echo "    compose services: 6/6 running; healthchecks passed"' \
  "  code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)" \
  '  if [ "${code}" != "200" ]; then' \
  '    echo "    ERROR: dagu http ${code}"' \
  '    sudo docker logs --tail 30 alpha-lab-dagu 2>&1 | sed "s/^/      /"' \
  '    exit 1' \
  '  fi' \
  '  echo "    dagu http: 200"' \
  '  hindsight_code=$(curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:8888/health || true)' \
  '  if [ "${hindsight_code}" != "200" ]; then' \
  '    echo "    ERROR: hindsight api ${hindsight_code}"' \
  '    exit 1' \
  '  fi' \
  '  echo "    hindsight api: 200"' \
  '  mastra_code=$(curl -sS -o /dev/null -w "%{http_code}" http://127.0.0.1:4111/health || true)' \
  '  if [ "${mastra_code}" != "200" ]; then' \
  '    echo "    ERROR: mastra api ${mastra_code}"' \
  '    exit 1' \
  '  fi' \
  '  echo "    mastra api: 200"' \
  '  echo "    dags-sync tail:"' \
  '  sudo docker logs --tail 5 alpha-lab-dags-sync 2>&1 | sed "s/^/      /"')