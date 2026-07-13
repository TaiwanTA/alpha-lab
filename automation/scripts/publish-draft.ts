/**
 * Pure draft publisher.
 *
 * Takes a candidate Markdown file produced by Hermes and atomically
 * publishes it to the blog content directory after a strict validation
 * pass. The implementation is intentionally restricted to filesystem
 * operations: no Git, no Dagu, no network, no child processes.
 *
 * Public surface:
 *   - publishDraft(input): validates, derives a deterministic target
 *     path, writes exactly one file, and reports whether the target
 *     already contained identical bytes.
 *   - PublishDraftInput / PublishDraftResult: companion types.
 */

import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import matter from "gray-matter";

export type PublishDraftInput = {
  candidatePath: string;
  blogDir: string;
  runtimeSha: string;
};

export type PublishDraftResult = {
  action: "created" | "unchanged";
  targetPath: string;
};

const ALLOWED_KEY: Record<string, true> = {
  title: true,
  date: true,
  summary: true,
  status: true,
  tags: true,
  investors: true,
  tickers: true,
  investmentClaim: true,
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCRIPT_TAG = /<script/i;
const LINE_IMPORT_OR_EXPORT = /^(?:import|export)\s/i;
const HTML_EVENT_ATTR = /\bon[a-z]+\s*=/i;
const HTTPS_URL = /^https:\/\//;
const SOURCE_HEADING = /^##\s*來源\s*$/;

class PublishError extends Error {}

function validateFrontmatter(data: Record<string, unknown>): void {
  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEY[key]) {
      throw new PublishError(`unknown frontmatter key: ${key}`);
    }
  }

  const title = data.title;
  if (typeof title !== "string" || title.length === 0 || title.length > 200) {
    throw new PublishError("frontmatter.title must be a non-empty string ≤ 200 chars");
  }

  const date = data.date;
  if (typeof date !== "string" || !ISO_DATE.test(date)) {
    throw new PublishError(
      `frontmatter.date must be a strict YYYY-MM-DD string (got ${JSON.stringify(date)})`,
    );
  }

  const summary = data.summary;
  if (typeof summary !== "string" || summary.length === 0 || summary.length > 500) {
    throw new PublishError("frontmatter.summary must be a non-empty string ≤ 500 chars");
  }

  // status is intentionally ignored on input: the publisher always forces "draft".

  for (const name of ["tags", "investors", "tickers"] as const) {
    const v = data[name];
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
      throw new PublishError(`frontmatter.${name} must be an array of strings`);
    }
  }

  if (typeof data.investmentClaim !== "boolean") {
    throw new PublishError("frontmatter.investmentClaim must be a boolean");
  }
}

function validateBody(body: string): void {
  if (body.trim().length === 0) {
    throw new PublishError("body must not be empty");
  }
  for (const line of body.split(/\r?\n/)) {
    if (LINE_IMPORT_OR_EXPORT.test(line)) {
      throw new PublishError(
        `prohibited Markdown syntax: line begins with import/export: ${line.trim()}`,
      );
    }
    if (SCRIPT_TAG.test(line)) {
      throw new PublishError(`prohibited Markdown syntax: <script tag found: ${line.trim()}`);
    }
    if (HTML_EVENT_ATTR.test(line)) {
      throw new PublishError(
        `prohibited Markdown syntax: HTML event attribute found: ${line.trim()}`,
      );
    }
  }
}

function validateSources(body: string): void {
  const lines = body.split(/\r?\n/);
  const sourceIdx = lines.findIndex((l) => SOURCE_HEADING.test(l));
  if (sourceIdx === -1) {
    throw new PublishError("body must contain a '## 來源' section");
  }
  const tail = lines.slice(sourceIdx + 1);
  const hasHttpsListItem = tail.some((line) => {
    const m = line.match(/^[\s\-\*]*(\S+)/);
    if (!m) return false;
    const token = m[1];
    if (!HTTPS_URL.test(token)) return false;
    try {
      return new URL(token).protocol === "https:";
    } catch {
      return false;
    }
  });
  if (!hasHttpsListItem) {
    throw new PublishError("## 來源 must contain at least one https:// list item URL");
  }
}

function slugifyTitle(title: string): string {
  if (title.includes("..") || title.includes("/") || title.includes("\\")) {
    throw new PublishError(`title contains path-traversal characters: ${JSON.stringify(title)}`);
  }
  // Lowercase, keep CJK Unified Ideographs and '-' alongside alphanumerics,
  // collapse runs of '-', trim leading/trailing '-'.
  const cleaned = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) {
    throw new PublishError(`title slugifies to empty string: ${JSON.stringify(title)}`);
  }
  return cleaned;
}

function deriveTargetPath(blogDir: string, date: string, title: string): string {
  const slug = slugifyTitle(title);
  if (slug.includes("..") || slug.includes("/") || slug.includes("\\")) {
    throw new PublishError(`title slug contains path-traversal characters: ${slug}`);
  }
  const target = resolve(blogDir, "src", "content", "blog", `${date}-${slug}.md`);
  const allowedRoot = resolve(blogDir, "src", "content", "blog");
  const withSep = allowedRoot.endsWith(sep) ? allowedRoot : allowedRoot + sep;
  if (!(target === allowedRoot || target.startsWith(withSep))) {
    throw new PublishError(`target path escapes blog/src/content/blog/: ${target}`);
  }
  return target;
}

function appendRuntimeSha(body: string, runtimeSha: string): string {
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex((l) => SOURCE_HEADING.test(l));
  if (idx === -1) {
    // validateSources guarantees this branch is unreachable.
    throw new PublishError("internal: source section vanished before SHA insertion");
  }
  lines.splice(idx + 1, 0, "", `<!-- alpha-lab runtime: ${runtimeSha} -->`);
  return lines.join("\n");
}

export async function publishDraft(input: PublishDraftInput): Promise<PublishDraftResult> {
  const { candidatePath, blogDir, runtimeSha } = input;
  const parsed = matter(readFileSync(candidatePath, "utf8"));

  validateFrontmatter(parsed.data);
  validateBody(parsed.content);
  validateSources(parsed.content);

  const date = parsed.data.date as string;
  const title = parsed.data.title as string;
  const targetPath = deriveTargetPath(blogDir, date, title);

  const forced = { ...parsed.data, status: "draft" as const };
  const bodyWithSha = appendRuntimeSha(parsed.content, runtimeSha);
  const content = matter.stringify(bodyWithSha, forced as never);

  const contentBytes = Buffer.from(content, "utf8");
  const targetFile = Bun.file(targetPath);
  if (await targetFile.exists()) {
    const existingBytes = Buffer.from(await targetFile.arrayBuffer());
    if (Buffer.compare(existingBytes, contentBytes) === 0) {
      return { action: "unchanged", targetPath };
    }
    throw new PublishError(
      `target collision with differing bytes at ${targetPath}; refusing to overwrite`,
    );
  }

  // The blogDir must contain src/content/blog; if it doesn't, Bun.write will
  // fail because the parent directory does not exist. That is the intended
  // behavior: Task 3 guarantees the subtree exists, and the publisher never
  // creates it.
  await Bun.write(targetPath, contentBytes);
  return { action: "created", targetPath };
}
