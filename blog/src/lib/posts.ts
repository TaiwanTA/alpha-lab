import type { CollectionEntry } from 'astro:content';
// @ts-check
import { getCollection } from 'astro:content';

export type Post = CollectionEntry<'blog'>;

const STATUS_RANK: Record<string, number> = {
  draft: 0,
  unverified: 1,
  corrected: 2,
  verified: 3,
};

export const STATUS_LABELS: Record<string, { label: string; color: string; hex: string }> = {
  draft: { label: 'draft', color: '#6b7280', hex: '草案 / 未發佈' },
  unverified: { label: 'unverified', color: '#92400e', hex: '未驗證 / 風格示範' },
  corrected: { label: 'corrected', color: '#1e40af', hex: '已驗證,內文含修正記錄' },
  verified: { label: 'verified', color: '#15803d', hex: '已逐項查證' },
};

export function sortByDateDesc(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => b.data.date.localeCompare(a.data.date));
}

export function sortByDateAsc(posts: Post[]): Post[] {
  return [...posts].sort((a, b) => a.data.date.localeCompare(b.data.date));
}

export async function getPublishedPosts(): Promise<Post[]> {
  const all = await getCollection('blog', ({ data }) => data.status !== 'draft');
  return sortByDateDesc(all);
}

export async function getAllPosts(): Promise<Post[]> {
  return sortByDateDesc(await getCollection('blog'));
}

export function getAllTags(posts: Post[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) {
      map.set(tag, (map.get(tag) ?? 0) + 1);
    }
  }
  return new Map([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

export function getAllInvestors(posts: Post[]): Map<string, Post[]> {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    for (const investor of post.data.investors) {
      const list = map.get(investor) ?? [];
      list.push(post);
      map.set(investor, list);
    }
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function getAllTickers(posts: Post[]): Map<string, Post[]> {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    for (const t of post.data.tickers) {
      const list = map.get(t) ?? [];
      list.push(post);
      map.set(t, list);
    }
  }
  return new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function getArchiveYears(posts: Post[]): Map<string, Post[]> {
  const map = new Map<string, Post[]>();
  for (const post of posts) {
    const year = post.data.date.slice(0, 4);
    const list = map.get(year) ?? [];
    list.push(post);
    map.set(year, list);
  }
  return map;
}

export function prevAndNext(allPosts: Post[], current: Post): { prev: Post | null; next: Post | null } {
  // allPosts assumed sorted by date ASC
  const i = allPosts.findIndex(p => p.id === current.id);
  return {
    prev: i > 0 ? allPosts[i - 1] : null,
    next: i >= 0 && i < allPosts.length - 1 ? allPosts[i + 1] : null,
  };
}

export function getStatusRank(status: string): number {
  return STATUS_RANK[status] ?? 0;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function slugifyTag(tag: string): string {
  return tag.replace(/[\s/]+/g, '-').toLowerCase();
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => {
    const map: Record<string, string> = {
      '<': '&lt;',
      '>': '&gt;',
      '&': '&amp;',
      '\'': '&apos;',
      '"': '&quot;',
    };
    return map[c] || c;
  });
}
