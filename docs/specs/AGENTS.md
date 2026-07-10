# α-lab v2 規格總入口

**狀態:** 撰寫中(2026-07-10 brainstorming 進行中)
**權威 ADR:** [`../ADR-002-v2-dagu-pivot.md`](../ADR-002-v2-dagu-pivot.md)
**工作區根:** `/home/joker/alpha-lab/`(research/ + blog/ + docs/ 三層)

## 鎖定約束(Q1 到 Q5 加上補充)

| 維度 | 答案 | 出處 |
|---|---|---|
| 範圍 | 完整 v2 — X pull + signals + research + reports + publish 全部從 spec 重設計 | Q1 = A |
| 使用情境 | 非人介入自動發布到 blog,user 是主要讀者;失敗有告警但不擋 pipeline | Q2 = A |
| 品質要求 | OBS + IDEMPOTENT + RECOVERY + DRIFT-GUARD | Q3 = C |
| 完成標準 | 發布 → 等下一個美股交易日收盤 → 驗收;若需要修 → 等下一個收盤日循環 | Q4 = C |
| 部署 | docker compose 黃金標準(四個服務全部容器化) | user 明確 |
| 儲存 | 以 git 為主;資料庫只放可查詢索引 | user 明確 |
| 本地開發 | 假資料給昂貴 API(X 等);正式環境打真的 | user 明確 |
| 文件路徑 | 工作區根目錄的 `/docs/`(research/ 跟 blog/ 是同層元件) | user 明確 |
| ADR-001 處理 | git 刪除(完整歷史保留在 `git log -p`) | user 拆 |
| 切換方式 | hard cut,不留舊版痕跡,不寫自動遷移腳本 | Q5 預設 D |
| 驗收節奏 | 用美股交易日收盤當驗收點 | user 明確 |

## 各 spec 索引

### 跨切面

- [`cross-cutting.md`](cross-cutting.md)— 架構、跨切面 NFR(OBS / IDEMPOTENT / RECOVERY / DRIFT-GUARD)、檔案以 git 為主、測試策略、沿用決定

### 各功能

- [`x-pull.md`](x-pull.md)— A agent:從 X 拉推文
- [`signal-discovery.md`](signal-discovery.md)— B agent:從未處理推文找新訊號
- [`signal-research.md`](signal-research.md)— C agent:對新訊號深入研究
- [`market-reports.md`](market-reports.md)— D agent:美股盤前跟盤後報告
- [`blog-publish.md`](blog-publish.md)— 把研究 markdown 發到 blog

> **命名原則:** 檔名不加日期(α-lab 只一份 v2 規格,不需要版本追蹤);用 kebab-case topic-prefixed 命名,讀檔名就知道內容

## 遷移狀態

對應 ADR-002 的 Phase 0 到 4:

- ✅ **Phase 0** — 文件鷹架 + ADR-002 + 各 spec 結構已落定
- ⏳ Phase 1 — 各 spec 內容填好並經過核准(specs/cross-cutting.md 已有第 1 節架構;NFR、storage、testing 高層;5 個 feature spec 占位還沒寫)
- ⏳ Phase 2 — 實作:docker-compose 撰寫、dagu DAG、執行器映像、移除 v1 的東西
- ⏳ Phase 3 — 切換:週末部署到 VM,等下一個美股交易日收盤後驗收;若需要修,再等下個收盤日循環
- ⏳ Phase 4 — 穩定期一週(全部 NFR 在 production 驗證過才算 done)

## 修改流程

1. 改 spec 先(這份是 source of truth)
2. 在對應的 `agent/*.ts` / `lib/*.ts` / `dags/*.yaml` 改實作
3. 同個 PR 內提交 spec 跟實作的改動
4. CI 跑 `bun run check:drift`(待實作)— 確認 spec 跟實作對得上

> 「確保不再偏移」就是這條流程,不靠人工 memory,靠 spec 跟實作同步進 PR 跟 CI gate。
