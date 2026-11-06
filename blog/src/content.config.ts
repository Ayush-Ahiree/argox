import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const posts = defineCollection({
  loader: glob({ pattern: "**/*.{md,mdx}", base: "./src/content/posts" }),
  schema: z.object({
    title: z.string(),
    // shown in search results -- keep it 140-160 characters
    description: z.string(),
    pubDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    author: z.string().default("Argox Team"),
    tags: z.array(z.string()).default([]),
    // the search phrase this post is written for (not rendered, just for us)
    keyword: z.string().optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    // cover art hue (0-360); covers are generated, no image files needed
    hue: z.number().default(160),
    glyph: z.string().default("◆"),
  }),
});

export const collections = { posts };
