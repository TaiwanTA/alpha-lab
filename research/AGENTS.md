# research/AGENTS.md — 研究工作區

## 這裡做什麼
研究投資人的資料湖 + LLM 分析工作區。Pipeline 從外部來源抓資料,LLM agent 定期分析,分析結果餵給 wiki / blog(之後)。

## 已達成決定
- 資料儲存:Postgres(在 Docker),`items` 表統一儲存所有來源
- Schema:`items(source_type, source_label, external_id, external_parent, created_at, fetched_at, context)`
- 排程:Vercel Workflow(`use workflow`,用 Postgres World)+ systemd timer 做 cron 觸發(之後加,Phase 3)
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
- `publish.ts` — 把 `research/drafts/` 內 markdown 發布到 `blog/src/content/blog/`(CLI + exported `publish()` 給未來 workflow)。`--push` 預設關、`--dry-run` 預覽用;細節見下方「Blog 發布」段
- `workflow-server.ts` — Vercel Workflow HTTP server(Bun.serve + workflow runtime)
  - listen on `WORKFLOW_SERVER_PORT`(預設 8090),expose `POST /a /b /c/:signalId /d/:type` + `GET /run/:runId` + `GET /health`
  - 後台 `getWorld().start?.()` 起 graphile-worker listener
  - Bun plugin 做 client mode SWC transform(`bunfig.toml` preload `scripts/workflow-plugin.ts`)
- `scripts/workflow-build.mjs` — Node 跑 SDK `StandaloneBuilder`,產出 `.well-known/workflow/v1/{flow,step,webhook}.js`(順便補 `module.exports.default`)
- `scripts/workflow-plugin.ts` — Bun plugin,給含 `"use workflow"` / `"use step"` directives 的 .ts/.tsx 檔加 `.workflowId` / `.stepId`

### Workflow source(durable workflow + step 函式)
- `workflow/a.ts` — `aWorkflow()` (run X pull,inline 自 `pull.ts` 業務邏輯不 import pull)
- `workflow/b.ts` — `bWorkflow()` orchestrate `discoverStep()` + 對每個新 signal 自動 trigger `cWorkflow`(回傳 `newSignalIds`)
- `workflow/c.ts` — `cWorkflow(signalId)`,內部 step `researchStep(signalId)` 跑 research + retain + 寫 report
- `workflow/d.ts` — `dWorkflow(type: "pre" | "post")`,內部 step `generateReportStep(type)` 跑 report generation

> 為什麼 workflow/*.ts 業務邏輯是 inline 而非 import agent/*:
> workflow SDK 的 `workflow-node-module-error` esbuild plugin 在 step.js bundle 內會 trace `lib/logger.ts`(透過 `lib/x-client.ts` 等)看到 `node:fs` / `node:os` / `node:path` 就報"not allowed in workflow function"。agent/* 都 module-level `const log = createLogger(...)` 拉 logger,→ workflow bundle 報錯。spec 範例的 import 模式理論上應該 work,但實際不可行,所以 `workflow/*.ts` 把 discover / research / generateReport 業務邏輯完整 inline,並用 `console.log` 替代 logger module-level side effect。
> agent/* CLI path 仍然 100% work(`bun run b.ts` etc. 仍走原本 import logger 邏輯),沒有變動。

### 結構
- `lib/types.ts` — 共用型別(`RawItem`、`FetchState`、`SourceConfig`、`Signal`、`ItemRow`、`NewSignal`、`SignalStatus`)
- `lib/source-adapter.ts` — `SourceAdapter` 介面
- `lib/x-client.ts` — X API v2 client(含 429 / 5xx retry)
- `lib/raw-writer.ts` — JSONL append writer
- `lib/db.ts` — Postgres 操作(含 `insertSignal` returns `Signal`,供 B 拿 id)
- `lib/hindsight-client.ts` — Hindsight REST API client(C / D agent 用)
- `lib/migrator.ts` — migration runner
- `lib/config.ts` — 讀 `sources.json`
- `lib/logger.ts` — loglayer singleton + 檔案輪替(daily/YMD/50M/14d)
- `lib/adapters/x-user-timeline.ts` — X user timeline adapter
- `lib/publish.ts` — publish helper 純函式:`detectType / deriveDate / slugify / extractTitle / extractSummary / parseFrontmatter / serializeFrontmatter / buildFrontmatter / resolveTargetPath`,unit-test in `tests/lib/publish.test.ts`
- `agent/lib/llm.ts` — LLM(OpenRouter)呼叫 wrapper
- `agent/lib/types.ts` — LLM 共用型別
- `agent/b.ts` — B agent(訊號發現):`discover(deps)`
- `agent/c.ts` — C agent(per-signal 研究):`research(signalId, deps)`
- `agent/d.ts` — D agent(盤前/盤後報告):`generateReport(type, deps)`
- `migrations/*.sql` — schema migrations(append-only,no down)
- `tests/` — bun test 跑的測試(`tests/agent/`,`tests/lib/`,`tests/workflow/`)

### 環境變數(在 `.env`)
- `DATABASE_URL` — Postgres 連線字串
- `WORKFLOW_POSTGRES_URL` — workflow runtime 用的 Postgres(`@workflow/world-postgres` 也走同一個 DB;務必跟 `DATABASE_URL` 同值)
- `X_BEARER_TOKEN` — X API bearer token
- `RAW_ROOT` — raw 檔案根目錄(預設 `../raw`)
- `SOURCES_PATH` — sources.json 路徑(預設 `./sources.json`)
- `LOG_DIR` — log 檔根目錄(預設 `./logs`,啟動時 mkdir -p)
- `LOG_CONSOLE` — `"false"` 時關閉 console transport,只寫檔(預設 `true`)
- `WORKFLOW_SERVER_PORT` — workflow HTTP server listen port(預設 `8090`)
- `WORKFLOW_LOCAL_BASE_URL` — workflow SDK background worker call back 給 server 的 base URL(預設 `http://127.0.0.1:8090`)
- `WORKFLOW_TARGET_WORLD` — world target(固定 `"@workflow/world-postgres"`)
- `HINDSIGHT_BASE_URL` — Hindsight container URL(VM 上跑)
- `LLM_*` — LLM provider config(API key、model、base URL)
- `PUBLISH_BLOG_DIR` — `publish.ts` target dir,相對於 monorepo root(預設 `../blog`)
- `PUBLISH_AUTHOR_NAME` / `PUBLISH_AUTHOR_EMAIL` — `publish.ts` git commit author(預設 `alpha-lab <noreply@alpha-lab.local>`)
- `PUBLISH_TARGET_BRANCH` — `publish.ts --push` 的目標 branch(預設 `main`)

### 跑流程
```bash
docker compose up -d
bun run migrate
cp .env.example .env   # 編輯填值,chmod 600
bun run pull
bun test
bun run typecheck

# ---- workflow ----
# 一次性:建 workflow schema(跟 alpha-lab schema 分開,
# Postgres world 自己管):在 .env 設定 WORKFLOW_POSTGRES_URL 後跑
bun run workflow:setup        # = bunx --package=@workflow/world-postgres bootstrap

# build workflow/{a,b,c,d}.ts → .well-known/workflow/v1/{flow,step,webhook}.js
# (server 啟動前必跑,否則 step / flow route 404)
bun run workflow:build      # = node scripts/workflow-build.mjs

# 起 server(bunfig.toml 自動載 scripts/workflow-plugin.ts 給含 "use workflow" 的 .ts 加 workflowId)
bun run workflow-server      # = bun run workflow-server.ts

# 觸發 workflow 跑(bash):
curl -X POST http://127.0.0.1:8090/a     # A — pull 一次 X timeline
curl -X POST http://127.0.0.1:8090/b     # B — 訊號發現(自動 trigger C per new signal)
curl -X POST http://127.0.0.1:8090/d/pre # D — 盤前報告
curl -X POST http://127.0.0.1:8090/d/post # D — 盤後報告
curl -X POST http://127.0.0.1:8090/c/<signal-uuid>  # C — 單 signal 研究(通常不手動)
curl http://127.0.0.1:8090/run/<runId>   # 查 workflow run 狀態
```

### Deploy(VM 上 systemd 接管排程)

**自動化**:跑 `scripts/deploy-vm.sh` 從 local 一次做完——
tar + scp + 解開 + 復原 .env + bun install + migrate + workflow:setup + workflow:build +
patch systemd unit(__PUBLISH_USER__ → 實際 VM user)+ restart server + 驗證 /health。

```bash
./scripts/deploy-vm.sh                 # 完整部署(含 systemd)
./scripts/deploy-vm.sh --skip-systemd  # 只 sync code + rebuild,不動 systemd
./scripts/deploy-vm.sh --skip-build    # 只 sync code
```

**手動一次首次部署**(deploy-vm.sh 之前的前置條件):
```bash
sudo cp deploy/systemd/alpha-lab-*.service deploy/systemd/alpha-lab-*.timer \
        /etc/systemd/system/
sudo sed -i "s/__PUBLISH_USER__/$(whoami)/g" /etc/systemd/system/alpha-lab-*.service
sudo systemctl daemon-reload
sudo systemctl enable --now alpha-lab-workflow.service  # long-running HTTP server
sudo systemctl enable --now alpha-lab-a.timer             # 6h
sudo systemctl enable --now alpha-lab-b.timer             # 1h
sudo systemctl enable --now alpha-lab-d-pre.timer         # Mon-Fri 09:00 ET
sudo systemctl enable --now alpha-lab-d-post.timer        # Mon-Fri 16:30 ET

# 驗證
sudo systemctl status alpha-lab-workflow.service
journalctl -u alpha-lab-workflow -f        # 看 server stdout / stderr
systemctl list-timers alpha-lab-*           # 確認 4 個 timer 都 next-time 排好
curl http://127.0.0.1:8090/health           # 應回 {"status":"ok","port":8090}
```

### Blog 發布(publish.ts,Step 8+9)


把 `research/drafts/` 內的 markdown(由 C / D agent 產出)發布到 `blog/src/content/blog/`,變成 Astro content collection 內的 post。

```bash
# 預覽 — 不寫檔、不 commit,只印 target path + 完整將寫入的內容
bun run publish.ts drafts/reports/2026-07-09-pre.md --dry-run

# commit local(預設)— 不推。review diff 再手動 push 或之後走另一條 review 流程
bun run publish.ts drafts/reports/2026-07-09-pre.md

# commit + push — 會直接 git push origin $PUBLISH_TARGET_BRANCH(main)
# 遠端有新 commit 時會 fail,留 local commit 給 user 處理 rebase
bun run publish.ts drafts/reports/2026-07-09-post.md --push
```

type → tag 對應(對齊 ADR-001「實體:報告」表):

| source path | type | tag |
|---|---|---|
| `drafts/reports/<YYYY-MM-DD>-pre.md` | `pre` | `盤前報告` |
| `drafts/reports/<YYYY-MM-DD>-post.md` | `post` | `盤後報告` |
| `drafts/event-tracking/<slug>.md` | `event-tracking` | `事件追蹤` |

發布的 frontmatter 全由 `publish.ts` 自己生成(`title / date / summary / status / tags / investors / tickers`);來源 frontmatter 的同名欄位會延用、tags 與 type tag 合併去重。slug 用 `kebab-case`(中文保留)。若 `blog/src/content/blog/<date>-<slug>.md` 已存在,自動加 `-2`、`-3` 直到不撞。

安全模式:`--push` 預設 **off**,確保 user 在 publish 完先 review diff 才對外(配合 blog 已上線的事實,避免 LLM 不小心把 unverified 內容推向 Cloudflare Pages 自動 deploy)。`--dry-run` 永遠可用,只 print 不寫任何檔。

`publish.ts` 同時 export `publish(sourcePath, opts?)`,workflow 之後要接 auto-publish 直接 call(`workflow/d.ts` 之後另 PR 處理 import 限制 — workflow bundle 不能 trace 到 `node:child_process`,得包成 `"use step"` 函式)。

### 新增資料來源
1. 在 `lib/adapters/` 新增 `<source>.ts`,實作 `SourceAdapter` 介面
2. 在 `pull.ts` 的 `ADAPTERS` map 註冊
3. 在 `sources.json` 加 config

### 環境變數(在 `.env`)
- `DATABASE_URL` — Postgres 連線字串
- `X_BEARER_TOKEN` — X API bearer token
- `RAW_ROOT` — raw 檔案根目錄(預設 `../raw`)
- `SOURCES_PATH` — sources.json 路徑(預設 `./sources.json`)
- `LOG_DIR` — log 檔案根目錄(預設 `./logs`,啟動時 mkdir -p)
- `LOG_CONSOLE` — `"false"` 時關閉 console transport,只寫檔(預設 `true`)

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
- **Vercel Workflow(Phase 3)** — 不是 orchestrator,是 in-process TS SDK;比 Dagu(YAML + 外部 binary)更合我們 Bun + TS stack;Postgres World 可共用 alpha-lab 的 Postgres instance;cron 觸發用 systemd timer,夠用
- **自寫 migrator** — `Bun.sql` 直接 raw SQL 的哲學下,drizzle/prisma/kysely 會引入 ORM 概念衝突
- **`source_label` per-item** — 同一個 source 拉回來的 items 中,parent tweet 屬於原作者,`@elonmusk` 的 tweet 進我們 DB 的 `source_label` 是 `@elonmusk`,不是監控對象的 label

## 踩過的雷(避免再撞)
- **Bun.sql 不會自動把 JS array 轉 Postgres array** — `WHERE id = ANY(${ids}::text[])` 會炸,要用 `IN (${sql.unsafe(idList)})`。ids 來自程式內部時 `sql.unsafe` 安全
- **X API bearer token 需先在 developer.x.com 開 pay-per-use billing**,沒開就只回 402
- **X API v2 沒有 `in_reply_to_status_id` 這個 tweet field** — 看 X API v1 文檔學到的人會踩。v2 的 reply 資訊放在 `referenced_tweets[]` 裡,要找 `type=="replied_to"` 的那筆取 `id`。quote tweet 是 `type=="quoted"`,不該當 parent。X 的錯誤訊息會列出合法 field 名稱,可以直接看
- **`bun test` 會動 DB**,不是單純 unit test — `db.test.ts` 需要一個真的 Postgres。要先建 `alpha_lab_test` DB + 跑 migration:`docker exec alpha-lab-postgres createdb -U alpha alpha_lab_test && DATABASE_URL=postgres://alpha:...@localhost:5432/alpha_lab_test bun run migrate`。`x-client` / `raw-writer` / `adapter` 那幾個 test 檔才是純單元測試,不需要 DB
- **首跑 lack `lastExternalId` 會一次拉歷史垃圾** — 預測性專案下,過去資料價值低。`initial_backfill_days` (X adapter,預設 3 天) 控制首跑往回拉多遠。不設的話首跑會撞 `max_tweets_per_run` 上限(1000),浪費 API 費用拉幾個月推文。已踩過:首跑拉到 5 個月前共 1093 條,加參數後 43 條

## 量級參考
- 50 萬推文:raw JSONL ~1-3GB,DB ~500MB-1GB
- X API:每次 timeline 呼叫 + 每則 tweet 計費,lookup 100 個 parent 一次比一則一則抓便宜 50-100x
- 月費(e2-medium VM + Postgres + 50 萬推文):~$25-35

## 不做的事
- LLM 分析(留給外部 agent)
- 排程(Phase 3 會用 Vercel Workflow 包,systemd timer 觸發)
- 自動 retry 整個 pipeline(用 Workflow 的 retry 機制)
- migration 的 down(不做,見上方決策)

## 後續規劃
見 `docs/ADR-001-pipeline-redesign.md`。簡版:
- ✅ A: 推文同步(已上線)
- ⏳ B: 訊號發現(每 1-2h,從 items 找市場訊號)
- ⏳ C: 事件追蹤研究(每訊號一個 agent,用 Hindsight 存觀察)
- ⏳ D: 報告生產(MVP 先做美股盤前 + 盤後)

核心原則:每個 agent 只做一件事並且足夠專注 → 費用更少、品質更好、更可預測。
