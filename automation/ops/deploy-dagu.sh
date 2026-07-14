#!/usr/bin/env bash
# 把 alpha-lab dagu runtime 部署到 GCP VM。
#
# 注意:這是 ops script,不是 Dagu runtime 的一部分。Dagu
# step 不會叫它,只有人在 local 跑的時候用。
#
# 流程:
#   1. 把 local `automation/` 目錄打包 (排除 secrets 跟
#      大型產物)
#   2. 透過 `gcloud compute ssh` 把 tarball 傳到 VM
#   3. 在 VM 上解到 /opt/alpha-lab (蓋掉前一次的部署)
#   4. 把 DAG 檔 cp 到 /var/lib/alpha-lab/dagu/dags/
#      (dagu 監看這個目錄)
#   5. 設定 git-askpass.sh 為 mode 0750 root:alpha-lab-dagu
#      (讓 alpha-lab-dagu 可以讀+執行,其他 user 不行)
#   6. 更新 admin.yaml (systemd unit 本身在第一次部署時就建好)
#   7. daemon-reload + restart
#
# 不做的事:
#   - 不會把 git branch 推到 origin (那個 user 自己做)
#   - 不會覆蓋 VM 上的 .env
#   - 不會動 systemd timer (只 restart service)
#
# 用法:
#   ./ops/deploy-dagu.sh

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
# 把 timestamp 收進變數 TS,讓 rm 跟 mv 用同一個值,避免跨秒
# 時兩個 timestamp 不同的競態。第一次部署時 /opt/alpha-lab
# /automation 還不存在,mv 會 "No such file or directory" 失敗
# — 這是合法的 first-deploy 路徑,不是 deploy 錯。first-deploy
# 之後任何 mv 失敗 (磁碟滿、SELinux、container 還在用舊工作樹)
# 都是真的 deploy 錯,必須在 extract 之前 abort,否則 tar 解到
# 還沒搬走的舊 tree 上面會新舊混雜。
#
# 區分兩種情況:remote 先 probe 來源 dir,只有存在才 mv。
"${SSH_CMD[@]}" --command "TS=\$(date +%s); sudo rm -rf /opt/alpha-lab/automation.bak.\$TS 2>/dev/null; if [ -d /opt/alpha-lab/automation ]; then sudo mv /opt/alpha-lab/automation /opt/alpha-lab/automation.bak.\$TS; fi; sudo mkdir -p /opt/alpha-lab/automation && sudo chown \$(whoami):\$(id -gn) /opt/alpha-lab/automation"
gcloud compute scp --zone "${ZONE}" "${TAR_FILE}" "${INSTANCE}:/tmp/dagu-deploy.tar.gz" --project "${PROJECT}"
rm -f "${TAR_FILE}"
"${SSH_CMD[@]}" --command "cd /opt/alpha-lab/automation && sudo tar -xzf /tmp/dagu-deploy.tar.gz --strip-components=1 --no-same-owner && sudo chown -R \$(whoami):\$(id -gn) . && sudo chmod +x scripts/*.sh ops/*.sh && rm -f /tmp/dagu-deploy.tar.gz && echo '    extracted'"

echo "[3/5] cp DAGs + perms for git-askpass.sh"
# 把 shopt -s nullglob 的範圍限在 for 迴圈內 (開 + 關),讓
# 後續的 chown/chmod *.yaml 在目錄是空的情況下能 fail loud
# (set -e 下 chmod 空字串會觸發 abort,而不是無聲成功)。
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
# git-askpass.sh 必須 alpha-lab-dagu 可讀+可執行 (git 用
# 呼叫端 user fork 它),其他 user 不可讀。
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
