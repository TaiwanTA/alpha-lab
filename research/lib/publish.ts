// publish helper 的純函式層
//
// 拆 publish.ts CLI 與 lib 的理由(同 lib/raw-writer.test.ts / db.test.ts 慣例):
//   - CLI (research/publish.ts) 管 IO + git + process exit code,難 unit test
//   - 純函式(frontmatter 解析、type 偵測、slug、target path)可被 unit test 蓋到
// workflow/d.ts 之後要從 publish 完接一條 publish step 會直接 import 這邊的函式
// 或 call publish() entry(workflow 端用 entry 比較方便,但 entry 含 IO,要小心
// workflow bundle 同 lib/* 的 logger module-level side effect 雷(AGENTS.md
// 有記)— 之後再決定從哪邊 call)
//
// frontmatter 格式:我們輸入來自 C/D agent 自家產的 markdown,schema 我們完全掌控,
// 因此 parser 只支援有限 subset:`key: scalar`、`key: "value with spaces"`、
// `key: [a, b, c]`(逗號前後可有空白)。其他 YAML 構造(nested、anchor、block scalar)
// 不支援,且 publish.ts 遇到會 throw — fail fast 比 silently 不 publish 安全
// Kilo/Gemini bot review 對 silent fallback 一致反感

import { existsSync } from "node:fs";
import { join as joinPath } from "node:path";

export type ReportType = "pre" | "post" | "event-tracking";

// type 對應的 blog tag(對齊 ADR-001 "實體:報告" 表)
export const TYPE_TAGS: Record<ReportType, readonly string[]> = {
  pre: ["盤前報告"],
  post: ["盤後報告"],
  "event-tracking": ["事件追蹤"],
} as const;

// 已知 frontmatter 欄位名 — schema-allowed per content.config.ts
// (其餘欄位在來源 frontmatter 內會被忽略,因為 publish.ts 自己生成 self-contained frontmatter)
export const KNOWN_FRONTMATTER_KEYS = [
  "title",
  "date",
  "summary",
  "status",
  "tags",
  "investors",
  "tickers",
] as const;
export type KnownFrontmatterKey = (typeof KNOWN_FRONTMATTER_KEYS)[number];

// 合法 status 對齊 blog schema
const ALLOWED_STATUS = new Set(["draft", "unverified", "verified", "corrected"]);

// date 檢測:YYYY-MM-DD
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// pre/post 檔名中央的日期:YYYY-MM-DD-pre.md 或 YYYY-MM-DD-post.md
const PRE_POST_FILENAME_RE = /(\d{4}-\d{2}-\d{2})-(?:pre|post)\.md$/;

// 偵測 type:看路徑
//   "...drafts/reports/YYYY-MM-DD-pre.md"   → "pre"
//   "...drafts/reports/YYYY-MM-DD-post.md"  → "post"
//   "...drafts/event-tracking/foo.md"       → "event-tracking"
export function detectType(filePath: string): ReportType | null {
  const normalized = filePath.replace(/\\/g, "/");
  if (/\/drafts\/reports\/[^/]*-pre\.md$/.test(normalized)) return "pre";
  if (/\/drafts\/reports\/[^/]*-post\.md$/.test(normalized)) return "post";
  if (/\/drafts\/event-tracking\/[^/]+\.md$/.test(normalized)) return "event-tracking";
  return null;
}

// 從路徑 + type + file mtime fallback 解出 date(YYYY-MM-DD)
export function deriveDate(filePath: string, type: ReportType, mtime: Date): string {
  if (type === "pre" || type === "post") {
    const m = filePath.replace(/\\/g, "/").match(PRE_POST_FILENAME_RE);
    const candidate = m?.[1];
    if (candidate !== undefined && DATE_RE.test(candidate)) return candidate;
  }
  // event-tracking 與 fallback:用檔案 mtime
  return mtime.toISOString().slice(0, 10);
}

// 從 raw markdown 抽出 title
//   1. source frontmatter title(string) → 直接用
//   2. 第一個 H1(`# ...`) → 取文字
//   3. fallback slug
export function extractTitle(raw: string, fallback: string): string {
  const fm = parseFrontmatter(raw);
  if (fm.frontmatter !== null) {
    const t = fm.frontmatter["title"];
    if (typeof t === "string" && t.trim().length > 0) return t.trim();
    if (typeof t === "number") return String(t);
  }
  // 用 extractTitleFromBody(避免重複 H1 抓取邏輯,Kilo PR #11 Gemini medium)
  const fromBody = extractTitleFromBody(fm.body);
  if (fromBody !== null && fromBody.length > 0) return fromBody;
  return fallback;
}

// 從 raw markdown 抽出 summary
//   1. source frontmatter summary → 用(可被 truncate)
//   2. body 第一段(non-empty,non-heading,non-blockquote,non-code-fence)
//   truncate 到 maxChars
export function extractSummary(raw: string, maxChars: number): string {
  const fm = parseFrontmatter(raw);
  if (fm.frontmatter !== null) {
    const s = fm.frontmatter["summary"];
    if (typeof s === "string" && s.trim().length > 0) {
      return truncate(s.trim().replace(/\s+/g, " "), maxChars);
    }
  }
  const body = fm.body;
  const lines = body.split("\n");
  const buffer: string[] = [];
  let inFence = false;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (line.length === 0) {
      if (buffer.length > 0) break;
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      if (buffer.length > 0) break;
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (buffer.length > 0) break;
      continue;
    }
    if (/^---+\s*$/.test(line) || /^\*\*\*+\s*$/.test(line)) {
      if (buffer.length > 0) break;
      continue;
    }
    buffer.push(line);
  }
  const joined = buffer.join(" ").replace(/\s+/g, " ").trim();
  return truncate(joined, maxChars);
}

// 去掉 inline markdown markup(`**bold**`、`*italic*`、`[text](url)`、`code`)
function stripInlineMarkdown(s: string): string {
  return s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

// 簡單 truncate:邊界在空白 + 加 …(避免截在單字中間)
// 中文容錯:若截斷點前一個 char 不是 ASCII(等機空白分隔),直接切(中文本就無空格分隔,
// 強回溯會一路回溯到 ASCII 才停在中文段最前,幾乎截空)(Kilo PR #11 Gemini high priority)
//
// iter 2 fix(Kilo PR #11):前版只在「段內無任何空白」才直切,但中文混早期 ASCII 空白
// 仍會回溯到最早空白(幾乎截光中文內容)。改折衷:回溯找不到最近空白時,允許在段內從
// maxChars 往左找最近空白,但若最近空白位置距 maxChars > maxChars/2(即目標 trim 後
// 不到一半長),直接切 maxChars 邊界 — 寧可切稍長也不要截到只剩三分之一。
function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  let cutAt = maxChars - 1;
  const windowHasSpace = s.slice(0, maxChars).includes(" ");
  if (windowHasSpace) {
    // 回溯找最近空白
    while (cutAt > 0 && s[cutAt] !== " ") cutAt--;
    // 若最近空白位置太早(切出來不到 maxChars 一半),直切 maxChars 邊界寧長不過短
    if (cutAt < maxChars / 2) {
      cutAt = maxChars - 1;
    }
  } else {
    cutAt = maxChars - 1;
  }
  const sliced = cutAt > 0 ? s.slice(0, cutAt) : s.slice(0, maxChars - 1);
  return sliced.trimEnd() + "…";
}

// slugify:保留 ASCII word char + CJK + hyphen;其餘 collapse 成 hyphen
// 中文保留不會造成 routing 問題 — blog/src/pages/tags/[tag].astro getStaticPaths
// 對中文 tag 已 work(先例:Burry post tags 含 `主題研究`、`反向投資`、`風格示範`)
export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^\p{Letter}\p{Number}\u4e00-\u9fff-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export interface ParsedMarkdown {
  frontmatter: Record<string, unknown> | null;
  body: string;
}

// 拆 frontmatter 與 body
// 回傳 { frontmatter: null, body: raw } 若無 frontmatter
export function parseFrontmatter(raw: string): ParsedMarkdown {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match || match[1] === undefined) {
    return { frontmatter: null, body: raw };
  }
  const lines = match[1].split(/\r?\n/);
  const fm: Record<string, unknown> = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed.length === 0) { i++; continue; }
    if (trimmed.startsWith("#")) { i++; continue; }
    if (!line.includes(":")) {
      throw new Error(`cannot parse frontmatter line: ${JSON.stringify(line)}`);
    }
    const colonIdx = line.indexOf(":");
    const key = line.slice(0, colonIdx).trim();
    const rawValue = line.slice(colonIdx + 1).trim();

    if (rawValue.length === 0) {
      // 嘗試 block-style list(e.g. `investors:\n  - "A"\n  - "B"`)
      const block = collectBlockList(lines, i + 1);
      if (block !== null) {
        fm[key] = block.values;
        i = block.nextIndex;
        continue;
      }
      fm[key] = "";
      i++;
      continue;
    }
    // 偵測 nested / block YAML — 我們不支援,throw(避免 silent fallback)
    if (rawValue.startsWith("{") || rawValue.endsWith("}") ||
        (rawValue.startsWith("[") && !rawValue.endsWith("]"))) {
      throw new Error(`unsupported nested/block YAML value: ${JSON.stringify(rawValue)}`);
    }
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      fm[key] = parseInlineArray(rawValue);
      i++;
      continue;
    }
    if (rawValue.startsWith('"') && rawValue.endsWith('"')) {
      fm[key] = unescapeYamlString(rawValue.slice(1, -1));
      i++;
      continue;
    }
    if (rawValue.startsWith("'") && rawValue.endsWith("'")) {
      fm[key] = rawValue.slice(1, -1);
      i++;
      continue;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(rawValue)) {
      fm[key] = Number(rawValue);
      i++;
      continue;
    }
    if (rawValue === "true" || rawValue === "false") {
      fm[key] = rawValue === "true";
      i++;
      continue;
    }
    fm[key] = rawValue;
    i++;
  }
  return { frontmatter: fm, body: raw.slice(match[0].length) };
}

// block-style list parser:從 start 開始收集 `- <item>` 行,所有行必須用相同 indent
// (至少 2 個空白),遇到非 indent 或 EOF 結束。回傳 null 表示不是 block-style。
function collectBlockList(
  lines: readonly string[],
  start: number,
): { values: string[]; nextIndex: number } | null {
  const values: string[] = [];
  let idx = start;
  // 第一行決定 indent 與 prefix
  let indentSize = -1;
  while (idx < lines.length) {
    const line = lines[idx] ?? "";
    if (line.trim().length === 0) { idx++; continue; }
    // 計算 leading whitespace
    const leading = line.match(/^(\s*)/)?.[0] ?? "";
    const currentIndent = leading.length;
    if (currentIndent < 2) break; // 回到 top-level 或 EOF
    if (indentSize === -1) indentSize = currentIndent;
    if (currentIndent !== indentSize) break;
    const content = line.slice(currentIndent);
    if (!content.startsWith("- ")) break;
    const itemText = content.slice(2);
    values.push(itemText);
    idx++;
  }
  if (values.length === 0) return null;
  // post-process:strip 雙/單引號,等同 inline array 的行為
  const cleaned = values.map((v) => {
    const t = v.trim();
    if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) {
      return unescapeYamlString(t.slice(1, -1));
    }
    return t;
  });
  return { values: cleaned, nextIndex: idx };
}

// inline YAML array 的字串列表:e.g. `[a, "b c", 'd']`
function parseInlineArray(s: string): string[] {
  const inner = s.slice(1, -1).trim();
  if (inner.length === 0) return [];
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  let escapeNext = false;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? "";
    if (escapeNext) {
      buf += c;
      escapeNext = false;
      continue;
    }
    if (quote !== null) {
      if (c === "\\") {
        escapeNext = true;
        continue;
      }
      if (c === quote) {
        quote = null;
        continue;
      }
      buf += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ",") {
      const t = buf.trim();
      if (t.length > 0) out.push(t);
      buf = "";
      continue;
    }
    buf += c;
  }
  const t = buf.trim();
  if (t.length > 0) out.push(t);
  return out;
}

function unescapeYamlString(s: string): string {
  return s.replace(/\\(.)/g, "$1");
}

// 序列化 frontmatter 回 markdown 區塊
// 排序:已知欄位在前(KNOWN_FRONTMATTER_KEYS 順序),未知欄位按字母接在後
export function serializeFrontmatter(fm: Record<string, unknown>): string {
  const orderedKeys = KNOWN_FRONTMATTER_KEYS.filter((k) => k in fm);
  const unknownKeys = Object.keys(fm)
    .filter((k) => !(KNOWN_FRONTMATTER_KEYS as readonly string[]).includes(k))
    .sort();
  const lines: string[] = ["---"];
  for (const key of orderedKeys) {
    lines.push(`${key}: ${formatFrontmatterValue(fm[key])}`);
  }
  for (const key of unknownKeys) {
    lines.push(`${key}: ${formatFrontmatterValue(fm[key])}`);
  }
  lines.push("---");
  return lines.join("\n") + "\n";
}

function formatFrontmatterValue(value: unknown): string {
  if (Array.isArray(value)) {
    const items = value.map((v) => {
      if (typeof v !== "string") return JSON.stringify(v);
      if (needsQuoting(v)) return JSON.stringify(v);
      return v;
    });
    return "[" + items.join(", ") + "]";
  }
  if (typeof value === "string") {
    if (value.length === 0) return '""';
    if (needsQuoting(value)) return JSON.stringify(value);
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (value === null || value === undefined) return "";
  return JSON.stringify(value);
}

// 需要 quotes 的情境:含冒號 / 中括號 / YAML 控制字元 / 中文 / YAML 保留字(true/false/null/數字字串)等
// 簡單判斷:全為英數 + hyphen + underscore 且 `不` 是 YAML 保留字 才不需 quoting
// (Kilo PR #11 CRITICAL:"true"/"false"/"42" 等 YAML 保留字串值需 quoting,
// 否則 serializeFrontmatter 寫出 `summary: true` 會被 parseFrontmatter
// 又讀成 boolean,round-trip typing drift)
//
// iter 2 fix(Kilo PR #11):加 inf/nan(+Inf/-Inf/NaN,YAML 1.2 規範)、
// hex/octal/scientific 數字形態也 quoting,避免假數字 round-trip。
function needsQuoting(s: string): boolean {
  if (s.length === 0) return true;
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return true;
  const lower = s.toLowerCase();
  // YAML 1.2 boolean/null literals(不分大小寫)
  if (lower === "true" || lower === "false" || lower === "null" || s === "~") return true;
  if (lower === "inf" || lower === "-inf" || lower === "nan") return true;
  // 十進位整數 / 小數
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return true;
  // 科學記號 e.g. 1e10 / -2.5E-3
  if (/^-?\d+(?:\.\d+)?[eE][-+]?\d+$/.test(s)) return true;
  // 十六進位 0x... / 八進位 0o... / 二進位 0b...(YAML 1.1 支援)
  if (/^0[xXbBoO][0-9a-fA-F]+$/.test(s)) return true;
  // 前導 + 號(如 "+5"、"true")— YAML 1.1 視某些為 type tag
  if (s.startsWith("+")) return true;
  return false;
}

export interface BuildFrontmatterInput {
  raw: string;
  type: ReportType;
  date: string;
}

export interface BuildFrontmatterOutput {
  frontmatter: Record<string, unknown>;
  body: string;
  slug: string;
  title: string;
}

// 主函式:從 source raw 整合出最終 frontmatter + body + slug
//   - source 的合法 frontmatter 欄位延用
//   - tags:source tags ∪ TYPE_TAGS[type],去重,源在前
//   - status:source 給且合法 → 用;否則 unverified
//   - investors/tickers:source 是 scalar 當作 [scalar]
export function buildFrontmatter(opts: BuildFrontmatterInput): BuildFrontmatterOutput {
  const { frontmatter: sourceFm, body } = parseFrontmatter(opts.raw);
  const fm = sourceFm ?? {};

  const sourceTitle = readString(fm["title"]);
  const sourceSummary = readString(fm["summary"]);
  const sourceDate = readString(fm["date"]);
  const sourceStatus = readString(fm["status"]);
  const sourceSlug = readString(fm["slug"]);
  const sourceTags = readStringArray(fm["tags"]);
  const sourceInvestors = readStringArray(fm["investors"]);
  const sourceTickers = readStringArray(fm["tickers"]);

  const title = sourceTitle ?? extractTitleFromBody(body) ?? "untitled";
  const summary = sourceSummary ?? extractSummaryFromBody(body, 150);
  const date = sourceDate ?? opts.date;

  const status = sourceStatus !== undefined && ALLOWED_STATUS.has(sourceStatus)
    ? sourceStatus
    : "unverified";

  const tags = dedupeStrings([...sourceTags, ...TYPE_TAGS[opts.type]]);

  const frontmatter: Record<string, unknown> = {
    title,
    date,
    summary,
    status,
    tags,
    investors: sourceInvestors,
    tickers: sourceTickers,
  };

  const slugSource = sourceSlug ?? slugify(title);
  const slug = slugSource.length > 0 ? slugSource : "untitled";

  return { frontmatter, body, slug, title };
}

function readString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.filter((x): x is string => typeof x === "string");
  }
  if (typeof v === "string" && v.length > 0) return [v];
  return [];
}

function dedupeStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

function extractTitleFromBody(body: string): string | null {
  // 跳過 code fence ``` 與 ~~~ 內的內容(Kilo PR #11 Gemini medium priority:
  // 全域正則 `body.match(/^#\s+(.+?)\s*$/m)` 會 match code block 內的 `# comment`)
  const lines = body.split("\n");
  let inFence = false;
  for (const line of lines) {
    const fenceMatch = line.match(/^(\s*)(```|~~~)/);
    if (fenceMatch) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    // 單行 H1 — 不能在 blockquote(> # foo)內
    const h1 = line.match(/^(?!>)#\s+(.+?)\s*$/);
    if (h1 && h1[1] !== undefined) {
      const text = stripInlineMarkdown(h1[1]).trim();
      if (text.length > 0) return text;
    }
  }
  return null;
}

function extractSummaryFromBody(body: string, maxChars: number): string {
  // 把 body 包成完整 markdown 給 extractSummary(它會正確跳過 frontmatter)
  return extractSummary(`---\n---\n${body}`, maxChars);
}

// 計算實際 target 路徑:blogDir/<YYYY-MM-DD>-<slug>.md(碰撞 → 加 -2、-3...)
//   blogDir 不存在也 OK(測試用 tmpdir)
export function resolveTargetPath(blogDir: string, date: string, slug: string): string {
  if (slug.includes("/") || slug.includes("\\") || slug.includes("..")) {
    throw new Error(`unsafe slug: ${JSON.stringify(slug)}`);
  }
  const base = joinPath(blogDir, `${date}-${slug}.md`);
  if (!existsSync(base)) return base;
  let suffix = 2;
  while (suffix < 1000) {
    const candidate = joinPath(blogDir, `${date}-${slug}-${suffix}.md`);
    if (!existsSync(candidate)) return candidate;
    suffix++;
  }
  throw new Error(`cannot find non-conflicting target path after ${suffix} tries`);
}
