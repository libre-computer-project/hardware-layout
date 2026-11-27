// Sitemap <lastmod> for a Libre Computer site: the date each page's <main>
// last changed. Vendored into each site as tools/lastmod.mjs by the kit's
// sync.py; edit the kit's copy, never a site's.
//
// The dates are kept in tools/lastmod.json, one {hash, date} per URL. A page
// whose <main> hashes as before keeps its date, so a render that changes
// nothing changes no date, and a kit sync (header, row, footer: outside
// <main>) dates no page. A changed or new page is dated today. A URL the
// ledger has never seen is dated by the last commit touching its file, when
// the checkout has that history, so a first render does not date every page
// today.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** The text a page's date follows: its <main>, else the whole page. */
export function mainOf(html) {
  const m = html.match(/<main\b[\s\S]*?<\/main>/i);
  return m ? m[0] : html;
}

const hash = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The page file behind a URL on `origin`: a path ending in / is its index.html. */
export function fileOf(root, origin, url) {
  let p = url.slice(origin.replace(/\/$/, "").length) || "/";
  if (p.endsWith("/")) p += "index.html";
  return path.join(root, p);
}

function commitDate(root, file) {
  try {
    const out = execFileSync("git", ["-C", root, "log", "-1", "--format=%cs", "--", path.relative(root, file)],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(out) ? out : null;
  } catch { return null; }
}

/** Pure: the new ledger for `pages` ({url, html}) given the old one.
 *  `seed(url)` dates a URL the ledger has never seen (null: today). */
export function dateLedger(old, pages, today, seed = () => null) {
  const next = {};
  for (const { url, html } of pages) {
    const h = hash(mainOf(html));
    const was = old[url];
    next[url] = { hash: h, date: was?.hash === h ? was.date : (!was && seed(url)) || today };
  }
  return next;
}

/** The sitemap for `urls` (already written under `root`), with <lastmod>,
 *  updating tools/lastmod.json. Returns the sitemap.xml text. */
export async function sitemapWithLastmod(root, origin, urls, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const ledgerFile = path.join(root, "tools", "lastmod.json");
  const old = JSON.parse(await readFile(ledgerFile, "utf8").catch(() => "{}"));
  const pages = await Promise.all(urls.map(async (url) => ({ url, html: await readFile(fileOf(root, origin, url), "utf8") })));
  const ledger = dateLedger(old, pages, today, (url) => commitDate(root, fileOf(root, origin, url)));
  await writeFile(ledgerFile, JSON.stringify(ledger, null, 1) + "\n");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((u) => `  <url><loc>${esc(u)}</loc><lastmod>${ledger[u].date}</lastmod></url>`).join("\n")}\n</urlset>\n`;
}
