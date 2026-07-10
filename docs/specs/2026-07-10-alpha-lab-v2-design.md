# α-lab v2 Design Spec

**Status:** IN PROGRESS(2026-07-10 brainstorming)
**Authoritative ADR:** [`../ADR-002-v2-dagu-pivot.md`](../ADR-002-v2-dagu-pivot.md)
**Workspace root:** `/home/joker/alpha-lab/`(research/ + blog/ + docs/ 三層)

## Sections

- ✅ **Section 1: Architecture** — committed 2026-07-10
- ⏳ Section 2: Components + agent/* boundaries(下一段)
- ⏳ Section 3: Data flow (A/B/C/D pipelines + publish)
- ⏳ Section 4: Error handling / NFR (OBS + IDEMPOTENT + RECOVERY + DRIFT-GUARD)
- ⏳ Section 5: Testing strategy

---

## Locked constraints(Q1-Q5 + adjacency)

| 維度 | 答案 | 出處 |
|---|---|---|
| Scope | 完整 v2 — X pull + signals + research + reports + publish 全部從 spec 重設計 | Q1 = A |
| Use case | Unattended auto-publish blog,user 主讀者,失敗有 alert 不擋 pipeline | Q2 = A |
| NFRs | OBS + IDEMPOTENT + RECOVERY + DRIFT-GUARD | Q3 = C |
| Success criteria | Ship → 等下個 US market close → 驗收;必要時 fix → 等下個 close | Q4 = C |
| 部署 | Docker compose 黃金標準(全 4 個 service 都容器化) | user explicit |
| Storage | Git-first;DB 只放 queryable indexes | user explicit |
| Local dev | Fake data 給昂貴 APIs(X 等);prod 打真 | user explicit |
| Docs 路徑 | workspace-root `/docs/`(research/ + blog/ 是 peer components) | user explicit |
| ADR-001 處理 | git rm(歷史完整保留於 `git log -p`) | user 拆 |
| Cutover | Hard cut,不寫 legacy shim,不寫 auto-migration script | Q5 default D |
| Verification cadence | 用美股交易日收盤當作驗收點(天然 version cycle) | user explicit |

## 對齊 α-lab AGENTS.md 既有決定(沿用不重設計)

| 對象 | 狀態 | 來源 |
|---|---|---|
| Postgres 作為資料儲存(items / signals) | 沿用 | `research/AGENTS.md` 「已達成決定」 |
| Schema 設計哲學(`items` 是 LLM 看索引層,raw 不入表) | 沿用 | 同上 |
| Raw 不可變,改動另寫到 `findings/` / `wiki/` | 沿用 | 同上 |
| Adapter 模式 + `source_type` / `source_label` free-form | 沿用 | 同上 |
| Migrator 自寫 + migrations append-only(不下 down) | 沿用 | 同上 |
| 既有 4 個 SQL migrations(`001-004`) | 完全保留 | git history |
| 245 unit tests baseline | 沿用 + Section 5 擴充 | test count |
| `agent/lib/llm.ts`(MiniMax native + thinking 適配) | 沿用 | PR #13, #14 |
| `lib/publish.ts` + `publish.ts`(CLI + lib helper) | 沿用 | `publish.ts` 邏輯不動 |
| Hindsight bank ID `alpha-lab` | 沿用 | ADR-001 v1 設定 |

## Section 1: Architecture ✅(committed 2026-07-10)

### Topology

```
Host VM α-lab
├──────────────────────────────────────────────────────────────┐
│ exposed                                                  │
│   dagu Web UI :8080   (SSH tunnel only — no public ingress) │
│                                                              │
│ internal — docker compose network "alpha-lab-net"            │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐                │
│   │ postgres │    │ hindsight│    │  dagu    │                │
│   │  :5432   │    │  :8888   │    │ cron +   │                │
│   │ items    │    │ alpha-lab│    │ DAG exec │                │
│   │ signals  │    │ bank id  │    │ + UI api │                │
│   └──────────┘    └──────────┘    └────┬─────┘                │
│       ▲       ▲                ▲      │                      │
│       └───────┴────────────────┴──────┤                      │
│                                        │                      │
│                                   ┌────▼─────┐                │
│                                   │  runner  │                │
│                                   │ bun +    │                │
│                                   │ agent/*  │                │
│                                   └────┬─────┘                │
│                                        │                      │
│ outbound (via runner)                   │                      │
│   → X API                              │                      │
│   → MiniMax-M3                         │                      │
│   → blog repo git push                 │                      │
└──────────────────────────────────────────────────────────────┘

Volumes:
  pg_data             — postgres persistent storage
  hindsight_data      — hindsight memory persistent
  dagu_data           — dagu runs, step history, retry state
  snapshots_volume    — git-tracked snapshots/ (研究 reproducibility)
                         bind-mounted from ./research/snapshots/

Bind mounts:
  ./research          → /workspace inside runner
                         (read-only code, read-write for snapshots/)
  ./research/dags/    → /var/lib/dagu/dags/ inside dagu
                         (DAG definitions, git-tracked)
```

### Service 職責矩陣

| Service | 職責 | 主要貢獻 NFR |
|---|---|---|
| **postgres** | α-lab 業務狀態(items / signals / run summary indexes)| IDEMPOTENT(unique constraints + processed_at)|
| **hindsight** | 跨 run 記憶 — per-signal 研究 recall / retain | RECOVERY(crash 後仍可 recall 之前的 fact)|
| **dagu** | Cron + DAG executor + Web UI backend + retry | OBS(Web UI、run history、step log 永久)|
| **runner** | 全部業務邏輯執行引擎(bun runtime + `agent/*.ts` + `lib/*.ts`)| DRIFT-GUARD(只有一個實作點,沒有 `workflow/*` 平行 inline 副本)|

### 邊界原則(each service one purpose)

- **postgres**:不存 raw content(純 metadata 跟 hot index),raw 由 git snapshot 留
- **hindsight**:只管 fact-level memory,不存 raw tweet/run 紀錄
- **dagu**:只 orchestrate + UI;不存業務 state;它自己內部 SQLite/Filesystem 管 run history
- **runner**:唯一執行 business logic 的地方;`agent/*` 是 single source of truth,**沒有** `workflow/*` 平行 layer

### 網路原則

- 公開入口只有 dagu Web UI 8080,只能從 SSH tunnel 進
- 其他所有 port(postgres / hindsight / dagu internal)只在 `alpha-lab-net` 內部 listen
- Runner 是唯一對外連線的服務(X、LLM、blog git push)
- Local dev 跟 prod 用同一個 compose 檔,只差 `cron` 設成 `none` / `manual trigger`

### 跟 NFR 的對應(deep dive 在 Section 4)

| NFR | 主要機制 | 補位 |
|---|---|---|
| OBS | dagu Web UI + dagu 內部 run history | — |
| IDEMPOTENT | postgres unique constraints + `processed_at` timestamp + agent 自己守 idempotency key | Section 4 |
| RECOVERY | dagu step-level retry policy + VM restart 後從 dagu 自己 state 恢復 | Section 4 |
| DRIFT-GUARD | compose 結構強迫 runner 容器化 + CI 掃 `agent/*` vs 不存在 `workflow/*`(物理路徑切掉) | Section 5 |

---

## Section 2: Components + agent/* boundaries(placeholder — TODO)

Will cover:

- 每個 `agent/*.ts` 的 purpose / contract / dependencies(B = discover、C = research、D = generateReport;另有 `agent/lib/llm.ts` 跟 `agent/lib/types.ts`)
- `lib/*.ts` 共用工具(types、db、llm、hindsight-client、raw-writer、x-client、source-adapter、config)
- `lib/publish.ts` + `publish.ts` — publish flow(publish.ts 是 CLI + lib helper,blog content collection 是 git-tracked,沿用現狀)
- dagu DAG 文件(`research/dags/{pull,discover,research,reports}.yaml`)— 每個呼叫什麼、跟其他 DAG 的 dependency
- Snapshot 機制(`research/snapshots/<signal_id>/{raw_tweets.md, llm_input.json, llm_output.json}`)— 寫入時機、結構、git-archived 政策
- 增加新 agent / 修改既有 agent 的 recipe

## Section 3: Data flow — A/B/C/D pipelines(placeholder — TODO)

Will cover:

- **A**: X pull → items 表 + `research/raw/<source_type>/<source_label>/<YYYY-MM-DD>.jsonl` append-only + 進 dagu DAG `pull` 跑
- **B**: items.unprocessed → LLM(with active signals context)→ signals 表 + 標記 items processed_at + 進 dagu DAG `discover` 跑
- **C**: new signal → Hindsight recall → LLM deep research → markdown draft(`drafts/event-tracking/<slug>.md`)+ signal-scoped snapshot
- **D-pre**: cron(美東 09:00 前)→ market data + active signals 摘要 → markdown draft(`drafts/reports/<YYYY-MM-DD>-pre.md`)
- **D-post**: cron(美東 16:30 後)→ 同上格式 → `drafts/reports/<YYYY-MM-DD>-post.md`
- **Publish**: drafts → `publish.ts` 寫到 `blog/src/content/blog/<date>-<slug>.md` → git push → Cloudflare Pages auto-deploy
- B 完成自動 trigger C(via dagu DAG `discover` step 2 對每個新 signal start `research` DAG)— 跟 v1 同樣 pattern,但 dagu 的 start 是 YAML-level 宣告而非 imperative API

## Section 4: Error handling / NFR enforcement(placeholder — TODO)

Will cover:

- **OBS detail**:dagu Web UI 路徑(`/runs`, `/dags`, `/queues`)、alerts(email / Slack 預備,但 prototype 暫不接)、跟現有 `journalctl` 怎麼互相取代
- **IDEMPOTENT detail**:每個 stage 的 idempotency key(item external_id / signal UUID / publish slug)、postgres unique constraint、再跑過同一 stage 的語意、re-run 的 trace 怎麼在 UI 上看到
- **RECOVERY detail**:failure mode matrix(`LLM rate-limit`、`network down`、`X-API failure`、`hindsight down`、`OOM`、`double trigger` 等)每種的 recovery 行為 — retry / skip / quarantine / 哪個 step retry / 哪個 stage-level retry
- **DRIFT-GUARD detail**:CI 掃規則(沒有 `workflow/` 目錄 / 沒有 `*Workflow` class / 沒有 `use workflow` directive 等 patterns)、pre-commit hook、pre-deploy check、`bun run check:drift` 命令

## Section 5: Testing strategy(placeholder — TODO)

Will cover:

- 既有 unit tests(245 baseline)沿用 + 加新 agent/* 的 tests
- Integration tests:`docker compose up` → 跑 fixture → 驗證 A/B/C/D 全 cycle
- DRIFT-GUARD test:CI 掃 `agent/*` vs 防 inline 規則,掃不過 PR fail
- IDEMPOTENT re-run tests:同 stage 跑 2 次,DB 狀態 + git snapshot 都單一(trigger-level fixtures)
- Cutover dry-run:手動 checklist(週末部署 → 等下個 US market close → dagu UI 看 run 成功 → git log 看 snapshot commit → blog 看 published post → manual rollback 如果失敗)

---

## Migration status(this section tracks phases per ADR-002)

- ✅ **Phase 0** — docs scaffold + ADR-002 + this spec doc Section 1(本 commit)
- ⏳ Phase 1 — spec doc Sections 2-5 全部 approved
- ⏳ Phase 2 — implementation(docker-compose / dagu setup / runner image / DAGs / 移除 v1)
- ⏳ Phase 3 — cutover(等美股下個收盤日驗收;必要時 fix → 等下個收盤日)
- ⏳ Phase 4 — 穩定期 1 週(NFRs 全在 production 驗證才 done)

## Open questions / TODO across sections

- [ ] dagu DAG 內部 step dependency 怎麼表達(Section 2)
- [ ] X adapter fake data fixture 具體格式(Section 2 / 5)
- [ ] LLM call 的 idempotency token 是否要存 hash?(Section 4)
- [ ] Snapshot retention / cleanup 政策(Section 2 + 5)
- [ ] `runs_summary` 表的 schema(Section 4)
- [ ] secrets 管理(.env 在 host bind-mount?compose secrets?Vault 之類 prototype 過重,跳過)(Section 4)
- [ ] DRIFT-GUARD CI script 跟既有 AI review(現有的 kilo / gemini / coderabbit)怎麼 avoid double-effort(Section 5)
