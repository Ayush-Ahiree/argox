// Post-build step: inject the server-rendered homepage + FAQ structured
// data into dist/index.html. Run after `vite build` and
// `vite build --ssr src/prerender-entry.jsx --outDir dist-ssr`.
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ssr = await import(pathToFileURL(path.join(root, "dist-ssr/prerender-entry.mjs")).href);

const file = path.join(root, "dist/index.html");
let html = readFileSync(file, "utf8");

const app = ssr.renderHome();
if (!html.includes('<div id="root"></div>')) throw new Error("prerender: #root placeholder not found");
html = html.replace('<div id="root"></div>', `<div id="root">${app}</div>`);

const ld = JSON.stringify(ssr.faqJsonLd()).replace(/</g, "\\u003c");
if (!html.includes("<!--faq-jsonld-->")) throw new Error("prerender: faq-jsonld placeholder not found");
html = html.replace("<!--faq-jsonld-->", `<script type="application/ld+json">${ld}</script>`);

writeFileSync(file, html);
rmSync(path.join(root, "dist-ssr"), { recursive: true, force: true });
console.log(`prerender: homepage injected (${(app.length / 1024).toFixed(1)} KB)`);
