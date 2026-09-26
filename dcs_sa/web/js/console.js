// The diagnostics console: what DCS SA itself is doing.
//
// Not the flight data - this is the panel you open when something isn't
// working and you want to see why, instead of guessing: telemetry arriving,
// the bridge connecting or going quiet, files loaded, warnings and errors.
//
// It polls only while open, so a closed console costs nothing.

import { el } from "./util.js";

const POLL_MS = 1500;
const KEEP = 500;

let dlg = null, body = null, timer = null, since = 0, rows = [], filter = "all", follow = true;

function stamp(t) {
  const d = new Date(t * 1000);
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function matches(r) {
  if (filter === "all") return true;
  if (filter === "problems") return r.level === "WARNING" || r.level === "ERROR" || r.level === "CRITICAL";
  return true;
}

function paint() {
  if (!body) return;
  const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.innerHTML = "";
  const shown = rows.filter(matches);
  if (!shown.length) {
    body.append(el("div", { class: "muted con-empty" },
      filter === "problems" ? "No warnings or errors. That is the good outcome."
        : "Nothing logged yet."));
  }
  for (const r of shown) {
    body.append(el("div", { class: `con-row lvl-${r.level.toLowerCase()}` },
      el("span", { class: "con-t" }, stamp(r.t)),
      el("span", { class: "con-lv" }, r.level === "WARNING" ? "WARN" : r.level.slice(0, 5)),
      el("span", { class: "con-src" }, r.source),
      el("span", { class: "con-msg" }, r.message)));
  }
  if (follow && atEnd) body.scrollTop = body.scrollHeight;
}

async function tick() {
  try {
    const res = await fetch(`/api/console?since=${since}`);
    if (res.ok) {
      const data = await res.json();
      if (data.entries?.length) {
        // The server drops the oldest first, so a gap just means we were slow.
        rows = rows.concat(data.entries).slice(-KEEP);
        since = data.entries[data.entries.length - 1].seq;
        paint();
      }
      const badge = document.getElementById("conCounts");
      if (badge) badge.textContent = `${data.errors || 0} errors · ${data.warnings || 0} warnings`;
    }
  } catch { /* app not reachable; the next tick tries again */ }
}

function build() {
  const box = el("dialog", { class: "settings-dlg console-dlg", id: "consoleDlg" });
  body = el("div", { class: "con-body", id: "conBody" });
  const sel = el("select", { onchange: (e) => { filter = e.target.value; paint(); } },
    el("option", { value: "all" }, "Everything"),
    el("option", { value: "problems" }, "Warnings and errors only"));
  const foll = el("input", { type: "checkbox", checked: follow, onchange: (e) => { follow = e.target.checked; paint(); } });
  box.append(
    el("div", { class: "con-head" },
      el("h2", {}, "Console"),
      el("span", { class: "muted", id: "conCounts" }, "")),
    el("p", { class: "muted set-note" },
      "What DCS SA is doing. Useful when something is not working; nothing here is sent anywhere."),
    el("div", { class: "con-tools" }, sel, el("label", {}, foll, "Follow"),
      el("button", { onclick: async () => {
        try { await fetch("/api/console", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clear: true }) }); } catch { /* offline */ }
        rows = []; since = 0; paint();
      } }, "Clear"),
      el("button", { onclick: () => {
        const text = rows.filter(matches).map((r) => `${stamp(r.t)} ${r.level} ${r.source}: ${r.message}`).join("\n");
        navigator.clipboard?.writeText(text).catch(() => {});
      } }, "Copy"),
      el("span", { class: "con-spacer" }),
      el("button", { onclick: () => close() }, "Close")),
    body);
  document.body.append(box);
  box.addEventListener("close", () => { clearInterval(timer); timer = null; });
  return box;
}

function close() {
  dlg?.close();
}

export function openConsole() {
  dlg ||= build();
  if (!dlg.open) dlg.showModal();
  paint();
  tick();
  clearInterval(timer);
  timer = setInterval(tick, POLL_MS);
}

/** Send the page's own errors to the same console: the desktop window has no dev tools. */
export function reportPageErrors() {
  const send = (level, message) => {
    fetch("/api/console", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level, message }) }).catch(() => {});
  };
  window.addEventListener("error", (e) => send("ERROR", `${e.message} (${e.filename || "?"}:${e.lineno || 0})`));
  window.addEventListener("unhandledrejection", (e) => send("ERROR", `Unhandled: ${e.reason?.message || e.reason}`));
}

export function wireConsoleButton(id) {
  const b = document.getElementById(id);
  if (b) b.onclick = openConsole;
  return b;
}
