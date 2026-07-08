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
  - `blog/` — 對外發表,已上線
- **VM** — 部署目標,跑 pipeline 跟 Postgres
  - `gcloud compute ssh --zone "asia-east1-b" "alpha-lab" --project "g6online-352310"`
  - 部署路徑:`/opt/alpha-lab/research/`
  - bun 在 `~/.bun/bin`(沒加進系統 PATH,跑命令前 `export PATH=$HOME/.bun/bin:$PATH`)
  - Postgres 跑在 `docker compose`,`alpha-lab-postgres` container,绑 `127.0.0.1:5432`

## 路徑規則
- local 工作目錄:`/home/joker/alpha-lab`(讀 `research/AGENTS.md` 跟 `blog/AGENTS.md`)
- VM 部署:`/opt/alpha-lab/...`
- 部署流程:local commit → tar(exclude node_modules + .env) → scp → 在 VM 解開 → `bun install` + `bun run migrate`

## 路徑規則(寫檔前先看)
- 用 cwd 相對路徑 或絕對路徑
- 部署到 VM 用 `/opt/alpha-lab/...`

## 進度

> 舊 phase plan 已過時,這裡只標當前ground truth。後續方案見下方「後續規劃」段。

1. ✅ Phase 1:工作區規劃
2. ✅ Phase 2:blog tech stack + 上線(user 確認 OK)
3. ⏳ Phase 3:資料 pipeline + LLM 分析
   - ✅ Pipeline:X → Postgres,Bill Ackman 一個 source,~1093 條 items 入庫
   - ⏳ LLM agent 消費 items 表(還沒做)
   - ⏳ Dagu 排程(還沒裝)
4. ⏳ Phase 4:真實工作(投資人清單最後才決定)

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
