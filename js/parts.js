/* The board's parts list as plain HTML -- its connectors and main parts by
 * reference designator, with the labels its data/<id>.json publishes -- so a
 * reader or crawler that runs no JavaScript still learns what is on the board.
 *
 * ONE renderer, two callers: tools/render.mjs draws it into each board's
 * static page (<id>/index.html), and js/app.js redraws it in place when the
 * viewer changes board on the home page (?board=). Pure functions of the
 * site's own data: nothing here touches the DOM or `location`, so Node can
 * import it. Only fields already in the published data are shown.
 */

export const ORIGIN = "https://layout.hardware.libre.computer";

/* The classes listed, in this order: what a reader looking for "what is on
   this board" means. Passives, diodes and the rest are in the viewer. */
const MAIN = [["connector", "Connectors"], ["ic", "ICs"]];

/* The component properties that describe a part (the rest are ratings and
   heights, which the viewer's detail panel shows). */
const LABEL_KEYS = ["Part_Type", "PartType", "Value"];

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

const byRef = (a, b) => a.r.localeCompare(b.r, "en", { numeric: true });

/** "Le Potato (AML-S905X-CC)" from a boards.json row or a data/<id>.json. */
export const boardName = (b) => `${b.name} (${b.model})`;

/** The words a part's published properties give it, without repeating its
 *  footprint (some exports put the footprint in PartType). */
function label(c) {
  const seen = new Set([String(c.f || "").toLowerCase()]);
  const out = [];
  for (const k of LABEL_KEYS) {
    const v = c.prop?.[k];
    if (v == null || v === "") continue;
    const s = String(v);
    if (seen.has(s.toLowerCase())) continue;
    seen.add(s.toLowerCase());
    out.push(s);
  }
  return out.join(" · ");
}

/** One line of board facts: revision, SoC, size, layers, parts, nets. */
export function boardFacts(board) {
  const o = board.outline || {};
  const parts = (board.components?.top || []).length + (board.components?.bot || []).length;
  const layers = (board.copper_index || []).length;
  const nets = Object.keys(board.nets || {}).length;
  const bits = [];
  if (board.rev) bits.push(`revision ${board.rev}`);
  if (board.soc) bits.push(`${board.soc} SoC`);
  if (o.w != null && o.h != null) bits.push(`${o.w} × ${o.h} mm`);
  bits.push(layers ? `${layers} copper layers` : "no copper layers in this export");
  bits.push(`${parts} placed parts`);
  if (nets) bits.push(`${nets} nets`);
  return bits.join(", ");
}

/** The parts list of one board (its data/<id>.json), as a disclosure. */
export function partsHtml(board) {
  const sides = [["top", "Top"], ["bot", "Bottom"]];
  const tables = MAIN.map(([cat, title]) => {
    const rows = sides.flatMap(([key, side]) =>
      (board.components?.[key] || []).filter((c) => c.c === cat).map((c) => ({ c, side })))
      .sort((a, b) => byRef(a.c, b.c));
    if (!rows.length) return "";
    const body = rows.map(({ c, side }) => {
      const words = label(c);
      const pins = c.p ? `, ${c.p} pins` : "";
      return `<tr><th scope="row">${esc(c.r)}</th><td>${words ? `${esc(words)}<br>` : ""}` +
        `<span class="fp">${esc(c.f || "")}${esc(pins)}</span></td><td>${side}</td></tr>`;
    }).join("");
    return `<table class="lc-table parts-table"><caption>${title} (${rows.length})</caption>` +
      `<thead><tr><th scope="col">Ref</th><th scope="col">Part</th><th scope="col">Side</th></tr></thead>` +
      `<tbody>${body}</tbody></table>`;
  }).join("");
  return `<details class="parts-text"><summary>${esc(boardName(board))}: connectors and main parts</summary>` +
    `<p>${esc(boardName(board))}: ${esc(boardFacts(board))}.</p>${tables}</details>`;
}

/** The home page's list: every board the site lists by default, linked to
 *  its own page. `rows` are data/boards.json rows. */
export function boardListHtml(rows, lede = "") {
  const items = rows.filter((b) => !b.hidden).map((b) => {
    const size = Array.isArray(b.size_mm) ? `, ${b.size_mm[0]} × ${b.size_mm[1]} mm` : "";
    return `<li><a href="/${esc(b.id)}/">${esc(boardName(b))}</a> ${esc(b.soc)}${esc(size)}</li>`;
  }).join("");
  // `lede`: what the tool shows (the home page's description), for a reader
  // that arrives without the drawing
  return `<details class="parts-text"><summary>Boards</summary>${lede ? `<p>${esc(lede)}</p>` : ""}<ul>${items}</ul></details>`;
}

/** A board page's <title> and description. */
export const pageTitle = (row) => `${boardName(row)} Board Layout — Libre Computer`;

export function pageDescription(row, board) {
  const o = board.outline || {};
  const size = o.w != null && o.h != null ? `, ${o.w} × ${o.h} mm` : "";
  const routing = (board.copper_index || []).length ? " and copper routing" : "";
  return `${boardName(row)} PCB layout${size}: its connectors and main parts by reference ` +
    `designator, and an interactive viewer of every part's placement${routing}, read from the board's own CAD data.`;
}

/** The board's own page, under ORIGIN. */
export const pageUrl = (id) => `${ORIGIN}/${encodeURIComponent(id)}/`;
