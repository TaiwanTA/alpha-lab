import { glob } from 'astro/loaders';
// @ts-check
import { defineCollection, z } from 'astro:content';

const blog = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blog' }),
  schema: z.object({
    title: z.string(),
    date: z.string(), // ISO date
    summary: z.string(),
    status: z.enum(['verified', 'unverified']).default('unverified'),
    tags: z.array(z.string()).default([]),
  }),
});

export const collections = { blog };
