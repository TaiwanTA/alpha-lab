# α-lab v3 rebuild — VM acceptance report

**Branch:** `rebuild/integrate`
**Date:** 2026-07-13
**Status:** Partial — Dagu runtime + DAG structure + isolation invariant verified; hermes + publish steps have known gaps.

## 1. Local validation (passes)

On the local workstation, in worktree `alpha-lab-integrate`:

- `bun test` → **13/13 pass** (publisher contract tests)
- `bunx tsc --noEmit` → **exit 0**
- `dagu validate automation/dags/fixture-research.yaml` → **exit 0**
- `dagu validate automation/dags/blog-publish.yaml` → **exit 0**
- `dagu dry automation/dags/fixture-research.yaml` → 5 steps succeeded, Result Succeeded
- `dagu dry automation/dags/blog-publish.yaml` → 6 succeeded + 3 skipped (precondition-based skip, normal), Result Succeeded, EXIT 0

## 2. VM deployment (succeeds)

On `alpha-lab` (asia-east1-b, g6online-352310):

### 2.1 Dagu runtime

- Dagu v2.10.7 binary installed at `/usr/local/bin/dagu` (SHA-256 from v2.10.7 release, exit 0)
- Service account `alpha-lab-dagu` (uid 999, gid 982) created with home `/var/lib/alpha-lab/dagu/`, shell `/bin/bash` (changed from `/usr/sbin/nologin` so Dagu run-step shells can spawn)
- `/var/lib/alpha-lab/dagu/{dags,data,logs,workspace/app,workspace/publish}/` created, owner `alpha-lab-dagu:alpha-lab-dagu`, mode 0750
- `/etc/systemd/system/alpha-lab-dagu.service` installed from `automation/deploy/dagu/alpha-lab-dagu.service`; `EnvironmentFile=/etc/alpha-lab/dagu.env` patched in; `systemctl daemon-reload` + `enable --now` succeed
- `systemctl is-active alpha-lab-dagu` → **active** (running, Main PID, 32.8M resident)
- `curl http://127.0.0.1:8080/health` → HTTP 200 (HTML bundle), `/api/v1/dags` → HTTP 401 (admin auth, expected)

### 2.2 Dagu admin config

- `admin.yaml` deployed to `/var/lib/alpha-lab/dagu/admin.yaml`, owner `alpha-lab-dagu:alpha-lab-dagu`, mode 0640
- `dags_dir=/var/lib/alpha-lab/dagu/dags`, `data_dir=/var/lib/alpha-lab/dagu/data`, `log_dir=/var/lib/alpha-lab/dagu/logs`
- `git_sync.repository=github.com/TaiwanTA/alpha-lab`, `branch=main`, `path=automation/dags`, `auth.type=token`
- `git_sync` is currently redundant because main has no DAG YAMLs yet; the rebuild branches have them. Step 7.5 of the playbook covers the manual `cp` bridge.

### 2.3 DAG YAMLs

- `fixture-research.yaml` and `blog-publish.yaml` deployed to `/var/lib/alpha-lab/dagu/dags/`
- `sudo -u alpha-lab-dagu dagu validate` on both → exit 0
- `sudo -u alpha-lab-dagu dagu dry fixture-research.yaml` → 5 steps succeeded

### 2.4 Secrets env file

- `/etc/alpha-lab/dagu.env` (sourced by systemd EnvironmentFile) contains:
  - `HINDSIGHT_BASE_URL=http://127.0.0.1:8888`
  - `NAME=alpha-lab`
  - `GIT_READ_TOKEN=github_pat_11B...` (user-provided fine-grained PAT, Contents: Read-only)
  - `HINDSIGHT_API_KEY` and `PUBLISH_TOKEN` left empty pending later milestones
- File owner `root:alpha-lab-dagu`, mode **0440** (changed from 0400 so the dagu user can source it from run-step shells)

### 2.5 Hindsight dependency (recovered)

- The Hindsight container was failing on boot after VM reset because its OpenRouter key had been revoked upstream
- New key supplied by user, `sed -i` on `/opt/hermes/hindsight/.env`, container recreated via `docker compose up -d`
- Hindsight is now healthy; `GET /v1/default/banks` returns 200 with `alpha-lab` bank present (0 facts)
- New container name is `hindsight-hindsight-1` instead of `hermes-hindsight-1` because the compose project name differs, but the API endpoint at `127.0.0.1:8888` is unchanged so downstream is unaffected

## 3. Fixture end-to-end run

`sudo -u alpha-lab-dagu dagu start /var/lib/alpha-lab/dagu/dags/fixture-research.yaml` result:

| Step | Status | Note |
|---|---|---|
| checkout | **succeeded** | git clone of `TaiwanTA/alpha-lab` main via x-access-token PAT in URL, depth 1 |
| record_runtime_sha | **succeeded** | `git rev-parse HEAD` = `334b2c52c7a45801c4d5fe00bc1891035fdda0ec` |
| record_workdir | **succeeded** | `pwd` = dagu per-run work dir |
| hermes | **failed** | `hermes: command not found` + `cat: automation/prompts/fixture-research.md: No such file or directory` |
| publish | aborted | depends on hermes |

3 of 5 steps pass; the remaining two are blocked on the same gap.

## 4. Isolation invariant (verified)

After fixture end-to-end:

- `GET /v1/default/banks` → banks `hermes` (693 facts, unchanged) and `alpha-lab` (0 facts, unchanged)
- `GET /v1/default/banks/alpha-lab/memories/list?limit=0` → `total=0` (no retain happened)
- `GET /v1/default/banks/alpha-lab-v3-fixture/memories/list?limit=0` → 404 (bank never created; hermes didn't run)

The production `alpha-lab` bank was not touched. Isolation invariant holds.

## 5. Known gaps

1. **hermes step** uses `hermes -p alpha-lab-fixture -z "..."` as a system binary. The deployed hermes (`nousresearch/hermes-agent` on port 8642) is an HTTP gateway, not a CLI. Playbook Step 7 was deferred and is now a design gap.
2. **prompts in main** — `automation/prompts/fixture-research.md` exists only on the `rebuild/integrate` branch, not on `main`. The hermes step's `cat automation/prompts/fixture-research.md` fails when the checkout ref is `main`.
3. **PUBLISH_TOKEN** — the `blog-publish` sub-DAG's push step needs a fine-grained PAT with Contents: Read+write. Not provided yet.
4. **Dagu service was reset** during the session to recover from a stuck sshd after a `sudo tee` heredoc froze a pipe. Existing services (`alpha-lab-workflow`, `alpha-lab-postgres`, `hindsight-db`, `mastra-app`) all came back up automatically; the only manual recovery was the Hindsight OpenRouter key rotation and Dagu unit + admin.yaml + dags cp.
5. **Dagu env propagation** — Dagu 2.10.7 does not propagate process env to `run:` step shells, so the wrapper script sources `/etc/alpha-lab/dagu.env` directly. This is documented in `automation/scripts/clone-fixture.sh`.

## 6. Commit chain on `rebuild/integrate`

- `1b1edf0` task-1: Dagu-Hermes feasibility runtime
- `f85767e` task-1: gitignore + plan alignment
- `ceba172` task-1: Dagu YAML v2.10.7 strict bindings
- `4a7d2fe` task-1: `${secrets.X}` warning in plan
- `1db22ef` task-2: pure draft publisher
- `0c36e70` task-3: fixture-research + blog-publish DAGs
- `7662cf9` task-4: validate-automation CI job
- `6890f34` task-5: VM playbook
- `063b8dc` task-5: Hindsight v0.8.4 endpoint alignment
- `3390769` task-5: Hindsight auth header policy
- `a58ab49` task-5: manual cp step for DAG YAMLs
- `e04ea0a` merge commit onto integrate
- `668ba54` post-deploy fix: wrapper script for git checkout

## 7. Next milestone (not in this run)

- Define hermes invocation: either as `docker exec hermes-hermes-1 <cli>` once a CLI is installed inside the gateway image, or as an HTTP call against the gateway, or as a sidecar to the existing `hermes-hermes-1` container.
- Either move `automation/prompts/fixture-research.md` to main, or keep the fixture pinned to `rebuild/integrate` (current YAML uses `ref: main`).
- Provision `PUBLISH_TOKEN`, restart dagu, re-run the full sub-DAG end-to-end.
- After merges land on main, remove the Step 7.5 manual cp bridge and let git_sync own the DAG lifecycle.
