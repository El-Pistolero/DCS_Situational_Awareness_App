// Manual Dogfight (A-A) / Ground attack (A-G) modes.
//
// A mode never switches by itself.  It is an overlay over the user's own
// settings: effective value = override[mode][k] ?? MODE_DEFAULTS[mode][k] ?? base[k].
// While a mode is active, changing a setting the mode manages writes only
// that mode's override, so going back to ALL restores the user's settings
// exactly (nothing is snapshotted or restored; ALL simply reads base).

export const MODES = [
  { id: "all", label: "ALL", name: "All", title: "Everything, with your own settings" },
  { id: "a2a", label: "A-A", name: "Dogfight", title: "Dogfight: aircraft, missiles and guns first" },
  { id: "a2g", label: "A-G", name: "Ground attack", title: "Ground attack: strikes, SAM rings and ground units first" },
];

const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, v) => { try { if (v === null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* private mode */ } };

/**
 * Settings store for one page.
 *   prefix: localStorage prefix ("dcs-sa." or "dcs-sa.live.")
 *   base: {key: default} for every setting (strings are stored raw so the
 *         existing preference keys keep working; other types as JSON)
 *   modeDefaults: {a2a: {...}, a2g: {...}} the keys a mode manages and their values
 */
export function createSettings({ prefix, base, modeDefaults }) {
  const listeners = new Set();
  const parse = (k, raw) => {
    if (raw === null) return undefined;
    if (typeof base[k] === "string") return raw;
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const encode = (k, v) => (typeof base[k] === "string" ? String(v) : JSON.stringify(v));
  const load = () => { try { return JSON.parse(read(`${prefix}modeprefs`) || "{}") || {}; } catch { return {}; } };
  let overrides = load();
  // Another window of the same page (two debriefs) changed a mode's settings: pick them up.
  try {
    window.addEventListener("storage", (e) => {
      if (e.key !== `${prefix}modeprefs`) return;
      overrides = load();
      for (const fn of listeners) fn({ type: "reset", mode: null });
    });
  } catch { /* no window (tests) */ }
  let mode = read(`${prefix}mode`);
  if (!MODES.some((m) => m.id === mode)) mode = "all";

  const owned = (k, m = mode) => m !== "all" && !!modeDefaults[m] && k in modeDefaults[m];
  const baseValue = (k) => parse(k, read(`${prefix}${k}`)) ?? base[k];

  const api = {
    get mode() { return mode; },
    /** Effective value of k in the current mode. */
    get(k) {
      if (owned(k)) return overrides[mode]?.[k] ?? modeDefaults[mode][k];
      return baseValue(k);
    },
    /** The user's own (ALL) value, whatever the mode. */
    base: baseValue,
    set(k, v) {
      if (owned(k)) {
        // Read-modify-write, so a second window's changes to other keys survive.
        overrides = load();
        overrides[mode] = { ...(overrides[mode] || {}), [k]: v };
        write(`${prefix}modeprefs`, JSON.stringify(overrides));
      } else write(`${prefix}${k}`, encode(k, v));
      for (const fn of listeners) fn({ type: "set", key: k, value: v });
    },
    /** True when k follows the active mode (the Display panel marks those rows). */
    owned: (k) => owned(k),
    setMode(m) {
      if (!MODES.some((x) => x.id === m) || m === mode) return;
      const from = mode;
      mode = m;
      write(`${prefix}mode`, m);
      for (const fn of listeners) fn({ type: "mode", from, to: m });
    },
    /** Pressing the active mode's key again returns to ALL. */
    toggle(m) { api.setMode(mode === m ? "all" : m); },
    /** Forget the user's changes to a mode. */
    reset(m = mode) {
      overrides = load();
      if (!overrides[m]) return;
      delete overrides[m];
      write(`${prefix}modeprefs`, JSON.stringify(overrides));
      for (const fn of listeners) fn({ type: "reset", mode: m });
    },
    customised: (m = mode) => !!overrides[m] && Object.keys(overrides[m]).length > 0,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
  return api;
}

/**
 * Segmented [ALL | A-A | A-G] control.  counts: optional () => {a2a, a2g}
 * shown as small numbers (information only, never a prompt to switch).
 */
export function modeSwitch(settings, { counts = null, keys = { a2a: "Shift+A", a2g: "Shift+G" } } = {}) {
  const box = document.createElement("div");
  box.className = "seg modesw";
  box.setAttribute("role", "radiogroup");
  box.setAttribute("aria-label", "Mode");
  const render = () => {
    box.innerHTML = "";
    const c = typeof counts === "function" ? counts() : counts;
    for (const m of MODES) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `m-${m.id}${settings.mode === m.id ? " active" : ""}`;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", settings.mode === m.id ? "true" : "false");
      b.title = `${m.title}${keys[m.id] ? ` (${keys[m.id]})` : ""}${m.id !== "all" && settings.customised(m.id) ? " · customised" : ""}`;
      b.textContent = m.label;
      const n = c?.[m.id];
      if (n) {
        const s = document.createElement("small");
        s.textContent = n;
        b.append(s);
      }
      if (m.id !== "all" && settings.customised(m.id)) b.classList.add("custom");
      b.onclick = () => settings.setMode(m.id);
      box.append(b);
    }
  };
  render();
  settings.on(render);
  box.refresh = render;
  return box;
}

/** Apply body classes and a transient chip for the active mode. */
export function reflectMode(settings, { chip = null, describe = () => "" } = {}) {
  let timer = null;
  const apply = (ev) => {
    for (const m of MODES) document.body.classList.toggle(`mode-${m.id}`, settings.mode === m.id);
    if (!chip || ev?.type !== "mode") return;
    const m = MODES.find((x) => x.id === settings.mode);
    const key = settings.mode === "a2a" ? "Shift+A" : settings.mode === "a2g" ? "Shift+G" : "";
    chip.textContent = settings.mode === "all" ? "All: your own settings" :
      `${m.name}: ${describe(settings.mode)}${key ? ` · ${key} to leave` : ""}`;
    chip.className = `modechip m-${settings.mode}`;
    clearTimeout(timer);
    timer = setTimeout(() => chip.classList.add("hidden"), 3500);
  };
  apply();
  settings.on(apply);
}
