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
