// Themes.  The whole UI is drawn from the CSS custom properties in app.css,
// so a theme is one `data-theme` attribute on <html>; this module switches it,
// remembers the choice, and hands the same colours to the canvas drawing,
// which cannot read CSS variables by itself.
//
// Coalition and result colours (blue/red/amber) are deliberately NOT themed:
// on a tactical display "red" has to mean hostile in every theme.

export const THEMES = [
  ["green", "Cockpit green", "Green on black, like an aircraft display"],
  ["bright", "Bright", "Black on white, for a lit room"],
  ["blue", "Night blue", "The original dark blue"],
];

export const DEFAULT_THEME = "green";
const KEY = "dcs-sa.theme";

export function storedTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.some(([id]) => id === v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;   // private mode / storage blocked
  }
}

let cache = null;

export function applyTheme(name) {
  const id = THEMES.some(([t]) => t === name) ? name : DEFAULT_THEME;
  document.documentElement.dataset.theme = id;
  try { localStorage.setItem(KEY, id); } catch { /* not fatal */ }
  cache = null;
  window.dispatchEvent(new CustomEvent("dcs-sa-theme", { detail: id }));
  return id;
}

/** Set the theme before first paint, so the page never flashes another one. */
export function initTheme() {
  const id = storedTheme();
  document.documentElement.dataset.theme = id;
  return id;
}

/** One CSS custom property, e.g. cssVar("--bg"). */
export function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgb(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : [255, 255, 255];
}

/** A themed colour with an alpha, for canvas work: rgba("--muted", 0.5). */
export function rgba(name, alpha) {
  const [r, g, b] = rgb(cssVar(name) || "#ffffff");
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * The colours the map draws its own furniture with (background, graticule,
 * scale bar, attribution).  Cached because it is read every frame, and
 * cleared whenever the theme changes.
 */
export function chrome() {
  if (cache) return cache;
  cache = {
    bg: cssVar("--bg") || "#0b0f14",
    dim: rgb(cssVar("--bg") || "#0b0f14"),
    grid: (a) => rgba("--line-2", a),
    gridText: (a) => rgba("--muted", a),
    scale: rgba("--text", 0.8),
    scaleText: rgba("--text", 0.85),
    faint: rgba("--muted", 0.55),
  };
  return cache;
}

window.addEventListener("dcs-sa-theme", () => { cache = null; });
