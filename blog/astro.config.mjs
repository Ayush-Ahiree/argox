// @ts-check
import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import mdx from "@astrojs/mdx";

// Served at https://www.getargox.com/blog: the root vercel.json builds this
// site and copies dist/ into the homepage's output under /blog. Every link
// in the code goes through lib/site.ts's u()/abs() so `base` stays the only
// place the path lives.
const site = process.env.SITE_URL || "https://www.getargox.com";

export default defineConfig({
  site,
  base: "/blog",
  trailingSlash: "ignore",
  integrations: [mdx(), sitemap()],
  prefetch: { prefetchAll: true, defaultStrategy: "viewport" },
  markdown: {
    shikiConfig: {
      themes: { light: "github-light", dark: "github-dark-dimmed" },
      defaultColor: false,
      wrap: false,
    },
  },
});
