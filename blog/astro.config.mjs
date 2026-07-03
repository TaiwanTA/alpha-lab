// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
// 純靜態站 — Cloudflare Pages 直接吃 dist/ 即可,不需要 adapter
// 若未來加 SSR,再加 @astrojs/cloudflare adapter
export default defineConfig({
  site: 'https://alpha-lab.pages.dev',
  trailingSlash: 'never',
  build: {
    format: 'directory',
  },
});
