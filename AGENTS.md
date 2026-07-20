# AGENTS.md — Workspace

## 這裡做什麼
你是「知名投資人研究」的 agent：
- 抓資料（X / Reddit / SEC 13F 等），寫入資料湖
- LLM 分析推文 / 持股 / 訪談，產出 findings
- 維護一個對外的 blog（部署到 Cloudflare Pages，已上線）
- 反思產出、校準判斷、模擬下注（Phase 4）

## 兩個環境

- **local workspace** — commit 跟 dev 用
  - `automation/` — TypeScript runtime（四層：`commands/` + `agents/` + `tools/` + `lib/`）
    - `dags/` — 7 個 DAG YAML
    - `config/` — `admin.yaml`（dagu config，bake 進 image）
    - `migrations/` — append-only SQL migrations
    - `deploy/dagu/` — `Dockerfile.dagu`（multi-stage：官方 dagu binary + oven/bun:1.3.14-debian base）+ `alpha-lab-dagu.service`（systemd unit）
    - `tests/` — 11 個測試檔（154 tests baseline）
  - `blog/` — 對外發表，已上線（Cloudflare Pages auto-deploy from git push）。看 `blog/AGENTS.md`
  - `compose.yml` — canonical Compose（五服務，repo root）
  - `scripts/setup-vm.sh` — 新 VM 一鍵 bootstrap
  - `research/` — 未追蹤的使用者資料，**不要修改或移動**
  - `docs/` — 跨切面文件（ADR + specs），看 `docs/AGENTS.md`

- **VM** — 部署目標
  - `gcloud compute ssh --zone "asia-east1-b" "alpha-lab" --project "g6online-352310"`
  - canonical Compose 部署到 `/opt/alpha-lab/compose.yml`
  - Dagu state：`/var/lib/alpha-lab/dagu/`（bind mount，含 data、logs、SSH key）
  - Secrets：`/etc/alpha-lab/secrets.env`（單一檔，PR 2 集中化；所有服務可見）
  - Interpolation 變數（image tag、Hindsight DB URL 等）：`/etc/alpha-lab/stack.env`
  - systemd unit：`/etc/systemd/system/alpha-lab-dagu.service`（compose wrapper，`ExecReload = docker compose up -d --force-recreate`）

## 部署流程

**自動（GitHub Actions）**：push 到 main 的 `compose.yml` / `automation/dags/**` / `automation/deploy/dagu/{Dockerfile.dagu,alpha-lab-dagu.service}` / `automation/config/admin.yaml` 變更 → `.github/workflows/deploy-vm.yml` 用 Workload Identity Federation 認證 GCP → scp 到 VM → `docker compose pull` + `systemctl reload` → 驗證五服務 healthy + Dagu/Hindsight health。也可手動 `gh workflow run deploy-vm.yml --ref main`。

**Image build（CI）**：`.github/workflows/build-images.yml` 在 push to main 時 build `Dockerfile.dagu`，推到 `ghcr.io/taiwanta/alpha-lab-dagu`。DAG 變更透過 image rebuild（~3min）+ compose reload 生效（dags-sync sidecar 已退役，DAGs bake 進 image）。

**新 VM 設置**：`scripts/setup-vm.sh`（互動式，讀 SSH deploy key 來源 + 寫 `secrets.env` + 建使用者 + `docker compose up -d` + verify）。

## 架構

**單一 canonical Compose**（`compose.yml`，五服務）：
- `alpha-lab-dagu` — Dagu 2.10.7，工作排程器，GHCR image。Multi-stage：官方 dagu binary + `oven/bun:1.3.14-debian` base
- `hindsight` — 研究記憶（recall/retain），GHCR image
- `hindsight-db` — pgvector，Hindsight 的 DB
- `alpha-lab-postgres` — 研究事件帳本（Postgres 16）
- `mastra-app` — Mastra（VM 本地 image，不在 GHCR）

單一 network `alpha-lab-net`。DAGs 透過 Dagu container 內部 DNS 連 Postgres/Hindsight（不能用 `127.0.0.1`）。compose YAML anchor `x-defaults` 共用 `restart`/`logging`/`env_file`/`networks`。secrets 集中單一 `/etc/alpha-lab/secrets.env`（所有服務可見，試驗專案接受橫向暴露）。

**DAG 同步**：DAGs 直接 bake 進 Dagu image（PR 2 dags-sync sidecar 退役）。DAG 變更透過 push → CI build image → deploy-vm.yml pull + reload 生效（~4min）。

**GitHub ruleset bypass**：org-level 6159190 + repo-level 18699827 的 DeployKey bypass（always mode），讓 blog-publish DAG 用 SSH deploy key push 到 main。

## 慣例

- **CLI discipline**：stdout 只輸出 run ID；log 走 stderr
- **SQL parameterized**：不插值；insert count 對驗 returned rows
- **Event ledger append-only**：修正用新版本或 status flag，不覆寫；`signal_type`/`source`/`payload` 保留給未來擴充
- **Hindsight fail-closed**：`recall`/`retain` 失敗即 abort research step
- **來源白名單**：`automation/config/investor-sources.yaml`，不自動網路探索
- **DAG hand-off**：狀態只透過 Postgres rows / Dagu artifacts / explicit parameters 傳遞
- **Migrations versioned**：`automation/migrations/`，append-only，tracked in `schema_migrations`
- **外部依賴（LLM、X、價格 API）明確失敗**：不 silent retry 或 fallback
- **Agent runtime**：`pi-agent-core` + minimal-permission custom tools（不是直接 fetch）
- **LLM**：pi-ai 內建 Anthropic-compatible MiniMax provider，用 `MINIMAX_API_KEY`
- **十二數據**：30 交易日實際返回，不推測未來日曆
- **TypeScript 分層**：`commands/`（CLI 進入點）/ `agents/`（research.ts 一 agent 一檔）/ `tools/`（一 tool 一檔 + toolkit factory + index barrel）/ `lib/`（shared infra：db/contracts/hindsight/twelve-data/x-client）。不在 runtime 用的 `.sh` 都已退役。

## Required env

`/etc/alpha-lab/secrets.env`（單一檔，所有服務可見）：
- `DATABASE_URL` — research workers + migrate-phase4.ts
- `MINIMAX_API_KEY` — pi-ai MiniMax provider
- `X_BEARER_TOKEN` — X API v2 event ingestion
- `TWELVE_DATA_API_KEY` — 30 交易日 adjusted-close
- `GIT_READ_TOKEN` — `commands/clone-publish.ts` 走 GIT_ASKPASS
- `GH_PR_TOKEN` — `blog-publish` DAG 的 `gh pr create`
- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — hindsight-db + alpha-lab-postgres 共用（pgdata 物理隔離，user 共用不影響資料）

`/etc/alpha-lab/stack.env`（interpolation 變數，非敏感）：
- `ALPHA_LAB_IMAGE_TAG` — 預設 `latest`
- `HINDSIGHT_API_DATABASE_URL` — host 必須是 `hindsight-db`
- `HINDSIGHT_DB_VERSION` — 預設 `18`
- `HINDSIGHT_VERSION` — 預設 `latest-slim`
- `MASTRA_IMAGE` — VM 本地 mastra image tag

## Build/test

```bash
cd automation && bun test        # 測試（154 tests baseline）
cd automation && bun run typecheck  # 型別檢查（pre-merge gate）
```

PR gate：`bun test` + `bun run typecheck` + Kilo Code Review（`@kilo-code-bot`，**有 dash**）+ CodeRabbit。用 `python skill://github-pr-master/wait.py --pr <N>` 等 CI + Kilo。

## Blog 長度風格

依類型調整，不為長而長：
- **主題研究** → 完整、結構齊全
- **單一事件/發言** → 簡短、聚焦一個 insight
- **持股/組合觀察** → 表格為主
- **方法論比較** → 短文、一個觀點打完

每一段要扛一個 source 或 insight；撐不起來就刪。

## 維護

這份文件隨進展更新。過時資訊直接刪除，不留「(已移除)」痕跡。詳細歷史在 git log。

## Housekeeping log

### 2026-07-20 — automation 目錄重整 PR 1/3 (PR #62)

`automation/scripts/` + `automation/scripts/phase4/` 兩層重整為 `automation/{commands,agents,tools,lib}/` 四層按職責分層。純 move + import path 修正，不改業務邏輯：

- `phase4/tools.ts` 拆成 `tools/` 7 檔（5 tool + toolkit factory + index barrel，一 tool 一檔）
- `phase4/pi-research.ts` 併入 `buildPrompt` 後改名 `agents/research.ts`（一 agent 一檔）
- 9 個 CLI 從 `scripts/` 搬到 `commands/`
- 5 個 shared infra 搬到 `lib/`（db/contracts/hindsight/twelve-data/x-client）
- 11 個測試 import 路徑更新
- 7 個 DAG YAML `run:` 路徑 `scripts/X.ts` → `commands/X.ts`
- 刪 2 個孤兒 `.sh`（`clone-fixture.sh`、`verify-compose.sh`）

fix(review) 同 PR：`lib/db.ts` migration URL path bug（`../../migrations/` → `../migrations/`）、`tools/toolkit.ts` 冗餘 type re-export。

Baseline：154 tests、7/7 DAGs validate、typecheck 0 errors、3/3 CI SUCCESS。

### 2026-07-20 — Dagu image 重寫 + dags-sync 退役 PR 2/3 (PR #63)

- **Dockerfile.dagu 重寫為 multi-stage**：Stage 1 `ghcr.io/dagucloud/dagu:2.10.7` COPY 靜態 binary（197MB statically linked），Stage 2 `oven/bun:1.3.14-debian` base + apt 補 git/gh/ssh/rsync/bash。bun 已在 base，不需另裝 node。
- **dags-sync sidecar 整條鏈退役**：刪 `Dockerfile.dags-sync` + `dags-sync.sh` + compose service + build-images.yml matrix entry。DAG 變更改透過 image rebuild + compose reload 生效（`deploy-vm.yml` paths 新增 `automation/dags/**`）。
- **compose.yml 簡化**：YAML anchor `x-defaults` 共用 restart/logging/env_file/networks；移除 `name:`/`container_name:`/`secrets:` top-level + `hindsight-hindsight-1` alias；secrets 集中單一 `/etc/alpha-lab/secrets.env`（所有服務可見）。dagu `command:` 加 `-c /etc/dagu/admin.yaml`（dagu 預設讀 `DAGU_HOME/base.yaml` 不讀 `/etc/dagu/admin.yaml`，Task 1 驗證發現）。
- **clone-publish shell → bun**：`automation/commands/clone-publish.ts` 用 `Bun.$` 跑系統 git；token 走 GIT_ASKPASS 臨時檔（0700、PID-suffixed、finally 必刪），不入 argv / URL。刪 `scripts/clone-publish.sh` + `git-askpass.sh`。
- **deploy-vm.yml 簡化**：GHCR 服務列表用 `docker compose config --images` 取代手寫 regex parsing；verify 迴圈保留 120 retries（hindsight start_period 180s）。
- **admin.yaml 路徑**：`automation/deploy/dagu/admin.yaml` → `automation/config/admin.yaml`；`dags_dir` 從 `/var/lib/alpha-lab/dagu/dags` 改為 `/opt/alpha-lab/automation/dags`（bake 進 image）。

CI 3/3 SUCCESS、Kilo SUCCESS、0 unresolved threads。docker build OK、image 內 dagu 2.10.7 + bun 1.3.14 + git + gh。

review fix 過程：
- kilo Critical 抓出 `workflow_dispatch:` 觸發器被我手誤刪，及時還原
- CodeRabbit Critical：`docker compose pull` 接受 service name 不接受 image name，改無 arg 拉所有 service；`clone-publish.ts` `process.exit()` 繞過 finally 會殘留含 token askpass 檔，改用 exitCode 變數
- Dockerfile stage 2 base `oven/bun:1.3.14-debian` 加 digest pin

### 2026-07-20 — automation 收尾 PR 3/3 (PR #64)

PR 1/2 完成後殘留：

- `setup-vm.sh` 從 `automation/scripts/` 搬到 root `scripts/`（ops 跟 runtime 分離）
- 5 個 per-service secrets 檔（`dagu.env` / `hindsight.env` / `hindsight-db.env` / `research-postgres.env` / `mastra.env`）合併為單一 `/etc/alpha-lab/secrets.env`；setup-vm.sh 直接列舉 keys 互動讀值（不再依賴 `dagu.env.template`）
- 兩個 postgres（hindsight-db + alpha-lab-postgres）共用同一組 `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` 變數（pgdata volume 物理隔離，user 共用不影響資料）
- 刪 `automation/deploy/dagu/{docker-compose.yml,dagu.env.template}` 歷史遺留
- `automation/scripts/` 目錄完全退役

---

### 歷史（2026-07-14 ~ 2026-07-15）

#### 2026-07-15 — compose 切換收尾 + dags-sync fix + v2 除役 (PR #26)

- **PR #26**：`dags-sync.sh` `git pull` → `git fetch --depth 1` + `git reset --hard origin/<branch>`。shallow clone 下 git pull 遇到 force-push 會因找不到共同祖先而 fail。
- **PR #27**：`deploy-dagu.sh` step 6 verify 的 `sed 's/^/      /'` 單引號被外層 `--command '...'` 吃掉 → 改用雙引號。
- **GitHub ruleset**：org-level (6159190, TaiwanTA "default") 由 user 加 DeployKey bypass (always mode)。repo-level (18699827) 既有 DeployKey bypass 仍有效。
- `git_sync.enabled` 維持 false：dagu v2.10.7 git_sync interval tick 不觸發。

#### 2026-07-15 — dagu runtime 切到 docker compose (PR #25)

systemd unit 從 native binary 改為 compose wrapper (`alpha-lab-dagu.service`)。e2e 全綠：fixture-research DAG 成功 push blog post 到 main (commit `1918f48`)。

#### 2026-07-14 — Hermes 移除 + research-agent.ts (PR #20)

Hermes 容器 UID mismatch + Hindsight "Server disconnected" 兩個 P0 無法在不改 hermes source 的情況下修復。改用 self-contained TypeScript agent（直接 fetch LLM API + Hindsight API），零容器層。

#### 2026-07-14 — push step 改用 SSH deploy key (PR #21)

dagu `${env.X}` 截斷長 token + repo ruleset 擋 direct push。改用 SSH deploy key + repo-level ruleset DeployKey bypass。
