# Canonical Feature Checklist — Serious Long-Form Research Blog

Target shape: Stratechery / Ribbonfarm / Marginal Revolution / Bloomberg Opinion class. Static-content, single-author first, multi-author capable, finance-research tilted, Chinese-language delivery. Skip forums, login, paywall. Only features a reader expects or that the operator regrets omitting.

## 1. Navigation & Discovery

- **Sticky table of contents on long posts.** Auto-generated from `<h2>`/`<h3>`, highlights the section in view, jumps on click. Long pieces are not skimmable otherwise.
- **Series / part-of-a-sequence index.** `series: foo` and `part: N/M` in frontmatter; `/series/<slug>/` lists all parts in order. Multi-day thesis arcs collapse into one reading unit.
- **Tags (`/tags/<slug>/`) and categories (`/categories/<slug>/`).** Two distinct axes — tags for granular topics ("利率", "估值"), categories for editorial bucket ("深度研究", "周记"). Mixed-type pages confuse readers.
- **Monthly + yearly archive (`/archive/`, `/2026/`, `/2026/03/`).** Browsing the past is the most common reader action after search.
- **Author pages (`/authors/<slug>/`).** Bio, photo, social, every post reverse-chronological. The canonical "about" surface even on a single-author blog.
- **Investor / entity filter pages (`/investors/<slug>/`).** Distinct from topic tags; lists every post naming the investor + one-line summary of the call. Research blogs live or die by entity recall.
- **"Related posts" module** at the end of each post — three to five cards by tag overlap. Cheapest session-length multiplier available.
- **Prev/Next post links** in the article footer. Chronological neighbors on the index, not arbitrary "you might like"; survives when related-posts recompute doesn't.
- **Breadcrumb on every page** (`Home › Tags › 估值 › <title>`). Search-result snippets, screen readers, and pasted URLs all rely on them.
- **Tag cloud** with post counts on the archive page.

## 2. Reader Aids

- **Reading time + word count** in the post header, computed at build. Sets the time budget up front; readers self-select.
- **Scroll progress bar** (thin fixed top strip, %). Answers "how much is left" without scrolling.
- **Floating "back to top" / TOC toggle** that morphs based on scroll. Required for pages ≥ 1500 words.
- **Typography controls** — font size ±, line-height ±, serif/sans toggle, column width toggle, persisted to `localStorage`. Different reading contexts demand different settings; a single canonical font is a citation-quality blog's enemy.
- **Dark mode + sepia**, OS-preference-respecting, manual override persisted. Reading sessions run late; white-on-black is not optional.
- **Copy-as-Markdown / copy-cite button**. Returns title, URL, date, site name as plain text or BibTeX-flavored. Researchers quote research; current copy-paste loses provenance.
- **Footnote vs. sidenote toggle** for citations. Footnote-only renders drown the page in number-soup; toggle the reader picks once.
- **Click-to-copy deep link** (`#` beside every heading). What readers actually share is "this section", not the title URL.
- **Print stylesheet** that strips chrome and shows citations at full width. Academics and lawyers still print; the output shouldn't be a joke.

## 3. Meta, Feed & Discovery

- **RSS 2.0** at `/feed.xml`, full-content preferred over excerpts. Real readers use RSS; feedless blogs lose an audience they can't recover.
- **Atom 1.0** at `/feed.atom`. Some readers (Akregator, corporate setups) prefer it; cheap to ship alongside RSS.
- **JSON Feed 1.1** at `/feed.json`. Native format for IFTTT, Zapier, automations — the feed becomes an API.
- **Per-category and per-tag feeds** (`/tags/利率/feed.xml`). Power users subscribe to a slice of the corpus.
- **Per-author feeds** (`/authors/<slug>/feed.xml`). Multi-author readers don't want the whole site's noise.
- **`sitemap.xml`** (and `sitemap-authors.xml`, `sitemap-tags.xml` if the corpus grows). Google ignores RSS.
- **`robots.txt`** with explicit `Sitemap:` line, plus `noindex` for `/draft/`, `/preview/`, `/search/?q=*` query pages, `/404`, and deep paginated tag pages that dup the index.
- **Open Graph** — `og:title`, `og:description`, `og:image`, `og:type=article`, `og:article:published_time`, `og:article:author`, `og:article:tag`. WeChat, X, LinkedIn, Slack previews are built on this.
- **Twitter Card** (`summary_large_image`, 1200×630). Share 90% of fields with OG; treat as one config.
- **JSON-LD** (`Article` / `BlogPosting` with author, datePublished, dateModified, image, keywords). The single biggest on-page SEO lever for a content site.
- **`<link rel="canonical">`** on every post, especially post pages reachable via multiple paths. Without it, Google picks the wrong "primary" and tanks link equity.
- **`pubdate` AND `lastmod`** in HTML meta and JSON-LD. Google rewards freshness-aware surfacing; missing `dateModified` wastes the signal.
- **Append-only permalinks.** Never change a post's slug after publish. Every other feature in this section assumes slugs are immutable.

## 4. UX & Social

- **Share row** with X / WeChat / Weibo / LinkedIn / copy-link / email. WeChat is the highest-converting share on a Chinese-language site — omit it at your traffic's peril.
- **"Copy link" button next to the post title** copying the *current scroll position's URL* (deep link to a section), not just the page URL. The share most people want is "this paragraph".
- **Comments: skip the comment system.** Replace with one of three static alternatives — (a) Webmention from Mastodon/ActivityPub only, (b) GitHub Issues per post via Utterances/Giscus, (c) email-reply (`mailto:` prefilled with slug). For a single-author research blog, no comment thread outperforms a low-traffic comment system; moderation cost kills them.
- **Newsletter signup form** — single field, double-opt-in, weekly cadence stated in the signup moment. Even at 5% conversion it's the only audience you own.
- **Sample-issue / preview link** in the signup's proximity. Conversion on research blogs is a trust problem, not a copy problem.
- **Email-reply-to-comment bridge** (kill-the-newsletter / blog-mail integration). Lets subscribers reply to a newsletter issue and the reply lands as an annotatable artifact.
- **"Subscribe by RSS" call-out** next to the newsletter signup. RSS readers are the most engaged 5%; ship an obvious link.
- **Footer CTA strip** ("分享这篇 / 订阅邮件"), not a popup. Popups kill trust on finance content.

## 5. Admin / Author

- **Draft preview at `/draft/<slug>/`** with the production layout plus a visible "DRAFT — DO NOT SHARE" banner and `noindex,nofollow`. Removing "how does it look" friction is the difference between shipping and abandoning.
- **Scheduled-post gate** — posts with future `publishDate` get `noindex` until the date passes; build script refuses to emit them to feeds/sitemap. Prevents accidental embargo leaks.
- **`lastmod` field distinct from `pubdate`**, with a visible "最后更新于" line whenever `lastmod > pubdate + 7 days`. Research posts get corrected; readers need to know the version they're reading.
- **Per-post change log** rendered as a small collapsible block ("v3 · 2026-06-14 · 修正第 4 段关于 NIM 的口径") when `lastmod > pubdate`. Inline errata, not a separate "corrections" page nobody finds — that *is* the credibility floor.
- **Frontmatter status enum** — `draft` / `unverified` / `verified` / `corrected`. Maps to a visible badge in the index and on the page; readers calibrate before clicking. `verified` is a deliberate human-review gate, not auto-set on publish.
- **Asset pipeline** — every image has alt text, explicit width/height, AVIF + WebP fallback, lazy-load below the fold. Image weight is the most common independent performance regression.
- **Link checker in CI** (`lychee` / `broken-link-checker`) over published posts. Dead links rot a research post from inside.
- **RSS-feed validation in CI** (validator.w3.org/feed). One bad escape in feed XML blanks the channel in readers; build must catch this.
- **Content-addressed asset cache-busting** so every deploy busts static caches without manual intervention.
- **Pagination on index pages** (20/page) with `rel="prev"` / `rel="next"`. Infinite scroll breaks reading sessions; pagination also makes page N+1 a stable surface for backlinks.

## 6. Search

- **Client-side full-text search** via a static JSON index (`/search-index.json`) generated at build — `MiniSearch` or `FlexSearch` default; `lunr.js` acceptable but heavier. Server-side search on a static blog is overkill; the corpus is small enough to ship.
- **Fuzzy match** (edit distance 1–2) on the title field, weighted higher than body match. Readers mistype tags and investor names.
- **CJK-aware tokenization** — none of `lunr`/`MiniSearch`/`FlexSearch` tokenize Chinese by default; run `nodejieba` / `Intl.Segmenter` at build time and emit pre-segmented terms. A search that returns zero hits for "灰犀牛" because the index holds it as one run of glyphs is a search that gets removed from the header.
- **Search results page (`/search/?q=...`) with snippeted excerpts** — "<…highlighted match…>" with surrounding 12 words, not just a title list.
- **Faceted filtering on the search page** by tag, category, author, year. Pulls the search box into a navigation surface.
- **Keyboard shortcut for search** (`/` focus, `Esc` close, `↑/↓` navigate, `Enter` open). Standard across Substack / Ghost / every editor; readers expect it.
- **`<meta name="robots" content="noindex">` on search-result pages.** Internal search is an SEO liability.
- **Empty-state copy** that links to the tag index and archive instead of showing a blank box.

## 7. Accessibility & Standards

- **Semantic HTML** — single `<h1>` per page, `<article>` wraps each post, `<nav>`/`<aside>`/`<footer>` used by purpose, lists for lists. CSS-only "headings" are the most common screen-reader-killing bug in hand-rolled blogs.
- **Skip-to-content link** as the first focusable element (`<a href="#main">`). Mandatory on any site with a sticky header.
- **Visible focus styles** on every interactive element (`outline: 2px solid` minimum). Removing default focus rings is the most common "looks nice, fails accessibility audit" mistake.
- **Color contrast ≥ WCAG AA** (4.5:1 body, 3:1 large text). Finance content frequently has muted-gray numerals on muted-gray backgrounds.
- **Reduced-motion support** (`@media (prefers-reduced-motion: reduce)`) — disables scroll-progress and fade-in animations for users who need it.
- **`lang` attribute on `<html>`** (`lang="zh-Hans"`). Screen readers switch pronunciation libraries on this attribute; getting it wrong makes Mandarin read as Cantonian.
- **`<title>` and `<meta name="description">` per page**, populated from frontmatter — not a generic site title on every page. SEO and link-preview both break without.
- **`404` page with a curated list of recent posts and a search box.** "Page not found" loses the reader; "Page not found — try these 5 recent pieces or search" recovers them.
- **`/humans.txt` and `/security.txt`** (`.well-known/security.txt`). Trivial to ship; cheap credibility markers that serious sites have and most blogs don't.
- **`/privacy/` and `/about/` static pages**, even minimal. A research blog without an about page is anonymous; without a privacy page it's unmonetizable later.

## 8. Multi-Author & Investor-Tagging Specifics

- **Author schema (frontmatter-validated)** — `name`, `slug`, `bio`, `avatar`, `role`, `social: { twitter, wechat, email }`, `expertise: string[]`. A shared schema is what makes the author page render uniform without per-author templates.
- **Investor / entity schema** — `ticker`, `name_zh`, `name_en`, `aliases: string[]` (e.g. `["芒格", "Charlie Munger", "Munger"]`), `sector`, `market`. Aliases drive entity-tag recall — readers search by the name they know.
- **`/investors/` index** listing all referenced investors with post count and recency of last mention. The investor surface is the corpus's API; readers treat it like a screener.
- **Investor page (`/investors/<slug>/`)** with bio (sourced, dated), tag timeline (every post mentioning the investor), and a "立场演变" / view-history subsection when the author has changed calls — explicit acknowledgment of view changes *is* the provenance a research blog sells.
- **Methodology page (`/methodology/`)** — sources consulted, data refresh cadence, what the author commits to (and what they don't), how claims are sourced vs. asserted, and a dated log of methodology revisions. The single page that distinguishes a research blog from an opinion column; an opinion column can skip it, a research blog cannot.
- **Sources block at the article footer** — every external URL cited, deduplicated, with link text and access date. Makes the methodology page concrete per-post.
- **Co-author byline on joint posts** (`authors: [a, b]`), each linking to their author page. When multi-author goes live, this is the only schema change that actually requires code.
- **Per-investor and per-author RSS feeds**, already in §3. Cross-cutting feeds are how a serious reader maintains the subscriber relationship without re-subscribing to "the whole site" after every new contributor.
- **Disclosure footer on every investment-related post** — "本文不构成投资建议" plus, where applicable, the author's current positions in named tickers. Required for any blog that survives a regulator's attention; cheap to ship; impossible to retrofit credibly after the first complaint.
- **Time-stamped citations** — every link records `accessed: 2026-07-04`. Cited sources disappear; the access date is the difference between a citation and a 404.
