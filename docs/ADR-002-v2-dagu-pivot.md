# ADR-002: α-lab v2 — 把排程與編排交回 dagu

**狀態:** 已採用(2026-07-10)
**取代:** `research/docs/ADR-001-pipeline-redesign.md`(本提交 git 刪除;完整歷史可從 `git log -p -- research/docs/ADR-001-pipeline-redesign.md` 找回)

## 動機

α-lab 是投資人研究的 pipeline:從外部來源拉資料(X,預留 Reddit、SEC 13F 等),跑 LLM agent 分析(ABCD 四段),把研究 markdown 發到 `blog/src/content/blog/`(已上線 Cloudflare Pages)。

### v1 到 v2 這段旅程(關鍵 commit)

- `1d34572`(2026-07-09)— ADR-001 首次提出,ABCD pipeline + dagu 跟 Vercel Workflow 的比較,當時選了 **Vercel Workflow**
- `193736e` — 正式記錄從 dagu 轉到 Vercel Workflow,理由:in-process TS SDK、Postgres World 可以共用 alpha-lab 的 Postgres instance、不用額外起 8080 server
- `dab7c6e`(PR #10)— Vercel Workflow + systemd timer 整合上線
- `334b2c5`(PR #17)— ADR-001 末段補上 6 個 self-host workaround 的紀錄

### 為什麼要把方向轉回來

PR #10 之後 12 個 PR、約 13 小時的工作,逐漸暴露出 v1 的問題:

1. **6 個系統層級的補丁** 為了在 Bun self-host 環境跑起 Vercel Workflow SDK 才能寫(細節見 ADR-001 「紀錄」段 line 163-173)
2. **Workflow 業務邏輯跟主程式分家** — `lib/logger.ts` 在 module 層級拉 `node:fs` / `node:os`,SDK 的 `workflow-node-module-error` esbuild plugin 會擋;workaround 是把業務邏輯整段寫進 `workflow/*.ts`,結果 `workflow/b.ts` 跟 `agent/b.ts` 出現平行實作(`workflow/b.ts` 302 行 vs `agent/b.ts` 352 行,validateCandidate 函式的錯誤訊息粒度不一樣)
3. **看不清楚** — Vercel Workflow 的執行狀態全在 `workflow_runs` / `workflow_steps` 兩個資料表,**沒有 UI**;要查哪次 run 失敗,得翻 `psql` 跟 `journalctl`
4. **規格跟實作跑出歧異** — `workflow/b.ts` 跟 `agent/b.ts` 訊息粒度已經分歧,production 跑的是 inline 精簡版,測試比較齊的反而是另一個檔
5. **Oracle 驗證過**:workflow/b.ts 跟 agent/b.ts 的相同業務邏輯已經漸偏(progressive risk,不是單一 bug)— 每次加 feature 都會重新引進 inline 平行版本,除非有結構性約束擋下來

原型階段壓力下,這個漂移跟補丁只會繼續長。要沒有「規格即契約」的機制,改一個 feature 就會再 inline 一次。

## 決定

α-lab v2 採取五個核心決定:

1. **把 Vercel Workflow 換成 dagu** — 本地優先的 workflow engine(單一執行檔、檔案式狀態、YAML 格式的 DAG、8080 port 的 Web UI),cron、retry、執行歷史、UI 都內建
2. **以 docker compose 為部署黃金標準** — postgres / hindsight / dagu / runner 四個服務同一個 `docker-compose.yml` 一次拉起來;移植性、重現性、本地開發行為一致
3. **檔案以 git 為主** — 內容型產物(報告、提示詞、訊號快照、DAG 設定)放 git;資料庫只放需要查詢的索引(訊號、推文項目、執行摘要)
4. **本地開發用假資料** — 抓 X 跟其他昂貴的 API,本機用 fixture 跑;正式環境打真的;`bun run fixtures/` 或環境變數切換
5. **業務邏輯單一源頭** — `agent/*.ts` 是唯一的執行路徑,**不能有** `workflow/*.ts` 這種平行實作;DRIFT-GUARD 靠 CI 掃描跟 compose 結構強制(執行器在容器內,工作目錄是 mount 進來的,沒有額外的 inline 點)

### 為什麼這五個是一組

- dagu 把 in-process SDK 的責任換成外部編排器,自帶 UI、retry、執行歷史 — 補回 Vercel Workflow 缺的觀察能力
- docker compose 把現在的 systemd unit 跟手工部署腳本換成宣告式檔案 — 一行 `docker compose up` 拉起整套
- 檔案以 git 為主,跟 dagu 檔案式狀態天然契合 — DAG 是 YAML(自然進 git)、快照是目錄(自然進 git)、報告本來就在 git(走 `blog/src/content/blog/`)
- 執行器容器化加上結構性約束,把 inline 平行版本的物理路徑切掉 — 沒有 `workflow/*.ts` 這個資料夾,就不會出現平行實作

### 拒絕的方案

| 方案 | 為什麼不選 |
|---|---|
| 留下 Vercel Workflow,補上 log viewer 跟 retry UI | 在自己手寫半套編排器,6 個 SDK 補丁的維護負擔也不會消失 |
| 用 GitHub Actions 自架 runner | 排程在高負載會被延遲或丟掉(GitHub 官方文件有明寫);runner 斷線時排隊上限 24 小時;自架 runner 對公開 repo 還會變成攻擊面;α-lab 沒有 PR 觸發需求,GHA 真正的賣點在這裡沒價值 |
| 用 dagu 但執行器放主機 | 只有狀態層可以移植,執行層還是卡在 VM 的 bun install 跟環境變數;不符合黃金標準 |

### 為什麼 dagu 適合 α-lab

- **本地優先**:VM 重啟不丟排程狀態;UI 即使在外網不穩時也還能用
- **單一執行檔加檔案式設定**:YAML 在 git,容易在 PR 看
- **內建 cron、retry、執行歷史、Web UI** — 這幾樣正好是 α-lab 缺的
- **不依賴外部服務** — 不用 GitHub.com,不用 Vercel dashboard

## 實作層的細節(將在 spec doc Section 2 到 5 展開)

- 4 個 dagu DAG,放在 `research/dags/{pull,discover,research,reports}.yaml`
- 執行器是常駐容器(bun runtime 加上 `agent/*` 跟 `lib/*` 跟 `publish.ts`)
- Postgres 的 `items` 跟 `signals` 表沿用;新增 `runs_summary` 表給跨執行統計
- Hindsight 容器沿用,bank ID 維持 `alpha-lab`
- 現有 4 個 SQL migrations(`001` 到 `004`)完全保留
- 訊號快照目錄 `research/snapshots/<signal_id>/`,每個訊號放 `{raw_tweets.md, llm_input.json, llm_output.json}` 當 repro 依據
- 現有 `pull.ts` / `publish.ts` / `migrate.ts` 沿用,只是被 dagu 步驟呼叫,而不是 systemd timer 觸發 curl

## 遷移計畫

1. **Phase 0**(本提交)— 文件鷹架 + ADR-002 + spec doc Section 1 骨架
2. **Phase 1** — spec doc 第 2(元件)到第 5(測試)段完成並經過核准
3. **Phase 2** — 實作:docker-compose 撰寫、dagu DAG、執行器映像、AGENTS.md 重寫、移除 v1 的東西
4. **Phase 3** — 切換:週末部署到 VM,等下一個美股交易日收盤後驗收;若需要修,再等下個收盤日循環
5. **Phase 4** — 穩定期一週(dagu Web UI 看所有執行、訊號表看 trace、快照看 repro,全部驗證過才算 done)

**一次到位**(不留 Vercel Workflow 的相容層)— 切換後 `workflow/*.ts`、`workflow-server.ts`、`scripts/workflow-plugin.ts`、`scripts/workflow-build.mjs`、`bunfig.toml` 全部移除。

## 後果

### 好的方面
- 業務邏輯單一源頭(`agent/*.ts`),inline 平行版物理路徑切掉
- dagu Web UI 補回 v1 缺的觀察能力
- docker-compose 黃金標準達標,本地開發行為一致
- 檔案以 git 為主,符合 α-lab 對內容版的偏好

### 不好的方面
- 多一個 dagu 服務要監控
- 失去「in-process TS SDK」的便利 — bun 腳本跑在容器內,呼叫邊界是 `docker compose exec`(每個步驟約 5 毫秒額外成本,可接受)
- dagu 沒有 Vercel Workflow SDK 那麼成熟,UI 細緻度可能較差
- 跨機器的 workflow SDK 生態(例如第三方儀表板)就用不到了

### 怎麼緩解
- dagu 是單一 Go 執行檔,資源 footprint 可預期,加 compose healthcheck 監控
- 接受 dagu 的慣用做法,不要硬套舊的心智模型
- 切換手動(美股收盤日的驗收節奏)— 沒有自動遷移腳本,避免默默失敗的風險

## 參考

- α-lab workspace-root `AGENTS.md` — 工作區根狀態
- [`docs/specs/2026-07-10-alpha-lab-v2-design.md`](specs/2026-07-10-alpha-lab-v2-design.md) — v2 完整 spec 設計文件(end-to-end 在那)
- `research/AGENTS.md` — research 子元件的指南(sections 待 v2 落定後重寫)
