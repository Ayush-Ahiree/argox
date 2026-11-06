# Argox blog

Static Astro site served at `www.getargox.com/blog`. Every page is prerendered HTML
(good for SEO), with page transitions and reading tools added on top.

```bash
cd blog
npm install
npm run dev      # http://localhost:4321, drafts visible
npm run build    # static site in dist/
```

## Writing a post

Add a Markdown file to `src/content/posts/`. The filename becomes the URL
(`my-post.md` → `/my-post/`).

```markdown
---
title: "Post title (aim for under 60 characters)"
description: "Shown in Google results. 140-160 characters."
pubDate: 2026-11-20
tags: ["Claude Code", "Secrets"]
keyword: "the search phrase this post targets"
hue: 150        # cover colour, 0-360
glyph: "⌘"      # big character on the cover
draft: true     # remove to publish
---
```

Extras you can use in the Markdown:

- Callouts: `<aside class="tldr|note|warn"><span class="label">TL;DR</span> ...</aside>`
  (leave a blank line after the opening tag so Markdown inside renders).
- Verdict pills: `<span class="v block">Blocked</span>` (also `allow`, `ask`, `flag`).
- Tables stack into cards on phones automatically.

If a post quotes an Argox decision, run it through `agent/policy.py`'s
`evaluate_call()` first so the example is real.

The sitemap, RSS feed (`/rss.xml`) and article structured data are generated
automatically.

## Deploying

Nothing separate to deploy. The root `vercel.json` builds the homepage,
then this blog, and copies `blog/dist/` into the homepage output as
`/blog`, so every push to master deploys both. `base: "/blog"` in
`astro.config.mjs` is the only place the path lives; build links with
`u()` / `abs()` from `src/lib/site.ts`, never a hardcoded `/...`.

To preview the combined site locally, from the repo root:

```bash
(cd frontend && npm run build) && (cd blog && npm run build) \
  && rm -rf frontend/dist/blog && cp -r blog/dist frontend/dist/blog \
  && (cd frontend && npx vite preview)
```
