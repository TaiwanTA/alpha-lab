// @ts-check
import type { APIRoute } from 'astro';
import { escapeXml, getPublishedPosts } from '../lib/posts';

export const GET: APIRoute = async (context) => {
  const posts = await getPublishedPosts();
  const SITE = 'alpha-lab';
  const updated = new Date(posts[0]?.data.date ?? Date.now()).toISOString();

  const items = posts.map(post => `
    <entry>
      <title>${escapeXml(post.data.title)}</title>
      <link href="${new URL(`/posts/${post.id}/`, context.site).toString()}"/>
      <id>${new URL(`/posts/${post.id}/`, context.site).toString()}</id>
      <updated>${new Date(post.data.lastmod ?? post.data.date).toISOString()}</updated>
      <published>${new Date(post.data.date).toISOString()}</published>
      <summary>${escapeXml(post.data.summary)}</summary>
      <author><name>alpha-lab agent</name></author>
      ${[...post.data.tags, ...post.data.investors].map(t => `<category term="${escapeXml(t)}"/>`).join('')}
    </entry>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${SITE}</title>
  <link href="${context.site}"/>
  <link rel="self" href="${new URL('/feed.atom.xml', context.site).toString()}"/>
  <id>${context.site}</id>
  <updated>${updated}</updated>
  <subtitle>研究公開投資人的言論、論點、與決策</subtitle>
  <language>zh-TW</language>
  ${items}
</feed>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8' },
  });
};
