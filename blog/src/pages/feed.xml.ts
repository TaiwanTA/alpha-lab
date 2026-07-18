import type { APIRoute } from 'astro';
// @ts-check
import rss from '@astrojs/rss';
import { getPublishedPosts } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getPublishedPosts();
  return rss({
    title: 'alpha-lab',
    description: '研究公開投資人的言論、論點、與決策。每篇明示來源、可重複查證或標為未驗證。',
    site: context.site ?? 'https://alpha-lab.pages.dev',
    items: posts.map(post => ({
      title: post.data.title,
      pubDate: new Date(post.data.date),
      description: post.data.summary,
      link: `/posts/${post.id}`,
      categories: [...post.data.tags, ...post.data.investors],
      author: 'alpha-lab agent',
    })),
    customData: '<language>zh-TW</language>',
    stylesheet: false,
  });
};
