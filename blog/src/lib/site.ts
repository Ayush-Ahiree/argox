import { getCollection, type CollectionEntry } from "astro:content";

export const SITE_NAME = "Argox Blog";
export const SITE_DESCRIPTION =
  "Practical AI agent security: how agents leak data, how prompt injection works in the real world, and how to stop it before the tool call runs.";
export const MAIN_SITE = "https://www.getargox.com";

// The blog lives under a base path (astro.config.mjs `base`). Build every
// link with these instead of writing "/..." by hand.
const BASE = import.meta.env.BASE_URL.replace(/\/$/, ""); // "/blog"
/** Site-relative link, e.g. u("/my-post/") -> "/blog/my-post/". */
export function u(path = "/"): string {
  return BASE + (path.startsWith("/") ? path : `/${path}`);
}
/** Absolute URL for canonical tags, JSON-LD, feeds. */
export function abs(path = "/"): string {
  return new URL(u(path), import.meta.env.SITE).href;
}
export const SIGNUP_URL = "https://www.getargox.com/signup";
export const GITHUB_URL = "https://github.com/Ayush-Ahiree/argox";

export type Post = CollectionEntry<"posts">;

/** Published posts, newest first (drafts only show in `astro dev`). */
export async function getPosts(): Promise<Post[]> {
  const all = await getCollection("posts", ({ data }) => import.meta.env.DEV || !data.draft);
  return all.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf() || Number(b.data.featured) - Number(a.data.featured));
}

export function readingTime(body = ""): number {
  const words = body.replace(/```[\s\S]*?```/g, " ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

export function tagSlug(tag: string): string {
  return tag.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
