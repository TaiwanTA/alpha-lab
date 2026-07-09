# ADR-001: Alpha-Lab Pipeline Redesign — ABCD 四段式架構

**狀態**: Accepted (2026-07-09)
**取代**: 兩-flow 草案(extract + write)、舊 phase plan 中 Phase 3 的線性設計

## Context

原本構思是兩個流程:
- Flow A: 從 items 表提煉資訊進 Hindsight
- Flow B: 從 Hindsight 寫文章

問題:
1. **Flow A 設計成「逐條改寫 tweet」的 ETL**,但實際需求是「定時 batch + agent 自己找資料研究」,根本不是 ETL
2. **Flow B 太廣**,把「事件追蹤」跟「盤前盤後報告」混在一個流程,每次 run context 不明確、產出不可預測、token 成本失控
3. **「事件」這個概念沒有資料實體**,等於每次 agent 都要重新發明「現在在追蹤什麼」

## Decision

改成 ABCD 四段式,**核心原則:每個 agent 只做一件事並且足夠專注**。費用更少、品質更好、行為更可預測。

### A — 推文同步(已完成)
- **任務**: 從 X user timeline 同步推文進 `items` 表
- **頻率**: 現有 pipeline(cron 控,預設每 6 小時)
- **跨段價值**: 整個系統只此一處打 X timeline API,**避免 B/C/D 各自重複查 X search 浪費成本**
- **首跑邊界**: `initial_backfill_days` 參數(預設 3 天)控制首跑往回拉的時間範圍。**不設此值的話首跑沒 lastExternalId 可做邊界,會一次撞到 max_tweets_per_run 上限把幾個月歷史推文都拉下來**
- **現況**: ✅ 已上線,Bill Ackman 一個 source,首跑後 ~43 條(3 天)

### B — 訊號發現
- **任務**: 從最近的新 items 中找出「值得專注的市場訊號」,建立訊號實體
- **頻率**: 每 1-2 小時一次
- **輸入**: `items` 表中尚未被處理的 items、`signals` 表中現有訊號(避免重複建)
- **輸出**: 新增 `signals` 表 row,附 metadata(importance、status、tags、related items)
- **Hindsight**: 用處不大,短期 batch 來說 context 直接放最近 items 夠了

### C — 事件追蹤研究
- **任務**: 對**單一訊號**獨立起一個 agent,做研究、查資料、累積觀察
- **頻率**: 每個新訊號觸發一次,或現有訊號每 N 小時複查一次
- **特點**: **一個 agent 一個訊號**,不混多訊號下去跑
- **輸入**: 訊號本體、X search API(可查相關推文)、外部研究工具(web search、SEC 13F 未來)
- **輸出**: 
  - Hindsight 的 observation / entity memory(過程中的碎片觀察,跨 run 共享)
  - `事件追蹤` 報告(markdown,持續追加,時間軸脈絡清晰)
  - 更新訊號 status / importance
- **Hindsight 角色**: **核心價值在這**。事件追蹤是 long-running 跨多次 run,context 裝不下所有歷史觀察,必須 semantic recall

### D — 報告生產
- **任務**: 從所有訊號 + 事件追蹤彙整出短報告
- **頻率**: 美股盤前固定時間一次、盤後固定時間一次
- **MVP 範圍**: 先做這兩種,之後再擴(月報、產業專題、投資人專題等)
- **盤前報告(Pre-market)**:
  - 目標: 當日美股預測/重點關注
  - 主要參考: 當前所有 active signals、最新事件追蹤
  - Hindsight: recall 補脈絡
- **盤後報告(Post-market)**:
  - 目標: 盤後分析 + 對盤前報告的檢討
  - 主要參考: 當天訊號 + 事件追蹤 + 盤前報告
  - 強制: 跟盤前報告對照(命中/失誤)

## 資料層分工

| 層 | 儲存 | 存什麼 | 訪問模式 |
|---|---|---|---|
| 原始資料 | Postgres `items` + 磁碟 `raw/*.jsonl` | 推文原始 payload + LLM-readable context | SQL filter、時間排序、provenance |
| 訊號實體 | Postgres `signals`(待加) | 訊號 metadata、status、importance | SQL filter by status、join items |
| 長期記憶 | Hindsight bank `alpha-lab` | C part 過程的 observation、entity 關聯 | semantic recall、reflect |
| 產出 | 檔案 + git(TaiwanTA/alpha-lab) | 事件追蹤 .md + 盤前盤後 .md | 人類讀、blog 發布 |

**設計原則**:不把訊號存 Hindsight。訊號要 SQL filter、status 流轉、join items,這是結構化查詢需求不是 semantic recall 需求。

## 實體:`市場訊號`(Signal)

(原名:「事件」,2026-07-09 改名為「市場訊號」,更精準表達「值得追蹤的市場動態」)

欄位設計(待 migration 002 實作):

```sql
CREATE TABLE signals (
  id            UUID PRIMARY KEY,
  slug          TEXT UNIQUE,             -- url-friendly 名稱
  title         TEXT NOT NULL,
  description   TEXT NOT NULL,
  importance    SMALLINT NOT NULL,       -- 1-5,5 最重要
  status        TEXT NOT NULL,           -- discovered / tracking / matured / faded / invalid
  tags          TEXT[],                  -- 分類,可多個
  source_items  TEXT[],                  -- 引發此訊號的 item external_ids
  created_at    TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL,
  -- status history、relation to reports 之後另表加
);
```

訊號的 status 流轉:
- `discovered` → B 找到,C 還沒跑過研究
- `tracking` → C 跑過至少一次,繼續追蹤
- `matured` → 發展完整,D 已寫進報告
- `faded` → 重要性下降或過時
- `invalid` → 初始判斷錯誤,廢棄

## 實體:`報告`

三種類型(MVP 先做後兩種):

| 類型 | 由誰產 | 頻率 | 深度 | blog 分類 |
|---|---|---|---|---|
| 事件追蹤 | C part agent | 每訊號觸發,持續追加 | 淺、持續性、時間軸脈絡 | tag: `事件追蹤` |
| 盤前報告 | D part agent | 美股盤前固定時段 | 中高、當日預測 | tag: `盤前報告` |
| 盤後報告 | D part agent | 美股盤後固定時段 | 中高、回顧檢討 | tag: `盤後報告` |

**`市場訊號` 本身也可以是 blog post**(訊號的 public face),分類 tag: `市場訊號`。

## Agent 分工原則

每個 agent:
- 接收**單一明確任務**(找訊號、研究一個訊號、寫一種報告)
- 上下文窄: 只看自己需要的 items / signals / hindsight memories
- 工具集合最小: B 不需要 web search、C 需要 X search + web search、D 只讀內部資料
- 產出結構固定(markdown with frontmatter),不需要每次重新協商格式

這直接對應 user 的原則:「每個 agent 只做一件事並且足夠專注 → 費用更少、品質更好、更可預測」。

## 排程

| 段 | 觸發 | 頻率 | 預估 token/run |
|---|---|---|---|
| A | cron / Dagu | 6h 一次 | 不用 LLM |
| B | cron / Dagu | 1-2h 一次 | 低 |
| C | 新訊號觸發 + 現有訊號每 N 小時複查 | 視訊號數量 | 中 |
| D 盤前 | cron (美東 09:00 前) | 每日一次 | 中高 |
| D 盤後 | cron (美東 16:30 後) | 每日一次 | 中高 |

MVP 階段可以先手動 `bun run <flow>.ts` 跑,Dagu 等 ABCD 都做完再上。

## MVP 範圍

優先順序:

1. ✅ A 已上線
2. **B 訊號發現** — 寫 signals schema、寫 B agent,跑一次現有 1093 items 看找出什麼訊號
3. **C 事件追蹤研究** — 寫 C agent、用 Pi SDK + hindsight client、對 B 找出的某個訊號跑一次
4. **D 報告生產** — 寫 D agent,先寫盤前或盤後其一
5. 整合 Dagu 排程
6. 加更多 source(SEC 13F、X search 補強)
7. 擴展報告類型(月報、產業專題)

## 與既有系統相容性

- **不動 `items` 表、不動 A part pipeline**(已上線驗證過)
- **新增 `signals` 表**(migration 002)
- **新增 hindsight instance**(關掉舊 hermes 用途的,新開給 alpha-lab 用)
- **新增 `agent/` 子目錄** in research/(B/C/D 的程式碼放這)
- **blog repo 加分類 / tag**:事件追蹤 / 盤前報告 / 盤後報告 / 市場訊號

## 紀錄

- 2026-07-09 接受,取代兩-flow 草案。後續實作以此為權威,與之前對話衝突以此版本為準。
