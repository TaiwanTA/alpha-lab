// @ts-check
import type { APIRoute } from 'astro';
import { getPublishedPosts } from '../lib/posts';
import { buildSearchBody } from '../lib/search-index';

export const GET: APIRoute = async () => {
  const posts = await getPublishedPosts();
  const docs = posts.map(post => ({
    id: post.id,
    title: post.data.title,
    summary: post.data.summary,
    tags: post.data.tags,
    investors: post.data.investors,
    body: buildSearchBody(post.data.title, post.data.summary, post.body ?? ''),
    date: post.data.date,
    status: post.data.status,
  }));
  return new Response(JSON.stringify(docs), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
