#!/usr/bin/env node
/** Draws each board's parts list into a page of its own, so a reader or
 * crawler that runs no JavaScript (GPTBot, ClaudeBot, a link preview) gets
 * the board's connectors and main parts, and writes what a crawler looks for
 * beside them:
 *
 *   index.html              the board list in #parts-text, a canonical
 *   <id>/index.html         one page per board the site lists by default
 *   robots.txt, sitemap.xml, llms.txt
 *
 *     node tools/render.mjs        (Node 18+, no dependencies)
 *
 * The content comes from js/parts.js, the same functions js/app.js redraws
 * the list with in the browser, fed from this repository's data/. A board
 * hidden by default (shown only under ?hidden=1) gets no page and no sitemap
 * entry. Running it twice changes nothing. Run it after the data changes and
 * commit its output (README "Publishing").
 */
import { readFile, writeFile, mkdir, readdir, rm, rmdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { sitemapWithLastmod } from "./lastmod.mjs";
import { stampOg } from "./og.mjs";

/** The kit's rows as tools/lc-ui-kit/sync.py last wrote them into this
 *  board page -- the top bar (Products current on a board's page) and the
 *  second row (the board's menu and breadcrumbs): kept, so a render alone
 *  changes nothing; sync.py rewrites them when the kit moves. */
const KIT_ROWS = [/[ \t]*<nav class="lc-sites"[\s\S]*?<\/nav>/, /[ \t]*<div class="lc-subnav-sites">[\s\S]*?<\/div>/];
async function keepKitRow(file, html) {
  const old = await readFile(file, "utf8").catch(() => "");
  for (const row of KIT_ROWS) {
    const kept = old.match(row);
    if (kept && row.test(html)) html = html.replace(row, () => kept[0]);
  }
  return html;
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const parts = await import(pathToFileURL(path.join(ROOT, "js/parts.js")).href);
const { ORIGIN, esc, pageUrl } = parts;

const read = (f) => readFile(path.join(ROOT, f), "utf8");
const json = async (f) => JSON.parse(await read(f));
const meta = (html, re) => (html.match(re) || [, ""])[1];

/** A page with `content` in its #parts-text and a canonical for `url`. The
 *  content ends with a marker, so a second run replaces it rather than nesting. */
function fill(html, content, url) {
  html = html.replace(/<div id="parts-text">(?:[\s\S]*?<\/div><!-- \/parts -->|<\/div>)/,
    () => `<div id="parts-text">${content}</div><!-- /parts -->`);
  const canon = `<link rel="canonical" href="${esc(url)}">`;
  return /<link rel="canonical"[^>]*>/.test(html)
    ? html.replace(/<link rel="canonical"[^>]*>/, () => canon)
    : html.replace(/(<meta name="description"[^>]*>)/, (m) => `${m}\n${canon}`);
}

const index = (await json("data/boards.json")).boards;
const listed = index.filter((b) => !b.hidden);

// The home page: the list of boards, linked to their pages
const homeFile = "index.html";
let home = await read(homeFile);
// what the tool shows (the page's description) above the list of boards
const homeDesc = (home.match(/<meta name="description" content="([^"]*)"/) || [, ""])[1]
  .replace(/&quot;/g, '"').replace(/&amp;/g, "&");
home = fill(home, parts.boardListHtml(index, homeDesc), `${ORIGIN}/`);
if (!home.includes('id="parts-text"')) throw new Error("index.html has no <div id=\"parts-text\">");
await writeFile(path.join(ROOT, homeFile), home);

// One page per listed board, from the home page's HTML one level down
const sitemap = [`${ORIGIN}/`];
for (const row of listed) {
  const board = await json(`data/${row.id}.json`);
  const html = fill(home, parts.partsHtml(board), pageUrl(row.id))
    .replace(/<title>[^<]*<\/title>/, () => `<title>${esc(parts.pageTitle(row))}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, (_, a) => `${a}${esc(parts.pageDescription(row, board))}"`)
    .replace(/<h1 class="lc-vh">[^<]*<\/h1>/, () => `<h1 class="lc-vh">${esc(parts.boardName(row))} board layout</h1>`)
    .replace(/<body>/, () => `<body data-board="${esc(row.id)}">`)
    // the page is one level down: its own files are in the parent
    .replace(/(<link rel="stylesheet" href=")(css\/)/g, "$1../$2")
    .replace(/(<script type="module" src=")(js\/)/g, "$1../$2");
  await mkdir(path.join(ROOT, row.id), { recursive: true });
  await writeFile(path.join(ROOT, row.id, "index.html"), await keepKitRow(path.join(ROOT, row.id, "index.html"), html));
  sitemap.push(pageUrl(row.id));
}
// a board that left the list (or became hidden): its page goes too (only
// pages this wrote, which carry data-board)
for (const d of await readdir(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory() || listed.some((b) => b.id === d.name)) continue;
  const f = path.join(ROOT, d.name, "index.html");
  if (!(await readFile(f, "utf8").catch(() => "")).includes("<body data-board=")) continue;
  await rm(f);
  await rmdir(path.dirname(f)).catch(() => {});  // only if nothing else is in it
}

await writeFile(path.join(ROOT, "robots.txt"), `User-agent: *\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\nAllow: /\n\nSitemap: ${ORIGIN}/sitemap.xml\n`);
await stampOg(ROOT, ORIGIN, sitemap);
await writeFile(path.join(ROOT, "sitemap.xml"), await sitemapWithLastmod(ROOT, ORIGIN, sitemap));

const title = meta(home, /<title>([^<]*)<\/title>/);
await writeFile(path.join(ROOT, "llms.txt"), [
  `# ${title}`, "",
  `> ${meta(home, /<meta name="description" content="([^"]*)"/)}`, "",
  "Part of Libre Computer (https://libre.computer/llms.txt). Each board's page carries its connectors and main parts as HTML.", "",
  "## Boards", "",
  // each line: what the page's own summary line says (parts.boardFacts), and its connector count
  ...await Promise.all(listed.map(async (b) => {
    const board = await json(`data/${b.id}.json`);
    const conns = ["top", "bot"].flatMap((s) => board.components?.[s] || []).filter((c) => c.c === "connector").length;
    return `- [${parts.boardName(b)}](${pageUrl(b.id)}): ${parts.boardFacts(board)}, ${conns} connectors`;
  })), "",
].join("\n"));

console.log(`rendered index.html, ${listed.length} board pages (${index.length - listed.length} hidden boards skipped), robots.txt, sitemap.xml, llms.txt`);
