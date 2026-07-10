# ADR-002: α-lab v2 — Pivot to dagu for Scheduling and Orchestration

**Status:** Accepted(2026-07-10)
**Supersedes:** `research/docs/ADR-001-pipeline-redesign.md`(removed in this commit;complete history recoverable via `git log -p -- research/docs/ADR-001-pipeline-redesign.md`)

## Context

α-lab 是投資人研究的 pipeline:從外部來源(X / 預留 Reddit / SEC 13F 等)拉資料、跑 LLM agent 分析(ABCD 四段)、把研究 markdown 發布到 `blog/src/content/blog/`(已上線 Cloudflare Pages)。

### v1 → v2 旅程(commit of record)

- `1d34572`(2026-07-09)— ADR-001 首次提出,ABCD pipeline + Dagu vs Vercel Workflow 評估,當時選 **Vercel Workflow**
- `193736e` — 正式記錄「Dagu → Vercel Workflow」轉向,理由:in-process TS SDK、Postgres World 可共用 alpha-lab Postgres instance、不用額外起 8080 server
- `dab7c6e`(PR #10)— Vercel Workflow + systemd timer 整合上線
- `334b2c5`(PR #17)— ADR-001 末段紀錄 6 個 self-host workaround

### 為什麼 pivot 回 dagu

PR #10 之後 12 個 PR、約 13 小時工作逐步暴露 v1 的 pain points:

1. **6 個 system-level patch** 為了在 Bun self-host 跑起 Vercel Workflow SDK 而寫(詳見 ADR-001 「紀錄」段 line 163-173)
2. **Workflow inline 業務邏輯** — `lib/logger.ts` module-level 拉 `node:fs` / `node:os`,SDK 的 `workflow-node-module-error` esbuild plugin 報錯;workaround 是把業務邏輯完整 inline 進 `workflow/*.ts`,造成跟 `agent/*.ts` 平行實作(`workflow/b.ts` 302 行 vs `agent/b.ts` 352 行,validateCandidate 函式 訊息粒度分歧)
3. **可觀察性缺口** — Vercel Workflow state 在 `workflow_runs` / `workflow_steps` 表內,**沒有 UI**;查失敗 run 要 `psql` + `journalctl`
4. **Spec-vs-implementation drift** — `workflow/b.ts` 跟 `agent/b.ts` production path 跑的版本跟 `agent/b.ts` 最被測試的版本不完全同步,validateCandidate 在兩個檔有不同粒度的錯誤訊息
5. **Oracle 驗證確認**:`workflow/b.ts` 跟 `agent/b.ts` 的相同業務邏輯有 divergence(progressive risk,不是單次 bug)— 每次加新 feature 都會 re-introduce inline 副本,直到有 structural enforcement 阻擋

Prototype-stage 壓力下,這些 drift + workaround 會繼續累積。沒有 spec-as-contract 機制,改一個 feature 都會再 inline 一次。

## Decision

α-lab v2 採取以下五個核心決定:

1. **Vercel Workflow 換成 dagu** — local-first workflow engine(單一 binary、file-based state、YAML DAG、Web UI port 8080,本地 cron + retry + history + UI 內建)
2. **Docker compose 為黃金標準部署** — postgres / hindsight / dagu / runner 四個 service 同一個 `docker-compose.yml` 一次拉起;可移植性、可重現性、local dev 一致
3. **Git-first storage** — 內容型 artifacts(reports / prompts / signal snapshots / DAG yaml)走 git;DB 只放 queryable indexes(signals / items lookup / run summaries)
4. **Local dev 用 fake data** — X pulls 跟其他昂貴 API 在 local 用 fixture,production 打真的;`bun run fixtures/` 或 env-var 切換
5. **Business logic 單一 source of truth** — `agent/*.ts` 是唯一執行路徑,**不存在** `workflow/*.ts` 等平行實作;DRIFT-GUARD 透過 CI scan + compose 結構強制(runner 在 container 內,工作目錄 mounted,沒有額外 inline 點)

### 為什麼這五個一起

- dagu 把 in-process SDK 責任換成 external orchestrator,自己有 UI / retry / history — 補回 Vercel Workflow 缺的 observability
- docker compose 把現有 systemd unit + bash deploy script 換成 declarative file — 一鍵 `docker compose up` 起整套
- git-first storage 跟 dagu file-based state 自洽 — DAGs 是 YAML(自然 git-tracked),snapshots 是目錄(自然 git-tracked),reports 已在 git(走 `blog/src/content/blog/`)
- Runner 容器化 + 結構性 enforcement 把 inline 副本的物理路徑切掉 — 沒有 `workflow/*.ts` 資料夾就沒有平行實作的可能性

### 拒絕的方案

| 方案 | 拒絕理由 |
|---|---|
| **留下 Vercel Workflow,補 log viewer + retry UI** | 補補丁等於自製半套 orchestrator,且 6 個 SDK workaround 的維護負擔不會消失 |
| **GitHub Actions self-hosted runner** | GHA schedule 在 high-load 時**會 delayed 或 dropped**(GitHub 官方文件明寫);runner offline 時 queue 24h 上限;self-hosted runner 在公開 repo 變 security attack surface;α-lab 沒有 PR 觸發需求,GHA 核心賣點 zero-value |
| **dagu 但 runner 在 host(docker compose 只有 state 層)** | 可移植性只有 state、execution 仍強耦合 VM 的 bun install + env;不符合黃金標準 |

### 為什麼 dagu 適合 α-lab

- **Local-first**:VM 重啟不丟 scheduler state;UI 即使在外網不穩時仍可用
- **單 binary + 文件式 config**:YAML 在 git,容易 review
- **內建 cron + retry + history + Web UI** — α-lab 缺的就這些
- **不依賴外部 SaaS** — 不要 GitHub.com / Vercel dashboard

## 實作層面(將在 spec doc Section 2-5 展開)

- 4 個 dagu DAG 在 `research/dags/{pull,discover,research,reports}.yaml`
- Runner 是 long-lived container(bun runtime + `agent/*` + `lib/*` + `publish.ts`)
- Postgres items / signals 表保留;新增 `runs_summary` 表給跨 run 統計
- Hindsight container 沿用但 bank ID 維持 `alpha-lab`
- 既有 4 個 migrations(`001-004`)完全保留
- Snapshot 目錄 `research/snapshots/<signal_id>/` 給 per-signal reproducibility(raw_tweets.md / llm_input.json / llm_output.json)
- 既有 `pull.ts` / `publish.ts` / `migrate.ts` 沿用,只是被 dagu step 呼叫而不是 systemd timer 觸發 curl

## Migration 計畫

1. **Phase 0**(本 commit)— docs scaffold + ADR-002 + spec doc Section 1 skeleton
2. **Phase 1** — spec doc Section 2 (Components) → 5 (Testing) 全部 approved
3. **Phase 2** — implementation:docker-compose build + dagu DAG 寫 + runner image build + AGENTS.md 重寫
4. **Phase 3** — cutover:週末部署 VM,等美股下個收盤日驗收;若 fix 再等下個收盤日循環
5. **Phase 4** — 穩定期一週(dagu Web UI 看所有 run / signals table 看 trace / snapshot 看 reproducibility 都驗證後才算 done)

**Hard cut**(不留 Vercel Workflow legacy shim)— 切換後 `workflow/*.ts`、`workflow-server.ts`、`scripts/workflow-plugin.ts`、`scripts/workflow-build.mjs`、`bunfig.toml` 全移除。

## 後果

### Positive
- Business logic 單一 source of truth(`agent/*.ts`),inline 副本物理路徑切掉
- dagu Web UI 補回 v1 缺的 observability
- docker-compose 黃金標準達標,local dev 一致
- Git-first storage 符合 α-lab 原生偏好

### Negative
- 多一個 dagu daemon 要 monitor
- 失去「in-process TS SDK」的 ergnomics — bun scripts 跑在 container 內,邊界 `docker compose exec`(每 step ~5ms overhead,可接受)
- dagu 沒有 Vercel Workflow SDK 那麼 mature,UI 細緻度可能較差
- 跨機 workflow SDK 生態(e.g. 第三方 dashboard)不可用

### Mitigations
- dagu 是單 Go binary,資源 footprint 可預期,compose healthcheck 監控
- 接受 dagu 的 idiomatic 用法,不要硬塞現有心智模型
- 切換手動(Q4 cadence — 等美股收盤後驗收)— 沒有 automatic migration script 風險

## Reference

- α-lab workspace-root AGENTS.md — 工作區根狀態
- `docs/specs/2026-07-10-alpha-lab-v2-design.md` — v2 完整 spec doc(設計 end-to-end 在那)
- `research/AGENTS.md` — research 子 component 指南(sections 待 v2 落定重寫)
