import { glob } from 'astro/loaders';
// @ts-check
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.string(), // ISO date (publish date)
    lastmod: z.string().optional(), // ISO date (last modified)
    summary: z.string(),
    status: z.enum(['draft', 'unverified', 'verified', 'corrected']).default('unverified'),
    tags: z.array(z.string()).default([]),
    // 系列:若屬於多篇序列,例如 "Burry 系列(1/3)"
    series: z.string().optional(),
    part: z.number().optional(),
    seriesTotal: z.number().optional(),
    // 投資人 entity(tags(同主題)分開)
    investors: z.array(z.string()).default([]), // 例如 ["Michael Burry", "Ray Dalio"]
    tickers: z.array(z.string()).default([]), // 例如 ["GS", "JPM"]
    // 揭露:是否有投資相關論斷
    investmentClaim: z.boolean().default(false),
  }),
});

export const collections = { blog };
