/* Libre Computer Board Layout — where every part sits on the board.
 *
 * The data is what tools/gen-layout-data.py writes out of the ODB++ export:
 * data/<id>.json is the placement, and data/<id>.copper.json is the routing.
 * The second is three to five times the size of the first and most visitors
 * never ask for it, so it is fetched the first time a copper layer is switched
 * on and not before. Everything else on the page works while it is absent.
 */

"use strict";

import { mountShell, token } from "./lc-kit.js";

/* Category display names, and the order the sidebar lists them in. The order
   is by how much of the board the class explains, not alphabetical: someone
   looking for "the big chips" should not have to scroll past the resistors. */
const CAT_NAMES = {
  ic: "ICs",
  connector: "Connectors",
  transistor: "Transistors",
  diode: "Diodes",
  passive_l: "Inductors",
  passive_c: "Capacitors",
  passive_r: "Resistors",
  esd: "ESD",
  mounting: "Mounting",
  other: "Other",
};
const CAT_ORDER = Object.keys(CAT_NAMES);

const COPPER_VARS = ["--cu-1", "--cu-2", "--cu-3", "--cu-4",
                     "--cu-5", "--cu-6", "--cu-7", "--cu-8"];

/* Pre-production and unreleased boards ship in the data but stay out of the
   picker until ?hidden=1 asks for them. The same vocabulary as the pinout
   site, plus `reference` for a silicon vendor's own design. */
const STATUS_LABEL = {
  preprod: "pre-production",
  unreleased: "unreleased",
  reference: "vendor reference design",
};

const $ = (id) => document.getElementById(id);

const els = {
  select: $("board-select"),
  search: $("search"),
  brand: document.querySelector(".lc-brand"),
  notices: $("notices"),
  meta: $("board-meta"),
  sideSeg: $("side-seg"),
  copper: $("copper-toggles"),
  copperNote: $("copper-note"),
  cats: $("cat-toggles"),
  list: $("comp-list"),
  detail: $("detail"),
  stage: $("stage"),
  canvas: $("canvas"),
  tooltip: $("tooltip"),
  hud: $("hud"),
  spinner: $("spinner"),
};

/* Not const: the copper cache below renders the same drawing code into an
   offscreen canvas by swapping this for a frame. */
let ctx = els.canvas.getContext("2d");

/* Every colour the board is drawn in comes from a CSS token, so the one
   stylesheet decides both themes. A canvas is the exception no stylesheet can
   reach, which is why the kit announces a theme change rather than only
   applying it -- see the themechange listener in wireEvents. */
const cssVar = token;

/* ---- state --------------------------------------------------------------- */

let boardIndex = [];      /* every row of data/boards.json */
let visibleBoards = [];   /* the ones this visitor may pick */
let showHidden = false;

let board = null;         /* the loaded data/<id>.json */
let meta = null;          /* its boards.json row */
let copper = null;        /* data/<id>.copper.json, once fetched */
let copperReq = null;     /* the in-flight fetch, so two clicks make one request */

let side = "top";
let hiddenCats = new Set();
let visibleCopper = new Set();
let selected = null;      /* refdes */
let hovered = null;       /* component object */
let term = "";
let shown = [];           /* components passing the category + search filter */
let netHi = null;

let vx = 0, vy = 0, vs = 1;   /* board mm -> screen px */

/* ---- boot ---------------------------------------------------------------- */

async function init() {
  mountShell();
  let index;
  try {
    index = await getJSON("data/boards.json");
  } catch (e) {
    notice("Could not load the board index. If you are opening this from a " +
           "file:// path, serve the directory over HTTP instead — " +
           "<code>python3 -m http.server</code>.", "error");
    return;
  }
  boardIndex = index.boards;

  const params = new URLSearchParams(location.search);
  showHidden = ["1", "true", "yes"].includes((params.get("hidden") || "").toLowerCase());
  visibleBoards = boardIndex.filter((b) => showHidden || !b.hidden);
  buildSelect();
  markHiddenMode();

  const wanted = params.get("board");
  const start = visibleBoards.find((b) => b.id === wanted) ||
                visibleBoards.find((b) => b.id === "aml-a311d-cc") ||
                visibleBoards[0];
  /* A query string cannot 404 — index.html exists, so ?board=<anything> is a
     200 on any host. Falling back silently would therefore show a DIFFERENT
     board's layout to someone who asked for a specific one, and a board view
     looks authoritative whichever board it is. Say so instead. */
  if (wanted && start && start.id !== wanted) {
    const existsButUnlisted = boardIndex.some((b) => b.id === wanted);
    notice(existsButUnlisted
      ? `“${wanted}” is not listed publicly. Showing ${start.name} instead.`
      : `No board “${wanted}”. Showing ${start.name} instead.`);
  }
  if (!start) {
    notice("The board index is empty.", "error");
    return;
  }

  els.select.value = start.id;
  wireEvents();
  await loadBoard(start.id);
}

function getJSON(url) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  });
}

function notice(html, cls) {
  const p = document.createElement("p");
  p.className = "lc-notice" + (cls ? " " + cls : "");
  p.setAttribute("role", "status");
  p.innerHTML = html;
  els.notices.appendChild(p);
}

function buildSelect() {
  els.select.textContent = "";
  for (const vendor of [...new Set(visibleBoards.map((b) => b.vendor))]) {
    const g = document.createElement("optgroup");
    g.label = vendor;
    for (const b of visibleBoards.filter((b) => b.vendor === vendor)) {
      const o = document.createElement("option");
      o.value = b.id;
      o.textContent = `${b.name} (${b.model})` +
        (STATUS_LABEL[b.status] ? ` — ${STATUS_LABEL[b.status]}` : "");
      g.appendChild(o);
    }
    els.select.appendChild(g);
  }
}

/* Say so, loudly, when the picker is showing boards nobody can buy yet. */
function markHiddenMode() {
  if (!showHidden) return;
  const n = boardIndex.filter((b) => b.hidden).length;
  const flag = document.createElement("span");
  flag.className = "lc-flag";
  flag.textContent = `+${n} unlisted`;
  flag.title = "?hidden=1 — pre-production, unreleased and reference designs are listed";
  els.brand.appendChild(flag);
}

/* ---- loading a board ----------------------------------------------------- */

async function loadBoard(id) {
  meta = boardIndex.find((b) => b.id === id) || null;
  spin(true);
  try {
    board = await getJSON(`data/${id}.json`);
  } catch (e) {
    spin(false);
    notice(`Could not load ${id}: ${e.message}`, "error");
    return;
  }
  /* Every per-board view control resets, because it described the OLD board.
     A copper layer index, a category filter and a selected refdes all mean
     something different on the next board, and a filter that outlived the
     switch hides parts with nothing on screen saying why. */
  copper = null;
  copperReq = null;
  invalidateCopperCache();
  visibleCopper.clear();
  hiddenCats.clear();
  selected = null;
  hovered = null;
  netHi = null;
  side = "top";
  term = "";
  els.search.value = "";

  renderMeta();
  buildSideSeg();
  buildCopperToggles();
  buildCatToggles();
  applyFilter();
  fitView();
  draw();
  spin(false);

  const url = new URL(location.href);
  url.searchParams.set("board", id);
  if (showHidden) url.searchParams.set("hidden", "1");
  history.replaceState(null, "", url);
}

function spin(on, label) {
  els.spinner.hidden = !on;
  if (on) els.spinner.textContent = label || "Loading…";
}

/* The routing arrives only when someone asks to see it. Two rapid clicks share
   one request; a failure leaves the toggles off rather than half-on. */
async function ensureCopper() {
  if (copper) return copper;
  if (!board.copper_file) return null;
  if (!copperReq) {
    spin(true, "Loading copper layers…");
    copperReq = getJSON(`data/${board.copper_file}`)
      .then((c) => { copper = c; return c; })
      .catch((e) => {
        notice(`Could not load the copper layers: ${e.message}`, "error");
        visibleCopper.clear();
        buildCopperToggles();
        return null;
      })
      .finally(() => { spin(false); copperReq = null; });
  }
  return copperReq;
}

/* ---- sidebar ------------------------------------------------------------- */

function renderMeta() {
  const o = board.outline;
  const parts = (board.components.top || []).length + (board.components.bot || []).length;
  const bits = [
    `<b>${esc(board.model)}</b> ${esc(board.rev || "")}`,
    `${esc(board.name)} · ${esc(board.soc)}`,
    `${o.w} &times; ${o.h} mm · ${board.copper_index.length} copper layers`,
    `${parts} placed parts · ${Object.keys(board.nets).length} nets`,
  ];
  let html = bits.join("<br>");
  if (meta && STATUS_LABEL[meta.status]) {
    html += `<br><span class="status unlisted">${esc(STATUS_LABEL[meta.status])}</span>`;
  }
  /* Two products can be one PCB. AML-A311D-CC and AML-S905D3-CC are the same
     layout with a different SoC fitted — the G12 package is common to both —
     so their board views are identical, and a reader who noticed that deserves
     to be told it is the hardware and not a mix-up in the data. */
  if (meta && meta.shares_layout_with) {
    const other = boardIndex.find((b) => b.id === meta.shares_layout_with);
    if (other && (showHidden || !other.hidden)) {
      html += `<br><span class="status">same PCB as ` +
        `<a href="?board=${other.id}${showHidden ? "&hidden=1" : ""}">${esc(other.model)}</a></span>`;
    }
  }
  els.meta.innerHTML = html;
}

function buildSideSeg() {
  els.sideSeg.textContent = "";
  for (const [key, label] of [["top", "Top"], ["bot", "Bottom"]]) {
    if (!board.components[key]) continue;
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("aria-pressed", String(side === key));
    b.onclick = () => setSide(key);
    els.sideSeg.appendChild(b);
  }
}

function setSide(key) {
  if (side === key || !board.components[key]) return;
  side = key;
  /* The category filter is per side: the bottom of a board is mostly passives
     and carries classes the top does not, so a filter carried across reads as
     parts having vanished. */
  hiddenCats.clear();
  selected = null;
  hovered = null;
  buildSideSeg();
  buildCatToggles();
  applyFilter();
  showDetail();
  draw();
}

function buildCopperToggles() {
  els.copper.textContent = "";
  const layers = board.copper_index || [];
  if (!layers.length) {
    els.copperNote.textContent = "This export carries no copper layers.";
    return;
  }
  els.copperNote.textContent = board.copper_file && !copper
    ? "Routing loads when you switch a layer on."
    : "";
  layers.forEach((l, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lc-toggle";
    b.setAttribute("aria-pressed", String(visibleCopper.has(i)));
    b.innerHTML =
      `<span class="lc-swatch" style="background:${cssVar(COPPER_VARS[i % 8])}"></span>` +
      `<span class="lc-name">${esc(l.label || l.name)}</span>` +
      `<span class="lc-count">${l.traces}T ${l.pads}P</span>`;
    b.onclick = () => toggleCopper(i);
    els.copper.appendChild(b);
  });
}

async function toggleCopper(i) {
  if (visibleCopper.has(i)) visibleCopper.delete(i);
  else visibleCopper.add(i);
  buildCopperToggles();
  draw();
  if (visibleCopper.size) {
    await ensureCopper();
    buildCopperToggles();
    draw();
  }
}

function buildCatToggles() {
  els.cats.textContent = "";
  const cats = board.categories[side] || {};
  const keys = Object.keys(cats).sort(
    (a, b) => (CAT_ORDER.indexOf(a) + 99) % 100 - (CAT_ORDER.indexOf(b) + 99) % 100);
  for (const cat of keys) {
    const info = cats[cat];
    const b = document.createElement("button");
    b.type = "button";
    b.className = "lc-toggle";
    b.setAttribute("aria-pressed", String(!hiddenCats.has(cat)));
    b.innerHTML =
      `<span class="lc-swatch" style="background:${info.color}"></span>` +
      `<span class="lc-name">${esc(CAT_NAMES[cat] || cat)}</span>` +
      `<span class="lc-count">${info.count}</span>`;
    b.onclick = () => {
      if (hiddenCats.has(cat)) hiddenCats.delete(cat);
      else hiddenCats.add(cat);
      buildCatToggles();
      applyFilter();
      draw();
    };
    els.cats.appendChild(b);
  }
}

/* ---- filtering + the component list -------------------------------------- */

function comps() { return board ? (board.components[side] || []) : []; }

function applyFilter() {
  const t = term.trim().toLowerCase();
  shown = comps().filter((c) =>
    !hiddenCats.has(c.c) &&
    (t === "" || c.r.toLowerCase().includes(t) || (c.f || "").toLowerCase().includes(t)));
  buildList();
}

/* The list is virtualised: a board's bottom side runs to ~500 parts and the
   search re-runs on every keystroke, so only the rows in view are built. */
const ROW_H = 22;

function buildList() {
  let inner = $("comp-list-inner");
  if (!inner) {
    inner = document.createElement("div");
    inner.id = "comp-list-inner";
    els.list.textContent = "";
    els.list.appendChild(inner);
    els.list.onscroll = paintRows;
  }
  inner.style.height = shown.length * ROW_H + "px";
  paintRows();
}

function paintRows() {
  const inner = $("comp-list-inner");
  if (!inner) return;
  const first = Math.max(0, Math.floor(els.list.scrollTop / ROW_H) - 2);
  const last = Math.min(shown.length,
                        first + Math.ceil((els.list.clientHeight || 240) / ROW_H) + 4);
  const out = [];
  for (let i = first; i < last; i++) {
    const c = shown[i];
    out.push(
      `<div class="comp-item" role="option" data-r="${esc(c.r)}" ` +
      `aria-selected="${c.r === selected}" style="top:${i * ROW_H}px">` +
      `${esc(c.r)}<span class="fp">${esc(c.f || "")}</span></div>`);
  }
  inner.innerHTML = out.join("");
  for (const el of inner.children) {
    el.onclick = () => select(el.dataset.r, true);
  }
}

function select(refdes, zoom) {
  selected = selected === refdes ? null : refdes;
  paintRows();
  showDetail();
  if (selected && zoom) zoomTo(selected);
  draw();
}

function showDetail() {
  const c = comps().find((x) => x.r === selected);
  if (!c) { els.detail.textContent = ""; return; }
  const rows = [
    ["Footprint", c.f || "—"],
    ["Class", CAT_NAMES[c.c] || c.c],
    ["Side", side === "top" ? "Top" : "Bottom"],
    ["Position", `${c.x}, ${c.y} mm`],
    ["Size", `${c.w} × ${c.h} mm`],
    ["Rotation", `${c.rot || 0}°`],
    ["Pins", c.p != null ? String(c.p) : "—"],
  ];
  if (c.z != null) rows.push(["Height", `${c.z} mm`]);
  for (const [k, v] of Object.entries(c.prop || {})) rows.push([k, String(v)]);
  els.detail.innerHTML =
    `<h4>${esc(c.r)}</h4><dl>` +
    rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("") +
    "</dl>";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---- the view transform -------------------------------------------------- */

function stageSize() {
  return [els.stage.clientWidth, els.stage.clientHeight];
}

function fitView() {
  const [cw, ch] = stageSize();
  const o = board.outline;
  /* Parts can overhang the board edge — a USB receptacle, a card slot — and a
     fit that used the outline alone cropped them off the first frame. */
  let [minX, minY] = o.min, [maxX, maxY] = o.max;
  for (const c of comps()) {
    minX = Math.min(minX, c.x - c.w / 2); maxX = Math.max(maxX, c.x + c.w / 2);
    minY = Math.min(minY, c.y - c.h / 2); maxY = Math.max(maxY, c.y + c.h / 2);
  }
  const m = 24;
  vs = Math.min((cw - 2 * m) / (maxX - minX), (ch - 2 * m) / (maxY - minY));
  vx = (cw - (maxX - minX) * vs) / 2 - minX * vs;
  vy = (ch - (maxY - minY) * vs) / 2 + maxY * vs;   /* y is flipped: CAD is up */
}

function zoomTo(refdes) {
  const c = comps().find((x) => x.r === refdes);
  if (!c) return;
  const [cw, ch] = stageSize();
  const m = 70;
  const want = Math.min((cw - 2 * m) / Math.max(c.w, 8), (ch - 2 * m) / Math.max(c.h, 8));
  vs = Math.min(want, vs * 1.8);          /* zoom in toward it, never back out */
  vx = cw / 2 - c.x * vs;
  vy = ch / 2 + c.y * vs;
}

const sx = (x) => x * vs + vx;
const sy = (y) => -y * vs + vy;
const bx = (px) => (px - vx) / vs;
const by = (py) => -(py - vy) / vs;

/* ---- drawing ------------------------------------------------------------- */

function draw() {
  if (!board) return;
  const [cw, ch] = stageSize();
  const dpr = window.devicePixelRatio || 1;
  if (els.canvas.width !== Math.round(cw * dpr) || els.canvas.height !== Math.round(ch * dpr)) {
    els.canvas.width = Math.round(cw * dpr);
    els.canvas.height = Math.round(ch * dpr);
    els.canvas.style.width = cw + "px";
    els.canvas.style.height = ch + "px";
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  ctx.fillStyle = cssVar("--stage-bg");
  ctx.fillRect(0, 0, cw, ch);

  const cuOn = visibleCopper.size > 0 && copper;
  drawOutline(cuOn);
  if (cuOn) drawCopper();

  /* Small parts first so a 0402 never disappears under the SoC, and the
     selected part last so it is never covered by anything. */
  const order = shown.slice().sort((a, b) => {
    const s = (a.r === selected ? 1 : 0) - (b.r === selected ? 1 : 0);
    return s !== 0 ? s : (a.w * a.h) - (b.w * b.h);
  });
  for (const c of order) drawPart(c, cuOn);

  drawNet();
  updateHud();
}

function outlinePath() {
  ctx.beginPath();
  let lx = 0, ly = 0;
  for (const s of board.outline.segs) {
    if (s[0] === "M") { lx = sx(s[1]); ly = sy(s[2]); ctx.moveTo(lx, ly); }
    else if (s[0] === "L") { lx = sx(s[1]); ly = sy(s[2]); ctx.lineTo(lx, ly); }
    else if (s[0] === "A") {
      const ex = sx(s[1]), ey = sy(s[2]), cx = sx(s[3]), cy = sy(s[4]);
      const r = Math.hypot(ex - cx, ey - cy);
      ctx.arc(cx, cy, r, Math.atan2(ly - cy, lx - cx), Math.atan2(ey - cy, ex - cx), !s[5]);
      lx = ex; ly = ey;
    } else if (s[0] === "Z") ctx.closePath();
  }
}

function drawOutline(cuOn) {
  ctx.save();
  outlinePath();
  /* Solder mask green under the placement view; near-black once copper is on,
     because a light substrate under eight translucent layers reads as mud. */
  ctx.fillStyle = cssVar(cuOn ? "--board-cu" : "--board");
  ctx.fill();
  ctx.strokeStyle = cssVar("--board-edge");
  ctx.lineWidth = 1.25;
  ctx.stroke();
  ctx.restore();
}

/* Copper is the bulk of the page's geometry -- on Alta, 27,055 trace segments,
 * ~15,000 pads and 600 pours across eight layers -- and with all eight on it
 * costs about 48 ms a frame (medians of 60 samples; the distribution within one
 * browser is tight, min 47.7 / max 51.2, so the number is solid even though
 * comparisons ACROSS browser instances are not).
 *
 * Three ways of making that faster were tried and none of them moved it. They
 * are recorded here because each is the obvious next idea:
 *
 *   Batch strokes by width. A layer uses 2-20 distinct trace widths against
 *   27,055 segments, so one stroke per width instead of one per segment cut
 *   stroke() calls from 27,675 to 704 a frame -- a 39x reduction that changed
 *   the frame time not at all.
 *
 *   Put the board-to-screen matrix on the context instead of mapping each
 *   point in JS. 48.65 ms against 48.70. The ~125,000 moveTo/lineTo/arc calls
 *   cost the same whoever multiplies the coordinates.
 *
 *   Cull geometry outside the viewport. No effect near fit-view, where
 *   everything is on screen by definition, and 41 ms against 48 when zoomed in
 *   -- real but small, and it needs a control measurement it never got.
 *
 * So the cost is not path submission, not coordinate math and not element
 * count: only ~2.4 ms of a frame is inside fill() and stroke() combined, which
 * points at rasterisation rather than at anything that loop does. Which is why
 * the answer below is not to draw it faster but to draw it less often.
 *
 * COPPER IS CACHED. It only changes when the layer set, the zoom, the board or
 * the theme changes -- panning, hovering, selecting a part, filtering a class
 * and highlighting a net all leave it identical and merely move it. So it is
 * rendered once into an offscreen canvas and blitted after that, and the
 * expensive frame happens on a zoom step instead of on every mouse move.
 *
 * The offscreen is bigger than the viewport by CACHE_MARGIN on each side, so a
 * pan keeps blitting until it runs past the margin and only then re-renders.
 */
const CACHE_MARGIN = 400;

/* The offscreen is (viewport + 2*margin) at device resolution, so its cost is
   quadratic in both. 400px of margin around a 1426x400 viewport is 2.7 Mpx and
   about 10 MB at dpr 1 -- fine -- but the same margin on a full-screen hidpi
   window is several times that, for a buffer whose only job is to postpone a
   re-render. So the margin shrinks until the buffer fits a budget, and can
   reach zero, at which point every pan re-renders and the cache still earns its
   keep on hover, selection and filtering. */
const MAX_CACHE_PX = 12e6;

function cacheMargin(cw, ch, dpr) {
  let m = CACHE_MARGIN;
  while (m > 0 && (cw + 2 * m) * (ch + 2 * m) * dpr * dpr > MAX_CACHE_PX) m -= 50;
  return Math.max(m, 0);
}

let cuCache = null;
/* Bumped whenever something invalidates the cache that is not part of the key
   by value -- currently the theme, whose colours are read from CSS. */
let cuSeq = 0;

/* Everything the cached pixels depend on EXCEPT the zoom, which is handled
   separately because a zoom can be served by scaling what we already have. */
function copperKey() {
  return [board.id, [...visibleCopper].sort((a, b) => a - b).join(","),
          cuSeq].join("|");
}

function renderCopperCache(cw, ch, dpr, key) {
  const M = cacheMargin(cw, ch, dpr);
  const W = cw + 2 * M, H = ch + 2 * M;
  let cv = cuCache && cuCache.canvas;
  if (!cv || cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv = document.createElement("canvas");
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const cc = cv.getContext("2d");
  cc.setTransform(dpr, 0, 0, dpr, 0, 0);
  cc.clearRect(0, 0, W, H);

  /* Render with the real drawing code by pointing it at the offscreen and
     shifting the origin by the margin. Nothing else has to know. */
  const realCtx = ctx, rvx = vx, rvy = vy;
  ctx = cc;
  vx = rvx + M;
  vy = rvy + M;
  try {
    ctx.save();
    outlinePath();
    ctx.clip();
    for (const i of [...visibleCopper].sort((a, b) => a - b)) {
      const l = copper[i];
      if (l) drawCopperLayer(l, cssVar(COPPER_VARS[i % 8]));
    }
    ctx.restore();
  } finally {
    ctx = realCtx;
    vx = rvx;
    vy = rvy;
  }
  cuCache = { canvas: cv, key, vs, vx: rvx, vy: rvy, cw, ch, dpr, w: W, h: H, m: M };
}

let cuRefresh = 0;

function drawCopper() {
  const [cw, ch] = stageSize();
  const dpr = window.devicePixelRatio || 1;
  const key = copperKey();

  const usable = cuCache && cuCache.key === key &&
    cuCache.cw === cw && cuCache.ch === ch && cuCache.dpr === dpr;
  const M = usable ? cuCache.m : cacheMargin(cw, ch, dpr);
  const sameScale = usable && cuCache.vs === vs &&
    Math.abs(vx - cuCache.vx) <= M && Math.abs(vy - cuCache.vy) <= M;

  if (!sameScale) {
    /* A zoom can be served by SCALING the pixels we already have, which costs
       a blit instead of a re-render. It is soft for a moment -- the copper is
       resampled rather than redrawn -- and a sharp version is scheduled for
       when the gesture stops.
       Re-rendering on every wheel notch instead measured 77.5 ms a step, worse
       than the 48 ms it was before any of this, because the offscreen is
       several times the viewport's area. Scaling makes the step a blit and
       pays the render once at the end. */
    if (usable) {
      const k = vs / cuCache.vs;
      ctx.drawImage(cuCache.canvas,
                    vx - k * (M + cuCache.vx), vy - k * (M + cuCache.vy),
                    cuCache.w * k, cuCache.h * k);
      clearTimeout(cuRefresh);
      cuRefresh = setTimeout(() => {
        if (!board) return;
        cuCache = null;
        draw();
      }, 140);
      return;
    }
    renderCopperCache(cw, ch, dpr, key);
  }

  /* A board point sits at p*vs + cache.vx + M in the cached image and at
     p*vs + vx now, so the image goes down by the difference. */
  ctx.drawImage(cuCache.canvas,
                vx - cuCache.vx - M, vy - cuCache.vy - M,
                cuCache.w, cuCache.h);
}

/* The copper cache holds a rendering, not data, so anything that changes how
   copper looks without changing the key by value has to say so. */
function invalidateCopperCache() {
  clearTimeout(cuRefresh);
  cuCache = null;
  cuSeq++;
}

function drawCopperLayer(l, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  /* Pours first and faintest — they are the background of the layer, and at
     full weight they bury the traces running over them. */
  if (l.surfaces && l.surfaces.length) {
    ctx.globalAlpha = 0.22;
    for (const p of l.surfaces) { surfacePath(p); ctx.fill(); }
  }

  ctx.globalAlpha = 0.7;
  ctx.lineCap = "round";
  const t = l.traces || [];
  for (let i = 0; i < t.length; i += 5) {
    ctx.lineWidth = Math.max(t[i + 4] * vs, 0.5);
    ctx.beginPath();
    ctx.moveTo(sx(t[i]), sy(t[i + 1]));
    ctx.lineTo(sx(t[i + 2]), sy(t[i + 3]));
    ctx.stroke();
  }

  const a = l.arcs || [];
  for (let i = 0; i < a.length; i += 8) {
    const x1 = sx(a[i]), y1 = sy(a[i + 1]);
    const x2 = sx(a[i + 2]), y2 = sy(a[i + 3]);
    const cx = sx(a[i + 4]), cy = sy(a[i + 5]);
    ctx.lineWidth = Math.max(a[i + 6] * vs, 0.5);
    ctx.beginPath();
    ctx.arc(cx, cy, Math.hypot(x1 - cx, y1 - cy),
            Math.atan2(y1 - cy, x1 - cx), Math.atan2(y2 - cy, x2 - cx), !a[i + 7]);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.85;
  const p = l.pads || [];
  for (let i = 0; i < p.length; i += 3) {
    ctx.beginPath();
    ctx.arc(sx(p[i]), sy(p[i + 1]), Math.max(p[i + 2] * vs / 2, 0.5), 0, Math.PI * 2);
    ctx.fill();
  }

  const q = l.pads_rect || [];
  for (let i = 0; i < q.length; i += 5) {
    const px = sx(q[i]), py = sy(q[i + 1]);
    const pw = Math.max(q[i + 2] * vs, 0.5), ph = Math.max(q[i + 3] * vs, 0.5);
    const rot = q[i + 4] * Math.PI / 180;
    if (Math.abs(Math.sin(rot)) < 0.01) {
      ctx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
    } else {
      ctx.save(); ctx.translate(px, py); ctx.rotate(-rot);
      ctx.fillRect(-pw / 2, -ph / 2, pw, ph);
      ctx.restore();
    }
  }
  ctx.restore();
}

function surfacePath(p) {
  ctx.beginPath();
  let lx = 0, ly = 0;
  for (let i = 0; i < p.length;) {
    const cmd = p[i];
    if (cmd === "M") { lx = sx(p[i + 1]); ly = sy(p[i + 2]); ctx.moveTo(lx, ly); i += 3; }
    else if (cmd === "L") { lx = sx(p[i + 1]); ly = sy(p[i + 2]); ctx.lineTo(lx, ly); i += 3; }
    else if (cmd === "A") {
      const ex = sx(p[i + 1]), ey = sy(p[i + 2]);
      const cx = sx(p[i + 3]), cy = sy(p[i + 4]);
      ctx.arc(cx, cy, Math.hypot(lx - cx, ly - cy),
              Math.atan2(ly - cy, lx - cx), Math.atan2(ey - cy, ex - cx), !p[i + 5]);
      lx = ex; ly = ey; i += 6;
    } else if (cmd === "Z") { ctx.closePath(); i += 1; }
    else i += 1;
  }
}

function drawPart(c, cuOn) {
  const cx = sx(c.x), cy = sy(c.y);
  const w = c.w * vs, h = c.h * vs;
  const isSel = c.r === selected;
  const isHov = c === hovered;
  const cats = board.categories[side] || {};
  const base = (cats[c.c] && cats[c.c].color) || "#5a6068";

  ctx.save();
  if (c.c === "mounting") {
    /* A mounting hole is a hole: an annular ring of copper with a bore through
       it, and both diameters are measured off the board's own drill and copper
       layers rather than guessed. The bore used to be drawn at 0.58 of the
       outer diameter, a ratio that fitted one MediaTek footprint by luck and
       nothing else -- on the Pi-form-factor boards it drew a 2.75 mm hole as
       0.3 mm. Where a board's export predates the drill-layer read, `d` is
       absent and only the ring is drawn; an outline with no bore is honest,
       a bore at an invented size is not. */
    const ringR = (c.ring ? c.ring : Math.max(c.w, c.h)) * vs / 2;
    ctx.beginPath(); ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
    ctx.fillStyle = isSel ? "rgba(77,163,255,.30)" : "rgba(201,162,39,.28)";
    ctx.fill();
    ctx.strokeStyle = isSel ? cssVar("--accent") : cssVar("--hole-ring");
    ctx.lineWidth = isSel ? 2.5 : 1.4;
    ctx.stroke();
    if (c.d) {
      ctx.beginPath(); ctx.arc(cx, cy, c.d * vs / 2, 0, Math.PI * 2);
      ctx.fillStyle = cssVar(cuOn ? "--board-cu" : "--board");
      ctx.fill();
      ctx.strokeStyle = cssVar("--border"); ctx.lineWidth = 0.6; ctx.stroke();
    }
  } else {
    ctx.globalAlpha = isSel ? 1 : isHov ? 0.92 : 0.78;
    ctx.fillStyle = isSel ? cssVar("--accent") : isHov ? lighten(base) : base;
    ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
    if (isSel || isHov) {
      ctx.strokeStyle = isSel ? lighten(cssVar("--accent")) : cssVar("--silk");
      ctx.lineWidth = isSel ? 2 : 1;
      ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
    }
  }

  /* Gold fingers and header pins: the individual pads, when they are big
     enough on screen to be worth the strokes. */
  if (c.pp) {
    for (let gi = 0; gi < c.pp.length; gi++) {
      const g = c.pp[gi];
      const pw = g.pw * vs, ph = g.ph * vs;
      if (Math.max(pw, ph) < 1.5) continue;
      ctx.globalAlpha = isSel ? 1 : 0.88;
      const brass = isSel ? lighten(cssVar("--brass")) : cssVar("--brass");
      ctx.fillStyle = brass;
      /* A header the pinout documents gets that pin's signal class colour, out
         of the same palette the pinout site draws with -- so 5V is the same red
         in both places and the two can be read against each other. Pads with no
         class, and every other connector, stay brass. */
      for (let i = 0; i < g.pos.length; i += 2) {
        const px = sx(g.pos[i]), py = sy(g.pos[i + 1]);
        if (g.cls) {
          const cls = g.cls[i / 2];
          const col = cls ? cssVar("--c-" + cls) : "";
          ctx.fillStyle = col ? (isSel ? lighten(col) : col) : brass;
        }
        if (g.sh === "r" || g.sh === "s") {
          ctx.beginPath(); ctx.arc(px, py, Math.max(pw, ph) / 2, 0, Math.PI * 2); ctx.fill();
        } else if (g.sh === "oval") {
          ctx.beginPath(); ctx.ellipse(px, py, pw / 2, ph / 2, 0, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.fillRect(px - pw / 2, py - ph / 2, pw, ph);
        }
      }
    }
  }

  /* Silkscreen, but only once it is worth drawing: below a few pixels a
     footprint's outline is a smear over its own body colour. */
  if (c.s && Math.max(w, h) > 6) {
    ctx.globalAlpha = isSel ? 1 : 0.62;
    ctx.strokeStyle = isSel ? lighten(cssVar("--accent")) : cssVar("--silk");
    ctx.lineWidth = isSel ? 1.6 : 0.7;
    ctx.beginPath();
    for (const g of c.s) {
      if (g[0] === "L") {
        ctx.moveTo(sx(g[1]), sy(g[2])); ctx.lineTo(sx(g[3]), sy(g[4]));
      } else if (g[0] === "A") {
        const x1 = sx(g[1]), y1 = sy(g[2]), x2 = sx(g[3]), y2 = sy(g[4]);
        const ax = sx(g[5]), ay = sy(g[6]);
        ctx.moveTo(x1, y1);
        /* g[7] is the CAD's clockwise flag, and it is not optional: two points
           and a centre describe two arcs, and ctx.arc's default picked the
           other one for the IR receiver -- a 286 deg sweep that reads as a
           circle drawn round the part. sy() flips Y, so a board-space
           counterclockwise arc runs clockwise here: that IR's endpoints come
           out at -143 and 143 deg, which swept the default way is the 286, and
           anticlockwise the 74 the part actually is. Hence the negation, which
           is the same convention the copper arcs above use. */
        ctx.arc(ax, ay, Math.hypot(x1 - ax, y1 - ay),
                Math.atan2(y1 - ay, x1 - ax), Math.atan2(y2 - ay, x2 - ax),
                !g[7]);
      }
    }
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
  const need = isSel ? 18 : c.M ? 28 : 46;
  if (Math.max(w, h) > need || isHov) {
    const fs = Math.min(13, Math.max(8, Math.min(w, h) * 0.55));
    ctx.font = `700 ${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineWidth = 3;
    /* The halo, not the fill, is what makes a refdes readable: a label sits on
       whatever part colour happens to be under it, and those come from the
       board data rather than from the theme. */
    ctx.strokeStyle = "rgba(0,0,0,.55)";
    ctx.strokeText(c.r, cx, cy);
    ctx.fillStyle = cssVar("--part-label");
    ctx.fillText(c.r, cx, cy);
  }
  ctx.restore();
}

function lighten(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.min(255, v + 44));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/* ---- net highlight ------------------------------------------------------- */

function netAt(px, py) {
  const pn = board.pin_nets;
  if (!pn || !pn.length) return null;
  const x = bx(px), y = by(py);
  let best = 1.0, id = null;            /* 1 mm, in board units not pixels */
  for (let i = 0; i < pn.length; i += 3) {
    const d = Math.hypot(pn[i] - x, pn[i + 1] - y);
    if (d < best) { best = d; id = pn[i + 2]; }
  }
  return id;
}

function netPins(id) {
  const pn = board.pin_nets || [];
  const out = [];
  for (let i = 0; i < pn.length; i += 3) if (pn[i + 2] === id) out.push([pn[i], pn[i + 1]]);
  return out;
}

function drawNet() {
  if (netHi === null) return;
  const pins = netPins(netHi);
  if (!pins.length) return;
  const col = cssVar("--net-hi");
  ctx.save();

  /* The pads on the net, across EVERY copper layer including the ones that are
     switched off — the question "where else does this net go" is exactly the
     one a hidden layer would otherwise refuse to answer. Only possible once
     the copper file is here; the pin markers below work regardless. */
  if (copper) {
    const at = new Set(pins.map(([x, y]) => `${Math.round(x * 100)},${Math.round(y * 100)}`));
    ctx.fillStyle = col;
    ctx.globalAlpha = 0.9;
    for (const l of copper) {
      const p = l.pads || [];
      for (let i = 0; i < p.length; i += 3) {
        if (!at.has(`${Math.round(p[i] * 100)},${Math.round(p[i + 1] * 100)}`)) continue;
        ctx.beginPath();
        ctx.arc(sx(p[i]), sy(p[i + 1]), Math.max(p[i + 2] * vs / 2, 2) + 1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  ctx.globalAlpha = 1;
  ctx.fillStyle = cssVar("--part-label");
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  for (const [x, y] of pins) {
    ctx.beginPath();
    ctx.arc(sx(x), sy(y), 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function updateHud() {
  const mmPerPx = 1 / vs;
  let html = `${(vs * 25.4).toFixed(0)}% · ${mmPerPx.toFixed(3)} mm/px · ` +
             `${shown.length}/${comps().length} parts`;
  if (netHi !== null) {
    const name = board.nets[String(netHi)] || `net ${netHi}`;
    html += ` · <span class="net">${esc(name)} (${netPins(netHi).length} pins)</span>`;
  }
  els.hud.innerHTML = html;
}

/* ---- hit testing + pointer ----------------------------------------------- */

function hit(px, py) {
  const x = bx(px), y = by(py);
  for (let i = shown.length - 1; i >= 0; i--) {
    const c = shown[i];
    if (Math.abs(x - c.x) <= c.w / 2 && Math.abs(y - c.y) <= c.h / 2) return c;
  }
  return null;
}

function localXY(e) {
  const r = els.stage.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/* Pointer events rather than mouse events, so the same three handlers serve a
   mouse, a trackpad and a finger. A drag past a few pixels suppresses the
   click, otherwise every pan selected whatever part it finished over. */
const pointers = new Map();
let dragged = false, startX = 0, startY = 0, startVX = 0, startVY = 0;
let pinchDist = 0, pinchScale = 1;

function wireEvents() {
  els.select.onchange = () => loadBoard(els.select.value);
  els.search.oninput = (e) => { term = e.target.value; applyFilter(); draw(); };

  els.stage.addEventListener("pointerdown", (e) => {
    els.stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, localXY(e));
    if (pointers.size === 1) {
      dragged = false;
      [startX, startY] = localXY(e);
      startVX = vx; startVY = vy;
      els.stage.classList.add("dragging");
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinchDist = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      pinchScale = vs;
    }
  });

  els.stage.addEventListener("pointermove", (e) => {
    const here = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, here);

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1;
      const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const f = (pinchScale * d / pinchDist) / vs;
      vx = mid[0] - (mid[0] - vx) * f;
      vy = mid[1] - (mid[1] - vy) * f;
      vs *= f;
      dragged = true;
      draw();
      return;
    }
    if (pointers.size === 1 && pointers.has(e.pointerId)) {
      const dx = here[0] - startX, dy = here[1] - startY;
      if (Math.hypot(dx, dy) > 4) dragged = true;
      vx = startVX + dx; vy = startVY + dy;
      draw();
      return;
    }
    updateHover(e, here);
  });

  const release = (e) => {
    pointers.delete(e.pointerId);
    if (!pointers.size) els.stage.classList.remove("dragging");
  };
  els.stage.addEventListener("pointerup", release);
  els.stage.addEventListener("pointercancel", release);
  els.stage.addEventListener("pointerleave", (e) => {
    release(e);
    hovered = null;
    els.tooltip.hidden = true;
    draw();
  });

  els.stage.addEventListener("click", (e) => {
    if (dragged) return;
    const [px, py] = localXY(e);
    const c = hit(px, py);
    if (c) select(c.r, false);
  });

  els.stage.addEventListener("dblclick", (e) => {
    const [px, py] = localXY(e);
    const c = hit(px, py);
    if (c) { selected = c.r; paintRows(); showDetail(); zoomTo(c.r); draw(); }
  });

  els.stage.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [px, py] = localXY(e);
    const f = e.deltaY < 0 ? 1.16 : 1 / 1.16;
    vx = px - (px - vx) * f;
    vy = py - (py - vy) * f;
    vs *= f;
    draw();
  }, { passive: false });

  els.stage.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const [px, py] = localXY(e);
    const id = netAt(px, py);
    netHi = (id === null || id === netHi) ? null : id;
    if (netHi !== null) ensureCopper().then(draw);
    draw();
  });

  addEventListener("keydown", onKey);

  /* The stylesheet cannot reach a canvas, so the board is redrawn when the
     theme moves -- by the button, or by the OS flipping while the choice is
     auto. Without this the chrome would switch and the board would stay the
     old colour. The sidebar swatches are rebuilt for the same reason: their
     background is an inline style holding a resolved token value. */
  document.addEventListener("themechange", () => {
    if (!board) return;
    /* The cached copper holds the OLD theme's colours baked into pixels, which
       no token swap can reach. */
    invalidateCopperCache();
    buildCopperToggles();
    draw();
  });

  let resizeTimer = 0;
  addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(draw, 100);
  });
}

function updateHover(e, here) {
  const c = hit(here[0], here[1]);
  if (c !== hovered) { hovered = c; draw(); }
  if (!c) { els.tooltip.hidden = true; return; }
  els.tooltip.hidden = false;
  els.tooltip.innerHTML =
    `<div class="r">${esc(c.r)}</div>` +
    `<div class="f">${esc(c.f || "")}</div>` +
    `<div>${c.w} × ${c.h} mm${c.p ? ` · ${c.p} pins` : ""}</div>`;
  /* Flip the tooltip to the other side of the cursor near the right or bottom
     edge, rather than letting it run off the stage where it cannot be read. */
  const tw = els.tooltip.offsetWidth, th = els.tooltip.offsetHeight;
  const [w, h] = stageSize();
  els.tooltip.style.left = (here[0] + 14 + tw > w ? here[0] - 14 - tw : here[0] + 14) + "px";
  els.tooltip.style.top = (here[1] + 14 + th > h ? here[1] - 14 - th : here[1] + 14) + "px";
}

function onKey(e) {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const k = e.key.toLowerCase();
  if (e.key === "Escape") {
    selected = null; netHi = null; paintRows(); showDetail(); draw();
  } else if (k === "f") {
    fitView(); draw();
  } else if (k === "t") {
    setSide("top");
  } else if (k === "b") {
    setSide("bot");
  } else if (k >= "1" && k <= "8") {
    const i = Number(k) - 1;
    if (board.copper_index && i < board.copper_index.length) toggleCopper(i);
  }
}

init();
