/* lc-kit 1 sha256:65abe02e07c8aa20a33ed8ca4db3b0d5e1b69b29a3b516b3caf316431b77ceed */
/* Libre Computer hardware-tool shell — theme and chrome, shared by the GPIO
 * pinout, the board layout viewer, the power tree and the sites that took the
 * same look.
 *
 * Three theme states, matching libre.computer: light, dark, and auto, which
 * follows the OS and is the default. `themePref()` is what the visitor chose;
 * `theme()` is the light or dark the page is actually painted in, which is what
 * a canvas renderer needs to ask for.
 *
 * Both tools draw on a <canvas>, which no stylesheet can restyle. So a theme
 * change has to be announced rather than merely applied: `themechange` fires on
 * `document` whenever the resolved theme moves, for any reason -- the button,
 * or the OS flipping while the choice is auto -- and each site redraws on it.
 * Without that the chrome would flip and the board would stay the old colour.
 *
 * This file is VENDORED. Edit tools/lc-ui-kit/lc-kit.js in the monorepo and run
 * tools/lc-ui-kit/sync.py; a hand-edit here fails each site's CI.
 */

const ORDER = ["auto", "light", "dark"];

const UI = {
  auto: { icon: "◐", label: "Auto", hint: "Theme: auto (follows your system)" },
  light: { icon: "☀", label: "Light", hint: "Theme: light" },
  dark: { icon: "☾", label: "Dark", hint: "Theme: dark" },
};

/* The same key libre.computer uses, so a visitor who set a preference there and
   follows a link here is not asked again. Same-origin storage means this only
   pays off across the tool sites themselves, but the cost of agreeing is nil
   and the cost of disagreeing is a visitor being asked twice. */
const KEY = "theme";

/* EMBED MODE (?embed=1): the tool inside another page's frame -- a
   libre.computer product page opens Layout, Pinout, Power, U-Boot, Memory map
   and Linux in a panel under the board. The page that frames it already says
   which board and which site, so the chrome that says so goes (the brand, the
   site switcher, the Software bar, the board links, the footer, and the board
   or SoC-family picker: the frame is for one board); the tool's own controls
   stay. ?theme=light|dark paints the frame like the page around it, without
   storing a preference here. An "Open ⤢" link opens the full tool in a new
   tab, and every link to another site opens in a new tab rather than inside
   the frame (most refuse to be framed). */
const Q = new URLSearchParams(location.search);
export const EMBED = Q.get("embed") === "1";
const FORCED_THEME = EMBED && ["light", "dark"].includes(Q.get("theme")) ? Q.get("theme") : null;
if (EMBED) document.documentElement.classList.add("lc-embed");

export function themePref() {
  if (FORCED_THEME) return FORCED_THEME;
  let p = "auto";
  try {
    p = localStorage.getItem(KEY) || "auto";
  } catch (_) {
    /* Private mode, or storage disabled: auto is a good answer, not an error. */
  }
  return ORDER.includes(p) ? p : "auto";
}

function systemPrefersDark() {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** The light-or-dark the page is painted in right now. */
export function theme() {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function applyTheme(pref = themePref()) {
  const before = theme();
  const dark = pref === "dark" || (pref === "auto" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  const now = theme();
  if (now !== before) {
    document.dispatchEvent(new CustomEvent("themechange", { detail: { theme: now } }));
  }
  return now;
}

/** auto → light → dark → auto. */
export function cycleTheme() {
  const next = ORDER[(ORDER.indexOf(themePref()) + 1) % ORDER.length];
  try {
    localStorage.setItem(KEY, next);
  } catch (_) {}
  applyTheme(next);
  return next;
}

/** A CSS custom property's current value — the bridge from tokens to canvas. */
export function token(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Wire the shared shell.
 *
 * The markup lives in each site's index.html rather than being generated here:
 * the two tools put genuinely different things in the controls slot (a board
 * picker and a pin search; a board picker and a part search), and a shell that
 * rendered the header would have to be told about both. What is shared is the
 * structure, the classes and the behaviour, which is what was duplicated.
 *
 * Returns the theme button so a caller can place it itself if it wants to.
 */
/* On a phone the switcher and the Software bar are each one sideways row
   with the scrollbar hidden, so the visitor's own entry can open scrolled
   out of sight (the Software bar's page links sit at its far end). Bring each
   row's current entry in -- the row only, never the page. */
function showCurrentEntries() {
  for (const row of document.querySelectorAll(".lc-sites, .lc-subnav")) {
    if (row.scrollWidth <= row.clientWidth) continue;
    const cur = row.querySelector('[aria-current="page"]') || row.querySelector("[aria-current]");
    if (!cur) continue;
    const r = cur.getBoundingClientRect(), box = row.getBoundingClientRect();
    if (r.right > box.right) row.scrollLeft += r.right - box.right + 16;
    else if (r.left < box.left) row.scrollLeft -= box.left - r.left + 16;
  }
}

/** The full tool's address for the embed's "Open ⤢": this page as it is now
    (a tool keeps its state in the address with replaceState), less embed and
    theme. */
function fullAddress() {
  const url = new URL(location.href);
  url.searchParams.delete("embed");
  url.searchParams.delete("theme");
  return url.href;
}

function mountEmbed() {
  const open = document.createElement("a");
  open.className = "lc-embed-open";
  open.target = "_blank";
  open.rel = "noopener";
  open.textContent = "Open ⤢";
  open.title = "Open the full tool in a new tab";
  const refresh = () => { open.href = fullAddress(); };
  for (const ev of ["pointerdown", "focus", "click"]) open.addEventListener(ev, refresh);
  refresh();
  const bar = document.querySelector(".lc-topbar");
  (bar?.querySelector(".lc-controls") || bar || document.body).appendChild(open);
  // A link to another site leaves the frame for a new tab, whenever it was
  // drawn: set at the click, so links a tool renders later are covered too.
  document.addEventListener("click", (e) => {
    const a = e.target.closest?.("a[href]");
    if (!a || a.origin === location.origin) return;
    a.target = "_blank";
    a.rel = "noopener";
  }, true);
}

export function mountShell({ themeButton = true } = {}) {
  applyTheme();
  mountSiteSwitch();
  showCurrentEntries();

  // Follow the OS while the choice is auto, including a mid-visit change.
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (themePref() === "auto") applyTheme("auto");
    });

  // In a frame the theme follows the page around it (?theme=), so no button.
  if (EMBED) {
    mountEmbed();
    return null;
  }
  if (!themeButton) return null;

  let btn = document.getElementById("lc-theme");
  if (!btn) {
    btn = document.createElement("button");
    btn.id = "lc-theme";
    btn.type = "button";
    btn.className = "lc-theme-btn";
    const bar = document.querySelector(".lc-topbar");
    // Last in the bar, after the controls, so tab order reaches the tool's own
    // controls before a preference that is set once and forgotten.
    (bar || document.body).appendChild(btn);
  }

  function paint() {
    const pref = themePref();
    const ui = UI[pref];
    const next = UI[ORDER[(ORDER.indexOf(pref) + 1) % ORDER.length]];
    btn.innerHTML =
      `<span class="lc-theme-icon" aria-hidden="true">${ui.icon}</span>` +
      `<span class="lc-theme-label">${ui.label}</span>`;
    btn.title = `${ui.hint} — click for ${next.label.toLowerCase()}`;
    btn.setAttribute("aria-label", ui.hint);
    btn.dataset.theme = pref;
  }

  btn.addEventListener("click", () => {
    cycleTheme();
    paint();
  });
  document.addEventListener("themechange", paint);
  paint();
  return btn;
}

/* One board, two kinds of id: Tritium is one PCB the layout and power tools
   draw once (all-h3-cc, also its product slug), fitted with an H3 or an H5,
   which the pinout tells apart. The only such board; a new one is a row here. */
const VARIANTS = { "all-h3-cc": ["all-h3-cc-h3", "all-h3-cc-h5"] };

/**
 * The board a hardware tool opens for `?board=wanted`, among the ids it lists:
 * the id itself; else a variant of it (Tritium -> Tritium H3, the first);
 * else the board it is a variant of (Tritium H5 -> Tritium); else null, and
 * the tool shows its default. `how` says which, for boardNotice.
 */
export function resolveBoard(wanted, ids) {
  if (!wanted) return { id: null, how: null };
  if (ids.includes(wanted)) return { id: wanted, how: "exact" };
  const variant = (VARIANTS[wanted] || []).find((v) => ids.includes(v));
  if (variant) return { id: variant, how: "variant" };
  const family = Object.keys(VARIANTS).find((f) => VARIANTS[f].includes(wanted) && ids.includes(f));
  if (family) return { id: family, how: "family" };
  return { id: null, how: null };
}

/**
 * The one sentence every hardware tool shows when it is not showing the board
 * asked for. `unlisted`: the id exists but only under ?hidden=1.
 */
export function boardNotice(wanted, shownName, how, unlisted = false) {
  if (how === "variant") return `${shownName} shown: this board comes in more than one version; pick another above.`;
  if (how === "family") return `${shownName} shown: this tool draws its versions as one board.`;
  return unlisted
    ? `“${wanted}” is not listed publicly; showing ${shownName}.`
    : `No board “${wanted}” here; showing ${shownName}.`;
}

/**
 * Keep the board the visitor asked for in the address while another is shown
 * (`?asked=`), for the switcher to carry on; a board picked here clears it.
 */
export function noteAsked(wanted, shownId) {
  const url = new URL(location.href);
  if (wanted && wanted !== shownId) url.searchParams.set("asked", wanted);
  else url.searchParams.delete("asked");
  history.replaceState(null, "", url);
}

/**
 * Carry the current query across to the other hardware tools (the switcher
 * links marked data-lc-site; sync.py marks only those between the GPIO,
 * layout and power tools).
 *
 * The three tools name the same boards by the same id and all take `?board=`
 * and `?hidden=`, so a visitor looking at a board here should arrive at THAT
 * board there. The catalogues are not identical -- the pinout has boards with
 * no layout CAD, the layout has pre-production boards with no pinout, the
 * power tree draws fewer still -- but no tool fails silently on an id it
 * lacks: each falls back to its default and says which board it is showing
 * and why (resolveBoard, boardNotice). So the board is passed through rather
 * than filtered against a list of another tool's boards, which would be a
 * second copy of that catalogue to keep in step.
 *
 * The href cannot be computed once at mount. Each tool keeps the selected board
 * in the URL with history.replaceState, which fires no event, so a link built
 * at load time would still point at whatever board the page opened with. It is
 * recomputed on the events that precede a navigation instead -- pointerdown
 * covers middle-click and the context menu's copy-link, focus covers the
 * keyboard -- so the address is right whichever way the link is taken.
 *
 * Anchors are marked in the page rather than generated here, so the switch is
 * still there and still works with the module blocked; only the query-carrying
 * is JavaScript's part.
 */
export function mountSiteSwitch(root = document) {
  const links = [...root.querySelectorAll("a[data-lc-site]")];
  if (!links.length) return links;

  const bases = new WeakMap(); // the tool's own address, before any query
  for (const a of links) bases.set(a, a.href.split(/[?#]/)[0]);

  /* Only what the tools share: the board and the hidden switch (a tool's own
     view, step or rail means nothing to the next). The board is the one the
     visitor ASKED for when this tool had to show another (`asked`, below), so
     a board one tool lacks is not swapped for that tool's default two hops
     later. */
  const carried = () => {
    const here = new URLSearchParams(location.search);
    const q = new URLSearchParams();
    const board = here.get("asked") || here.get("board");
    if (board) q.set("board", board);
    if (here.get("hidden")) q.set("hidden", here.get("hidden"));
    const s = q.toString();
    return s ? `?${s}` : "";
  };
  const refresh = () => {
    for (const a of links) a.href = bases.get(a) + carried();
  };

  for (const ev of ["pointerdown", "focus", "click"]) {
    for (const a of links) a.addEventListener(ev, refresh);
  }
  refresh();
  return links;
}

/**
 * Say so, in the brand row, when ?hidden=1 lists boards nobody can buy yet
 * (pre-production, unreleased, another maker's reference): the same flag on
 * every tool. `count` is how many the switch added; `title` says which kinds.
 */
export function showHiddenFlag(count, title) {
  const brand = document.querySelector(".lc-brand");
  let flag = document.getElementById("lc-hidden-flag");
  if (!brand || !count) {  // (nothing hidden here: no flag)
    if (flag) flag.remove();
    return null;
  }
  if (!flag) {  // (a second call updates the one flag)
    flag = document.createElement("span");
    flag.id = "lc-hidden-flag";
    flag.className = "lc-flag";
    brand.appendChild(flag);
  }
  flag.textContent = `+${count} unlisted`;
  flag.title = title || "?hidden=1: boards not yet public are listed";
  return flag;
}

/**
 * The board's own pages, beside the board picker: its product page on
 * libre.computer and its 3D model in cad.place, so a visitor who arrived at a
 * tool from a search can find the board itself.
 *
 * The links are data/lc-products.json, written into each tool by
 * tools/lc-ui-kit/sync.py from libre.computer's catalogue -- { "boards": {
 * "<this tool's board id>": { "name", "page", "model"? } } } for released
 * boards only -- rather than fetched from libre.computer, which sends no CORS
 * to these sites and would couple each tool to that site being up. A board
 * the file does not name (a hidden one, one with no product page) shows no
 * links, and a site without the file shows none for any board.
 *
 * Call it with the board id whenever the board changes. Only http(s) links
 * are drawn, from text alone, so the file can never inject markup.
 */
let products = null; // the file's boards, once fetched (a promise)

export async function setBoardLinks(id) {
  if (!products) {
    products = fetch("data/lc-products.json")
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => (d && typeof d.boards === "object" && d.boards) || {})
      .catch(() => ({}));
  }
  const boards = await products;
  let nav = document.getElementById("lc-board-links");
  if (!nav) {
    const slot = document.querySelector(".lc-controls");
    if (!slot) return null;
    nav = document.createElement("nav");
    nav.id = "lc-board-links";
    nav.className = "lc-board-links";
    nav.setAttribute("aria-label", "This board's pages");
    // after the board picker, before the search box
    const sel = slot.querySelector("select");
    if (sel) sel.after(nav);
    else slot.prepend(nav);
  }
  nav.textContent = "";
  const b = Object.prototype.hasOwnProperty.call(boards, id) ? boards[id] : null;
  const safe = (u) => {
    try {
      return /^https?:$/.test(new URL(u).protocol) ? u : null;
    } catch (_) {
      return null;
    }
  };
  const link = (href, text, title) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    a.title = title;
    a.rel = "noopener";
    nav.appendChild(a);
  };
  const name = b && typeof b.name === "string" ? b.name : "this board";
  if (b && safe(b.page)) link(b.page, "Product page", `${name} on libre.computer`);
  if (b && safe(b.model)) link(b.model, "3D model", `${name}'s 3D model in cad.place`);
  nav.hidden = !nav.childElementCount;
  return nav;
}

/**
 * The inline <head> script, as a string, so the two sites cannot drift on the
 * one piece of theme code that must not be deferred.
 *
 * It has to run before first paint or a dark visitor gets a white flash, which
 * means it cannot be in this module -- a module is deferred by definition. Each
 * page carries it inline; sync.py checks the copies match this text.
 */
export const HEAD_SNIPPET =
  `try{var p=localStorage.getItem("theme")||"auto";` +
  `if(p==="dark"||(p==="auto"&&matchMedia("(prefers-color-scheme: dark)").matches))` +
  `document.documentElement.classList.add("dark")}catch(e){}`;
