# AGENTS.md — docs/specs/ 目錄

## 這裡做什麼

`docs/specs/` 是 α-lab v2 的功能規格區。每一份文件描述 v2 的某個層面該怎麼做,實作(`research/agent/*.ts`、`research/lib/*.ts`、`research/dags/*.yaml` 等)必須對得上這裡。

跟 [`cross-cutting.md`](cross-cutting.md)並列時:**`cross-cutting.md` 是 source of truth,這目錄下的 feature spec 是對齊基準的具體實作描述**。

## 結構

| 檔案 | 角色 |
|---|---|
| `cross-cutting.md` | **跨切面規則**:架構、4 個 NFR(OBS / IDEMPOTENT / RECOVERY / DRIFT-GUARD)、檔案策略、測試策略、沿用既有決定。任何修改都影響所有 feature spec。 |
| `x-pull.md` | A agent(X timeline 拉資料)|
| `signal-discovery.md` | B agent(訊號發現)|
| `signal-research.md` | C agent(per-signal 研究)|
| `market-reports.md` | D agent(美股盤前/盤後報告)|
| `blog-publish.md` | publish 流程(markdown → blog git push)|

## feature spec 的骨架

每份 `*.md`(cross-cutting 跟 README 之外)都應該用同一個骨架,讓讀的人能預期結構:

1. **用途** — 這個 spec 描述什麼
2. **觸發與頻率** — 誰觸發、什麼頻率
3. **介面** — CLI / dagu DAG / 低階 function
4. **行為** — 從觸發到結束的步驟
5. **邊界** — 冪等關鍵字、上限、不該做的事
6. **寫到哪裡** — DB tables + git 路徑兩邊都列
7. **失敗處理** — 錯誤模式矩陣
8. **IDEMPOTENT**(連到 cross-cutting 第 2 節)— 冪等機制、key、重跑語意
9. **沿用既有** — 從 v1 沿用的東西列舉,標明「不重設計」
10. **測試要點** — 該跑的測試類型
11. **修改原則** — 改這份 spec 時的警戒事項跟 cross-reference

沒填到的段落寫「(留空,待 Phase 2 實作時補)」,不要刪。

## 怎麼加一份新 feature spec

1. **先確認不需要 cross-cutting rule**:如果新規則會影響其他 spec,先想清楚要不要加到 cross-cutting.md
2. **定義 spec 跟既有功能的關係**:誰觸發這個 spec、這個 spec 觸發誰、寫到哪些表跟 git 路徑
3. **依骨架寫完 11 段**
4. 在 `docs/AGENTS.md` 的索引清單加上去(還有 cross-cutting.md 的索引,如果有)
5. 在 `AGENTS.md`(這個目錄的)的「結構」表加新 row
6. 同 PR 內附上對應實作與其 unit test

## 怎麼改 cross-cutting

1. 影響範圍檢查 — 列出這個改動會影響哪幾份 feature spec
2. 同步更新受影響的 feature spec(cross-reference 也要更新)
3. **需要**明確 review 才合併 — 改 cross-cutting 等同動 NFR 跟架構

## 怎麼改現有 feature spec

1. 對應實作也要改 — 在同個 PR 內,先改 spec 然後改 code
2. 「沿用既有」段不要輕易動 — v1 的決定有歷史成本,重設計需明確理由
3. 改「邊界」段等於改 NFR — review
4. 改「測試要點」段不會影響 spec 邏輯,不用特別 review

## Cross-reference 怎麼寫

- 路徑用相對 — `[cross-cutting.md](cross-cutting.md)`,不要絕對路徑
- 引用 NFR 時指明第幾節:`見 cross-cutting.md 第 2 節 IDEMPOTENT`,不只寫「見 cross-cutting.md」
- 引用其他 feature spec 時指明文件名 + 段落,例如 `見 signal-research.md 第 7 節 失敗處理`
- 避免雙向 reference(只有單向,從較細節指向較權威)

## 不做的事

- 不把 spec 跟 code 寫在同個檔(`AGENTS.md` / spec 是給人讀的)
- 不在 spec 裡寫程式碼片段超過 5 行(超過就搬到 `research/` 內)
- 不寫 implementation 細節(spec 寫「該做什麼」,code 寫「怎麼做」)
- 不寫 testing 程式碼(spec 只列「要測什麼」,test 程式碼放 `research/tests/`)
- 不做 spec 內的版本切換(v2 期間不再有 v2.1 / v2.2,改就 commit 跟更新,不留 side branch)
- 不寫到 `docs/AGENTS.md` 的索引時偷放 `## Index` — 索引在每個 `AGENTS.md` 頂層就夠

## 修改流程(再強調)

```
1. 讀對應 spec + 必要 cross-cutting 段
2. 改 spec (這份是 source of truth)
3. 改實作 (research/agent/*、lib/*、dags/*)
4. 加 / 改測試
5. 同 PR 內提交(spec 跟實作跟測試一起)
6. PR 過 CI(包含 check:drift、unit tests、integration tests)
```

DRIFT-GUARD 確保第 2 跟第 3 步不會分開漂移。
