# alpha-lab：四個 Compose stack 合併為單一 stack 設計

**日期：** 2026-07-16  
**狀態：** 設計提案；GHCR build wiring 已實作，VM cutover 待執行
**適用 VM：** `alpha-lab`  
**目標：** 以一份 Compose 管理 6 個服務；runtime 不再把 `/opt/alpha-lab/automation` bind mount 到任何 container。

## 1. 決策摘要

1. 建立一份由 alpha-lab repo 維護的 canonical Compose（建議路徑：`automation/deploy/docker-compose.yml`），把目前四個 project 的 6 個服務 inline 進去。不使用 Compose `include`、外部 compose project 或外部 network 作為正式架構；這可避免 Hindsight 與 mastra 的 compose 檔案漂移。
2. 六個服務全部加入單一、由 canonical Compose 管理的 `alpha-lab-net`：
   `alpha-lab-dagu`、`alpha-lab-dags-sync`、`hindsight`、`hindsight-db`、`alpha-lab-postgres`、`mastra-app`。
3. Dagu runtime image 以 repo root 為 build context，將 `automation/scripts`、`automation/dags`、`automation/config`、`automation/migrations` 及 production `node_modules` bake 進 image。Dagu DAG 的 `working_dir` 固定為 `/opt/alpha-lab/automation`，所以不需改每支 DAG 的路徑契約。
4. `dags-sync` **仍然保留**。它只同步可變的 DAG 定義；scripts 與依賴固定在 Dagu image。同步結果寫到 named volume 的 `dagu_state/dags`，不是 host source bind mount。
5. 所有持久資料都使用 named volume：
   - Dagu `/var/lib/alpha-lab/dagu`：從現有 bind directory 搬到 `alpha_lab_dagu_state`。
   - Hindsight pgvector `/opt/hermes/hindsight/pg_data`：從現有 bind directory 搬到 `alpha_lab_hindsight_pgdata`。
   - research Postgres：直接採用現有 external volume `research_pgdata`，避免不必要的資料複製。
   - mastra：直接採用現有 external volume `mastra-data`，避免不必要的資料複製。
6. Hindsight 與 mastra 的服務定義由 canonical Compose 接管；現有 `/opt/hermes/.../docker-compose.yml` 僅作為遷移時的設定來源，不能在正式啟動時再以另一個 Compose project 運作。
7. Secrets 留在 VM 的 root-owned 目錄並按服務分檔；Compose 啟動時另使用一份不入 repo 的 interpolation env。建置階段不得把 secrets 放入 image layer、`ARG` 或 source tree。
8. GitHub Actions workflow `.github/workflows/build-images.yml` 在 pull request（只建置、不推送）與 push `main`（建置並推送）時，以 repo root context 建置 Dagu image、以 `automation/deploy/dagu` context 建置 dags-sync image，分別推送 `ghcr.io/taiwanta/alpha-lab-dagu` 與 `ghcr.io/taiwanta/alpha-lab-dags-sync`，tag 同時包含完整 commit SHA 與 `latest`（只在 main push）。目前 repo 可見性是 **private**，因此 VM pull 必須配置 `read:packages` credential；公開化不是本設計的前置條件。

## 2. 目標架構

```mermaid
flowchart LR
    User[VM localhost / reverse proxy] -->|127.0.0.1:8080| Dagu
    User -->|127.0.0.1:8888| Hindsight
    User -->|Mastra 原有 loopback port| Mastra

    subgraph Compose[alpha-lab canonical docker compose]
      subgraph Net[alpha-lab-net：單一 user-defined bridge]
        Dagu[alpha-lab-dagu\nDagu 2.10.7 + baked automation]
        Sync[alpha-lab-dags-sync\nGit sparse clone + rsync]
        Hindsight[hindsight\nlatest-slim，版本/ digest 固定]
        HDB[hindsight-db\npgvector/pgvector:pg18]
        Research[alpha-lab-postgres\npostgres:16-alpine]
        Mastra[mastra-app\nimmutable mastra image]
      end
      DaguState[(alpha_lab_dagu_state)]
      HDBData[(alpha_lab_hindsight_pgdata)]
      ResearchData[(research_pgdata：既有 external volume)]
      MastraData[(mastra-data：既有 external volume)]
    end

    Dagu ---|DAG steps：/opt/alpha-lab/automation| DaguState
    Sync -->|只更新 automation/dags| DaguState
    Hindsight --> HDB
    Dagu -->|http://hindsight:8888| Hindsight
    Dagu -->|postgres://...@alpha-lab-postgres:5432| Research
    Mastra -.沿用現有服務依賴.-> Hindsight
    HDB --- HDBData
    Research --- ResearchData
    Mastra --- MastraData
    Sync -->|SSH GitHub| GitHub[(GitHub TaiwanTA/alpha-lab)]
```

### DNS 與服務名稱

Canonical Compose 的 service name 是穩定的內部 DNS 名稱：`hindsight`、`hindsight-db`、`alpha-lab-postgres`、`mastra-app`。Dagu 的 `HINDSIGHT_BASE_URL` 必須改成 `http://hindsight:8888`，`DATABASE_URL` 的 host 必須改成 `alpha-lab-postgres`，不可使用 container 內的 `127.0.0.1` 或 `host.docker.internal`。

為降低切換風險，可以暫時在 Hindsight service 加上 network alias `hindsight-hindsight-1`，但新的 DAG 與 secrets 應以 `hindsight` 為唯一正式名稱；完成驗證後移除相容 alias。

## 3. Canonical `docker-compose.yml` 結構

以下是關鍵段落。實作時應以現場三份 compose 的實際 image、port、healthcheck、environment 與 volume target 逐項核對；標成「沿用」的欄位不能憑猜測填值。

Compose 檔建議放在 `automation/deploy/docker-compose.yml`，並以 `docker compose --env-file /etc/alpha-lab/stack.env -f automation/deploy/docker-compose.yml ...` 執行。`stack.env` 是 VM-only 檔案，不入 repo。

```yaml
name: alpha-lab

services:
  alpha-lab-dagu:
    image: ghcr.io/taiwanta/alpha-lab-dagu:${ALPHA_LAB_IMAGE_TAG:?set immutable image tag}
    # production 必須明確指定 workflow 產生的完整 commit SHA；
    # 測試 latest 時也要顯式設定 ALPHA_LAB_IMAGE_TAG=latest。
    container_name: alpha-lab-dagu
    restart: unless-stopped
    command: ["dagu", "start-all"]
    ports:
      - "127.0.0.1:8080:8080"
    env_file:
      - /etc/alpha-lab/secrets/dagu.env
    environment:
      PUID: "999"
      PGID: "982"
      HOME: /var/lib/alpha-lab/dagu
      DAGU_HOME: /var/lib/alpha-lab/dagu
      # Secrets 由 env_file 注入；environment 只覆寫 Compose DNS 設定。
      HINDSIGHT_BASE_URL: http://hindsight:8888
    volumes:
      - dagu_state:/var/lib/alpha-lab/dagu
    secrets:
      - source: dagu_env
        target: /etc/alpha-lab/dagu.env
    depends_on:
      hindsight:
        condition: service_healthy
      alpha-lab-postgres:
        condition: service_healthy
    networks: [alpha_lab_net]

  alpha-lab-dags-sync:
    image: ghcr.io/taiwanta/alpha-lab-dags-sync:${ALPHA_LAB_IMAGE_TAG:?set immutable image tag}
    # image 由同一個 GitHub Actions workflow 推送；只 bake sidecar
    # script/dependencies，DAG source 仍由 sidecar 從 GitHub 同步。
    container_name: alpha-lab-dags-sync
    restart: unless-stopped
    entrypoint: ["/usr/local/bin/dags-sync.sh"]
    environment:
      DAG_SYNC_REPO: git@github.com:TaiwanTA/alpha-lab.git
      DAG_SYNC_BRANCH: main
      DAG_SYNC_PATH: automation/dags
      DAG_SYNC_INTERVAL: "300"
      DAG_SYNC_TARGET: /var/lib/alpha-lab/dagu/dags
      HOME: /var/lib/alpha-lab/dagu
      GIT_SSH_COMMAND: >-
        ssh -i /var/lib/alpha-lab/dagu/.ssh/id_ed25519
        -o IdentitiesOnly=yes
        -o UserKnownHostsFile=/var/lib/alpha-lab/dagu/.ssh/known_hosts
        -o StrictHostKeyChecking=yes
    volumes:
      - dagu_state:/var/lib/alpha-lab/dagu
    networks: [alpha_lab_net]

  hindsight-db:
    image: pgvector/pgvector:pg18
    container_name: hindsight-db
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${HINDSIGHT_DB_USER:?set Hindsight DB user}
      POSTGRES_PASSWORD: ${HINDSIGHT_DB_PASSWORD:?set Hindsight DB password}
      POSTGRES_DB: ${HINDSIGHT_DB_NAME:?set Hindsight DB name}
    volumes:
      - hindsight_pgdata:/var/lib/postgresql/data
    healthcheck:
      # 以現場 Hindsight compose 的 user/db 值替換；不要用猜測的預設值。
      test: ["CMD-SHELL", "pg_isready -U ${HINDSIGHT_DB_USER} -d ${HINDSIGHT_DB_NAME}"]
      interval: 10s
      timeout: 5s
      retries: 12
    networks: [alpha_lab_net]

  hindsight:
    image: ghcr.io/vectorize-io/hindsight:${HINDSIGHT_VERSION:?pin version or digest}
    container_name: hindsight
    restart: unless-stopped
    ports:
      - "127.0.0.1:8888:8888"
      # 只有現場確實需要外部 debug/secondary API 時才保留 9999。
      # - "127.0.0.1:9999:9999"
    environment:
      HINDSIGHT_API_LLM_PROVIDER: ${HINDSIGHT_API_LLM_PROVIDER:?copy current provider}
      HINDSIGHT_API_LLM_API_KEY: ${HINDSIGHT_LLM_API_KEY:?copy current LLM key}
      # 由遷移工具 URL-encode password 後產生，避免 YAML/URL 特殊字元問題。
      HINDSIGHT_API_DATABASE_URL: ${HINDSIGHT_API_DATABASE_URL:?generated internal DB URL}
      HINDSIGHT_API_VECTOR_EXTENSION: pgvector
      # 依現場 compose 的設定保留 text-search backend。
      HINDSIGHT_API_TEXT_SEARCH_EXTENSION: ${HINDSIGHT_API_TEXT_SEARCH_EXTENSION:-}
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
    depends_on:
      hindsight-db:
        condition: service_healthy
    healthcheck:
      # 沿用現有 Hindsight compose 已驗證的 endpoint/命令；不要假定 image 內有 curl。
      test: ["CMD-SHELL", "<現場驗證的 Hindsight health check>"]
      interval: 10s
      timeout: 5s
      retries: 18
    networks:
      alpha_lab_net:
        aliases:
          - hindsight-hindsight-1

  alpha-lab-postgres:
    image: postgres:16-alpine
    container_name: alpha-lab-postgres
    restart: unless-stopped
    # 這些值直接取自 orphan research stack 的 inspect/env；不要重設密碼。
    environment:
      POSTGRES_USER: ${RESEARCH_POSTGRES_USER:?preserve existing value}
      POSTGRES_PASSWORD: ${RESEARCH_POSTGRES_PASSWORD:?preserve existing value}
      POSTGRES_DB: ${RESEARCH_POSTGRES_DB:?preserve existing value}
    volumes:
      - research_pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${RESEARCH_POSTGRES_USER} -d ${RESEARCH_POSTGRES_DB}"]
      interval: 10s
      timeout: 5s
      retries: 12
    networks: [alpha_lab_net]

  mastra-app:
    # `mastra-selfhost:local` 是 VM 上的 local tag，不能作為跨 VM 部署契約。
    # 先推送同一 image 的 immutable digest，再填入這裡。
    image: ${MASTRA_IMAGE:?immutable mastra image or digest}
    container_name: mastra-app
    restart: unless-stopped
    # 下列 environment、ports、healthcheck 與 target path 必須逐項沿用
    # /opt/hermes/mastra-selfhost/compose.yaml；這裡不重新發明 Mastra 契約。
    env_file:
      - /etc/alpha-lab/secrets/mastra.env
    volumes:
      - mastra_data:/<沿用 mastra compose 的 data target>
    depends_on:
      hindsight:
        condition: service_healthy
    networks: [alpha_lab_net]

networks:
  alpha_lab_net:
    name: alpha-lab-net
    driver: bridge
    internal: false

volumes:
  dagu_state:
    name: alpha_lab_dagu_state
  hindsight_pgdata:
    name: alpha_lab_hindsight_pgdata
  research_pgdata:
    external: true
    name: research_pgdata
  mastra_data:
    external: true
    name: mastra-data

secrets:
  dagu_env:
    file: /etc/alpha-lab/secrets/dagu.env
```

### Hindsight compose 的處理決定

正式方案選擇 **inline**，不保留 `hindsight` 的外部 Compose project：

- Hindsight image、pgvector image、healthcheck、環境變數與 DB URL 從 `/opt/hermes/hindsight/docker-compose.yml` 逐項帶入 canonical Compose。
- Hindsight 原始 compose 檔不在 alpha-lab repo，會造成版本/網路/啟停順序分裂；以 `include` 或 `extends` 只會把外部路徑依賴帶進 production。
- Hindsight 應固定已驗證的 image tag 或 digest；不要在切換同時把現行 `latest-slim` 升級到另一個版本。
- Hindsight 的 `.env` 不直接搬進 repo。遷移時產生 `/etc/alpha-lab/stack.env` 的 Hindsight section，並保留 `/etc/alpha-lab/secrets/hindsight.env` 作為原始、可審計的服務 secret 檔。

## 4. 原始碼與 image 策略

### 4.1 Dagu image

現行 `automation/deploy/dagu/Dockerfile.dagu` 改為以 repo root 作為 build context；`.github/workflows/build-images.yml` 以 `docker/build-push-action` 執行：

```dockerfile
FROM ghcr.io/dagucloud/dagu:2.10.7@sha256:5e715705e0c96e462417303f3e2fbbadc7f9cd15d153764c89fd1442e80a1d66

# 安裝 git、openssh-client、rsync、Node.js 22 與 Bun。
RUN <固定版本的 runtime 工具鏈安裝，沿用既有 Dockerfile>

WORKDIR /opt/alpha-lab/automation
# 先 COPY package manifest 與文字 lockfile，讓 tsconfig/source
# 修改不會使 production dependency layer 失效。
COPY automation/package.json automation/bun.lock ./
RUN bun install --frozen-lockfile --production

# `.dockerignore` 排除 tests、.env、node_modules、blog、research、
# .delete、docs 等非 runtime 內容；以下會把 scripts、dags、
# config、migrations 與 production node_modules 留在 image。
COPY automation/ ./
```

這個 image 由 GitHub Actions 推送到 `ghcr.io/taiwanta/alpha-lab-dagu`，
tag 同時產生完整 commit SHA 與 `latest`（只在 main push）。VM 的
Compose 只使用 `image:`，不含 `build:`；production 應以
`ALPHA_LAB_IMAGE_TAG=<SHA>` 固定部署版本，測試 latest 時必須顯式指定。

實際 Dockerfile 應注意：

- `bun install --frozen-lockfile --production` 在 build time 生成 `/opt/alpha-lab/automation/node_modules`；runtime 不執行 install，不依賴 VM 的 node_modules。
- `automation/scripts`、`automation/dags`、`automation/config`、`automation/migrations` 與 `package.json`/`bun.lock` 都在 image 內。Dagu YAML 中現有 `working_dir: /opt/alpha-lab/automation` 與 `bun run scripts/*.ts` 可維持。
- tests、`.git`、logs、`.env*`、SSH key、任何未追蹤產物必須由 `.dockerignore` 排除；不要讓 secret 進 build context 或 layer。
- base image 固定為目前驗證過的
  `ghcr.io/dagucloud/dagu:2.10.7@sha256:5e715705e0c96e462417303f3e2fbbadc7f9cd15d153764c89fd1442e80a1d66`；
  更新 Dagu base image 時必須另行更新 digest 並重新驗證。
- Bun `bun-v1.3.14/bun-linux-x64.zip` 下載後以官方
  `sha256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f`
  驗證；更新 Bun 版本時必須同步更新 URL 與 checksum。
- image metadata 以 commit SHA、lockfile hash、base image digest 標記；GitHub Actions
  以 `GITHUB_TOKEN` 登入 GHCR 並推送 `ghcr.io/taiwanta/alpha-lab-dagu`。
  workflow 的 package permission 必須是 `contents: read` + `packages: write`。
  repo 目前是 private，VM pull 需先 `docker login ghcr.io`，使用僅具
  `read:packages` 的 credential；不能假定 anonymous pull。
- `DAGU_HOME` 仍為 `/var/lib/alpha-lab/dagu`。現行 compose 的 state
  mount 內保留 `data/`、`logs/`、`dags/`、`admin.yaml`、`.ssh/`、
  `workspace/` 及既有 cache，符合現行 state layout。baked source 位於
  `/opt/alpha-lab/automation` image layer，不由 state mount 提供。

### 4.2 dags-sync image 與必要性

`dags-sync` 必須保留，原因是 DAG 定義會在 GitHub 的 `main` 分支更新；把 DAG bake 進 image 只能提供 build 時的 snapshot，不能取代每 5 分鐘的更新。

- 現有 `Dockerfile.dags-sync` 已把 `dags-sync.sh`、git、OpenSSH client、rsync bake 進 image；可沿用，因其 build context 不包含 host automation runtime source。
- `dags-sync.sh` 仍以 sparse clone 取得 `automation/dags`，再 rsync 到 `/var/lib/alpha-lab/dagu/dags`。這個路徑是 `dagu_state` named volume，不是 `/opt/alpha-lab/automation` bind mount。
- SSH key 保留在遷移後 named volume 的 `.ssh/`，並將 `GIT_SSH_COMMAND` 改為該 volume 內的絕對路徑。key/known_hosts 的 mode 與 owner 維持現行 `alpha-lab-dagu`（UID 999、GID 982）。
- `dags-sync` image 只 bake `dags-sync.sh` 與 git/SSH/rsync；Dagu image
  的 `/opt/alpha-lab/automation/dags` 是 build-time snapshot，但 runtime
  正式使用 `/var/lib/alpha-lab/dagu/dags`，由 sidecar 每 300 秒從 GitHub
  sparse clone + rsync 更新。因此 sidecar 不能移除。
- 若未來要避免 rsync 直接寫入 Dagu watcher 正在讀取的目錄，應另做 staging + atomic swap 的變更並驗證 Dagu 2.10.7 行為；本次合併不偷偷改變既有同步語意。

## 5. 資料持久化與保留策略

| 現況資料 | 現況型態 | 目標 volume | 處理 | 驗證 |
|---|---|---|---|---|
| `/var/lib/alpha-lab/dagu`（data、logs、dags、admin、`.ssh`、workspace、cache） | host bind | `alpha_lab_dagu_state` | 停寫後以保留 owner/mode 的 tar/rsync 搬入；不刪原目錄 | 檔案數、SHA256 manifest、7 個 Phase 4 DAG、`.ssh` mode、Dagu run/artifact |
| `/opt/hermes/hindsight/pg_data` | host bind | `alpha_lab_hindsight_pgdata` | Hindsight DB clean shutdown 後搬入；先做 `pg_dumpall`/必要 database dump | pg_isready、Hindsight migrations/API、既有 bank/memory 抽樣 |
| `research_pgdata` | named volume | `research_pgdata`（external） | 直接讓新 Compose 宣告同一 volume 名稱；不得 `down -v` | schema migrations、table/row count、Dagu read/write smoke |
| `mastra-data` | named volume | `mastra-data`（external） | 直接讓新 Compose 宣告同一 volume 名稱；不得 `down -v` | Mastra health、既有資料/metadata 抽樣 |

### Dagu state 的細節

- `data/`、`logs/`、`dags/`、`workspace/`、`admin.yaml` 與 `.ssh/` 全部留在同一個 `dagu_state` volume，避免改變 Dagu 2.10.7 的既有絕對路徑。
- 不要把 `dags` 再拆成第二個 volume；現行 `admin.yaml` 的 `dags_dir` 是 `/var/lib/alpha-lab/dagu/dags`，sidecar 與 Dagu 必須看到同一個 volume。
- npm/Bun cache 若現場已存在，也跟隨 state volume 保留；不要為了清理 cache 在切換時刪除整個 state。
- `admin.yaml` 是非 secret 設定，可由 image 初始值 bootstrap；遷移時以現有 `/var/lib/alpha-lab/dagu/admin.yaml` 為準，最後再由部署流程更新非 secret 設定。

### Volume 搬移操作原則

1. 先保存 volume/目錄的 `docker inspect`、owner/mode、檔案數與 checksum manifest。
2. 停止會寫入該資料的舊 container，確認無 process 再讀寫。
3. `docker volume create alpha_lab_dagu_state` / `docker volume create alpha_lab_hindsight_pgdata`。
4. 用 root tar pipeline 搬資料並保留 mode、owner、mtime、symlink；不要用會改 owner 的普通 `cp -r`。例如：

   ```bash
   docker run --rm -u 0 \
     -v /var/lib/alpha-lab/dagu:/src:ro \
     -v alpha_lab_dagu_state:/dst \
     alpine:3.20 sh -c 'cd /src && tar cpf - . | tar xpf - -C /dst'
   ```

5. 重新計算 manifest、確認 DB 目錄沒有被套錯 UID；不要在不知道 Postgres image UID 的情況下盲目 `chown -R`。
6. 原始 bind directory 至少保留至 cutover 驗收、備份還原演練與 rollback window 結束後，才依變更流程封存或刪除。

## 6. Network 設計

本次採用 **單一 network** `alpha-lab-net`，由 canonical Compose 建立且不宣告 `external: true`。理由是六個服務均屬同一個應用邊界，且 Dagu 需要同時呼叫 Hindsight 與 research Postgres；單一 network 可消除目前 `hindsight-net`/`research_default` 的 project ownership 與 orphan labels。

- 不再使用 `hindsight-net`、`research_default`、`mastra_default` 作為 runtime 依賴。切換期間保留它們供 rollback，確認沒有 container 後才刪除。
- DB port 預設不 publish 到 host；container 間以 DNS/service name 通訊。若現有 VM 工具仍需要 host loopback DB port，先盤點使用者後只綁 `127.0.0.1`，且避免與既有 port 衝突。
- Dagu、Hindsight、Mastra 的對外 port 只保留現行必要的 loopback binding；不把 DB 或管理介面暴露到 VM 對外網卡。
- `internal: false` 是為了讓 Hindsight、Dagu image 與 Mastra 的既有對外 API 呼叫繼續工作；若確認所有 outbound 都由 proxy/其他 network 提供，可另行評估 internal network，但不在本次切換同時變更。

## 7. Secrets 管理

### 檔案分區

VM 上建議使用以下 root-owned、group-readable 檔案（`0440 root:<runtime-admin-group>`；含 SSH key 的目錄 `0700`）：

- `/etc/alpha-lab/secrets/dagu.env`：現有 `/etc/alpha-lab/dagu.env` 的保留副本；含 `DATABASE_URL`、`MINIMAX_API_KEY`、`X_BEARER_TOKEN`、`TWELVE_DATA_API_KEY`、`HINDSIGHT_*`、Git token 等 Dagu/DAG 需要的值。
- `/etc/alpha-lab/secrets/hindsight.env`：現有 `/opt/hermes/hindsight/.env` 的 Hindsight DB、LLM provider、OpenRouter 等值，逐項帶入並重新命名為 canonical Compose 使用的變數。
- `/etc/alpha-lab/secrets/mastra.env`：現有 mastra `.env`，保留 Mastra 所需 key。
- `/etc/alpha-lab/stack.env`：Compose interpolation 專用的 VM-only 檔案，含服務 image tag/digest、內部 DNS URL、DB user/name/password 與必要 non-secret flags。它可以由上面三份檔案產生，但不可 commit，也不可在 log 顯示。

「各自獨立 section」的做法是以檔案邊界實現，而不是把所有 secret 注入每個 service。Canonical Compose 只把每個 service 所需的 key 映射進去；不要對所有 service 使用同一個 `env_file`。

### 操作規則

- Dagu 保留 `env_file`/Compose secret mount 的功能：process env 供 DAG 使用，`/etc/alpha-lab/dagu.env` 供現有 step 的 `source` 契約使用。正式檔由 Compose `secrets` 掛入 container，不再是 automation source bind mount。
  Canonical Dagu service 必須宣告上述 `env_file`；`environment` 僅覆寫
  container DNS（例如 `HINDSIGHT_BASE_URL`），不得以 `${MINIMAX_API_KEY}`
  等 interpolation 取代 secret，避免依賴 `stack.env` 提供 API key。
- Secrets 不得出現在 Dockerfile `ARG`、`ENV`、image label、build cache、Git commit、Compose YAML 或 CI log。
- `docker compose config` 可能展開 secret；驗證時輸出導向受控檔案並清理，或只執行 `--quiet`。
- Hindsight DB password 若嵌入 `HINDSIGHT_API_DATABASE_URL`，生成 URL 時必須 percent-encode；不要手工把含 `@`、`:`、`#` 的 password 拼進 URL。
- 切換期間不輪換 secret；先確保資料與網路切換成功，再另開變更執行 rotation，避免把遷移故障與 credential 故障混在一起。

## 8. 有序遷移步驟

### Phase A：盤點與備份（不停止 production）

1. 在 VM 保存四個現行 Compose 的 `docker compose config`、`docker inspect`、labels、container image digest、port、mount、network、healthcheck 與所有環境變數名稱；secret 值不得寫入報告。
2. 取得 Hindsight 原 compose、`.env` 的受控備份；取得 mastra compose 及 `mastra-selfhost:local` image digest；確認 mastra volume 的實際 mount target。
3. 確認 research orphan 的 `postgres:16-alpine` 實際 `POSTGRES_USER`、`POSTGRES_DB`、password source、volume `research_pgdata` 與 schema。原 compose 遺失時，`docker inspect` 是 authority，不可自行重設 credentials。
4. 對 Dagu state、Hindsight `pg_data` 做檔案 manifest；對兩個 Postgres 做 `pg_dumpall`/database dump（寫入 VM 受控備份位置）；對 mastra data 做 volume archive 或應用層 export。
5. 驗證可用磁碟空間至少為待搬資料兩倍（來源 + 暫存/volume），並測試備份檔可以讀取。

### Phase B：準備 image、Compose 與 volumes

6. push `main` 觸發 `.github/workflows/build-images.yml`；workflow 以 repo root
   build Dagu image、以 `automation/deploy/dagu` build dags-sync image，
   將完整 commit SHA 與 `latest` 推到 `ghcr.io/taiwanta/alpha-lab-dagu`
   及 `ghcr.io/taiwanta/alpha-lab-dags-sync`。確認 GHCR package digest，
   並確認 build context 沒有 secret。
7. 因 repo 目前為 private，在 VM 建立僅具 GHCR `read:packages` 權限的
   credential，先執行 `docker login ghcr.io`；不可假定 public anonymous pull。
   以 `ALPHA_LAB_IMAGE_TAG=<commit SHA>` 產生 deploy env，並執行
   `docker compose pull` 預先確認兩個 image 可下載。
8. 將 mastra 現有 local image 以相同 bytes tag/push 到 GHCR（或另一個
   private registry），canonical Compose 改用 digest；不得讓 Compose 依賴
   `/opt/hermes/mastra-selfhost` 存在。
9. 建立 `alpha_lab_dagu_state`、`alpha_lab_hindsight_pgdata`，在舊服務仍可 rollback
   的前提下先完成資料複製與 checksum/owner 驗證。
10. 產生 `/etc/alpha-lab/stack.env` 及三份服務 secret file；把
    Dagu/Hindsight/Postgres 的 endpoint 改為 compose DNS 名稱，但保留原始
    secret value。以 `docker compose config --quiet` 驗證 interpolations。
10a. 在任何 dags-sync clone 前，建立並驗證 GitHub host key：
    從 GitHub 官方公布的 SSH fingerprint（或受控的 out-of-band 管道）
    取得預期值，對 `ssh-keyscan -t ed25519 github.com` 的結果執行
    `ssh-keygen -lf` 比對；只有比對成功才將結果以 mode `0644`、
    owner `999:982` 寫入 `/var/lib/alpha-lab/dagu/.ssh/known_hosts`。
    不得在未驗證時使用 `accept-new`；sidecar 使用
    `StrictHostKeyChecking=yes`，clone 前必須先完成這個步驟。

### Phase C：停寫與切換

11. 先停止 Dagu scheduler/dags-sync，避免 state 與 DAG 在複製後再次變更；再停止 Hindsight、research Postgres、mastra 的四個舊 Compose services。使用 `docker compose down` 時 **不得** 使用 `-v`。
12. 對剛停止的 Dagu state、Hindsight pg_data 再做一次增量 checksum/同步；若增量不同，以最後一次停止後的內容為準。確認兩個 Postgres clean shutdown 且 logical dump 完整。
13. 確認舊 container 不再佔用 `8080`、`8888`、Mastra 既有 port；舊 networks 暫時保留。
14. 執行 canonical Compose：

    ```bash
    docker compose --env-file /etc/alpha-lab/stack.env \
      -f /opt/alpha-lab/automation/deploy/docker-compose.yml \
      up -d --remove-orphans
    ```

15. `up` 後立即檢查六個 service 都是 running，且已定義 healthcheck 的
    `hindsight-db`、research Postgres、Hindsight、Mastra healthcheck
    先通過再宣告應用可用。不要用 `depends_on` 的啟動順序代替 readiness。

### Phase D：驗證與收尾

16. 檢查所有 container 都只掛 named volume/Compose secret；`docker inspect alpha-lab-dagu` 不得出現 `/opt/alpha-lab/automation` mount，`docker inspect alpha-lab-dags-sync` 也不得出現 source tree mount。
17. 從 Dagu container 驗證 DNS 與 API：`hindsight:8888`、`alpha-lab-postgres:5432`；從 VM 驗證 loopback Dagu HTTP 200、Hindsight health、Mastra health。
18. 驗證資料：
    - Dagu：state directory、admin、`.ssh` mode/owner、7 個既有 Phase 4 DAG YAML、既有 log/run/artifact 可讀。
    - Hindsight：pgvector extension、schema migration、既有 bank/memory 抽樣 recall。
    - research Postgres：schema migration 版本、既有表與 row count；執行一個受控 read-only query，再做非 production write/read smoke。
    - Mastra：health endpoint 與既有 data/metadata 抽樣。
19. 手動執行一個不觸發外部副作用的 Dagu DAG，確認 `/opt/alpha-lab/automation/scripts`、`node_modules` 與 Dagu artifact path 可用；再依既有 runbook 執行 Hindsight、Postgres、Mastra 的最小整合 smoke。
20. 觀察至少一個 dags-sync interval：確認 log 顯示 clone/fetch + rsync 成功，DAG YAML 出現在 named volume 且 Dagu reload。不要在驗證中以 host path 讀取 image source；可從 container 內 `/opt/alpha-lab/automation` 驗證 baked files。
21. 保留舊 container 定義、舊 networks、舊 bind directory 與完整備份一個既定 rollback window；驗證完成後才移除 old Compose project labels/舊 networks。最後更新 `setup-vm.sh`、`deploy-dagu.sh`、systemd unit 的部署入口，使之只呼叫 canonical Compose（本文件階段不修改這些既有檔案）。

### Rollback

Rollback 的有效邊界是 **任何 production write 發生之前**。切換前必須
先停用 Dagu production schedule、外部觸發器與寫入流量；canonical Compose
啟動後只做 read-only health/DNS/data 驗證，尚未通過 rollback gate 前不得
讓 production DAG 或 API 寫入資料。

若在 rollback gate 前任一驗證失敗：停止 canonical Compose（不得使用 `-v`，
保留新 volumes），確認沒有寫入，再重新啟動原四個 Compose project，使用
未改動的舊 bind directory、舊 named volume 與舊 networks。切換期間不刪
原目錄、不覆蓋舊 image、不輪換 credentials。

一旦已發生 production write，不得直接啟動仍指向舊資料的 Compose project；
必須先備份新 volumes，將 run records、logs、artifacts、memory 與 DB 變更
反向同步或以受控 restore/reconciliation 寫回舊資料位置，重新計算 checksum、
row count 並完成 read/write 驗證後，才可重啟舊 project。若無法完成該
reconciliation，維持 canonical Compose 並採 forward fix，避免資料遺失或雙寫
分叉。

## 9. 驗收清單

- [ ] canonical Compose 只有 6 個 services，且六個都 running；所有已定義
  healthcheck 的 service（目前為 `hindsight-db`、research Postgres、
  Hindsight、Mastra）均 healthy。
- [ ] 六個 services 都在 `alpha-lab-net`；不依賴 `hindsight-net`、`research_default`、`mastra_default`。
- [ ] Dagu image 內存在 `/opt/alpha-lab/automation/scripts`、`node_modules`、`dags`；`docker inspect` 沒有 `/opt/alpha-lab/automation` host mount。
- [ ] `dags-sync` 仍執行，每 300 秒可從 GitHub 更新 DAG；Dagu 使用 named volume 的 `dags/`。
- [ ] Dagu state、Hindsight pgvector、research Postgres、mastra 四組資料均可讀，且 manifest/row count/API 抽樣與 cutover 前一致。
- [ ] Dagu → Hindsight 使用 `http://hindsight:8888`；Dagu → research Postgres 使用 `alpha-lab-postgres`；沒有 container-localhost 錯誤。
- [ ] Hindsight compose 已 inline；mastra 使用 immutable registry image，不依賴 `/opt/hermes` 在 VM 上提供 build context。
- [ ] Secrets 沒有進 repo/image/log，且每個 service 只收到自己的 secret section。
- [ ] rollback runbook 已在保留 window 內完成 dry-run 或至少驗證可重啟原 stack。

## 10. 風險與緩解

| 風險 | 影響 | 緩解 |
|---|---|---|
| Hindsight compose 不在 alpha-lab repo，漏帶 env/healthcheck/port | Hindsight 啟動但功能異常 | 遷移前保存原 compose/config/inspect；inline 前逐欄 diff；先固定現行 image digest，不同時升級 |
| research compose 已丟失，重建時重設 DB credentials | Dagu 無法連線或資料不可解密/使用 | 以現存 container inspect、`research_pgdata` 與 dump 為 authority；保留 `alpha-lab-postgres` name/alias 與原 user/db/password |
| Hindsight pg_data bind 搬移不完整或 Postgres UID 被改壞 | DB 無法啟動或記憶遺失 | clean shutdown、logical dump + filesystem archive、tar 保留 owner/mode、先在 scratch volume restore 驗證 |
| `docker compose down -v` 誤刪 named volumes | 不可逆資料遺失 | runbook 明確禁止 `-v`；volume 名稱列入 preflight allowlist；切換前後保存 `docker volume inspect` |
| Dagu state 路徑/volume mount shadow image bootstrap | DAG、admin 或 run history 消失 | 先完整搬移 `/var/lib/alpha-lab/dagu`；明確保留 `DAGU_HOME`/`dags_dir`；新 volume 啟動前檢查檔案清單 |
| UID/GID 不一致造成 DAG 或 SSH key permission error | 排程或 Git sync 失敗 | 保留 UID 999/GID 982；檢查 `.ssh` 0700、key 0600、目錄 owner；不要事後遞迴 chown DB volume |
| 把 baked DAG 誤當成可更新 DAG，或移除 dags-sync | Git 新 DAG 不會部署 | sidecar 保留；image DAG 僅作 bootstrap；驗收至少跨一個 sync interval |
| Dagu/Hindsight 使用 `localhost` | container 只連到自己 | 所有 runtime URL 使用 Compose DNS；Dagu env 明確設 `hindsight` 與 `alpha-lab-postgres` |
| Mastra `local` image 在新 VM 不存在 | service 無法啟動 | 先以相同 image bytes push registry 並 pin digest；驗證 mount target/port/env 後才停舊 stack |
| `latest-slim` 或未鎖定 node/bun/base image 漂移 | 重建後行為不一致 | pin image tag/digest、lockfile 與 build metadata；把升級另開變更 |
| source 在 CI/build context 中意外含 secret | secret 洩漏到 layer/registry | `.dockerignore` 排除 `.env*`/keys/logs/.git；image scan；不使用 secret `ARG`/`ENV` |
| Hindsight/DB/Mastra host port 衝突 | unified Compose 起不來 | 先盤點 `docker port` 與使用者；只保留必要 loopback ports，DB 優先不 publish |
| 舊 networks/container 仍有 hidden client 依賴 | 切換後其他工具失效 | 切換前列出 network endpoints/labels；提供 DNS alias/loopback 相容期；rollback window 結束後才清理 |
| Compose interpolation 展開 secret 到診斷輸出 | credential 洩漏 | `stack.env` 0440、限制執行帳號；`config --quiet`；禁止把完整 config/環境輸出貼到 log |

## 11. 非本次實作範圍

本文件已同步記錄 GHCR/GitHub Actions image build wiring；本次實作修改
Dockerfile、`.dockerignore`、workflow 與現行 Dagu compose，但尚未執行
四 stack 的 VM cutover。canonical 六服務 Compose、volume 搬移、
`setup-vm.sh`/`deploy-dagu.sh`/systemd 入口更新，仍須依本設計在後續
變更中完成，並保留 rollback window。
