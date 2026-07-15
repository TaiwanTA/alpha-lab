#!/usr/bin/env bash
# automation/scripts/verify-compose.sh
#
# In-container readiness check for the Phase 4 DAG runtime. Designed to be
# `docker exec`'d into the running `alpha-lab-dagu` container (or run
# manually inside a Dagu step) to prove that every external boundary a
# Phase 4 DAG touches is reachable *before* any real X / Twelve Data /
# Hindsight / LLM traffic is enabled.
#
# 這個 script 是 brief Step 1 規定的 deploy verification checklist。
# 它的位置在 automation/scripts/ — 由 `ops/deploy-dagu.sh` step 6 透過
# `docker exec alpha-lab-dagu bash /opt/alpha-lab/automation/scripts/
# verify-compose.sh` 觸發,或被人工 `gcloud compute ssh ... -- docker
# exec` 單獨驗證。
#
# 檢查項目:
#   1. Bun 版本 >= 1.3.0(Phase 4 必須用 bun built-in SQL + pi-agent-
#      core;舊版不支援)
#   2. PostgreSQL 連線(走 DATABASE_URL)— 一個 SELECT 1,確認 driver
#      跟 bind-mounted DATABASE_URL 都活
#   3. pi-agent-core + pi-ai 兩個 package 都可 import(Phase 4 的
#      research 流程依賴這兩個)
#
# Exit code 0 = 全部通過;非零 = 任何一項失敗。
#
# 注意:
#   - 不觸發任何外部 API(X / Twelve Data / Hindsight retain /
#     LLM / blog push)。Hindsight 跟 LLM 在 step 4 個別 DAG 內 smoke
#     test,這裡只證明 process 環境與 DB 邊界。
#   - 這個 script 不動 dagsync 內容、不動 admin.yaml、不動
#     /etc/alpha-lab/dagu.env。Read-only 驗證。
#   - DATABASE_URL 必須存在於 process env;container mode 下由
#     docker-compose env_file 注入。
#
# Bash 細節:
#   - 不用 `set -e` — 每個 check 用 fail() 累加 fail_count 並回報
#     個別失敗訊息,這樣一份 log 看得到哪幾項掛了。
#   - bun subprocess 用 redirect-to-file + `bun ... || EXIT=$?`
#     才能抓到真正的 exit code(直接 `$(bun ...)` 在 `||` 之後
#     會被 assignment 吞掉 exit code)。
#   - DATABASE_URL / HINDSIGHT_* 要 export 出去給 bun subprocess,
#     否則 `bun -e '...'` 的 process.env 看不到。
set -uo pipefail

# 顏色 — fail 訊息在 dagu log 比較容易看
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

fail_count=0
pass() {
  echo -e "  ${GREEN}PASS${NC}  $1"
}
fail() {
  echo -e "  ${RED}FAIL${NC}  $1"
  fail_count=$((fail_count + 1))
}
section() {
  echo -e "${YELLOW}== $1 ==${NC}"
}

# ---------------------------------------------------------------------------
# Step 0: PATH + env vars — container 內 dagu process 的 PATH 不一定
# 包含 ~/.bun/bin(降權後 shell 不繼承 root 的 PATH),先 export 一
# 次。這跟 DAG step 內 `export PATH="$HOME/.bun/bin:$PATH"` 同模式。
# ---------------------------------------------------------------------------
export PATH="$HOME/.bun/bin:$PATH"

# 把 DATABASE_URL / HINDSIGHT_* export 出去給 bun subprocess
# (subprocess 的 process.env 預設只看 export 過的 var)。
if [ -n "${DATABASE_URL:-}" ]; then
  export DATABASE_URL
fi
# 2>/dev/null || true 確保 unset 也不會 fail script
export HINDSIGHT_BASE_URL HINDSIGHT_API_KEY HINDSIGHT_BANK_ID 2>/dev/null || true

# ---------------------------------------------------------------------------
# Step 1: bun 版本
# ---------------------------------------------------------------------------
section "1/3  bun version"

if ! command -v bun >/dev/null 2>&1; then
  fail "bun not found in PATH (looked in \$HOME/.bun/bin: $HOME/.bun/bin)"
  echo
  echo "verify-compose: cannot continue without bun"
  exit 1
fi

BUN_VERSION="$(bun --version)"
# bun --version 輸出像 "1.3.14",parse major.minor
BUN_MAJOR="$(echo "${BUN_VERSION}" | cut -d. -f1)"
BUN_MINOR="$(echo "${BUN_VERSION}" | cut -d. -f2)"
if [ "${BUN_MAJOR}" -ge 1 ] && [ "${BUN_MINOR}" -ge 3 ]; then
  pass "bun ${BUN_VERSION} (>= 1.3)"
else
  fail "bun ${BUN_VERSION} is older than required 1.3.x"
fi

# ---------------------------------------------------------------------------
# Step 2: PostgreSQL 連線 (Bun built-in SQL)
# ---------------------------------------------------------------------------
section "2/3  PostgreSQL connectivity (Bun SQL)"

if [ -z "${DATABASE_URL:-}" ]; then
  fail "DATABASE_URL is unset (compose env_file or systemd EnvironmentFile required)"
else
  DB_OUTPUT="$(mktemp)"
  bun -e '
    import { SQL } from "bun";
    const url = process.env.DATABASE_URL;
    if (!url) { process.stderr.write("DATABASE_URL missing\n"); process.exit(2); }
    const db = new SQL(url);
    try {
      const rows = await db`SELECT 1 AS ok`;
      await db.close();
      process.stdout.write(JSON.stringify({ ok: rows.length === 1, rows: rows.length }));
    } catch (err) {
      process.stderr.write(`db error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(3);
    }
  ' >"${DB_OUTPUT}" 2>&1
  DB_EXIT=$?
  DB_RESULT="$(cat "${DB_OUTPUT}")"
  rm -f "${DB_OUTPUT}"
  if [ "${DB_EXIT}" -eq 0 ] && echo "${DB_RESULT}" | grep -q '"ok":true'; then
    pass "PostgreSQL responded: ${DB_RESULT}"
  else
    fail "PostgreSQL check failed (exit ${DB_EXIT}): ${DB_RESULT}"
  fi
fi

# ---------------------------------------------------------------------------
# Step 3: pi-agent-core + pi-ai import
# ---------------------------------------------------------------------------
section "3/3  pi-agent-core + pi-ai imports"

PI_OUTPUT="$(mktemp)"
bun -e '
  let ok = true;
  const errors = [];
  for (const pkg of ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai"]) {
    try {
      await import(pkg);
    } catch (err) {
      ok = false;
      errors.push(`${pkg}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  process.stdout.write(JSON.stringify({ ok, errors }));
' >"${PI_OUTPUT}" 2>&1
PI_EXIT=$?
PI_RESULT="$(cat "${PI_OUTPUT}")"
rm -f "${PI_OUTPUT}"
if [ "${PI_EXIT}" -eq 0 ] && echo "${PI_RESULT}" | grep -q '"ok":true'; then
  pass "both pi packages import cleanly"
else
  fail "pi package import failed (exit ${PI_EXIT}): ${PI_RESULT}"
fi

# ---------------------------------------------------------------------------
# 結果
# ---------------------------------------------------------------------------
echo
if [ "${fail_count}" -eq 0 ]; then
  echo -e "${GREEN}verify-compose: 3/3 passed${NC}"
  exit 0
else
  echo -e "${RED}verify-compose: ${fail_count} failure(s)${NC}"
  exit 1
fi