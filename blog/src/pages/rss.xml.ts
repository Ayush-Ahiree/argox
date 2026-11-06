import rss from "@astrojs/rss";
import type { APIContext } from "astro";
import { getPosts, SITE_NAME, SITE_DESCRIPTION, u, abs } from "../lib/site";

export async function GET(_context: APIContext) {
  const posts = await getPosts();
  return rss({
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
    site: abs("/"),
    items: posts.map((p) => ({
      title: p.data.title,
      description: p.data.description,
      pubDate: p.data.pubDate,
      link: u(`/${p.id}/`),
      categories: p.data.tags,
    })),
  });
}
