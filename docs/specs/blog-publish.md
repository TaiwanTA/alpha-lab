# 把研究 markdown 發到 blog (`blog-publish`)

**狀態:** 撰寫中
**覆蓋範圍:** publish.ts 的行為、介面、安全模式、測試要點
**交叉引用:** [`cross-cutting.md`](cross-cutting.md)(git-first 策略)

## 用途

把 `research/drafts/` 內的 markdown(由 [`signal-research`](signal-research.md)(事件追蹤)、[`market-reports`](market-reports.md)(盤前/盤後) 產出)發布到 `blog/src/content/blog/`,變成 Astro content collection 內的 post,觸發 Cloudflare Pages 自動部署。

## 觸發與頻率

| 環境 | 觸發 |
|---|---|
| 正式環境 | 在 draft 寫完後由 dagu 步驟呼叫 publish()(驗收後 push)|
| 本地 / 開發 | 手動 `bun run publish.ts <path>` |

**不會全自動 push**:`--push` 預設 off,需要顯式決定;切換預設值需 review,因為會跳過 review 直推 production blog

## 介面

### CLI

```sh
# 預覽 — 不寫檔、不 commit,只印 target path + 完整將寫入的內容
bun run publish.ts drafts/reports/2026-07-09-pre.md --dry-run

# commit local(預設)— 不推。review diff 再手動 push 或之後走另一條 review 流程
bun run publish.ts drafts/reports/2026-07-09-pre.md

# commit + push — 會直接 git push origin $PUBLISH_TARGET_BRANCH(main)
# 遠端有新 commit 時會 fail,留 local commit 給 user 處理 rebase
bun run publish.ts drafts/reports/2026-07-09-post.md --push
```

### lib 介面

```ts
// lib/publish.ts (沿用既有)
export function detectType(sourcePath: string): "pre" | "post" | "event-tracking" | null;
export function deriveDate(sourcePath: string): string;       // YYYY-MM-DD
export function slugify(title: string): string;
export function extractTitle(markdown: string): string;
export function extractSummary(markdown: string): string;
export function parseFrontmatter(markdown: string): Frontmatter;
export function serializeFrontmatter(meta: Frontmatter): string;
export function buildFrontmatter(draftPath: string, parsed: Frontmatter): Frontmatter;
export function resolveTargetPath(draftPath: string, date: string, slug: string): string;

// publish.ts (top-level CLI, 新增 lib-style export)
export async function publish(sourcePath: string, opts?: PublishOptions): Promise<PublishResult>;
export interface PublishOptions {
  dryRun?: boolean;
  push?: boolean;
  publishDir?: string;     // 預設 `../blog`
  author?: { name: string; email: string };
  targetBranch?: string;   // 預設 `main`
}
export interface PublishResult {
  targetPath: string;
  committed: boolean;
  pushed: boolean;
}
```

## 行為

1. 讀 source markdown
2. 解析 frontmatter(`lib/publish.ts` 既有規則)
3. 自動補 frontmatter 欄位(`title / date / summary / status / tags / investors / tickers`):
   - status 預設 `draft`(後續 blog 內 status 改 `published`)
   - tags 合併 type 對應的 tag(見下表)
   - investors 跟 tickers 從 frontmatter 同名欄位延用
4. 序列化新的 markdown(frontmatter + body)
5. 計算 target path:`blog/src/content/blog/<date>-<slug>.md`
   - 若檔案已存在 → 加 `-2`、`-3` 直到不撞
6. `--dry-run`:印出 target path 跟將寫入的完整內容,**不做任何寫入**
7. (非 dry-run):
   - 寫到 target path
   - `git add` 跟 `git commit` 在 blog repo(預設 author `alpha-lab <noreply@alpha-lab.local>`)
   - 若 `--push`:git push target branch;失敗留 local commit
8. 回 `PublishResult`

## type → tag 對應(沿用既有)

| source path | type | tag |
|---|---|---|
| `drafts/reports/<YYYY-MM-DD>-pre.md` | `pre` | `盤前報告` |
| `drafts/reports/<YYYY-MM-DD>-post.md` | `post` | `盤後報告` |
| `drafts/event-tracking/<slug>.md` | `event-tracking` | `事件追蹤` |

`tags` 跟 type tag 合併去重。

## 邊界 / 安全

- **`--push` 預設 off**(跟現在一樣)— 確保 user 先 review diff 再對外,避免 LLM 不小心把 unverified 內容推向 Cloudflare Pages 自動 deploy
- **`--dry-run` 永遠可用**,只 print 不寫任何檔
- **衝突處理**:blog repo 已有同名檔 → slug 加後綴,不覆蓋
- **commit author**:`alpha-lab <noreply@alpha-lab.local>`(避免污染 user 自己的 git history)
- **git push 失敗行為**:留 local commit,讓 user 處理 rebase(不要 force push)

## 寫到哪裡

| 對象 | 位置 | 細節 |
|---|---|---|
| 寫入 | `blog/src/content/blog/<date>-<slug>.md` | markdown with serialized frontmatter |
| Git | blog repo commit | author 為 alpha-lab bot |
| Git(可選)| blog repo push to target branch | 需要 `--push` 才做 |

## 失敗處理

| 失敗 | 怎麼處理 |
|---|---|
| 讀 source 失敗 | CLI 報錯,exit 1 |
| frontmatter 解析失敗 | CLI 報錯,exit 1 |
| target path 計算失敗(ex.日期格式壞) | CLI 報錯,exit 1 |
| 寫 target file 失敗 | CLI 報錯,exit 2;無 git commit |
| git commit 失敗 | CLI 報錯,exit 3;target file 已經寫(可能要手動清) |
| `--push` 時 push 失敗 | warning 印出;commit 留 local;exit 不算 0(讓 caller 看 warning)|

## IDEMPOTENT(對應 cross-cutting 第 2 節)

- **idempotency key**:target path(`<date>-<slug>.md`)
- **重跑語意**:`<date>-<slug>` 已存在 → 加 `-2`、`-3` 後綴;donc 同一個 draft 不會被發布到同一個檔案
- **content 變動偵測**:不會自動覆蓋已有 post;若 draft 有更新,user 要手動決定處理(目前 v2 不處理,draft 一旦發布就不變動)

## 沿用(不重設計)

- `lib/publish.ts` — frontmatter 處理純函式沿用(已有 unit tests)
- `publish.ts` — CLI + `publish()` 函式沿用;只新增 `PublishOptions`、`PublishResult` 等 export type
- blog repo 既有 Astro content collection schema 不動
- 既有 frontmatter 序列化邏輯不動
- 既有 tag 對應規則不動

## 測試要點

| 測試 | 涵蓋 |
|---|---|
| `tests/lib/publish.test.ts`(既有 245 個)| frontmatter 純函式 |
| `tests/publish-cli.test.ts`(新增)| publish() 函式各種組合(--dry-run、commit-only、commit+push、衝突) |
| fixture 整合測試 | 給 3 種 draft type,跑 publish,驗證 target file 跟 git commit author |

---

## 修改原則

- 改 frontmatter schema(新增 / 改欄位)→ 改本 spec 內 frontmatter 相關段,然後改 `lib/publish.ts` 跟 `tests/lib/publish.test.ts`,**不能 break 既有 245 個 unit tests**
- 改 tag 對應規則 → 影響 `tests/lib/publish.test.ts` 跟 blog 內容分類(若 blog astro content schema 有引用)
- 改 `--push` 預設值 → 必須 review(預設 off 是安全 net,不要默默改為 on)
- 加 publish 觸發點(dagu 內自動 push)→ 必須 review;原型階段 publish 預期全手動
