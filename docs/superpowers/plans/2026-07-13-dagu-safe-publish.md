# Dagu 安全發布閉環 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不影響既有 production pipeline 的前提下，讓 Dagu 在 `alpha-lab` VM 手動執行 Hermes/Hindsight fixture research，並由受限 publisher 直接提交一篇隱藏 Astro draft 到 `main`，交由既有 GitHub deploy workflow 發布。

**Architecture:** Dagu 是唯一 research runtime orchestrator；每個 DAG 以外部 process 呼叫 fresh Hermes session，並保存 run logs、artifact 與 retry state。`fixture-research` 只產生 candidate，`blog-publish` 是唯一可取得 repository-scoped PAT 的 reusable sub-DAG；它用乾淨 checkout 驗證 candidate、建立唯一 Markdown、lint/build 後 push `main`。GitHub Actions 僅保留 CI 和既有 `main` → Cloudflare Pages deploy。

**Tech Stack:** Dagu v2.10.7、Hermes Agent、self-hosted Hindsight、Bun/TypeScript、`gray-matter`、`zod`、Astro 7、GitHub Actions、fine-grained PAT、Cloudflare Pages。

## Global Constraints

- Dagu v2.10.7；CI 必須使用 release checksum `8884a11a982bcaf675b562544b70f81a71c6cb7a7adbafe42ed2e6f6e42ece20`。
- GitHub `main` 是 DAG YAML、prompt、fixture、publisher script 與文章的 source of truth；Dagu Git Sync 必須 `push_enabled: false`。
- Dagu 是唯一 research runtime scheduler/orchestrator；不新增 GitHub Actions schedule、self-hosted runner scheduler、Vercel Workflow、systemd timer 或 Dagu 外的 retry layer。
- 只新增隔離 bank `alpha-lab-v3-fixture`；不得讀寫既有 `alpha-lab` bank。
- `PUBLISH_TOKEN` 是 repository-scoped fine-grained PAT，只有 Contents read/write；只在 `blog-publish` 最終非-agent push step 注入。
- Hermes process 永不取得 Git write credential、`PUBLISH_TOKEN`、Cloudflare token、Dagu 管理 credential。
- `blog-publish` 只可新增 `blog/src/content/blog/<date>-<slug>.md`；此次 milestone 強制 `status: draft`。
- 既有 `research/`、Vercel Workflow、systemd timers、VM raw data、Hindsight production bank 和 `blog/` 現有內容不刪除、不停用、不覆寫。
- Dagu UI/API 僅 bind `127.0.0.1`，以 builtin auth 經 SSH tunnel 存取。
- Dagu data、Hindsight data 和 raw-data volume 在日後任何 destructive cutover 前必須備份。

---

## File Structure

| Path | Responsibility |
|---|---|
| `automation/package.json` | Isolated Bun/TypeScript publisher test tooling and exact scripts. |
| `automation/tsconfig.json` | Strict TypeScript configuration for automation code. |
| `automation/fixtures/safe-publish.md` | Deterministic, offline research input. |
| `automation/prompts/fixture-research.md` | Git-versioned Hermes instruction; output is candidate Markdown only. |
| `automation/scripts/publish-draft.ts` | Pure candidate validation, deterministic target generation and idempotency logic. |
| `automation/tests/publish-draft.test.ts` | Publisher contract tests. |
| `automation/dags/fixture-research.yaml` | Dagu root DAG: checkout, Hermes, artifact, synchronous publisher child. |
| `automation/dags/blog-publish.yaml` | Dagu reusable child: clean checkout, validation, Astro gate, restricted push. |
| `automation/deploy/dagu/admin.yaml` | Loopback Dagu server, data paths, read-only Git Sync. No write secrets committed. |
| `automation/deploy/dagu/alpha-lab-dagu.service` | VM systemd service for `dagu start-all`. |
| `.github/workflows/deploy.yml` | Existing deploy workflow extended to validate automation tests and both Dagu YAML files before Pages deploy. |

---

### Task 1: Prove Dagu–Hermes Feasibility Before Publisher Work

**Files:**
- Create: `automation/fixtures/safe-publish.md`
- Create: `automation/prompts/fixture-research.md`
- Create: `automation/dags/feasibility-check.yaml`
- Create: `automation/deploy/dagu/admin.yaml`
- Create: `automation/deploy/dagu/alpha-lab-dagu.service`

**Interfaces:**
- Consumes: VM-local Hermes installation; VM-local Hindsight container; read-only Git credential when the repository is private.
- Produces: A Dagu run with captured Hermes stdout/stderr and an immutable `candidate.md` artifact, or a documented blocking incompatibility.

- [ ] **Step 1: Add an offline fixture and fixed output contract**

Create `automation/fixtures/safe-publish.md` with a non-investment fixture whose only source is a valid HTTPS URL. Create `automation/prompts/fixture-research.md` that tells Hermes to retain/recall only the fixture, output one Markdown document to `$ALPHA_LAB_CANDIDATE_PATH`, include the exact Astro frontmatter keys, use `status: draft`, set `investmentClaim: false`, and finish with `## 來源` containing the fixture URL. It must explicitly prohibit Git, Dagu, deploy, shell, and network operations beyond Hermes/Hindsight use.

- [ ] **Step 2: Install exactly Dagu v2.10.7 on the isolated VM service account**

Run on the VM after creating the non-login `alpha-lab-dagu` user and `/var/lib/alpha-lab/dagu/{data,logs,dags}`:

```bash
curl -fsSLO https://github.com/dagucloud/dagu/releases/download/v2.10.7/dagu_2.10.7_linux_amd64.tar.gz
echo '8884a11a982bcaf675b562544b70f81a71c6cb7a7adbafe42ed2e6f6e42ece20  dagu_2.10.7_linux_amd64.tar.gz' | sha256sum -c -
tar -xzf dagu_2.10.7_linux_amd64.tar.gz
sudo install -o root -g root -m 0755 dagu /usr/local/bin/dagu
dagu --version
```

Expected: version reports `2.10.7`.

- [ ] **Step 3: Configure loopback Dagu and read-only DAG sync**

Create `automation/deploy/dagu/admin.yaml` with this non-secret configuration. Install it as `/var/lib/alpha-lab/dagu/admin.yaml`; resolve `GIT_READ_TOKEN` only from Dagu's local secret provider, never from Git.

```yaml
host: "127.0.0.1"
port: 8080
paths:
  dags_dir: /var/lib/alpha-lab/dagu/dags
  data_dir: /var/lib/alpha-lab/dagu/data
  log_dir: /var/lib/alpha-lab/dagu/logs
git_sync:
  enabled: true
  repository: github.com/TaiwanTA/alpha-lab
  branch: main
  path: automation/dags
  auth:
    type: token
    token: "${secrets.GIT_READ_TOKEN}"
  auto_sync:
    enabled: true
    on_startup: true
    interval: 300
  push_enabled: false
```

Use Dagu's first-run setup only on the loopback UI to create the builtin-auth admin account. Store the bootstrap credential in the VM secret store, not in this YAML.

- [ ] **Step 4: Add a systemd service with no publish secret**

Create `automation/deploy/dagu/alpha-lab-dagu.service`:

```ini
[Unit]
Description=Alpha Lab Dagu runtime
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=alpha-lab-dagu
Group=alpha-lab-dagu
Environment=DAGU_HOME=/var/lib/alpha-lab/dagu
WorkingDirectory=/var/lib/alpha-lab/dagu
ExecStart=/usr/local/bin/dagu start-all
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/alpha-lab/dagu

[Install]
WantedBy=multi-user.target
```

Install, daemon-reload, enable and start it. Verify locally with `curl --fail http://127.0.0.1:8080/health`; verify the UI only through an SSH tunnel.

- [ ] **Step 5: Write and validate the feasibility DAG**

Create `automation/dags/feasibility-check.yaml` using only verified Dagu v2 syntax. The command must call a fresh profile and redirect final Hermes output to a candidate path while Dagu captures stdout as an artifact:

```yaml
artifacts:
  enabled: true
timeout_sec: 900
steps:
  - id: checkout
    action: git.checkout
    with:
      repository: https://github.com/TaiwanTA/alpha-lab.git
      ref: main
      path: ./workspace/app
      depth: 1
      force: true
      token: "${secrets.GIT_READ_TOKEN}"
  - id: hermes
    depends: [checkout]
    working_dir: ./workspace/app
    run: |
      set -euo pipefail
      export ALPHA_LAB_RUN_ID="${DAG_RUN_ID}"
      export ALPHA_LAB_WORKSPACE="$PWD"
      export ALPHA_LAB_CANDIDATE_PATH="$PWD/candidate.md"
      hermes -p alpha-lab-fixture -z "$(cat automation/prompts/fixture-research.md)" > "$ALPHA_LAB_CANDIDATE_PATH"
      cat "$ALPHA_LAB_CANDIDATE_PATH"
    env:
      - HINDSIGHT_BASE_URL=${secrets.HINDSIGHT_BASE_URL}
      - HINDSIGHT_BANK_ID=alpha-lab-v3-fixture
    stdout: candidate.md
    timeout_sec: 600
    retry_policy:
      limit: 1
      interval_sec: 30
      exit_code: [1]
```

> Dagu v2.10.7 verified contract:
> - DAG name is inferred from the file name; do not add `name:` at the root.
> - Step working directory uses `working_dir`, not `dir`.
> - Per-step stdout capture uses the `stdout` field; `stdout_artifact` is the older name.
> - The runtime exports `DAG_RUN_ID`, not `DAGU_RUN_ID`. Use `DAG_RUN_ID` for `ALPHA_LAB_RUN_ID`.

Run `dagu validate automation/dags/feasibility-check.yaml` locally and on the VM after sync.

- [ ] **Step 6: Run the hard feasibility gate**

Start `dagu start feasibility-check`, then inspect the Dagu UI and Hindsight bank. Expected: one fresh Hermes session exits zero, `candidate.md` is readable as an artifact, stdout/stderr are visible, and a recall query against `alpha-lab-v3-fixture` returns fixture facts.

If any of these conditions fails, stop. Record the observed Dagu/Hermes/Hindsight constraint in the design spec and implementation plan. Do not implement publisher files, a second orchestrator, or a compatibility shim.

- [ ] **Step 7: Commit the feasibility slice**

```bash
git add automation/fixtures automation/prompts automation/dags/feasibility-check.yaml automation/deploy/dagu
git commit -m "feat: add Dagu Hermes feasibility runtime"
```

---

### Task 2: Build the Pure, Test-Driven Draft Publisher

**Files:**
- Create: `automation/package.json`
- Create: `automation/tsconfig.json`
- Create: `automation/scripts/publish-draft.ts`
- Create: `automation/tests/publish-draft.test.ts`

**Interfaces:**
- Consumes: `candidatePath: string`, `blogDir: string`, `runtimeSha: string`.
- Produces: `Promise<{ action: "created" | "unchanged"; targetPath: string }>`.
- Errors: malformed candidate, unsafe body, invalid sources, target collision, path escape.

- [ ] **Step 1: Create the isolated Bun package**

```json
{
  "name": "alpha-lab-automation",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "publish-draft": "bun run scripts/publish-draft.ts"
  },
  "dependencies": {
    "gray-matter": "^4.0.3",
    "zod": "^3.24.2"
  },
  "devDependencies": {
    "@types/bun": "latest",
    "typescript": "^5.7.0"
  }
}
```

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  "include": ["scripts/**/*.ts", "tests/**/*.ts"]
}
```

Run `cd automation && bun install`.

- [ ] **Step 2: Write failing publisher contract tests**

Cover these exact test cases before implementation:

```ts
expect(await publishDraft(validInput)).toMatchObject({ action: "created" });
expect(await readText(target)).toContain("status: draft");
await expect(publishDraft(withUnknownFrontmatter)).rejects.toThrow("unknown frontmatter key");
await expect(publishDraft(withScriptTag)).rejects.toThrow("prohibited Markdown syntax");
await expect(publishDraft(withMissingSource)).rejects.toThrow("來源");
await expect(publishDraft(withPathTraversalTitle)).rejects.toThrow("target path");
expect(await publishDraft(existingIdentical)).toMatchObject({ action: "unchanged" });
await expect(publishDraft(existingDifferent)).rejects.toThrow("target collision");
```

Run `cd automation && bun test tests/publish-draft.test.ts`; expected initial failure: module/function absent.

- [ ] **Step 3: Implement `publishDraft` as a pure filesystem operation**

Export exactly:

```ts
export type PublishDraftInput = {
  candidatePath: string;
  blogDir: string;
  runtimeSha: string;
};

export type PublishDraftResult = {
  action: "created" | "unchanged";
  targetPath: string;
};

export async function publishDraft(input: PublishDraftInput): Promise<PublishDraftResult>;
```

Implementation rules:

- Parse candidate frontmatter with `gray-matter` and validate exactly the Astro collection keys with `zod`.
- Reject every key outside `title`, `date`, `summary`, `status`, `tags`, `investors`, `tickers`, `investmentClaim`.
- Require a real `## 來源` heading and at least one `https://` URL below it.
- Reject body lines beginning with `import` or `export`, case-insensitive `<script`, and HTML event attributes matching `/\son[a-z]+\s*=/i`.
- Force `status: "draft"`; derive slug from normalised `date-title`; reject an empty slug or any target outside `path.join(blogDir, "src/content/blog")`.
- Append `<!-- alpha-lab runtime: ${runtimeSha} -->` after the source section.
- Compare bytes if target exists; return `unchanged` for equality, otherwise throw target collision.
- Write exactly one new `.md` file with `Bun.write`; never execute Git commands.

- [ ] **Step 4: Run focused verification**

```bash
cd automation
bun test tests/publish-draft.test.ts
bun run typecheck
```

Expected: all listed contracts pass.

- [ ] **Step 5: Commit the publisher slice**

```bash
git add automation/package.json automation/bun.lock automation/tsconfig.json automation/scripts automation/tests
git commit -m "feat: add validated draft publisher"
```

---

### Task 3: Replace the Feasibility DAG with Root and Publisher DAGs

**Files:**
- Create: `automation/dags/fixture-research.yaml`
- Create: `automation/dags/blog-publish.yaml`
- Delete: `automation/dags/feasibility-check.yaml`
- Modify: `automation/prompts/fixture-research.md`

**Interfaces:**
- `fixture-research` consumes no params and produces immutable `candidate.md` plus `runtime_sha`.
- `blog-publish` consumes `candidate_ref` and `runtime_sha`; it invokes `automation/scripts/publish-draft.ts` in a clean checkout and may push exactly one file.

- [ ] **Step 1: Write the root DAG after Task 1 has proved the artifact-reference syntax**

Task 1 must record the exact Dagu v2 artifact read/reference semantics in the design document before this task begins. Use that observed reference as `candidate_ref`, and use the recorded `git rev-parse HEAD` value as `runtime_sha`. Do not guess a cross-DAG artifact path or an undocumented Dagu output expression. The root DAG must retain the verified checkout/Hermes steps, persist `candidate.md`, and synchronously call `blog-publish` using `action: dag.run` with only those two parameters.

Keep only orchestration in YAML. The prompt remains in `automation/prompts/fixture-research.md`; no prompt text is copied into a DAG.

- [ ] **Step 2: Write the reusable `blog-publish` sub-DAG**

The child DAG must:

1. create a clean worktree through `action: git.checkout` at `main` using `GIT_READ_TOKEN`;
2. materialize `candidate_ref` outside the clean worktree using the verified Task 1 artifact read mechanism;
3. execute `cd automation && bun run publish-draft -- --candidate "$CANDIDATE" --blog-dir "$WORKTREE/blog" --runtime-sha "${params.runtime_sha}"`;
4. run `npm ci`, `npm run lint`, and `npm run build` under `$WORKTREE/blog`;
5. assert `git diff --cached --name-only` equals exactly one `blog/src/content/blog/*.md` path;
6. inject `PUBLISH_TOKEN` only into the final `git commit`/`git push` step; use `git push origin HEAD:main`, never force push;
7. retry only exit code 1 network failures once; leave validation, build, collision and non-fast-forward failures unretried.

- [ ] **Step 3: Validate both final DAGs and delete the proof DAG**

```bash
dagu validate automation/dags/fixture-research.yaml
dagu validate automation/dags/blog-publish.yaml
git rm automation/dags/feasibility-check.yaml
```

Expected: both validation commands report valid specs. The deletion happens only after the root/child path has passed the same manual fixture run.

- [ ] **Step 4: Run the local publisher boundary tests again**

```bash
cd automation
bun test tests/publish-draft.test.ts
bun run typecheck
```

Expected: no Dagu configuration change weakens publisher validation.

- [ ] **Step 5: Commit the final DAG contract**

```bash
git add automation/dags automation/prompts
git commit -m "feat: add Dagu fixture publish DAGs"
```

---

### Task 4: Add CI Validation Without Making GitHub a Runtime Orchestrator

**Files:**
- Modify: `.github/workflows/deploy.yml`

**Interfaces:**
- Consumes: every push to `main`.
- Produces: a failed GitHub run before Cloudflare deployment when automation tests, TypeScript, or Dagu schema validation fail.
- Does not schedule, invoke or publish Dagu research.

- [ ] **Step 1: Add a failing CI path for malformed Dagu YAML**

Add a `validate-automation` job before the existing Pages job. Pin Dagu's exact release and checksum:

```yaml
validate-automation:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
    - name: Install automation dependencies
      working-directory: automation
      run: bun install --frozen-lockfile
    - name: Test and typecheck automation
      working-directory: automation
      run: |
        bun test
        bun run typecheck
    - name: Install Dagu v2.10.7
      run: |
        curl -fsSL https://github.com/dagucloud/dagu/releases/download/v2.10.7/dagu_2.10.7_linux_amd64.tar.gz -o /tmp/dagu.tar.gz
        echo '8884a11a982bcaf675b562544b70f81a71c6cb7a7adbafe42ed2e6f6e42ece20  /tmp/dagu.tar.gz' | sha256sum -c -
        tar -xzf /tmp/dagu.tar.gz -C /tmp
        sudo install /tmp/dagu /usr/local/bin/dagu
    - name: Validate Dagu definitions
      run: |
        dagu validate automation/dags/fixture-research.yaml
        dagu validate automation/dags/blog-publish.yaml
```

Make the existing deployment job depend on this job:

```yaml
needs: validate-automation
```

- [ ] **Step 2: Prove CI rejects invalid DAG YAML**

Temporarily change a known step dependency in a local branch to an unknown ID. Expected: `dagu validate` fails before the Pages deployment job starts. Restore the valid YAML before committing.

- [ ] **Step 3: Commit CI guardrail**

```bash
git add .github/workflows/deploy.yml automation/bun.lock
git commit -m "ci: validate Dagu automation definitions"
```

---

### Task 5: Configure Secrets and Perform the Production-Safe End-to-End Run

**Files:**
- Modify: VM-local Dagu secret store only; never commit secret values.
- Modify: `docs/superpowers/specs/2026-07-13-dagu-safe-publish-design.md` only if Task 1 found a documented integration constraint.

**Interfaces:**
- Consumes: deployed Dagu DAG definitions, isolated Hermes profile, Hindsight bank, and a repository-scoped PAT.
- Produces: exactly one hidden draft post in `main`, a successful existing Cloudflare deploy run, and Dagu run evidence.

- [ ] **Step 1: Provision least-privilege VM secrets**

Provision:

| Secret | Consumer | Permission / purpose |
|---|---|---|
| `GIT_READ_TOKEN` | Dagu Git Sync and checkout steps | Read-only access to this repository |
| `HINDSIGHT_BASE_URL` | Hermes research step | VM-local self-hosted Hindsight endpoint |
| LLM provider credentials | Hermes research step | Existing model invocation only |
| `PUBLISH_TOKEN` | `blog-publish` final push step only | Fine-grained repository Contents read/write |

Confirm with Dagu run environment inspection that the Hermes step cannot resolve `PUBLISH_TOKEN`, and that the publisher step cannot resolve LLM or Hindsight secrets.

- [ ] **Step 2: Configure the isolated Hermes profile**

As `alpha-lab-dagu`, configure profile `alpha-lab-fixture` through `hermes memory setup`:

- provider: `hindsight`;
- mode: `local_external`;
- bank: `alpha-lab-v3-fixture`;
- automatic retain and recall: enabled.

Run a one-shot local prompt and a recall query before any Dagu publish run. Expected: the bank stores and retrieves a fixture fact; the existing `alpha-lab` bank remains unchanged.

- [ ] **Step 3: Execute the manual fixture root DAG**

```bash
sudo -u alpha-lab-dagu DAGU_HOME=/var/lib/alpha-lab/dagu dagu start fixture-research
```

Expected Dagu evidence: checkout, Hermes, artifact, child publisher, lint/build and push each have independent status plus stdout/stderr. A failed publisher must leave the candidate artifact and permit a publisher-only rerun.

- [ ] **Step 4: Verify GitHub and public-site contracts**

Verify all of the following:

1. `main` contains exactly one additional `blog/src/content/blog/*.md` file.
2. The post frontmatter is `status: draft`; its body contains the runtime SHA provenance comment.
3. The PAT commit triggered existing `Deploy to Cloudflare Pages` successfully.
4. Homepage, tag index, archive and RSS omit the draft.
5. Re-running `fixture-research` with identical fixture creates no second Git commit.
6. Replacing candidate body with `<script>` fails before `git push`; `main` stays unchanged.

- [ ] **Step 5: Commit only intentional repository evidence**

Commit the final source changes if they were not committed in earlier tasks. Do not commit VM secrets, Dagu data, logs, artifacts, Hermes state or generated hidden candidate files outside the single verified blog draft.

---

## Plan Self-Review

- **Spec coverage:** Tasks 1–5 cover Dagu single-node runtime, loopback UI, Git-driven definitions, Hermes/Hindsight process boundary, isolated bank, clean publisher worktree, step-scoped PAT, AST/frontmatter validation, Dagu artifacts/retry, CI validation, existing GitHub deploy and end-to-end draft visibility/idempotency checks.
- **Feasibility gate:** Task 1 is explicitly blocking. The only permitted response to a failed Dagu–Hermes contract is to update the design and this plan before publisher implementation.
- **No legacy cutover:** No task deletes, disables or replaces current Workflow/systemd services; the separate cutover design remains future work.
- **Placeholder scan:** No unowned future implementation is hidden in this plan. The Task 1 artifact-reference observation is deliberately a blocking, measured interface because Dagu/Hermes execution feasibility was explicitly accepted as uncertain by the user.
