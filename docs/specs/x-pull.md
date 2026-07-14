# A:抓 X 推文 (`x-pull`)

**狀態:** 撰寫中
**覆蓋範圍:** A agent 的行為、觸發、介面、寫入位置、測試要點
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(架構、檔案策略、測試)

## 用途

從 X 拉指定 investor 的 timeline 推文,寫進兩處:

- DB `items` 表 — 給 LLM 看的索引層,用來 query「未處理」「by source」「by time range」
- Git `research/raw/<source_type>/<source_label>/<YYYY-MM>/<YYYY-MM-DD>.jsonl` — append-only 不可變歷史

## 觸發與頻率

| 環境 | 觸發 | 頻率 |
|---|---|---|
| 正式環境 | dagu DAG `x-pull` 的 cron | 每 6 小時一次 |
| 本地開發 | 手動 `bun run pull.ts`(也可從 dagu UI 手動觸發) | 隨時 |
| fixture 模式 | 環境變數 `X_FIXTURE_MODE=true` | 隨時(不發 X API)|

DAG 設定將在 Phase 2 實作時落進 `research/dags/x-pull.yaml`。

## 介面

### CLI

```sh
bun run pull.ts                 # 跑所有 source
bun run pull.ts --source X      # 只跑 X
X_FIXTURE_MODE=true bun run pull.ts  # 用 fixture 不打 X API
```

### dagu 呼叫(Phase 2)

```yaml
# research/dags/x-pull.yaml (示意)
name: x-pull
schedule: "0 */6 * * *"           # 每 6 小時
steps:
  - name: pull
    command: docker compose exec -T runner bun run pull.ts
    retry: 3
    retryInterval: 30s
```

### 低階介面(`pull.ts` 內部)

- 讀 `sources.json`(列舉哪些 source / investor)
- 跑各個 source 的 adapter(`lib/adapters/*.ts`)
- adapter 的 SourceAdapter 介面:

```ts
interface SourceAdapter {
  fetchItems(sinceId: string | null, limit: number): Promise<RawItem[]>;
  // RawItem = { source_type, source_label, external_id, external_parent, created_at, fetched_at, context }
  getLatestExternalId(): Promise<string | null>;
}
```

## 行為

1. 讀 `sources.json` 拿到所有 source 設定
2. 對每個 source:
   - 取得 `fetch_state.last_external_id`(in-memory 或 DB,看 adapter)
   - 呼叫 `adapter.fetchItems(lastExternalId, max_per_run)`
   - 對每個 RawItem:
     - 寫進 DB `items` 表(insert 帶 unique conflict skip)
     - append 進 `raw/...jsonl`
   - 更新 `fetch_state.last_external_id` 為這批最後的 ID
3. 跑完回 dagu 報 success

## 邊界

- **不重複抓**:`fetch_state.last_external_id` 是 inclusive boundary — adapter 看到等於這個 ID 就停;確保不漏不重
- **首跑控制**:`initial_backfill_days`(預設 3 天,見 `x-user-timeline` adapter)防止首跑拉幾個月舊推文炸 quota
- **單次上限**:`max_per_run`(預設 1000) — 防單次 timeout / quota 撐爆
- **rate-limit**:adapter 內部 429 / 5xx retry,X 官方限制 100 req / 15 min
- **schema 穩定**:`source_type` / `source_label` 是 free-form TEXT,加新 source 不改 schema

## 寫到哪裡

| 對象 | 位置 | 細節 |
|---|---|---|
| DB | `items` 表 | unique constraint on `(source_type, external_id)`;conflict skip(insert 失敗不報錯) |
| Git | `raw/<source_type>/<source_label>/<YYYY-MM>/<YYYY-MM-DD>.jsonl` | append-only,每行一個 RawItem,不可變 |
| 失敗標記 | dagu run history | 整個 batch 失敗 → dagu retry;部分失敗 → 一筆 RawItem 寫 DB 失敗不擋下一筆 |

## 失敗處理

| 失敗 | 怎麼處理 |
|---|---|
| X API 401(未授權)| adapter 報錯 → dagu 步驟失敗 → 需要換 token |
| X API 402(沒付費)| adapter 報錯 → 手動介入(必須開 pay-per-use billing)|
| X API 429(rate-limit)| adapter 內部 sleep + retry;dagu step 額外 retry 3 次 |
| X API 5xx | adapter 內部 retry;dagu step retry |
| 寫 DB 失敗 | 整 step 失敗 → dagu retry → 重新跑會因為 DB unique constraint skip 重複的部分 |
| 寫 raw JSONL 失敗 | 整 step 失敗 → dagu retry;JSONL 是 append-only,可能會有殘留 + 重複(待 fixture 確認行為) |
| 網路瞬斷 | adapter 內部 retry + dagu step retry |

## 沿用(不重設計)

- `lib/adapters/x-user-timeline.ts` — X timeline adapter 沿用,加 fixture 模式分支
- `lib/source-adapter.ts` — SourceAdapter 介面沿用
- `lib/x-client.ts` — X API v2 client(含 429 / 5xx retry)沿用
- `lib/raw-writer.ts` — JSONL append writer 沿用
- `lib/db.ts` — Postgres 操作(含 items insert)沿用
- `lib/config.ts` — 讀 `sources.json` 沿用
- `lib/logger.ts` — loglayer + 檔案輪替沿用
- `pull.ts` — 主程式邏輯沿用,只外層改成可被 dagu 呼叫

## 測試要點

| 測試 | 涵蓋 |
|---|---|
| `tests/adapters/x-user-timeline.test.ts` | adapter 對 X API 回傳的 RawItem 格式驗證 |
| `tests/lib/raw-writer.test.ts` | JSONL append 行為(atomic、idempotent)|
| `tests/lib/db.test.ts` | items insert + unique conflict skip |
| fixture 整合測試 | `X_FIXTURE_MODE=true bun run pull.ts` 跑一遍,驗證 DB 跟 git 寫入正確 |

---

## 修改原則

- 改 A agent 行為 → 改本 spec → 改 `agent/lib/x-client.ts` / `lib/adapters/*` / `pull.ts` / dagu DAG
- 改 SourceAdapter 介面 → 要 review 影響所有 adapter(包括未來加的 source)
- 加新 source → 不必改本 spec;在 `sources.json` 加設定 + 寫新 adapter;但要在 PR 描述為什麼加
