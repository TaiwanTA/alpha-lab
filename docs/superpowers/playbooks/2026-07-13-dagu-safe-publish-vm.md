# Dagu 安全發布閉環 — VM 端部署與驗收 Playbook

**對應計畫：** `docs/superpowers/plans/2026-07-13-dagu-safe-publish.md` §Task 5
**對應設計：** `docs/superpowers/specs/2026-07-13-dagu-safe-publish-design.md`
**目標 commit 鏈：**

- Task 1：`1b1edf0 + f85767e + ceba172 + 4a7d2fe` (`rebuild/task-1-dagu-feasibility`)
- Task 2：`1db22ef` (`rebuild/task-2-publisher`)
- Task 3：`0c36e70` (`rebuild/task-3-dags`)
- Task 4：`7662cf9` (`rebuild/task-4-ci`)
- Task 5（playbook）：本檔

> 本 playbook 由 user（VM 持有者）執行；非 VM 端的程式碼修補已由前 4 個 task 完成。
> 任何步驟失敗 → 停下、回頭看對應 commit、補設計後再開新 task。

## 0. 前置檢查

```bash
# VM 上沒有任何「自動化 runtime」目錄（Dagu 還沒建）
test ! -d /var/lib/alpha-lab && echo "clean slate: ok" || echo "WARNING: /var/lib/alpha-lab already exists"

# 確認 git 已裝、SSH 通暢
git --version
gh auth status

# 確認 Docker 跑著（既有 Postgres / Hindsight 容器）
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}' | head
```

預期：看到 `alpha-lab-postgres` 與 `hermes-hindsight-1` 兩個既有容器，`alpha-lab` 容器不在。

## 1. 部署程式碼到 VM

```bash
cd /home/joker/projects/alpha-lab
git fetch origin
git checkout rebuild/task-4-ci
git pull --ff-only
```

預期：HEAD = `7662cf9`。若有衝突或 fast-forward 失敗，**停下**——commit 鏈已被破壞。

## 2. 建立 Dagu service account 與目錄

```bash
sudo useradd --system --shell /usr/sbin/nologin --create-home --home-dir /var/lib/alpha-lab alpha-lab-dagu
sudo mkdir -p /var/lib/alpha-lab/dagu/{data,logs,dags,workspace}
sudo chown -R alpha-lab-dagu:alpha-lab-dagu /var/lib/alpha-lab/dagu
```

預期：service account `alpha-lab-dagu` 是 non-login，home 為 `/var/lib/alpha-lab`。

## 3. 安裝 Dagu v2.10.7（pinned）

```bash
cd /tmp
curl -fsSLO https://github.com/dagucloud/dagu/releases/download/v2.10.7/dagu_2.10.7_linux_amd64.tar.gz
echo '8884a11a982bcaf675b562544b70f81a71c6cb7a7adbafe42ed2e6f6e42ece20  dagu_2.10.7_linux_amd64.tar.gz' | sha256sum -c -
sudo tar -xzf dagu_2.10.7_linux_amd64.tar.gz -C /usr/local/bin dagu
sudo chmod 0755 /usr/local/bin/dagu
dagu version   # 預期: 2.10.7
```

## 4. 安裝 automation systemd unit

```bash
sudo cp /home/joker/projects/alpha-lab/automation/deploy/dagu/alpha-lab-dagu.service /etc/systemd/system/
sudo systemctl daemon-reload
```

確認 service 檔內 `User=`、`Environment=`、`ExecStart=`：

```bash
grep -E '^(User|Environment|ExecStart)=' /etc/systemd/system/alpha-lab-dagu.service
```

預期輸出：

```
User=alpha-lab-dagu
Environment=DAGU_HOME=/var/lib/alpha-lab/dagu
ExecStart=/usr/local/bin/dagu start-all
```

> 註：此 service file 在 commit `4a7d2fe` 內已是 hardcoded `User=alpha-lab-dagu`，**無** `__PUBLISH_USER__` placeholder。

## 5. 部署 Dagu admin config

```bash
sudo mkdir -p /var/lib/alpha-lab/dagu
sudo cp /home/joker/projects/alpha-lab/automation/deploy/dagu/admin.yaml /var/lib/alpha-lab/dagu/admin.yaml
sudo chown alpha-lab-dagu:alpha-lab-dagu /var/lib/alpha-lab/dagu/admin.yaml
sudo chmod 0600 /var/lib/alpha-lab/dagu/admin.yaml
```

`admin.yaml` 內 `git_sync` 引用 `${env.GIT_READ_TOKEN}`；env 變數必須在 Dagu process 啟動時存在。

## 6. 注入 secret 環境變數

**只允許放在 root-only env file**，systemd unit 還沒宣告 `EnvironmentFile=`，**手動 patch unit**：

```bash
sudo systemctl edit alpha-lab-dagu
```

開啟 editor，在空檔內貼：

```ini
[Service]
EnvironmentFile=/etc/alpha-lab/dagu.env
```

儲存後：

```bash
sudo mkdir -p /etc/alpha-lab
sudo touch /etc/alpha-lab/dagu.env
sudo chmod 0600 /etc/alpha-lab/dagu.env
sudo chown root:root /etc/alpha-lab/dagu.env
sudo tee /etc/alpha-lab/dagu.env <<'EOF'
GIT_READ_TOKEN=<fine-grained-PAT-with-Contents-read>
HINDSIGHT_BASE_URL=http://127.0.0.1:8888
HINDSIGHT_API_KEY=<hindsight-bearer>
PUBLISH_TOKEN=<fine-grained-PAT-with-Contents-read+write>
EOF
sudo chmod 0400 /etc/alpha-lab/dagu.env
```

**GIT_READ_TOKEN 與 PUBLISH_TOKEN 是兩個不同的 fine-grained PAT**：

- `GIT_READ_TOKEN`：repository-scoped，`Contents: Read-only`。
- `PUBLISH_TOKEN`：repository-scoped，`Contents: Read and write`。

預期：file owner `root:root`、perm `0400`。**絕不**把任何 token 寫進 git。

> **已知取捨：** 三組 secret 全部由 `EnvironmentFile=` 注入 Dagu server process，**所有** `run:` step 都能在 shell 內讀到（process env 繼承）。目前唯一真正取用 `PUBLISH_TOKEN` 的 step 是 `blog-publish` 的 `push`，其他 step 不會主動讀取，所以是局部收斂的。但若未來要在受限模型行為之外做額外隔離，下一步可以改用 Dagu step-level secret provider 或在 step 內用一行 `env: PUBLISH_TOKEN=...` 限制範圍。

## 7. 安裝 hermes 給 `alpha-lab-dagu` 可執行

如果 hermes 是用 bun 裝在 `joker` user 的 `~/.bun/bin/hermes`，`alpha-lab-dagu` 預設沒讀權。**兩種做法擇一**：

```bash
# 做法 A（推薦）：把 hermes 與所需 binary 暴露成 world-readable + executable
# 預期: hermes 自身是 ELF 或 bun launcher；需要看實際 owner
ls -la /home/joker/.bun/bin/hermes 2>/dev/null || ls -la /home/joker/.local/bin/hermes
sudo chmod -R o+rX /home/joker/.bun/bin /home/joker/.bun/registry 2>/dev/null || true
sudo chmod -R o+rX /home/joker/.local/bin /home/joker/.local/share 2>/dev/null || true

# 做法 B：把 hermes 與整個 bun 工具鏈系統級安裝到 /usr/local
sudo cp /home/joker/.bun/bin/hermes /usr/local/bin/hermes
sudo chmod 0755 /usr/local/bin/hermes
```

> 做法 B 較乾淨：hermes binary 脫離 user home，所有 system user 都能用，且不再依賴 `/home/joker/.bun/` 的權限。**推薦做法 B**。若 hermes 是 bun launcher（殼層 script），需連 `~/.bun/bin/bun` 一起複製並把 `#!/usr/bin/env bun` 改成 `#!$(command -v bun)`，或直接安裝 hermes 為系統套件（如果 Hindsight plugin 已有 standalone binary）。

驗證 `alpha-lab-dagu` 真的能跑 hermes：

```bash
sudo -u alpha-lab-dagu -H /usr/local/bin/hermes --version
```

預期：版本字串，非 `Permission denied` 或 `command not found`。

## 7.5. 把 DAG YAML 放到 Dagu 的 dags 目錄

> **依賴：** Step 6 已把 `GIT_READ_TOKEN` 注入 `/etc/alpha-lab/dagu.env`。Dagu 啟動時會用這個 token 做 `git_sync` 拉 `main`，但**本步驟不靠 git_sync**——直接 cp 檔案進 Dagu 的 `dags_dir`，跳過 git_sync 找不到 main 分支空集合的問題。`blog-publish.yaml` 內的 `git.checkout` 步驟在執行 DAG 時（不是啟動 Dagu 時）才用 `GIT_READ_TOKEN`，那時 token 已在 process env。

`automation/dags/*.yaml` 目前只在 `rebuild/task-3-dags` 與後續 `rebuild/task-5-vm` 分支上，**不在** `main`。`admin.yaml` 的 `git_sync` 從 `main` 拉，會找不到 DAG → Dagu UI 列表是空的。

**這個 milestone 不要 merge rebuild 分支到 main**（先發後驗風險）。改用**手動 cp** 進 Dagu 的 dags 目錄，讓 Dagu 直接讀檔、跳過 git_sync：

```bash
sudo mkdir -p /var/lib/alpha-lab/dagu/dags
sudo cp /home/joker/projects/alpha-lab/automation/dags/fixture-research.yaml /var/lib/alpha-lab/dagu/dags/
sudo cp /home/joker/projects/alpha-lab/automation/dags/blog-publish.yaml /var/lib/alpha-lab/dagu/dags/
sudo chown -R alpha-lab-dagu:alpha-lab-dagu /var/lib/alpha-lab/dagu/dags
sudo -u alpha-lab-dagu dagu validate /var/lib/alpha-lab/dagu/dags/fixture-research.yaml
sudo -u alpha-lab-dagu dagu validate /var/lib/alpha-lab/dagu/dags/blog-publish.yaml
```

預期：兩條 `dagu validate` 都 exit 0。

> **重跑時**：若你在 `rebuild/*` 分支上重新 checkout 或 pull 程式碼，再次跑這段 cp 指令把最新 YAML 同步到 Dagu 的 dags 目錄。**不需要**重啟 systemd unit（Dagu 會在每次 `dagu start` 時讀檔）。
>
> **未來 cutover**：當所有 task 都被合併到 `main`、且 `automation/dags/*.yaml` 在 `main` 內後，刪除這步 cp、刪除 `dags/` 內手動放的檔，git_sync 會自己從 `main` 拉到。

## 9. 啟動 Dagu service

```bash
sudo systemctl enable --now alpha-lab-dagu
sudo systemctl status alpha-lab-dagu --no-pager
curl --fail http://127.0.0.1:8080/health
```

預期：status `active (running)`、`/health` 回 `{"status":"ok",...}`。

若 `/health` 失敗：

```bash
sudo journalctl -u alpha-lab-dagu -n 50 --no-pager
```

常見原因：env file 路徑錯、token 含特殊字元需 quotes、Dagu 嘗試 git_sync 401。

## 10. 初始化 Dagu admin 帳號（首次）

Dagu bind 在 `127.0.0.1:8080`，需 SSH tunnel 看 UI：

```bash
# 在 local 端
ssh -L 8080:127.0.0.1:8080 alpha-lab
```

瀏覽 `http://127.0.0.1:8080/setup`，建立 admin 帳號。**admin 密碼存進 VM secret store**，不要 commit。

Dagu Git Sync 啟動後會每 5 分鐘 sync `automation/dags/*` 進 `/var/lib/alpha-lab/dagu/dags/`。等第一次 sync 完（看 UI 的 DAGs 列表）才進下一步。

## 11. 配置 Hermes profile `alpha-lab-fixture`

`alpha-lab-dagu` 是 system user（shell `/usr/sbin/nologin`），不能直接互動式 `hermes memory setup`；且 hermes binary 來自 root 安裝到 `/usr/local/bin/`，需要明確加入 PATH。**用一次性指令替代互動式 wizard**：

```bash
# alpha-lab-dagu 的 home 是 /var/lib/alpha-lab；hermes 不在它的預設 PATH
# 我們安裝在 /usr/local/bin/hermes，對所有 user 可見，但仍需 export PATH 確認

sudo -u alpha-lab-dagu -H bash -c '
  export PATH=/usr/local/bin:$PATH
  hermes memory setup \
    --provider hindsight \
    --mode local_external \
    --bank alpha-lab-v3-fixture \
    --auto-retain \
    --auto-recall
'
```

> 若 `hermes memory setup` 還沒實作 non-interactive flags（不同版本差異），改用配置檔寫入：

```bash
sudo -u alpha-lab-dagu -H bash -c '
  mkdir -p ~/.hermes
  cat > ~/.hermes/profiles/alpha-lab-fixture.yaml <<EOF
provider: hindsight
mode: local_external
bank: alpha-lab-v3-fixture
auto_retain: true
auto_recall: true
EOF
  chmod 0600 ~/.hermes/profiles/alpha-lab-fixture.yaml
'
```

驗證 profile 已被讀：

驗證：

```bash
sudo -u alpha-lab-dagu -H bash -lc 'hermes -p alpha-lab-fixture memory list'
```

預期：列出 bank `alpha-lab-v3-fixture` 為 active profile 的 backing store。

若 `hermes memory list` 找不到 bank，**先建 bank**：

```bash
# Hindsight v0.8.x: bank create is a PUT upsert; bank_id is in the path.
# Bearer token: 用 playbook Step 6 注入的 HINDSIGHT_API_KEY (或 self-hosted 未設時省略)
curl -fsS -X PUT "http://127.0.0.1:8888/v1/default/banks/alpha-lab-v3-fixture" \
  -H "Authorization: Bearer ${HINDSIGHT_API_KEY:-x}" \
  -H 'Content-Type: application/json' \
  -d '{
    "retain_mission": "Extract only facts explicitly stated in the fixture Markdown; do not infer; do not read or write the production bank alpha-lab.",
    "retain_extraction_mode": "concise",
    "enable_observations": false
  }'
```

預期：HTTP 200 + `bank_id: "alpha-lab-v3-fixture"`。**Self-hosted 是否需要 `Authorization` header** 取決於 Hindsight container 啟動設定（環境變數 `HINDSIGHT_API_KEY` 或類似的 auth provider）。若有開，必須把 `${HINDSIGHT_API_KEY:-x}` 換成實際 bearer token；若沒開，移除 `Authorization` 標頭即可。

## 12. （可選）預先驗證 Hindsight bank 行為

> **Auth header 假設：** 下方所有 Hindsight `curl` 都預設 self-hosted 未開 bearer auth。如果你的 `hermes-hindsight-1` 啟動時設了 `HINDSIGHT_API_KEY` 或其他 auth provider，**每條 curl 都要加** `-H "Authorization: Bearer $HINDSIGHT_API_KEY"`。

```bash
# 由 Hindsight container 端查; v0.8.x banks 列表透過 /v1/default/banks
docker exec hermes-hindsight-1 sh -c 'curl -s http://127.0.0.1:8888/v1/default/banks | jq'
```

預期：`alpha-lab-v3-fixture` 存在、`alpha-lab` 仍存在且未變更。

`alpha-lab` bank 的 baseline `.total` 記下來（`alpha-lab-total-before.json`）；Dagu run 完成後再查一次，**必須**仍是同一個數字：

```bash
curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab/memories/list?limit=0' | jq '.total' > /tmp/alpha-lab-total-before.json
```

`alpha-lab-v3-fixture` 跑完後應有 > 0 筆 retain 記錄（Hindsight v0.8.x：list memory units path）：

```bash
curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab-v3-fixture/memories/list?limit=0' | jq '.total'
```

預期：> 0。若想看具體 facts：

```bash
curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab-v3-fixture/memories/list?limit=10' | jq '.items[] | {id, type, text, mentioned_at: .date}'
```

預期：list 內含 fixture retain；`type` 為 `world`、`experience` 或 `observation`；`text` 引用 fixture 內容。

## 13. 啟動 fixture-research DAG

```bash
sudo -u alpha-lab-dagu -H bash -lc 'DAGU_HOME=/var/lib/alpha-lab/dagu dagu start fixture-research'
```

預期：Dagu UI 顯示 `fixture-research` run 為 `running` → 切到 `succeeded`。

**預期總耗時**：第一次跑 1-3 分鐘（包含 `git clone`、Hermes session、Astro `npm ci` + `npm run lint` + `npm run build`）。

> Root 與 sub-DAG 的 checkout 已經分開：root 落 `/var/lib/alpha-lab/dagu/workspace/app/`，sub 落 `/var/lib/alpha-lab/dagu/workspace/publish/`。兩者不會競爭同一個 dirty state，也不會誤刪對方的 candidate。

若失敗：

```bash
sudo journalctl -u alpha-lab-dagu -n 200 --no-pager
# 或開 Dagu UI /runs 找 run id，看 stdout/stderr
```

最常見失敗模式：
- Dagu 嘗試 git sync 401：GIT_READ_TOKEN 權限錯。
- Hermes profile 找不到：`hermes memory setup` 沒跑。
- Hindsight 不可用：HINDSIGHT_BASE_URL 寫錯（注意 127.0.0.1 對 Dagu process 是 host loopback，不是 container loopback）。
- Publisher 拒絕：candidate 不符合 frontmatter 規則；Dagu UI 的 `hermes` step 的 stdout artifact 會保留 `candidate.md` 供查。

## 15. 端到端驗收清單

Dagu run 顯示 `succeeded` 後，逐條核對：

- [ ] `git log origin/main -1 --name-only` 顯示**只**有一個新檔 `blog/src/content/blog/<date>-<slug>.md`，沒有其他路徑被改。
- [ ] 新檔 frontmatter 內 `status: draft`。
- [ ] 新檔 body 出現 `<!-- alpha-lab runtime: <sha> -->` 在 `## 來源` 之後。
- [ ] GitHub 上的 `Deploy to Cloudflare Pages` workflow 顯示新的 green run（由 `PUBLISH_TOKEN` push 觸發）。
- [ ] Cloudflare Pages deployment 顯示新 commit。
- [ ] `https://alpha-lab.pages.dev/` 首頁**不**列出此文章。
- [ ] `https://alpha-lab.pages.dev/tags/` 不含此文章 tag。
- [ ] `https://alpha-lab.pages.dev/feed.xml` 不含此文章。
- [ ] 重跑 `dagu start fixture-research`，**不**產生第二個 git commit（`git log origin/main` 仍只有那一次）。
- [ ] Hindsight `alpha-lab-v3-fixture` bank 至少 1 筆 retain 記錄：

  ```bash
  curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab-v3-fixture/memories/list?limit=0' | jq '.total'
  ```

  預期：> 0。
- [ ] Hindsight `alpha-lab` production bank `.total` 與 baseline 相同：

  ```bash
  # 跑 Dagu 前先取 baseline
  curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab/memories/list?limit=0' | jq '.total' > /tmp/alpha-lab-total-before.json
  # 跑 Dagu 後再取一次，比較兩者
  curl -fsS 'http://127.0.0.1:8888/v1/default/banks/alpha-lab/memories/list?limit=0' | jq '.total'
  cat /tmp/alpha-lab-total-before.json
  ```

  預期：兩個數字相等（rebuild 不得污染 production bank）。
- [ ] 把 `candidate.md` 換成含 `<script>` 的版本，再跑，**不**產生新 commit（publisher 拒絕）；Dagu UI 的 publish step 顯示 `failed`。

## 16. 失敗時的回退

- **Dagu process 卡住**：`sudo systemctl restart alpha-lab-dagu`。
- **VM 端 secret 疑慮**：`sudo chmod 0400 /etc/alpha-lab/dagu.env`、重讀 unit `sudo systemctl daemon-reload`。
- **Dagu run 留垃圾**：`/var/lib/alpha-lab/dagu/data/dag-runs/<dag>/<run-id>/` 是 isolated workspace；用 `dagu history --cleanup` 清理。
- **main 上多了不該有的 commit**：`git revert <sha>`，把 Dagu run 標記 failed 後不重跑。

## 17. 後續（不在本 playbook 範圍）

- 用真實 X、新聞、網站來源替換 fixture。
- 啟用 GitHub `schedule` 觸發 Dagu sub-DAG（Task 5 之外）。
- 把既有的 Vercel Workflow / systemd timers 切換到 Dagu（需要單獨的 cutover 設計）。
- Phase 4：投資人清單決定 + 模擬下注 + 反思校準。

## 附錄：對應的 commit 與路徑

| 任務 | commit | 路徑 |
|---|---|---|
| Task 1（feasibility runtime） | `1b1edf0`, `f85767e`, `ceba172`, `4a7d2fe` | `automation/{dags,fixtures,prompts,deploy}/` |
| Task 2（pure publisher） | `1db22ef` | `automation/{scripts,tests}/`, `automation/{package,tsconfig}.json`, `automation/bun.lock` |
| Task 3（root + sub-DAG） | `0c36e70` | `automation/dags/{fixture-research,blog-publish}.yaml` |
| Task 4（CI guard） | `7662cf9` | `.github/workflows/deploy.yml` |
| Task 5（本 playbook） | 由 user 執行 | `docs/superpowers/playbooks/2026-07-13-dagu-safe-publish-vm.md` |

> 任何 commit 改動：plan 與 spec 也得在同 PR 修。Playbook 不自動更新。
