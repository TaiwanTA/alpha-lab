# 跨切面規則

**狀態:** 撰寫中
**覆蓋範圍:** 架構、NFR 規則、檔案以 git 為主、測試策略 — 任何功能改動都要對齊這份

## 為什麼這份獨立

跨切面的事 — 系統形狀、品質要求的執行方式、儲存策略、測試方法 — 不屬於單一功能,被多個 spec 同時引用。如果分到各 feature spec 內,DRIFT-GUARD 規則散落、互相引用的負擔會長大。所以放這裡當 single source of truth,各 spec 引用。

---

## 1. 架構

### 拓樸

```
Host VM α-lab
├──────────────────────────────────────────────────────────────┐
│ 對外暴露                                                  │
│   dagu Web UI :8080   (只走 SSH tunnel — 不對外)             │
│                                                              │
│ 內部 — docker compose 網路 "alpha-lab-net"                  │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐                │
│   │ postgres │    │ hindsight│    │  dagu    │                │
│   │  :5432   │    │  :8888   │    │ cron +   │                │
│   │ items    │    │ alpha-lab│    │ DAG 執行 │                │
│   │ signals  │    │ bank id  │    │ + UI api │                │
│   └──────────┘    └──────────┘    └────┬─────┘                │
│       ▲       ▲                ▲      │                      │
│       └───────┴────────────────┴──────┤                      │
│                                        │                      │
│                                   ┌────▼─────┐                │
│                                   │  runner  │                │
│                                   │ bun +    │                │
│                                   │ agent/*  │                │
│                                   └────┬─────┘                │
│                                        │                      │
│ 對外連線 (透過 runner)                  │                      │
│   → X API                              │                      │
│   → MiniMax-M3                          │                      │
│   → blog repo git push                  │                      │
└──────────────────────────────────────────────────────────────┘

Volumes:
  pg_data             — postgres 持續儲存
  hindsight_data      — hindsight 持續儲存
  dagu_data           — dagu 執行紀錄、步驟歷史、重試狀態
  snapshots_volume    — git 追蹤的 snapshots/(用於研究 repro)
                         bind-mount 自 ./research/snapshots/

Bind mounts:
  ./research          → /workspace 在 runner 內
                         (程式碼唯讀,snapshots/ 可寫)
  ./research/dags/    → /var/lib/dagu/dags/ 在 dagu 內
                         (DAG 設定檔,git 追蹤)
```

### 各服務的職責

| 服務 | 職責 | 主要貢獻的品質要求 |
|---|---|---|
| **postgres** | α-lab 業務狀態(items / signals / 執行摘要索引) | IDEMPOTENT(unique constraint + processed_at) |
| **hindsight** | 跨執行的記憶 — 對每個訊號的研究 recall / retain | RECOVERY(崩潰後仍可 recall 先前事實) |
| **dagu** | cron + DAG 執行器 + Web UI + retry | OBS(Web UI、執行歷史、步驟 log 永久保存) |
| **runner** | 所有業務邏輯的執行引擎(bun runtime + `agent/*.ts` + `lib/*.ts`)| DRIFT-GUARD(只有一個實作點,沒有 `workflow/*` 平行 inline 層)|

### 邊界原則(每個服務只做一件事)

- **postgres**:不存原始內容(只有 metadata 跟 hot index),原始資料由 git 快照保存
- **hindsight**:只管事實級記憶,不存原始推文 / 執行紀錄
- **dagu**:只編排 + UI;不存業務狀態;它自己內部 SQLite / 檔案管理執行歷史
- **runner**:唯一執行業務邏輯的地方;`agent/*` 是單一源頭,**沒有** `workflow/*` 平行層

### 網路原則

- 對外入口只有 dagu Web UI 8080,只能從 SSH tunnel 進
- 其他所有 port(postgres / hindsight / dagu 內部)只在 `alpha-lab-net` 內部 listen
- runner 是唯一對外連線的服務(X、LLM、blog git push)
- 本地開發跟正式環境用同一個 compose 檔,只差 `cron` 設成 `none` / `manual trigger`

### 各品質要求的對應

| 品質要求 | 主要機制 |
|---|---|
| OBS | dagu Web UI + dagu 內部執行歷史 |
| IDEMPOTENT | postgres unique constraint + `processed_at` 時間戳 + agent 自己守 idempotency key |
| RECOVERY | dagu 步驟層級 retry policy + VM 重啟後從 dagu 自己的狀態復原 |
| DRIFT-GUARD | compose 結構強制 runner 容器化 + CI 掃 `agent/*` 不存在 `workflow/*`(物理路徑切掉) |

> 各功能的實作層細節在自己 spec 內;本段只談系統形狀

---

## 2. 品質要求(NFR)— 4 個

### OBS(可觀察性)

**要求:** 每個 run 跟每個 step 都進 dagu Web UI;執行歷史永久保存;失敗有告警;user 可一鍵 retry / skip。

**機制:**
- dagu Web UI 路徑:`/runs`、`/dags`、`/queues`
- 告警來源:原型先不接 email / Slack,以 `journalctl -u alpha-lab-dagu` + Web UI 為主
- 原有的 `journalctl` 仍可看 dagu 跟 runner 的 stdout/stderr

### IDEMPOTENT(冪等)

**要求:** 同 stage 跑兩次,DB 跟 git 快照都單一 — 不會重複 publish、不會重複 deep research、不會重複 ingest。

**各 stage 的 idempotency key:**
| stage | key |
|---|---|
| A (X pull) | 來源 adapter 的 `last_external_id`(inclusive boundary) |
| B (signal discovery) | items 的 `processed_at` 標記;signal 的 `external_id` 群組去重 |
| C (signal research) | signal UUID |
| D (market reports) | 日期 + type(`pre` / `post`) |
| publish | 目標檔案的 slug (撞名加 `-2`、`-3` 直到不撞) |

**機制:**
- postgres unique constraint 在每個關鍵欄位(例如 `signals.external_id_group`、`items.external_id`)
- `processed_at` 在 B 階段的 item 標記上
- agent 內部函式接收 dependency injection,自己負責 idempotency 邏輯(見各 agent spec)
- 重新跑同一 stage → dagu 顯示成新 run,但資料層結果單一

### RECOVERY(復原)

**要求:** LLM rate-limit、網路中斷、X-API 失敗、hindsight 當機、OOM、雙重觸發等情況都有定義好的復原行為。

**錯誤模式矩陣:**

| 失敗 | 復原行為 |
|---|---|
| LLM rate-limit(MiniMax 429)| dagu step retry,exponential backoff(預設 3 次)|
| X-API 5xx 或 rate-limit | dagu step retry,backoff 5 次 |
| Hindsight 連不上 | step 失敗 → dagu 標記 run failed → Web UI 顯紅;不 retry(等手動)|
| postgres 連不上 | dagu 整個 DAG 失敗、報錯、需要人工介入(可能是 VM / docker 問題)|
| OOM(runner out of memory) | dagu 重啟 step,container 自動重建 |
| 網路瞬斷(X、LLM、blog push)| dagu step retry,3 次 backoff |
| 雙重觸發(兩個 dagu run 同時啟動)| 兩個 run 各自走完整 pipeline,DB unique constraint 讓結果單一 |

**retry policy 設定:**
- dagu DAG 預設:`retry: 3` + `retryInterval: 30s` + `retryBackoff: exponential`
- 個別 step 可 override(例如 publish 步驟只 retry 1 次,git conflict 第二次就 fail)

### DRIFT-GUARD(防漂移)

**要求:** 業務邏輯必須只有 single source of truth(`agent/*`),不能再出現 `workflow/*` 平行 inline 層;此規則要可被 CI 自動檢查。

**機制:**
- **物理路徑切斷**:compose 把 runner 容器化,工作目錄 mount 進來,沒有額外 inline 點
- **CI 掃描規則**(待實作):`bun run check:drift` 檢查
  - 不存在 `research/workflow/` 目錄
  - 不存在 `*Workflow` class / `use workflow` directive
  - `agent/*.ts` 必須是 dagu DAG 唯一的進入點
- **pre-commit hook**(待實作):跑 `bun run check:drift`
- **pre-deploy check**(待實作):同 `bun run check:drift`,但從 CI 觸發

> DRIFT-GUARD 是這次 v2 想杜絕的「workflow/b.ts 跟 agent/b.ts 業務邏輯分歧」問題的結構性解法 — 物理路徑切斷 + CI 掃描 + PR gate 三層

---

## 3. 檔案以 git 為主

### 規則

任何「內容型產物」預設放 git(版本化、可回溯、PR 可 review);只有「需要 SQL 查詢的索引」進 DB。

| 產物類型 | 放哪 | 為什麼 |
|---|---|---|
| 研究 markdown | git(`blog/src/content/blog/`)| 已是 git 追蹤;Cloudflare Pages auto-deploy |
| 4 個 dagu DAG yaml | git(`research/dags/`)| 排程設定是 IAC,要 review、要版本化 |
| LLM 提示詞模板 | git(`research/prompts/`)| 內容、可改良、可追溯 |
| 每訊號的快照 | git(`research/snapshots/<signal_id>/`)| repro 用,DB 不適合放原始 json blob |
| 原始 X 推文 | git(`research/raw/<source_type>/<source_label>/<YYYY-MM>/<YYYY-MM-DD>.jsonl`)| 不可變歷史,append-only |
| LLM provider / API key 設定 | git(`research/config/llm.yaml` 結構;secret 走 `.env`)| 設定要版本化,secret 走 env |
| Signal 的 metadata(status / importance / tags / 來源 item 連結)| DB(`signals` 表)| 要 query 「active」、「by importance」、「by tag」 |
| X 推文 hot index(external_id → context, processed_at)| DB(`items` 表)| 查 unprocessed / by source / by time range 是 hot path |
| 執行摘要索引 | DB(`runs_summary` 表,待開)| dagu 已有 run history,這個表只給跨 run 統計 |
| Pipeline 日誌 | 檔案(`LOG_DIR` — loglayer 寫到 `logs/`,gitignore)| 高頻寫入、不可變歷史 |

**同一份資料可能兩處都有**,只是不同面向:raw tweet 既是「不可變歷史」進 git,也是「hot index」進 DB(`items`)。git 那份是完整 payload,DB 那份給快速查詢。

### 沿用現有策略

- `raw/` 不可變(`research/AGENTS.md` 「寫入規範」)— 沿用
- `findings/` / `wiki/` 給 raw 修正的另寫處 — 沿用
- migrations append-only(不下 down)— 沿用

---

## 4. 測試策略

### 既有基準

- 245 個單元測試(沿用 `research/tests/`)
- 4 個 SQL migrations(已 apply,沿用)
- 既有 integration 測試透過 `bun run typecheck` + `bun test`(沿用)

### 各 layer

| 測試類型 | 範圍 | 怎麼跑 |
|---|---|---|
| **單元測試** | `agent/*`、`lib/*`、`dagu/*.yaml` schema | `bun test research/tests/` |
| **整合測試** | 整套 pipeline 跑 fixture | `bun run test:integration`(本地 compose up + fixture 跑 A/B/C/D 全 cycle)|
| **DRIFT-GUARD 測試** | 掃 `agent/*` 跟禁止 pattern | `bun run check:drift`(CI gate)|
| **IDEMPOTENT re-run 測試** | 同 stage 跑 2 次,DB + git 唯一 | `bun run test:idempotent`(整合測試子任務)|
| **切換演練** | 手動 checklist | 等美股收盤後驗收(Q4 cadence)|

### CI gate(待實作)

- `bun test` — 單元測試全過
- `bun run typecheck` — TypeScript 全過
- `bun run check:drift` — 沒有平行實作 pattern
- `bun run test:idempotent` — 重新跑不會重複

---

## 5. 沿用 α-lab AGENTS.md 既有決定(不重設計)

| 對象 | 狀態 | 來源 |
|---|---|---|
| 以 Postgres 當資料儲存(items / signals) | 沿用 | `research/AGENTS.md`「已達成決定」 |
| Schema 設計哲學(items 是給 LLM 看的索引層,原始 payload 不進表) | 沿用 | 同上 |
| Raw 檔案不可變,改動另寫到 `findings/` / `wiki/` | 沿用 | 同上 |
| Adapter 模式 + `source_type` / `source_label` 是 free-form TEXT | 沿用 | 同上 |
| 自寫 migrator + migrations 是 append-only(不下 down) | 沿用 | 同上 |
| 現有 4 個 SQL migrations(`001` 到 `004`) | 完全保留 | git 紀錄 |
| 245 個單元測試基準 | 沿用,本檔第 4 節擴充 | test count |
| `agent/lib/llm.ts`(MiniMax native + thinking 適配) | 沿用 | PR #13, #14 |
| `lib/publish.ts` + `publish.ts`(CLI + lib helper) | 沿用 | `publish.ts` 邏輯不動 |
| Hindsight bank ID `alpha-lab` | 沿用 | ADR-001 v1 設定 |

> 改這些 baseline 中的任何一條,要在 commit message 內解釋為什麼、引用這份 spec

---

## 6. 跨切面規則的修改原則

- 改本檔需要 review(spec 是 source of truth)
- 改實作時若發現「本檔寫得跟實作對不上」,先改 spec 再改實作
- CI `bun run check:drift` 失敗 → PR fail,不合併
