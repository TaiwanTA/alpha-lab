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

COMPOSE_FILE="${LOCAL_ROOT}/automation/deploy/dagu/docker-compose.yml"

echo "[1/5] scp compose 檔到 VM"
gcloud compute scp --zone "${ZONE}" "${COMPOSE_FILE}" \
  "${INSTANCE}:/tmp/alpha-lab-docker-compose.yml" --project "${PROJECT}"
"${SSH_CMD[@]}" --command 'set -e
sudo mkdir -p /etc/alpha-lab
sudo install -m 0644 /tmp/alpha-lab-docker-compose.yml /etc/alpha-lab/docker-compose.yml
rm -f /tmp/alpha-lab-docker-compose.yml
echo "    /etc/alpha-lab/docker-compose.yml installed"'

echo "[2/5] docker compose pull"
"${SSH_CMD[@]}" --command 'set -e
cd /etc/alpha-lab
sudo /usr/bin/docker compose pull
echo "    images pulled from GHCR"'

echo "[3/5] systemctl reload alpha-lab-dagu.service"
# ExecReload = `docker compose ... up -d --force-recreate`。
# 兩個 container 都會重建;dags bind mount 內資料保留。
"${SSH_CMD[@]}" --command 'set -e
sudo systemctl reload alpha-lab-dagu.service
echo "    reload issued"'

echo "[4/5] wait for containers"
# reload 後 dagu 跟 dags-sync 都需要時間起來 (force-recreate)。
"${SSH_CMD[@]}" --command 'set -e
cd /etc/alpha-lab
for i in $(seq 1 30); do
  # 兩個 container 都 running 才繼續,不能只等其中一個。
  running=$(sudo /usr/bin/docker compose ps --status running 2>/dev/null \
    | grep -cE "alpha-lab-dagu|alpha-lab-dags-sync" || true)
  if [ "${running}" -ge 2 ]; then
    echo "    containers up after ${i}s"
    break
  fi
  sleep 1
done
sudo /usr/bin/docker compose ps'

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
  'cd /etc/alpha-lab' \
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
  '# 兩個 Compose container 都 running — closure check' \
  "running=\$(sudo /usr/bin/docker compose ps --status running 2>/dev/null | grep -cE 'alpha-lab-dagu|alpha-lab-dags-sync' || true)" \
  'if [ "${running}" -lt 2 ]; then' \
  '  echo "    ERROR: expected 2 compose containers running, got ${running}"' \
  '  sudo /usr/bin/docker compose ps' \
  '  exit 1' \
  'fi' \
  'echo "    compose containers: ${running}/2 running"' \
  "code=\$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/)" \
  'if [ "${code}" != "200" ]; then' \
  '  echo "    ERROR: dagu http ${code}"' \
  '  echo "    dagu container tail (debug):"' \
  '  sudo docker logs --tail 30 alpha-lab-dagu 2>&1 | sed "s/^/      /"' \
  '  exit 1' \
  'fi' \
  'echo "    dagu http: 200"' \
  'echo "    dags-sync tail:"' \
  'sudo docker logs --tail 5 alpha-lab-dags-sync 2>&1 | sed "s/^/      /"')
"${SSH_CMD[@]}" --command "${VERIFY_CMD}"
