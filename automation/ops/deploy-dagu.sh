#!/usr/bin/env bash
# 把 alpha-lab dagu runtime 部署到 GCP VM。
#
# 注意:這是 ops script,不是 Dagu runtime 的一部分。Dagu
# step 不會叫它,只有人在 local 跑的時候用。
#
# 流程 (compose 模式):
#   1. 把 local `automation/` 目錄打包 (排除 secrets 跟
#      大型產物)
#   2. scp 到 VM + 解到 /opt/alpha-lab/automation (蓋掉前一次)
#   3. 更新 admin.yaml 到 /var/lib/alpha-lab/dagu/admin.yaml
#      (DAGU_HOME bind mount 進 dagu container,放這層 dagu
#      內部就讀得到)
#   4. systemctl reload alpha-lab-dagu.service (ExecReload =
#      `docker compose ... up -d --force-recreate`,dagu 跟
#      dags-sync 兩個 container 重建。dags 走 bind mount
#      /var/lib/alpha-lab/dagu/dags,資料跨 restart 保留。
#      dags-sync 第一次跑會 git clone 進 dags 子目錄,5-30s
#      內 dags 出現)
#   5. 等兩個 container 都 running (最多 30s)
#   6. verify:systemd active + 7 Phase 4 DAG YAML 在
#      /var/lib/alpha-lab/dagu/dags 都存在 + dagu http 200 +
#      dags-sync log
#
# 不做的事:
#   - 不會把 git branch 推到 origin (那個 user 自己做)
#   - 不會覆蓋 VM 上的 .env
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
# 從 main 拉到 `/var/lib/alpha-lab/dagu/dags`。舊的 `fixture-research`
# DAG 在 Phase 4 cutover 時已移除 — verifier 不列它,也不觸發任何
# live X / LLM / blog-publish code path。
set -euo pipefail

ZONE="asia-east1-b"
INSTANCE="alpha-lab"
PROJECT="g6online-352310"
SSH_CMD=(gcloud compute ssh --zone "${ZONE}" "${INSTANCE}" --project "${PROJECT}")
LOCAL_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

cd "${LOCAL_ROOT}"

echo "[1/6] packaging automation/ to /tmp/dagu-deploy.tar.gz"
TAR_FILE=$(mktemp /tmp/dagu-deploy-XXXXXX.tar.gz)
trap 'rm -f "${TAR_FILE}"' EXIT
tar --exclude='.env' \
    --exclude='.env.local' \
    --exclude='*.log' \
    --exclude='tests/.tmp' \
    --exclude='.git' \
    -czf "${TAR_FILE}" automation/
echo "    $(du -h "${TAR_FILE}" | cut -f1) packaged"

echo "[2/6] scp tar to VM + extract"
# 1. 清理舊 backup,只保留最近 1 個 automation.bak.* — 避免
#    每次 deploy 留一個舊 snapshot 在 /opt/alpha-lab/ 累積垃圾。
#    Sort by name(就是 timestamp)確保 stable order;head -n -1
#    留最新 1 個,把其餘砍掉。-print0/-0 處理任何奇怪檔名。
# 2. 把 timestamp 收進變數 TS,讓 rm 跟 mv 用同一個值,避免跨秒
#    時兩個 timestamp 不同的競態。第一次部署時 /opt/alpha-lab
#    /automation 還不存在,mv 會 "No such file or directory" 失敗
#    — 這是合法的 first-deploy 路徑,不是 deploy 錯。first-deploy
#    之後任何 mv 失敗 (磁碟滿、SELinux、container 還在用舊工作樹)
#    都是真的 deploy 錯,必須在 extract 之前 abort,否則 tar 解到
#    還沒搬走的舊 tree 上面會新舊混雜。
"${SSH_CMD[@]}" --command 'set -e; python3 -c "import subprocess; baks=sorted(__import__(\"glob\").glob(\"/opt/alpha-lab/automation.bak.*\")); baks=[p for p in baks if __import__(\"os\").path.isdir(p)]; [subprocess.check_call([\"/usr/bin/sudo\",\"rm\",\"-rf\",p]) for p in baks[:-1]]" || true; TS=$(date +%s); sudo rm -rf "/opt/alpha-lab/automation.bak.${TS}" 2>/dev/null; if [ -d /opt/alpha-lab/automation ]; then sudo mv /opt/alpha-lab/automation "/opt/alpha-lab/automation.bak.${TS}"; fi; sudo mkdir -p /opt/alpha-lab/automation && sudo chown $(whoami):$(id -gn) /opt/alpha-lab/automation; echo "    pruned old backups, kept latest, mv ok"'
gcloud compute scp --zone "${ZONE}" "${TAR_FILE}" "${INSTANCE}:/tmp/dagu-deploy.tar.gz" --project "${PROJECT}"
rm -f "${TAR_FILE}"
"${SSH_CMD[@]}" --command "cd /opt/alpha-lab/automation && sudo tar -xzf /tmp/dagu-deploy.tar.gz --strip-components=1 --no-same-owner && sudo chown -R \$(whoami):\$(id -gn) . && (shopt -s nullglob; for f in scripts/*.sh deploy/dagu/*.sh ops/*.sh; do [ -e \"\$f\" ] && sudo chmod +x \"\$f\" || true; done) && rm -f /tmp/dagu-deploy.tar.gz && echo '    extracted'"

echo "[3/6] update admin.yaml"
# admin.yaml 放 /var/lib/alpha-lab/dagu/admin.yaml,dagu container
# 透過 bind mount /var/lib/alpha-lab/dagu:/var/lib/alpha-lab/dagu
# 讀到,dagu internal 認這個路徑。
"${SSH_CMD[@]}" --command 'set -e
sudo install -m 0644 -o alpha-lab-dagu -g alpha-lab-dagu /opt/alpha-lab/automation/deploy/dagu/admin.yaml /var/lib/alpha-lab/dagu/admin.yaml
echo "    admin.yaml updated"'

echo "[4/6] systemctl reload alpha-lab-dagu.service"
# ExecReload = `docker compose ... up -d --force-recreate`。
# 兩個 container 都會重建;dags named volume 內資料保留,
# dags-sync 第一次跑會重新 git clone 進去。
"${SSH_CMD[@]}" --command 'set -e
sudo systemctl reload alpha-lab-dagu.service
echo "    reload issued"'

echo "[5/6] wait for containers"
# reload 後 dagu 跟 dags-sync 都需要時間起來 (force-recreate)。
# dags-sync 第一次跑要 git clone 進 named volume (5-30s)。
# 等到兩個 container 都是 running (注意 docker compose ps 的
# STATUS 欄位是 "Up" 不是 "running",別被大小寫搞混)。
"${SSH_CMD[@]}" --command 'set -e
cd /opt/alpha-lab/automation/deploy/dagu
for i in $(seq 1 30); do
  # grep -cE count >= 2:兩個 container (alpha-lab-dagu +
  # alpha-lab-dags-sync) 都要 running 才 break。原來的
  # grep -qE 是 OR 邏輯,第一個起來就 break,沒等 dags-sync。
  running=$(sudo /usr/bin/docker compose ps --status running 2>/dev/null | grep -cE "alpha-lab-dagu|alpha-lab-dags-sync")
  if [ "${running}" -ge 2 ]; then
    echo "    containers up after ${i}s"
    break
  fi
  sleep 1
done
sudo /usr/bin/docker compose ps'

echo "[6/6] verify"
# Phase 4 DAG 清單 — brief Step 2 要求 deploy verifier 證明這 7 個
# YAML 都已透過 dags-sync 從 main 拉到 /var/lib/alpha-lab/dagu/dags。
# `fixture-research.yaml` 在 Phase 4 cutover 時已移除(brief 計劃
# review checklist 第 3 條:舊 fixture DAG 跟 direct-fetch agent 同
# 一個 task 移除,沒有 compatibility path 留下)。Verifier 不列
# fixture-research,也不觸發任何 live X / LLM / blog-publish 的
# code path。
PHASE4_DAGS="blog-publish calibrate-signals ingest-events open-next-paper-bet publish-next-research research-next-event settle-paper-bets"
# 用 printf 把要送給 VM 的 shell command 組出來。PHASE4_DAGS
# (local variable) 在 printf argument list 展開成 DAG 清單字串;
# 其它每一行 VM-side 變數(${d}/${missing}/${running}/${code})都用
# 單引號包住,在 local shell 不展開,VM 上才展開。printf 也避免內
# 層 \\$var / \"\$var\" 容易踩到的引號配錯。
VERIFY_CMD=$(printf '%s\n' \
  'set -e' \
  'if ! sudo systemctl is-active --quiet alpha-lab-dagu.service; then' \
  '  echo "    ERROR: alpha-lab-dagu.service not active"' \
  '  sudo systemctl status alpha-lab-dagu.service --no-pager' \
  '  exit 1' \
  'fi' \
  'echo "    systemd: active"' \
  'cd /opt/alpha-lab/automation/deploy/dagu' \
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
  '# 兩個 Compose container 都 running — closure check(避免 step 5 等完到這裡又被任何 concurrent restart 弄掉)' \
  "running=\$(sudo /usr/bin/docker compose ps --status running 2>/dev/null | grep -cE 'alpha-lab-dagu|alpha-lab-dags-sync')" \
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