# D:美股盤前/盤後報告 (`market-reports`)

**狀態:** 撰寫中
**覆蓋範圍:** D agent 的行為、觸發、介面、寫入位置、測試要點
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(IDEMPOTENT、storage)

## 用途

每個美股交易日產出兩份報告:
- **盤前**(美東 09:00 之前):當日市場預期、追蹤的 investor 有什麼新表態、相關訊號摘要
- **盤後**(美東 16:30 之後):當日盤中發生的事、有追蹤的 investor 對盤中事件的反應、相關訊號更新

## 觸發與頻率

| 環境 | 觸發 | 時間 |
|---|---|---|
| 正式環境 | dagu DAG `market-reports-pre` | Mon-Fri 美東 09:00 前 |
| 正式環境 | dagu DAG `market-reports-post` | Mon-Fri 美東 16:30 後 |
| 本地開發 | 手動 `bun run agent/d.ts --type=pre\|post` | 隨時 |

DAG 設定 Phase 2 實作。DST(夏令時間)由 dagu cron 的 timezone 表達式處理。

## 介面

### CLI

```sh
bun run agent/d.ts --type=pre       # 盤前
bun run agent/d.ts --type=post      # 盤後
```

### dagu 呼叫(Phase 2)

```yaml
# research/dags/market-reports-pre.yaml (示意)
name: market-reports-pre
schedule: "0 8 * * 1-5"             # 美東 08:00(= UTC 12:00 或 13:00 DST)
timezone: "America/New_York"
steps:
  - name: generate-pre-report
    command: docker compose exec -T runner bun run agent/d.ts --type=pre
    retry: 1
```

類似的 `market-reports-post.yaml`:`schedule: "30 16 * * 1-5"` 美東 16:30。

### 低階介面

```ts
// agent/d.ts (示意)
export interface DDependencies {
  getActiveSignals: () => Promise<Signal[]>;
  getMarketOverview: () => Promise<MarketData>;
  recallFromHindsight: (query: string) => Promise<HindsightFact[]>;
  retainToHindsight: (date: string, type: "pre" | "post", facts: string[]) => Promise<void>;
  ask: LlmAskFunction;
  writeReportDraft: (date: string, type: "pre" | "post", content: string, meta: DraftMeta) => Promise<string>;
  writeReportSnapshot: (date: string, type: "pre" | "post", snapshot: ResearchSnapshot) => Promise<void>;
}

export interface GenerateReportResult {
  date: string;
  type: "pre" | "post";
  draftPath: string;
  snapshotPath: string;
  hindsightFacts: string[];
}

export async function generateReport(type: "pre" | "post", deps: DDependencies): Promise<GenerateReportResult>;
```

## 行為

### 共通

1. 取當下日期(美東時區)
2. 取 active signals(從 `signals` 表)
3. 取市場概況(從某個來源 — 設計細節待展開;選項:Polygon / Alpaca / 自己抓指數報價)
4. `recallFromHindsight(date + type)` 拿過去類似報告的觀察
5. 把以上丟給 LLM,請它輸出 markdown 報告(盤前:當日預期 / 盤後:當日盤點)
6. 驗證 LLM 輸出
7. 寫草稿 `drafts/reports/<YYYY-MM-DD>-{pre|post}.md`
8. 寫快照 `snapshots/<YYYY-MM-DD>-{pre|post}/`
9. `retainToHindsight` 把這份報告的觀察存進去

### 盤前特殊

- 內容重點:當日市場預期、追蹤中 investor 的最新表態(最近 12 小時推文)、昨日訊號是否有新發展

### 盤後特殊

- 內容重點:當日盤中重要事件、追蹤中 investor 對事件的反應、今日新訊號摘要、今日訊號後續

## 邊界

- **冪等 key**:`<date>+<type>`(`pre` 或 `post`),例如 `2026-07-10-pre`
- **冪等語意**:重跑同日同 type → 加 `-2` 後綴(同 signal-research)
- **週末不跑**:Mon-Fri 才跑(美股交易日);週末 cron 不觸發
- **DST**:dagu timezone 設定 `America/New_York`,dagu 自動處理 DST
- **單次執行**:預期 < 60 秒

## 寫到哪裡

| 對象 | 位置 | 細節 |
|---|---|---|
| Git | `research/drafts/reports/<YYYY-MM-DD>-{pre\|post}.md` | markdown 報告草稿 |
| Git | `research/snapshots/<YYYY-MM-DD>-{pre\|post}/raw_market.md` | 市場概況快照(原始)|
| Git | `research/snapshots/<YYYY-MM-DD>-{pre\|post}/llm_input.json` | LLM 完整輸入 |
| Git | `research/snapshots/<YYYY-MM-DD>-{pre\|post}/llm_output.json` | LLM 完整輸出 |
| Hindsight | bank `alpha-lab` | recall 過去 pre/post、retain 這次觀察 |
| DB | 不寫業務資料 | — |

## 失敗處理

| 失敗 | 怎麼處理 |
|---|---|
| 市場資料來源連不上 | 沒市場概況,標 warning 進 snapshot,LLM 仍可寫報告;整 step 不 fail |
| LLM rate-limit | dagu retry;backoff |
| Hindsight 連不上 | 同 C,recall 用空結果、retain 失敗 → 整 step fail |
| 寫草稿失敗 | step fail → dagu retry;草稿已存在 → 加 `-2` |
| 寫快照失敗 | step fail → dagu retry |

## IDEMPOTENT(對應 cross-cutting 第 2 節)

- **idempotency key**:`<date>+<type>` 組合
- **重跑語意**:同日同 type 重跑,產出檔案用 `-2` 後綴;dagu UI 顯示成新 run
- **週末補跑**:若週末手動 trigger,dagu 仍跑;冪等機制讓效果跟平日一致

## 沿用(不重設計)

- `agent/lib/llm.ts` — LLM wrapper 沿用
- `lib/hindsight-client.ts` — Hindsight client 沿用
- `lib/db.ts` — `getActiveSignals` 沿用
- `lib/types.ts` — `Signal` type 沿用
- `lib/publish.ts` — frontmatter 序列化沿用
- `agent/d.ts` — 業務邏輯沿用(console.log 改 loglayer;新增 snapshot 寫入)

## 測試要點

| 測試 | 涵蓋 |
|---|---|
| `tests/agent/d.test.ts` | `generateReport()` 各階段 |
| 市場資料來源 fixture | mock 市場 API 回傳固定資料,驗證 LLM 拿到正確 context |
| fixture 整合測試 | `--type=pre` 跟 `--type=post` 各跑一次,驗證草稿跟快照結構 |
| re-run 測試 | 同 date+type 跑 2 次,第二次產 `-2` 後綴 |
| DST 行為測試 | 模擬 DST 切換,驗證 cron 排程不誤觸發 |

---

## 修改原則

- 改報告結構 → 改本 spec 內「行為」段 + `agent/d.ts` 內 LLM prompt
- 改 cron 時間 → 必須跟美股實際交易日曆對齊(SEC 公告假日的話手動 disable timer)
- 改市場資料來源 → 影響 LLM context 品質,可能要 review cross-cutting 第 2 節 NFR RECOVERY
