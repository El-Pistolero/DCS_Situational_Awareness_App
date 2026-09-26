// Live second-screen view.

import {
  api, aspectDeg, bearing, braa, distance, el, fmtAlt, fmtDist, fmtHdg, fmtNum, fmtSpeed, fmtVs, isHostile, isNum,
  sideColor, units, wrap180, M_TO_FT,
} from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawEdgePointers, drawScene } from "./symbols.js";
import { Scene3D } from "./scene3d.js";
import { bindShortcuts } from "./keys.js";
import { watchRecordings } from "./watch.js";
import { MODES, createSettings, modeSwitch, reflectMode } from "./modes.js";
import { createDisplayPanel } from "./layers.js";
import { createSelectionUI } from "./selmenu.js";
import { COORD_FORMATS, copyText, fmtCoord } from "./coords.js";
import { AMBER, HEAT_NOTE, drawHeatLobes, flareColor } from "./irviz.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.live.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.live.${k}`, v); } catch { /* ignore */ } };
const AIR = ["fixedwing", "rotorcraft", "air"];
const RANGES = [5, 10, 20, 40, 80, 160];
const LB = 2.20462;
const NM = 1852;
const WRECK_S = 300; // wreck markers fade out over five minutes (mission time)
const PIP_MS = 10000; // DCS hit pips
const TARGET_KEY = "dcs-sa.live.target";

// Display settings.  The manual A-A / A-G modes overlay their own values on
// the keys they manage; ALL is always exactly the user's own settings.  The
// existing "range" (raw "40"), "radar" and "bullets" preferences read as before.
const SET = createSettings({
  prefix: "dcs-sa.live.",
  base: {
    range: 40, radar: "all", bullets: "paths", rings: "all", ground: "show", labels: "aircraft", vectors: 0, braa: false,
    myWeapons: true, lar: true, wrecks: true, northArrow: true, coords: "ddm", irHeat: true,
  },
  modeDefaults: {
    a2a: { range: 20, radar: "all", rings: "near", ground: "threats", labels: "aircraft", vectors: 10, braa: true, myWeapons: false, lar: false, wrecks: false },
    a2g: { range: 40, radar: "focus", rings: "hostile", ground: "show", labels: "targets", vectors: 0, braa: false, myWeapons: true, lar: true, wrecks: true },
  },
});
const cfg = (k) => SET.get(k);
const rangeNm = () => { const r = +cfg("range"); return isNum(r) && r > 0 ? r : 40; };

const map = new TacticalMap($("map"), { layer: pref("layer", "satellite") });
const S = {
  snap: null, trails: new Map(), headingUp: pref("hdgUp", "1") === "1",
  sound: false, lastMissiles: new Set(), events: [], userPanned: false, panTimer: null,
  cam: pref("cam", "chase"),
  glance: pref("glance", "0") === "1", glanceAuto: false, lastMissileAt: 0,
  padlockId: null, hist: [], histKey: null, home: null, homeTried: 0, bingoShown: false,
  bridgeSeen: false, bridgeLostAt: null, seenHits: new Set(), status: null,
  // Selection, target mark and what the user hid or pinned.
  sel: null, hidden: new Set(), pinned: new Set(), target: loadTarget(),
  // Destroyed units: id -> death time (still in the picture) and removed wrecks; DCS hit pips.
  dead: new Map(), wrecks: new Map(), pips: [], wpnSeen: new Map(), lastSeq: 0, firstSnap: true,
};

const isAir = (o) => AIR.includes(o?.category);
const isSurface = (o) => o?.category === "ground" || o?.category === "sea";
const isThreatUnit = (o) => isNum(o?.v?.EngagementRange) && o.v.EngagementRange > 0;
const wLabel = (name) => String(name || "").replace(/_/g, "-");
// Submunitions: flagged by the server ("sub"), or known by name when it is not.
const isBomblet = (o) => o.sub === true || (o.category === "weapon" && /^(BLU-97|BLU-108|Mk[-_ ]?118|PTAB|AO-2[.,]5)/i.test(o.name || ""));
const myWeapons = (snap) => (Array.isArray(snap?.myWeapons) ? snap.myWeapons : []);
const focusObj = (snap = S.snap) => snap?.objects.find((o) => o.id === snap.focus) || null;
const hotCold = (asp) => (isNum(asp) ? (asp >= 135 ? "HOT" : asp <= 45 ? "COLD" : "FLANK") : "");

/** m:ss for times to impact ("0:42"). */
function mmss(sec) {
  if (!isNum(sec)) return "—";
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Ids no mode, filter or "Hide it" may take off the map: missiles guided at me, emitters spiking me. */
function protectedIds(snap) {
  const ids = new Set();
  for (const t of snap?.threats || []) if (t.kind === "missile" || t.spike) ids.add(t.id);
  return ids;
}

/** Trail plus the current position, without repeating it (the server's trail may already end there). */
function withHead(trail, head) {
  const last = trail[trail.length - 1];
  return last && last[0] === head[0] && last[1] === head[1] ? [...trail] : [...trail, head];
}

/** Live rounds -> the drawable shape roundsAt() produces for recordings. */
function liveRounds(snap) {
  if (cfg("bullets") === "off") return [];
  return (snap.rounds || []).map((r) => ({
    id: r.id, color: r.color, coalition: r.coalition, impacted: false, fade: 1,
    pts: withHead(r.trail || [], [r.lon, r.lat, r.alt]), head: [r.lon, r.lat, r.alt],
  }));
}

let scene3d = null;
S.view = "2d";
function setView(view) {
  S.view = view;
  if (view === "3d" && !scene3d) {
    try {
      scene3d = new Scene3D(document.querySelector(".lv-map"));
      scene3d.onPick = (id) => select(id);
      scene3d.onContext = (id, { clientX, clientY, lon, lat } = {}) => {
        const r = document.querySelector(".lv-map").getBoundingClientRect();
        const obj = id && S.snap?.objects.find((o) => o.id === id);
        const target = obj ? { kind: "object", id, o: obj } : isNum(lon) ? { kind: "point", lon, lat } : null;
        if (!target) return;
        if (obj && S.sel?.id !== id) select(id);
        sel.openMenu(target, clientX - r.left, clientY - r.top);
      };
    } catch (err) { alert(`3D view unavailable: ${err.message}`); S.view = "2d"; return; }
  }
  const is3d = S.view === "3d";
  document.body.classList.toggle("is3d", is3d);
  $("map").style.display = is3d ? "none" : "block";
  scene3d?.setVisible(is3d);
  $("btn2d").classList.toggle("active", !is3d);
  $("btn3d").classList.toggle("active", is3d);
  setPref("view", S.view);
  if (is3d) setCam(S.cam);
}
function setCam(mode) {
  S.cam = mode;
  scene3d?.setMode(mode);
  $("btnOrbit").classList.toggle("active", mode === "orbit");
  $("btnChase").classList.toggle("active", mode === "chase");
  $("btnPadlock").classList.toggle("active", mode === "padlock");
  setPref("cam", mode);
}
function cycleCam() {
  const order = ["orbit", "chase", "padlock"];
  setCam(order[(order.indexOf(S.cam) + 1) % order.length]);
}
$("btn2d").onclick = () => setView("2d");
$("btn3d").onclick = () => setView("3d");
$("btnOrbit").onclick = () => setCam("orbit");
$("btnChase").onclick = () => setCam("chase");
$("btnPadlock").onclick = () => setCam("padlock");

// -- controls ---------------------------------------------------------------

for (const [k, v] of Object.entries(LAYERS)) $("layerSel").append(el("option", { value: k }, v.label));
$("layerSel").value = map.layer;
$("layerSel").onchange = (e) => { map.setLayer(e.target.value); setPref("layer", e.target.value); };

/** Header controls show the effective (mode-aware) values. */
function syncControls() {
  $("radarSel").value = cfg("radar");
  $("bulletSel").value = cfg("bullets");
  $("rangeSel").value = String(rangeNm());
  map.northArrow = !!cfg("northArrow");
}
// Written through the settings: a change made in A-G stays in A-G, ALL keeps the user's own.
$("radarSel").onchange = (e) => SET.set("radar", e.target.value);
$("bulletSel").onchange = (e) => SET.set("bullets", e.target.value);
$("rangeSel").onchange = (e) => SET.set("range", +e.target.value);
syncControls();

function redraw() { if (S.snap) onSnapshot(S.snap, { redraw: true }); else map.invalidate(); }
function stepRange(dir) {
  const i = RANGES.indexOf(rangeNm());
  const j = Math.max(0, Math.min(RANGES.length - 1, (i < 0 ? 3 : i) + dir));
  SET.set("range", RANGES[j]);
}
const orientLabel = () => { $("btnOrient").textContent = S.headingUp ? "Heading up" : "North up"; };
orientLabel();
function toggleOrient() { S.headingUp = !S.headingUp; setPref("hdgUp", S.headingUp ? "1" : "0"); orientLabel(); if (!S.headingUp) map.setRotation(0); }
function toggleSound() {
  S.sound = !S.sound;
  $("btnSound").textContent = S.sound ? "🔊 Sound" : "🔇 Sound";
  if (S.sound) beep(880, 0.08);
}
$("btnOrient").onclick = toggleOrient;
$("btnSound").onclick = toggleSound;
function recenter() { S.userPanned = false; clearTimeout(S.panTimer); redraw(); }
map.on("viewchange", (e) => {
  if (!e?.user) return;
  S.userPanned = true;
  clearTimeout(S.panTimer);
  S.panTimer = setTimeout(() => { S.userPanned = false; }, 15000);
});

function hitAt(px, py) {
  let best = null, bd = Infinity;
  for (const h of hits) {
    const d = Math.hypot(h.x - px, h.y - py);
    if (d < Math.max(h.r, 12) && d < bd) { best = h; bd = d; }
  }
  return best;
}

map.on("click", ({ px, py }) => {
  // Edge arrows first: bring that contact into view.
  for (const h of ptrHits) {
    if (Math.hypot(h.x - px, h.y - py) > h.r) continue;
    if (h.item.home) return;
    // Pick the range at which the contact lands inside the arrow rectangle
    // (not just inside the outer ring), and always zoom out at least a step.
    const [fx, fy] = ptrFrom;
    const avail = Math.max(40, Math.hypot(h.x - fx, h.y - fy)) * 0.9;
    const ringPx = Math.min(map.w, map.h) * 0.45;
    const need = ((h.item.range || 0) / NM) * ringPx / avail;
    const next = RANGES.find((r) => r >= need && r > rangeNm()) || RANGES[RANGES.length - 1];
    SET.set("range", next);
    return;
  }
  // A click selects; changing the view is the card's "View from here" (or a double click).
  const best = hitAt(px, py);
  if (best) select(best.id);
});
$("map").addEventListener("dblclick", (e) => {
  const r = $("map").getBoundingClientRect();
  const h = hitAt(e.clientX - r.left, e.clientY - r.top);
  const o = h && S.snap?.objects.find((x) => x.id === h.id);
  if (o && isAir(o)) viewFrom(o.id);
});
map.on("contextmenu", (ev) => {
  ev.event.preventDefault();
  if (!S.snap) return;
  const h = hitAt(ev.px, ev.py);
  const o = h && S.snap.objects.find((x) => x.id === h.id);
  if (o && S.sel?.id !== o.id) select(o.id);
  sel.openMenu(o ? { kind: "object", id: o.id, o } : { kind: "point", lon: ev.lonlat[0], lat: ev.lonlat[1] }, ev.px, ev.py);
});

let audioCtx = null;
function beep(freq = 1000, dur = 0.12) {
  try {
    audioCtx ||= new AudioContext();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = freq; o.type = "square";
    g.gain.value = 0.06;
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* audio unavailable */ }
}

// -- glance mode -----------------------------------------------------------------

function setGlance(on, { auto = false } = {}) {
  const wasAuto = S.glanceAuto && !on; // auto exit after an auto entry
  S.glance = on;
  S.glanceAuto = on && auto;
  document.body.classList.toggle("glance", on);
  $("btnGlance").classList.toggle("active", on);
  if (!auto && !wasAuto) setPref("glance", on ? "1" : "0"); // automatic switching is never saved
  map.invalidate();
  if (S.snap) onSnapshot(S.snap, { redraw: true });
}
$("btnGlance").onclick = () => setGlance(!S.glance);
// One listener per list: rows are rebuilt five times a second, so a per-row
// onclick would often be lost between mousedown and mouseup.
$("threats").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".threat[data-id]");
  if (!row) return;
  S.padlockId = row.dataset.id;
  select(row.dataset.id);
});
$("wpns").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".wif-row[data-id]");
  if (row && S.snap?.objects.some((o) => o.id === row.dataset.id)) select(row.dataset.id);
});
$("own").addEventListener("dblclick", () => setGlance(!S.glance));
$("autoGlance").checked = pref("autoGlance", "0") === "1";
$("autoGlance").onchange = (e) => setPref("autoGlance", e.target.checked ? "1" : "0");
document.body.classList.toggle("glance", S.glance);
$("btnGlance").classList.toggle("active", S.glance);

// -- modes and the Display panel ---------------------------------------------------

const MODE_BLURB = {
  a2a: "aircraft, missiles, BRAA and vectors; only SAMs that can reach you",
  a2g: "my weapons, JSOW range, target mark, SAM rings and ground units",
};
$("modeSw").append(modeSwitch(SET));
reflectMode(SET, { chip: $("modeChip"), describe: (m) => MODE_BLURB[m] || "" });
SET.on((ev) => {
  syncControls();
  // A new range (or mode) re-centres on the jet, as picking a range always did.
  if (ev.type !== "set" || ev.key === "range") recenter(); else redraw();
  renderMapChips(true);
});

const DISPLAY = [
  { title: "Threats & sensors", rows: [
    { key: "rings", label: "SAM / AAA rings", type: "select", options: [["all", "All"], ["hostile", "Hostile to me"], ["near", "Hostile, when near"], ["off", "Off"]] },
    { key: "radar", label: "Radar cones", type: "select", options: [["all", "All (incl. assumed)"], ["known", "Known only"], ["focus", "My jet"], ["none", "Off"]] },
    { key: "braa", label: "BRAA from me on bandits", type: "toggle" },
    { key: "irHeat", label: "My heat when an IR missile is inbound", type: "toggle", title: HEAT_NOTE },
  ] },
  { title: "Objects", rows: [
    { key: "ground", label: "Ground & ships", type: "select", options: [["show", "Show"], ["threats", "Only SAM / AAA / armed ships"], ["hide", "Hide"]] },
    { key: "bullets", label: "Gun rounds", type: "select", options: [["paths", "On"], ["off", "Off"]] },
    { key: "wrecks", label: "Wrecks and hit marks", type: "toggle", title: "Destroyed units as grey X (fading over 5 min), DCS hits as orange pips" },
  ] },
  { title: "Ground attack", rows: [
    { key: "myWeapons", label: "My weapons: path to impact, TTI", type: "toggle" },
    { key: "lar", label: "JSOW launch zone (DCS table)", type: "toggle", title: "Max / min range for your height and speed, from DCS's own AI launch table" },
  ] },
  { title: "Labels & map", rows: [
    { key: "labels", label: "Labels", type: "select", options: [["aircraft", "Aircraft"], ["targets", "Aircraft + targets"], ["all", "All"], ["minimal", "Minimal"], ["none", "Off"]] },
    { key: "vectors", label: "Velocity vectors", type: "select", options: [[0, "Off"], [10, "10 s"], [30, "30 s"], [60, "60 s"]] },
    { key: "range", label: "Map range", type: "select", options: RANGES.map((r) => [r, `${r} nm`]) },
    { key: "northArrow", label: "North arrow", type: "toggle" },
    { key: "coords", label: "Coordinates", type: "select", options: COORD_FORMATS },
  ] },
];
const display = createDisplayPanel($("btnDisplay"), document.querySelector(".lv"), { sections: DISPLAY, settings: SET });

// -- selection ------------------------------------------------------------------

/** The object as it is now (the card target keeps the last row it saw). */
function liveObj(tg) { return S.snap?.objects.find((o) => o.id === tg.id) || tg.o; }

function select(id) {
  const o = id && S.snap?.objects.find((x) => x.id === id);
  S.sel = o ? { kind: "object", id, o } : null;
  sel.set(S.sel);
  redraw();
}
function deselect() {
  S.sel = null;
  sel.closeMenu();
  sel.set(null);
  redraw();
}
function openSelectionMenu() {
  if (!S.sel) return;
  const r = sel.card.getBoundingClientRect(), h = document.querySelector(".lv-map").getBoundingClientRect();
  // Beside the card (it sits bottom-left), so both stay readable.
  sel.openMenu(S.sel, r.width ? r.right - h.left + 6 : 60, r.width ? r.top - h.top : 60);
}

async function viewFrom(id) {
  try { await api("/api/live/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }); } catch { /* offline */ }
  recenter();
}
/** Viewing from another jet?  With no DCS bridge there is no "own" id: then a locked focus is the tell. */
function canGoBack(snap = S.snap) { return !!snap && (snap.ownId ? snap.focus !== snap.ownId : !!snap.focusLocked); }
// No own id: an unlocked focus lets the server pick the player's jet again.
const backToMe = () => viewFrom(S.snap?.ownId || null);

function loadTarget() {
  try { const t = JSON.parse(sessionStorage.getItem(TARGET_KEY) || "null"); return t && isNum(t.lon) && isNum(t.lat) ? t : null; } catch { return null; }
}
function setTarget(t) {
  S.target = t;
  try { if (t) sessionStorage.setItem(TARGET_KEY, JSON.stringify(t)); else sessionStorage.removeItem(TARGET_KEY); } catch { /* private mode */ }
  renderMapChips(true);
  redraw();
}
function toggleTarget(tg) {
  if (tg.kind === "point") { setTarget({ id: null, name: "point", lon: tg.lon, lat: tg.lat, alt: null }); return; }
  const o = liveObj(tg);
  if (S.target?.id === o.id) { setTarget(null); return; }
  setTarget({ id: o.id, name: o.name, lon: o.lon, lat: o.lat, alt: isNum(o.alt) ? o.alt : null });
}

function flash(msg) {
  const c = $("modeChip");
  c.textContent = msg;
  c.className = "modechip";
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => c.classList.add("hidden"), 3000);
}

async function copyAs(tg, what) {
  const p = tg.kind === "point" ? { lon: tg.lon, lat: tg.lat, alt: null } : liveObj(tg);
  const me = focusObj();
  if (!p) return;
  let txt = "";
  if (what === "braa") {
    if (!me) return;
    txt = `BRAA ${braa(me.lon, me.lat, p.lon, p.lat, isAir(p) ? p.alt : null)}`;
  } else {
    txt = fmtCoord(p.lon, p.lat, cfg("coords") || "ddm");
    // A surface unit's altitude is its ground elevation: what a steerpoint needs.
    if (isSurface(p) && isNum(p.alt)) txt += ` · elev ${fmtAlt(p.alt)}`;
  }
  if (!txt) return; // e.g. MGRS does not exist beyond 84° N / 80° S
  const ok = await copyText(txt);
  flash(ok ? `Copied: ${txt}` : `Copy failed: ${txt}`);
}
const copyDefault = (tg) => copyAs(tg, tg.kind === "object" && isAir(liveObj(tg)) ? "braa" : "coords");

/** The bullseye for my side (any, when my side is unknown). */
function bullseyeFor(snap, me) {
  const all = (snap?.objects || []).filter((o) => o.category === "bullseye");
  return all.find((b) => me && b.coalition === me.coalition) || all[0] || null;
}

/** Card text for a target. */
function describe(tg) {
  const snap = S.snap;
  if (!tg || !snap) return null;
  const me = focusObj(snap);
  const fmt = cfg("coords") || "ddm";
  if (tg.kind === "point") {
    const lines = [fmtCoord(tg.lon, tg.lat, fmt)];
    if (me) lines.push(`BRAA ${braa(me.lon, me.lat, tg.lon, tg.lat)}`);
    return { title: "Map point", sub: "right-click menu", color: "#ffd166", lines };
  }
  const cur = snap.objects.find((x) => x.id === tg.id);
  const o = cur || tg.o;
  const v = o.v || {}, d = o.d || {};
  const lines = [];
  const sub = [o.pilot && o.name !== o.pilot ? o.name : "", o.group, o.coalition].filter(Boolean).join(" · ");
  if (isAir(o)) {
    lines.push([fmtAlt(o.alt), fmtSpeed(v.IAS ?? v.TAS ?? d.gs), fmtHdg(o.hdg)].join(" · "));
  } else if (o.category === "weapon") {
    lines.push([fmtSpeed(v.TAS ?? d.gs), fmtAlt(o.alt)].join(" · "));
    const w = myWeapons(snap).find((x) => x.id === o.id);
    if (w) {
      const res = w.impacted ? weaponResult(w) || (w.dispensed ? "opened" : "impact") : `TTI ${isNum(w.tti) ? `~${mmss(w.tti)}` : "—"}`;
      lines.push(`${res}${w.targetName ? ` → ${w.targetName}` : ""}${w.estimated ? " (estimate)" : ""}`);
    }
  } else {
    const r = v.EngagementRange;
    if (isNum(r) && r > 0 && !S.dead.has(o.id)) {
      const edge = me ? distance(me.lon, me.lat, o.lon, o.lat) - r : null;
      lines.push(`ring ${fmtDist(r)}${o.engSrc ? ` (${o.engSrc})` : ""}${isNum(edge) ? ` · me ${fmtDist(Math.abs(edge))} ${edge >= 0 ? "outside" : "inside"}` : ""}`);
    }
    lines.push(`${fmtCoord(o.lon, o.lat, fmt)}${isNum(o.alt) && isSurface(o) ? ` · elev ${fmtAlt(o.alt)}` : ""}`);
  }
  if (S.dead.has(o.id)) lines.push({ text: "destroyed", cls: "bad" });
  if (me && o.id !== me.id) {
    const asp = isAir(o) && isNum(o.hdg) ? aspectDeg(o.lon, o.lat, o.hdg, me.lon, me.lat) : null;
    lines.push(`BRAA ${braa(me.lon, me.lat, o.lon, o.lat, isAir(o) ? o.alt : null)} ${hotCold(asp)}`.trim());
  }
  const be = bullseyeFor(snap, me);
  if (be && o.category !== "weapon" && o.category !== "bullseye") lines.push(`BULLS ${braa(be.lon, be.lat, o.lon, o.lat, isAir(o) ? o.alt : null)}`);
  if (!cur) lines.push({ text: "no longer in the picture", cls: "faint" });
  const tagMe = o.id === snap.ownId ? " (me)" : o.id === snap.focus ? " (view)" : "";
  return { title: `${o.pilot || o.name}${tagMe}`, sub, color: sideColor(o), lines };
}

const onObj = (fn) => (tg) => tg.kind === "object" && fn(liveObj(tg), tg);
/** Hiding never applies to my own view, missiles at me or emitters spiking me. */
const canHide = (o) => o.id !== S.snap?.focus && o.id !== S.snap?.ownId && !protectedIds(S.snap).has(o.id);
const ACTIONS = [
  { id: "view", label: "View from here", key: "dbl-click", icon: "⌖", primary: true, group: "view", applies: onObj((o) => isAir(o) && o.id !== S.snap?.focus),
    run: (tg) => viewFrom(tg.id) },
  { id: "back", label: "Back to my jet", key: "B", icon: "↩", group: "view", applies: () => canGoBack(), run: () => backToMe() },
  { id: "padlock", label: "Padlock in 3D", icon: "◎", group: "view", applies: onObj((o) => o.id !== S.snap?.focus && !isBomblet(o)),
    run: (tg) => { S.padlockId = tg.id; if (S.view !== "3d") setView("3d"); setCam("padlock"); redraw(); } },
  { id: "target", label: "Mark as target", short: "Target", icon: "◇", primary: true, group: "show", applies: onObj((o) => isSurface(o)),
    active: (tg) => S.target?.id === tg.id, run: toggleTarget },
  { id: "targetpt", label: "Mark as target here", short: "Target here", icon: "◇", primary: true, group: "show", applies: (tg) => tg.kind === "point", run: toggleTarget },
  { id: "pin", label: "Pin its ring", short: "Pin ring", icon: "📌", primary: true, group: "show", applies: onObj((o) => isThreatUnit(o) && !S.dead.has(o.id)),
    active: (tg) => S.pinned.has(tg.id), run: (tg) => { S.pinned.has(tg.id) ? S.pinned.delete(tg.id) : S.pinned.add(tg.id); renderMapChips(true); redraw(); } },
  { id: "hide", label: "Hide it", icon: "⊘", group: "show", applies: onObj((o) => canHide(o)),
    run: (tg) => { S.hidden.add(tg.id); if (S.sel?.id === tg.id) deselect(); renderMapChips(true); redraw(); } },
  { id: "copybraa", label: "Copy BRAA from me", icon: "⧉", group: "copy", applies: (tg) => !!focusObj() && !(tg.kind === "object" && tg.id === S.snap?.focus),
    run: (tg) => copyAs(tg, "braa") },
  { id: "copypos", label: "Copy coordinates", key: "Ctrl+C", icon: "⧉", group: "copy", applies: () => true,
    hint: () => ((cfg("coords") || "ddm") === "ddm" ? "deg-min, as the DED" : ""), run: (tg) => copyAs(tg, "coords") },
];

const sel = createSelectionUI(document.querySelector(".lv-map"), {
  actions: ACTIONS, describe, cardHost: $("selCol"), onClose: () => deselect(),
});

/** Chips on the map for states that change what is shown or from where (never silent). */
let chipSig = "";
function renderMapChips(force = false) {
  const snap = S.snap;
  const back = canGoBack(snap);
  const sig = [back, S.target?.name, S.hidden.size, S.pinned.size, SET.mode].join("|");
  if (!force && sig === chipSig) return; // rebuilt only on change: a click must survive the 5 Hz refresh
  chipSig = sig;
  const box = $("mapChips");
  box.innerHTML = "";
  const add = (txt, onclick, cls = "", title = "Clear") => box.append(el("button", { class: `mapchip ${cls}`, title, onclick }, txt));
  if (back) add("↩ Back to my jet", backToMe, "back", "View from your own jet again (B)");
  if (S.target) add(`Target: ${S.target.name} ×`, () => setTarget(null), "tgt");
  if (S.hidden.size) add(`${S.hidden.size} hidden ×`, () => { S.hidden.clear(); renderMapChips(true); redraw(); }, "", "Show them again");
  if (S.pinned.size) add(`${S.pinned.size} ring${S.pinned.size > 1 ? "s" : ""} pinned ×`, () => { S.pinned.clear(); renderMapChips(true); redraw(); }, "", "Unpin");
  if (SET.mode !== "all") {
    const m = MODES.find((x) => x.id === SET.mode);
    add(`${m.label} mode ×`, () => SET.setMode("all"), `m-${SET.mode}`, "Back to ALL (your own settings)");
  }
}

// -- setup dialog -------------------------------------------------------------

function bingoKg() { const v = parseFloat(pref("bingoKg", "")); return isNum(v) && v > 0 ? v : null; }
function showBingoInput() {
  const kg = bingoKg();
  $("bingoUnit").textContent = units.metric ? "kg" : "lb";
  $("bingoIn").value = kg ? String(Math.round(units.metric ? kg : kg * LB)) : "";
  $("jokerOut").textContent = kg ? `Joker ${Math.round((units.metric ? kg : kg * LB) * 1.2).toLocaleString()} ${units.metric ? "kg" : "lb"}` : "Joker = bingo × 1.2";
}
$("bingoIn").oninput = (e) => {
  const v = parseFloat(e.target.value);
  setPref("bingoKg", isNum(v) && v > 0 ? String(units.metric ? v : v / LB) : "");
  S.bingoShown = false;
  showBingoInput();
  if (S.snap) onSnapshot(S.snap, { redraw: true });
};

async function openSetup() {
  const dlg = $("setup");
  showBingoInput();
  try {
    const [{ body: st }, { body: lib }] = await Promise.all([api("/api/status"), api("/api/recordings")]);
    S.status = st;
    $("tvHost").value = st.tacview.host; $("tvPort").value = st.tacview.port;
    $("rpFile").innerHTML = "";
    for (const r of lib.recordings) $("rpFile").append(el("option", { value: r.key }, r.name));
    const b = st.bridge;
    const p = st.profile || {};
    $("bridgeInfo").innerHTML = "";
    $("bridgeInfo").append(
      el("div", {}, `DCS bridge: ${b.listening ? `listening on UDP ${b.port}` : "not listening"} · ${b.packets ? `${b.packets} packets received` : "no data yet"}`),
      el("div", {}, p.found ? `DCS profile: ${p.player || "(no logbook pilot found)"} · bridge ${p.bridgeInstalled ? "installed" : "NOT installed in Export.lua"}` : "DCS Saved Games folder not found on this PC."),
      // Without Tacview's own exporter DCS records nothing, and its page is missing from Options -> Special.
      p.found && !p.tacviewInstalled
        ? el("div", { class: "warn" }, "Tacview's recorder is NOT installed in DCS, so DCS writes no recordings and has no ",
            el("b", {}, "Options → Special → Tacview"), " page. ",
            el("a", { href: "/guide?from=live#step-4-record-your-own-flights" }, "How to install it"))
        : null);
  } catch { /* offline */ }
  if (!dlg.open) dlg.showModal();
}
import("./settings.js").then((m) => m.wireSettingsButton("btnSettings"));
import("./console.js").then((m) => m.reportPageErrors());
$("btnSetup").onclick = openSetup;
$("btnSetup2").onclick = openSetup;
const post = (body) => api("/api/live/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
$("btnTv").onclick = async () => { await post({ type: "tacview", host: $("tvHost").value, port: +$("tvPort").value, password: $("tvPass").value }); $("setup").close(); };
$("btnRp").onclick = async () => { await post({ type: "replay", key: $("rpFile").value, speed: +$("rpSpeed").value }); $("setup").close(); };
$("btnInstall").onclick = async () => {
  try {
    const { body } = await api("/api/install-bridge", { method: "POST" });
    alert(body.ok ? `Installed in:\n${body.installed.join("\n")}\n\nNow quit DCS completely and start it again: DCS only reads these scripts when it starts.` : body.error);
  } catch (err) { alert(`Install failed: ${err.message}`); }
  openSetup();
};
$("btnDisc").onclick = async () => { await post({ type: "none" }); S.trails.clear(); };

// -- keyboard -----------------------------------------------------------------------

const LIVE_KEYS = [
  { keys: ["Shift+C"], group: "Panels", label: "Console (diagnostics)",
    run: () => import("./console.js").then((m) => m.openConsole()) },
  { keys: ["v"], group: "View", label: "2D / 3D", run: () => setView(S.view === "3d" ? "2d" : "3d") },
  { keys: ["c"], group: "View", label: "3D camera: orbit → chase → padlock", when: () => S.view === "3d", run: () => cycleCam() },
  { keys: ["t"], group: "View", label: "Padlock: next threat", run: () => cyclePadlock() },
  { keys: ["+", "="], group: "View", label: "Zoom out (larger range)", run: () => stepRange(1) },
  { keys: ["-"], group: "View", label: "Zoom in (smaller range)", run: () => stepRange(-1) },
  { keys: ["h"], group: "View", label: "Heading-up / north-up", run: () => toggleOrient() },
  { keys: ["n"], group: "View", label: "Re-centre on my jet", run: () => recenter() },
  { keys: ["b"], group: "View", label: "Back to my jet (after View from here)", when: () => canGoBack(), run: () => backToMe() },
  { keys: ["g"], group: "View", label: "Glance (big-number) layout", run: () => setGlance(!S.glance) },
  { keys: ["d"], group: "View", label: "Display options", run: () => display.toggle() },
  { keys: ["Shift+a"], group: "Mode", label: "Dogfight (A-A) mode on / off", run: () => SET.toggle("a2a") },
  { keys: ["Shift+g"], group: "Mode", label: "Ground-attack (A-G) mode on / off", run: () => SET.toggle("a2g") },
  { keys: ["e"], group: "Selection", label: "Actions for the selection (or right-click it)", when: () => !!S.sel, run: () => openSelectionMenu() },
  { keys: ["Escape"], group: "Selection", label: "Close the panel or menu, then deselect", when: () => display.isOpen() || sel.menuOpen() || !!S.sel,
    run: () => (display.isOpen() ? display.close() : sel.menuOpen() ? sel.closeMenu() : deselect()) },
  { keys: ["Ctrl+c"], group: "Selection", label: "Copy BRAA (aircraft) / coordinates of the selection", when: () => !!S.sel && !String(window.getSelection?.() || ""),
    run: () => copyDefault(S.sel) },
  { keys: ["s"], group: "Panels", label: "Missile warning sound on / off", run: () => toggleSound() },
  { keys: ["Ctrl+,"], group: "Panels", label: "Connect…", run: () => openSetup() },
];
const keys = bindShortcuts(LIVE_KEYS);
$("btnKeys").onclick = () => keys.help();

// -- new recordings --------------------------------------------------------------------

watchRecordings({
  host: document.querySelector(".lv-map"), placement: "bottom",
  openHere: async (key) => {
    if (S.status?.desktop) {
      try {
        const { body } = await api("/api/open-debrief", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key }) });
        if (body?.ok) return; // no debrief window to switch (e.g. started with --live): open one below
      } catch { /* fall through */ }
    }
    window.open(`/#rec=${key}`, "dcs-sa-debrief");
  },
  onNew: () => { S.bridgeLostAt = null; S.bridgeSeen = false; },
});
api("/api/status").then(({ body }) => { S.status = body; }).catch(() => {});

// -- stream -------------------------------------------------------------------

function connect() {
  const es = new EventSource("/api/live/stream?rate=5");
  es.onmessage = (m) => { try { onSnapshot(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.onerror = () => { $("status").textContent = "App not reachable, retrying…"; $("recDot").className = "rec"; };
}

/** Bookkeeping for a new snapshot: trails, events, deaths, wrecks, hit pips, my weapons. */
function ingest(snap) {
  if (snap.session !== S.session) {
    // New live session (reconnect / mission restart): start clean.  The
    // target mark stays (it is the user's, for the browser session).
    S.session = snap.session;
    S.events = [];
    S.trails.clear();
    S.lastMissiles = new Set();
    S.hist = []; S.home = null; S.homeTried = 0; S.bingoShown = false; S.seenHits.clear();
    S.dead.clear(); S.wrecks.clear(); S.pips = []; S.wpnSeen.clear(); S.hidden.clear(); S.lastSeq = 0;
    S.firstSnap = true;
  }
  S.snap = snap;
  // Maintain trails client-side; the server only sends them occasionally.
  const alive = new Set();
  for (const o of snap.objects) {
    alive.add(o.id);
    if (isBomblet(o)) continue; // a JSOW-A releases 145: dots, no trails
    let tr = S.trails.get(o.id);
    if (o.trail) { tr = o.trail.slice(); S.trails.set(o.id, tr); }
    else if ([...AIR, "weapon"].includes(o.category)) {
      if (!tr) { tr = []; S.trails.set(o.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || last[0] !== o.lon || last[1] !== o.lat) tr.push([o.lon, o.lat, o.alt]);
      if (tr.length > 400) tr.splice(0, tr.length - 400);
    }
  }
  for (const id of [...S.trails.keys()]) if (!alive.has(id)) S.trails.delete(id);
  const now = isNum(snap.time) ? snap.time : null;
  for (const e of snap.events || []) {
    // DCS hit runs are updated in place (same id, higher seq): replace the row.
    const i = isNum(e.id) ? S.events.findIndex((x) => x.id === e.id) : -1;
    if (i >= 0) S.events.splice(i, 1);
    S.events.unshift(e);
    if (e.againstMe && e.kind === "DCS hit" && !S.seenHits.has(e.id ?? e.seq)) {
      S.seenHits.add(e.id ?? e.seq);
      // Opening the page mid-mission replays old events: only alert on new hits.
      if (!isNum(snap.time) || !isNum(e.time) || snap.time - e.time < 5) flashHit(e);
    }
    // Tacview's "Destroyed" event: the unit may stay in the picture as a wreck.
    if (/^destroyed$/i.test(e.kind || "")) for (const id of e.objectIds || []) if (!S.dead.has(id)) S.dead.set(id, isNum(e.time) ? e.time : now);
    // Where a DCS hit landed (the first snapshot's events are history: no pips).
    if (!S.firstSnap && e.kind === "DCS hit" && isNum(e.targetLon) && isNum(e.targetLat)) S.pips.push({ lon: e.targetLon, lat: e.targetLat, at: performance.now() });
  }
  S.events.length = Math.min(S.events.length, 40);
  for (const d of snap.destroyed || []) {
    if (!d || !isNum(d.lon) || !isNum(d.lat) || S.wrecks.has(d.id)) continue;
    S.wrecks.set(d.id, { ...d, time: isNum(d.time) ? d.time : now });
  }
  // Results of my weapons are looked for in the events that came after each was first seen.
  for (const w of myWeapons(snap)) if (!S.wpnSeen.has(w.id)) S.wpnSeen.set(w.id, S.lastSeq);
  if (isNum(snap.eventSeq)) S.lastSeq = snap.eventSeq;
  // The target mark follows its unit while the unit is in the picture.
  if (S.target?.id) {
    const t = snap.objects.find((o) => o.id === S.target.id);
    if (t && (t.lon !== S.target.lon || t.lat !== S.target.lat)) {
      S.target = { ...S.target, lon: t.lon, lat: t.lat, alt: isNum(t.alt) ? t.alt : S.target.alt };
      try { sessionStorage.setItem(TARGET_KEY, JSON.stringify(S.target)); } catch { /* private mode */ }
    }
  }
  if (S.sel?.kind === "object") {
    const o = snap.objects.find((x) => x.id === S.sel.id);
    if (o) S.sel.o = o;
  }
  S.firstSnap = false;
}

function onSnapshot(snap, { redraw = false } = {}) {
  if (!redraw) ingest(snap);

  const st = snap.status || {};
  const bridge = snap.bridge?.state === "receiving" && snap.ownship;
  if (bridge) { S.bridgeSeen = true; S.bridgeLostAt = null; } else if (S.bridgeSeen && !S.bridgeLostAt) S.bridgeLostAt = Date.now();
  const live = st.state === "connected" || bridge;
  $("recDot").className = `rec ${live ? (snap.stale && !bridge ? "stale" : "on") : ""}`;
  const parts = [];
  if (st.source) parts.push(`${st.source === "tacview" ? "Tacview" : st.source === "replay" ? "Replay" : st.source}: ${st.state}${st.detail ? ` (${st.detail})` : ""}`);
  if (bridge) parts.push("DCS bridge: receiving");
  else if (S.bridgeLostAt && Date.now() - S.bridgeLostAt < 600000) parts.push("Mission ended — waiting for the Tacview recording…");
  $("status").textContent = parts.join(" · ") || "Not connected";
  $("status").title = $("status").textContent; // the header may leave it only a few pixels
  $("empty").classList.toggle("hidden", snap.objects.length > 0);

  const me = snap.objects.find((o) => o.id === snap.focus);
  if (me) {
    if (S.headingUp && isNum(me.hdg)) map.setRotation(me.hdg); else if (!S.headingUp) map.setRotation(0);
    if (!S.userPanned) {
      const px = Math.min(map.w, map.h) * 0.45;
      map.setView(me.lon, me.lat, map.zoomForRange(rangeNm() * NM, px));
    }
  }
  if (!redraw) pushHist(me, snap.ownship, snap);
  updateHome(me, snap.ownship);
  renderOwn(me, snap.ownship);
  renderThreats(snap.threats || []);
  renderWeapons(snap);
  renderEvents();
  renderStores(snap.ownship);
  renderRWR(snap.ownship, me);
  renderMapChips();
  sel.refresh();
  if (S.glanceAuto && Date.now() - S.lastMissileAt > 15000) setGlance(false);
  map.invalidate();
  if (S.view === "3d" && scene3d) {
    // The same objects as the 2D map (filters, hidden, bomblets as dots).
    const spiking = protectedIds(snap);
    scene3d.update(sceneObjects(snap, { for3d: true }).map((o) => ({ ...o, pitch: o.v?.Pitch, roll: o.v?.Roll })), {
      focusId: snap.focus, selectedId: S.sel?.kind === "object" ? S.sel.id : null, radar: S.glance ? "focus" : cfg("radar"),
      rounds: liveRounds(snap), padlockId: S.cam === "padlock" ? padlockTarget(snap) : null,
      rings: ringMode3d(), pinned: new Set([...S.pinned, ...spiking]),
      // My engine heat while a heat-seeker is inbound (a flame only when afterburner is known).
      heat: cfg("irHeat") && snap.heat && irInbound(snap).length
        ? (id) => (id === snap.focus ? { c: snap.heat.ab && snap.heat.irAB ? snap.heat.irAB : snap.heat.ir, lit: snap.heat.ab } : null) : null,
    });
    scene3d.setPointers(pointerList(snap).map((p) => ({ id: p.id, color: p.color, text: p.text })));
  }
}

/** 3D engagement domes follow the 2D ring setting ("near" has no 3D test: hostile). */
function ringMode3d() {
  const r = cfg("rings");
  return r === "off" ? "off" : r === "all" ? "all" : "hostile";
}

function flashHit(e) {
  const w = $("hitWarn");
  w.textContent = `HIT — ${e.text}`;
  w.classList.remove("hidden");
  clearTimeout(flashHit.timer);
  flashHit.timer = setTimeout(() => w.classList.add("hidden"), 4000);
  if (S.sound) beep(520, 0.25);
}

// -- padlock & pointers ------------------------------------------------------------------

function padlockTarget(snap) {
  const ids = new Set(snap.objects.map((o) => o.id));
  if (S.padlockId && ids.has(S.padlockId)) return S.padlockId;
  const top = (snap.threats || []).find((t) => ids.has(t.id));
  if (top) return top.id;
  const me = snap.objects.find((o) => o.id === snap.focus);
  if (!me) return null;
  let best = null, bd = Infinity;
  for (const o of snap.objects) {
    if (!AIR.includes(o.category) || o.id === me.id || !isHostile(me, o)) continue;
    const d = distance(me.lon, me.lat, o.lon, o.lat);
    if (d < bd) { bd = d; best = o.id; }
  }
  return best;
}

function cyclePadlock() {
  const ids = (S.snap?.threats || []).map((t) => t.id);
  if (!ids.length) return;
  const cur = S.snap ? padlockTarget(S.snap) : null;
  S.padlockId = ids[(ids.indexOf(cur) + 1) % ids.length];
  redraw();
}

function pointerList(snap) {
  const out = [];
  const byId = new Map(snap.objects.map((o) => [o.id, o]));
  for (const t of snap.threats || []) {
    if (t.level < 1) continue;
    const o = byId.get(t.id);
    if (!o) continue;
    const missile = t.kind === "missile";
    const color = missile ? "#ff3b3b" : t.spike ? "#ff9f43" : "#ffd166";
    const text = missile ? `${t.ir ? `${t.seeker} IR` : wLabel(t.name)} ${fmtDist(t.range)}${isNum(t.tti) ? ` ${Math.round(t.tti)}s` : ""}`
      : t.spike ? `${t.pilot || t.name} SPIKE ${fmtDist(t.range)}`
      : `${t.name} ${t.inWez ? "WEZ" : "HOT"} ${fmtDist(t.range)}`;
    out.push({ id: t.id, lon: o.lon, lat: o.lat, color, text, range: t.range, level: missile ? 3 : t.level });
  }
  return out;
}

// -- fuel, trends, home ------------------------------------------------------------------

function fuelKg(own, v) {
  const e = own?.engine;
  if (isNum(e?.fuel_internal)) return e.fuel_internal + (isNum(e.fuel_external) ? e.fuel_external : 0);
  return isNum(v?.FuelWeight) ? v.FuelWeight : null;
}

function pushHist(me, own, snap) {
  if (me && snap.ownId && me.id !== snap.ownId) own = null; // the player's bridge data is not the focused jet's
  const key = `${snap.session}|${snap.focus}`;
  if (key !== S.histKey) { S.hist = []; S.histKey = key; S.home = null; S.homeTried = 0; }
  if (!me && !own) return;
  const s = own?.self || {}, v = me?.v || {}, d = me?.d || {};
  const t = snap.time;
  if (!isNum(t) || (S.hist.length && t <= S.hist[S.hist.length - 1].t)) return;
  const row = { t, ias: v.IAS ?? s.ias, tas: v.TAS ?? s.tas ?? d.gs, alt: me?.alt ?? s.alt, vs: s.vs ?? d.vs, fuel: fuelKg(own, v),
    agl: v.AGL ?? s.agl, lon: me?.lon ?? s.lon, lat: me?.lat ?? s.lat };
  const last = S.hist[S.hist.length - 1];
  if (last && isNum(row.fuel) && isNum(last.fuel) && row.fuel - last.fuel > 20) S.hist.forEach((h) => { h.fuel = null; });
  S.hist.push(row);
  while (S.hist.length && t - S.hist[0].t > 30) S.hist.shift();
}

/** Least-squares slope of hist[key] over the last `win` seconds. */
function slope(key, win) {
  const h = S.hist;
  if (!h.length) return null;
  const tEnd = h[h.length - 1].t;
  const pts = h.filter((r) => tEnd - r.t <= win && isNum(r[key]));
  if (pts.length < 3 || pts[pts.length - 1].t - pts[0].t < 1.5) return null;
  const n = pts.length;
  const mt = pts.reduce((a, r) => a + r.t, 0) / n, mv = pts.reduce((a, r) => a + r[key], 0) / n;
  let num = 0, den = 0;
  for (const r of pts) { num += (r.t - mt) * (r[key] - mv); den += (r.t - mt) ** 2; }
  return den > 0 ? num / den : null;
}

function updateHome(me, own) {
  const s = own?.self || {}, v = me?.v || {};
  const agl = v.AGL ?? s.agl, ias = v.IAS ?? s.ias;
  const lon = me?.lon ?? s.lon, lat = me?.lat ?? s.lat;
  if (!isNum(lon)) return;
  if (isNum(agl) && agl < 15 && isNum(ias) && ias < 30) { S.home = { lon, lat, name: "HOME" }; return; }
  // Ask for the nearest airfield; retry every 30 s until DCS has sent its airbases.
  if (!S.home && Date.now() - (S.homeTried || 0) > 30000) {
    S.homeTried = Date.now();
    api(`/api/dcsmap?lon=${lon}&lat=${lat}`).then(({ body }) => {
      if (S.home) return;
      let best = null, bd = Infinity;
      for (const a of body.airbaseList || []) {
        if (a.category !== 0 || !isNum(a.lon)) continue;
        const d = distance(lon, lat, a.lon, a.lat);
        if (d < bd) { bd = d; best = a; }
      }
      if (best) S.home = { lon: best.lon, lat: best.lat, name: best.name || "HOME" };
    }).catch(() => {});
  }
}

function bingoState(fuel) {
  const b = bingoKg();
  if (!b || !isNum(fuel)) return "ok";
  return fuel <= b ? "bingo" : fuel <= b * 1.2 ? "joker" : "ok";
}

function homeText(me) {
  if (!S.home || !me) return "";
  const brg = bearing(me.lon, me.lat, S.home.lon, S.home.lat);
  const d = distance(me.lon, me.lat, S.home.lon, S.home.lat);
  return `HOME ${fmtHdg(brg)} ${fmtDist(d)}`;
}

// -- ground attack: selected store, JSOW launch zone, my weapons ---------------------------------

/** The bridge's payload describes the player's own jet: only while that is the jet in view. */
function myOwn(snap, me) {
  const own = snap?.ownship;
  return own && (!me || !snap.ownId || me.id === snap.ownId) ? own : null;
}

/** "AGM-154A" from "AGM-154A", "{AGM-154A}", "{BRU57_2*AGM-154A}" or "AGM_154"; other stores tidied. */
function storeName(s) {
  const txt = `${s?.name || ""} ${s?.clsid || ""}`;
  const m = txt.match(/AGM[-_ ]?154([A-C])?/i);
  if (m) return `AGM-154${(m[1] || "").toUpperCase()}`;
  return String(s?.name || s?.clsid || "store").replace(/[{}]/g, "").replace(/_/g, "-");
}

/** The selected store: its name, how many are left of it, and whether it is a JSOW. */
function selectedStore(own) {
  const stations = own?.payload?.stations || [];
  const cur = stations.find((s) => s?.selected && s.count > 0);
  if (!cur) return null;
  const name = storeName(cur);
  const count = stations.filter((s) => s && s.count > 0 && storeName(s) === name).reduce((a, s) => a + s.count, 0);
  return { name, count, jsow: /^AGM-154/.test(name) };
}

// DCS's JSOW AI launch table, fetched once when a JSOW is first selected.
let larTable = null, larTried = false;
function jsowTable() {
  if (larTable || larTried) return larTable;
  larTried = true;
  fetch("/static/data/jsow_lar.json").then((r) => (r.ok ? r.json() : null)).then((t) => {
    if (!t?.rmax) return;
    // As analysis/lar.py: the raw rows are noisy (the 10 km row dips below
    // 9 km) and range cannot fall with height, so keep a running maximum up
    // the altitude axis.  Empty cells (0) stay empty.
    for (let c = 0; c < t.speeds.length; c++) {
      let best = 0;
      for (let r = 0; r < t.altitudes.length; r++) {
        best = Math.max(best, t.rmax[r][c]);
        t.rmax[r][c] = t.rmax[r][c] > 0 ? best : 0;
      }
    }
    larTable = t;
    redraw();
  }).catch(() => {});
  return null;
}

/** Bilinear interpolation over the cells with data, clamped to the table (lar.py _interp). */
function larInterp(t, key, alt, tas) {
  const alts = t.altitudes, spds = t.speeds;
  alt = Math.max(alts[0], Math.min(alts[alts.length - 1], alt));
  tas = Math.max(spds[0], Math.min(spds[spds.length - 1], tas));
  let r = alts.length - 2, c = spds.length - 2;
  for (let i = 0; i < alts.length - 1; i++) if (alts[i + 1] >= alt) { r = i; break; }
  for (let i = 0; i < spds.length - 1; i++) if (spds[i + 1] >= tas) { c = i; break; }
  r = Math.max(0, Math.min(alts.length - 2, r));
  c = Math.max(0, Math.min(spds.length - 2, c));
  const fr = (alt - alts[r]) / (alts[r + 1] - alts[r]);
  const fc = (tas - spds[c]) / (spds[c + 1] - spds[c]);
  const g = t[key];
  const cells = [[g[r][c], (1 - fr) * (1 - fc)], [g[r][c + 1], (1 - fr) * fc], [g[r + 1][c], fr * (1 - fc)], [g[r + 1][c + 1], fr * fc]];
  const good = cells.filter(([v]) => v > 0);
  const wsum = good.reduce((a, [, w]) => a + w, 0);
  if (!good.length || wsum <= 1e-9) return null;
  return good.reduce((a, [v, w]) => a + v * w, 0) / wsum;
}

/** Rmax / Rmin (m) and times of flight (s) for a release at this height above the target and TAS. */
function jsowEnvelope(t, hat, tas) {
  if (!t || !isNum(hat) || !isNum(tas)) return null;
  const out = {};
  for (const key of ["rmax", "rmin", "tofMax", "tofMid", "tofMin"]) {
    const v = larInterp(t, key, hat, tas);
    if (v !== null) out[key] = v;
  }
  return isNum(out.rmax) ? out : null;
}

/** The JSOW launch zone right now, and where the marked target sits in it. */
function larNow(me, own) {
  if (!me || !selectedStore(own)?.jsow) return null;
  const t = jsowTable();
  if (!t) return null;
  const s = own?.self || {}, v = me.v || {};
  const alt = me.alt ?? s.alt;
  const tas = v.TAS ?? s.tas ?? me.d?.gs;
  // Height above the target: the marked target's elevation, else the ground under me.
  const agl = s.agl ?? v.AGL;
  const ground = isNum(S.target?.alt) ? S.target.alt : isNum(agl) && isNum(alt) ? alt - agl : 0;
  const hat = isNum(alt) ? alt - ground : null;
  const env = jsowEnvelope(t, hat, tas);
  if (!env) return null;
  const out = { env, hat, tas };
  if (S.target) {
    const r = distance(me.lon, me.lat, S.target.lon, S.target.lat);
    const gs = me.d?.gs ?? tas;
    out.range = r;
    if (r > env.rmax) {
      const go = r - env.rmax;
      out.state = { cls: "out", text: `OUT ${fmtDist(go)}${isNum(gs) && gs > 20 ? ` · ${mmss(go / gs)}` : ""}`, short: `OUT ${fmtDist(go, { suffix: false })}` };
    } else if (isNum(env.rmin) && r < env.rmin) out.state = { cls: "bad", text: "INSIDE RMIN", short: "RMIN" };
    else out.state = { cls: "in", text: "IN RNG", short: "IN RNG" };
  }
  return out;
}

/** HIT / KILL for one of my weapons, from the events seen after it was released. */
function weaponResult(w) {
  const since = S.wpnSeen.get(w.id) ?? 0;
  const names = [w.targetName, w.targetId].filter(Boolean);
  let res = null;
  for (const e of S.events) {
    if (!(e.seq > since)) continue;
    if (/^destroyed$/i.test(e.kind || "") && w.targetId && (e.objectIds || []).includes(w.targetId)) return "KILL";
    const k = /^DCS (hit|kill|dead)$/.exec(e.kind || "");
    if (!k || !names.some((n) => (e.text || "").includes(n) || (e.names || []).includes(n))) continue;
    if (k[1] !== "hit") return "KILL";
    res = "HIT";
  }
  return res;
}

/** Everything the A-G strip line says: selected store, launch zone, target, time to impact. */
function agInfo(snap, me, own) {
  const parts = [];
  const st = selectedStore(own);
  const lar = st?.jsow ? larNow(me, own) : null;
  if (st) parts.push({ text: `SEL ${st.name} ×${st.count}` });
  if (lar?.state) parts.push(lar.state);
  else if (lar) parts.push({ text: `Rmax ${fmtDist(lar.env.rmax)}` });
  if (S.target && me) {
    const d = distance(me.lon, me.lat, S.target.lon, S.target.lat);
    parts.push({ text: `TGT ${fmtHdg(bearing(me.lon, me.lat, S.target.lon, S.target.lat))} ${fmtDist(d, { precise: d < 100 * NM })}`, cls: "tgt" });
  }
  const flying = myWeapons(snap).filter((w) => !w.impacted);
  const ttis = flying.map((w) => w.tti).filter(isNum);
  const next = ttis.length ? Math.min(...ttis) : null;
  if (flying.length) parts.push({ text: `TTI ${isNum(next) ? `~${mmss(next)}` : "—"}${flying.length > 1 ? ` (${flying.length} in flight)` : ""}`, cls: "tti" });
  return { parts, lar, flying, next };
}

// -- map ------------------------------------------------------------------------

/**
 * What the map (and the 3D view) shows: the snapshot's objects after the
 * mode's filters and the user's hidden list.  The view's own jet, the
 * selection, the target, pinned rings and every protected threat always stay.
 */
function sceneObjects(snap, { for3d = false } = {}) {
  const me = snap.objects.find((o) => o.id === snap.focus);
  const keepIds = protectedIds(snap);
  const selId = S.sel?.kind === "object" ? S.sel.id : null;
  const ground = cfg("ground"), wrecks = cfg("wrecks");
  const targets = !S.glance && cfg("labels") === "targets";
  const braaOn = cfg("braa") && me;
  const aimed = new Set(myWeapons(snap).map((w) => w.targetId).filter(Boolean));
  const out = [];
  for (const o of snap.objects) {
    const keep = o.id === snap.focus || o.id === selId || o.id === S.padlockId || o.id === S.target?.id || S.pinned.has(o.id) || keepIds.has(o.id);
    if (!keep && S.hidden.has(o.id)) continue;
    const deadAt = S.dead.get(o.id);
    const dead = S.dead.has(o.id);
    if (isSurface(o) && !keep) {
      if (ground === "hide") continue;
      if (ground === "threats" && (dead || !isThreatUnit(o))) continue;
      // A destroyed unit is a wreck marker on the map; in 3D a grey model while that lasts.
      if (dead && (!for3d || !wrecks || wreckAge(snap, deadAt) > WRECK_S)) continue;
    }
    const row = { ...o, ias: o.v?.IAS, tas: o.v?.TAS ?? o.d?.gs, trail: S.trails.get(o.id) };
    if (dead) {
      row.dead = true;
      row.v = { ...o.v };
      delete row.v.EngagementRange; // a destroyed SAM threatens nothing
    }
    if (isBomblet(o)) { row.dispenser = "sub"; row.trail = null; }
    if (o.category === "countermeasure") {
      // Ringed in the colour of the jet it came from (the server's guess: nearest jet when it appeared).
      const owner = o.cmOwner && snap.objects.find((x) => x.id === o.cmOwner);
      row.cmColor = flareColor(owner || o.cmOwnerSide || null); // the side stays after the jet is gone
    }
    if (targets && isSurface(o) && !dead && me && (aimed.has(o.id) || (isHostile(me, o) && distance(me.lon, me.lat, o.lon, o.lat) <= 10 * NM))) row.labelMe = true;
    if (o.id === S.target?.id) row.labelMe = true;
    if (braaOn && isAir(o) && o.id !== me.id && !dead && isHostile(me, o)) {
      const asp = isNum(o.hdg) ? aspectDeg(o.lon, o.lat, o.hdg, me.lon, me.lat) : null;
      row.tag = `BRAA ${braa(me.lon, me.lat, o.lon, o.lat, o.alt)} ${hotCold(asp)}`.trim();
    }
    out.push(row);
  }
  return out;
}

const wreckAge = (snap, t) => (isNum(snap?.time) && isNum(t) ? snap.time - t : 0);

/** Engagement ring filter for the "rings" setting; pinned and spiking emitters always draw. */
function ringFilter(o) {
  if (S.pinned.has(o.id) || protectedIds(S.snap).has(o.id)) return true;
  const mode = cfg("rings");
  if (mode === "off") return false;
  if (mode === "all") return true;
  const me = focusObj();
  if (me && !isHostile(me, o)) return false;
  if (mode === "hostile") return true;
  // "near": only while I am within 1.5x the ring.
  const r = o.v?.EngagementRange;
  return !me || !isNum(r) || distance(me.lon, me.lat, o.lon, o.lat) <= r * 1.5;
}

let hits = [];
let ptrHits = [];
let ptrFrom = [0, 0];
map.scene = (ctx, m) => {
  const snap = S.snap;
  if (!snap) return;
  const objs = sceneObjects(snap);
  const byId = new Map(objs.map((o) => [o.id, o]));
  const me = byId.get(snap.focus);
  if (cfg("myWeapons")) {
    // My weapons in flight are named once, at their impact tag.
    for (const w of myWeapons(snap)) {
      const o = byId.get(w.id);
      if (o && !w.impacted && isNum(w.impactLon) && o.id !== S.sel?.id) o.name = "";
    }
  }
  if (me) drawRangeRings(ctx, m, me);
  if (cfg("wrecks")) drawWrecks(ctx, m, snap);
  const own = $("own");
  const stripBox = own && !own.classList.contains("hidden") ? [own.offsetLeft + own.offsetWidth, own.offsetTop + own.offsetHeight] : [0, 0];
  const lar = me && cfg("lar") ? larNow(me, myOwn(snap, me)) : null;
  if (lar) drawLar(ctx, m, me, lar, stripBox);
  if (me && S.target) drawTargetLine(ctx, m, me, S.target);
  hits = drawScene(ctx, m, objs, { focusId: snap.focus, selectedId: S.sel?.kind === "object" ? S.sel.id : null,
    labels: S.glance ? "minimal" : cfg("labels"), showRadar: S.glance ? "focus" : cfg("radar"), rounds: liveRounds(snap),
    ringFilter, vectors: cfg("vectors"), byId });
  if (cfg("myWeapons")) drawMyWeapons(ctx, m, snap, byId);
  if (me && cfg("irHeat") && snap.heat && irInbound(snap).length) drawOwnHeat(ctx, m, me, snap);
  if (cfg("wrecks")) drawPips(ctx, m);
  if (S.target) drawTargetMark(ctx, m, S.target);
  if (S.sel?.kind === "point") drawPointMark(ctx, m, S.sel);
  // Threat lines from inbound missiles to me.
  if (me) {
    ctx.save();
    ctx.setLineDash([3, 4]);
    for (const t of snap.threats || []) {
      if (t.kind !== "missile") continue;
      const o = byId.get(t.id);
      if (!o) continue;
      ctx.strokeStyle = t.level >= 3 ? "rgba(255,59,59,0.9)" : "rgba(255,159,67,0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(...m.project(o.lon, o.lat)); ctx.lineTo(...m.project(me.lon, me.lat)); ctx.stroke();
    }
    ctx.restore();
  }
  const from = me ? m.project(me.lon, me.lat) : [m.w / 2, m.h / 2];
  const list = pointerList(snap);
  // HOME, once fuel is at joker or below.
  const fuel = fuelKg(snap.ownship, me?.v);
  if (me && S.home && bingoState(fuel) !== "ok") {
    const [hx, hy] = m.project(S.home.lon, S.home.lat);
    if (hx >= 22 && hy >= 22 && hx <= m.w - 22 && hy <= m.h - 22) drawHome(ctx, hx, hy);
    else list.push({ id: "home", home: true, lon: S.home.lon, lat: S.home.lat, color: "#5fd38d", dashed: true, text: homeText(me) });
  }
  // Keep the arrows below the ownship strip and missile warning, and above the selection card.
  const top = stripBox[1] ? stripBox[1] + 16 : 22;
  const col = $("selCol");
  const bottom = sel.card.classList.contains("hidden") ? 36 : Math.max(36, col.offsetHeight + 56);
  ptrHits = drawEdgePointers(ctx, m, from, list, { top, right: 22, bottom, left: 22 });
  ptrFrom = from;
};

function drawHome(ctx, x, y) {
  ctx.save();
  ctx.strokeStyle = "#5fd38d"; ctx.fillStyle = "rgba(95,211,141,0.25)"; ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(x - 7, y + 6); ctx.lineTo(x - 7, y - 1); ctx.lineTo(x, y - 8); ctx.lineTo(x + 7, y - 1); ctx.lineTo(x + 7, y + 6); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.font = "11px ui-monospace, monospace"; ctx.fillStyle = "#5fd38d"; ctx.textBaseline = "middle";
  ctx.fillText("HOME", x + 11, y);
  ctx.restore();
}

function drawRangeRings(ctx, m, me) {
  const [x, y] = m.project(me.lon, me.lat);
  const mpp = m.metersPerPixel();
  const range = rangeNm();
  const step = range / 4;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const r = (step * i * NM) / mpp;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(units.metric ? `${Math.round(step * i * 1.852)}` : `${step * i}`, x + 4, y - r - 3);
  }
  // Compass ticks on the outer ring.
  const R = (range * NM) / mpp;
  for (let b = 0; b < 360; b += 30) {
    const a = m.screenAngle(b);
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * (R - 6), y + Math.sin(a) * (R - 6));
    ctx.lineTo(x + Math.cos(a) * R, y + Math.sin(a) * R);
    ctx.stroke();
    if (b % 90 === 0) {
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(["N", "E", "S", "W"][b / 90], x + Math.cos(a) * (R + 12), y + Math.sin(a) * (R + 12));
    }
  }
  ctx.restore();
}

/** Text with a dark halo, readable on imagery. */
function halo(ctx, text, x, y, color) {
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(6,9,13,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

/** JSOW Rmax (dashed) and Rmin (dotted) around my jet, from DCS's AI launch table. */
function drawLar(ctx, m, me, lar, [stripR, stripB] = [0, 0]) {
  const [x, y] = m.project(me.lon, me.lat);
  const mpp = m.metersPerPixel();
  const R = lar.env.rmax / mpp;
  if (R > 20000) return;
  ctx.save();
  ctx.strokeStyle = "rgba(255,209,102,0.75)";
  ctx.lineWidth = 1.4;
  ctx.setLineDash([9, 6]);
  ctx.beginPath(); ctx.arc(x, y, R, 0, Math.PI * 2); ctx.stroke();
  if (isNum(lar.env.rmin)) {
    ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.arc(x, y, lar.env.rmin / mpp, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.setLineDash([]);
  // Label where the ring is on screen: ahead, behind, then the sides and diagonals.
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const text = `JSOW Rmax ${fmtDist(lar.env.rmax)} (DCS table)`;
  const w = ctx.measureText(text).width;
  for (const deg of [-90, 90, 0, 180, -45, -135, 45, 135]) {
    const a = (deg * Math.PI) / 180;
    const lx = x + Math.cos(a) * R, ly = y + Math.sin(a) * R + (deg === -90 ? -9 : deg === 90 ? 9 : 0);
    if (lx - w / 2 < 8 || lx + w / 2 > m.w - 8 || ly < 12 || ly > m.h - 24) continue;
    if (ly - 8 < stripB && lx - w / 2 < stripR) continue; // under the ownship strip
    halo(ctx, text, lx, ly, "rgba(255,209,102,0.95)");
    break;
  }
  ctx.restore();
}

/** A faint line from my jet to the marked target: the steering cue. */
function drawTargetLine(ctx, m, me, tg) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,209,102,0.45)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  ctx.beginPath(); ctx.moveTo(...m.project(me.lon, me.lat)); ctx.lineTo(...m.project(tg.lon, tg.lat)); ctx.stroke();
  ctx.restore();
}

/** The user's target point: a diamond with its name (as in the debrief). */
function drawTargetMark(ctx, m, tg) {
  const [x, y] = m.project(tg.lon, tg.lat);
  ctx.save();
  ctx.strokeStyle = "#ffd166";
  ctx.fillStyle = "rgba(255,209,102,0.18)";
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 9, y); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  halo(ctx, `TGT ${tg.name || ""}`, x + 12, y + (tg.id ? 12 : 0), "#ffd166");
  ctx.restore();
}

function drawPointMark(ctx, m, p) {
  const [x, y] = m.project(p.lon, p.lat);
  ctx.save();
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 1.4;
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.moveTo(x - 12, y); ctx.lineTo(x - 4, y); ctx.moveTo(x + 4, y); ctx.lineTo(x + 12, y);
  ctx.moveTo(x, y - 12); ctx.lineTo(x, y - 4); ctx.moveTo(x, y + 4); ctx.lineTo(x, y + 12);
  ctx.stroke();
  ctx.restore();
}

/** Destroyed units: a grey X where each died, fading out over five minutes. */
function drawWrecks(ctx, m, snap) {
  const byId = new Map(snap.objects.map((o) => [o.id, o]));
  ctx.save();
  const mark = (lon, lat, age) => {
    if (!isNum(lon) || !isNum(lat) || age > WRECK_S) return;
    const [x, y] = m.project(lon, lat);
    if (x < -10 || y < -10 || x > m.w + 10 || y > m.h + 10) return;
    ctx.globalAlpha = Math.max(0, 1 - age / WRECK_S);
    ctx.beginPath(); ctx.moveTo(x - 5, y - 5); ctx.lineTo(x + 5, y + 5); ctx.moveTo(x + 5, y - 5); ctx.lineTo(x - 5, y + 5);
    ctx.lineWidth = 4; ctx.strokeStyle = "rgba(6,9,13,0.7)"; ctx.stroke();
    ctx.lineWidth = 2; ctx.strokeStyle = "#a9b1bc"; ctx.stroke();
  };
  for (const [id, t] of S.dead) {
    const o = byId.get(id);
    if (o && isSurface(o)) mark(o.lon, o.lat, wreckAge(snap, t));
  }
  for (const w of S.wrecks.values()) if (!byId.has(w.id)) mark(w.lon, w.lat, wreckAge(snap, w.time));
  ctx.restore();
}

/** Where DCS says a hit landed: short orange pips. */
function drawPips(ctx, m) {
  const now = performance.now();
  S.pips = S.pips.filter((p) => now - p.at < PIP_MS);
  if (!S.pips.length) return;
  ctx.save();
  for (const p of S.pips) {
    const [x, y] = m.project(p.lon, p.lat);
    ctx.globalAlpha = 1 - (now - p.at) / PIP_MS;
    ctx.fillStyle = "#ff9f43";
    ctx.strokeStyle = "rgba(255,159,67,0.8)";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.restore();
}

/** My weapons in flight: a dashed line to the predicted impact, the impact circle, target and TTI. */
/** Heat-seekers coming at me (the server tags them from DCS's IR seeker table). */
const irInbound = (snap) => (snap?.threats || []).filter((t) => t.kind === "missile" && t.ir);

/** My heat lobe (DCS aspect model) with a tick towards each IR missile. */
function drawOwnHeat(ctx, m, me, snap) {
  const h = snap.heat;
  const state = h.ab === null ? "unknown" : "recorded";
  drawHeatLobes(ctx, m, [me], 0, { [me.id]: { ir: h.ir, irAB: h.irAB, state, spans: h.ab ? [[-Infinity, Infinity]] : [] } }, { scale: 1.6 });
  const [x, y] = m.project(me.lon, me.lat);
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2;
  for (const t of irInbound(snap)) {
    const a = m.screenAngle(t.bearing);
    ctx.beginPath(); ctx.moveTo(x + Math.cos(a) * 20, y + Math.sin(a) * 20); ctx.lineTo(x + Math.cos(a) * 34, y + Math.sin(a) * 34); ctx.stroke();
  }
  ctx.restore();
}

function drawMyWeapons(ctx, m, snap, byId) {
  const list = myWeapons(snap);
  if (!list.length) return;
  ctx.save();
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  // Tags go left of the impact point (unit labels sit right of their symbols,
  // and the target is usually right there); several weapons often share a
  // target area, so a tag that would overlap another stacks below it.
  const boxes = [];
  const tag = (text, ix, iy, color) => {
    const w = ctx.measureText(text).width;
    let x = ix - 11 - w, yy = iy;
    if (x < 4) { x = ix + 11; yy = iy + 11; }
    x = Math.min(x, m.w - w - 4);
    for (let k = 0; k < 6 && boxes.some((b) => x < b[2] && x + w > b[0] && yy - 7 < b[3] && yy + 7 > b[1]); k++) yy += 13;
    boxes.push([x - 2, yy - 7, x + w + 2, yy + 7]);
    halo(ctx, text, x, yy, color);
  };
  for (const w of list) {
    if (!isNum(w.impactLon) || !isNum(w.impactLat)) continue;
    const [ix, iy] = m.project(w.impactLon, w.impactLat);
    const label = wLabel(w.name);
    if (w.impacted) {
      const res = weaponResult(w);
      const col = res === "KILL" ? "#ff5c5c" : res === "HIT" ? "#ff9f43" : "#c8cdd6";
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(ix, iy, 6, 0, Math.PI * 2); ctx.stroke();
      // A JSOW-A / CBU that opened: the point is where it opened, not where anything hit.
      const over = w.dispensed && !res ? " over" : "";
      tag(`${label} · ${res || (w.dispensed ? "OPENED" : "IMPACT")}${w.targetName ? `${over} ${w.targetName}` : ""}`, ix, iy, col);
      continue;
    }
    const o = byId.get(w.id) || snap.objects.find((x) => x.id === w.id);
    ctx.strokeStyle = "rgba(77,216,230,0.85)";
    ctx.lineWidth = 1.3;
    if (o) {
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(...m.project(o.lon, o.lat)); ctx.lineTo(ix, iy); ctx.stroke();
    }
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.arc(ix, iy, 7, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
    // "~": the time and point are the server's estimate.
    tag(`${label}${w.targetName ? ` → ${w.targetName}` : ""}${isNum(w.tti) ? ` · ~${mmss(w.tti)}` : ""}`, ix, iy, "#4dd8e6");
  }
  ctx.restore();
}

// -- panels -----------------------------------------------------------------------

function trend(rate, { dead, fast, levels, fmt }) {
  if (!isNum(rate) || Math.abs(rate) < dead) return "";
  const n = levels ? 1 + levels.filter((l) => Math.abs(rate) > l).length : 1;
  const arrow = (rate > 0 ? "▲" : "▼").repeat(n);
  const cls = `trend ${rate > 0 ? "up" : "down"}${isNum(fast) && rate < fast ? " fast" : ""}`;
  return el("span", { class: cls }, `${arrow}${fmt ? fmt(Math.abs(rate)) : ""}`);
}

/** Nearest hostile aircraft as a BRAA with HOT / COLD, from the server's threat list. */
function banditText(snap) {
  const t = (snap?.threats || []).filter((x) => x.kind === "aircraft").sort((a, b) => a.range - b.range)[0];
  if (!t) return null;
  const o = snap.objects.find((x) => x.id === t.id);
  const alt = isNum(o?.alt) ? (units.metric ? `${(o.alt / 1000).toFixed(1)}km` : `${Math.round((o.alt * M_TO_FT) / 1000)}k`) : "";
  const hc = hotCold(t.aspect);
  return { text: [fmtHdg(t.bearing), fmtDist(t.range, { suffix: false }), alt, hc].filter(Boolean).join(" "), cls: hc === "HOT" ? "warn" : "" };
}

function renderOwn(me, own) {
  const box = $("own");
  box.innerHTML = "";
  if (!me && !own) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  // Bridge values describe the player's own jet: use them only when that is
  // the aircraft in focus, never mixed with a wingman's numbers.
  own = myOwn(S.snap, me);
  const s = own?.self || {};
  const v = me?.v || {};
  const d = me?.d || {};
  const ias = v.IAS ?? s.ias, alt = me?.alt ?? s.alt, hdg = me?.hdg ?? s.hdg;
  const aoa = v.AOA ?? s.aoa, g = v.VerticalGForce ?? s.g?.y ?? d.g, mach = v.Mach ?? s.mach;
  const vs = s.vs ?? d.vs;
  const tas = v.TAS ?? s.tas ?? d.gs;
  const agl = v.AGL ?? s.agl;
  const cell = (k, val, cls = "", extra = "") => [el("div", {}, el("div", { class: "k" }, k), el("div", { class: `v ${cls}` }, val, extra))];
  const mode = SET.mode;

  // Trends: IAS rate (kt/s or km/h per s), climb arrows, specific excess power.
  const dIas = slope("ias", 3), dTas = slope("tas", 3);
  // Thresholds in m/s (1 kt/s shown, red below -5 kt/s); only the number is converted.
  const iasTrend = trend(dIas, { dead: 0.514, fast: -2.57, fmt: (x) => Math.round(x * (units.metric ? 3.6 : 1.943844)) });
  const altTrend = trend(isNum(vs) ? vs * 196.85 : null, { dead: 300, levels: [3000, 10000] });
  const ps = isNum(vs) && isNum(tas) && isNum(dTas) ? vs + (tas / 9.80665) * dTas : null;
  const psTxt = isNum(ps) ? `${ps >= 0 ? "+" : ""}${Math.round(units.metric ? ps : ps * M_TO_FT)}` : "—";
  const psCls = isNum(ps) ? (ps * M_TO_FT > 10 ? "good" : ps * M_TO_FT < -10 ? "bad" : "") : "";
  // Dive angle from the flight path: positive going down.
  const dive = isNum(vs) && isNum(tas) && tas > 30 ? (-Math.asin(Math.max(-1, Math.min(1, vs / tas))) * 180) / Math.PI : null;

  const fuel = fuelKg(own, v);
  const burn = slope("fuel", 30);
  const endurance = isNum(fuel) && isNum(burn) && burn < -0.01 ? Math.round(fuel / -burn / 60) : null;
  const fuelTxt = isNum(fuel) ? `${Math.round(units.metric ? fuel : fuel * LB).toLocaleString()}${endurance !== null ? ` · ${endurance} min` : ""}` : "—";
  const bs = bingoState(fuel);
  const fuelCls = bs === "bingo" ? "danger flash" : bs === "joker" ? "warn" : "";
  const warn = $("bingo");
  if (bs === "bingo" && !S.bingoShown) {
    S.bingoShown = true;
    warn.textContent = `BINGO${S.home && me ? ` · ${homeText(me)}` : ""}`;
    warn.classList.remove("hidden");
    clearTimeout(S.bingoTimer);
    S.bingoTimer = setTimeout(() => warn.classList.add("hidden"), 12000);
    if (S.sound) beep(700, 0.3);
  } else if (bs === "ok") S.bingoShown = false;

  const altKey = units.metric ? "ALT m" : "ALT ft";
  const fuelKey = units.metric ? "FUEL kg" : "FUEL lb";
  const iasCell = () => cell("IAS", fmtSpeed(ias, { suffix: false }), "", iasTrend);
  const altCell = () => cell(altKey, fmtAlt(alt, { suffix: false }), "", altTrend);
  const gCell = () => cell("G", fmtNum(g, 1), g > 7.5 ? "danger" : g > 6 ? "warn" : "");
  const fuelCell = () => cell(fuelKey, fuelTxt, fuelCls);
  // Heat: DCS's coefficient for my type, and afterburner when the data shows it.
  const irIn = irInbound(S.snap).length > 0;
  const heat = S.snap?.heat;
  const heatCell = () => cell("HEAT", heat.ab ? `AB ${heat.irAB.toFixed(1)}` : `DRY ${heat.ir}`, `sm ${heat.ab ? (irIn ? "danger flash" : "warn") : ""}`);
  const flrCell = () => cell("FLR", own?.cm?.flare ?? "—", isNum(own?.cm?.flare) && own.cm.flare <= 10 ? "warn" : "");
  const aoaCell = () => cell("AOA", isNum(aoa) ? aoa.toFixed(1) : "—", aoa > 20 ? "warn" : "");
  const vsCell = () => cell("V/S", fmtVs(vs).replace(" fpm", "").replace(" m/s", ""));
  const ag = mode !== "a2a" ? agInfo(S.snap, me, own) : null;
  const agLine = (hint) => {
    const line = el("div", { class: "agline" });
    for (const p of ag.parts) line.append(el("span", { class: p.cls || "" }, p.text));
    if (!ag.parts.length && hint) line.append(el("span", { class: "hint" }, hint));
    return line;
  };

  if (S.glance) {
    if (mode === "a2g") {
      // Height over the ground is what matters low; TTI while weapons fly, else the launch zone.
      const hasAgl = isNum(agl);
      box.append(
        ...cell(hasAgl ? (units.metric ? "AGL m" : "AGL ft") : altKey, fmtAlt(hasAgl ? agl : alt, { suffix: false }), "", altTrend),
        ...iasCell(),
        ...(ag.flying.length ? cell("TTI", isNum(ag.next) ? `~${mmss(ag.next)}` : "—") : cell("LAR", ag.lar?.state?.short || "—", ag.lar?.state?.cls || "")),
        ...fuelCell(),
      );
      return;
    }
    // An IR missile inbound: flares matter more than fuel.
    // An IR missile inbound: flares matter more than fuel (when the bridge gives the count).
    box.append(...iasCell(), ...altCell(), ...gCell(), ...(irIn && isNum(own?.cm?.flare) ? flrCell() : fuelCell()));
    return;
  }
  if (mode === "a2g") {
    box.append(
      ...iasCell(), ...altCell(), ...cell(units.metric ? "AGL m" : "AGL ft", fmtAlt(agl, { suffix: false })),
      ...cell("HDG", fmtHdg(hdg)), ...cell("DIVE", isNum(dive) ? `${Math.round(dive)}°` : "—", isNum(dive) && dive > 45 ? "warn" : ""),
      ...gCell(), ...vsCell(), ...cell("MACH", fmtNum(mach, 2)), ...aoaCell(), ...fuelCell(),
    );
    box.append(agLine("Right-click a ground unit or the map to mark a target"));
  } else if (mode === "a2a") {
    const b = banditText(S.snap);
    box.append(
      ...iasCell(), ...altCell(), ...cell("HDG", fmtHdg(hdg)), ...cell("MACH", fmtNum(mach, 2)),
      ...cell("BANDIT", b ? b.text : "—", `sm ${b?.cls || ""}`),
      ...aoaCell(), ...gCell(), ...vsCell(), ...cell(units.metric ? "Ps m/s" : "Ps ft/s", psTxt, psCls), ...fuelCell(),
      // Only when the data says (engine data for my jet); never a guess.
      ...(heat && heat.ab !== null && heat.ab !== undefined ? heatCell() : []),
    );
  } else {
    box.append(
      ...iasCell(), ...altCell(), ...cell("HDG", fmtHdg(hdg)), ...cell("MACH", fmtNum(mach, 2)),
      ...aoaCell(), ...gCell(), ...vsCell(), ...cell(units.metric ? "Ps m/s" : "Ps ft/s", psTxt, psCls), ...fuelCell(),
    );
    // ALL: the ground-attack line only when it has news (launch zone, target, weapons in flight).
    if (ag.lar?.state || S.target || ag.flying.length) box.append(agLine());
  }
  const cfgLine = el("div", { class: "cfg" });
  const gear = own?.mech?.gear ?? v.LandingGear, flaps = own?.mech?.flaps ?? v.Flaps, brk = own?.mech?.speedbrakes ?? v.AirBrakes;
  if (isNum(gear)) cfgLine.append(el("span", {}, "Gear ", el("b", {}, gear > 0.95 ? "DOWN" : gear < 0.05 ? "UP" : "TRANSIT")));
  if (isNum(flaps)) cfgLine.append(el("span", {}, "Flaps ", el("b", {}, `${Math.round(flaps * 100)}%`)));
  if (isNum(brk) && brk > 0.05) cfgLine.append(el("span", {}, "Brake ", el("b", {}, "OUT")));
  if (own?.cm) cfgLine.append(el("span", {}, "CHF ", el("b", {}, own.cm.chaff ?? "—"), " FLR ", el("b", {}, own.cm.flare ?? "—")));
  const c = own?.controls;
  if (c && isNum(c.pitch)) cfgLine.append(el("span", {}, "Stick ", el("b", {}, `${c.pitch >= 0 ? "+" : ""}${c.pitch.toFixed(2)} / ${c.roll >= 0 ? "+" : ""}${(c.roll ?? 0).toFixed(2)}`)));
  if (me?.pilot || s.pilot) cfgLine.append(el("span", {}, el("b", {}, me?.pilot || s.pilot), ` · ${me?.name || s.name || ""}`));
  box.append(cfgLine);
}

/** Clock position (12 = nose) from a relative bearing, as the server does. */
function clockOf(rel) {
  const c = Math.round((((rel % 360) + 360) % 360) / 30) % 12;
  return c === 0 ? 12 : c;
}

/**
 * The threat list for the mode.  ALL: the server's list.  A-A: SAMs only
 * while they spike me or I am in their WEZ.  A-G: hostile SAM / AAA sorted by
 * distance to their WEZ edge (within 10 nm of it) after the missiles.
 * Missiles at me always come first.
 */
function threatRows(snap, threats) {
  const mode = SET.mode;
  const surface = (t) => t.kind === "sam" || t.kind === "surface";
  if (mode === "all") return threats;
  // The server does not follow Tacview's "Destroyed" events: a dead SAM threatens nothing.
  threats = threats.filter((t) => !surface(t) || t.spike || !S.dead.has(t.id));
  if (mode === "a2a") return threats.filter((t) => !surface(t) || t.spike || t.inWez);
  const me = focusObj(snap);
  const missiles = threats.filter((t) => t.kind === "missile");
  const server = new Map(threats.map((t) => [t.id, t]));
  const sams = [];
  if (me) {
    for (const o of snap.objects) {
      if (!isSurface(o) || !isThreatUnit(o) || S.dead.has(o.id) || !isHostile(me, o)) continue;
      const g = distance(me.lon, me.lat, o.lon, o.lat);
      const edge = g - o.v.EngagementRange;
      const srv = server.get(o.id);
      if (edge > 10 * NM && !srv?.spike) continue;
      const brg = bearing(me.lon, me.lat, o.lon, o.lat);
      sams.push({
        ...srv, id: o.id, name: o.name, kind: srv?.kind || "sam", edge, bearing: brg, range: srv?.range ?? g,
        clock: srv?.clock ?? clockOf(wrap180(brg - (me.hdg ?? 0))), altDelta: srv?.altDelta ?? (isNum(o.alt) && isNum(me.alt) ? o.alt - me.alt : null),
        level: srv?.spike ? 2 : edge <= 0 ? 1 : 0, spike: !!srv?.spike,
        text: srv?.spike ? "SPIKE" : edge <= 0 ? "IN WEZ" : "WEZ",
      });
    }
  }
  sams.sort((a, b) => a.edge - b.edge);
  const ids = new Set(sams.map((t) => t.id));
  // The server's own rows stay (a spiking emitter with no known ring among them).
  return [...missiles, ...sams, ...threats.filter((t) => t.kind !== "missile" && !ids.has(t.id))];
}

function renderThreats(threats) {
  const box = $("threats");
  box.innerHTML = "";
  // Warnings and sound come from the server's full list, whatever the mode shows.
  const missiles = threats.filter((t) => t.kind === "missile" && t.level >= 3);
  const ids = new Set(missiles.map((m) => m.id));
  const fresh = [...ids].some((id) => !S.lastMissiles.has(id));
  S.lastMissiles = ids;
  if (missiles.length) S.lastMissileAt = Date.now();
  if (fresh && S.sound) {
    // A heat-seeker gives no RWR warning: its own sound, three lower beeps.
    if (missiles.some((m) => m.ir && !S.lastIr?.has(m.id))) [0, 180, 360].forEach((d) => setTimeout(() => beep(900, 0.1), d));
    else { beep(1200, 0.15); setTimeout(() => beep(1200, 0.15), 220); }
  }
  S.lastIr = new Set(missiles.filter((m) => m.ir).map((m) => m.id));
  // Deferred: setGlance re-renders this list.
  if (fresh && !S.glance && pref("autoGlance", "0") === "1") queueMicrotask(() => setGlance(true, { auto: true }));
  const warn = $("warn");
  if (missiles.length) {
    const m = missiles[0];
    const hot = m.ir && S.snap?.heat?.ab === true ? " · AB!" : "";
    warn.textContent = `${m.ir ? "IR MISSILE" : "MISSILE"} ${m.clock} O'CLOCK${isNum(m.tti) ? ` · ${Math.round(m.tti)}s` : ""}${m.ir ? ` · NO RWR${hot}` : ""}`;
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");

  const rows = threatRows(S.snap, threats);
  if (!rows.length) { box.append(el("div", { class: "empty" }, "No threats")); return; }
  const pad = S.cam === "padlock" && S.snap ? padlockTarget(S.snap) : S.padlockId;
  const selId = S.sel?.kind === "object" ? S.sel.id : null;
  for (const t of rows.slice(0, S.glance ? 3 : 12)) {
    const tag = t.kind === "missile" ? `${t.ir ? "IR " : ""}${isNum(t.tti) ? `${Math.round(t.tti)}s` : t.ir ? "" : "MSL"}`.trim()
      : t.ir && t.kind === "sam" ? `IR ${t.text || "SAM"}` : t.text || (t.kind === "aircraft" ? "A/C" : t.kind.toUpperCase());
    const alt = isNum(t.altDelta) ? (units.metric ? `${t.altDelta >= 0 ? "+" : ""}${Math.round(t.altDelta)}m` : `${t.altDelta >= 0 ? "+" : ""}${Math.round((t.altDelta * M_TO_FT) / 1000)}k`) : "";
    const who = t.kind === "missile" ? `${t.ir ? `${t.seeker || wLabel(t.name)} · IR` : wLabel(t.name)}${t.shooterPilot || t.shooter ? ` ← ${t.shooterPilot || t.shooter}` : ""}` : `${t.pilot || t.name}${t.pilot ? ` · ${t.name}` : ""}`;
    let bits;
    if (isNum(t.edge)) bits = [fmtHdg(t.bearing), t.edge <= 0 ? "IN WEZ" : `WEZ in ${fmtDist(t.edge)}`, fmtDist(t.range)];
    else {
      bits = [fmtHdg(t.bearing), fmtDist(t.range), alt];
      if (isNum(t.aspect)) bits.push(`asp ${Math.round(t.aspect)}°`);
      if (isNum(t.closure)) bits.push(`${t.closure >= 0 ? "+" : ""}${fmtSpeed(t.closure, { suffix: false })}`);
    }
    // Heat-seekers: no RWR, and which part of me it sees (DCS: tail x1.5, beam x1, nose x0.5).
    if (t.ir) bits.push(t.sees ? `sees your ${t.sees.toUpperCase()} ×${t.heatFactor}` : "no RWR");
    box.append(el("div", { class: `threat l${t.level}${t.id === pad ? " pad" : ""}${t.id === selId ? " sel" : ""}`, title: "Click to select (and padlock in 3D)", "data-id": t.id },
      el("div", { class: "clock" }, `${t.clock}`, el("small", {}, "o'clock")),
      el("div", { class: "what" }, el("b", {}, who), el("span", {}, bits.filter(Boolean).join(" · "))),
      el("span", { class: `tag${t.ir ? " ir" : ""}`, title: t.ir ? "Heat-seeker (DCS data): passive, the RWR does not show it; flares can decoy it" : null }, tag)));
  }
}

/** Side panel: my weapons in flight, time to impact and how far along they are. */
function renderWeapons(snap) {
  const sec = $("wpnSec");
  const list = cfg("myWeapons") ? myWeapons(snap) : [];
  if (!list.length) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const box = $("wpns");
  box.innerHTML = "";
  const flying = list.filter((w) => !w.impacted).length;
  $("wpnCount").textContent = flying ? `${flying} in flight` : "";
  const order = [...list].sort((a, b) => (!!a.impacted - !!b.impacted) || ((a.tti ?? 1e9) - (b.tti ?? 1e9)));
  const selId = S.sel?.kind === "object" ? S.sel.id : null;
  for (const w of order) {
    const res = w.impacted ? weaponResult(w) || (w.dispensed ? "OPENED" : "IMPACT") : null;
    const elapsed = isNum(snap.time) && isNum(w.releasedAt) ? snap.time - w.releasedAt : null;
    const frac = w.impacted ? 1 : isNum(elapsed) && isNum(w.tti) && elapsed + w.tti > 0 ? elapsed / (elapsed + w.tti) : null;
    box.append(el("div", { class: `wif-row${w.impacted ? " done" : ""}${w.id === selId ? " sel" : ""}`, "data-id": w.id, title: w.estimated ? "Impact point and time are estimates" : "" },
      el("span", { class: "nm" }, `${wLabel(w.name)}${w.targetName ? ` → ${w.targetName}` : ""}`),
      el("span", { class: `tti${res ? ` r-${res.toLowerCase()}` : ""}` }, res || (isNum(w.tti) ? `~${mmss(w.tti)}` : "—")),
      el("span", { class: "prog" }, el("i", { style: { width: `${Math.round(Math.max(0, Math.min(1, frac ?? 0)) * 100)}%` } }))));
  }
}

function renderEvents() {
  const box = $("events");
  box.innerHTML = "";
  if (!S.events.length) { box.append(el("div", {}, "—")); return; }
  for (const e of S.events.slice(0, 15)) {
    const mm = Math.floor(e.time / 60), ss = Math.floor(e.time % 60);
    box.append(el("div", { class: e.againstMe ? "me" : "" }, `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} `,
      el("b", {}, e.kind), " ", [e.names?.join(", "), e.text].filter(Boolean).join(": ")));
  }
}

function renderStores(own) {
  const sec = $("storesSec");
  const p = own?.payload;
  if (!p?.stations?.length && !isNum(p?.gun)) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const box = $("stores");
  box.innerHTML = "";
  const agg = new Map();
  for (const s of p.stations || []) {
    if (!s || !s.count) continue;
    const name = s.name || s.clsid || "store";
    const a = agg.get(name) || { count: 0, sel: false };
    a.count += s.count; a.sel ||= s.selected;
    agg.set(name, a);
  }
  if (isNum(p.gun)) box.append(el("div", { class: "st" }, "Gun ", el("b", {}, p.gun)));
  for (const [name, a] of agg) box.append(el("div", { class: `st${a.sel ? " sel" : ""}`, title: name }, name.slice(0, 14), " ", el("b", {}, a.count)));
}

function renderRWR(own, me) {
  const sec = $("rwrSec");
  const emitters = own?.rwr?.emitters;
  if (!Array.isArray(emitters)) { sec.classList.add("hidden"); return; }
  sec.classList.remove("hidden");
  const c = $("rwr");
  const r = c.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  c.width = r.width * dpr; c.height = r.height * dpr;
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cx = r.width / 2, cy = r.height / 2, R = Math.min(cx, cy) - 4;
  ctx.fillStyle = "#07120a"; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(95,211,141,0.35)";
  for (const f of [0.33, 0.66, 1]) { ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke(); }
  ctx.font = "bold 12px ui-monospace, monospace"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (const e of emitters) {
    // DCS reports azimuth relative to the nose in radians; stronger signal plots closer.
    const az = isNum(e.azimuth) ? e.azimuth : 0;
    const pw = isNum(e.power) ? Math.max(0, Math.min(1, e.power)) : 0.5;
    const rr = R * (0.92 - pw * 0.7);
    const x = cx + Math.sin(az) * rr, y = cy - Math.cos(az) * rr;
    const lock = /lock|missile/i.test(e.signal || "");
    ctx.fillStyle = lock ? "#ff5c5c" : "#5fd38d";
    ctx.fillText(e.label || "U", x, y);
    if (lock) { ctx.strokeStyle = "#ff5c5c"; ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.fillStyle = "#5fd38d"; ctx.beginPath(); ctx.moveTo(cx, cy - 6); ctx.lineTo(cx - 4, cy + 4); ctx.lineTo(cx + 4, cy + 4); ctx.fill();
  void me;
}

renderMapChips(true);
connect();
if (pref("view", "2d") === "3d") setView("3d");
