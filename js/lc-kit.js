/* lc-kit 1 sha256:b5771b8617d9e2f489555132fa7c7137b2fd48c0acfe4a33c095af72b741587d */
/* Libre Computer hardware-tool shell — theme and chrome, shared by the GPIO
 * pinout and the board layout viewer.
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

export function themePref() {
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
export function mountShell({ themeButton = true } = {}) {
  applyTheme();
  mountSiteSwitch();

  // Follow the OS while the choice is auto, including a mid-visit change.
  window
    .matchMedia?.("(prefers-color-scheme: dark)")
    .addEventListener?.("change", () => {
      if (themePref() === "auto") applyTheme("auto");
    });

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

/**
 * Carry the current query across to the other tool.
 *
 * Both sites name the same boards by the same id and both take `?board=` and
 * `?hidden=`, so a visitor looking at a board here should arrive at THAT board
 * there. The two catalogues are not identical -- the pinout has boards with no
 * layout CAD and the layout has pre-production boards with no pinout -- but
 * neither site fails silently on an id it lacks: each falls back to its default
 * and says which board it is showing and why. So the query is passed through
 * whole rather than filtered against a list of the other site's boards, which
 * would be a second copy of that catalogue to keep in step.
 *
 * The href cannot be computed once at mount. Both sites keep the selected board
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

  const refresh = () => {
    for (const a of links) a.href = bases.get(a) + location.search;
  };

  for (const ev of ["pointerdown", "focus", "click"]) {
    for (const a of links) a.addEventListener(ev, refresh);
  }
  refresh();
  return links;
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
