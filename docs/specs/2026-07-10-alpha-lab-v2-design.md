# α-lab v2 設計規格

**狀態:** 撰寫中(2026-07-10 brainstorming 進行中)
**權威 ADR:** [`../ADR-002-v2-dagu-pivot.md`](../ADR-002-v2-dagu-pivot.md)
**工作區根目錄:** `/home/joker/alpha-lab/`(research/ + blog/ + docs/ 三層)

## 各章節

- ✅ **第 1 節:架構** — 於 2026-07-10 提交
- ⏳ 第 2 節:元件 + agent/* 邊界(下一段)
- ⏳ 第 3 節:資料流(A/B/C/D pipeline + 發布)
- ⏳ 第 4 節:錯誤處理 / 品質要求(OBS + IDEMPOTENT + RECOVERY + DRIFT-GUARD)
- ⏳ 第 5 節:測試策略

---

## 鎖定約束(Q1 到 Q5 加上補充)

| 維度 | 答案 | 出處 |
|---|---|---|
| 範圍 | 完整 v2 — X pull + signals + research + reports + publish 全部從 spec 重設計 | Q1 = A |
| 使用情境 | 非人介入自動發布到 blog,user 是主要讀者;失敗有告警但不擋 pipeline | Q2 = A |
| 品質要求 | OBS + IDEMPOTENT + RECOVERY + DRIFT-GUARD | Q3 = C |
| 完成標準 | 發布 → 等下一個美股交易日收盤 → 驗收;若需要修 → 等下一個收盤日循環 | Q4 = C |
| 部署 | docker compose 黃金標準(四個服務全部容器化) | user 明確 |
| 儲存 | 以 git 為主;資料庫只放可查詢索引 | user 明確 |
| 本地開發 | 假資料給昂貴 API(X 等);正式環境打真的 | user 明確 |
| 文件路徑 | 工作區根目錄的 `/docs/`(research/ 跟 blog/ 是同層元件) | user 明確 |
| ADR-001 處理 | git 刪除(完整歷史保留在 `git log -p`) | user 拆 |
| 切換方式 | hard cut,不留舊版痕跡,不寫自動遷移腳本 | Q5 預設 D |
| 驗收節奏 | 用美股交易日收盤當驗收點 | user 明確 |

## 沿用 α-lab AGENTS.md 已有決定(不重設計)

| 對象 | 狀態 | 來源 |
|---|---|---|
| 以 Postgres 當資料儲存(items / signals) | 沿用 | `research/AGENTS.md`「已達成決定」 |
| Schema 設計哲學(items 是給 LLM 看的索引層,原始 payload 不進表) | 沿用 | 同上 |
| Raw 檔案不可變,改動另寫到 `findings/` / `wiki/` | 沿用 | 同上 |
| Adapter 模式 + `source_type` / `source_label` 是 free-form TEXT | 沿用 | 同上 |
| 自寫 migrator + migrations 是 append-only(不下 down) | 沿用 | 同上 |
| 現有 4 個 SQL migrations(`001` 到 `004`) | 完全保留 | git 紀錄 |
| 245 個單元測試基準 | 沿用,Section 5 會擴充 | test count |
| `agent/lib/llm.ts`(MiniMax native + thinking 適配) | 沿用 | PR #13, #14 |
| `lib/publish.ts` + `publish.ts`(CLI + lib helper) | 沿用 | `publish.ts` 邏輯不動 |
| Hindsight bank ID `alpha-lab` | 沿用 | ADR-001 v1 設定 |

## 第 1 節:架構 ✅(於 2026-07-10 提交)

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

### 各品質要求的對應(細節在 Section 4)

| 品質要求 | 主要機制 | 補強 |
|---|---|---|
| OBS | dagu Web UI + dagu 內部執行歷史 | — |
| IDEMPOTENT | postgres unique constraint + `processed_at` 時間戳 + agent 自己守 idempotency key | Section 4 |
| RECOVERY | dagu 步驟層級 retry policy + VM 重啟後從 dagu 自己的狀態復原 | Section 4 |
| DRIFT-GUARD | compose 結構強制 runner 容器化 + CI 掃 `agent/*` 不存在 `workflow/*`(物理路徑切掉) | Section 5 |

---

## 第 2 節:元件 + agent/* 邊界(占位 — 待補)

會涵蓋:

- 每個 `agent/*.ts` 的用途、介面、依賴(B = discover、C = research、D = generateReport;另有 `agent/lib/llm.ts` 跟 `agent/lib/types.ts`)
- `lib/*.ts` 共用工具(types、db、llm、hindsight-client、raw-writer、x-client、source-adapter、config)
- `lib/publish.ts` + `publish.ts` — 發布流程(`publish.ts` 同時是 CLI 跟 lib helper,blog content collection 是 git 追蹤,沿用現狀)
- dagu DAG 檔案(`research/dags/{pull,discover,research,reports}.yaml`)— 每個呼叫什麼、跟其他 DAG 的相依
- 快照機制(`research/snapshots/<signal_id>/{raw_tweets.md, llm_input.json, llm_output.json}`)— 寫入時機、結構、git 封存政策
- 新增 agent / 修改既有 agent 的食譜

## 第 3 節:資料流 — A/B/C/D pipeline(占位 — 待補)

會涵蓋:

- **A**: X pull → items 表 + `research/raw/<source_type>/<source_label>/<YYYY-MM-DD>.jsonl` append-only + 進 dagu DAG `pull` 跑
- **B**: items.unprocessed → LLM(帶已追蹤訊號當 context)→ signals 表 + 標記 items processed_at + 進 dagu DAG `discover` 跑
- **C**: 新訊號 → Hindsight recall → LLM 深度研究 → markdown 草稿(`drafts/event-tracking/<slug>.md`) + 訊號級快照
- **D-pre**: cron(美東 09:00 前)→ 市場資料 + 已追蹤訊號摘要 → markdown 草稿(`drafts/reports/<YYYY-MM-DD>-pre.md`)
- **D-post**: cron(美東 16:30 後)→ 同上格式 → `drafts/reports/<YYYY-MM-DD>-post.md`
- **發布**: 草稿 → `publish.ts` 寫到 `blog/src/content/blog/<date>-<slug>.md` → git push → Cloudflare Pages 自動部署
- B 完成自動觸發 C(透過 dagu DAG `discover` 的第二步,對每個新訊號啟動 `research` DAG)— 跟 v1 同樣的 pattern,但 dagu 的 start 用 YAML 層級宣告,不是 imperative API

## 第 4 節:錯誤處理 / 品質要求的落實(占位 — 待補)

會涵蓋:

- **OBS 細節**:dagu Web UI 路徑(`/runs`、`/dags`、`/queues`)、告警(email / Slack 預備,但原型先不接)、跟現有 `journalctl` 的取代關係
- **IDEMPOTENT 細節**:每個階段的 idempotency key(item external_id / signal UUID / publish slug)、postgres unique constraint、再跑過同一階段的語意、re-run 的 trace 怎麼在 UI 上看到
- **RECOVERY 細節**:錯誤模式矩陣(`LLM rate-limit`、`network down`、`X-API failure`、`hindsight down`、`OOM`、`double trigger` 等)各自該怎麼處理 — retry / skip / quarantine / 哪個步驟重試 / 哪個是階段層級重試
- **DRIFT-GUARD 細節**:CI 掃描規則(沒有 `workflow/` 目錄 / 沒有 `*Workflow` class / 沒有 `use workflow` directive 等 pattern)、pre-commit hook、pre-deploy check、`bun run check:drift` 指令

## 第 5 節:測試策略(占位 — 待補)

會涵蓋:

- 既有單元測試(245 個基準)沿用 + 加新 agent/* 的測試
- 整合測試:`docker compose up` → 跑 fixture → 驗證 A/B/C/D 全 cycle
- DRIFT-GUARD 測試:CI 掃 `agent/*` 並阻擋 inline 規則,掃不過 PR fail
- IDEMPOTENT re-run 測試:同階段跑 2 次,DB 狀態 + git 快照都單一(觸發級 fixtures)
- 切換演練:手動 checklist(週末部署 → 等下個美股交易日收盤 → dagu UI 看執行成功 → git log 看快照提交 → blog 看發布後的文章 → 若失敗手動退回)

---

## 遷移狀態(本節追蹤 ADR-002 內各 Phase)

- ✅ **Phase 0** — 文件鷹架 + ADR-002 + 本 spec doc 第 1 節(本提交)
- ⏳ Phase 1 — spec doc 第 2 至 5 節全部核准
- ⏳ Phase 2 — 實作(docker-compose / dagu 設定 / runner 映像 / DAGs / 移除 v1)
- ⏳ Phase 3 — 切換(等下個美股交易日收盤後驗收;若需修 → 等下個收盤日)
- ⏳ Phase 4 — 穩定期一週(品質要求全在 production 驗證才 done)

## 還沒解決 / 各節待辦

- [ ] dagu DAG 內部步驟相依怎麼表達(Section 2)
- [ ] X adapter 假資料 fixture 具體格式(Section 2 / 5)
- [ ] LLM 呼叫的 idempotency token 要不要存 hash?(Section 4)
- [ ] 快照留存 / 清理政策(Section 2 + 5)
- [ ] `runs_summary` 表的 schema(Section 4)
- [ ] 敏感資料管理(.env 在主機 bind-mount ?compose secrets ?Vault 之類對原型太重,跳過)(Section 4)
- [ ] DRIFT-GUARD CI 腳本跟既有 AI review(現有的 kilo / gemini / coderabbit)怎麼避免重複(Section 5)
