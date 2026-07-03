# Wiki Log

> 所有 wiki 動作的時序記錄。Append-only。
> 格式: `## [YYYY-MM-DD] action | subject`
> Actions: create, ingest, update, query, lint, archive, delete, reflection
> 超過 500 條目時 rotate:`log-YYYY.md` + 新檔開始

## [2026-07-03] create | Wiki initialized
- Domain: 知名投資人研究 (Famous Investor Intelligence)
- 環境:Linux container,HOME=/opt/data/home,HERMES_HOME=/opt/data
- 工具狀態:已安裝 curl/python3/node/git;待安裝 xurl/blogwatcher-cli/jq

## [2026-07-03] restructure | 改用 research/ + blog/ 兩層結構
- 原因:之前在根目錄散落 7 份 .md + 10 個子目錄,結構混亂
- 新結構:
  - 根目錄: `AGENTS.md` (workspace 級入口)
  - `research/` — 主工作區
    - `AGENTS.md` (project 級入口)
    - `SCHEMA.md` `METHODOLOGY.md` `index.md` `log.md` — 元文件
    - `raw/{posts,articles,transcripts,podcasts}/` — 不可變來源
    - `entities/` `concepts/` `comparisons/` `queries/` — wiki 頁面
    - `_staging/` — 階段 4 才用的暫放(目前:PORTFOLIO-FRAMEWORK.md、watchlist.md)
  - `blog/` — 對外發表,階段 2 才填
- 移除多蓋的空目錄:`portfolio/`、`drafts/`、`reports/`、`research_queue/`、`scripts/`
- 寫入兩份 AGENTS.md(workspace 級 + project 級,精簡版,30 秒可讀)
- 階段 1 完成,等 user 進入階段 2