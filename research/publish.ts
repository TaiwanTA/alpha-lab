// publish.ts — 把 research/drafts/ 內的 markdown 發布到 blog。
//
// CLI 用法:
//   bun run publish.ts <source.md> [--push] [--dry-run]
//
// 設計(見 research/AGENTS.md「Blog 發布」段;spec 出處 Step 8+9):
//   - --push 預設 false:commit local 但不推;user review 後手動 push(或之後走另一條流程)
//   - --dry-run:不寫檔、不 commit,只印 target path 與 frontmatter 預覽
//   - lib/publish.ts 提供純函式(本檔只負責 IO + git + CLI arg parsing)
//
// 雙介面:
//   - CLI:`if (import.meta.main)` 跑 main()
//   - lib:export `publish(sourcePath, opts)`,workflow 之後要直接呼叫可用
//     (workflow 接線本身不在本次 PR 範圍,見 spec「workflow 整合」段)

import { readFile, stat, writeFile, mkdir as mkdirAsync } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  resolve as resolvePath,
  join as joinPath,
  relative as relativePath,
  dirname,
  isAbsolute as pathIsAbsolute,
} from "node:path";
// path.isAbsolute 對 Windows UNC (\\server\share) 跟 drive (C:\) 都會正確回 true
// 跨平台路徑偵測:不要自己 regex 檢查(Kilo PR #11 + Gemini high priority:
// /home/... startsWith("/") + /^[A-Za-z]:[\\/]/ 漏 UNC \\server\share,
// Windows 上 lastIndexOf("/") 切 dirname 也錯)。改用 node:path 內建 API。
import { spawnSync } from "node:child_process";
import {
  detectType,
  deriveDate,
  buildFrontmatter,
  resolveTargetPath,
  serializeFrontmatter,
  type ReportType,
} from "./lib/publish.ts";
import { createLogger } from "./lib/logger.ts";

const log = createLogger("publish");

const DEFAULT_AUTHOR_NAME = "alpha-lab";
const DEFAULT_AUTHOR_EMAIL = "noreply@alpha-lab.local";
// 預設:`../blog`(相對於 research/)→ monorepo 內的 blog/。SPEC 對齊。
const DEFAULT_BLOG_DIR = "../blog";

export interface PublishOptions {
  push?: boolean;
  dryRun?: boolean;
  cwd?: string;        // monorepo root(覆寫 process.cwd())
  blogDir?: string;    // 覆寫 env PUBLISH_BLOG_DIR
}

export interface PublishResult {
  type: ReportType;
  sourcePath: string;       // 絕對路徑(輸入)
  targetPath: string;       // 絕對路徑(blog post)
  targetRelPath: string;    // monorepo root 相對路徑(給 git commit 訊息用)
  date: string;
  title: string;
  slug: string;
  tags: string[];
  status: string;
  commitHash: string | null;
  pushed: boolean;
  dryRun: boolean;
}

// 主 entry function:給 CLI 與未來 workflow 雙用
//
// 流程:
//   1. resolve source 絕對路徑、讀檔、mtime
//   2. detectType(根據 path)
//   3. deriveDate(從檔名或 mtime)
//   4. resolve blogDir(env PUBLISH_BLOG_DIR,絕對值化)
//   5. buildFrontmatter(synthesize fm、slug)
//   6. resolveTargetPath(處理碰撞)
//   7. 寫檔(unless dryRun)
//   8. git add + commit(unless dryRun)
//   9. 若 --push:true → git push origin main(失敗清楚報)
export async function publish(
  sourcePath: string,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const cwd = opts.cwd ?? process.cwd();
  // 用 node:path.isAbsolute 做跨平台絕對路徑偵測(POSIX / Windows drive / UNC)
  const monorepoRoot = cwd;
  const absSource = pathIsAbsolute(sourcePath)
    ? sourcePath
    : joinPath(cwd, sourcePath);

  if (!existsSync(absSource)) {
    throw new Error(`source not found: ${absSource}`);
  }
  const sourceStat = await stat(absSource);
  if (!sourceStat.isFile()) {
    throw new Error(`source is not a regular file: ${absSource}`);
  }
  const sourceRaw = await readFile(absSource, "utf-8");

  const type = detectType(absSource);
  if (type === null) {
    throw new Error(
      `cannot detect report type from source path: ${absSource}\n` +
        `expected path pattern: drafts/reports/<date>-pre.md | drafts/reports/<date>-post.md | drafts/event-tracking/<slug>.md`,
    );
  }

  const date = deriveDate(absSource, type, sourceStat.mtime);
  const blogDirRaw = opts.blogDir ?? process.env["PUBLISH_BLOG_DIR"] ?? DEFAULT_BLOG_DIR;
  const blogDir = pathIsAbsolute(blogDirRaw)
    ? blogDirRaw
    : resolvePath(monorepoRoot, blogDirRaw);

  const built = buildFrontmatter({
    raw: sourceRaw,
    type,
    date,
  });
  const targetAbsPath = resolveTargetPath(blogDir, date, built.slug);
  const targetRelPath = relativePath(monorepoRoot, targetAbsPath);

  const fmText = serializeFrontmatter(built.frontmatter);
  const bodyTrimmed = built.body.replace(/^\r?\n/, "");
  const composed = fmText + bodyTrimmed;

  const dryRun = opts.dryRun === true;
  const push = opts.push === true;

  if (dryRun) {
    log
      .withMetadata({
        type,
        source: sourcePath,
        target: targetRelPath,
        tags: built.frontmatter["tags"],
        date,
        slug: built.slug,
        title: built.frontmatter["title"],
      })
      .info("dry-run preview (not written, not committed)");
    // dry-run 仍印完整 composed 內容給 user review(在 main 印到 stdout)
    console.log("--- BEGIN COMPOSED ---");
    console.log(composed);
    console.log("--- END COMPOSED ---");
    return {
      type,
      sourcePath: absSource,
      targetPath: targetAbsPath,
      targetRelPath,
      date,
      title: built.frontmatter["title"] as string,
      slug: built.slug,
      tags: built.frontmatter["tags"] as string[],
      status: built.frontmatter["status"] as string,
      commitHash: null,
      pushed: false,
      dryRun: true,
    };
  }

  // 7. 寫檔
  // 用 dirname() 跨平台(POSIX / 跟 Windows \ 都能正確)(Kilo PR #11 WARNING:
  // lastIndexOf("/") 在 Windows 切到整個 path 當 dir 會臭)
  const targetDir = dirname(targetAbsPath);
  await mkdirAsync(targetDir, { recursive: true });
  await writeFile(targetAbsPath, composed, "utf-8");
  log.withMetadata({ target: targetRelPath }).info("target written");

  // 8. git add + commit
  const authorName = process.env["PUBLISH_AUTHOR_NAME"] ?? DEFAULT_AUTHOR_NAME;
  const authorEmail = process.env["PUBLISH_AUTHOR_EMAIL"] ?? DEFAULT_AUTHOR_EMAIL;
  const gitEnv: Record<string, string> = {
    ...process.env,
    GIT_AUTHOR_NAME: authorName,
    GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName,
    GIT_COMMITTER_EMAIL: authorEmail,
  };

  runGit(["add", "--", targetRelPath], monorepoRoot, gitEnv);
  const commitMsg = `blog: publish ${type} ${date}-${built.slug}`;
  runGit(["commit", "-m", commitMsg], monorepoRoot, gitEnv);
  const commitHash = readGitHead(monorepoRoot);
  log
    .withMetadata({
      commit: commitHash?.slice(0, 7),
      target: targetRelPath,
    })
    .info("committed");

  // 9. push (opt-in)
  let pushed = false;
  if (push) {
    const branch = process.env["PUBLISH_TARGET_BRANCH"] ?? "main";
    const pushResult = runGit(["push", "origin", branch], monorepoRoot, gitEnv, /*allowFail*/ true);
    if (pushResult.ok) {
      pushed = true;
      log.withMetadata({ branch }).info("pushed");
    } else {
      // 區分:spawn fail(git 不在 PATH / SIGKILL)vs 非 0 exit(remote ahead / 認證 / 網路)
      // (Kilo PR #11 iter 2:訊息分開,給 operator 對的排查方向)
      const isSpawnFail = pushResult.spawnError !== null && pushResult.spawnError !== undefined;
      if (isSpawnFail) {
        log
          .withMetadata({
            branch,
            spawnError: pushResult.spawnError,
          })
          .warn(
            "git push failed to spawn — local commit preserved. " +
              "Likely `git` binary missing from PATH (install git or fix PATH).",
          );
      } else {
        log
          .withMetadata({
            branch,
            stderr: pushResult.stderr,
            stdout: pushResult.stdout,
          })
          .warn(
            "git push failed — local commit preserved. " +
              `Manually inspect remote and push (e.g. \`git push origin ${branch}\` or ` +
              `\`git pull --rebase origin ${branch} && git push origin ${branch}\` if remote is ahead).`,
          );
      }
    }
  }

  return {
    type,
    sourcePath: absSource,
    targetPath: targetAbsPath,
    targetRelPath,
    date,
    title: built.frontmatter["title"] as string,
    slug: built.slug,
    tags: built.frontmatter["tags"] as string[],
    status: built.frontmatter["status"] as string,
    commitHash,
    pushed,
    dryRun: false,
  };
}

// ---- 內部 git helper ----

// 加區分:spawn fail(ENOENT git 不存在 / SIGKILL)vs remote ahead
// 兩種情況訊息不同(Kilo PR #11 iter 2 + Gemini):
//   - spawn fail:打出 spawn error 訊息 + 提示「確保 git 在 PATH」
//   - 非 0 exit:remote ahead / 無權限 / 網路 — 提示用戶手動 inspect
interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  spawnError?: string | null;  // spawn 失敗原因(no binary / SIGKILL 等)
}

function runGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  allowFail: boolean = false,
): GitResult {
  const result = spawnSync("git", args, {
    cwd,
    env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  // git binary 本身失敗(ENOENT=git 不存在 / SIGKILL=OOM kill 等等)
  // result.status 是 null 而非 0(Kilo PR #11 Gemini medium priority)
  if (result.error) {
    const msg = result.error.message;
    if (!allowFail) {
      throw new Error(
        `git ${args.join(" ")} failed to spawn: ${msg}`,
      );
    }
    return {
      ok: false,
      stdout: "",
      stderr: msg,
      spawnError: msg,
    };
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `git ${args.join(" ")} failed (exit=${result.status})\nstdout: ${stdout}\nstderr: ${stderr}`,
    );
  }
  return {
    ok: result.status === 0,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
    spawnError: null,
  };
}

function readGitHead(cwd: string): string | null {
  const r = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) return null;
  return (r.stdout ?? "").trim() || null;
}

// ---- CLI ----

interface ParsedArgs {
  sourcePath: string | null;
  push: boolean;
  dryRun: boolean;
}

function parseCliArgs(argv: readonly string[]): ParsedArgs {
  let sourcePath: string | null = null;
  let push = false;
  let dryRun = false;
  let seenSeparator = false;
  for (const arg of argv) {
    // -- separator:之後所有 args 都當位置參數(Kilo PR #11 SUGGESTION:
    // 不然路徑剛好以 `--` 開頭(罕見但可能)會被當 unknown flag)
    if (!seenSeparator && arg === "--") {
      seenSeparator = true;
      continue;
    }
    if (!seenSeparator) {
      if (arg === "--push") {
        push = true;
        continue;
      }
      if (arg === "--dry-run") {
        dryRun = true;
        continue;
      }
      if (arg === "--help" || arg === "-h") {
        printHelp();
        process.exit(0);
      }
      if (arg.startsWith("--")) {
        throw new Error(`unknown flag: ${arg}`);
      }
    }
    if (sourcePath !== null) {
      throw new Error(`multiple source paths given; only one allowed`);
    }
    sourcePath = arg;
  }
  return { sourcePath, push, dryRun };
}

function printHelp(): void {
  console.log(`Usage: bun run publish.ts <source.md> [--push] [--dry-run]

Publishes a draft report from research/drafts/ to blog/src/content/blog/ as a
self-contained Astro content collection entry. Self-contained = all
frontmatter fields (title/date/summary/status/tags/investors/tickers) are
synthesized by publish.ts; the source draft is preserved unchanged.

Tag mapping (per ADR-001 "實體:報告"):
  drafts/reports/<date>-pre.md           → tag  "盤前報告"
  drafts/reports/<date>-post.md          → tag  "盤後報告"
  drafts/event-tracking/<slug>.md        → tag  "事件追蹤"

Safety:
  --push     default OFF  → only commit local; user reviews diff and pushes
                            manually, OR a separate review workflow handles it
  --dry-run               → write nothing, commit nothing; print preview

Environment overrides:
  PUBLISH_BLOG_DIR       target dir relative to monorepo root (default ../blog)
  PUBLISH_AUTHOR_NAME    git author name  (default alpha-lab)
  PUBLISH_AUTHOR_EMAIL   git author email (default noreply@alpha-lab.local)
  PUBLISH_TARGET_BRANCH  push target branch (default main)

Examples:
  bun run publish.ts drafts/reports/2026-07-09-pre.md
  bun run publish.ts drafts/event-tracking/ackman-nvda-abc123def.md --dry-run
  bun run publish.ts drafts/reports/2026-07-09-post.md --push
`);
}

async function main(): Promise<void> {
  let parsed: ParsedArgs;
  try {
    parsed = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    log.withError(err).error("argument parse failed");
    printHelp();
    process.exit(2);
  }
  if (parsed.sourcePath === null) {
    log.error("missing required argument: <source.md>");
    printHelp();
    process.exit(2);
  }

  try {
    const result = await publish(parsed.sourcePath, {
      push: parsed.push,
      dryRun: parsed.dryRun,
    });
    const summary = {
      type: result.type,
      source: relativePath(process.cwd(), result.sourcePath),
      target: result.targetRelPath,
      title: result.title,
      tags: result.tags,
      date: result.date,
      commit: result.commitHash?.slice(0, 7) ?? null,
      pushed: result.pushed,
      dry_run: result.dryRun,
    };
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  } catch (err) {
    log.withError(err).error("publish failed");
    process.exit(1);
  }
}

if (import.meta.main) {
  main();
}
