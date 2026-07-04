// @ts-check
// Build search index at build time (per the canonical checklist).
// We're using a pre-segmented JSON index fed to MiniSearch on the client.

export interface SearchDocument {
  id: string;
  title: string;
  summary: string;
  tags: string[];
  investors: string[];
  body: string[]; // already segmented into words
  date: string;
  status: string;
}
// Pre-segment Chinese text using Intl.Segmenter
const intlAny = Intl as unknown as Record<string, any>;

// Pre-segment Chinese text using Intl.Segmenter
export function segmentCJK(text: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const segmenter = new intlAny.Segmenter('zh', { granularity: 'word' });
      const tokens: string[] = [];
      for (const seg of segmenter.segment(text)) {
        const t = seg.segment.trim();
        if (t && t.length > 0)
          tokens.push(t.toLowerCase());
      }
      return tokens;
    }
    catch {
      // fall through
    }
  }
  // Fallback: per-character
  return text.split('').filter(c => c.trim().length > 0).map(c => c.toLowerCase());
}

export function buildSearchBody(title: string, summary: string, body: string): string[] {
  const combined = `${title} ${summary} ${body}`;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    try {
      const segmenter = new intlAny.Segmenter('zh', { granularity: 'word' });
      const tokens: string[] = [];
      for (const seg of segmenter.segment(combined)) {
        const t = seg.segment.trim();
        if (t && t.length > 0)
          tokens.push(t);
      }
      return tokens;
    }
    catch {
      // fall through
    }
  }
  return combined.split(/\s+/).filter(Boolean);
}
