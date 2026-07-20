/**
 * 純粹的草稿發布器。
 *
 * 接收 Hermes 產出的候選 Markdown,經過嚴格驗證後原子地
 * 寫入 blog 內容目錄。本實作刻意只做檔案系統操作:
 * 沒有 Git、Dagu、網路、子行程。
  *
 *
 * 對外介面:
 *   - publishDraft(input):驗證 frontmatter、算出固定的目標路徑、
 *     寫入一個檔案,並回報目標檔是否已存在相同內容。
  *
 *   - PublishDraftInput / PublishDraftResult:伴隨的型別。
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

  // 輸入的 status 欄位刻意忽略:publisher 一律強制寫成 "unverified"。
  // archive / 文章列表的 getPublishedPosts() 只收 status != 'draft',
  // 若發布時留 draft,新文永遠不會在 archive 出現。

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
  // 轉小寫、保留 CJK Unified Ideographs 跟 '-' 跟英數字,
  // 把連續 '-' 壓成單一,去掉頭尾 '-'。
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
    // validateSources 已經先擋掉,理論上到不了這行。
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

  const forced = { ...parsed.data, status: "unverified" as const };
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

  // blogDir 必須已經含 src/content/blog;若沒有,Bun.write 會
  // 因為 parent dir 不存在而失敗。這是預期行為:Task 3 保證
  // 子目錄存在,publisher 不會自己建立。
  //
  await Bun.write(targetPath, contentBytes);
  return { action: "created", targetPath };
}

// CLI 入口。Dagu 的 `blog-publish` 子 DAG 會用以下指令叫這個 script:
//   bun run scripts/publish-draft.ts \
//     --candidate <path> --blog-dir <path> --runtime-sha <sha>
// 沒這個守門員的話,`bun run` 只會 import 模組、不跑任何程式、
// 然後 exit 0 — 靜默地丟掉 publish。
//
function parseArgs(argv: string[]): { candidate?: string; blogDir?: string; runtimeSha?: string } {
  const out: { candidate?: string; blogDir?: string; runtimeSha?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--candidate") out.candidate = argv[++i];
    else if (a === "--blog-dir") out.blogDir = argv[++i];
    else if (a === "--runtime-sha") out.runtimeSha = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log("usage: publish-draft.ts --candidate <path> --blog-dir <path> --runtime-sha <sha>");
      process.exit(0);
    } else {
      throw new PublishError(`unknown argument: ${a}`);
    }
  }
  return out;
}

if (import.meta.main) {
  (async () => {
    try {
      const args = parseArgs(process.argv.slice(2));
      if (!args.candidate || !args.blogDir || !args.runtimeSha) {
        throw new PublishError(
          "missing required flags: --candidate, --blog-dir, --runtime-sha",
        );
      }
      const result = await publishDraft({
        candidatePath: args.candidate,
        blogDir: args.blogDir,
        runtimeSha: args.runtimeSha,
      });
      // 單行機器可讀的摘要,輸出到 stdout。Dagu
      // step 會把 stdout 收下來,日誌可以確認實際動了哪個檔。
      //
      console.log(JSON.stringify({ ok: true, ...result }));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`publish-draft failed: ${message}`);
      process.exit(1);
    }
  })();
}
