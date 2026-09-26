// The Settings dialog, shared by the debrief and the live view.
//
// Only things that are the same everywhere belong here.  Map and readout
// options stay in each page's Display panel, where they sit next to what
// they change.

import { el } from "./util.js";
import { THEMES, applyTheme, storedTheme } from "./theme.js";
import { openConsole } from "./console.js";

let dlg = null;

function build() {
  const box = el("dialog", { class: "settings-dlg", id: "settingsDlg" });
  const form = el("form", { method: "dialog" });
  form.append(el("h2", {}, "Settings"));

  const themes = el("fieldset", {}, el("legend", {}, "Theme"));
  const current = storedTheme();
  for (const [id, label, note] of THEMES) {
    const input = el("input", { type: "radio", name: "theme", value: id, checked: id === current,
      onchange: () => applyTheme(id) });
    themes.append(el("label", { class: "set-row" }, input,
      el("span", {}, el("b", {}, label), el("small", { class: "muted" }, note))));
  }
  form.append(themes);

  form.append(el("p", { class: "muted set-note" }, "Your choice is remembered on this PC."));

  const updates = el("fieldset", {}, el("legend", {}, "Updates"));
  const auto = el("input", { type: "checkbox", onchange: async (e) => {
    try {
      await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoDownloadUpdates: e.target.checked }) });
    } catch { /* offline */ }
  } });
  fetch("/api/status").then((r) => r.json()).then((st) => { auto.checked = st.autoDownload !== false; })
    .catch(() => { auto.checked = true; });
  updates.append(el("label", { class: "set-row" }, auto,
    el("span", {}, el("b", {}, "Get updates ready automatically"),
      el("small", { class: "muted" }, "Downloads a new version as soon as there is one, so it is only ever one click to install."))));
  form.append(updates);

  const tools = el("fieldset", {}, el("legend", {}, "Troubleshooting"));
  tools.append(el("div", { class: "set-row" },
    el("button", { type: "button", onclick: () => { box.close(); openConsole(); } }, "Open console"),
    el("small", { class: "muted" }, "What DCS SA is doing: telemetry, the bridge, files, warnings and errors.")));
  form.append(tools);
  form.append(el("div", { class: "row-end" }, el("button", { value: "close" }, "Close")));
  box.append(form);
  document.body.append(box);
  return box;
}

export function openSettings() {
  dlg ||= build();
  // Another window may have changed the theme since this dialog was built.
  const now = storedTheme();
  for (const input of dlg.querySelectorAll('input[name="theme"]')) input.checked = input.value === now;
  if (!dlg.open) dlg.showModal();
}

/** Wire a button (by id) to open Settings.  Missing button: nothing happens. */
export function wireSettingsButton(id) {
  const b = document.getElementById(id);
  if (b) b.onclick = openSettings;
  return b;
}
