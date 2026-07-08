# research/AGENTS.md — 研究工作區

## 這裡做什麼
研究投資人的資料湖 + LLM 分析工作區。Pipeline 從外部來源抓資料,LLM agent 定期分析,分析結果餵給 wiki / blog(之後)。

## 已達成決定
- 資料儲存:Postgres(在 Docker),`items` 表統一儲存所有來源
- Schema:`items(source_type, source_label, external_id, external_parent, created_at, fetched_at, context)`
- 排程:Dagu(之後加,Phase 3)
- Raw 儲存:JSONL 檔案,`raw/<source_type>/<source_label>/<YYYY-MM>/<YYYY-MM-DD>.jsonl`
- 投資人清單延後到 Phase 4

## 設計原則(讀 schema / code 前先看)
- `items` 表是給 LLM 看的**索引層**,不是 source of truth。raw payload 在磁碟的 `raw/*.jsonl`
- `context` 是 adapter 渲染過的純文字,**不要塞 JSON 進去** — 會強迫 LLM 自己解析
- `source_type` / `source_label` 是 free-form TEXT,加新來源不用改 schema
- `fetch_state.last_external_id` 是 inclusive boundary — adapter 遇到等於就停,確保不漏不重
- adapter 模式:每個 source 一個檔案實作 `SourceAdapter` 介面;理由是加來源不污染 schema

## 寫入規範
- `raw/` 不可變。任何修正另寫到 `findings/` 或 `wiki/`
- DB schema 改動一律走 `migrations/`,**不要手改**
- 新增資料來源:寫一個 adapter 放到 `lib/adapters/`

## Pipeline 程式碼

### 入口
- `pull.ts` — 主程式:讀 `sources.json`,跑各個 source 的 pull
- `migrate.ts` — 跑 DB migrations

### 結構
- `lib/types.ts` — 共用型別(`RawItem`、`FetchState`、`SourceConfig`)
- `lib/source-adapter.ts` — `SourceAdapter` 介面
- `lib/x-client.ts` — X API v2 client(含 429 / 5xx retry)
- `lib/raw-writer.ts` — JSONL append writer
- `lib/db.ts` — Postgres 操作
- `lib/migrator.ts` — migration runner
- `lib/config.ts` — 讀 `sources.json`
- `lib/adapters/x-user-timeline.ts` — X user timeline adapter
- `migrations/001_*.sql` — schema migrations(append-only,no down)
- `tests/` — 4 個 test 檔(用 `bun test` 跑)

### 環境變數(在 `.env`)
- `DATABASE_URL` — Postgres 連線字串
- `X_BEARER_TOKEN` — X API bearer token
- `RAW_ROOT` — raw 檔案根目錄(預設 `../raw`)
- `SOURCES_PATH` — sources.json 路徑(預設 `./sources.json`)

### 跑流程
```bash
docker compose up -d
bun run migrate
cp .env.example .env   # 編輯填值,chmod 600
bun run pull
bun test
bun run typecheck
```

### 新增資料來源
1. 在 `lib/adapters/` 新增 `<source>.ts`,實作 `SourceAdapter` 介面
2. 在 `pull.ts` 的 `ADAPTERS` map 註冊
3. 在 `sources.json` 加 config

## 為什麼用這些工具
- **Dagu(Phase 3)** — 不用 crontab 是因為要 retry/depends/UI;不用 Airflow 是因為它要 DB + Python runtime,單 VM 過重
- **自寫 migrator** — `Bun.sql` 直接 raw SQL 的哲學下,drizzle/prisma/kysely 會引入 ORM 概念衝突
- **`source_label` per-item** — 同一個 source 拉回來的 items 中,parent tweet 屬於原作者,`@elonmusk` 的 tweet 進我們 DB 的 `source_label` 是 `@elonmusk`,不是監控對象的 label

## 踩過的雷(避免再撞)
- **Bun.sql 不會自動把 JS array 轉 Postgres array** — `WHERE id = ANY(${ids}::text[])` 會炸,要用 `IN (${sql.unsafe(idList)})`。ids 來自程式內部時 `sql.unsafe` 安全
- **X API bearer token 需先在 developer.x.com 開 pay-per-use billing**,沒開就只回 402
- **X API v2 沒有 `in_reply_to_status_id` 這個 tweet field** — 看 X API v1 文檔學到的人會踩。v2 的 reply 資訊放在 `referenced_tweets[]` 裡,要找 `type=="replied_to"` 的那筆取 `id`。quote tweet 是 `type=="quoted"`,不該當 parent。X 的錯誤訊息會列出合法 field 名稱,可以直接看
- **`bun test` 會動 DB**,不是單純 unit test — `db.test.ts` 需要一個真的 Postgres。要先建 `alpha_lab_test` DB + 跑 migration:`docker exec alpha-lab-postgres createdb -U alpha alpha_lab_test && DATABASE_URL=postgres://alpha:...@localhost:5432/alpha_lab_test bun run migrate`。`x-client` / `raw-writer` / `adapter` 那幾個 test 檔才是純單元測試,不需要 DB

## 量級參考
- 50 萬推文:raw JSONL ~1-3GB,DB ~500MB-1GB
- X API:每次 timeline 呼叫 + 每則 tweet 計費,lookup 100 個 parent 一次比一則一則抓便宜 50-100x
- 月費(e2-medium VM + Postgres + 50 萬推文):~$25-35

## 不做的事
- LLM 分析(留給外部 agent)
- 排程(Phase 3 會用 Dagu 包)
- 自動 retry 整個 pipeline(用 Dagu 的 retry 機制)
- migration 的 down(不做,見上方決策)
