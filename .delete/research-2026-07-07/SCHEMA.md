# Wiki Schema — 知名投資人研究知識庫

## Domain
**Famous Investor Intelligence** — 對全球知名投資人(價值投資、宏觀、量化、創投等)的研究、追蹤與綜合分析。整合 X/Reddit 公開發言、訪談、書信、13F/13D/13G 等持倉揭露,以及我們自己的反思與(模擬)投資決策紀錄。

## Conventions
- 檔名:小寫、連字號、無空格 (例: `warren-buffett.md`)
- 每個 wiki 頁面以 YAML frontmatter 開頭(必要欄位:`title`、`created`、`updated`、`type`、`tags`、`sources`)
- 用 `[[wikilinks]]` 串接頁面,**每頁至少 2 個 outbound wikilinks**
- 更新頁面時 bump `updated` 日期
- 新頁面必須在 `index.md` 對應段落新增一條目
- 每個重要動作都 append 到 `log.md`
- **Provenance 標記**:在整合 3+ 來源的段落,於段尾加 `^[raw/articles/foo.md]`
- **信心校準**:對意見性/快速變動/單一來源的事實,設定 `confidence: medium` 或 `low`

### Frontmatter 標準

```yaml
---
title: Warren Buffett
created: 2026-07-03
updated: 2026-07-03
type: entity
tags: [investor, value-investing, person]
sources: [raw/articles/buffett-letter-2024.md, raw/posts/x-buffett-2025.md]
confidence: high
contested: false
contradictions: []
---
```

**`raw/` 來源檔 frontmatter:**
```yaml
---
source_url: https://...
ingested: 2026-07-03
sha256: <hex digest>
fetch_method: xurl | curl | web_extract | manual
---
```

## Tag Taxonomy (必須遵守)

### 投資人/人物
- `investor` — 任一投資人
- `person` — 個人
- `value-investing` — 價值投資流派
- `macro-investor` — 宏觀投資
- `quant` — 量化
- `vc` — 創投
- `hedge-fund` — 避險基金經理
- `private-equity` — 私募
- `trader` — 短線/技術
- `index-investor` — 被動指數

### 主題/概念
- `thesis` — 投資論點
- `position` — 持倉(模擬)
- `sector` — 產業主題
- `geopolitics` — 地緣政治
- `macro` — 總體經濟
- `ai` — AI/科技
- `energy` — 能源
- `crypto` — 加密貨幣

### 方法/流程
- `methodology` — 我們自己研究方法的元文件
- `reflection` — 自我反思/事後檢討
- `simulation` — 模擬投資決策
- `calibration` — 信心校準/打賭紀錄
- `source-quality` — 來源可信度評估
- `controversy` — 爭議事件

### 工具/後設
- `meta` — 後設文件 (SCHEMA, METHODOLOGY 等)
- `infrastructure` — 系統/tooling

## Page Thresholds
- **建立新頁** 在以下情況:
  - 一個 entity/concept 在 2+ 來源出現
  - 是某個來源的**核心**對象 (即使只有 1 來源,但佔比大)
- **更新現有頁** 在以下情況:
  - 新來源提到已知 entity/concept
- **不要建頁** 在以下情況:
  - 順帶提及(單一句話提及)
  - 與投資觀點無關
  - 過於瑣碎
- **拆頁** 在以下情況:
  - 頁面超過 200 行 — 拆成子主題並 cross-link
- **封存頁** 在以下情況:
  - 內容被完全取代 — 移到 `_archive/`,從 index 移除

## Page Types

### Entity (`entities/`) — 一個頁面/知名投資人或關鍵人物
包含:背景、關鍵時序、立場/風格、引用句、相關 entity、來源

### Concept (`concepts/`) — 一個頁面/主題或論點
包含:定義、現況、爭議、來源、相關 entity

### Comparison (`comparisons/`) — 多投資人/多論點比較
表格化呈現維度,總結 verdict

### Query (`queries/`) — 有保存價值的問答
值得重新讀的問答內容

### Methodology (`methodology` tag) — 我們自己的研究方法
流程、checklists、pitfalls

### Reflection (`reflection` tag) — 事後檢討與自我審視
「我以為...結果發現...」

## Update Policy — 衝突處理
1. 檢查日期 — 較新來源通常優先
2. 若真正矛盾,**兩個立場都記錄**(標日期與來源)
3. 在 frontmatter 加 `contradictions: [page-slug]`
4. 在 lint report 中 flag 給人工 review

## 模擬投資組合特殊規則 (portfolio/)
- **真實感**:每筆模擬決策必須能追溯到具體來源 (某投資人的某具體發言/持倉)
- **時間戳**:所有買賣必須有日期 + 推論價位 + 信心度
- **事後驗證**:每季/月重新估值,記錄 P/L
- **不與 entity 頁混淆**:portfolio 屬於「我們的反思」,entity 頁屬於「投資人的事實」
- **反思優先**:比起「賺多少」,我們更在意「學到什麼」「判斷錯在哪」