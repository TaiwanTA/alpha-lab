# AGENTS.md — Workspace

## 這裡做什麼
你是「知名投資人研究」的 agent:
- 抓資料(X / Reddit / SEC 13F 等),寫入資料湖
- LLM 分析推文 / 持股 / 訪談,產出 findings
- 維護一個對外的 blog(部署到 Cloudflare Pages,已上線)
- 反思產出、校準判斷、模擬下注(Phase 4)

## 兩個環境
- **local workspace** — commit 跟 dev 用,看 `blog/AGENTS.md`
  - `automation/` — v3 dagu runtime (DAGs + 部署腳本
    + research-agent.ts + dags-sync sidecar + setup-vm.sh
    + docker-compose.yml + Dockerfile.dagu + Dockerfile.dags-sync
    + alpha-lab-dagu.service)
  - `blog/` — 對外發表,已上線(Cloudflare Pages auto-deploy from git push)
- **VM** — 部署目標,v3 compose stack 跑 production(v2 已除役)
  - `gcloud compute ssh --zone "asia-east1-b" "alpha-lab" --project "g6online-352310"`
  - v2 路徑:`/opt/alpha-lab/research/`(已除役;
    systemd units 已 `disable --now`)
  - v3 路徑:`/opt/alpha-lab/automation/`(用
    `automation/ops/deploy-dagu.sh` 部署;systemd
    `alpha-lab-dagu.service` 跑 docker compose stack
    — dagu 跟 dags-sync 兩個 container,compose
    wrapper unit,已切換為 production)
  - bun 在 `~/.bun/bin`(沒加進系統 PATH,跑命令前 `export PATH=$HOME/.bun/bin:$PATH`;systemd unit 內有顯式 `Environment="PATH=..."` cover)
  - Postgres 跑在 docker container `alpha-lab-postgres`,绑 `127.0.0.1:5432`
  - Hindsight 跑在 docker container `hermes-hindsight-1`(沿用 hermes 既有 instance),绑 `127.0.0.1:8888`;bank ID `alpha-lab`
  - **v3 切換已完成**(PR #25):v3 dagu 從 native binary
    切到 docker compose 模式。dagu 跟 dags-sync 為兩個
    docker container,systemd unit `alpha-lab-dagu.service`
    變成 compose wrapper。VM e2e 全綠:fixture-research DAG
    在 compose stack 上端到端跑通,成功 push blog post 到
    main。v3 production 完成。
  - **v2 已除役**:v2 systemd units 已 `disable --now`:
    `alpha-lab-workflow.service` + 4 個 timer
    `alpha-lab-{a,b,d-pre,d-post}.timer` 全部 inactive +
    disabled。`/opt/alpha-lab/research/` 目錄跟 `research/`
    repo 程式碼暫保留(等 user 確認後清掉)。

## 路徑規則
- 部署流程(v3 automation):commit 到 main → 推 GitHub → 在 local
  跑 `cd automation && bash ops/deploy-dagu.sh`(script 自動 tar
  + scp + 解開 /opt/alpha-lab/automation + 部署 admin.yaml 到
  /var/lib/alpha-lab/dagu/admin.yaml + systemctl reload
  alpha-lab-dagu.service (ExecReload = docker compose
  up -d --force-recreate) + verify systemd active / 兩個
  container running / dagu http 200)
- 新 VM 設置:用一般 user (非 root) 跑 `cd
  /opt/alpha-lab/automation && bash scripts/setup-vm.sh`
  (互動讀 SSH deploy key 來源 / secrets 寫入
  /etc/alpha-lab/dagu.env / 預建 hindsight-net / `docker
  compose up -d` / verify)
- VM 部署:`/opt/alpha-lab/...`
## 進度

> Phase 1-3 全部完成 + VM 上線 production。Phase 4 還沒開始。

1. ✅ Phase 1:工作區規劃
2. ✅ Phase 2:blog tech stack + 上線(user 確認 OK)
3. ✅ Phase 3:資料 pipeline + LLM 分析 + 排程
   - ✅ A agent:X → Postgres(workflow `aWorkflow`),Bill Ackman 一個 source
   - ✅ B agent:訊號發現(workflow `bWorkflow`),處理 items + LLM 找 signals
   - ✅ C agent:per-signal 研究(workflow `cWorkflow`),recall/retain Hindsight + 寫 markdown draft
   - ✅ D agent:盤前/盤後報告(workflow `dWorkflow`),美股盤前 + 盤後 markdown draft
   - ✅ Vercel Workflow 整合(`workflow/{a,b,c,d}.ts` + `workflow-server.ts` + `bunfig.toml` SWC plugin + `scripts/workflow-build.mjs`)
   - ✅ systemd timer 排程(A 6h / B 1h / D pre+post Mon-Fri ET)
   - ✅ publish.ts:C/D 的 markdown draft → `blog/src/content/blog/`(tag:盤前報告 / 盤後報告 / 事件追蹤)
   - ✅ v3 rebuild(Dagu + Hindsight pipeline,PR #18)
     — 取代 v2 Vercel Workflow + 研究端獨立流程;VM 上以
     systemd service (`alpha-lab-dagu`) 跑 6 步
     fixture-research DAG,結果 → blog。
   - ✅ housekeeping after v3 merge (PR #19):clone ref /
     push ref 從 `rebuild/integrate` 切回 `main`;deploy
     script 從 `automation/scripts/` 搬到
     `automation/ops/`;blog-publish diff gate 嚴格 scope
     到 `*.md`;docker-compose 加 hardening(尚未 active);
     移除 dead dep `zod`;修 checkout env passthrough bug。
   - ✅ Hermes 替換為自建 research-agent.ts(P0 fix):
     Hermes 容器的 UID mismatch + Hindsight "Server
     disconnected" 兩個 P0 無法在不改 hermes source 的情況下
     修復。改用 self-contained TypeScript agent(直接 fetch
     LLM API + Hindsight API,不經過 Docker 容器),同一個
     MiniMax-M3 模型,同一個 Hindsight endpoint。7 步 DAG
     簡化為 6 步(retain + recall + hermes 合併為 1 步 `research`)。
     `hermes-call.sh` / `hindsight-retain.sh` /
     `hindsight-recall.sh` 移到 `.delete/`。local smoke test:
     failure-path 全正確 reject。VM e2e 全綠(PR #20)。
   - ✅ push step 改用 SSH deploy key(PR #21):
     dagu `${env.X}` 截斷長 token + repo ruleset 擋 direct
     push。改用 SSH deploy key + ruleset bypass。fixture
     DAG 端到端全綠,自動 push 了一篇 blog post 到 main
     (commit `cc8c035`)。
4. ⏳ Phase 4:真實工作(投資人清單最後才決定 + 模擬下注 + 反思校準)

5. ✅ Dagu runtime 切到 docker compose 模式(PR #25):新增
   `automation/deploy/dagu/dags-sync.sh`(sidecar 從 main 拉
   automation/dags/ 到 dags_dir bind mount 子目錄)跟
   `automation/scripts/setup-vm.sh`(在新 VM 一鍵重現
   dagu runtime);自建 `automation/deploy/dagu/Dockerfile.dagu`
   (官方 dagu:2.10.7 + git/node22/bun/ssh/rsync)跟
   `Dockerfile.dags-sync`(alpine + git/openssh/rsync);
   `admin.yaml` `dags_dir` 維持 `/var/lib/alpha-lab/dagu/dags`
   (bind mount 子目錄,跟 native 模式一致,不拆 named volume);
   `ops/deploy-dagu.sh` 用 `systemctl reload`(走 ExecReload =
   `docker compose up -d --force-recreate`)取代直接 `cp dags` +
   `systemctl restart`。VM 切換已完成:systemd unit 改為 compose
   wrapper,dagu + dags-sync 兩個 container 跑 production,
   e2e 全綠(fixture-research DAG 成功 push blog post 到 main,
   commit `1918f48`)。

> 不要搶進。做一步停一步等 user 確認。
> 不要自認階段完成:必須 user 確認才算階段結,特別是風格這類主觀判定。

## Blog 長度風格
依類型調整長度密度,不要為長而長:
- **主題研究**(深度分析一個投資人)→ 完整、結構齊全
- **單一事件/發言分析** → 簡短、聚焦一個 insight
- **持股/組合觀察** → 表格為主、敘述為輔
- **方法論比較** → 短文、一個觀點打完收工

原則:每一段要扛一個 source 或一個 insight;撐不起來的話就刪掉。

## 維護
這份文件要隨進展更新(階段完成 ✅ 改 ⏳、新決定補上、過時資訊刪掉)。

## Housekeeping log

### 2026-07-14 — v3 rebuild merge + post-merge fixes (PR #18 + PR #19)

- v3 Dagu + Hermes + Hindsight pipeline 走完 review(19/26 review threads resolved;`626633c` 後剩 4 個 pre-existing finding 在 housekeeping PR 處理);squash 合併 PR #18 (commit `a0de336`)。
- PR #19 (`chore/v3-housekeeping`) 收尾:
- 分支 / push ref 從 `rebuild/integrate` 切回 `main`(4 個檔:`clone-fixture.sh`、`clone-publish.sh`、`blog-publish.yaml` push step `git push HEAD:rebuild/integrate` → `HEAD:main`、admin.yaml narrative comment)。
- `admin.yaml` `git_sync.enabled` **保持 false**(PR #19 merge + 部署完之前不能 enable,會 overwrite 剛 deploy 的 DAG);附 migration checklist 給後續單獨 enable 操作。詳見 `automation/deploy/dagu/admin.yaml` 檔頭 comment。
- `fixture-research.yaml` / `blog-publish.yaml` 的 checkout step 修 env passthrough bug:dagu 2.10.7 step 子進程不會 inherit systemd `EnvironmentFile` 到 step subprocess,需要 `env: GIT_READ_TOKEN: ${env.GIT_READ_TOKEN}` block。
- `blog-publish.yaml` diff gate 修正:`git add -- blog/src/content/blog` → `git add -- 'blog/src/content/blog/*.md'`,避免 build artifact (`package-lock.json`、`.astro/`、`dist/`) 被偷偷 stage 進來。
- `deploy-dagu.sh` chmod 用 nullglob guard,`scripts/*.sh` 或 `ops/*.sh` 空目錄不會 abort deploy。
- `docker-compose.yml`:PR #19 加了 `security_opt: [no-new-privileges:true]` + `read_only: true` + 必要 tmpfs,但 PR #25 compose 切換時未採用(npm/bun/git 需要寫 cache 到 $HOME,`read_only` 會 fail)。workspace 已經在 bind mount `/var/lib/alpha-lab/dagu/data/workspaces/` 上;將來重新 enable hardening 需要把 $HOME/cache 也指向 bind mount。docker.sock mount 在 Hermes 移除後已拿掉。
- `package.json` 移除 dead dep `zod`(沒有任何 import site),跟著 `bun.lock` 一起更新;`bun test automation/tests` 13/13 pass。

### 2026-07-14 — Hermes 移除 + research-agent.ts (PR #20)

VM e2e step 6-7 原先失敗(Hermes 容器 UID mismatch +
Hindsight "Server disconnected")。Root cause:Hermes 容器內
`write_file` 走 `/workspace/.hermes-tmp.X` 暫存,但 hermes
process (UID 10000) 對 bind mount 目錄沒寫入權限;Hindsight
recall 在容器內也 fail(TCP connect OK 但 API 回 disconnect)。
這些是 Hermes 作為 Docker 容器黑盒的根本問題。

**決策**:移除 Hermes,改用自建 `research-agent.ts`(self-
contained TypeScript,直接 fetch LLM + Hindsight API)。同一個
MiniMax-M3 模型,同一個 Hindsight endpoint,零容器層。把
`hermes-call.sh` / `hindsight-retain.sh` / `hindsight-recall.sh`
移到 `.delete/`;DAG 從 7 步(retain → recall → hermes)簡化
為 6 步(一步 `research` 完成 retain + recall + LLM call +
candidate 組裝)。VM e2e 全綠。

### 2026-07-14 — push step 改用 SSH deploy key (PR #21)

dagu `${env.X}` 截斷長 token + repo ruleset 擋 direct push。
改用 SSH deploy key + repo-level ruleset (18699827) DeployKey
bypass。fixture DAG 端到端全綠,自動 push blog post 到 main
(commit `cc8c035`)。

### 2026-07-15 — dagu runtime 切到 docker compose (PR #25)

systemd unit 從 native binary 改為 compose wrapper
(`alpha-lab-dagu.service`)。dagu + dags-sync 兩個 container 跑
production。自建 `Dockerfile.dagu`(官方 dagu:2.10.7 +
git/node22/bun/ssh/rsync)+ `Dockerfile.dags-sync`(alpine +
git/openssh/rsync)。DAG YAML 加 `shell: ["bash", "-e"]` +
頂層 `env:` block(`${NAME}` import host env vars 到 dagu env
scope)。

e2e 全綠:fixture-research DAG 在 compose stack 上端到端跑通,
成功 push blog post 到 main(commit `1918f48`)。LLM env vars
(`LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`)在
`/etc/alpha-lab/dagu.env`(MiniMax native API)。

### 2026-07-15 — compose 切換收尾 + dags-sync fix + v2 除役 (PR #26)

- **PR #26**:`dags-sync.sh` `git pull` → `git fetch --depth 1` +
  `git reset --hard origin/<branch>`。shallow `--depth 1` clone
  下 git pull 遇到 force-push 會因找不到共同祖先而 fail;
  fetch + reset --hard 不需要 common ancestor,直接強制對齊
  remote state。同 PR 更新 AGENTS.md(v3 切換完成 + v2 除役
  標記)。v2 systemd units 除役:5 個 v2 unit 全部
  `disable --now`,inactive + disabled。
- **PR #27**:`deploy-dagu.sh` step 6 verify 的 `sed 's/^/      /'`
  單引號被外層 `--command '...'` 吃掉 → 改用雙引號。
- **GitHub ruleset**:org-level (6159190, TaiwanTA "default")
  由 user 加 DeployKey bypass (always mode)。repo-level
  (18699827) 既有 DeployKey bypass 仍有效。兩個 ruleset 都只
  target `~DEFAULT_BRANCH` (main)。
- `git_sync.enabled` 維持 false:dagu v2.10.7 git_sync
  interval tick 不觸發(已驗證限制)。DAG 同步由外部
  dags-sync sidecar 處理,跟 dagu 內部 git_sync 解耦。
