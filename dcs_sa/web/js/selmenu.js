// Selection card and right-click action menu, shared by the debrief and the
// live view.  The page supplies an action registry and a describe() function;
// this module only lays them out.
//
// target: {kind: "object", id, o} | {kind: "point", lon, lat}
// action: {id, label, key?, icon?, primary?, applies(target) -> bool,
//          active?(target) -> bool, run(target), hint?(target) -> string}

import { el } from "./util.js";

export function createSelectionUI(host, { actions, describe, onClose = null, cardHost = host }) {
  const card = el("div", { class: "selcard hidden", role: "region", "aria-label": "Selection" });
  const menu = el("div", { class: "selmenu hidden", role: "menu" });
  cardHost.prepend(card);
  host.append(menu);
  let current = null, collapsed = false, lastSig = "";

  const applicable = (target) => actions.filter((a) => { try { return a.applies(target); } catch { return false; } });

  function button(a, target, { compact = false } = {}) {
    const active = a.active?.(target);
    const hint = a.hint?.(target);
    return el("button", {
      class: `${compact ? "ghost " : ""}${active ? "active" : ""}`,
      title: `${a.label}${a.key ? ` (${a.key})` : ""}${hint ? ` · ${hint}` : ""}`,
      onclick: (e) => { e.stopPropagation(); closeMenu(); a.run(target); refresh(true); },
    }, a.icon ? el("span", { class: "ic" }, a.icon) : "", compact ? "" : a.short || a.label);
  }

  /** Rebuild the card for `target` (null hides it). */
  function set(target) {
    current = target;
    lastSig = "";
    refresh(true);
  }

  /** Update the text; rebuild the buttons only when something about them changed. */
  function refresh(force = false) {
    if (!current) { card.classList.add("hidden"); return; }
    const d = describe(current);
    if (!d) { card.classList.add("hidden"); return; }
    card.classList.remove("hidden");
    const acts = applicable(current).filter((a) => a.primary);
    const sig = `${collapsed}|${d.title}|${acts.map((a) => `${a.id}:${a.active?.(current) ? 1 : 0}`).join(",")}`;
    if (force || sig !== lastSig) {
      lastSig = sig;
      card.innerHTML = "";
      const head = el("div", { class: "sc-head" },
        el("span", { class: "dot", style: { background: d.color || "#c8cdd6" } }),
        el("div", { class: "sc-title" }, el("b", {}, d.title), el("small", { class: "sc-sub" })),
        el("button", { class: "ghost sc-more", title: "All actions (E)", onclick: (e) => { e.stopPropagation(); const r = card.getBoundingClientRect(), hr = host.getBoundingClientRect(); openMenu(current, r.right - hr.left - 8, r.top - hr.top + 26); } }, "⋯"),
        el("button", { class: "ghost sc-fold", title: collapsed ? "Expand" : "Collapse", onclick: (e) => { e.stopPropagation(); collapsed = !collapsed; refresh(true); } }, collapsed ? "▸" : "▾"),
        el("button", { class: "ghost sc-close", title: "Deselect (Esc)", onclick: (e) => { e.stopPropagation(); onClose?.(); } }, "×"));
      card.append(head, el("div", { class: "sc-lines" }));
      if (!collapsed && acts.length) card.append(el("div", { class: "sc-acts" }, ...acts.map((a) => button(a, current))));
    }
    card.classList.toggle("collapsed", collapsed);
    const sub = card.querySelector(".sc-sub");
    if (sub && sub.textContent !== (d.sub || "")) sub.textContent = d.sub || "";
    const box = card.querySelector(".sc-lines");
    const lines = collapsed ? [] : (d.lines || []).filter(Boolean);
    const txt = lines.map((l) => (typeof l === "string" ? l : l.text)).join("\n");
    if (box && box.dataset.txt !== txt) {
      box.dataset.txt = txt;
      box.innerHTML = "";
      for (const l of lines) box.append(el("div", { class: typeof l === "string" ? "" : l.cls || "", title: typeof l === "string" ? null : l.title || null }, typeof l === "string" ? l : l.text));
    }
  }

  /** Context menu at host-relative x, y. */
  function openMenu(target, x, y) {
    const acts = applicable(target);
    if (!acts.length) { closeMenu(); return; }
    menu.innerHTML = "";
    const d = describe(target);
    if (d?.title) menu.append(el("div", { class: "sm-title" }, d.title));
    let group = null;
    for (const a of acts) {
      if (a.group && a.group !== group && group !== null) menu.append(el("div", { class: "sm-sep" }));
      group = a.group || group;
      const hint = a.hint?.(target);
      menu.append(el("button", {
        class: `sm-item${a.active?.(target) ? " active" : ""}`, role: "menuitem",
        onclick: (e) => { e.stopPropagation(); closeMenu(); a.run(target); refresh(true); },
      }, el("span", { class: "ic" }, a.icon || ""), el("span", { class: "lbl" }, a.label, hint ? el("small", {}, hint) : ""),
      a.key ? el("kbd", {}, a.key) : ""));
    }
    menu.classList.remove("hidden");
    // Keep it inside the host.
    const hw = host.clientWidth, hh = host.clientHeight;
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(hw - mw - 4, x))}px`;
    menu.style.top = `${Math.max(4, Math.min(hh - mh - 4, y))}px`;
    menu.querySelector(".sm-item")?.focus();
  }
  function closeMenu() { menu.classList.add("hidden"); }
  const menuOpen = () => !menu.classList.contains("hidden");

  // Close on any outside click / Escape / scroll of the host.
  document.addEventListener("pointerdown", (e) => { if (menuOpen() && !menu.contains(e.target)) closeMenu(); }, true);
  menu.addEventListener("keydown", (e) => {
    const items = [...menu.querySelectorAll(".sm-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  });

  return { card, menu, set, refresh, openMenu, closeMenu, menuOpen, get target() { return current; } };
}
