# Signal 層:從 tweet 直推到 narrative 實體

**狀態:** 撰寫中
**覆蓋範圍:** item/signal 兩層分離、signal-classify agent、signal-manage workflow、research agent 以 signal 為單位編排、publish gate、migration 策略
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(架構、IDEMPOTENT、儲存)、[`signal-discovery.md`](signal-discovery.md)(原 B agent 概念,本 spec 取代其分類職責)、[`signal-research.md`](signal-research.md)(research agent,本 spec 改造其觸發與產出)、[`blog-publish.md`](blog-publish.md)(publish 流程,本 spec 加 gate)

## 問題背景

現有 Pipeline 把每一則 X tweet 直接寫成 `signal_events.active` row,每則都進 research queue → research agent 強制產完整文章 → publish 無 gate 直推 main。結果:Ackman 的「Crazy.」「Agreed.」等一字推文全部變成 90 行完整 blog post。

根因:`signal_events` 表同時扮演「原料(tweet 暫存)」跟「事件實體(研究目標)」兩個角色,tweet ≠ event 的語意混淆造成每則 tweet 都變研究 + 發布目標。

本 spec 引入獨立的 signal(narrative)實體層,分離原料與實體。

## 用途

把 ingest 拉下來的 raw items 透過 LLM 批次分類,動態關聯到 signal(narrative)實體。signal 有自己的優先權、描述、時間線,後續 research / bet / publish / 報告都掛在 signal 上。

## 1. 詞彙模型

| 詞 | 定義 |
|---|---|
| **item** | 原料資料(tweet、網頁爬蟲、之後擴充的來源)。純 raw 暫存,不直接觸發 research |
| **signal** | narrative 實體。由 LLM 動態建立,關聯多個 items(多對多),有 priority / description / timeline |

`signal` 對應原始 B agent(specs/signal-discovery.md)的設計意圖:LLM 聚合 items 產出的高層實體。現有實作走偏了(每則 tweet 直接當 event),本 spec 回歸原始設計。

## 2. 資料層

### items 表(由 signal_events rename)

`signal_events` rename 為 `items`。欄位不變,新增:

| 新欄位 | 類型 | 用途 |
|---|---|---|
| `classified_at` | timestamptz, nullable | signal-classify 處理過的時間;NULL = 未分類,每次 classify 只查 NULL |
| `classification_result` | jsonb | 分類結果(rejection reason 或關聯的 signal_ids),供 debug |

`signal_events.status` 欄位 **刪除**(migration DROP COLUMN)。現有 `active`/`processing`/`superseded`/`rejected` 狀態概念由 signal 層接手,items 不再有狀態。

### signals 表(新增)

```
signals
  id           uuid PK
  title        text NOT NULL
  description  text NOT NULL          — agent 維護的 living 描述(字數上限 500,強迫精簡)
  priority     text NOT NULL CHECK(priority IN ('high','low'))
  created_at   timestamptz DEFAULT now()
  updated_at   timestamptz DEFAULT now()
  archived_at  timestamptz            — NULL = 未封存;非 NULL = 封存(不列入研究,保留供參考)
```

- 沒有 status enum。signal 的「狀態」(進行中?預測?降溫?)由 `description` 動態文本承載
- 封存用 `archived_at IS NOT NULL`,不是一個 status
- `description` 字數上限 500,research agent 每次跑完更新

### signal_items 關聯表(新增,多對多)

```
signal_items
  signal_id  uuid FK signals
  item_id    uuid FK items
  relation   text CHECK(relation IN ('primary','supporting','context'))
  added_at   timestamptz DEFAULT now()
  PRIMARY KEY(signal_id, item_id)
```

一則 item 可關聯多個 signal(如 Ackman 一則移民推文同時打到「移民政策立場」和「投資人政治表態」兩個 signal)。

### research_runs 改造

| 變更 | 說明 |
|---|---|
| `event_id` → `signal_id` | RENAME COLUMN + FK 重建指向 signals |
| 新增 `published_path` | text, nullable。發布後填 blog repo 相對路徑;未發布為 null。timeline 用此欄拼 |
| unique index 重建 | `research_runs_event_active_unique` → `research_runs_signal_active_unique`,以 `signal_id` 為 key |

### paper_bets 改造

`event_id` → `signal_id`(RENAME COLUMN + FK 重建)。

### signal timeline(無獨立表)

timeline 由 `research_runs` 拼:

```sql
SELECT created_at, thesis, published_path, confidence, ticker, direction
FROM research_runs
WHERE signal_id = $1
ORDER BY created_at
```

- 每筆 research_run 帶 thesis + structured finding
- 已發布的帶 `published_path`(blog 文章路徑)
- blog frontmatter 加 `signalId` + `signalSlug`,反向關聯回 signal

### signal-config.yaml(新增)

優先權預算與編排設定,可調整不動 code:

```yaml
# automation/config/signal-config.yaml
priorities:
  high:
    soft_limit: 5          # 軟上限,非硬擋
    research_schedule: "0 7 * * *"      # 每天 07:00 UTC
    research_model: "MiniMax-M3"
    research_per_signal: true            # 每個 signal 獨立跑一個 agent
  low:
    soft_limit: 20
    research_schedule: "0 8 * * */2"    # 每 2 天 08:00 UTC
    research_model: "MiniMax-M3"        # 暫時同模型,觀察後可能換較小型號
    research_per_signal: false           # 共用批次任務
description:
  max_chars: 500
```

## 3. signal-classify agent

### 觸發與頻率

| 環境 | 觸發 | 頻率 |
|---|---|---|
| 正式環境 | dagu DAG `signal-classify` cron | 每 1-2 小時 |
| 本地開發 | 手動 `bun run commands/signal-classify.ts` | 隨時 |

### 行為

1. 查未分類 items:`SELECT ... FROM items WHERE classified_at IS NULL ORDER BY captured_at LIMIT 50`
2. 查未封存 signals 清單(帶 title + description)
3. 把兩份資料餵 LLM,請它輸出 JSON:

```json
{
  "classifications": [
    {
      "item_id": "...",
      "signal_assignments": [
        { "signal_id": "existing-uuid", "relation": "supporting" },
        { "signal_id": "new", "relation": "primary" }
      ]
    }
  ],
  "new_signals": [
    {
      "title": "Ackman 移民政策立場",
      "description": "Ackman 2026年7月連續推文倡議高技術移民改革...",
      "priority": "low"
    }
  ],
  "rejections": [
    { "item_id": "...", "reason": "單字情緒反應,無實質內容" }
  ]
}
```

4. 同一交易寫入:
   - `INSERT INTO signals ...` 新 signal(含 LLM 決定的 priority,可直指 high)
   - `INSERT INTO signal_items ...` 關聯
   - `UPDATE items SET classified_at = now(), classification_result = ...` 所有處理過的 items(含 rejected)
5. 輸出 summary(stdout run ID,詳細 log 走 stderr)

### LLM 參數

- temperature: 0.3(訊號分類要穩定而非創意)
- maxTokens: 2000

### 邊界

- **冪等 key:** `items.classified_at`(已分類的不重處理)
- **批次上限:** 50 items/run(超過下次跑)
- **新 signal priority:** LLM 直接決定(high 或 low),不自動先列 low 再升級
- **不處理降級/替換:** 那是 signal-manage 的事
- **不產 research 內容:** 只分類

### 失敗處理

| 失敗 | 處理 |
|---|---|
| LLM 回的不是 valid JSON | 報錯 → dagu retry |
| LLM 回的 candidate 沒通過欄位驗證 | skip 該 candidate,繼續下一個 |
| LLM 5xx / rate-limit | dagu retry,backoff 3 次 |
| INSERT signal 失敗 | 整 step fail → dagu retry;classified_at 未標 → 下次重處理 |
| 無未分類 items | exit 0(no-op) |

## 4. signal-manage workflow

### 觸發與頻率

| 環境 | 觸發 | 頻率 |
|---|---|---|
| 正式環境 | dagu DAG `signal-manage` cron | 每天 1 次(UTC 06:00,research 高峰前) |
| 本地開發 | 手動 | 隨時 |

### 行為

1. 查所有未封存 signals(帶 title, description, priority, created_at, updated_at)
2. 查每個 signal 的近期活動摘要:
   - 最近 N 天新增的 items 數量
   - 最近一次 research_runs 的時間 + thesis 摘要
   - 是否有已發布 blog post
3. 查當前 priority 分佈(high 幾個、low 幾個)+ high 軟上限
4. 餵 LLM,輸出 JSON:

```json
{
  "priority_changes": [
    { "signal_id": "...", "new_priority": "low", "reason": "近 14 天無新 items" },
    { "signal_id": "...", "new_priority": "high", "reason": "突發升溫" }
  ],
  "archive": [
    { "signal_id": "...", "reason": "事件已結束" }
  ]
}
```

5. 執行變更:UPDATE signals SET priority / archived_at + 更新 description 記錄決策原因

### 軟上限行為

升級到 high 時,若現有 high ≥ 軟上限(config 預設 5):
- prompt 提示已達軟上限
- LLM 可附理由突破,或降級某個既有 high signal
- 降級理由寫進被降級 signal 的 description(留下決策軌跡)
- 非硬擋:如果 LLM 認為值得,可以附理由突破上限

### 邊界

- **唯一能改 `signals.priority` 和 `signals.archived_at` 的地方**
- 不開新 signal(那是 classify 的事)
- 不產 research 內容

## 5. Research agent 編排(改造 research-next-event → research-signals)

### 觸發與頻率

| priority | 排程 | 編排 |
|---|---|---|
| high | 每天 07:00 UTC(manage 跑完後) | 每個 signal 獨立跑一個 research agent run |
| low | 每 2 天 08:00 UTC | 共用批次任務 |

排程時間 + preconditions 確保 manage(06:00)先於 research(07:00)。

### 行為(每個 signal)

1. claim signal(防止同時多個 run 跑同一 signal,用 `research_runs_signal_active_unique` partial unique index)
2. 讀 signal 的 items(透過 signal_items join)+ 過去 research_runs(timeline)
3. 跑 research agent(現有 pi-agent-core + MiniMax-M3 + 五工具 toolkit)
4. agent 判斷:這個 signal 是否有可交易 alpha?
   - **有** → 產 thesis + 完整 candidateMarkdown(現有行為)
   - **沒有** → 只產 thesis + structured finding(rationale + confidence + 不產 candidateMarkdown)
5. 更新 `signals.description`(living 描述,research agent 每次跑完更新)

### record_research tool 放寬(B 層)

現有 `record_research` 強制 `ticker`/`direction`/`candidate_markdown` 全部非空。改為:

| 欄位 | Mode 1(有 alpha) | Mode 2(無 alpha) |
|---|---|---|
| thesis | 必填 | 必填 |
| rationale | 必填 | 必填 |
| confidence | 必填 | 必填 |
| sourceCitations | 必填 | 必填 |
| ticker | 必填 | optional / null |
| direction | 必填 | optional / null |
| candidateMarkdown | 必填 | optional / empty string |

DB schema 本來就允許 null(`research_runs.ticker text` 無 NOT NULL),只需放寬 tool 層的 typebox schema。

### 邊界

- 不再 claim `items` row(舊的 tweet = event 模式退役)
- 不再每 15 分鐘跑(改以 signal 為單位,按 priority 排程)
- `research_runs.status` 維持 `accepted`(兩種 mode 都 accepted,代表「研究完成」)
- Mode 2 的 row 不會被 publish claim 查到(因為 candidate_markdown 為空)

## 6. Publish gate(改造 publish-next-research)

### 改造

publish claim 邏輯加三道 gate:

1. `candidate_markdown` 非空(research agent 判斷有可交易 alpha 才產文)
2. signal 未封存(`signals.archived_at IS NULL`)
3. 尚未發布過(idempotent)

```sql
SELECT rr.id
FROM research_runs rr
JOIN signals s ON rr.signal_id = s.id
WHERE rr.status = 'accepted'
  AND rr.candidate_markdown IS NOT NULL
  AND rr.candidate_markdown != ''
  AND s.archived_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM research_publications rp
    WHERE rp.research_run_id = rr.id
  )
ORDER BY rr.created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 1
```

不需要額外的 `investmentClaim` / `confidence` gate — B 層已經在上游決定「要不要產文」。如果沒產文,根本不會進到 publish 管道。

### 沿用

`blog-publish` 子 DAG(materialize + github-publish)完全不動。Publish gate 只改 publish-next-research 的 claim 查詢。

## 7. Migration 策略

### SQL migration(`002_signal_layer.sql`)

```sql
-- 1. Rename signal_events → items
ALTER TABLE signal_events RENAME TO items;
-- (constraint/index rename 按慣例)

-- 2. 新增 signals 表
CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY,
  title text NOT NULL,
  description text NOT NULL,
  priority text NOT NULL CHECK(priority IN ('high','low')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);

-- 3. 新增 signal_items
CREATE TABLE IF NOT EXISTS signal_items (
  signal_id uuid NOT NULL REFERENCES signals(id),
  item_id uuid NOT NULL REFERENCES items(id),
  relation text CHECK(relation IN ('primary','supporting','context')),
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(signal_id, item_id)
);

-- 4. items 加分類標記
ALTER TABLE items
  ADD COLUMN classified_at timestamptz,
  ADD COLUMN classification_result jsonb;

-- 5. items: 刪除 status 欄位 + 相依的 partial index(DROP INDEX 必須在 DROP COLUMN 之前)
DROP INDEX IF EXISTS signal_events_research_queue;
ALTER TABLE items DROP COLUMN status;

-- 6. research_runs: event_id → signal_id
ALTER TABLE research_runs RENAME COLUMN event_id TO signal_id;
ALTER TABLE research_runs
  DROP CONSTRAINT research_runs_event_id_fkey,
  ADD CONSTRAINT research_runs_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(id);

-- 7. research_runs: 加 published_path
ALTER TABLE research_runs ADD COLUMN published_path text;

-- 8. paper_bets: event_id → signal_id
ALTER TABLE paper_bets RENAME COLUMN event_id TO signal_id;
ALTER TABLE paper_bets
  DROP CONSTRAINT paper_bets_event_id_fkey,
  ADD CONSTRAINT paper_bets_signal_id_fkey
    FOREIGN KEY (signal_id) REFERENCES signals(id);

-- 9. 重建 unique index
DROP INDEX IF EXISTS research_runs_event_active_unique;
CREATE UNIQUE INDEX IF NOT EXISTS research_runs_signal_active_unique
  ON research_runs (signal_id)
  WHERE status IN ('accepted','processing');

-- 10. signal 索引
CREATE INDEX IF NOT EXISTS signals_active
  ON signals (priority, updated_at)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS items_unclassified
  ON items (captured_at)
  WHERE classified_at IS NULL;
```

### TS migration script(`migrate-signal-layer.ts`)

在 SQL migration 後跑,處理既有資料的 item→signal 映射:

1. 對每個既有 item:
   - `INSERT INTO signals (title=raw_content 前綴, description='Legacy item: pending reclassification', priority='low')`
   - `INSERT INTO signal_items (signal_id=新signal, item_id=該item, relation='primary')`
2. 對每個既有 research_runs row:
   - `UPDATE research_runs SET signal_id = (對應的 item → signal 的 id)`
3. 對每個既有 paper_bets row:
   - `UPDATE paper_bets SET signal_id = (對應的 item → signal 的 id)`
4. 標記所有既有 items 為已分類:`UPDATE items SET classified_at = now(), classification_result = '{"legacy": true}'`

### 既有 blog 文章

不動、不補 signalId。它們 frontmatter 沒有 signalId,不影響新流程。新發布的文章才帶 signalId。

## 8. DAG 總覽(改造後)

| DAG | 排程 | 變更 |
|---|---|---|
| `ingest-events` | 每 6h | 不變(tweet → items) |
| `signal-classify` | 每 1-2h | **新增**:LLM 批次分類 items → signals |
| `signal-manage` | 每天 06:00 | **新增**:升級/降級/封存 signals |
| `research-signals` | 每天 07:00 (high) / 每 2 天 08:00 (low) | **改造**:以 signal 為單位,取代舊 `research-next-event` |
| `publish-next-research` | 每 30m | **改造**:claim 查詢加 gate(candidate_markdown 非空 + 未封存) |
| `open-next-paper-bet` | 每 30m | FK 改 signal_id,其他不動 |
| `settle-paper-bets` | 21:30 UTC 平日 | 不動 |
| `calibrate-signals` | 22:00 UTC 平日 | 不動 |
| `blog-publish` | 按需 | 不動(被 publish-next-research 呼叫) |

## 9. 沿用既有

| 對象 | 狀態 | 來源 |
|---|---|---|
| pi-agent-core + 五工具 toolkit | 沿用,record_research schema 放寬 | Phase 4 |
| MiniMax-M3 via pi-ai minimaxProvider | 沿用,high/low 暫時同模型 | Phase 4 |
| Hindsight recall/retain | 沿用 | ADR-001 |
| `blog-publish` 子 DAG | 沿用,不改 | PR #21 |
| `renderPublishContent` lint | 沿用,不動 | publish-draft.ts |
| `qualifiesForBet()` gate | 沿用,只 gate paper bet 不 gate publish | contracts.ts |
| migrations append-only | 沿用,新增 `002_signal_layer.sql` | cross-cutting §2 |

## 10. 測試要點

| 測試 | 涵蓋 |
|---|---|
| signal-classify unit | 批次分類:新 signal / 既有 signal 關聯 / rejection,三種產出路徑 |
| signal-classify idempotent | classified_at 標記後不重處理 |
| signal-manage unit | 升級/降級/封存決策,軟上限行為 |
| research agent record_research 放寬 | Mode 1(有 alpha)+ Mode 2(無 alpha)兩種 path |
| publish gate | candidate_markdown 空的不被 claim;封存 signal 的 research 不被 claim |
| migration script | 既有 items → signals 映射正確,research_runs/paper_bets FK 正確 |
| signal timeline query | research_runs + published_path 拼出正確時間線 |

## 11. 修改原則

- 改 classify LLM prompt → 改本 spec §3「行為」段 + `commands/signal-classify.ts` 內 prompt template
- 改 priority 預算 → 改 `automation/config/signal-config.yaml`,不動 code
- 改 `description` 字數上限 → 改 `signal-config.yaml` + `tools/record-research.ts` 的 schema 驗證
- 改封存觸發邏輯 → 改本 spec §4 + `commands/signal-manage.ts` 內 prompt
- 改 record_research schema → 須 review 影響 `research_runs` insert path 跟 publish claim query
- 改 migration → append-only,新增 `003_*` 不改 `002`
