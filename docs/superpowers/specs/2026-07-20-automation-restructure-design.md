# Automation 架構重整設計

> 日期：2026-07-20
> 狀態：設計待審
> 範圍：`automation/` 目錄重整 + Dockerfile 重寫 + 部署簡化

## 背景

`automation/deploy/dagu/` 下累積 7 個檔，其中 3 個是殘留垃圾（`docker-compose.yml` 已標「已棄用」、`admin.yaml`/`dagu.env.template` 無人或僅 dead-code 引用）。`Dockerfile.dagu` 從官方 dagu image（Ubuntu 24.04）出發，再 apt 装 git/gh/ssh/node22 + curl 装 bun，runtime user 透過官方 entrypoint + PUID/PGID 動態降權。`automation/scripts/` 是個「啥都丟」的桶子，混了 11 個 bun CLI 入口、7 個 `phase4/` lib 檔、4 個 .sh wrapper。

核心架構問題：
- 設計決策已經選了「source 在 repo、runtime 在 GHCR image」（PR #51/52），但 `dags-sync` sidecar 又每 300s git clone `automation/dags/`，跟「所有內容 bake 進 image」的決策矛盾
- agent runtime（`pi-research.ts`）、agent tools（`tools.ts`）、shared infra（`db.ts` 等）、CLI 入口、shell wrapper 全塞 `scripts/` 跟 `scripts/phase4/` 兩層，沒有職責分層
- 6 個分服務 secrets 檔 + `stack.env` 對這個試驗專案過度工程
- `PUID/PGID` 動態降權機制（官方 entrypoint + sudo + tini）對單一 user 場景過度複雜

## 目標

1. `automation/` 目錄按職責分層為 `commands/agents/tools/lib/`，不留 `scripts/` 這個垃圾桶
2. Dockerfile 以 `oven/bun:1.3.14-debian` 為 base，所有 runtime 內容（source + dags + config + migrations）bake 進單一 image
3. dags-sync sidecar 整條鏈刪除，DAG 改動透過 push-to-deploy 鏈生效
4. 部署簡化：6 個 secrets 檔 → 1 個、`stack.env` 取消、`PUID/PGID` → compose `user:` 直設
5. 不改動任何業務邏輯，154 個測試 baseline 必須完整通過

## 非目標

- 不改 Postgres schema、不遷移資料
- 不動 `compose.yml` 內 5 個保留服務（hindsight / hindsight-db / alpha-lab-postgres / mastra-app）的容器層設定（除了 secrets 注入方式）
- 不重寫 agent prompt 或工具語意
- 不改 Dagu 的排程 cron 跟 retry policy

## 目錄結構

```
alpha-lab/
├── scripts/
│   └── setup-vm.sh                  ← PR 3 從 automation/scripts/ 搬過來
└── automation/
    ├── commands/                    ← DAG 用的 bun CLI 入口
    │   ├── ingest-events.ts
    │   ├── research-next-event.ts
    │   ├── open-next-paper-bet.ts
    │   ├── settle-paper-bets.ts
    │   ├── calibrate-signals.ts
    │   ├── publish-next-research.ts
    │   ├── publish-draft.ts
    │   ├── clone-publish.ts          ← PR 2 取代 clone-publish.sh + git-askpass.sh
    │   ├── materialize-research-candidate.ts
    │   └── migrate-phase4.ts
    ├── agents/                       ← 一 agent 一檔（對稱 tools/ 一 tool 一檔）
    │   └── research.ts               ← pi-research.ts + buildPrompt 合併，從 phase4/pi-research.ts 搬並併入 research-next-event.ts 的 buildPrompt
    ├── tools/                       ← 一 tool 一檔 + barrel
    │   ├── read-event.ts
    │   ├── recall-memory.ts
    │   ├── retain-event-memory.ts
    │   ├── lookup-adjusted-close.ts
    │   ├── record-research.ts
    │   ├── toolkit.ts               ← createResearchToolkit factory + 共用 type-narrowing helpers
    │   └── index.ts                 ← barrel re-export
    ├── lib/                         ← shared infra（HTTP client / DB / 純契約）
    │   ├── db.ts
    │   ├── hindsight.ts
    │   ├── twelve-data.ts
    │   ├── x-client.ts
    │   └── contracts.ts
    ├── dags/                        ← Dagu YAML，路徑指向 commands/
    ├── config/                      ← investor-sources.yaml 等
    ├── migrations/
    └── tests/
```

### 目錄命名依據

- **`commands/`**：DAG step 直接 `bun run` 的 CLI 入口。每個檔是 `#!/usr/bin/env bun` + `if (import.meta.main)` 結構，唯一職責是接 CLI args / env、呼叫 lib + agents + tools、output run ID 到 stdout、exit code 反映成敗
- **`agents/`**：pi-agent-core 的 agent runtime 構造，一 agent 一檔。`research.ts` 包含 `buildPiResearchRuntime` / `subscribeMaxStepsGuard` / `assertRunPersisted` + `buildPrompt(event)`（從原 `research-next-event.ts` 抽併入）。未來加新 agent 就加 `agents/<name>.ts`，對稱於 `tools/` 的「一 tool 一檔」
- **`tools/`**：agent tool 實作 + TypeBox parameter schema。每個 tool 一個檔，包含 schema type 常數 + executor function。`toolkit.ts` 放 factory `createResearchToolkit`、`ResearchToolContext`、共用 helpers（`requireObject/requireString/...`）。`index.ts` barrel
- **`lib/`**：跨 commands / agents / tests 共用的 infra。`db.ts` (Bun SQL)、`hindsight.ts` (Hindsight HTTP client)、`twelve-data.ts` (Twelve Data client)、`x-client.ts` (X API client)、`contracts.ts` (pure 純函數契約)
- **`scripts/`（root 層）**：VM 維運工具。`setup-vm.sh` 做的是系統操作（`useradd`、`install`、`docker compose up`），用 bun 跑無好處；它跟 runtime 關注點分離，搬到 root `scripts/`

### `scripts/` 目錄退場

`automation/scripts/` 在 PR 3 後完全消失：
- `*.ts` CLI 入口 → `automation/commands/` (PR 1)
- `phase4/db.ts` 等 5 個 lib → `automation/lib/` (PR 1)
- `phase4/tools.ts` 拆 6 檔 → `automation/tools/` (PR 1)
- `phase4/pi-research.ts` → `automation/agents/research.ts` (PR 1)
- `clone-publish.sh` + `git-askpass.sh` → `commands/clone-publish.ts` 用 bun 重寫 (PR 2)
- `setup-vm.sh` → `scripts/setup-vm.sh` (PR 3，root 層)
- `clone-fixture.sh` + `verify-compose.sh` → 刪除，無引用 (PR 1)

## Dockerfile

單一 Dockerfile 取代 `Dockerfile.dagu` + `Dockerfile.dags-sync`：

```dockerfile
# stage 1：從官方 dagu image 抽 binary
FROM ghcr.io/dagucloud/dagu:2.10.7@sha256:5e715705e0c96e462417303f3e2fbbadc7f9cd15d153764c89fd1442e80a1d66 AS dagu

# stage 2：bun base + 系統工具 + dagu binary + runtime source
FROM oven/bun:1.3.14-debian

# DAG step 需要的系統工具：git（clone-publish）/ gh（開 PR）/ openssh-client（deploy key）/ rsync（保留給其他用途）/ ca-certificates
# unzip 已在 bun base 內
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates git gh openssh-client rsync && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# dagu binary（已驗證 statically linked，docker copy 可行）
COPY --from=dagu /usr/local/bin/dagu /usr/local/bin/dagu

# runtime source：先 COPY package manifest），讓 tsconfig/source 修改不會使 production dependency layer 失效
WORKDIR /opt/alpha-lab/automation
COPY automation/package.json automation/bun.lock ./
RUN bun install --frozen-lockfile --production

# .dockerignore 排除 tests/.env/node_modules/.delete/，保留 commands/agents/tools/lib/dags/config/migrations
COPY automation/ ./

USER 999:982
```

驗證紀錄（2026-07-20）：
- `ldd /usr/local/bin/dagu` → `not a dynamic executable`（197MB statically linked）
- multi-stage COPY 到 `oven/bun:1.3.14-debian` → `dagu version` 回 `2.10.7`

### `admin.yaml` 退場

`admin.yaml` 原本 mount 進 dagu container 定義 `dags_dir` / `data_dir` / `log_dir` 路徑。新架構下：
- `DAGU_HOME` 直接指到 `/var/lib/alpha-lab/dagu`（compose environment）
- dagu 預設 `dags_dir = $DAGU_HOME/dags`、`data_dir = $DAGU_HOME/data`、`log_dir = $DAGU_HOME/logs`
- 但 image 內也 bake 了 `automation/dags/`——DAG 載入路徑改指到 image 內固定路徑（`/opt/alpha-lab/automation/dags/`），不用 volume 同步

`admin.yaml` 刪除。

## compose.yml

充分利用 YAML anchors（`x-defaults`）把 `restart` / `logging` / `env_file` / `networks` 抽到共用 block，merge 進每個 service。省 `container_name`（用 compose 預設 `<project>-<service>-1`，service name 就是容器 DNS 名稱）、省 `name:`（目錄名即 project name）。

```yaml
# alpha-lab canonical Compose：5 服務 + 單 network。
# 所有秘密走 /etc/alpha-lab/secrets.env 一檔（PR 2 簡化）。
# image tag 透過 ${ALPHA_LAB_IMAGE_TAG:-latest} interpolation，下方 services 直接複用。

x-defaults: &defaults
  restart: unless-stopped
  logging:
    driver: json-file
    options: { max-size: "10m", max-file: "3" }
  env_file:
    - /etc/alpha-lab/secrets.env
  networks:
    - alpha_lab_net

services:
  alpha-lab-dagu:
    <<: *defaults
    image: ghcr.io/taiwanta/alpha-lab-dagu:${ALPHA_LAB_IMAGE_TAG:-latest}
    user: "999:982"
    command: ["dagu", "start-all"]
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      DAGU_HOME: /var/lib/alpha-lab/dagu
      HINDSIGHT_BASE_URL: http://hindsight:8888
    volumes:
      - /var/lib/alpha-lab/dagu:/var/lib/alpha-lab/dagu
    depends_on:
      hindsight: { condition: service_healthy }
      alpha-lab-postgres: { condition: service_healthy }

  # alpha-lab-dags-sync service 整條刪除（PR 2）

  hindsight-db:
    <<: *defaults
    image: pgvector/pgvector:pg${HINDSIGHT_DB_VERSION:-18}
    volumes:
      - hindsight_pgdata:/var/lib/postgresql/${HINDSIGHT_DB_VERSION:-18}/docker
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 20s

  hindsight:
    <<: *defaults
    image: ghcr.io/vectorize-io/hindsight:${HINDSIGHT_VERSION:-latest-slim}
    entrypoint:
      - /bin/sh
      - -c
      - >-
        uv pip install --python /app/api/.venv/bin/python --quiet
        --link-mode=copy flashrank && exec /app/start-all.sh
    environment:
      HINDSIGHT_API_DATABASE_URL: ${HINDSIGHT_API_DATABASE_URL:?set URL with hindsight-db host}
      HINDSIGHT_API_VECTOR_EXTENSION: pgvector
    ports:
      - "127.0.0.1:8888:8888"
    depends_on:
      hindsight-db: { condition: service_healthy }
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8888/health || exit 1"]
      interval: 15s
      timeout: 5s
      retries: 5
      start_period: 180s

  alpha-lab-postgres:
    <<: *defaults
    image: postgres:16-alpine
    volumes:
      - research_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 12

  mastra-app:
    <<: *defaults
    image: ${MASTRA_IMAGE:?set immutable mastra image or existing VM tag}
    user: "1001:1001"
    ports:
      - "127.0.0.1:4111:4111"
    environment:
      PORT: "4111"
      HOST: 0.0.0.0
      LOG_LEVEL: info
      DATABASE_URL: file:/data/mastra.db
    volumes:
      - mastra_data:/data
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:4111/health || exit 1"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    security_opt:
      - no-new-privileges:true

networks:
  alpha_lab_net:
    name: alpha-lab-net

volumes:
  hindsight_pgdata:
    name: alpha_lab_hindsight_pgdata
  research_pgdata:
    external: true
    name: research_pgdata
  mastra_data:
    external: true
    name: mastra-data
```

### 精簡幅度

原本 6 個服務各寫 `restart` / `logging` 兩行（3 行 block）+ `networks` 1 行 + `env_file` 3 行（分服務 6 檔）= 6 × 6 = 36 行重複配置。用 anchor 後：
- 共用 block 一次定義 `restart` / `logging` / `env_file` / `networks`
- 每個 service 只要寫自己獨有的 `image` + `volumes` + `healthcheck` 等，merge 進共用 block
- `name:` 取消（目錄名即 compose project name）
- `container_name:` 取消（compose 預設 `<project>-<service>-1` 就是容器 DNS 名）
- 反而是 Hindsight service 的舊 alias `hindsight-hindsight-1` 退場（搬遷期間的相容 alias 已無 caller）

### 簡化清單

| 項目 | before | after |
|---|---|---|
| 服務數 | 6 | 5 |
| Dockerfile | 2（dagu + dags-sync） | 1 |
| GHCR image | 2（alpha-lab-dagu + alpha-lab-dags-sync） | 1（alpha-lab-dagu） |
| secrets 檔 | 6（dagu.env / hindsight-db.env / hindsight.env / research-postgres.env / mastra.env + stack.env） | 1（`/etc/alpha-lab/secrets.env`） |
| user 降權 | 官方 entrypoint.sh + sudo + tini + PUID/PGID env | compose `user: "999:982"` 直設 |
| admin.yaml | 有 | 無（走 dagu 預設路徑 + env） |
| dags-sync sidecar | 有（Alpine + git/ssh/rsync + dags-sync.sh） | 無 |

### Secrets 集中 Tradeoff

6 檔分服務 secrets → 1 檔集中，所有 container 都看得到 every secret。

風險評估：
- 在單主機單 compose stack 部署模型下，攻陷任一 container 即可橫向讀其他服務的 network traffic，最小權限 secrets 隔離的边际安全收益對此試驗專案可忽略
- 收益：setup-vm.sh 寫 1 檔而非 6 檔、compose 列 1 個 env_file 而非 6 個、維運心智負擔顯著降低
- 結論：對此專案，激進簡化可接受

## DAG YAML 適配

每個 DAG step 的 `working_dir` 不變（`/opt/alpha-lab/automation`），但 `run` 路徑全改：

```yaml
# before
run: |
  set -euo pipefail
  export PATH="$HOME/.bun/bin:$PATH"
  bun run scripts/ingest-events.ts

# after
run: |
  set -euo pipefail
  bun run commands/ingest-events.ts
```

- `scripts/` → `commands/`：9 個 step 橫跨 7 個 DAG
- `export PATH="$HOME/.bun/bin:$PATH"` 拿掉：bun 現在是 image base 的 `/usr/local/bin/bun`，已在 default PATH
- `blog-publish.yaml` 的 `bash /opt/alpha-lab/automation/scripts/clone-publish.sh` → `bun run commands/clone-publish.ts`（PR 2）

## `commands/clone-publish.ts`（PR 2）

取代 `clone-publish.sh` + `git-askpass.sh` 兩個檔。用 bun 重寫：

```typescript
#!/usr/bin/env bun
// commands/clone-publish.ts
//
// 在 blog-publish 子 DAG 的 checkout step 裡把遠端 worktree
// 拉進 ./workspace/publish。取代舊的 clone-publish.sh +
// git-askpass.sh 兩檔組合，使用 Bun.$ 跑系統 git + 環境變數
// 傳 token，避免 askpass shim。

import { $, argv } from "bun";

if (!process.env.GIT_READ_TOKEN?.trim()) {
  throw new Error("GIT_READ_TOKEN is required");
}

const targetDir = argv[0] ?? "./workspace/publish";

// 清掉前次失敗 run 留下的 stale workspace
await $`rm -rf ./workspace/publish`;
await $`mkdir -p ${targetDir}`;

// token 不進 argv：環境變數傳給 git，git 的 credential helper 讀取
// URL 只放 username，token 走 git credential channel
await $`git clone --depth 1 -b main \
  https://x-access-token@github.com/TaiwanTA/alpha-lab.git \
  ${targetDir}`.env({
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: "",          // 不靠 askpass shim
});
```

註：token 從 env 讀，但實際 git clone 的 token 傳遞方式需要再驗證——單純 `https://x-access-token@` URL 不含 token 的話 git 會 prompt；用 askpass shim 或 `git credential approve` 才能完全避免 token 進 argv。**PR 2 實作時確定具體機制**，spec 不鎖死。

## `agents/research.ts`

把 `buildPrompt(event: SignalEventRow): string`（從原 `scripts/research-next-event.ts:176-223`）併入 `agents/research.ts`。這個檔同時包含 `buildPiResearchRuntime` / `subscribeMaxStepsGuard` / `assertRunPersisted` + `buildPrompt`——都是 research agent 的內部組裝。簽名不變，純搬家 + 合併。

## 測試 import 路徑更新

11 個測試檔：

| 舊路徑 | 新路徑 |
|---|---|
| `../scripts/phase4/db.ts` | `../lib/db.ts` |
| `../scripts/phase4/contracts.ts` | `../lib/contracts.ts` |
| `../scripts/phase4/hindsight.ts` | `../lib/hindsight.ts` |
| `../scripts/phase4/twelve-data.ts` | `../lib/twelve-data.ts` |
| `../scripts/phase4/x-client.ts` | `../lib/x-client.ts` |
| `../scripts/phase4/tools.ts` | `../tools/index.ts` |
| `../scripts/phase4/pi-research.ts` | `../agents/research.ts` |

## PR 拆分

### PR 1：目錄重整（純 move + import 修正，無邏輯改動）

**範圍**：
- `automation/scripts/*.ts` → `automation/commands/`
- `automation/scripts/phase4/{db,contracts,hindsight,twelve-data,x-client}.ts` → `automation/lib/`
- `automation/scripts/phase4/tools.ts` 拆成 `automation/tools/{read-event,recall-memory,retain-event-memory,lookup-adjusted-close,record-research,toolkit,index}.ts`
- `automation/scripts/phase4/pi-research.ts` → `automation/agents/research.ts`
- 從 `commands/research-next-event.ts` 抽 `buildPrompt` 併入 `automation/agents/research.ts`，command 改 import
- 11 個測試 import 路徑同步
- 7 個 DAG YAML `scripts/X.ts` → `commands/X.ts`，拿掉 `export PATH="$HOME/.bun/bin:$PATH"`
- 刪 `automation/scripts/clone-fixture.sh` + `automation/scripts/verify-compose.sh`（孤兒）

**驗證**：
- `cd automation && bun test`（154 tests pass）
- `cd automation && bun run typecheck`
- `dagu validate` 7 個 DAG YAML

**不做**：Dockerfile 不動、compose.yml 不動、clone-publish.sh + git-askpass.sh 不動（PR 2 處理）、setup-vm.sh 不動（PR 3 處理）

### PR 2：Dockerfile 重寫 + image 簡化

**範圍**：
- 新 `Dockerfile.dagu`（multi-stage：官方 dagu image + oven/bun:1.3.14-debian base，IMAGE 內 bake 所有 runtime source）
- 刪 `automation/deploy/dagu/Dockerfile.dags-sync` + `automation/deploy/dagu/dags-sync.sh`
- `compose.yml`：
  - 刪 `alpha-lab-dags-sync` service
  - `PUID/PGID` environment 區塊 → `user: "999:982"` 直設
  - 6 個 env_file → 1 個 `/etc/alpha-lab/secrets.env`
  - `secrets:` 區塊刪除
  - `stack.env` 的 image tag interpolation 改寫進 `secrets.env` 或 compose.yml 直設
  - `admin.yaml` mount 刪除
- `build-images.yml`：matrix 從 2 image 縮成 1（只 build `alpha-lab-dagu`）
- `deploy-vm.yml`：
  - `paths:` 加 `automation/dags/**`
  - 70 行 verify 迴圈簡化為 `docker compose up -d --wait`（`--wait` 會等到所有 service unhealthy 或 running）
- `clone-publish.sh` + `git-askpass.sh` → `commands/clone-publish.ts`（bun 重寫）
- `blog-publish.yaml` 改用 image 內 source（但仍需 git clone worktree 來 commit + push + 開 PR；clone-publish.ts 負責）

**驗證**：
- local `docker build -f automation/deploy/dagu/Dockerfile.dagu .` 成功
- `docker compose config` 通過
- local `docker compose up --wait` 把 5 個服務都跑起來
- dagu UI 8080 回應、hindsight health 8888 回應
- 跑一輪 ingest smoke test（手動觸發 ingest-events DAG，驗證 container 內 `bun run commands/ingest-events.ts` 路徑正確）
- `cd automation && bun test` + `bun run typecheck`

**不做**：setup-vm.sh 不動、`automation/deploy/dagu/docker-compose.yml` + `admin.yaml` + `dagu.env.template` 不動（PR 3）

### PR 3：部署簡化收尾

**範圍**：
- `automation/scripts/setup-vm.sh` → `scripts/setup-vm.sh`（root 層新建 `scripts/` 目錄）
- 刪 `automation/deploy/dagu/docker-compose.yml`（已標「已棄用」殘留）
- 刪 `automation/deploy/dagu/admin.yaml`（PR 2 後不再 mount）
- 刪 `automation/deploy/dagu/dagu.env.template`（secrets 改單檔，範本跟著簡化）
- `automation/deploy/dagu/` 目錄最終只留 `Dockerfile.dagu` 跟 `alpha-lab-dagu.service`，或將這兩個搬到更合適位置（待 PR 3 評估）
- `setup-vm.sh` 內容更新：寫 1 個 secrets 檔而非 6 個、不再用 dagu.env.template
- `AGENTS.md` 路徑引用同步更新
- `automation/scripts/` 目錄在 PR 3 後消失

**驗證**：
- VM-side 整套 deploy 跑一遍（新 VM 或現有 VM）
- `setup-vm.sh` 互動式跑一次生成 `/etc/alpha-lab/secrets.env`
- `docker compose up -d` 跑起來、verify 所有服務 healthy
- 跑一輪 e2e：ingest → research → open-bet → settle → calibrate → publish

## 風險跟未決問題

1. **`clone-publish.ts` 的 token 傳遞機制**：spec 沒鎖死。舊機制是 `git-askpass.sh` shim，新機制必須達到同等安全等級（token 不進 argv / ps / log）。PR 2 實作時確定靠 `git credential approve` 或其他方式
2. **`blog-publish.yaml` 的 worktree 依賴**：即使 image 內有 source，blog-publish 仍需要 git worktree 才能 commit + push 到新分支。clone-publish.ts 在 DAG step 內跑，clone 完 worktree 後跑 image 內的 `commands/publish-draft.ts`
3. **`tools.ts` 拆檔的 barrel export 結構**：11 個測試裡有 1 個 (`phase4-tools.test.ts`) 直接 import 多個 internal helper，拆檔後這個測試的 import surface 會變大，可能需要多個 import 行
4. **DAG 路徑 `/opt/alpha-lab/automation`** 在新 image 內仍正確：`WORKDIR /opt/alpha-lab/automation` + `COPY automation/ ./`，DAG YAML 路徑不變
5. **154 tests** 是 stable baseline，PR 1 拆 `tools.ts` 風險最高，barrel re-export 必須對齊所有原本 export 的符號

## 驗證矩陣

每個 PR gate（對應 AGENTS.md「Pre-deploy validation matrix」）：

| 檢查 | PR 1 | PR 2 | PR 3 |
|---|---|---|---|
| `bun run typecheck` | ✓ | ✓ | ✓ |
| `bun test` (154 tests) | ✓ | ✓ | ✓ |
| `dagu validate` 7 DAG | ✓ | ✓ | - |
| `docker build` 成功 | - | ✓ | - |
| `docker compose config` | - | ✓ | - |
| `docker compose up --wait` | - | ✓ | ✓ |
| `ssh VM + verify-compose` | - | - | ✓ |
| `e2e smoke` | - | - | ✓ |
