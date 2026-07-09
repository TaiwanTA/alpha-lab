// publish lib 純函式測試
//   這些不需 DB、不需 git、不需真實 blog repo,tmpdir 跑就夠
//
// 涵蓋(對應 spec「3. 測試」段):
//   - detectType:3 種 path
//   - slugify:中文 / 英文 / 特殊字元
//   - extractSummary:frontmatter / H1 / 第一段、空 markdown
//   - extractTitle:H1 優先 / fallback slug
//   - buildFrontmatter:各 type 給對應 tag、source tags merge、date 不被覆蓋
//   - resolveTargetPath:不存在 / 撞名(td 真實 tmpdir)

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectType,
  deriveDate,
  extractTitle,
  extractSummary,
  slugify,
  parseFrontmatter,
  serializeFrontmatter,
  buildFrontmatter,
  resolveTargetPath,
  TYPE_TAGS,
  type ReportType,
} from "../../lib/publish.ts";

describe("detectType", () => {
  test("pre reports", () => {
    expect(detectType("/repo/research/drafts/reports/2026-07-09-pre.md")).toBe("pre");
  });
  test("post reports", () => {
    expect(detectType("/repo/research/drafts/reports/2026-07-09-post.md")).toBe("post");
  });
  test("event-tracking reports", () => {
    expect(detectType("/repo/research/drafts/event-tracking/ackman-on-nvda-abc123def.md")).toBe(
      "event-tracking",
    );
  });
  test("non-canonical paths return null", () => {
    expect(detectType("/tmp/foo.md")).toBeNull();
    expect(detectType("/repo/research/drafts/reports/random.md")).toBeNull();
    expect(detectType("/repo/research/drafts/reports/2026-07-09-draft.md")).toBeNull();
  });
  test("windows-style paths also work", () => {
    expect(
      detectType(String.raw`C:\repo\research\drafts\reports\2026-07-09-pre.md`),
    ).toBe("pre");
  });
});

describe("deriveDate", () => {
  test("pre/post:date from filename", () => {
    const mtime = new Date("2026-07-15T10:00:00Z");
    expect(deriveDate("/x/drafts/reports/2026-07-09-pre.md", "pre", mtime)).toBe("2026-07-09");
    expect(deriveDate("/x/drafts/reports/2026-12-31-post.md", "post", mtime)).toBe("2026-12-31");
  });
  test("event-tracking:fallback to mtime", () => {
    const mtime = new Date("2026-07-15T10:00:00Z");
    expect(
      deriveDate("/x/drafts/event-tracking/ackman-on-nvda-abc.md", "event-tracking", mtime),
    ).toBe("2026-07-15");
  });
  test("pre with non-canonical filename:fallback mtime", () => {
    const mtime = new Date("2026-08-20T03:00:00Z");
    expect(deriveDate("/x/drafts/reports/whatever-pre.md", "pre", mtime)).toBe("2026-08-20");
  });
});

describe("slugify", () => {
  test("english pascal-case → kebab", () => {
    expect(slugify("Hello World")).toBe("hello-world");
    expect(slugify("Ackman on NVDA")).toBe("ackman-on-nvda");
  });
  test("chinese preserved", () => {
    // 純中文也會保留(不會 collapse 成空)
    expect(slugify("盤前報告")).toBe("盤前報告");
    expect(slugify("事件追蹤:Burry 次貸")).toBe("事件追蹤-burry-次貸");
  });
  test("special chars collapse to hyphen", () => {
    expect(slugify("hello/world! 2026?")).toBe("hello-world-2026");
    expect(slugify("what??!! no")).toBe("what-no");
  });
  test("trim leading/trailing hyphens", () => {
    expect(slugify("---hi---")).toBe("hi");
    expect(slugify("!@#$ok")).toBe("ok");
  });
  test("emoji collapse to hyphen", () => {
    expect(slugify("rocket 🚀 launch")).toBe("rocket-launch");
  });
  test("truncates to 80 chars", () => {
    const long = "a".repeat(200);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
  test("empty string → empty", () => {
    expect(slugify("")).toBe("");
    expect(slugify("---")).toBe("");
  });
});

describe("extractTitle", () => {
  test("frontmatter title 優先", () => {
    const raw = `---
title: "Hello world"
---
body`;
    expect(extractTitle(raw, "fallback")).toBe("Hello world");
  });
  test("frontmatter title 空白 fallback 到 H1", () => {
    const raw = `---
title: ""
---
# H1 title
body`;
    expect(extractTitle(raw, "fallback")).toBe("H1 title");
  });
  test("沒 frontmatter 但有 H1", () => {
    const raw = `# 第一個 H1

body content`;
    expect(extractTitle(raw, "fallback")).toBe("第一個 H1");
  });
  test("H1 with inline markdown stripped", () => {
    const raw = `# **Bold** and *italic* \`code\`

body`;
    expect(extractTitle(raw, "fallback")).toBe("Bold and italic code");
  });
  test("H1 with link", () => {
    const raw = `# [click here](https://example.com)

body`;
    expect(extractTitle(raw, "fallback")).toBe("click here");
  });
  test("完全沒有 frontmatter / H1 → fallback", () => {
    const raw = `just plain text
no heading here`;
    expect(extractTitle(raw, "fallback-value")).toBe("fallback-value");
  });
});

describe("extractSummary", () => {
  test("frontmatter summary 優先,truncate", () => {
    const long = "A".repeat(500);
    const raw = `---
title: "t"
summary: "${long}"
---
body`;
    const s = extractSummary(raw, 150);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(160);
  });
  test("沒 frontmatter:取第一段", () => {
    const raw = `一段中文 summary,內容是這樣的。繼續擴充。

## 下一段

content`;
    const s = extractSummary(raw, 150);
    expect(s).toBe("一段中文 summary,內容是這樣的。繼續擴充。");
  });
  test("skip heading 第一行", () => {
    const raw = `# 第一行是 H1
真正要取的內容是這一段。`;
    const s = extractSummary(raw, 150);
    expect(s).toBe("真正要取的內容是這一段。");
  });
  test("skip blockquote", () => {
    const raw = `> 這是 blockquote
這才是 summary`;
    const s = extractSummary(raw, 150);
    expect(s).toBe("這才是 summary");
  });
  test("skip code fence", () => {
    const raw = "```js\nconst x = 1;\n```\n第一段是 summary 內容。";
    const s = extractSummary(raw, 150);
    expect(s).toBe("第一段是 summary 內容。");
  });
  test("空 markdown", () => {
    expect(extractSummary("", 150)).toBe("");
    expect(extractSummary("\n\n\n", 150)).toBe("");
    expect(extractSummary("# only heading\n", 150)).toBe("");
  });
  test("long 內容 truncate at word boundary", () => {
    const raw = "word ".repeat(50);
    const s = extractSummary(`---\n---\n${raw}`, 60);
    expect(s.endsWith("…")).toBe(true);
    expect(s.length).toBeLessThanOrEqual(62);
  });
});

describe("parseFrontmatter", () => {
  test("no frontmatter → null + body = raw", () => {
    const raw = "no fm here\nbody";
    const r = parseFrontmatter(raw);
    expect(r.frontmatter).toBeNull();
    expect(r.body).toBe(raw);
  });
  test("simple frontmatter (scalars)", () => {
    const raw = `---
title: "Hello"
date: "2026-07-09"
status: unverified
---
body here`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter).toEqual({
      title: "Hello",
      date: "2026-07-09",
      status: "unverified",
    });
    expect(r.body.startsWith("body here")).toBe(true);
  });
  test("frontmatter array values", () => {
    const raw = `---
tags: ["a", "b", "中文 tag"]
investors: ["Michael Burry"]
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["tags"]).toEqual(["a", "b", "中文 tag"]);
    expect(r.frontmatter?.["investors"]).toEqual(["Michael Burry"]);
  });
  test("array with single quotes", () => {
    const raw = `---
tags: ['a', 'b']
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["tags"]).toEqual(["a", "b"]);
  });
  test("array unquoted", () => {
    const raw = `---
tags: [a, b, c]
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["tags"]).toEqual(["a", "b", "c"]);
  });
  test("numeric and boolean", () => {
    const raw = `---
port: 5432
enabled: true
disabled: false
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["port"]).toBe(5432);
    expect(r.frontmatter?.["enabled"]).toBe(true);
    expect(r.frontmatter?.["disabled"]).toBe(false);
  });
  test("unknown / unsupported line → throw", () => {
    const raw = `---
title: ok
nested: { a: b }
---
body`;
    expect(() => parseFrontmatter(raw)).toThrow(/unsupported nested\/block YAML/);
  });
  test("block-style list", () => {
    const raw = `---
title: t
investors:
  - "Bill Ackman"
  - "Stanley Druckenmiller"
tickers:
  - NVDA
  - TSLA
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["investors"]).toEqual(["Bill Ackman", "Stanley Druckenmiller"]);
    expect(r.frontmatter?.["tickers"]).toEqual(["NVDA", "TSLA"]);
    expect(r.frontmatter?.["title"]).toBe("t");
  });
  test("mixed inline + block-style", () => {
    const raw = `---
title: t
tags: ["a"]
investors:
  - "Burry"
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["tags"]).toEqual(["a"]);
    expect(r.frontmatter?.["investors"]).toEqual(["Burry"]);
  });
  test("comment line skip", () => {
    const raw = `---
# 這是註解
title: ok
---
body`;
    const r = parseFrontmatter(raw);
    expect(r.frontmatter?.["title"]).toBe("ok");
    expect(Object.keys(r.frontmatter ?? {}).length).toBe(1);
  });
});

describe("serializeFrontmatter", () => {
  test("known keys 在前、unknown 在後依字母", () => {
    const fm = {
      tags: ["x"],
      zz: "last",
      title: "T",
      aa: "first",
      date: "2026-07-09",
    };
    const lines = serializeFrontmatter(fm).split("\n");
    expect(lines[0]).toBe("---");
    // 已知順序:title, date, tags(fm 內實際有的)— summary/status/investors/tickers
    // 不在 input 故不 emit(serializeFrontmatter 不做 default-filling)
    expect(lines[1]).toBe('title: T');
    expect(lines[2]).toBe('date: 2026-07-09');
    expect(lines[3]).toBe('tags: [x]');
    // unknown:aa → zz(字母序)
    expect(lines[4]).toBe('aa: first');
    expect(lines[5]).toBe('zz: last');
    expect(lines[6]).toBe("---");
  });
  test("string with special chars → JSON-quoted", () => {
    const fm = { title: 'has:colon and "quotes" and 中文' };
    const s = serializeFrontmatter(fm);
    expect(s).toContain('title: "has:colon and \\"quotes\\" and 中文"');
  });
  test("empty string → empty quoted", () => {
    const fm = { title: "" };
    const s = serializeFrontmatter(fm);
    expect(s).toContain('title: ""');
  });
});

describe("buildFrontmatter:type → tags", () => {
  test("pre → 盤前報告", () => {
    const out = buildFrontmatter({
      raw: `---\ntitle: "T"\n---\nbody`,
      type: "pre",
      date: "2026-07-09",
    });
    expect(out.frontmatter["tags"]).toEqual(["盤前報告"]);
  });
  test("post → 盤後報告", () => {
    const out = buildFrontmatter({
      raw: `---\ntitle: "T"\n---\nbody`,
      type: "post",
      date: "2026-07-09",
    });
    expect(out.frontmatter["tags"]).toEqual(["盤後報告"]);
  });
  test("event-tracking → 事件追蹤", () => {
    const out = buildFrontmatter({
      raw: `---\ntitle: "T"\n---\nbody`,
      type: "event-tracking",
      date: "2026-07-09",
    });
    expect(out.frontmatter["tags"]).toEqual(["事件追蹤"]);
  });
  test("TYPE_TAGS 與 spec 對齊", () => {
    expect(TYPE_TAGS.pre).toEqual(["盤前報告"]);
    expect(TYPE_TAGS.post).toEqual(["盤後報告"]);
    expect(TYPE_TAGS["event-tracking"]).toEqual(["事件追蹤"]);
  });
  test("source tags + type tag 合併 dedupe", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
tags: ["long-form", "盤前報告"]
---
body`,
      type: "pre",
      date: "2026-07-09",
    });
    // source 順序保留 → long-form 先,盤前報告 dedupe
    expect(out.frontmatter["tags"]).toEqual(["long-form", "盤前報告"]);
  });
  test("source tags 不含 type tag → 新增 type tag 在後", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
tags: ["深度分析"]
---
body`,
      type: "post",
      date: "2026-07-09",
    });
    expect(out.frontmatter["tags"]).toEqual(["深度分析", "盤後報告"]);
  });
  test("source date 被保留(不被 opts.date 覆蓋)", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
date: "2025-01-15"
---
body`,
      type: "pre",
      date: "2026-07-09", // 故意不同
    });
    expect(out.frontmatter["date"]).toBe("2025-01-15");
  });
  test("source status 為合法值時沿用", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
status: draft
---
body`,
      type: "pre",
      date: "2026-07-09",
    });
    expect(out.frontmatter["status"]).toBe("draft");
  });
  test("source status 為非法值時 fallback unverified", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
status: bogus
---
body`,
      type: "pre",
      date: "2026-07-09",
    });
    expect(out.frontmatter["status"]).toBe("unverified");
  });
  test("source investors / tickers 為 scalar → array", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
investors: "Michael Burry"
tickers: TSLA
---
body`,
      type: "pre",
      date: "2026-07-09",
    });
    expect(out.frontmatter["investors"]).toEqual(["Michael Burry"]);
    expect(out.frontmatter["tickers"]).toEqual(["TSLA"]);
  });
  test("沒 source frontmatter:全部 default", () => {
    const out = buildFrontmatter({
      raw: "# 第一個 H1 title\n\n這是 body 第一段文字。",
      type: "post",
      date: "2026-07-09",
    });
    expect(out.frontmatter["title"]).toBe("第一個 H1 title");
    expect(out.frontmatter["date"]).toBe("2026-07-09");
    expect(out.frontmatter["status"]).toBe("unverified");
    expect(out.frontmatter["tags"]).toEqual(["盤後報告"]);
    expect(out.frontmatter["investors"]).toEqual([]);
    expect(out.frontmatter["tickers"]).toEqual([]);
    expect(out.frontmatter["summary"]).toBe("這是 body 第一段文字。");
  });
  test("slug from title kebab/lowercase", () => {
    const out = buildFrontmatter({
      raw: `---
title: "Ackman on NVDA: deep dive"
---
body`,
      type: "event-tracking",
      date: "2026-07-09",
    });
    expect(out.slug).toBe("ackman-on-nvda-deep-dive");
  });
  test("source frontmatter 含 slug → 沿用", () => {
    const out = buildFrontmatter({
      raw: `---
title: "T"
slug: my-custom-slug
---
body`,
      type: "pre",
      date: "2026-07-09",
    });
    expect(out.slug).toBe("my-custom-slug");
  });
});

describe("resolveTargetPath(tmpdir)", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), "publish-resolve-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  test("target 不存在 → 直接回傳路徑", () => {
    const p = resolveTargetPath(tmp, "2026-07-09", "ackman-on-nvda");
    expect(p).toBe(join(tmp, "2026-07-09-ackman-on-nvda.md"));
  });

  test("target 已存在 → 加 -2", async () => {
    const first = join(tmp, "2026-07-09-ackman-on-nvda.md");
    await writeFile(first, "x", "utf-8");
    const p = resolveTargetPath(tmp, "2026-07-09", "ackman-on-nvda");
    expect(p).toBe(join(tmp, "2026-07-09-ackman-on-nvda-2.md"));
  });

  test("target 已存在 -2 / -3 / -4 累加", async () => {
    for (const s of ["", "-2", "-3", "-4"]) {
      await writeFile(join(tmp, `2026-07-09-foo${s}.md`), "x", "utf-8");
    }
    // 已有 foo, foo-2, foo-3, foo-4,下一個應為 foo-5
    const p = resolveTargetPath(tmp, "2026-07-09", "foo");
    expect(p).toBe(join(tmp, "2026-07-09-foo-5.md"));
  });

  test("unsafe slug throw", () => {
    expect(() => resolveTargetPath(tmp, "2026-07-09", "../escape")).toThrow(/unsafe slug/);
    expect(() => resolveTargetPath(tmp, "2026-07-09", "a/b")).toThrow(/unsafe slug/);
    expect(() => resolveTargetPath(tmp, "2026-07-09", "a\\b")).toThrow(/unsafe slug/);
  });
});

describe("integration: buildFrontmatter + resolveTargetPath", () => {
  test("end-to-end with tmpdir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "publish-integration-"));
    try {
      const raw = `---
title: "Ackman on NVDA"
date: "2026-07-09"
summary: "預先有的 summary"
tags: ["深度分析"]
investors: ["Bill Ackman"]
tickers: ["NVDA"]
---
# 內容

body paragraph here.`;
      const built = buildFrontmatter({
        raw,
        type: "event-tracking",
        date: "2026-07-09",
      });
      const target = resolveTargetPath(tmp, built.frontmatter["date"] as string, built.slug);
      expect(target).toBe(join(tmp, "2026-07-09-ackman-on-nvda.md"));

      // 寫檔 + serialize round trip
      const text = serializeFrontmatter(built.frontmatter) + built.body.replace(/^\r?\n/, "");
      await writeFile(target, text, "utf-8");

      const reParsed = parseFrontmatter(text);
      expect(reParsed.frontmatter?.["title"]).toBe("Ackman on NVDA");
      expect(reParsed.frontmatter?.["tags"]).toEqual(["深度分析", "事件追蹤"]);
      expect(reParsed.frontmatter?.["investors"]).toEqual(["Bill Ackman"]);
      expect(reParsed.frontmatter?.["tickers"]).toEqual(["NVDA"]);
      expect(reParsed.frontmatter?.["status"]).toBe("unverified");
      expect(reParsed.body).toContain("# 內容");
      expect(reParsed.body).toContain("body paragraph here.");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// 確保 TS 型別 link 不漏(用 compile-time assertion;若 type 對不上這行會在
// bun test 之前就被 tsc --noEmit 抓到)
const _types: { ok: boolean } = (() => {
  const r: ReportType = "pre";
  const _x: ReportType | null = detectType("/foo");
  return { ok: typeof r === "string" && typeof _x === "object" };
})();
void _types;
