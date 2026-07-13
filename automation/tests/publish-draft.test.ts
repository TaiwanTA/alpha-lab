import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import matter from "gray-matter";

import { publishDraft } from "../scripts/publish-draft.ts";

// Each test owns its own scratch directory and its own blogDir with the
// required src/content/blog subtree, so no state leaks between tests.

function makeScratch(label: string): {
  root: string;
  candidatePath: string;
  blogDir: string;
} {
  const root = mkdtempSync(join(tmpdir(), `publish-draft-${label}-`));
  const blogDir = join(root, "blog");
  const contentDir = join(blogDir, "src", "content", "blog");
  mkdirSync(contentDir, { recursive: true });
  const candidatePath = join(root, "candidate.md");
  return { root, candidatePath, blogDir };
}

function baseFrontmatter(overrides: Record<string, unknown> = {}): string {
  const fm = {
    title: "Sample title",
    date: "2026-07-13",
    summary: "A short summary.",
    status: "unverified",
    tags: ["alpha", "beta"],
    investors: ["Alice"],
    tickers: ["AAPL"],
    investmentClaim: false,
    ...overrides,
  };
  // Use gray-matter's stringify to guarantee valid YAML the publisher can re-parse.
  return matter.stringify("", fm as never);
}


describe("publishDraft", () => {
  test("valid candidate writes the deterministic target with forced draft status", async () => {
    const { root, candidatePath, blogDir } = makeScratch("valid");
    const candidate = baseFrontmatter({ status: "unverified" }) +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);

    const result = await publishDraft({ candidatePath, blogDir, runtimeSha: "deadbeef" });
    expect(result.action).toBe("created");
    const expectedSlug = "sample-title";
    const targetPath = join(blogDir, "src/content/blog/2026-07-13-sample-title.md");
    expect(result.targetPath).toBe(targetPath);
    expect(existsSync(targetPath)).toBe(true);
    const written = readFileSync(targetPath, "utf8");
    expect(written).toContain("status: draft");
    expect(written).not.toContain("status: unverified");

    rmSync(root, { recursive: true, force: true });
  });

  test("invalid frontmatter type is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("bad-date");
    const candidate = baseFrontmatter({ date: "not-a-date" }) +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow();
    rmSync(root, { recursive: true, force: true });
  });

  test("unknown frontmatter key is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("unknown-key");
    const candidate = baseFrontmatter({ randomKey: 1 }) +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/randomKey/);
    rmSync(root, { recursive: true, force: true });
  });

  test("prohibited Markdown syntax: <script is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("script");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n\n<script>alert(1)</script>\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/<script/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("prohibited Markdown syntax: import at line start is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("import");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n\nimport foo from 'bar'\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/line begins with import\/export/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("prohibited Markdown syntax: onload= event attribute is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("onload");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n\n<img src=x onload=alert(1)>\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/\bon[a-z]+\s*=/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("missing source section is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("no-source");
    const candidate = baseFrontmatter() + "No source section here.\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/來源/);
    rmSync(root, { recursive: true, force: true });
  });

  test("invalid source URL (http://, not https://) is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("http-url");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- http://example.com/article\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/https/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("identical existing target causes no write", async () => {
    const { root, candidatePath, blogDir } = makeScratch("unchanged");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);

    // First call creates the file; capture the bytes that would be written.
    const first = await publishDraft({ candidatePath, blogDir, runtimeSha: "cafe" });
    expect(first.action).toBe("created");
    const targetPath = first.targetPath;
    const expectedBytes = readFileSync(targetPath);

    // Second call must report unchanged and not rewrite.
    const second = await publishDraft({ candidatePath, blogDir, runtimeSha: "cafe" });
    expect(second.action).toBe("unchanged");
    expect(second.targetPath).toBe(targetPath);
    const afterBytes = readFileSync(targetPath);
    expect(Buffer.compare(expectedBytes, afterBytes)).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  test("differing target collision is rejected", async () => {
    const { root, candidatePath, blogDir } = makeScratch("collision");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);

    const first = await publishDraft({ candidatePath, blogDir, runtimeSha: "cafe" });
    expect(first.action).toBe("created");
    const targetPath = first.targetPath;

    // Mangle the existing target so the next call sees differing bytes.
    writeFileSync(targetPath, "different content\n");

    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "cafe" })).rejects.toThrow(/target collision/i);
    // The publisher must NOT have overwritten the mangled file.
    expect(readFileSync(targetPath, "utf8")).toBe("different content\n");

    rmSync(root, { recursive: true, force: true });
  });

  test("output path cannot escape blog/src/content/blog/", async () => {
    const { root, candidatePath, blogDir } = makeScratch("escape");
    const candidate = baseFrontmatter({ title: "../../etc/passwd" }) +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/escape|traversal|invalid slug/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("runtime SHA appears as a Markdown comment after the source section", async () => {
    const { root, candidatePath, blogDir } = makeScratch("sha");
    const candidate = baseFrontmatter() +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);

    const result = await publishDraft({ candidatePath, blogDir, runtimeSha: "abc123" });
    const written = readFileSync(result.targetPath, "utf8");
    const sourceIdx = written.indexOf("## 來源");
    expect(sourceIdx).toBeGreaterThanOrEqual(0);
    const commentIdx = written.indexOf("<!-- alpha-lab runtime: abc123 -->");
    expect(commentIdx).toBeGreaterThan(sourceIdx);
    // Must NOT be inside frontmatter
    const fmEnd = written.indexOf("---", written.indexOf("---") + 3);
    expect(commentIdx).toBeGreaterThan(fmEnd);

    rmSync(root, { recursive: true, force: true });
  });

  test("frontmatter date is normalized: strict YYYY-MM-DD only", async () => {
    const { root, candidatePath, blogDir } = makeScratch("bad-date-format");
    const candidate = baseFrontmatter({ date: "2026-7-3" }) +
      "## 來源\n\n- https://example.com/article\n";
    writeFileSync(candidatePath, candidate);
    await expect(publishDraft({ candidatePath, blogDir, runtimeSha: "x" })).rejects.toThrow(/YYYY-MM-DD|date/i);
    rmSync(root, { recursive: true, force: true });
  });
});