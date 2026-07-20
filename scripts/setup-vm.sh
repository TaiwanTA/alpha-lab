#!/usr/bin/env bash
# setup-vm.sh — 在一台新的 GCP VM 上把 alpha-lab runtime 完整架起來。
#
# 這支腳本設計目標：把「alpha-lab-dagu user / SSH deploy key /
# /etc/alpha-lab/secrets.env / docker compose / systemd unit」
# 全部打包成可重跑的單一 entry point。新 VM 跑一次就具備跟
# production 等價的 dagu runtime。
#
# 已知先決條件（在跑這支之前必須先完成）：
#   - GCP VM 已建好並用 SSH 可連
#   - docker 已裝（docker version >= 20）
#   - VM 可連線到 ghcr.io 與 GitHub
#   - /etc/alpha-lab/stack.env（image tag、Hindsight DB URL 等 interpolation
#     變數）已由受控流程建立（本腳本會檢查）
#   - 執行者可提供 GHCR PAT（read:packages scope）
#
# VM 不需要 alpha-lab source checkout；這支腳本會把 canonical
# Compose 檔安裝到 /opt/alpha-lab，runtime 都在 GHCR image 內。
#
# 步驟：
#   1. 建立 alpha-lab-dagu user（uid=999、gid=982）
#   2. 建立 Dagu state 跟 SSH 目錄
#   3. SSH deploy key
#   4. 互動讀 secrets 寫入 /etc/alpha-lab/secrets.env
#   5. 安裝 canonical Compose 與 systemd unit
#   6. 檢查 stack.env + secrets.env
#   7. GHCR login
#   8. docker compose pull
#   9. systemctl start
#   10. verify
#
# Idempotent：重跑不會破壞既有狀態；既有 user、state、key、secrets.env
# 與 named volumes 都會保留。
#
# 互動模式：每個 secret 值用 read -s 隱藏輸入。
#
# PR 3 變更：
#   - 5 個 per-service secrets 檔（dagu.env / hindsight.env /
#     hindsight-db.env / research-postgres.env / mastra.env）合併為
#     單一 /etc/alpha-lab/secrets.env（所有服務可見，試驗專案接受
#     橫向暴露 — blast radius 1→5 可接受）
#   - 兩個 postgres（hindsight-db / alpha-lab-postgres）共用同一組
#     POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_DB 變數
#     （兩個 pgdata volume 物理隔離，user 共用不影響資料）
#   - 從 `automation/scripts/` 搬到 root `scripts/`（ops 跟 runtime 分離）

set -euo pipefail

# 這支腳本呼叫者必須是一般 user（透過 sudo 提權），不是 root 直接跑。
if [ "${EUID:-$(id -u)}" -eq 0 ]; then
  echo "ERROR: 不要用 root 跑這支，請用一般 user + sudo 權限" >&2
  echo "       (個別指令已內含 sudo，不要 prefix sudo 跑整支)" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
CANONICAL_COMPOSE_SRC="${REPO_ROOT}/compose.yml"
if [ ! -f "${CANONICAL_COMPOSE_SRC}" ]; then
  echo "ERROR: 找不到 ${CANONICAL_COMPOSE_SRC}." >&2
  echo "       compose.yml 位於 repository root，請確保已將 compose.yml 與 scripts/ 一併複製到 VM 上." >&2
  exit 1
fi
CANONICAL_COMPOSE_TARGET="/opt/alpha-lab/compose.yml"
SYSTEMD_UNIT_SRC="${REPO_ROOT}/automation/deploy/dagu/alpha-lab-dagu.service"
SYSTEMD_UNIT_TARGET="/etc/systemd/system/alpha-lab-dagu.service"
SECRETS_ENV_TARGET="/etc/alpha-lab/secrets.env"
STACK_ENV_TARGET="/etc/alpha-lab/stack.env"
SSH_DIR="/var/lib/alpha-lab/dagu/.ssh"
SSH_KEY="${SSH_DIR}/id_ed25519"
DAGU_HOME="/var/lib/alpha-lab/dagu"

# === 步驟 1: user ===
echo "[1/10] 建立 alpha-lab-dagu user (uid=999, gid=982)"
if ! id alpha-lab-dagu >/dev/null 2>&1; then
  sudo groupadd -g 982 alpha-lab-dagu
  sudo useradd -u 999 -g 982 -d "${DAGU_HOME}" -s /usr/sbin/nologin alpha-lab-dagu
fi

# === 步驟 2: dirs ===
echo "[2/10] 建立 dagu state 跟 ssh 目錄"
sudo mkdir -p "${DAGU_HOME}/data" "${DAGU_HOME}/logs"
# DAG 現在 bake 進 image，dags_dir 在 image 內（/opt/alpha-lab/automation/dags），
# host bind mount 不需要 dags 子目錄。
sudo chown -R alpha-lab-dagu:alpha-lab-dagu "${DAGU_HOME}"
sudo chmod 0750 "${DAGU_HOME}"

# === 步驟 3: SSH deploy key ===
echo "[3/10] SSH deploy key (git@github.com:TaiwanTA/alpha-lab)"
sudo mkdir -p "${SSH_DIR}"
sudo chmod 0700 "${SSH_DIR}"
# chown 給 alpha-lab-dagu：sudo mkdir 預設 root:root，後續 ssh-keygen /
# ssh-keyscan 要用 alpha-lab-dagu 跑會被擋。
sudo chown alpha-lab-dagu:alpha-lab-dagu "${SSH_DIR}"
if [ -f "${SSH_KEY}" ]; then
  echo "    既有 ${SSH_KEY} 保留"
else
  echo "    需要 SSH deploy key:"
  echo "      a) 從 backup 還原"
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
# 預先放 github.com host key，避免 blog-publish git fetch/push 卡在
# "authenticity of host" prompt。用 >> (append) 避免 ssh-keyscan
# 失敗（DNS/網路）時清空既有 known_hosts。只在 ssh-keyscan 有輸出時才寫入。
if ! sudo -u alpha-lab-dagu ssh-keyscan -t ed25519,rsa,ecdsa github.com 2>/dev/null \
  | sudo -u alpha-lab-dagu tee -a "${SSH_DIR}/known_hosts" >/dev/null; then
  echo "    WARNING: ssh-keyscan 失敗，known_hosts 未更新" >&2
fi
sudo chmod 0644 "${SSH_DIR}/known_hosts"

# === 步驟 4: secrets.env ===
echo "[4/10] /etc/alpha-lab/secrets.env (互動讀值)"
sudo mkdir -p /etc/alpha-lab
if [ -f "${SECRETS_ENV_TARGET}" ]; then
  echo "    既有 ${SECRETS_ENV_TARGET} 保留 (刪除檔案後重跑才會重新生成)"
else
  # 用 temp file 收集 secret 再 install 到目標路徑：
  # 避免 `sudo tee -a` 把 secret value 放進 argv（會落到
  # /var/log/audit/audit.log 的 EXECVE 記錄）。secret 只走 file content，
  # argv 只有 install 跟 temp file 路徑。
  TMP_ENV=$(mktemp)
  trap 'rm -f "${TMP_ENV}"' EXIT

  # secrets.env 用的所有 key 列表（按 service 分組註解）
  # alpha-lab-dagu 容器：
  read_secret() {
    local key="$1" prompt_msg="$2" default_val="${3:-}"
    local value=""
    if [ -n "${default_val}" ]; then
      read -r -s -p "    ${prompt_msg} [default: ${default_val}]= " value < /dev/tty
      echo
      [ -z "${value}" ] && value="${default_val}"
    else
      read -r -s -p "    ${prompt_msg}= " value < /dev/tty
      echo
      if [ -z "${value}" ]; then
        echo "    ERROR: ${key} 不可為空" >&2
        exit 1
      fi
    fi
    printf '%s=%s\n' "${key}" "${value}" >> "${TMP_ENV}"
  }

  read_secret DATABASE_URL "Postgres connection string (postgres://USER:PASS@alpha-lab-postgres:5432/DB)"
  read_secret MINIMAX_API_KEY "MiniMax LLM API key"
  read_secret X_BEARER_TOKEN "X (Twitter) bearer token"
  read_secret TWELVE_DATA_API_KEY "Twelve Data API key"
  read_secret GIT_READ_TOKEN "GitHub fine-grained PAT (Contents: Read)"
  read_secret GH_PR_TOKEN "GitHub fine-grained PAT (Contents: Read + Pull requests: Write)"
  read_secret POSTGRES_USER "Postgres user (共用於 hindsight-db + alpha-lab-postgres)"
  read_secret POSTGRES_PASSWORD "Postgres password (共用於兩個 postgres)"
  read_secret POSTGRES_DB "Postgres database name (共用於兩個 postgres)"

  sudo install -m 0640 -o root -g alpha-lab-dagu "${TMP_ENV}" "${SECRETS_ENV_TARGET}"
  rm -f "${TMP_ENV}"
  trap - EXIT
  echo "    已寫入 ${SECRETS_ENV_TARGET} (mode 0640 root:alpha-lab-dagu)"
fi

# === 步驟 5: canonical Compose 檔與 systemd unit ===
echo "[5/10] 安裝 canonical Compose 與 systemd unit"
sudo mkdir -p "$(dirname "${CANONICAL_COMPOSE_TARGET}")"
sudo install -m 0644 "${CANONICAL_COMPOSE_SRC}" "${CANONICAL_COMPOSE_TARGET}"
sudo install -m 0644 "${SYSTEMD_UNIT_SRC}" "${SYSTEMD_UNIT_TARGET}"
sudo systemctl daemon-reload
sudo systemctl enable alpha-lab-dagu.service

# === 步驟 6: 檢查 stack.env 與 secrets.env ===
if [ ! -f "${STACK_ENV_TARGET}" ]; then
  echo "ERROR: 缺少 ${STACK_ENV_TARGET}，請先建立（內容見 compose.yml 內 interpolation 變數）" >&2
  exit 1
fi
for required_file in "${STACK_ENV_TARGET}" "${SECRETS_ENV_TARGET}"; do
  if [ ! -f "${required_file}" ]; then
    echo "ERROR: 缺少 ${required_file}" >&2
    exit 1
  fi
done

# === 步驟 7: GHCR login ===
echo "[7/10] GHCR login (需要 read:packages PAT)"
read -r -s -p "    GHCR PAT (read:packages)= " GHCR_PAT < /dev/tty
echo
if [ -z "${GHCR_PAT}" ]; then
  echo "ERROR: GHCR PAT 不可為空" >&2
  exit 1
fi
printf '%s' "${GHCR_PAT}" | sudo docker login ghcr.io -u taiwanta --password-stdin
unset GHCR_PAT

# === 步驟 8: docker compose pull ===
echo "[8/10] docker compose pull"
sudo docker compose --env-file "${STACK_ENV_TARGET}" \
  -f "${CANONICAL_COMPOSE_TARGET}" pull

# === 步驟 9: 啟動 systemd 服務 ===
echo "[9/10] systemctl start alpha-lab-dagu.service"
sudo systemctl start alpha-lab-dagu.service

# === 步驟 10: verify ===
echo "[10/10] verify"
sleep 4
if curl -fsS -o /dev/null -w "    dagu http: %{http_code}\n" http://127.0.0.1:8080/; then
  echo "    DONE — alpha-lab runtime 已就緒"
else
  echo "    ERROR: dagu http 不可達，看 journalctl 跟 docker logs" >&2
  sudo journalctl -u alpha-lab-dagu.service --since "1m ago" --no-pager
  sudo docker logs alpha-lab-dagu 2>&1 | tail -30
  exit 1
fi
