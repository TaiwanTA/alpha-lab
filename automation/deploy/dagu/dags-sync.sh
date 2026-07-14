#!/bin/sh
# dags-sync.sh — sidecar entrypoint,跑在 alpha-lab-dags-sync container 內。
#
# 功能:把 alpha-lab repo 的 automation/dags/ 同步到 dags_dir
# (跟 dagu container 共享的 named volume)。
#
# 第一次啟動:`git clone --branch <branch> --filter=blob:none
# --sparse <repo> /tmp/repo`,然後 `git sparse-checkout set
# <path>`,最後把 `<path>` 內容 rsync 到 ${DAG_SYNC_TARGET}。
# 之後每 ${DAG_SYNC_INTERVAL} 秒跑 `git pull && rsync`。
#
# Auth:SSH deploy key (bind mount /home/alpha-lab-dagu/.ssh/
# 進 container),GIT_SSH_COMMAND 已預先設 StrictHostKeyChecking
# =accept-new + IdentitiesOnly=yes。
#
# Failure mode:任何 git/rsync 失敗都 log + 等待下次 interval
# (不 crash container),這樣 sidecar 比 dagu 短暫 off-line
# 不會打斷 dagu 排程。dagu 內建 watch dags_dir 變更,新檔
# 落地會自動 reload。
#
# 安裝:此檔 bind mount 進 container /usr/local/bin/dags-sync.sh
# (見 docker-compose.yml dags-sync service)。
#
# 環境變數:
#   DAG_SYNC_REPO     — git URL (default git@github.com:TaiwanTA/alpha-lab.git)
#   DAG_SYNC_BRANCH   — branch (default main)
#   DAG_SYNC_PATH     — repo 內 subpath (default automation/dags)
#   DAG_SYNC_INTERVAL — 秒數 (default 300)
#   DAG_SYNC_TARGET   — 目標 dir (default /var/lib/alpha-lab/dagu/dags)
#   GIT_SSH_COMMAND   — git 走 SSH 的 command (compose 注入)

set -eu

REPO="${DAG_SYNC_REPO:-git@github.com:TaiwanTA/alpha-lab.git}"
BRANCH="${DAG_SYNC_BRANCH:-main}"
PATH_IN_REPO="${DAG_SYNC_PATH:-automation/dags}"
INTERVAL="${DAG_SYNC_INTERVAL:-300}"
TARGET="${DAG_SYNC_TARGET:-/var/lib/alpha-lab/dagu/dags}"
CLONE_DIR="/tmp/repo"

export GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new}"

log() {
  echo "[dags-sync $(date -u +%FT%TZ)] $*"
}

sync_once() {
  if [ ! -d "${CLONE_DIR}/.git" ]; then
    log "first-time clone of ${REPO} (branch=${BRANCH})"
    git clone --branch "${BRANCH}" --filter=blob:none --sparse --depth 1 \
      "${REPO}" "${CLONE_DIR}" || {
        log "ERROR: git clone failed"
        return 1
      }
    git -C "${CLONE_DIR}" sparse-checkout set "${PATH_IN_REPO}" || {
      log "ERROR: sparse-checkout set ${PATH_IN_REPO} failed"
       # 清掉殘留的 .git 目錄,讓下次 sync 重新 clone
       # (否則 git clone 成功但 sparse-checkout 失敗時,
        # 下次會走 git pull 分支但 sparse-checkout 未設定)
       rm -rf "${CLONE_DIR}"
      return 1
    }
  else
    git -C "${CLONE_DIR}" pull --depth 1 origin "${BRANCH}" || {
      log "ERROR: git pull failed (will retry in ${INTERVAL}s)"
      return 1
    }
  fi

  if [ ! -d "${CLONE_DIR}/${PATH_IN_REPO}" ]; then
    log "ERROR: ${PATH_IN_REPO} not found in clone (path changed upstream?)"
    return 1
  fi

  # rsync -a 保留 mode/mtime/owner,dagu 跟 sidecar 都用 999:982
  # 寫,owner 會一致;新檔案 owner 由 rsync 推導 = sidecar user
  # (999:982),跟 dagu 讀寫一致。
  #
  # --exclude='.dagu' --exclude='.git' 保護 dags_dir 內既有的
  # dagu metadata 跟其他非 source 檔,避免 rsync --delete 砍掉。
  rsync -a --delete \
   --exclude='.dagu' \
   --exclude='.git' \
   "${CLONE_DIR}/${PATH_IN_REPO}/" "${TARGET}/" || {
    log "ERROR: rsync to ${TARGET} failed"
    return 1
  }

  log "synced $(find "${TARGET}" -maxdepth 1 -name '*.yaml' | wc -l) DAG file(s) to ${TARGET}"
}

log "starting dags-sync (repo=${REPO} branch=${BRANCH} path=${PATH_IN_REPO} interval=${INTERVAL}s target=${TARGET})"

while true; do
  sync_once || true
  sleep "${INTERVAL}"
done
