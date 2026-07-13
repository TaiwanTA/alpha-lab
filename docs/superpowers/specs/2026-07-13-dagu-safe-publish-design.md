# Dagu 安全發布閉環設計

**狀態：** 已核可，待實作

## 目標

建立第一個可端到端驗收的 Dagu runtime：在 GCP VM 上手動執行固定 fixture 的 Hermes 研究，使用既有 self-hosted Hindsight 記憶，產生隱藏 draft 文章，經受限的 Dagu publisher 直接提交到 GitHub `main`，再由現有 GitHub Actions 部署到 Cloudflare Pages。

此階段要證明兩個契約：

1. Dagu 能提供 research run 的單一排程、步驟、retry 與可觀測性控制面。
2. Hermes 能直接發布文章，但 Hermes process 沒有 GitHub write 或 Cloudflare credential，且無法修改網站程式碼或 workflow。

## 範圍

### 包含

- 在 VM 運行單機 Dagu，作為 research runtime control plane。
- Dagu Web UI、scheduler、executor、run history、per-step logs、artifact 與 retry。
- `fixture-research` Dagu DAG：手動執行固定 fixture，呼叫 Hermes 與 Hindsight。
- `blog-publish` 可重用 Dagu sub-DAG：驗證 candidate Markdown、執行 Astro lint/build、以 PAT 提交單一 draft Markdown。
- GitHub `main` 保留為 Dagu YAML、prompt、fixture、publisher script 與 website content 的 source of truth。
- 現有 GitHub `deploy.yml` 保留為唯一 Cloudflare Pages deploy path。
- publisher unit tests、Dagu YAML validation、一次 production-safe end-to-end fixture run。

### 不包含

- 真實 X、新聞或網站爬蟲。
- Dagu cron、market-time schedules、queue fan-out、signal discovery 或 event research。
- 公開的 agent 文章；第一篇文章固定為 `status: draft`。
- CMS、GitHub App、GitHub Actions 作為 research scheduler、GitHub Actions artifact/outbox handoff。
- 刪除或停用既有 Vercel Workflow、systemd timer、`research/` pipeline 或 VM raw data。
- 後續正式資料來源的 schema 與 retention policy。

## 架構決策

### Control plane 邊界

| 元件 | 責任 | 不可負責 |
|---|---|---|
| GitHub | code、Dagu YAML、prompt、fixture、publisher script、blog Markdown 的 version history；CI；網站 deploy | research 排程、queue、retry、execution history
| Dagu | research execution、步驟 retry、run state、artifact、log、UI、共用 publish sub-DAG | 原始資料的 canonical storage、網站 deploy
| Hermes | 單一 research task、Hindsight retain/recall、candidate 內容 | 排程、Git push、Cloudflare deploy
| Hindsight | 研究事實與觀察的 retain/recall | raw archive、DAG state、Git history
| Dagu publisher | candidate 驗證、blog Markdown 寫入、pre-push lint/build、Git commit/push | 研究、Hindsight 存取、Cloudflare deploy
| GitHub `deploy.yml` | 由 `main` push 執行 Astro build 與 Cloudflare Pages deploy | candidate 生成、Git 寫入、VM workflow 編排

Dagu 是唯一 research runtime orchestrator。GitHub Actions 只在 `main` push 執行 CI／Cloudflare deploy；不使用 GitHub Actions `schedule`、self-hosted runner 或跨 workflow artifact 作為 runtime 編排。

### VM 拓樸

```text
GitHub main
  │  read-only Dagu definition / runtime checkout
  ▼
GCP VM: alpha-lab
  ├─ Dagu start-all
  │   ├─ Web UI: 127.0.0.1 only, accessed through SSH tunnel
  │   ├─ scheduler/executor/run history/log/artifact storage
  │   ├─ fixture-research DAG
  │   └─ blog-publish sub-DAG
  ├─ Hermes runtime
  └─ existing self-hosted Hindsight
      └─ isolated bank: alpha-lab-v3-fixture

Dagu blog-publish PAT push main
  ▼
GitHub deploy.yml
  ▼
Cloudflare Pages
```

Dagu runs as a single-machine service. Its data directory is persistent and contains control-plane run records, logs, artifacts, queue state and Dagu-managed secrets. The Dagu HTTP interface binds only to `127.0.0.1`; access is through an SSH tunnel. Dagu uses `builtin` authentication for the UI/API even though it is loopback-bound.

Hindsight remains the existing self-hosted service, but this milestone uses only bank `alpha-lab-v3-fixture`. It must not read or write the existing production bank `alpha-lab`.

### Git-driven runtime definition

- `automation/dags/` contains Dagu YAML and is pulled read-only by Dagu Git Sync.
- Every root DAG checks out a clean, read-only runtime worktree of `main` before it invokes Hermes. Prompts, fixtures, scripts and tests live in that worktree.
- If the repository is private, the Dagu Git Sync and checkout actions use a separate read-only repository credential stored in Dagu secrets. This credential cannot write GitHub.
- A Dagu run records the checked-out Git SHA in its logs and candidate metadata.
- Dagu never publishes or writes DAG definitions back to GitHub.

## File layout

```text
automation/
├─ dags/
│  ├─ fixture-research.yaml
│  └─ blog-publish.yaml
├─ fixtures/
│  └─ safe-publish.md
├─ prompts/
│  └─ fixture-research.md
├─ scripts/
│  └─ publish-draft.ts
└─ tests/
   └─ publish-draft.test.ts
```

`automation/dags/` contains orchestration only. It invokes the prompt and publisher script; it does not duplicate Hermes business logic in YAML.

## Dagu DAG contracts

### `fixture-research`

**Trigger:** Dagu UI or `dagu start fixture-research` only. No cron in this milestone.

**Inputs:** none; fixture path and Hindsight bank ID are fixed by the DAG.

**Steps:**

1. Check out the current `main` worktree at a recorded SHA.
2. Read `automation/fixtures/safe-publish.md` and `automation/prompts/fixture-research.md`.
3. Run a fresh Hermes session configured with Hindsight `local_external`, bank `alpha-lab-v3-fixture`.
4. Hermes retains the fixture facts and recalls relevant facts before drafting.
5. Hermes writes `candidate.md` to the Dagu run workspace.
6. Dagu stores an immutable copy of `candidate.md` as that run's artifact.
7. Invoke `blog-publish` as a sub-DAG, passing the candidate artifact reference and runtime SHA.

The Hermes step has no `PUBLISH_TOKEN`, Cloudflare credential or Git write credential in its environment.

If Hermes, Hindsight retain/recall, candidate generation or artifact persistence fails, `fixture-research` fails before `blog-publish` starts. Dagu preserves the failed step logs and candidate artifact when it exists.

### `blog-publish`

**Trigger:** only as a sub-DAG from a completed research run in this milestone.

**Input:** an immutable Dagu candidate artifact reference and the producing runtime SHA.

**Steps:**

1. Check out a new, clean `main` worktree dedicated to publication. It must not reuse the Hermes worktree.
2. Copy the candidate artifact into a temporary file outside the clean worktree.
3. Run `automation/scripts/publish-draft.ts` from the clean worktree.
4. The script validates the candidate and writes exactly one target file below `blog/src/content/blog/`.
5. Run `npm ci`, `npm run lint` and `npm run build` in `blog/`.
6. Verify the staged Git diff contains exactly the permitted target Markdown file.
7. Commit and push with `PUBLISH_TOKEN`.

`PUBLISH_TOKEN` is a repository-scoped fine-grained PAT with `Contents: Read and write` only. It is stored in the Dagu secret provider and injected only into the final non-agent publish step. It is never present in a Hermes process or the research DAG environment.

The PAT push triggers the existing `deploy.yml`. A repository `GITHUB_TOKEN` is not used for this push because such pushes do not trigger downstream `push` workflows.

### Candidate Markdown contract

Hermes produces Markdown with this exact frontmatter shape:

```yaml
---
title: "Fixture research title"
date: "2026-07-13"
summary: "A concise statement of the researched fixture."
status: draft
tags: ["系統驗證"]
investors: []
tickers: []
investmentClaim: false
---

正文 Markdown。

## 來源
- https://example.com/fixture-source
```

`publish-draft.ts` is the final authority, not Hermes. It must:

- require `title`, `date`, `summary`, `status`, `tags`, `investors`, `tickers` and `investmentClaim` with the types accepted by `blog/src/content.config.ts`;
- force `status` to `draft` for this milestone;
- require a non-empty `## 來源` section containing at least one valid HTTPS URL;
- derive the target slug from `date` and `title` itself;
- permit only `blog/src/content/blog/<date>-<slug>.md` as its output;
- reject `.mdx`, `import`, `export`, `<script`, and inline HTML event attributes;
- reject unknown frontmatter keys, invalid dates, malformed URLs, empty source lists and over-limit fields;
- reject a target collision with differing contents;
- return success without a Git commit if the existing target has byte-identical contents.

The generated target includes the checked-out runtime SHA in a plain Markdown provenance section, not in Astro frontmatter.

## Failure and recovery contract

| Failure | Required result |
|---|---|
| Hindsight unavailable | Hermes research step fails; `blog-publish` does not start; Dagu retains logs for retry |
| Hermes output missing or malformed | candidate validation fails; no Git write occurs |
| Candidate contains prohibited syntax | publisher fails; no Git write occurs |
| Astro lint or build fails | publisher fails before commit; candidate artifact remains in Dagu run history |
| Existing target has identical bytes | publisher succeeds without a new commit |
| Existing target differs | publisher fails and preserves both the candidate artifact and existing Git file |
| Git push rejects non-fast-forward | publisher fails; it must not force push; operator retries after resolving repository state |
| GitHub deploy fails after a successful commit | Git history remains the canonical record; do not auto-revert; investigate/revert through GitHub |

`blog-publish` may retry transient Git network errors once. It must not automatically retry validation errors, build errors or target collisions.

## Security requirements

- Dagu UI/API binds only to loopback and requires Dagu builtin authentication.
- `PUBLISH_TOKEN`, LLM credentials and Hindsight configuration remain VM secrets and never enter Git.
- `PUBLISH_TOKEN` has repository-local Contents read/write permission only.
- Hermes research subprocesses never receive `PUBLISH_TOKEN` or Cloudflare credentials.
- The publisher uses a clean runtime worktree; it never executes a script from the Hermes worktree.
- The pre-push diff assertion is mandatory and permits one new Markdown file only.
- The existing GitHub `deploy.yml` remains the only workflow with Cloudflare credentials.
- Dagu data, Hindsight persistent data and raw-data volumes require VM backup before future destructive migration work.

## Verification plan

### Unit tests

`automation/tests/publish-draft.test.ts` covers:

1. a valid candidate writes the deterministic target with forced draft status;
2. an invalid frontmatter type is rejected;
3. unknown frontmatter keys are rejected;
4. each prohibited syntax category is rejected;
5. missing/invalid source URLs are rejected;
6. an identical existing target causes no write/commit request;
7. a differing target collision is rejected;
8. the output path cannot escape `blog/src/content/blog/`.

### Dagu validation

The repository CI validates both DAG YAML files with `dagu validate`. The VM validates the synced definitions before enabling the service.

### End-to-end acceptance

1. Start `fixture-research` from the Dagu UI or CLI.
2. Observe each step and the candidate artifact in Dagu UI.
3. Confirm the isolated Hindsight bank retains and recalls fixture facts.
4. Confirm `blog-publish` is the only step receiving the publish secret.
5. Confirm `main` has exactly one additional file under `blog/src/content/blog/` and no other changed path.
6. Confirm the committed post has `status: draft`.
7. Confirm GitHub `deploy.yml` runs and Cloudflare Pages deployment succeeds.
8. Confirm the draft is absent from homepage, tag index, archive and RSS.
9. Re-run the same fixture and confirm it creates no additional Git commit.
10. Run a malformed candidate through the publisher test path and confirm `main` remains unchanged.

## Cutover boundary

This design creates a new, isolated runtime alongside the existing production pipeline. No current production service is disabled or deleted in this milestone.

A later, separate design/implementation plan may replace the legacy Vercel Workflow/systemd runtime only after this fixture loop and subsequent real-source Dagu workflows have been accepted. That cutover must explicitly enumerate every timer, service, workflow file, deployment script and data migration before any removal occurs.

## Sources

- [Dagu project documentation](https://github.com/dagu-org/dagu): single-machine `start-all`, YAML DAGs, scheduling, retries, Web UI, file-backed state and Git Sync.
- [GitHub Actions token behavior](https://docs.github.com/actions/concepts/security/github_token#when-github_token-triggers-workflow-runs): `GITHUB_TOKEN` push events do not trigger downstream push workflows.
- [Hermes Hindsight provider](https://github.com/NousResearch/hermes-agent/tree/main/plugins/memory/hindsight): external self-hosted Hindsight mode.
- [Hindsight API](https://docs.hindsight.vectorize.io/api-integration/): retain, recall and reflect operations.
