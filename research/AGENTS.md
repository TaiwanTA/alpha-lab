# research/AGENTS.md — 研究工作區

## 這裡做什麼
你的研究主體在這裡。投資人的具體發言、研究筆記、反思日誌都歸這。
設計為「LLM Wiki」模式:raw/ 不可變、wiki/ 可演化、log/ 時序、_staging/ 暫放。

## 目錄分層
- `raw/{posts,articles,transcripts,podcasts}/` — **不可變原始來源**。append-only,任何修正寫到 wiki 頁面
- `entities/` `concepts/` `comparisons/` `queries/` — wiki 頁面(frontmatter 規範見 `SCHEMA.md`)
- `_staging/` — 階段 4 才用的暫放區(模擬投資、追蹤名單)
- `SCHEMA.md` `index.md` `log.md` `METHODOLOGY.md` — 元文件

## memory vs workspace 邊界
- **memory**:協作約定、工具特性、workflow 慣例、決策原則(短)
- **workspace**(這個目錄):投資人發言、研究筆記、價格、原始來源(量大)

## 寫入規範
- 新頁面前先看 `SCHEMA.md`(frontmatter、tag taxonomy、page threshold)
- 更新頁面 bump `updated` 日期 + 在 `log.md` 記錄
- 每頁至少 2 個 outbound wikilinks

## 已達成決定(不要重提)
- blog 部署目標 Cloudflare Pages(可選 GitHub repo)
- 技術棧待定(階段 2 才討論)
- 投資人清單延後到階段 4