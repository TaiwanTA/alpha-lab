# AGENTS.md — Workspace

## 這裡做什麼
你是「知名投資人研究」的 agent:
- 抓資料(X / Reddit / SEC 13F 等),寫入資料湖
- LLM 分析推文 / 持股 / 訪談,產出 findings
- 維護一個對外的 blog(部署到 Cloudflare Pages,已上線)
- 反思產出、校準判斷、模擬下注(Phase 4)

## 兩個環境
- **local workspace** — commit 跟 dev 用,看 `research/AGENTS.md` 跟 `blog/AGENTS.md`
  - `research/` — pipeline 程式碼 + raw + tests
  - `blog/` — 對外發表,已上線(Cloudflare Pages auto-deploy from git push)
- **VM** — 部署目標,跑 workflow server + Postgres + Hindsight
  - `gcloud compute ssh --zone "asia-east1-b" "alpha-lab" --project "g6online-352310"`
  - 部署路徑:`/opt/alpha-lab/research/`(VM 上不是 git repo,用 `research/scripts/deploy-vm.sh` 部署)
  - bun 在 `~/.bun/bin`(沒加進系統 PATH,跑命令前 `export PATH=$HOME/.bun/bin:$PATH`;systemd unit 內有顯式 `Environment="PATH=..."` cover)
  - Postgres 跑在 docker container `alpha-lab-postgres`,绑 `127.0.0.1:5432`
  - Hindsight 跑在 docker container `hermes-hindsight-1`(沿用 hermes 既有 instance),绑 `127.0.0.1:8888`;bank ID `alpha-lab`
  - workflow server:`alpha-lab-workflow.service`(systemd active)+ 4 個 timer(`alpha-lab-{a,b,d-pre,d-post}.timer`)

## 路徑規則
- local 工作目錄:`/home/joker/alpha-lab`(讀 `research/AGENTS.md` 跟 `blog/AGENTS.md`)
- VM 部署:`/opt/alpha-lab/...`
- 部署流程:**commit 到 main → 推 GitHub → 在 local 跑 `cd research && ./scripts/deploy-vm.sh`**(script 自動 tar + scp + 解開 + 復原 .env + bun install + migrate + workflow:setup + workflow:build + patch systemd unit + restart server + verify /health)

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
   - ✅ v3 rebuild(Dagu + Hermes + Hindsight pipeline,PR #18)
     — 取代 v2 Vercel Workflow + 研究端獨立流程;VM 上以
     systemd-managed Docker compose (`alpha-lab-dagu`) 跑
     7 步 fixture-research DAG,結果 → blog。
   - ✅ housekeeping after v3 merge (PR #19):clone ref /
     push ref 從 `rebuild/integrate` 切回 `main`(blog-publish
     push step line 131 + clone-*.sh `-b` + admin.yaml
     narrative);`admin.yaml` `git_sync.enabled` **保持 false**
     (等 migration checklist 完成再啟用,見 admin.yaml
     註解);deploy script 從 `automation/scripts/` 搬到
     `automation/ops/`;blog-publish diff gate 嚴格 scope 到
     `*.md`;docker-compose 加 `no-new-privileges` +
     `read_only`(docker-compose 尚未 active,目前 VM 仍
     systemd unit);移除 dead dep `zod`;意外發現並修
     checkout step 的 env passthrough bug。
4. ⏳ Phase 4:真實工作(投資人清單最後才決定 + 模擬下注 + 反思校準)

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
- `docker-compose.yml`:加 `security_opt: [no-new-privileges:true]` + `read_only: true` + 必要 tmpfs;docker.sock mount 帶來的 host-root 等價風險是 structural limit(為了 `docker exec hermes-hermes-1 ...` 不能拿掉),只能用 best-effort mitigation。**注意**:`/opt/alpha-lab/automation` host bind mount 是 `:ro`,加上 `read_only: true` 之後 `mkdir ./workspace` 仍會 fail;切到 docker-compose 部署前需要把 workspace 移到 bind mount 上(例如 `/var/lib/alpha-lab/dagu/workspace`)。
- `package.json` 移除 dead dep `zod`(沒有任何 import site),跟著 `bun.lock` 一起更新;`bun test automation/tests` 13/13 pass。
- `automation/scripts/deploy-dagu.sh` → `automation/ops/deploy-dagu.sh`(ops script 不是 dagu runtime 的一部分;`chmod +x scripts/*.sh` 加上 `ops/*.sh` 才能讓 deploy 過去有 +x)。

VM deploy 跑完 `sudo -u alpha-lab-dagu dagu start /var/lib/alpha-lab/dagu/dags/fixture-research.yaml` 看 7 步全綠才算收尾。
