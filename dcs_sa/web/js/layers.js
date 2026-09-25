// "Display" popover: every map option in one place, read from and written to
// the mode-aware settings (modes.js).  Rows the active mode manages carry the
// mode's colour dot, and the footer says where a change will be saved.

import { el } from "./util.js";
import { MODES } from "./modes.js";

/**
 * sections: [{title, rows: [{key, label, type: "select"|"toggle", options?: [[value, label]], title?, when?()}]}]
 * onChange(key, value) runs after a setting was written.
 */
export function createDisplayPanel(button, host, { sections, settings, onChange }) {
  const pop = el("div", { class: "dispanel hidden", role: "dialog", "aria-label": "Display options" });
  host.append(pop);
  const isOpen = () => !pop.classList.contains("hidden");

  function control(row) {
    const v = settings.get(row.key);
    if (row.type === "toggle") {
      return el("input", { type: "checkbox", checked: !!v, onchange: (e) => { settings.set(row.key, e.target.checked); onChange?.(row.key, e.target.checked); } });
    }
    const sel = el("select", { onchange: (e) => {
      const raw = e.target.value;
      const val = typeof settings.base(row.key) === "number" ? Number(raw) : raw;
      settings.set(row.key, val);
      onChange?.(row.key, val);
    } });
    for (const [value, label] of row.options) sel.append(el("option", { value: String(value) }, label));
    sel.value = String(v);
    return sel;
  }

  function render() {
    pop.innerHTML = "";
    const mode = MODES.find((m) => m.id === settings.mode);
    for (const sec of sections) {
      const rows = sec.rows.filter((r) => !r.when || r.when());
      if (!rows.length) continue;
      const box = el("section", {}, el("h4", {}, sec.title));
      for (const r of rows) {
        const owned = settings.owned(r.key);
        box.append(el("label", { class: `dp-row${owned ? ` owned m-${settings.mode}` : ""}`, title: r.title || (owned ? `Saved to ${mode.label} mode` : "") },
          el("span", { class: "dp-lbl" }, r.label), control(r)));
      }
      pop.append(box);
    }
    const foot = el("div", { class: "dp-foot" });
    if (settings.mode === "all") foot.append("Changes here are your own settings. A-A and A-G keep theirs separately.");
    else {
      foot.append(el("span", { class: `dp-dot m-${settings.mode}` }), ` Rows with a dot are saved to ${mode.label} only; ALL keeps your settings. `,
        settings.customised() ? el("button", { class: "ghost", onclick: () => { settings.reset(); onChange?.(null, null); render(); } }, `Reset ${mode.label}`) : "");
    }
    pop.append(foot);
  }

  function place() {
    const b = button.getBoundingClientRect(), h = host.getBoundingClientRect();
    const top = Math.max(6, b.bottom - h.top + 6);
    pop.style.top = `${top}px`;
    pop.style.right = `${Math.max(6, h.right - b.right)}px`;
    pop.style.maxHeight = `${Math.max(160, h.height - top - 10)}px`;
  }
  function open() { render(); pop.classList.remove("hidden"); place(); button.classList.add("active"); }
  function close() { pop.classList.add("hidden"); button.classList.remove("active"); }
  button.addEventListener("click", (e) => { e.stopPropagation(); isOpen() ? close() : open(); });
  document.addEventListener("pointerdown", (e) => { if (isOpen() && !pop.contains(e.target) && !button.contains(e.target)) close(); }, true);
  pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); close(); button.focus(); } });
  settings.on(() => { if (isOpen()) render(); });
  return { open, close, toggle: () => (isOpen() ? close() : open()), isOpen, render };
}
