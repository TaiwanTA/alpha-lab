# B:訊號發現 (`signal-discovery`)

**狀態:** 撰寫中
**覆蓋範圍:** B agent 的行為、觸發、介面、寫入位置、測試要點
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(IDEMPOTENT)、[`x-pull.md`](x-pull.md)(輸入源)、[`signal-research.md`](signal-research.md)(完成時觸發下游)

## 用途

從未處理的 items 表找「值得長期追蹤的新市場訊號」,寫進 `signals` 表。完成時對每個新訊號啟動 C agent 做深度研究。

## 觸發與頻率

| 環境 | 觸發 | 頻率 |
|---|---|---|
| 正式環境 | dagu DAG `signal-discovery` 的 cron | 每 1-2 小時一次 |
| 本地開發 | 手動 `bun run agent/b.ts` 或 dagu UI | 隨時 |

DAG 設定 Phase 2 實作。

## 介面

### CLI

```sh
bun run agent/b.ts                # 跑一次
```

### dagu 呼叫(Phase 2)

```yaml
# research/dags/signal-discovery.yaml (示意)
name: signal-discovery
schedule: "0 */1 * * *"           # 每 1 小時
steps:
  - name: discover-and-trigger
    command: docker compose exec -T runner bun run -e '
      import { discover } from "./agent/b.ts";
      import { start } from "dagu/api";
      const deps = ...;
      const result = await discover(deps);
      for (const signalId of result.newSignalIds) {
        await start("signal-research", { signalId });
      }
    '
    retry: 1
```

### 低階介面

```ts
// agent/b.ts (示意)
export interface BDependencies {
  getUnprocessedItems(limit: number): Promise<ItemRow[]>;
  getActiveSignals(): Promise<Signal[]>;
  insertSignal(signal: { ... }): Promise<Pick<Signal, "id">>;
  markItemsProcessed(sourceType: string, externalIds: string[]): Promise<void>;
  ask: LlmAskFunction;
}

export interface DiscoverResult {
  itemsProcessed: number;
  newSignals: number;
  newSignalIds: string[];
}

export async function discover(deps: BDependencies): Promise<DiscoverResult>;
```

## 行為

1. 從 `items` 表取 `MAX_ITEMS_PER_RUN = 50` 筆未處理的(用 `processed_at IS NULL`)
2. 從 `signals` 表取所有 active 的(用來告訴 LLM 「這些已存在避免重複」)
3. 把兩個一起喂 LLM,請它輸出 JSON `{signals: [...]}` 列出新訊號
4. 對 LLM 輸出的每個 candidate:
   - `validateCandidate()` 驗證欄位(title ≤ 80、description ≤ 800、importance ∈ 1-5、tags 跟 source_item_ids 是 string array 且 source_item_ids 非空)
   - 驗證過的進 `signals` 表 insert
   - 用 `source_items` 連結回原始 items
5. 把這批 items 標 `processed_at = now()`(**不管有沒有找到新訊號都標**)
6. 回 `DiscoverResult{ itemsProcessed, newSignals, newSignalIds }`
7. dagu step 拿 `newSignalIds`,對每個呼叫 `start("signal-research", { signalId })`

## 邊界

- **冪等**:`processed_at` 標記讓重跑只處理新 items;`signals.external_id` 群組去重由 DB unique constraint 保證
- **單次上限**:`MAX_ITEMS_PER_RUN = 50` — 超過就下次跑
- **LLM 行為 determinism**:temperature 0.3(訊號發現要穩定而非創意)
- **回傳上限**:maxTokens 2000 — 50 個 items 大概不超過

## 寫到哪裡

| 對象 | 位置 | 細節 |
|---|---|---|
| DB | `signals` 表 | insert 帶 unique conflict skip |
| DB | `items.processed_at` 標記 | 整批 items 一次性標完 |
| 下游觸發 | dagu `start("signal-research", { signalId })` | 對每個新 signal 各一個 run |

## 失敗處理

| 失敗 | 怎麼處理 |
|---|---|
| LLM 回的不是 valid JSON | 報錯,整 step fail → dagu retry |
| LLM 回的 candidate 沒通過 `validateCandidate` | skip 該 candidate,繼續下一個 |
| LLM 5xx / rate-limit | dagu step retry;backoff 3 次 |
| insertSignal 失敗(unique conflict)| skip(已經存在的訊號)|
| markItemsProcessed 失敗 | 整 step fail → dagu retry;items 沒標 → 下次會重處理這批(冪等)|
| 觸發下游 signal-research 失敗 | log warning,不擋整個 run;被遺漏的 signal 之後手動觸發 C |

## IDEMPOTENT(對應 cross-cutting 第 2 節)

- **idempotency key**:`items.processed_at` + `signals.external_id_group`
- **重跑語意**:dagu 顯示成新 run,但因為 `processed_at` 已經標過,實際處理的 items 數量是 0(或新進來的);signals 表不重複
- **dagu Web UI** 上能看到「這次跑 0 個 items」「上次跑 50 個 items」的差別

## 沿用(不重設計)

- `agent/lib/llm.ts` — LLM 呼叫 wrapper 沿用(MiniMax 設定 + thinking 適配)
- `lib/db.ts` — Postgres 操作沿用
- `lib/types.ts` — `Signal`、`ItemRow` 等 type 沿用
- `agent/b.ts` — 業務邏輯沿用(只需把 `console.log` 之類改成 loglayer;**整段不要 inline**到 dagu step,DRIFT-GUARD)

## 測試要點

| 測試 | 涵蓋 |
|---|---|
| `tests/agent/b.test.ts` | `discover()` 業務邏輯 + `validateCandidate()` 各邊界 |
| `tests/lib/llm.test.ts` | Mock LLM 各種回應(JSON 正常、壞 JSON、bad candidate 各種 case)|
| fixture 整合測試 | `bun run agent/b.ts` 跑 fixture items,驗證 signals 表跟 processed_at 標記 |
| re-run 測試 | 跑 2 次,第二次 itemsProcessed = 0(全部已標過)、signals 表無重複 |

---

## 修改原則

- 改 LLM prompt → 改本 spec 內「行為」段、然後改 SYSTEM_PROMPT 跟 buildUserPrompt
- 改 idempotency key → 必須 review 影響 cross-cutting.md 第 2 節
- 改 `MAX_ITEMS_PER_RUN` → 改本 spec 跟 `agent/b.ts` 內常數;升級到常數而非 hard-code 是 DRIFT-GUARD 的一環
