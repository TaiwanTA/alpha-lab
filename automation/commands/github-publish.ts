#!/usr/bin/env bun
// automation/commands/github-publish.ts
//
// 把候選 Markdown 透過 GitHub Contents API (REST) 直接 commit 到 main。
// 不開 PR、不開分支、不需要本地 git workstation。
//
// 流程:
//   1. renderPublishContent (純函數,共享自 publish-draft.ts) 驗證 frontmatter/body
//      並產出最終 bytes + 目標 repo-relative 路徑
//   2. GET /repos/.../contents/{path}?ref=main 檢查檔案是否已存在
//      - 200 且 bytes 相同 → noop (idempotent retry)
//      - 200 但 bytes 不同 → fatal collision (跟 publish-draft.ts 行為一致)
//      - 404 → 進行 PUT
//   3. PUT /repos/.../contents/{path},branch=main → 一次 call = commit + push
//
// 認證:
//   只讀 GH_PR_TOKEN 環境變數 (Bearer)。需有 contents:write 對 main 的權限。
//
// ruleset:
//   repo-level ruleset 18699827 原本只允許 DeployKey bypass,但使用者已放鬆
//   pull_request rule,讓 PAT 能直推 main (ruleset 現在只保留 deletion /
//   non_fast_forward 兩個保護)。
//
// 不做 PR:blog 內容錯誤靠本地 lint (renderPublishContent) 把關,
// review bot 不該浪費在文章上。

import { parseArgs } from "node:util";
import { renderPublishContent } from "./publish-draft.ts";

const REPO = "TaiwanTA/alpha-lab";
const API_BASE = "https://api.github.com";

interface ContentsGetResponse {
  sha: string;
  content: string | null;
  encoding: string | null;
}

interface ContentsPutResponse {
  commit: {
    sha: string;
    html_url: string;
  };
  content: {
    html_url: string;
  } | null;
}

function parseCliArgs(argv: string[]): {
  candidate: string;
  runtimeSha: string;
  runId: string;
} {
  const args = parseArgs({
    args: argv,
    options: {
      candidate: { type: "string" },
      "runtime-sha": { type: "string" },
      "run-id": { type: "string" },
    },
    strict: true,
  });
  const candidate = args.values.candidate;
  const runtimeSha = args.values["runtime-sha"] ?? "";
  const runId = args.values["run-id"] ?? "";
  if (!candidate) {
    throw new Error("--candidate <path> is required");
  }
  return { candidate, runtimeSha, runId };
}

function authHeaders(): Record<string, string> {
  const token = process.env.GH_PR_TOKEN;
  if (!token || token.length === 0) {
    throw new Error("GH_PR_TOKEN 必須設定在環境變數");
  }
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "alpha-lab-blog-publish",
  };
}

function decodeContentFromApi(resp: ContentsGetResponse): string {
  // GitHub Contents API 回傳 content 為 base64,可能含換行
  if (resp.encoding !== "base64" || resp.content == null) {
    throw new Error(
      `unexpected content encoding from API: encoding=${resp.encoding ?? "null"}`,
    );
  }
  return Buffer.from(resp.content.replace(/\n/g, ""), "base64").toString("utf8");
}

async function githubFetch<T>(
  path: string,
  init: RequestInit & { expectedStatus?: number[] } = {},
): Promise<{ status: number; body: T | unknown }> {
  const { expectedStatus, ...rest } = init;
  const res = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: { ...authHeaders(), ...(rest.headers ?? {}) },
  });
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (expectedStatus && !expectedStatus.includes(res.status)) {
    const message =
      typeof body === "object" && body !== null && "message" in body
        ? String((body as { message: unknown }).message)
        : "<no message>";
    throw new Error(
      `GitHub API ${path} expected ${expectedStatus.join("/")} got ${res.status}: ${message}`,
    );
  }
  return { status: res.status, body };
}

/**
 * 主流程:驗證 candidate → 檢查遠端是否存在 → PUT commit 到 main。
 * 返回 commit html_url,給 DAG 當 output。
 */
async function publishViaGithubApi(
  candidatePath: string,
  runtimeSha: string,
  runId: string,
): Promise<{ commitUrl: string; action: "created" | "unchanged" }> {
  const rendered = renderPublishContent(candidatePath, runtimeSha);
  const encodedPath = encodeURIComponent(rendered.repoRelPath);
  const contentBytes = Buffer.from(rendered.content, "utf8");
  const contentBase64 = contentBytes.toString("base64");

  // 1. GET 檢查是否已存在
  const getRes = await githubFetch<ContentsGetResponse>(
    `/repos/${REPO}/contents/${encodedPath}?ref=main`,
    { method: "GET" },
  );

  let existingSha: string | null = null;
  if (getRes.status === 200) {
    const body = getRes.body as ContentsGetResponse;
    existingSha = body.sha;
    const remoteContent = decodeContentFromApi(body);
    if (remoteContent === rendered.content) {
      // 已存在且 bytes 完全相同:idempotent retry 路徑。
      return {
        commitUrl: `https://github.com/${REPO}/blob/main/${rendered.repoRelPath}`,
        action: "unchanged",
      };
    }
    // 不允許覆寫不同 bytes 的既有檔。跟 publish-draft.ts 本地模式
    // 的 collision 檢查行為一致 — 避免靜默把別人的手動編輯覆蓋掉。
    throw new Error(
      `target collision: ${rendered.repoRelPath} already exists on main with differing bytes (sha=${existingSha}); refusing to overwrite`,
    );
  }
  if (getRes.status !== 404) {
    const msg =
      typeof getRes.body === "object" && getRes.body !== null && "message" in getRes.body
        ? String((getRes.body as { message: unknown }).message)
        : "<no message>";
    throw new Error(`GET contents returned ${getRes.status}: ${msg}`);
  }

  // 2. PUT 直接 commit 到 main (不開分支、不開 PR)
  const commitMessage = runId
    ? `feat(blog): publish ${rendered.repoRelPath.split("/").pop()} (${runId})`
    : `feat(blog): publish ${rendered.repoRelPath.split("/").pop()}`;

  const putBody = {
    message: commitMessage,
    branch: "main",
    content: contentBase64,
  };

  const putRes = await githubFetch<ContentsPutResponse>(
    `/repos/${REPO}/contents/${encodedPath}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(putBody),
      expectedStatus: [200, 201],
    },
  );

  const putResponseBody = putRes.body as ContentsPutResponse;
  const commitUrl = putResponseBody.commit?.html_url;
  if (!commitUrl) {
    throw new Error("PUT contents response missing commit.html_url");
  }
  return { commitUrl, action: "created" };
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const result = await publishViaGithubApi(args.candidate, args.runtimeSha, args.runId);
  // 單行機器可讀 stdout,DAG step 收成 PR_URL/COMMIT_URL output 用。
  console.log(
    JSON.stringify({ ok: true, action: result.action, commitUrl: result.commitUrl }),
  );
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`github-publish: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  });
}
