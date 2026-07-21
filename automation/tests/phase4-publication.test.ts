import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const HERE = dirname(new URL(import.meta.url).pathname);
const SCRIPT = readFileSync(join(HERE, "..", "commands", "publish-next-research.ts"), "utf8");
const MATERIALIZER = readFileSync(join(HERE, "..", "commands", "materialize-research-candidate.ts"), "utf8");
const DB = readFileSync(join(HERE, "..", "lib", "db.ts"), "utf8");
const MIGRATION = readFileSync(join(HERE, "..", "migrations", "001_phase4_event_ledger.sql"), "utf8");
const PUBLISH_DAG = readFileSync(join(HERE, "..", "dags", "publish-next-research.yaml"), "utf8");
const BLOG_DAG = readFileSync(join(HERE, "..", "dags", "blog-publish.yaml"), "utf8");

describe("publication claim state machine", () => {
  test("materializer accepts exactly the stored claim owned by this DAG run", () => {
    expect(DB).toMatch(/findPublishableById\(id: string, owner: string\)/);
    expect(DB).toMatch(/rp\.status = 'claimed'[\s\S]*?rp\.claim_owner = \$\{owner\}/);
    expect(MATERIALIZER).toMatch(/--owner/);
    expect(MATERIALIZER).toMatch(/findPublishableById\(researchRunId, claimOwner\)/);
  });

  test("live claims are exclusive and only expired leases are recoverable", () => {
    expect(MIGRATION).toMatch(/claim_owner text/);
    expect(DB).toMatch(/claimNextUnpublished\(owner: string\)/);
    expect(DB).toMatch(/claimed_at < now\(\) - interval '30 minutes'/);
    expect(DB).toMatch(/SET claim_owner = \$\{owner\}, claimed_at = now\(\)/);
    expect(SCRIPT).toMatch(/--owner/);
  });

  test("child publishes via GitHub Contents API and parent finalizes without republishing", () => {
    // 新流程 (PR 之後):blog-publish.yaml 用 github-publish.ts 走 REST API
    // 直接 PUT commit 到 main,不開分支、不開 PR。idempotency 靠
    // github-publish.ts 內部先 GET 確認檔案不存在 (或 bytes 相同 → unchanged)。
    expect(BLOG_DAG).toMatch(/id: publish_via_api/);
    expect(BLOG_DAG).toMatch(/github-publish\.ts/);
    // 不再有 git clone / git push / gh pr create
    expect(BLOG_DAG).not.toMatch(/git -C.*push/);
    expect(BLOG_DAG).not.toMatch(/gh pr create/);
    expect(BLOG_DAG).not.toMatch(/clone-publish\.ts/);
    // 父 DAG 仍用 finalize 路徑處理歷史 pushed row (claimNextPushed 保留)
    expect(DB).toMatch(/claimNextPushed/);
    expect(PUBLISH_DAG).toMatch(/ACTION=.*[\s\S]*?= finalize[\s\S]*?--mark-published/);
    expect(PUBLISH_DAG).toMatch(/if \[ "\$ACTION" = finalize \]/);
  });

  test("github-publish.ts implements idempotent GET-before-PUT and collision refusal", () => {
    const GHPUB = readFileSync(join(HERE, "..", "commands", "github-publish.ts"), "utf8");
    // 先 GET 確認狀態:200 → 比對 bytes (unchanged 或 collision);404 → 進 PUT。
    // 失敗的 200/collision 路徑是 fatal,不靜默覆寫別人手動編輯。
    expect(GHPUB).toMatch(/getRes\.status === 200/);
    expect(GHPUB).toMatch(/getRes\.status !== 404/);
    expect(GHPUB).toMatch(/target collision/);
    expect(GHPUB).toMatch(/action: "unchanged"/);
    // PUT 只到 main,不開分支不開 PR
    expect(GHPUB).toMatch(/branch: "main"/);
    expect(GHPUB).not.toMatch(/\/pulls/);
    // PUT 帶 expectedStatus 包含 422,作為 race condition idempotent retry signal
    expect(GHPUB).toMatch(/expectedStatus: \[200, 201, 422\]/);
    // 每個 GitHub API request 都有 AbortController hard timeout,不靠 DAG 兜底
    expect(GHPUB).toMatch(/AbortController/);
    expect(GHPUB).toMatch(/REQUEST_TIMEOUT_MS/);
  });
  test("post-publish failure releases claim, not leaves it in transient state", () => {
    // publish_via_api 失敗時 failure handler 必須 --release-claim,
    // 否則下次 claimNextUnpublished 拿不到這個 claimed row (因為已 insert 過)
    // 會永遠卡住。父 DAG 不該有 release-claim (子 DAG 負責自己的失敗清理)。
    expect(PUBLISH_DAG).not.toMatch(/--release-claim/);
    expect(BLOG_DAG).toMatch(/handler_on:[\s\S]*?failure:[\s\S]*?--release-claim/);
    // markPushed 仍在 db.ts 保留給未來可能的中間態流程,但 blog-publish.yaml
    // 不再用 --mark-pushed (新版沒有 git push + gh pr create 兩階段)。
    expect(DB).toMatch(/markPushed[\s\S]*?SET status = 'pushed'/);
    expect(DB).toMatch(/releasePublicationClaim[\s\S]*?status = 'claimed'/);
    expect(BLOG_DAG).not.toMatch(/--mark-pushed/);
  });
});
