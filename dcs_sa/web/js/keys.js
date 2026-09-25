// Keyboard shortcuts: one table per page drives both the key handling and
// the '?' help sheet, so the two cannot drift apart.
//
// defs: [{ keys: ["Shift+ArrowLeft", ...], group, label, run(e), repeat?, when?(): bool, hidden? }]
// Key strings: optional "Ctrl+" (Ctrl or Cmd) and "Shift+" prefixes, then a
// letter (matched case-insensitively), a KeyboardEvent.key name (ArrowLeft,
// Home, Escape, " " for Space) or a printable character ('?', '+', '[', ...),
// which matches whatever Shift state produced it.

import { el } from "./util.js";

const PRINTABLE = new Set(["?", "+", "=", "-", ",", ".", "/", "[", "]"]);
const NAMES = { " ": "Space", ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Escape: "Esc" };

function parse(spec) {
  const parts = spec.split("+");
  let key = parts.pop();
  if (key === "" && spec.endsWith("+")) { parts.pop(); key = "+"; } // "Shift++" / "+"
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const letter = key.length === 1 && /[a-z0-9]/i.test(key);
  return {
    key: letter ? key.toLowerCase() : key,
    ctrl: mods.has("ctrl"),
    shift: mods.has("shift"),
    printable: PRINTABLE.has(key),
  };
}

function matches(p, e) {
  if (p.ctrl !== (e.ctrlKey || e.metaKey)) return false;
  if (e.altKey) return false;
  if (p.printable) return e.key === p.key;
  if (p.shift !== e.shiftKey) return false;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  return k === p.key;
}

function typing(target) {
  return target instanceof Element && target.closest("input, select, textarea, [contenteditable=''], [contenteditable='true']");
}

export function bindShortcuts(defs, { title = "Keyboard shortcuts" } = {}) {
  const table = [];
  const add = (more) => {
    for (const d of more) table.push({ ...d, parsed: d.keys.map(parse) });
  };
  add(defs);
  window.addEventListener("keydown", (e) => {
    if (typing(e.target)) return;
    const open = [...document.querySelectorAll("dialog[open]")];
    const helpOpen = open.some((d) => d.classList.contains("kbd-help"));
    if (open.some((d) => !d.classList.contains("kbd-help"))) return;
    for (const d of table) {
      if (!d.parsed.some((p) => matches(p, e))) continue;
      if (e.repeat && !d.repeat) { e.preventDefault(); return; }
      if (d.when && !d.when()) continue;
      if (helpOpen && !d.help) continue;
      e.preventDefault();
      d.run(e);
      return;
    }
  });
  const api = {
    add,
    help: () => showShortcutHelp(table, title),
  };
  add([{ keys: ["?"], group: "Panels", label: "This help", help: true, run: () => api.help() }]);
  return api;
}

function chip(spec) {
  const p = spec.split("+");
  let key = p.pop();
  if (key === "" && spec.endsWith("+")) { p.pop(); key = "+"; }
  return [...p.map((m) => (m === "Ctrl" ? "Ctrl" : m)), NAMES[key] || (key.length === 1 ? key.toUpperCase() : key)]
    .map((k) => el("kbd", {}, k));
}

export function showShortcutHelp(table, title = "Keyboard shortcuts") {
  let dlg = document.querySelector("dialog.kbd-help");
  if (dlg?.open) { dlg.close(); return; }
  if (!dlg) {
    dlg = el("dialog", { class: "kbd-help" });
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    document.body.append(dlg);
  }
  dlg.innerHTML = "";
  const groups = new Map();
  for (const d of table) {
    if (d.hidden) continue;
    const g = d.group || "Other";
    if (!groups.has(g)) groups.set(g, []);
    // Rows sharing a label (e.g. 1..7) are merged by the caller via `keysLabel`.
    groups.get(g).push(d);
  }
  const body = el("div", { class: "kbd-groups" });
  for (const [g, rows] of groups) {
    const sec = el("section", {}, el("h3", {}, g));
    for (const d of rows) {
      const keys = d.keysLabel ? [el("kbd", {}, d.keysLabel)] : d.keys.flatMap((k, i) => (i ? [" ", ...chip(k)] : chip(k)));
      sec.append(el("div", { class: "kbd-row" }, el("span", { class: "keys" }, ...keys), el("span", {}, d.label)));
    }
    body.append(sec);
  }
  dlg.append(el("div", { class: "kbd-head" }, el("h2", {}, title),
    el("button", { class: "ghost", onclick: () => dlg.close(), title: "Close (Esc)" }, "✕")), body);
  dlg.showModal();
}
