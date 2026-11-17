// Post-build step: inject the server-rendered homepage + FAQ structured
// data into dist/index.html, and write prerendered /pricing, /terms and
// /refunds pages to dist/<page>/index.html. Run after `vite build` and
// `vite build --ssr src/prerender-entry.jsx --outDir dist-ssr`.
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ssr = await import(pathToFileURL(path.join(root, "dist-ssr/prerender-entry.mjs")).href);

const file = path.join(root, "dist/index.html");
const template = readFileSync(file, "utf8");
if (!template.includes('<div id="root"></div>')) throw new Error("prerender: #root placeholder not found");
if (!template.includes("<!--faq-jsonld-->")) throw new Error("prerender: faq-jsonld placeholder not found");

// ---- homepage
const app = ssr.renderHome();
const ld = JSON.stringify(ssr.faqJsonLd()).replace(/</g, "\\u003c");
const home = template
  .replace('<div id="root"></div>', `<div id="root">${app}</div>`)
  .replace("<!--faq-jsonld-->", `<script type="application/ld+json">${ld}</script>`);
writeFileSync(file, home);
console.log(`prerender: homepage injected (${(app.length / 1024).toFixed(1)} KB)`);

// ---- /pricing, /terms, /refunds
const SITE = "https://www.getargox.com";
const esc = (s) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function swap(html, re, replacement, what) {
  if (!re.test(html)) throw new Error(`prerender: ${what} not found in index.html`);
  return html.replace(re, replacement);
}

for (const [page, meta] of Object.entries(ssr.PAGES)) {
  const url = `${SITE}/${page}`;
  let html = template.replace("<!--faq-jsonld-->", "");
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${esc(meta.title)}</title>`, "<title>");
  html = swap(html, /(<meta\s+name="description"\s+content=")[^"]*(")/, `$1${esc(meta.description)}$2`, "meta description");
  html = swap(html, /(<link rel="canonical" href=")[^"]*(")/, `$1${url}$2`, "canonical");
  html = swap(html, /(<meta property="og:url" content=")[^"]*(")/, `$1${url}$2`, "og:url");
  html = swap(html, /(<meta property="og:title" content=")[^"]*(")/, `$1${esc(meta.title)}$2`, "og:title");
  html = swap(html, /(<meta property="og:description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`, "og:description");
  html = swap(html, /(<meta name="twitter:title" content=")[^"]*(")/, `$1${esc(meta.title)}$2`, "twitter:title");
  html = swap(html, /(<meta name="twitter:description" content=")[^"]*(")/, `$1${esc(meta.description)}$2`, "twitter:description");
  const body = ssr.renderPage(page);
  html = html.replace('<div id="root"></div>', `<div id="root">${body}</div>`);
  mkdirSync(path.join(root, "dist", page), { recursive: true });
  writeFileSync(path.join(root, "dist", page, "index.html"), html);
  console.log(`prerender: /${page} written (${(body.length / 1024).toFixed(1)} KB)`);
}

rmSync(path.join(root, "dist-ssr"), { recursive: true, force: true });
