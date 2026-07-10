# α-lab 文件總入口

工作區根目錄 `/home/joker/alpha-lab/` 的所有跨子元件文件在此聚合。

## 索引

### 決策紀錄 (ADR)

- [`ADR-002-v2-dagu-pivot.md`](ADR-002-v2-dagu-pivot.md) — α-lab v2 架構決策:dagu 取代 Vercel Workflow,加 docker compose 黃金標準

### 規格 (specs)

- [`specs/AGENTS.md`](specs/AGENTS.md) — v2 規格入口,鎖定約束表、各 spec 索引
- [`specs/cross-cutting.md`](specs/cross-cutting.md) — 跨切面:架構、NFR 規則、檔案以 git 為主、測試策略
- [`specs/x-pull.md`](specs/x-pull.md) — A:抓 X 推文
- [`specs/signal-discovery.md`](specs/signal-discovery.md) — B:從未處理推文找新訊號
- [`specs/signal-research.md`](specs/signal-research.md) — C:對新訊號深入研究
- [`specs/market-reports.md`](specs/market-reports.md) — D:美股盤前/盤後報告
- [`specs/blog-publish.md`](specs/blog-publish.md) — 把研究 markdown 發到 blog

### 子元件指南

- [`../AGENTS.md`](../AGENTS.md) — 工作區根狀態
- [`../research/AGENTS.md`](../research/AGENTS.md) — research 子元件指南
- [`../blog/AGENTS.md`](../blog/AGENTS.md) — blog 子元件指南

## 文件組織原則

- **跨切面 rule** 放 `specs/cross-cutting.md`(架構、NFR 規則、檔案策略、測試策略)— 任何 spec 改了要回頭對齊這裡
- **每個功能一份 spec** — 5 個 agent / 功能各一份,只 cover 自己的業務邏輯跟 fixture
- **修改流程** — 改 spec → 改對應實作 → 同個 PR;spec 先改、實作後改,確保「不再偏移」
