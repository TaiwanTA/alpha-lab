// @ts-check
import type { APIRoute } from 'astro';
import { getPublishedPosts } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getPublishedPosts();
  const feed = {
    version: 'https://jsonfeed.org/version/1.1',
    title: 'alpha-lab',
    home_page_url: context.site?.toString(),
    feed_url: new URL('/feed.json', context.site).toString(),
    language: 'zh-TW',
    description: '研究公開投資人的言論、論點、與決策。',
    items: posts.map(post => ({
      id: new URL(`/posts/${post.id}/`, context.site).toString(),
      url: new URL(`/posts/${post.id}/`, context.site).toString(),
      title: post.data.title,
      summary: post.data.summary,
      content_text: post.data.summary,
      date_published: new Date(post.data.date).toISOString(),
      date_modified: new Date(post.data.lastmod ?? post.data.date).toISOString(),
      tags: [...post.data.tags, ...post.data.investors],
      author: { name: 'alpha-lab agent' },
    })),
  };
  return new Response(JSON.stringify(feed, null, 2), {
    headers: { 'Content-Type': 'application/feed+json; charset=utf-8' },
  });
};
