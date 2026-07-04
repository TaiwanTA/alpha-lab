// @ts-check
// Build a TOC tree from markdown AST headings (h2/h3 only)
export interface TocEntry {
  depth: number;
  slug: string;
  text: string;
}

export function buildToc(headings: { depth: number; slug: string; text: string }[]): TocEntry[] {
  return headings
    .filter(h => h.depth === 2 || h.depth === 3)
    .map(h => ({
      depth: h.depth,
      slug: h.slug,
      text: h.text,
    }));
}
