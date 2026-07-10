# C:對新訊號深入研究 (`signal-research`)

**狀態:** 撰寫中
**覆蓋範圍:** C agent 的行為、觸發、介面、寫入位置、測試要點
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(IDEMPOTENT、storage)、[`signal-discovery.md`](signal-discovery.md)(上游觸發源)

## 用途

對一個新訊號做深度研究,把結果寫成 markdown 草稿 + 訊號級快照,並把觀察存進 Hindsight 供未來 recall。

## 觸發與頻率

| 環境 | 觸發 |
|---|---|
| 正式環境 | 由 [`signal-discovery`](signal-discovery.md) 對每個新 signalId 透過 `dagu start` 觸發一個獨立 run |
| 本地開發 | 手動 `bun run agent/c.ts <signalId>` 或 dagu UI |

**不是 cron 驅動**,每次接收一個 signalId 當輸入。

## 介面

### CLI

```sh
bun run agent/c.ts <signal-uuid>
```

### dagu 觸發(由 signal-discovery)

```yaml
# research/dags/signal-discovery.yaml 內(Phase 2 實作)
- 對每個 newSignalId:
  dagu start signal-research --param signalId=<uuid>
```

### dagu DAG 接收(Phase 2)

```yaml
# research/dags/signal-research.yaml (示意)
name: signal-research
params:
  - signalId: required
steps:
  - name: research-and-snapshot
    command: docker compose exec -T runner bun run agent/c.ts $signalId
    retry: 2
```

### 低階介面

```ts
// agent/c.ts (示意)
export interface CDependencies {
  getSignal: (id: string) => Promise<Signal | null>;
  getSourceItems: (signalId: string) => Promise<ItemRow[]>;
  recallFromHindsight: (query: string) => Promise<HindsightFact[]>;
  retainToHindsight: (signalId: string, facts: string[]) => Promise<void>;
  ask: LlmAskFunction;
  writeResearchDraft: (signalId: string, content: string, meta: DraftMeta) => Promise<string>;
  writeSignalSnapshot: (signalId: string, snapshot: ResearchSnapshot) => Promise<void>;
}

export interface ResearchResult {
  signalId: string;
  draftPath: string;
  snapshotPath: string;
  hindsightFacts: string[];
}

export async function research(signalId: string, deps: CDependencies): Promise<ResearchResult>;
```

## 行為

1. 用 `getSignal(signalId)` 拿到 signal 資料
2. 用 `getSourceItems(signalId)` 拿到當初 B agent 引用哪些推文(透過 `signals.source_items` 關聯 items 表)
3. `recallFromHindsight(signal.title + description)` 拿過去相關的事實
4. 把 signal 摘要 + source items + recall 結果丟給 LLM,請它輸出結構化 markdown 研究報告(title / 摘要 / 內文 / 結論 / 引用 / tags)
5. 對 LLM 輸出驗證欄位
6. 寫 markdown 草稿到 `research/drafts/event-tracking/<slug>.md`(frontmatter 含 title / date / summary / status / tags / investors / tickers)
7. 寫快照到 `research/snapshots/<signal_id>/`:
   - `raw_tweets.md` — 從 source_items 抓到的原始推文文字
   - `llm_input.json` — 提示詞、參數
   - `llm_output.json` — LLM 原始回應(對 repro 重要)
8. `retainToHindsight` 把觀察存進 Hindsight bank `alpha-lab`
9. 回 `ResearchResult`

## 邊界

- **冪等 key**:signal UUID
- **冪等語意**:重跑同一 signal 應該 skip(已寫過 draft)或覆寫(同 signal 不同研究內容)— 由 `drafts/event-tracking/<slug>.md` 是否存在決定;若已存在則加 `-2` 後綴
- **單次執行時間**:預期 < 30 秒(Hindsight recall + LLM call + 寫檔)
- **LLM 參數**:研究任務可調 temperature(預設 0.5)、maxTokens(預設 4000)

## 寫到哪裡

| 對象 | 位置 | 細節 |
|---|---|---|
| Git | `research/drafts/event-tracking/<slug>.md` | markdown 草稿,frontmatter 含 metadata |
| Git | `research/snapshots/<signal_id>/raw_tweets.md` | 訊號引用的原始推文文字版本 |
| Git | `research/snapshots/<signal_id>/llm_input.json` | 完整 LLM prompt 內容 + 參數 |
| Git | `research/snapshots/<signal_id>/llm_output.json` | LLM 原始回應 + finish_reason |
| Hindsight | bank `alpha-lab` | recall 過去事實、retain 這次觀察 |
| DB | 不寫業務資料(只用來 join 取 source_items)| — |

## 失敗處理

| 失敗 | 怎麼處理 |
|---|---|
| signalId 不存在 | step 報錯 → dagu run failed → 手動檢查 signal 表 |
| LLM rate-limit | dagu step retry,backoff 3 次 |
| LLM 回的不是 valid JSON | step 報錯 → dagu retry |
| Hindsight 連不上 | recall 失敗 → 用「無過去觀察」繼續研究(警告寫進 snapshot);retain 失敗 → 整 step 失敗;dagu retry |
| 寫 drafts 失敗 | 整 step 失敗 → dagu retry → 重新跑會發現 draft 已存在,加 `-2` 後綴 |
| 寫 snapshots 失敗 | 整 step 失敗 → dagu retry;快照目錄是 mkdir + atomic write,失敗就整批 fail |
| 草稿已存在(冪等衝突)| 加後綴 `-2` 然後繼續,避免覆蓋 |

## IDEMPOTENT(對應 cross-cutting 第 2 節)

- **idempotency key**:signal UUID
- **重跑語意**:若 `drafts/event-tracking/<slug>.md` 已存在,加 `-2` 後綴;dagu UI 顯示成新 run,但產出檔案不同名
- **快照冪等**:snapshots 寫入是 atomic,失敗就 fail,不半殘留

## 沿用(不重設計)

- `agent/lib/llm.ts` — LLM wrapper 沿用
- `lib/hindsight-client.ts` — Hindsight REST API client 沿用
- `lib/db.ts` — `getSignal`、`getSourceItems` 沿用
- `lib/types.ts` — `Signal` type 沿用
- `lib/publish.ts` — frontmatter 序列化函式沿用(直接呼叫,不重寫)
- `agent/c.ts` — 業務邏輯沿用;`console.log` 改 loglayer;新增 snapshot 寫入邏輯

## 測試要點

| 測試 | 涵蓋 |
|---|---|
| `tests/agent/c.test.ts` | `research()` 各階段行為 |
| `tests/lib/hindsight-client.test.ts` | Hindsight recall / retain 介面 |
| fixture 整合測試 | 給定 fixture signal,跑 research,驗證 draft + snapshots + Hindsight retain 都生成了 |
| re-run 測試 | 同 signalId 跑 2 次,第二次產出 `-2` 後綴 draft |

---

## 修改原則

- 改研究 prompt → 改本 spec 內「行為」段、然後改 `agent/c.ts` 內的 prompt template
- 改 snapshot 結構 → 影響 `agent/c.ts` 跟 cross-cutting.md 第 3 節(storage 規則)對齊
- 改 Hindsight bank 或 query 策略 → 必須 review 影響 RECOVERY(recovery recall 行為)
