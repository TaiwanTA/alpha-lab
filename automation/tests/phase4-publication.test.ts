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

  test("child records pushed state and parent finalizes without republishing", () => {
    expect(BLOG_DAG).toMatch(/id: push_and_mark/);
    expect(BLOG_DAG).toMatch(/--mark-pushed[\s\S]*?git -C[\s\S]*?push/);
    expect(BLOG_DAG).toMatch(/push[\s\S]*?--revert-pushed/);
    expect(DB).toMatch(/claimNextPushed/);
    expect(PUBLISH_DAG).toMatch(/ACTION=.*[\s\S]*?= finalize[\s\S]*?--mark-published/);
    expect(PUBLISH_DAG).toMatch(/if \[ "\$ACTION" = finalize \]/);
  });

  test("post-push failure cannot trigger transient claimed cleanup", () => {
    expect(PUBLISH_DAG).not.toMatch(/--release-claim/);
    expect(BLOG_DAG).toMatch(/handler_on:[\s\S]*?failure:[\s\S]*?--release-claim/);
    expect(DB).toMatch(/markPushed[\s\S]*?SET status = 'pushed'/);
    expect(DB).toMatch(/releasePublicationClaim[\s\S]*?status = 'claimed'/);
    expect(BLOG_DAG.indexOf("--mark-pushed")).toBeLessThan(BLOG_DAG.indexOf('push "git@github.com'));
  });
});
