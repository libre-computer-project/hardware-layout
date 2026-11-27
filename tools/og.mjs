// Share tags (Open Graph) for a Libre Computer site's pages, drawn from what
// the page already says: og:title from <title>, og:description from the meta
// description, og:url from the canonical, and libre.computer's share image.
// Vendored into each site as tools/og.mjs by the kit's sync.py; edit the
// kit's copy, never a site's.
//
// The tags sit between <!-- og --> and <!-- /og --> after the description,
// so a second run replaces them rather than adding a second set.

import { readFile, writeFile } from "node:fs/promises";
import { fileOf } from "./lastmod.mjs";

export const OG_IMAGE = "https://libre.computer/images/ogImage.webp";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);
// the page's own text is already escaped HTML: decode it once before escaping
const unesc = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const BLOCK = /\n?<!-- og -->[\s\S]*?<!-- \/og -->/;

/** Pure: `html` with its share tags, or unchanged when it has no <title>. */
export function withOg(html, image = OG_IMAGE) {
  html = html.replace(BLOCK, "");
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1];
  if (!title) return html;
  const desc = html.match(/<meta name="description" content="([^"]*)"/)?.[1];
  const url = html.match(/<link rel="canonical" href="([^"]*)"/)?.[1];
  // a tag the page already carries outside the block is left to the page
  const has = (attr) => html.includes(attr);
  const tag = (p, v) => has(`property="og:${p}"`) ? null : `<meta property="og:${p}" content="${esc(unesc(v))}">`;
  const tags = [tag("type", "website"), tag("site_name", "Libre Computer"), tag("title", title),
    desc && tag("description", desc), url && tag("url", url), tag("image", image),
    has('name="twitter:card"') ? null : `<meta name="twitter:card" content="summary_large_image">`].filter(Boolean);
  if (!tags.length) return html;
  const block = `\n<!-- og -->\n${tags.join("\n")}\n<!-- /og -->`;
  const at = /<meta name="description"[^>]*>/.test(html) ? /(<meta name="description"[^>]*>)/ : /(<title>[^<]*<\/title>)/;
  return html.replace(at, (m) => m + block);
}

/** Write the share tags into each page of `urls` (already written under `root`). */
export async function stampOg(root, origin, urls) {
  for (const u of urls) {
    const f = fileOf(root, origin, u);
    const html = await readFile(f, "utf8");
    const out = withOg(html);
    if (out !== html) await writeFile(f, out);
  }
}
