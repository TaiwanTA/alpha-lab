#!/usr/bin/env bash
# setup-vm.sh — 在一台新的 GCP VM 上把 alpha-lab dagu runtime
# 完整架起來。
#
# 這支腳本設計目標:把「alpha-lab-dagu user / SSH deploy key /
# dagu.env / docker compose / systemd unit」全部打包成可重跑
# 的單一 entry point。新 VM 跑一次就具備跟現有 production
# 等價的 dagu runtime。
#
# 已知先決條件 (在跑這支之前必須先完成):
#   - GCP VM 已建好並用 `gcloud compute ssh` 可連
#   - docker 已裝 (docker version >= 20)
#   - dagu image `ghcr.io/dagu-org/dagu:2.10.7` 可 pull
#     (ghcr.io 需要 login 或 public access)
#   - hindsight-net 外部 docker network 已建好
#     (Hindsight container 跟 alpha-lab-dagu 共用)
#   - /opt/alpha-lab/automation/ 已被 deploy-dagu.sh 部署進來
#     (見 AGENTS.md「部署流程」)
#
# 步驟:
#   1. 建立 alpha-lab-dagu user (uid=999, gid=982)
#   2. 建 /var/lib/alpha-lab/dagu/{,data,logs} + dags-dirs
#   3. 生成或還原 SSH deploy key
#      (備援用 — 互動讀 public key path,或用 backup)
#   4. 從 dagu.env.template 生成 /etc/alpha-lab/dagu.env
#      (互動讀 secret 值,不入 repo)
#   5. cp systemd unit + systemctl daemon-reload + enable
#   6. 預先建 hindsight-net (如果還沒)
#   7. docker compose pull
#   8. docker compose up -d
#   9. verify (curl dagu http base URL)
#
# Idempotent:重跑不會破壞既有狀態。`useradd` 重複跑會跳過,
# `mkdir -p` 不會壞,systemd unit 永遠覆蓋,`docker compose
# up -d` 沒變更就不做事。
#
# 互動模式:每個 secret 值用 read -s 隱藏輸入,非 secret 用
# read。沒有 --batch / non-interactive mode — 這是故意,新 VM
# 設置是 user-driven 操作,不是 CI 流程。

set -euo pipefail

# 這支腳本呼叫者必須是一般 user (透過 sudo 提權),不是
# root 直接跑。原因:
#   - sudo 提權讓個別指令的權限問題能即時浮現
#     (e.g. 檔案 owner / group membership / sudoers 設定),
#     用 root 跑會把這層訊號壓平
#   - 互動讀 SSH deploy key / secrets 應該由真人操作,不是
#     CI / unattended 流程
#   - 跟 deploy-dagu.sh 慣例一致 (它也假設 caller 是一般 user)
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo "ERROR: 不要用 root 跑這支,請用一般 user + sudo 權限" >&2
  echo "       (個別指令已內含 sudo,不要 prefix sudo 跑整支)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DAGU_DEPLOY_DIR="${REPO_ROOT}/deploy/dagu"
DAGU_ENV_TEMPLATE="${DAGU_DEPLOY_DIR}/dagu.env.template"
DAGU_ENV_TARGET="/etc/alpha-lab/dagu.env"
SYSTEMD_UNIT_SRC="${DAGU_DEPLOY_DIR}/alpha-lab-dagu.service"
SYSTEMD_UNIT_TARGET="/etc/systemd/system/alpha-lab-dagu.service"
SSH_DIR="/var/lib/alpha-lab/dagu/.ssh"
SSH_KEY="${SSH_DIR}/id_ed25519"
DAGU_HOME="/var/lib/alpha-lab/dagu"
DAGS_HOME="/var/lib/alpha-lab/dagu-dags"

# === 步驟 1: user ===
echo "[1/9] 建立 alpha-lab-dagu user (uid=999, gid=982)"
if ! id alpha-lab-dagu >/dev/null 2>&1; then
  sudo groupadd -g 982 alpha-lab-dagu
  sudo useradd -u 999 -g 982 -d "${DAGU_HOME}" -M -s /bin/bash alpha-lab-dagu
fi

# === 步驟 2: dirs ===
echo "[2/9] 建立 dagu state 跟 dags dirs"
sudo mkdir -p "${DAGU_HOME}/data" "${DAGU_HOME}/logs" "${DAGS_HOME}"
sudo chown -R alpha-lab-dagu:alpha-lab-dagu "${DAGU_HOME}" "${DAGS_HOME}"
sudo chmod 0750 "${DAGU_HOME}"
sudo chmod 0755 "${DAGS_HOME}"

# === 步驟 3: SSH deploy key ===
echo "[3/9] SSH deploy key (git@github.com:TaiwanTA/alpha-lab)"
sudo mkdir -p "${SSH_DIR}"
sudo chmod 0700 "${SSH_DIR}"
# chown 給 alpha-lab-dagu:sudo mkdir 預設是 root:root,後續
# ssh-keygen / ssh-keyscan 要用 alpha-lab-dagu 跑會被擋。
sudo chown alpha-lab-dagu:alpha-lab-dagu "${SSH_DIR}"
if [ -f "${SSH_KEY}" ]; then
  echo "    既有 ${SSH_KEY} 保留"
else
  echo "    需要 SSH deploy key:"
  echo "      a) 從 backup 還原 (PR #20 之前產生的 key)"
  echo "      b) 現場 ssh-keygen 並在 GitHub repo 註冊"
  read -r -p "    選 a 或 b: " KEY_CHOICE
  case "${KEY_CHOICE}" in
    a)
      read -r -p "    backup private key 絕對路徑: " KEY_SRC
      sudo install -m 0600 -o alpha-lab-dagu -g alpha-lab-dagu "${KEY_SRC}" "${SSH_KEY}"
      ;;
    b)
      sudo -u alpha-lab-dagu ssh-keygen -t ed25519 -C "alpha-lab-dagu@$(hostname)" -f "${SSH_KEY}" -N ""
      echo
      echo "    把以下 public key 加到 GitHub repo Settings > Deploy keys:"
      sudo cat "${SSH_KEY}.pub"
      echo
      read -r -p "    按 Enter 繼續 (確認已加進 GitHub)..."
      ;;
    *)
      echo "ERROR: 未知選項" >&2
      exit 1
      ;;
  esac
fi
# 預先放 github.com host key,避免 dags-sync 第一次 git pull
# 卡在 "authenticity of host" prompt。
sudo -u alpha-lab-dagu ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null \
  | sudo -u alpha-lab-dagu tee "${SSH_DIR}/known_hosts" >/dev/null
sudo chmod 0644 "${SSH_DIR}/known_hosts"

# === 步驟 4: dagu.env ===
echo "[4/9] /etc/alpha-lab/dagu.env (互動讀值)"
if [ -f "${DAGU_ENV_TARGET}" ]; then
  echo "    既有 ${DAGU_ENV_TARGET} 保留 (刪除檔案後重跑才會重新生成)"
else
  sudo mkdir -p /etc/alpha-lab
  sudo touch "${DAGU_ENV_TARGET}"
  sudo chmod 0640 "${DAGU_ENV_TARGET}"
  sudo chown root:alpha-lab-dagu "${DAGU_ENV_TARGET}"
  # 從 template 抓 keys,互動讀值
  while IFS= read -r line; do
    case "${line}" in
      ""|\#*) continue ;;
      *=*)
        key="${line%%=*}"
        if [ "${key}" = "NAME" ]; then
          # NAME 預設值,跳過
          continue
        fi
        if [ "${key}" = "HINDSIGHT_API_KEY" ]; then
          # self-hosted Hindsight 不用 key,跳過 (但保留行)
          continue
        fi
        if [ "${key}" = "PUBLISH_TOKEN" ]; then
          # PR #21 之後 blog publish 改 SSH deploy key,
          # PUBLISH_TOKEN 暫停用,跳過
          continue
        fi
        # 一般 secret
        read -r -s -p "    ${key}= " value
        echo
        echo "${key}=${value}" | sudo tee -a "${DAGU_ENV_TARGET}" >/dev/null
        ;;
    esac
  done < "${DAGU_ENV_TEMPLATE}"
  # NAME 預設值
  echo "NAME=alpha-lab-dagu" | sudo tee -a "${DAGU_ENV_TARGET}" >/dev/null
fi

# === 步驟 5: systemd unit ===
echo "[5/9] systemd unit"
sudo install -m 0644 "${SYSTEMD_UNIT_SRC}" "${SYSTEMD_UNIT_TARGET}"
sudo systemctl daemon-reload
sudo systemctl enable alpha-lab-dagu.service

# === 步驟 6: hindsight-net ===
echo "[6/9] docker network hindsight-net"
if ! docker network ls --format '{{.Name}}' | grep -qx hindsight-net; then
  docker network create --driver bridge hindsight-net
fi

# === 步驟 7: docker compose pull ===
echo "[7/9] docker compose pull"
cd "${DAGU_DEPLOY_DIR}"
docker compose pull

# === 步驟 8: docker compose up ===
echo "[8/9] docker compose up -d"
docker compose up -d --remove-orphans

# === 步驟 9: verify ===
echo "[9/9] verify"
sleep 4
if curl -fsS -o /dev/null -w "    dagu http: %{http_code}\n" http://127.0.0.1:8080/; then
  echo "    dags-sync container logs (last 20 lines):"
  docker logs --tail 20 alpha-lab-dags-sync 2>&1 | sed 's/^/      /'
  echo
  echo "    DONE — alpha-lab dagu runtime 已就緒"
else
  echo "    ERROR: dagu http 不可達,看 journalctl 跟 docker logs"
  sudo journalctl -u alpha-lab-dagu.service --since "1m ago" --no-pager
  docker logs alpha-lab-dagu 2>&1 | tail -30
  exit 1
fi
