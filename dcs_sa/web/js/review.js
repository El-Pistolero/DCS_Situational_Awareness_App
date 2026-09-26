// Debrief / review controller.

import {
  api, aspectDeg, bearing, bisectRight, braa, el, fmtAlt, fmtClock, fmtDeg, fmtDist, fmtHdg, fmtMass, fmtNum, fmtShort,
  fmtPct, fmtRel, fmtSpeed, fmtVs, fmtZulu, isHostile, isNum, radarAt, rampColor, rampCss, roundsAt, sampleTrack,
  sideColor, slantRange, units, distance, M_TO_FT, MPS_TO_KT, MPS_TO_FPM,
} from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawEdgePointers, drawRadar, drawScene, radarVolume } from "./symbols.js";
import { LineChart } from "./charts.js";
import { bar, drawADI, drawStick } from "./instruments.js";
import { Scene3D } from "./scene3d.js";
import { bindShortcuts } from "./keys.js";
import { buildShotCard } from "./shotcard.js";
import { watchRecordings } from "./watch.js";
import { MODES, createSettings, modeSwitch, reflectMode } from "./modes.js";
import { createDisplayPanel } from "./layers.js";
import { wireSettingsButton } from "./settings.js";
import { openConsole, reportPageErrors } from "./console.js";
import { createSelectionUI } from "./selmenu.js";
import { RESULT_COLOR, drawStrikes, kAlt, missText, prepareStrikes, weaponsInFlight } from "./strikeviz.js";
import { FAMILY_LABEL, groupPasses, posAt, strikeGeometry, weaponLabel } from "./strikegeom.js";
import { buildStrikeCard, buildStrikeThumb } from "./strikecard.js";
import { COORD_FORMATS, copyText, fmtCoord } from "./coords.js";
import {
  HEAT_CSS, HEAT_NOTE, abAt, aspectFactor, drawHeatLobes, drawReach, drawSeekers, flareColor, heatNow, heatText, irInFlight, prepareIR,
} from "./irviz.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.${k}`, v); } catch { /* ignore */ } };

// Display settings.  The manual A-A / A-G modes overlay their own values on
// the keys they manage; ALL is always exactly the user's own settings.
const SET = createSettings({
  prefix: "dcs-sa.",
  base: {
    labels: "aircraft", trailSec: 90, trailColor: "side", radar: "all", bullets: "paths",
    rings: "all", lockLines: true, pointers: "follow", vectors: 0, bullseye: "rings", braa: false,
    air: "show", ground: "show", cm: "show", weapons: "all", bomblets: "dots", dead: "show",
    blue: true, red: true, neutral: true,
    strikeRelease: true, strikePaths: true, strikeFuture: false, strikeImpacts: true, strikeFootprints: true,
    strikeTti: true, strikeBda: true, strikeLar: false,
    stalks: "off", lighting: "day", grid: false, coords: "dd", strikeLabels: "auto", exposure: false, labelSize: "m",
    charts: "Altitude,Speed,AOA,G,Throttle,Energy", evHide: "", wtab: "all", objChip: "all",
    irHeat: "sel", irSeeker: "sel", irReach: false,
  },
  modeDefaults: {
    a2a: {
      labels: "aircraft", trailSec: 60, trailColor: "ps", radar: "all", rings: "near", pointers: "always", vectors: 10,
      bullseye: "calls", braa: true, ground: "threats", weapons: "a2a", bomblets: "hide",
      strikeRelease: false, strikePaths: false, strikeFuture: false, strikeImpacts: false, strikeFootprints: false,
      strikeTti: false, strikeBda: false, strikeLar: false, stalks: "off",
      charts: "Altitude,Speed,G,AOA,Energy,Turn rate", evHide: "release,impact,landing,takeoff,message,bookmark", wtab: "a2a",
      irHeat: "focus", irSeeker: "sel", cm: "show",
    },
    a2g: {
      labels: "targets", trailSec: 300, trailColor: "alt", radar: "known", rings: "hostile", pointers: "always", vectors: 0,
      bullseye: "off", braa: false, ground: "show", weapons: "all", bomblets: "dots",
      strikeRelease: true, strikePaths: true, strikeFuture: true, strikeImpacts: true, strikeFootprints: true,
      strikeTti: true, strikeBda: true, strikeLar: true, strikeLabels: "full", stalks: "all", exposure: true,
      charts: "Altitude,Speed,Vert speed,G,Mach", evHide: "lock,landing,takeoff,message,bookmark,radar,flares", wtab: "a2g",
      irHeat: "off", irSeeker: "sel",
    },
  },
});
// Two layers over the saved settings, neither ever written to storage:
// TEMP holds what a replay button needs (longer trails, gun rounds on) until
// the user picks that setting or switches mode; Z declutter can only make
// the display sparser, and Z again restores it exactly.
const TEMP = {};
const DECLUTTER = {
  labels: (v) => (v === "none" ? "none" : "minimal"), cm: () => "hide", bomblets: () => "hide",
  trailSec: (v) => (v === 0 ? 0 : Math.min(v, 30)), vectors: () => 0, bullseye: () => "off", braa: () => false, strikeLabels: () => "auto",
  irHeat: () => "off", irSeeker: (v) => (v === "all" ? "sel" : v), irReach: () => false,
};
const cfg = (k) => {
  const v = k in TEMP ? TEMP[k] : SET.get(k);
  return S?.declutter && DECLUTTER[k] ? DECLUTTER[k](v) : v;
};

const S = {
  key: null, analysis: null, playback: null, objects: new Map(), deaths: new Map(),
  t: 0, start: 0, end: 0, playing: false, speed: 4,
  selected: null, me: null, follow: false,
  series: new Map(),
  rounds: [], roundLife: 8,
  tab: "flight", status: null, lastPanel: 0, filter: "",
  loop: { a: null, b: null, on: false }, padlockId: null, cam: pref("cam", "orbit"),
  tapes: [], tapeDraft: null, trailSeries: new Map(),
  openShots: new Set(), openStrikes: new Set(), keys: null,
  strikes: [], strikeIds: new Set(), hidden: new Set(), pinned: new Set(), isolate: null, target: null,
  collapsed: new Map(), shooterFilter: null, compare: null, weaponCam: null, measureFrom: null,
};
// Settings the rest of the code reads as plain fields.
for (const k of ["labels", "trailSec", "trailColor", "radar", "bullets"]) {
  Object.defineProperty(S, k, { get: () => cfg(k), set: (v) => SET.set(k, v) });
}
// A setting the user picks replaces any temporary value; a mode switch drops them all.
SET.on((ev) => {
  if (ev.type === "set") delete TEMP[ev.key];
  else for (const k of Object.keys(TEMP)) delete TEMP[k];
});
let evHideCache = { raw: null, set: new Set() };
Object.defineProperty(S, "eventFilter", {
  get: () => {
    const raw = SET.get("evHide") || "";
    if (raw !== evHideCache.raw) evHideCache = { raw, set: new Set(raw.split(",").filter(Boolean)) };
    return evHideCache.set;
  },
});
function toggleEventKind(k) {
  const hide = new Set(S.eventFilter);
  hide.has(k) ? hide.delete(k) : hide.add(k);
  SET.set("evHide", [...hide].join(","));
  stopsCache = null;
}
const AIR = ["fixedwing", "rotorcraft", "air"];
const TAPE_COLORS = ["#ffd166", "#4dd8e6", "#b48cff"];

const map = new TacticalMap($("map"), { layer: pref("layer", "satellite") });
let scene3d = null;
S.view = "2d";

function setView(view) {
  S.view = view;
  if (view === "3d" && !scene3d) {
    try {
      scene3d = new Scene3D(document.querySelector(".mapwrap"));
      scene3d.onPick = (id, { shift } = {}) => (shift ? setPadlock(id) : select(id));
      scene3d.onContext = (id, { clientX, clientY, lon, lat } = {}) => {
        const r = document.querySelector(".mapwrap").getBoundingClientRect();
        const target = id ? objectTarget(id) : isNum(lon) ? { kind: "point", lon, lat } : null;
        if (!target) return;
        if (id && id !== S.selected) select(id);
        sel.openMenu(target, clientX - r.left, clientY - r.top);
      };
      scene3d.setMode(S.cam);
      scene3d.setLighting?.(cfg("lighting"));
      if (S.analysis) scene3d.setStrikes?.(strikes3d());
    } catch (err) { toast(`3D view unavailable: ${err.message}`); S.view = "2d"; return; }
  }
  const is3d = S.view === "3d";
  document.body.classList.toggle("is3d", is3d);
  $("map").style.display = is3d ? "none" : "block";
  scene3d?.setVisible(is3d);
  $("btn2d").classList.toggle("active", !is3d);
  $("btn3d").classList.toggle("active", is3d);
  setPref("view", S.view);
  onTimeChange(true);
}

function setCam(mode) {
  S.cam = mode;
  scene3d?.setMode(mode);
  setTimeout(() => onTimeChange(true), 0);
  $("btnOrbit").classList.toggle("active", mode === "orbit");
  $("btnChase").classList.toggle("active", mode === "chase");
  $("btnPadlock").classList.toggle("active", mode === "padlock");
  setPref("cam", mode);
}

function cycleCam() {
  const order = ["orbit", "chase", "padlock"];
  setCam(order[(order.indexOf(S.cam) + 1) % order.length]);
}

// ---------------------------------------------------------------------------
// Modes, display options, selection actions
// ---------------------------------------------------------------------------

let display = null, sel = null, modeSw = null;

const MODE_BLURB = {
  a2a: "aircraft, missiles and guns; ground units only where they can shoot",
  a2g: "strike marks, SAM rings, ground units and the Strike tab",
};

function setupModes() {
  const counts = () => {
    if (!S.analysis) return null;
    const ag = S.strikes.length;
    return { a2a: S.analysis.weapons.shots.length - ag + S.analysis.weapons.bursts.length, a2g: ag };
  };
  modeSw = modeSwitch(SET, { counts });
  $("modeSw").append(modeSw);
  reflectMode(SET, { chip: $("modeChip"), describe: (m) => MODE_BLURB[m] || "" });
  S.tabBeforeMode = S.tab;
  SET.on((ev) => {
    if (ev.type === "mode") onModeChange(ev);
    else if (ev.type === "reset") onDisplayChange(null);
  });
}

/** A manual mode switch: re-read every setting, open the mode's home tab. Time, view and selection stay. */
function onModeChange({ from, to }) {
  S.wtabOverride = null;
  if (from === "all") S.tabBeforeMode = S.tab;
  if (to === "a2a") S.tab = "weapons";
  else if (to === "a2g") S.tab = S.strikes.length ? "strike" : "weapons";
  else S.tab = S.tabBeforeMode || S.tab;
  onDisplayChange(null);
}

function cycleSetting(key, order, label) {
  const i = order.indexOf(SET.get(key));
  const v = order[(i + 1) % order.length];
  SET.set(key, v);
  flash(`${label}: ${v}${S.declutter && DECLUTTER[key] ? " (hidden while decluttered: Z)" : ""}`);
  onDisplayChange(key);
}

/** Any setting changed (Display panel, mode switch, reset): refresh what depends on it. */
function onDisplayChange(key) {
  stopsCache = null;
  if (!key || key === "trailColor") setTrailColor(S.trailColor);
  else if (key.startsWith("ir")) updateLegend();
  if (!key || key === "lighting") scene3d?.setLighting?.(cfg("lighting"));
  if (!S.analysis) return;
  renderTicks();
  renderAllPanels();
  renderMapChips();
  onTimeChange(true);
}

const DISPLAY = [
  { title: "Objects", rows: [
    { key: "air", label: "Aircraft", type: "select", options: [["show", "Show"], ["hide", "Hide"]] },
    { key: "ground", label: "Ground & ships", type: "select", options: [["show", "Show"], ["threats", "Only SAM / AAA / armed ships"], ["hide", "Hide"]] },
    { key: "cm", label: "Flares & chaff", type: "select", options: [["show", "Show"], ["flares", "Flares only"], ["hide", "Hide"]] },
    { key: "dead", label: "Destroyed units", type: "select", options: [["show", "Show as X"], ["fade", "Hide after 60 s"], ["hide", "Hide"]] },
    { key: "blue", label: "Blue", type: "toggle" }, { key: "red", label: "Red", type: "toggle" }, { key: "neutral", label: "Neutral", type: "toggle" },
  ] },
  { title: "Weapons", rows: [
    { key: "weapons", label: "Show", type: "select", options: [["all", "All weapons"], ["a2a", "Air-to-air only"], ["a2g", "Air-to-ground only"], ["none", "None"]] },
    { key: "bomblets", label: "Submunitions", type: "select", options: [["dots", "Dots"], ["hide", "Hide"]] },
    { key: "bullets", label: "Gun rounds", type: "select", options: [["paths", "Paths"], ["tracers", "Tracers"], ["off", "Off"]] },
  ] },
  { title: "Strike marks", rows: [
    { key: "strikeRelease", label: "Release points", type: "toggle" },
    { key: "strikePaths", label: "Weapon paths + time-of-fall ticks", type: "toggle" },
    { key: "strikeFuture", label: "Path still to fly (dotted)", type: "toggle", title: "Shows where a weapon will go before it gets there" },
    { key: "strikeImpacts", label: "Impacts and miss distance", type: "toggle" },
    { key: "strikeFootprints", label: "Bomblet footprints", type: "toggle" },
    { key: "strikeTti", label: "Weapons in flight · time to impact", type: "toggle" },
    { key: "strikeBda", label: "BDA badges", type: "toggle" },
    { key: "strikeLar", label: "JSOW launch zone (DCS table)", type: "toggle", title: "Max / min range for the release altitude and speed, from DCS's own AI launch table" },
    { key: "strikeLabels", label: "Strike labels", type: "select", options: [["auto", "Selected / zoomed in"], ["full", "Always"]] },
  ] },
  { title: "Threats & sensors", rows: [
    { key: "rings", label: "SAM / AAA rings", type: "select", options: [["all", "All"], ["hostile", "Hostile to me"], ["near", "Hostile, when near"], ["off", "Off"]] },
    { key: "radar", label: "Radar cones", type: "select", options: [["all", "All (incl. assumed)"], ["known", "Known only"], ["focus", "Selected jet"], ["none", "Off"]] },
    { key: "lockLines", label: "Lock lines", type: "toggle" },
    { key: "exposure", label: "Mark my path inside SAM rings", type: "toggle", title: "Red where the selected jet (or you) was inside a hostile SAM / AAA envelope" },
    { key: "pointers", label: "Threat arrows at the edge", type: "select", options: [["follow", "While following"], ["always", "Always"], ["off", "Off"]] },
  ] },
  { title: "Heat (IR)", rows: [
    { key: "irHeat", label: "Heat lobes", type: "select", options: [["sel", "Selected + IR targets"], ["focus", "… + me"], ["all", "All aircraft"], ["off", "Off"]],
      title: HEAT_NOTE },
    { key: "irSeeker", label: "IR missile seekers", type: "select", options: [["sel", "Selected + at me"], ["all", "All IR missiles"], ["off", "Off"]],
      title: "Gimbal limit (DCS), the line to what the seeker is steering at, and the flare it likely went for (estimate)" },
    { key: "irReach", label: "Seeker reach (estimate)", type: "toggle",
      title: "How far an IR seeker could see the jet from each side: DCS seeker sensitivity x the square root of its heat. An estimate, not launch range." },
  ] },
  { title: "Overlays", rows: [
    { key: "bullseye", label: "Bullseye", type: "select", options: [["rings", "Rings"], ["calls", "Rings + bullseye calls"], ["off", "Off"]] },
    { key: "braa", label: "BRAA from me on bandits", type: "toggle" },
    { key: "vectors", label: "Velocity vectors", type: "select", options: [[0, "Off"], [10, "10 s"], [30, "30 s"], [60, "60 s"]] },
    { key: "grid", label: "Lat / long grid", type: "toggle" },
  ] },
  { title: "Labels & trails", rows: [
    { key: "labels", label: "Labels", type: "select", options: [["aircraft", "Aircraft"], ["targets", "Aircraft + targets"], ["all", "All"], ["minimal", "Minimal"], ["none", "Off"]] },
    { key: "labelSize", label: "Label size", type: "select", options: [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large (second screen)"]] },
    { key: "trailSec", label: "Trails", type: "select", options: [[30, "30 s"], [60, "60 s"], [90, "90 s"], [300, "5 min"], [1000000, "Full"], [0, "Off"]] },
    { key: "trailColor", label: "Trail colour", type: "select", options: [["side", "Side"], ["alt", "Altitude"], ["speed", "Speed"], ["g", "G"], ["ps", "Energy (Ps)"], ["aoa", "AOA"], ["heat", "Heat (afterburner)"]] },
    { key: "coords", label: "Coordinates", type: "select", options: COORD_FORMATS },
  ] },
  { title: "3D", rows: [
    { key: "stalks", label: "Altitude stalks", type: "select", options: [["off", "Off"], ["selected", "Selected + me"], ["all", "All"]] },
    { key: "lighting", label: "Lighting", type: "select", options: [["day", "Day"], ["dusk", "Dusk"], ["night", "Night"]] },
  ] },
];

// -- selection ------------------------------------------------------------------

function objectTarget(id) {
  const o = S.objects.get(id);
  return o ? { kind: "object", id, o } : null;
}
const currentTarget = () => S.selTarget || (S.selected ? objectTarget(S.selected) : null);
function openSelectionMenu() {
  const tg = currentTarget();
  if (!tg) return;
  const r = sel.card.getBoundingClientRect(), h = document.querySelector(".mapwrap").getBoundingClientRect();
  sel.openMenu(tg, r.width ? r.right - h.left - 8 : 60, r.width ? r.top - h.top + 26 : 60);
}

/** Position of a target at the playhead (held at its last sample when gone). */
function targetPos(tg) {
  if (!tg) return null;
  if (tg.kind === "point") return { lon: tg.lon, lat: tg.lat, alt: null, present: true };
  const p = alive(tg.o, S.t) || sampleTrack(tg.o.pb, S.t);
  if (p) return { ...p, present: true };
  const q = posAt(tg.o, S.t);
  return q ? { ...q, present: false } : null;
}

const isAir = (o) => AIR.includes(o?.category);
const isSurface = (o) => ["ground", "sea"].includes(o?.category);
const isWeapon = (o) => o?.category === "weapon";
const shooterOf = (id) => S.analysis.weapons.shots.some((x) => x.launcherId === id) || S.analysis.weapons.bursts.some((x) => x.launcherId === id) || S.strikes.some((p) => p.s.launcherId === id);
const shotAt = (id) => S.analysis.weapons.shots.some((x) => x.targetId === id) || S.analysis.weapons.kills.some((k) => k.victimId === id) || S.strikes.some((p) => (p.s.damage || []).some((d) => d.id === id) || p.s.targetId === id);
const strikeOf = (id) => S.strikes.find((p) => p.s.weaponId === id)?.s || null;

function copyDefault(tg) {
  const p = targetPos(tg);
  if (!p) return;
  const me = S.me && S.objects.get(S.me);
  const braaOk = tg.kind === "object" && isAir(tg.o) && tg.id !== S.me && me && alive(me, S.t);
  copyAs(tg, braaOk ? "braa" : "coords");
}

async function copyAs(tg, what) {
  const p = targetPos(tg);
  if (!p) return;
  const me = S.me && S.objects.get(S.me);
  const mp = me ? alive(me, S.t) : null;
  let txt = "";
  if (what === "braa" && !mp) { flash("No position for me at this time"); return; }
  if (what === "braa") txt = `BRAA ${braa(mp.lon, mp.lat, p.lon, p.lat, p.alt)}`;
  else if (what === "bulls" && S.analysis.bullseye) txt = `BULLSEYE ${braa(S.analysis.bullseye.longitude, S.analysis.bullseye.latitude, p.lon, p.lat, p.alt)}`;
  else {
    txt = fmtCoord(p.lon, p.lat, cfg("coords") === "dd" ? "ddm" : cfg("coords"));
    // A surface unit's altitude is its ground elevation: what a steerpoint needs.
    if (tg.kind === "object" && isSurface(tg.o) && isNum(p.alt)) txt += ` · elev ${fmtAlt(p.alt)}`;
  }
  if (!txt) return;
  const ok = await copyText(txt);
  flash(ok ? `Copied: ${txt}` : `Copy failed: ${txt}`);
}

function flash(msg) {
  const c = $("modeChip");
  c.textContent = msg;
  c.className = "modechip";
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => c.classList.add("hidden"), 3000);
}

/** Card text for a target. */
/** DCS's aspect factor for a jet seen from `from` (lon, lat, alt): {k, tail}. */
function aspectFactorFrom(o, p, from) {
  const tail = aspectDeg(p.lon, p.lat, (p.hdg + 180) % 360, from.lon, from.lat); // 180 = looking up its tailpipe
  const off = 180 - tail;
  return { k: aspectFactor(off), tail: off };
}

function describeTarget(tg) {
  if (!tg || !S.analysis) return null;
  const me = S.me && S.objects.get(S.me);
  const mp = me ? alive(me, S.t) : null;
  if (tg.kind === "point") {
    const lines = [fmtCoord(tg.lon, tg.lat, cfg("coords") === "dd" ? "ddm" : cfg("coords"))];
    if (mp) lines.push(`from ${me.pilot || me.name}: ${braa(mp.lon, mp.lat, tg.lon, tg.lat)}`);
    return { title: "Map point", sub: "right-click menu", color: "#ffd166", lines };
  }
  const o = tg.o;
  const p = targetPos(tg);
  const lines = [];
  let sub = [o.name !== (o.pilot || o.name) ? o.name : "", o.group, o.coalition].filter(Boolean).join(" · ");
  const death = S.deaths.get(o.id);
  if (isAir(o)) {
    const v = S.series.has(o.id) ? seriesAt(o.id) : null;
    if (p?.present) lines.push([fmtAlt(p.alt), fmtHdg(p.hdg), v ? fmtSpeed(v.IAS ?? v.TAS) : "", v && isNum(v.GLoad) ? `${v.GLoad.toFixed(1)} g` : ""].filter(Boolean).join(" · "));
    const h = S.analysis.ir?.heat?.[o.id];
    const hn = heatNow(h, S.t);
    if (hn && p?.present) {
      const src = h.src === "Afterburner" ? "recorded" : h.src === "DcsFuelFlow" ? "DCS bridge fuel flow" : "fuel flow";
      const now = !isNum(hn.ab) ? "no afterburner" : hn.lit === null ? "now: not recorded" : `now ${hn.lit ? "AB" : "dry"} (${src})`;
      lines.push({ text: `heat ${hn.dry} dry${isNum(hn.ab) ? ` · ${hn.ab.toFixed(1)} AB` : ""} · ${now}`, title: `DCS IR emission coefficient. ${HEAT_NOTE}` });
      // How hot it looks from me: DCS's aspect factor for where I am off its tail.
      const mine = o.id !== S.me && mp && isNum(p.hdg) ? aspectFactorFrom(o, p, mp) : null;
      if (mine) lines.push({ text: `seen from me ×${mine.k.toFixed(2)} (${Math.round(mine.tail)}° off its tail)`, title: HEAT_NOTE });
    } else if (h && !isNum(h.ir) && p?.present && cfg("irHeat") !== "off") {
      lines.push({ text: "heat: type not in the DCS table", cls: "faint", title: HEAT_NOTE });
    }
  } else if (o.category === "countermeasure") {
    const owner = o.cmOwner && S.objects.get(o.cmOwner);
    const kind = o.cmKind === "chaff" ? "Chaff" : "Flare";
    return {
      title: kind, color: owner ? sideColor(owner) : "#8d9aab",
      sub: owner ? `from ${owner.pilot || owner.name} (nearest jet at release, ${Math.round(o.cmDist)} m)` : o.cmAmbiguous ? "owner unclear (two jets close by)" : "owner unknown",
      lines: [o.cmSalvo > 1 ? `salvo of ${o.cmSalvo}` : "", `released ${fmtClock(o.firstSeen - S.start)}`, kind === "Chaff" ? "chaff fools radars, not heat-seekers" : ""].filter(Boolean),
    };
  } else if (isWeapon(o)) {
    const st = strikeOf(o.id);
    const shot = S.analysis.weapons.shots.find((x) => x.weaponId === o.id);
    if (st) {
      if (S.t < st.releaseTime) lines.push(`released in ${fmtClock(st.releaseTime - S.t)}`);
      else if (S.t < st.impactTime) lines.push(`${st.dispense?.time && S.t < st.dispense.time ? `opens in ${fmtClock(st.dispense.time - S.t)} · ` : ""}impact in ${fmtClock(st.impactTime - S.t)}${p?.present ? ` · ${kAlt(p.alt)}` : ""}`);
      else lines.push({ text: `impact ${fmtClock(st.impactTime - S.start)} · ${st.result}${isNum(st.missDistance) ? ` · ${fmtShort(st.missDistance)}` : ""}`, cls: st.result === "destroyed" ? "bad" : "" });
      if (st.targetName) lines.push(`target ${st.targetName}${st.targetSource === "nearest" ? " (nearest)" : ""}`);
      const g = strikeGeometry(st, S.objects, { target: S.target || null });
      if (S.t >= st.impactTime && g?.miss) lines.push(missText(g.miss));
      sub = `${FAMILY_LABEL[st.family] || "weapon"} · ${st.launcherPilot || st.launcherName || ""}`;
    } else if (shot) {
      lines.push(`${shot.launcherPilot || shot.launcherName || "?"} → ${shot.targetPilot || shot.targetName || "—"} · ${shot.outcome}`);
      const sk = shot.ir?.seeker;
      if (sk?.fromEvent) {
        sub = `${shot.weaponName} · IR (DCS shot event) · ${shot.launcherPilot || shot.launcherName || ""}`;
      } else if (sk) {
        sub = `${sk.short || sk.display || shot.weaponName} · IR ${sk.allAspect ? "all-aspect" : "rear-aspect"} · ${shot.launcherPilot || shot.launcherName || ""}`;
        lines.push({ text: `decoyability ${sk.ccm} (DCS ccm_k0: 0 immune · 1 medium · higher = easier to decoy)${isNum(sk.gimbal) ? ` · gimbal ${Math.round(sk.gimbal)}°` : ""}`,
          title: "DCS seeker data" });
        const d = shot.ir.decoy;
        if (d && S.t >= shot.launchTime + d.t) lines.push({ text: `likely went for a flare ${fmtRel(d.t)} (est.)`, cls: "bad" });
      }
    }
  } else {
    const eng = o.pb?.eng;
    let margin = "";
    if (mp && p) {
      const d = distance(mp.lon, mp.lat, p.lon, p.lat) - eng;
      margin = d > 0 ? ` · me ${fmtDist(d)} outside` : ` · me ${fmtDist(-d)} INSIDE`;
    }
    if (isNum(eng)) lines.push({ text: `ring ${fmtDist(eng)}${o.pb.engSrc !== "recorded" ? ` (${o.pb.engSrc})` : ""}${margin}`, cls: margin.includes("INSIDE") && !S.deaths.has(o.id) ? "bad" : "" });
    if (o.group) {
      const members = [...S.objects.values()].filter((x) => x.group === o.group && x.coalition === o.coalition && isSurface(x));
      if (members.length > 1) lines.push(`${o.group}: ${members.filter((x) => !(S.deaths.has(x.id) && S.t >= S.deaths.get(x.id))).length}/${members.length} alive`);
    }
  }
  if (isNum(death) && S.t >= death) {
    const k = S.analysis.weapons.kills.find((x) => x.victimId === o.id);
    lines.push({ text: `destroyed ${fmtClock(death - S.start)}${k?.killerId ? ` by ${k.killerPilot || k.killerName} (${weaponLabel(k.weaponName)})` : ""}`, cls: "bad" });
  }
  // Surface units: bearing and range only (their "altitude" is the ground).
  const alt = isAir(o) || isWeapon(o) ? p?.alt : undefined;
  if (p && mp && o.id !== S.me) lines.push(`BRAA ${braa(mp.lon, mp.lat, p.lon, p.lat, alt)}`);
  if (p && S.analysis.bullseye && !isWeapon(o)) lines.push(`BULLS ${braa(S.analysis.bullseye.longitude, S.analysis.bullseye.latitude, p.lon, p.lat, alt)}`);
  if (p && !p.present && !isNum(death) && !isWeapon(o)) lines.push({ text: "not in the recording at this time", cls: "faint" });
  return { title: `${o.pilot || (isWeapon(o) ? weaponLabel(o.name) : o.name)}${o.id === S.me ? " (me)" : ""}`, sub, color: sideColor(o), lines };
}

const onObj = (fn) => (tg) => tg.kind === "object" && fn(tg.o, tg);
const ACTIONS = [
  { id: "follow", label: "Follow", key: "F", icon: "⌖", primary: true, group: "view", applies: onObj((o) => isAir(o) || isWeapon(o) || o.category === "sea"),
    active: (tg) => S.follow && S.selected === tg.id, run: (tg) => { select(tg.id); setFollow(!(S.follow && S.selected === tg.id)); } },
  { id: "padlock", label: "Padlock in 3D", key: "Shift+click", icon: "◎", group: "view", applies: onObj((o) => o.id !== (S.me || null)),
    run: (tg) => {
      // The menu selected the object on the way in: look at it from the jet that was in focus before.
      if (S.selected === tg.id) {
        const back = S.prevSelected && S.prevSelected !== tg.id && S.objects.has(S.prevSelected) ? S.prevSelected : S.me;
        if (back && back !== tg.id) select(back);
      }
      if (S.view !== "3d") setView("3d");
      setPadlock(tg.id);
    } },
  { id: "wcam", label: "Weapon cam", icon: "🎥", primary: true, group: "view", applies: onObj((o) => isWeapon(o) && !o.dispenser),
    active: (tg) => S.weaponCam?.id === tg.id, run: (tg) => (S.weaponCam?.id === tg.id ? stopWeaponCam() : startWeaponCam(tg.id)) },
  { id: "me", label: "This is me", icon: "★", group: "view", applies: onObj((o) => isAir(o) && o.id !== S.me),
    run: (tg) => setMe(tg) },
  { id: "isolate", label: "Isolate (show only what it touched)", short: "Isolate", key: "X", icon: "◐", primary: true, group: "focus", applies: onObj(() => true),
    active: (tg) => S.isolate?.id === tg.id, run: (tg) => setIsolate(S.isolate?.id === tg.id ? null : tg.id) },
  { id: "shots", label: "Its shots & strikes", short: "Its shots", icon: "➶", primary: true, group: "focus", applies: onObj((o) => shooterOf(o.id)),
    run: (tg) => {
      S.shooterFilter = tg.id;
      const w = S.analysis.weapons;
      const other = w.shots.some((x) => x.launcherId === tg.id && !isAG(x)) || w.bursts.some((x) => x.launcherId === tg.id);
      const ag = S.strikes.some((p) => p.s.launcherId === tg.id);
      S.tab = ag && (!other || SET.mode === "a2g") ? "strike" : "weapons";
      if (S.tab === "weapons") S.wtabOverride = "all";
      renderAllPanels();
    } },
  { id: "hitby", label: "What shot at / hit it", short: "Hit by", icon: "✹", primary: true, group: "focus", applies: onObj((o) => !isWeapon(o) && shotAt(o.id)),
    run: (tg) => {
      S.shooterFilter = tg.id;
      const struck = S.strikes.some((p) => p.s.targetId === tg.id || (p.s.damage || []).some((d) => d.id === tg.id));
      S.tab = struck ? "strike" : "weapons";
      if (S.tab === "weapons") S.wtabOverride = "all";
      renderAllPanels();
    } },
  { id: "card", label: "Open its strike / shot card", short: "Card", icon: "▤", primary: true, group: "focus", applies: onObj((o) => isWeapon(o) && !!S.analysis.weapons.shots.find((x) => x.weaponId === o.id)),
    run: (tg) => {
      if (strikeOf(tg.id)) { S.openStrikes.add(tg.id); S.tab = "strike"; } else { S.openShots.add(tg.id); S.tab = "weapons"; S.wtabOverride = "all"; }
      renderAllPanels();
    } },
  { id: "evnext", label: "Next event of this object", key: "Shift+N", icon: "⏭", group: "time", applies: onObj(() => true), run: (tg) => { select(tg.id); stepEvent(1, { only: tg.id }); } },
  { id: "evprev", label: "Previous event of this object", key: "Shift+P", icon: "⏮", group: "time", applies: onObj(() => true), run: (tg) => { select(tg.id); stepEvent(-1, { only: tg.id }); } },
  { id: "death", label: "Jump to its death", icon: "✝", group: "time", applies: onObj((o) => S.deaths.has(o.id)), run: (tg) => seek(S.deaths.get(tg.id) - 5) },
  { id: "loop", label: "Loop its engagement", icon: "↻", group: "time", applies: onObj((o) => objectStops(o.id).length > 0),
    run: (tg) => { const st = objectStops(tg.id); const a = st[0].time - 5, b = st[st.length - 1].time + 5; setLoop(a, Math.max(b, a + 10), true); seek(a); } },
  { id: "measure", label: "Measure from here", icon: "📏", group: "measure", applies: () => true,
    run: (tg) => { S.measureFrom = tg.kind === "point" ? { lonlat: [tg.lon, tg.lat] } : { id: tg.id }; renderMapChips(); } },
  { id: "tome", label: "Measure to me", icon: "↔", group: "measure", applies: (tg) => !!S.me && S.objects.has(S.me) && !(tg.kind === "object" && tg.id === S.me),
    run: (tg) => addTape({ a: { id: S.me }, b: tg.kind === "point" ? { lonlat: [tg.lon, tg.lat] } : { id: tg.id } }) },
  { id: "compare", label: "Compare with me (charts)", icon: "≋", group: "measure", applies: onObj((o) => isAir(o) && !!S.me && o.id !== S.me),
    run: async (tg) => {
      S.compare = tg.id; S.tab = "charts";
      select(S.me);
      if (!S.series.has(tg.id)) {
        try { const { body, status } = await api(`/api/recording/${S.key}/series/${encodeURIComponent(tg.id)}`); if (status === 200) S.series.set(tg.id, body); } catch { /* offline */ }
      }
      renderAllPanels();
    } },
  { id: "pin", label: "Always show its ring / radar", short: "Pin ring", icon: "📌", group: "show", applies: onObj((o) => isNum(o.pb?.eng) || !!o.pb?.radar),
    active: (tg) => S.pinned.has(tg.id), run: (tg) => { S.pinned.has(tg.id) ? S.pinned.delete(tg.id) : S.pinned.add(tg.id); onTimeChange(true); } },
  { id: "target", label: "Mark as my target", icon: "◇", group: "show", applies: (tg) => tg.kind === "point" || (!isAir(tg.o) && !isWeapon(tg.o)),
    active: (tg) => !!S.target && (tg.kind === "object" ? S.target.id === tg.id : false),
    run: (tg) => {
      const p = targetPos(tg);
      if (!p) return;
      S.target = S.target && tg.kind === "object" && S.target.id === tg.id ? null
        : { id: tg.kind === "object" ? tg.id : null, name: tg.kind === "object" ? tg.o.name : "point", lon: p.lon, lat: p.lat, alt: p.alt };
      renderMapChips(); renderAllPanels(); map.invalidate();
    } },
  { id: "group", label: "Isolate its group", icon: "⬡", group: "show", applies: onObj((o) => !!o.group && [...S.objects.values()].filter((x) => x.group === o.group).length > 1),
    run: (tg) => {
      const ids = new Set([...S.objects.values()].filter((x) => x.group === tg.o.group && x.coalition === tg.o.coalition).map((x) => x.id));
      for (const id of [...ids]) relatedIds(id).forEach((x) => ids.add(x));
      S.isolate = { id: tg.id, ids, group: tg.o.group };
      renderMapChips(); renderObjectList(); onTimeChange(true);
    } },
  { id: "hide", label: "Hide it", icon: "⊘", group: "show", applies: onObj((o) => o.id !== S.me && !(isWeapon(o) && atMe(o, S.t))),
    run: (tg) => { S.hidden.add(tg.id); if (S.selected === tg.id) select(null); renderObjectList(); renderMapChips(); onTimeChange(true); } },
  { id: "copybraa", label: "Copy BRAA from me", icon: "⧉", group: "copy",
    applies: (tg) => !!S.me && !!S.objects.get(S.me) && !!alive(S.objects.get(S.me), S.t) && !(tg.kind === "object" && tg.id === S.me), run: (tg) => copyAs(tg, "braa") },
  { id: "copybulls", label: "Copy bullseye call", icon: "⧉", group: "copy", applies: () => !!S.analysis?.bullseye, run: (tg) => copyAs(tg, "bulls") },
  { id: "copypos", label: "Copy coordinates", key: "Ctrl+C", icon: "⧉", group: "copy", applies: () => true, hint: () => (cfg("coords") === "dd" ? "deg-min, as the DED" : ""), run: (tg) => copyAs(tg, "coords") },
];

/** Chips on the map for states that hide or change things (never silent). */
function renderMapChips() {
  const box = $("mapChips");
  box.innerHTML = "";
  const add = (txt, clear, cls = "") => box.append(el("button", { class: `mapchip ${cls}`, title: "Clear", onclick: clear }, txt, " ×"));
  const rec = S.analysis?.recording;
  if (rec?.scrambled) box.append(el("span", { class: "mapchip warn", title: rec.warnings?.[0] || "" }, "⚠ Positions scrambled (multiplayer playback delay)"));
  if (S.isolate) {
    const o = S.objects.get(S.isolate.id);
    add(`Isolated: ${S.isolate.group || o?.pilot || o?.name || "?"} + ${S.isolate.ids.size - 1} related · X`, () => setIsolate(null));
  }
  if (S.hidden.size) add(`${S.hidden.size} hidden`, () => { S.hidden.clear(); renderObjectList(); renderMapChips(); onTimeChange(true); });
  if (S.target) add(`Target: ${S.target.name}`, () => { S.target = null; renderMapChips(); renderAllPanels(); map.invalidate(); }, "tgt");
  if (S.measureFrom) add("Measuring: click an object or point · Esc", () => { S.measureFrom = null; S.tapeDraft = null; renderMapChips(); map.invalidate(); });
  if (S.weaponCam) add("Weapon cam · Esc", () => stopWeaponCam());
  if (S.declutter) add("Decluttered · Z", () => { S.declutter = false; onDisplayChange(null); });
  if (SET.mode !== "all") {
    const m = MODES.find((x) => x.id === SET.mode);
    add(`${m.label} mode`, () => SET.setMode("all"), `m-${SET.mode}`);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  for (const [k, v] of Object.entries(LAYERS)) $("layerSel").append(el("option", { value: k }, v.label));
  $("layerSel").value = map.layer;
  $("layerSel").onchange = (e) => { map.setLayer(e.target.value); setPref("layer", e.target.value); };
  $("unitSel").value = units.system;
  $("unitSel").onchange = (e) => { units.set(e.target.value); renderAllPanels(); updateLegend(); renderTapeHud(); map.invalidate(); };
  setupModes();
  display = createDisplayPanel($("btnDisplay"), document.querySelector(".mapwrap"), { sections: DISPLAY, settings: SET, onChange: onDisplayChange });
  sel = createSelectionUI(document.querySelector(".mapwrap"), {
    actions: ACTIONS, describe: describeTarget, cardHost: $("hudCol"),
    onClose: () => { if (S.selTarget?.kind === "point") { S.selTarget = null; sel.set(null); } else select(null); },
  });
  wireSettingsButton("btnSettings");
  $("btnCareer").onclick = () => { location.href = "/career"; };
  reportPageErrors();
  $("btnFollow").onclick = () => setFollow(!S.follow);
  $("btn2d").onclick = () => setView("2d");
  $("btn3d").onclick = () => setView("3d");
  $("btnOrbit").onclick = () => setCam("orbit");
  $("btnChase").onclick = () => setCam("chase");
  $("btnPadlock").onclick = () => setCam("padlock");
  $("btnMeasure").onclick = () => setMeasure(map.tool !== "measure");
  $("btnPrevEv").onclick = () => stepEvent(-1);
  $("btnNextEv").onclick = () => stepEvent(1);
  $("btnLoop").onclick = () => toggleLoop();
  $("btnKeys").onclick = () => S.keys?.help();
  $("exagSel").onchange = (e) => { scene3d?.setExaggeration(+e.target.value); onTimeChange(true); };
  $("btnFit").onclick = fitAll;
  $("btnLibrary").onclick = showLibrary;
  $("btnPlay").onclick = togglePlay;
  $("speedSel").onchange = (e) => { S.speed = +e.target.value; };
  $("btnBack").onclick = () => seek(S.t - 10);
  $("btnFwd").onclick = () => seek(S.t + 10);
  $("objFilter").oninput = (e) => { S.filter = e.target.value.toLowerCase(); renderObjectList(); };
  $("objFilter").addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.target.value = ""; S.filter = ""; renderObjectList(); e.target.blur();
  });
  $("btnDebrief").onclick = () => {
    if (S.key) window.open(`/api/recording/${S.key}/markdown${S.me ? `?focus=${S.me}` : ""}`, "_blank");
  };
  document.querySelector('a[href="/live"]').addEventListener("click", async (e) => {
    if (S.status?.desktop) { e.preventDefault(); await api("/api/open-live", { method: "POST" }); }
  });
  setupScrubber();
  S.keys = bindShortcuts(KEYS);
  map.scene = drawMap;
  map.measureEnabled = true;
  map.on("click", onMapClick);
  map.on("hover", onMapHover);
  map.on("viewchange", (ev) => { if (ev?.user && S.follow) setFollow(false); });
  map.on("measurestart", (ev) => { S.tapeDraft = { a: snapAt(ev.px, ev.py) || { lonlat: ev.lonlat }, b: { lonlat: ev.lonlat } }; map.invalidate(); });
  map.on("measuremove", (ev) => { if (S.tapeDraft) { S.tapeDraft.b = { lonlat: ev.lonlat }; map.invalidate(); } });
  map.on("measureend", (ev) => {
    if (!S.tapeDraft) return;
    S.tapeDraft.b = snapAt(ev.px, ev.py) || { lonlat: ev.lonlat };
    addTape(S.tapeDraft);
    S.tapeDraft = null;
  });
  map.on("measurecancel", () => { S.tapeDraft = null; map.invalidate(); });
  map.on("contextmenu", (ev) => {
    ev.event.preventDefault();
    if (!S.analysis) return;
    // An object under the cursor opens its menu (tape ends sit on objects);
    // otherwise a tape under the cursor is deleted, as before.
    const hit = hitAt(ev.px, ev.py);
    const i = hit ? -1 : tapeNear(ev.px, ev.py);
    if (i >= 0) { S.tapes.splice(i, 1); renderTapeHud(); map.invalidate(); return; }
    const target = hit && !hit.strike ? objectTarget(hit.id) : hit?.strike ? objectTarget(hit.id) || pointTarget(hit) : { kind: "point", lon: ev.lonlat[0], lat: ev.lonlat[1] };
    if (!target) return;
    if (target.kind === "object" && hit.id !== S.selected) select(hit.id);
    sel.openMenu(target, ev.px, ev.py);
  });
  renderTabs();

  try { S.status = (await api("/api/status")).body; } catch { /* offline */ }
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("rec")) loadRecording(hash.get("rec"));
  else showLibrary();
  window.addEventListener("hashchange", () => {
    const k = new URLSearchParams(location.hash.slice(1)).get("rec");
    if (k && k !== S.key) loadRecording(k);
  });
  watcher = watchRecordings({
    host: document.querySelector(".mapwrap"), placement: "top",
    openHere: (key) => loadRecording(key),
    isOpen: (key) => key === S.key || key === S.loadingKey,
    isIdle: () => !S.loadingKey && (!S.analysis || !S.playing),
  });
  // Test hook (?debug): symbol hitboxes and the map, for browser tests.
  if (new URLSearchParams(location.search).has("debug")) window.__dcsSA = { hitboxes: () => hitboxes, map, S, settings: SET, sel, scene3d: () => scene3d };
  requestAnimationFrame(tick);
}

function toast(msg, { info = false, ms = 5000 } = {}) {
  const t = el("div", { class: info ? "toast info" : "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
  return t;
}

/** "This is me": remembered for this recording, and the pilot name can be remembered for the next ones. */
function setMe(target) {
  const o = S.objects.get(target.id) || target;
  S.me = o.id;
  setPref(`me.${S.key}`, o.id);
  renderAllPanels();
  map.invalidate();
  const name = (o.pilot || "").trim();
  const known = (S.status?.playerNames || []).map((n) => n.toLowerCase());
  if (!name || known.includes(name.toLowerCase())) return;
  const t = toast([`Is "${name}" your pilot name? `,
    el("button", { onclick: async () => {
      t.remove();
      const names = [name, ...(S.status?.playerNames || [])];
      try {
        const { body } = await api("/api/player", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ names }) });
        if (S.status) S.status.playerNames = body.playerNames;
        flash(`Saved: new recordings will pick ${name}'s jet as yours`);
      } catch { flash("Could not save the pilot name"); }
    } }, "Remember it"),
    el("button", { onclick: () => t.remove() }, "No")], { info: true, ms: 12000 });
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

/** The version line: up to date, an update to get and install, or a failed check. */
function renderVersion(host, up, tries = 0) {
  host.innerHTML = "";
  host.classList.toggle("note-update", !!up?.available);
  // Only the newest render of this line may schedule a follow-up, so going
  // back to the library repeatedly cannot stack up pollers.
  const gen = (host._gen = (host._gen || 0) + 1);
  const check = async (force, n = 0, path = "/api/update") => {
    if (host._gen !== gen) return;
    try {
      const { body } = await api(`${path}${force ? "?force=1" : ""}`);
      if (S.status) S.status.update = body;
      if (host._gen === gen) renderVersion(host, body, n);
    } catch { /* app not reachable; the line keeps what it last showed */ }
  };
  const post = async (path) => {
    try {
      const { body } = await api(path, { method: "POST" });
      if (!body.ok && body.error) flash(body.error);
      return body;
    } catch (err) { flash(err.message); return { ok: false }; }
  };
  const version = up?.current || S.status?.version || "";

  if (up?.available) {
    const inst = up.install || {};
    const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
    host.append(`DCS SA ${up.latest} is out (you have ${version}). `);
    if (inst.state === "downloading") {
      const pct = inst.total ? Math.round((inst.done / inst.total) * 100) : null;
      host.append(el("span", {}, pct === null ? `Downloading… ${mb(inst.done || 0)}` : `Downloading… ${pct}%`));
      setTimeout(() => check(false, 0), 700);
    } else if (inst.state === "ready") {
      host.append(el("button", { onclick: async () => {
        flash("Installing — DCS SA will close and reopen");
        await post("/api/update/install");
      } }, "Install now"),
        el("span", { class: "muted" }, " Downloaded and checked. DCS SA closes, updates and reopens."));
    } else {
      // Windows only: elsewhere (and if anything goes wrong) fall back to the page.
      const canInstall = (S.status?.platform || "") === "win32";
      const queued = canInstall && S.status?.autoDownload && inst.state !== "failed";
      if (queued) {
        // The download starts by itself; this is only ever a moment's wait.
        host.append(el("span", {}, "Getting it ready…"));
        setTimeout(() => check(false, 0), 900);
        return;
      }
      host.append(el("button", { onclick: async () => {
        if (!canInstall) { await post("/api/open-release"); return; }
        const body = await post("/api/update/download");
        if (body.ok) check(false, 0); else await post("/api/open-release");
      } }, canInstall ? "Get it" : "Open download page"),
        inst.state === "failed"
          ? el("span", { class: "muted" }, ` Last try failed: ${inst.error}. `)
          : el("span", { class: "muted" }, canInstall
            ? " Downloads and installs itself; your recordings and settings are kept."
            : " Opens the download page; the installer only runs on Windows."));
    }
    return;
  }

  const settled = up?.enabled === false || (up?.checked && !up?.checking);
  const gaveUp = tries >= 20;   // ~25 s: far longer than the 6 s request timeout
  const status = up?.enabled === false ? "update checks are off"
    : settled ? (up?.latest ? "up to date" : "couldn't check for updates")
    : gaveUp ? "couldn't check for updates"
    : "checking for updates…";
  host.append(el("span", { class: "muted" }, `DCS SA ${version} · ${status}`));
  if (up?.enabled !== false && (settled || gaveUp)) {
    host.append(el("button", { class: "linklike", onclick: () => check(true) }, "Check again"));
  } else if (up?.enabled !== false) {
    setTimeout(() => check(false, tries + 1), 1200);
  }
}

async function showLibrary() {
  const w = $("welcome");
  w.classList.remove("hidden");
  w.innerHTML = "";
  const box = el("div", { class: "box" });
  w.append(box);
  const player = S.status?.profile?.player;
  box.append(
    el("h1", {}, "Flight debrief"),
    el("p", { class: "lead" }, "Open a Tacview recording (.acmi) to replay the sortie and review telemetry, weapons, radar and landings.",
      player ? ` Your DCS pilot profile is "${player}"; that jet is picked automatically.` : ""),
    el("p", { class: "lead" }, "New here? ",
      el("button", { onclick: () => { location.href = "/guide#step-3-try-it-with-a-demo-flight-no-dcs-needed"; } }, "Guide"),
      " walks you through it step by step, from the demo flights to setting up DCS."),
  );
  // Always says which version this is, so "am I up to date?" has an answer
  // even when there is nothing to install.
  const verLine = el("div", { class: "version-line" });
  box.append(verLine);
  renderVersion(verLine, S.status?.update);
  // The bridge is optional, so it is offered rather than installed silently:
  // it writes into the user's DCS folder.  Once in, it keeps itself up to date.
  const prof0 = S.status?.profile || {};
  if (prof0.found && prof0.tacviewInstalled && !prof0.bridgeInstalled) {
    const note = el("div", { class: "note-update" });
    const install = el("button", { onclick: async () => {
      install.disabled = true;
      install.textContent = "Installing…";
      try {
        const { body } = await api("/api/install-bridge", { method: "POST" });
        note.textContent = body.ok
          ? `DCS bridge installed in ${body.installed.join(", ")}. Quit DCS completely and start it again to use it. It updates itself from now on.`
          : `Could not install it: ${body.error}`;
      } catch (err) {
        note.textContent = `Could not install it: ${err.message}`;
      }
    } }, "Install it");
    note.append("Get more out of your debriefs: the ", el("b", {}, "DCS bridge"),
      " adds your stick and throttle inputs, RWR and exact fuel, and DCS's own hits and kills. ",
      install,
      el("span", { class: "muted" }, " One click, then restart DCS. It keeps itself up to date afterwards."));
    box.append(note);
  }
  const drop = el("div", { class: "drop" }, "Drop an .acmi file here, or ",
    el("button", { onclick: () => fileInput.click() }, "choose a file"));
  const fileInput = el("input", { type: "file", accept: ".acmi,.txt", class: "hidden" });
  fileInput.onchange = () => fileInput.files[0] && upload(fileInput.files[0]);
  box.append(drop, fileInput);
  for (const evt of ["dragenter", "dragover"]) w.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add("over"); });
  for (const evt of ["dragleave", "drop"]) w.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove("over"); });
  w.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f) upload(f); });

  const lib = el("div", { class: "library" }, el("div", { class: "empty" }, "Scanning for recordings…"));
  box.append(lib);
  try {
    const { body } = await api("/api/recordings");
    lib.innerHTML = "";
    if (!body.recordings.length) lib.append(el("div", { class: "empty" }, "No recordings found yet."));
    for (const r of body.recordings) {
      lib.append(el("div", { class: "rec", onclick: () => loadRecording(r.key) },
        el("div", { class: "n" }, r.sample ? `${r.name} (demo)` : r.name, el("small", {}, r.folder)),
        el("span", { class: "muted num" }, `${(r.size / 1048576).toFixed(1)} MB`),
        el("span", { class: "muted" }, new Date(r.modified * 1000).toLocaleString())));
    }
    const prof = S.status?.profile || {};
    box.append(el("div", { class: "hint", html:
      `Searched: ${body.dirs.map((d) => `<code>${d.replace(/</g, "&lt;")}</code>`).join(" ")}<br>` +
      (prof.found && !prof.tacviewInstalled
        // Nothing to find until Tacview's recorder is in DCS: its Options page is missing too.
        ? "<b>Tacview's recorder is not installed in DCS</b>, so DCS writes no recordings and has no " +
          "<code>Options → Special → Tacview</code> page. " +
          '<a href="/guide#step-4-record-your-own-flights">How to install it</a>.'
        : "Tacview saves to <code>Documents\\Tacview</code> by default. Enable the recorder in DCS under " +
          "<code>Options → Special → Tacview</code>.") }));
  } catch (err) {
    lib.innerHTML = "";
    lib.append(el("div", { class: "empty" }, `Could not list recordings: ${err.message}`));
  }
}

// A recording dropped anywhere on the window opens it (the start page has its own drop area).
window.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) e.preventDefault(); });
window.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  e.preventDefault();
  if ($("welcome").classList.contains("hidden")) upload(f);
});

async function upload(file) {
  try {
    const { body } = await api("/api/upload", { method: "POST", headers: { "X-Filename": encodeURIComponent(file.name) }, body: file });
    watcher?.markKnown(body.key);
    loadRecording(body.key);
  } catch (err) { toast(`Upload failed: ${err.message}`); }
}

let watcher = null;
async function loadRecording(key) {
  // A later load supersedes this one (e.g. auto-open while a big file parses).
  const gen = (S.loadGen = (S.loadGen || 0) + 1);
  S.loadingKey = key;
  watcher?.markKnown(key);
  const w = $("welcome");
  w.classList.remove("hidden");
  w.innerHTML = "";
  const fill = el("div", { class: "fill" });
  const label = el("div", {}, "Loading recording…");
  w.append(el("div", { class: "loading" }, label, el("div", { class: "progressbar" }, fill)));
  try {
    for (;;) {
      const { body } = await api(`/api/recording/${key}/load`);
      if (gen !== S.loadGen) return;
      fill.style.width = `${Math.round((body.progress || 0) * 100)}%`;
      if (body.state === "ready") break;
      if (body.state === "error") throw new Error(body.error);
      label.textContent = body.state === "analyzing" ? "Analysing…" : "Parsing recording…";
      await new Promise((r) => setTimeout(r, 300));
    }
    const [a, p] = await Promise.all([api(`/api/recording/${key}/analysis`), api(`/api/recording/${key}/playback`)]);
    if (gen !== S.loadGen) return;
    S.loadingKey = null;
    setupRecording(key, a.body, p.body);
    w.classList.add("hidden");
    history.replaceState(null, "", `#rec=${key}`);
  } catch (err) {
    if (gen !== S.loadGen) return;
    S.loadingKey = null;
    toast(`Could not load recording: ${err.message}`);
    showLibrary();
  }
}

function setupRecording(key, analysis, playback) {
  S.key = key; S.analysis = analysis; S.playback = playback;
  S.series.clear(); S.objects.clear(); S.deaths.clear();
  S.trailSeries.clear(); trailCache.clear(); trailRanges.clear(); stopsCache = null;
  exposureCache.clear(); targetIdsCache = null; sitesCache = null;
  S.loop = { a: null, b: null, on: false }; S.padlockId = null; S.tapes = []; S.tapeDraft = null;
  S.openShots.clear(); S.openStrikes.clear();
  S.lastStop = null;
  S.hidden.clear(); S.pinned.clear(); S.isolate = null; S.target = null; S.shooterFilter = null; S.compare = null;
  S.weaponCam = null; S.measureFrom = null; S.selTarget = null;
  hideChip();
  renderTapeHud();
  for (const o of analysis.objects) {
    const pb = playback.objects[o.id];
    if (pb) S.objects.set(o.id, { ...o, pb });
  }
  for (const k of analysis.weapons.kills) S.deaths.set(k.victimId, k.time);
  S.strikes = prepareStrikes(analysis.strikes || [], S.objects, analysis.weapons.submunitions || {});
  S.strikeIds = new Set((analysis.strikes || []).map((x) => x.weaponId));
  S.ir = prepareIR(analysis, S.objects);
  S.irNames = new Map(S.ir.shots.map((x) => [x.s.weaponId, x.sk.short || x.sk.display || x.s.weaponName]));
  // Bomblets per dispenser: DCS's count for the load (it records one object for all of them).
  S.subCount = new Map((analysis.strikes || []).filter((x) => x.submunitions).map((x) => [x.weaponId, x.submunitions]));
  modeSw?.refresh?.();
  S.rounds = playback.rounds || [];
  S.roundLife = Math.max(1, ...S.rounds.map((r) => (r.end ?? r.t[r.t.length - 1]) - r.t[0]));
  if (playback.roundsTruncated) toast(`Showing the first ${S.rounds.length} of ${playback.roundsTotal} gun rounds.`);
  S.start = playback.start; S.end = playback.end;
  S.t = S.start;
  // "This is me" picked earlier for this recording wins over the guess.
  const savedMe = pref(`me.${key}`, null);
  S.me = savedMe && analysis.objects?.some((o) => o.id === savedMe) ? savedMe : analysis.player;
  $("recTitle").textContent = `${analysis.recording.title} · ${fmtClock(analysis.recording.duration)} · ${analysis.recording.aircraftCount} aircraft`;
  $("btnDebrief").disabled = false;
  renderTicks();
  fitAll();
  select(S.me || analysis.aircraft[0]?.id || null);
  renderAllPanels();
  scene3d?.setStrikes?.(strikes3d());
  if (pref("view", "2d") === "3d") { setView("3d"); setCam(S.cam); }
  updateLoopBand();
  setTrailColor(S.trailColor);
  renderMapChips();
}

/** Strikes with their weapon's playback track, for the 3D view. */
function strikes3d() {
  return (S.analysis?.strikes || []).map((x) => ({ ...x, pb: S.objects.get(x.weaponId)?.pb || null }));
}

function fitAll() {
  const b = S.analysis?.bounds;
  if (b) map.fitBounds(b[0], b[1], b[2], b[3]);
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
function tick(now) {
  const dt = (now - lastFrame) / 1000;
  lastFrame = now;
  if (S.playing && S.analysis) {
    S.t += dt * S.speed;
    if (S.loop.on && isNum(S.loop.a) && isNum(S.loop.b) && S.t >= S.loop.b) S.t = S.loop.a;
    if (S.t >= S.end) { S.t = S.end; togglePlay(false); }
    onTimeChange();
  }
  requestAnimationFrame(tick);
}

function togglePlay(force) {
  S.playing = typeof force === "boolean" ? force : !S.playing;
  if (S.playing && S.t >= S.end) S.t = S.start;
  if (S.playing && S.loop.on && isNum(S.loop.a) && (S.t < S.loop.a || S.t >= S.loop.b)) S.t = S.loop.a;
  $("btnPlay").textContent = S.playing ? "❚❚" : "▶";
}

function seek(t) {
  if (!S.analysis) return;
  const nt = Math.max(S.start, Math.min(S.end, t));
  if (Math.abs(nt - S.t) > 10 && chipTimer) hideChip();
  S.t = nt;
  onTimeChange(true);
}

function onTimeChange(force = false) {
  if (S.follow && S.selected) {
    const o = S.objects.get(S.selected);
    const p = o && sampleTrack(o.pb, S.t);
    if (p && isNum(p.lon)) map.setView(p.lon, p.lat);
  }
  map.invalidate();
  updateWeaponCam();
  if (S.view === "3d" && scene3d && S.analysis) {
    scene3d.follow = true;
    const focus = S.selected || S.me;
    const wc = S.weaponCam;
    scene3d.update(sceneObjects(), { focusId: focus, selectedId: S.selected, radar: S.radar, rounds: currentRounds(),
      padlockId: S.cam === "padlock" ? padlockTarget() : null,
      t: S.t, strikeLayers: strikeLayers(), stalks: cfg("stalks"), rings: ringMode3d(), pinned: S.pinned,
      lockLines: cfg("lockLines"), dim: S.isolate ? S.isolate.ids : null,
      weaponCamHoldAt: wc && wc.held ? wc.hold : null, heat: heat3d() });
    scene3d.setPointers(cfg("pointers") === "off" ? [] : threatsAt(S.t, focus));
  }
  updateScrubber();
  const now = performance.now();
  if (force || now - S.lastPanel > 100) {
    S.lastPanel = now;
    updateLivePanels();
  }
}

/** Which strike marks to draw (Display > Strike, or the A-G mode's defaults). */
function strikeLayers() {
  return { release: cfg("strikeRelease"), paths: cfg("strikePaths"), future: cfg("strikeFuture"), impacts: cfg("strikeImpacts"),
    footprints: cfg("strikeFootprints"), tti: cfg("strikeTti"), bda: cfg("strikeBda"), lar: cfg("strikeLar") };
}

/** 3D engagement domes follow the 2D ring setting ("near" has no 3D test: hostile). */
function ringMode3d() {
  const r = cfg("rings");
  return r === "off" ? "off" : r === "all" ? "all" : "hostile";
}

/**
 * Weapon cam: ride a weapon in 3D chase, hold on the impact for 3 s, then
 * hand back to the previous selection and camera.
 */
function startWeaponCam(weaponId) {
  const st = S.strikes.find((p) => p.s.weaponId === weaponId);
  const shot = S.analysis.weapons.shots.find((x) => x.weaponId === weaponId);
  const t0 = st ? st.s.releaseTime : shot?.launchTime;
  const t1 = st ? st.s.impactTime : shot?.endTime ?? shot?.launchTime;
  if (!isNum(t0)) return;
  // The right-click menu and W select the weapon first: hand back to what was selected before it.
  const prevSel = S.selected !== weaponId ? S.selected : S.selBeforeWeapon ?? S.me ?? null;
  const wc = { id: weaponId, prevSel, prevCam: S.cam, prevView: S.view, end: t1, held: false,
    hold: st ? { lon: st.geom.impact.lon, lat: st.geom.impact.lat, alt: st.geom.impact.alt } : null };
  S.weaponCam = null;
  select(weaponId);
  if (S.view !== "3d") setView("3d");
  setCam("chase");
  // An A-B loop elsewhere would pull playback away from the weapon: park it (L brings it back).
  if (S.loop.on && (S.loop.a > t0 - 1 || S.loop.b < (isNum(t1) ? t1 : t0) + 3)) setLoop(S.loop.a, S.loop.b, false);
  if (S.t < t0 || S.t > t1) seek(t0 - 1);
  S.weaponCam = wc; // armed last, so nothing during the switch sees a half-built cam
  if (!S.playing) togglePlay(true);
  renderMapChips();
}

function stopWeaponCam({ restore = true } = {}) {
  const wc = S.weaponCam;
  if (!wc) return;
  S.weaponCam = null;
  if (restore) {
    setCam(wc.prevCam);
    if (wc.prevView !== "3d") setView(wc.prevView);
    select(wc.prevSel);
  }
  renderMapChips();
}

function updateWeaponCam() {
  const wc = S.weaponCam;
  if (!wc) return;
  if (S.selected !== wc.id) { stopWeaponCam({ restore: false }); return; }
  wc.held = isNum(wc.end) && S.t > wc.end;
  if (isNum(wc.end) && S.t > wc.end + 3) stopWeaponCam();
}

function setFollow(on) {
  S.follow = on;
  $("btnFollow").classList.toggle("active", on);
  if (on) onTimeChange(true);
}

function setupScrubber() {
  const sc = $("scrub");
  const tAt = (e) => {
    const r = sc.getBoundingClientRect();
    return S.start + ((e.clientX - r.left) / r.width) * (S.end - S.start);
  };
  let dragging = false, painting = null;
  sc.addEventListener("pointerdown", (e) => {
    sc.setPointerCapture(e.pointerId);
    if (e.shiftKey && S.analysis) { painting = S.loopPaint = { a: tAt(e), b: tAt(e) }; updateLoopBand(painting); return; }
    dragging = true; seek(tAt(e));
  });
  sc.addEventListener("pointerup", () => {
    if (!painting) return;
    const { a, b } = painting;
    painting = S.loopPaint = null;
    if (Math.abs(b - a) >= 1) setLoop(Math.min(a, b), Math.max(a, b), true); else updateLoopBand();
  });
  sc.addEventListener("pointermove", (e) => {
    if (painting) { painting.b = tAt(e); updateLoopBand(painting); }
    if (dragging) seek(tAt(e));
    let h = sc.querySelector(".hovert");
    if (!h) { h = el("div", { class: "hovert" }); sc.append(h); }
    const r = sc.getBoundingClientRect();
    h.style.left = `${e.clientX - r.left}px`;
    h.textContent = fmtClock(tAt(e) - S.start);
  });
  sc.addEventListener("pointerup", () => { dragging = false; });
  sc.addEventListener("pointerleave", () => sc.querySelector(".hovert")?.remove());
}

function renderTicks() {
  const sc = $("scrub");
  sc.querySelectorAll(".tick, .lane").forEach((n) => n.remove());
  if (!S.analysis) return;
  const span = S.end - S.start || 1;
  const pct = (t) => `${((t - S.start) / span) * 100}%`;
  const mode = SET.mode;
  for (const it of S.analysis.timeline) {
    if (!["kill", "shot", "landing", "takeoff", "lock"].includes(it.kind)) continue;
    if (it.kind === "shot" && it.text.includes(": ")) continue; // outcome rows
    // Strike releases have their own lanes below.
    if (it.kind === "shot" && it.objectIds.some((id) => S.strikeIds.has(id))) continue;
    if (mode === "a2g" && ["landing", "takeoff"].includes(it.kind)) continue;
    if (mode === "a2a" && ["landing", "takeoff"].includes(it.kind)) continue;
    sc.append(el("div", { class: `tick ${it.kind}${mode === "a2g" && it.kind !== "kill" ? " dim" : ""}`, title: `${fmtClock(it.time - S.start)} ${it.text}`,
      style: { left: pct(it.time) } }));
  }
  if (mode === "a2a") return;
  // Strike lanes: release -> impact, stacked when they overlap, dot at the impact.
  const rows = [];
  for (const p of [...S.strikes].sort((a, b) => a.s.releaseTime - b.s.releaseTime)) {
    const x = p.s;
    let row = rows.findIndex((end) => end < x.releaseTime - 1);
    if (row < 0) { row = rows.length; rows.push(0); }
    rows[row] = x.impactTime;
    if (row > 2) continue; // three lanes are plenty; the Strike tab lists everything
    const col = RESULT_COLOR[x.result] || RESULT_COLOR.unknown;
    const lane = el("div", {
      class: "lane", style: { left: pct(x.releaseTime), width: `${((x.impactTime - x.releaseTime) / span) * 100}%`, top: `${26 + row * 3}px` },
      title: `${fmtClock(x.releaseTime - S.start)} ${weaponLabel(x.weaponName)}${x.targetName ? ` → ${x.targetName}` : ""} · TOF ${Math.round(x.timeOfFall)} s · ${x.result}`,
    }, el("i", { style: { background: col } }));
    lane.addEventListener("pointerdown", (e) => { e.stopPropagation(); seek(x.releaseTime - 5); select(x.weaponId); });
    sc.append(lane);
  }
}

function updateScrubber() {
  updateLoopBand(S.loopPaint || undefined);
  const f = (S.t - S.start) / (S.end - S.start || 1);
  document.querySelector(".scrub .progress").style.width = `${f * 100}%`;
  document.querySelector(".scrub .head").style.left = `${f * 100}%`;
  const z = fmtZulu(S.analysis?.recording.referenceTime, S.t);
  $("clock").innerHTML = "";
  $("clock").append(`${fmtClock(S.t - S.start)} / ${fmtClock(S.end - S.start)}`, z ? el("span", { class: "z" }, z) : "");
}

function stepSpeed(dir) {
  const opts = [...$("speedSel").options].map((o) => +o.value);
  const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(S.speed) + dir));
  S.speed = opts[i]; $("speedSel").value = String(S.speed);
}

function gotoTab(n) {
  const tabs = visibleTabs();
  if (!tabs[n - 1]) return;
  S.tab = tabs[n - 1][0];
  renderAllPanels();
}

function stepAircraft(dir) {
  // The object list's order (its filters and sorting), including groups folded away.
  const ids = (S.listOrder || []).filter((id) => AIR.includes(S.objects.get(id)?.category));
  if (!ids.length) return;
  const i = ids.indexOf(S.selected);
  const id = ids[(i < 0 ? (dir > 0 ? 0 : ids.length - 1) : i + dir + ids.length) % ids.length];
  select(id);
  if (!S.follow) {
    const o = S.objects.get(id);
    const p = sampleTrack(o.pb, S.t) || sampleTrack(o.pb, o.pb.t[0]);
    if (p) map.setView(p.lon, p.lat);
  }
}

const KEYS = [
  { keys: [" "], group: "Playback", label: "Play / pause", run: () => togglePlay() },
  { keys: ["ArrowLeft", "ArrowRight"], group: "Playback", label: "Back / forward 5 s", repeat: true,
    run: (e) => seek(S.t + (e.key === "ArrowLeft" ? -5 : 5)) },
  { keys: ["Shift+ArrowLeft", "Shift+ArrowRight"], group: "Playback", label: "Back / forward 30 s", repeat: true,
    run: (e) => seek(S.t + (e.key === "ArrowLeft" ? -30 : 30)) },
  { keys: [",", "."], group: "Playback", label: "Pause and step 0.5 s", repeat: true,
    run: (e) => { togglePlay(false); seek(S.t + (e.key === "," ? -0.5 : 0.5)); } },
  { keys: ["[", "]"], group: "Playback", label: "Slower / faster", repeat: true, run: (e) => stepSpeed(e.key === "]" ? 1 : -1) },
  { keys: ["Home", "End"], group: "Playback", label: "Start / end of the recording", run: (e) => seek(e.key === "Home" ? S.start : S.end) },
  { keys: ["n", "p"], group: "Playback", label: "Next / previous event", run: (e) => stepEvent(e.key.toLowerCase() === "n" ? 1 : -1) },
  { keys: ["i", "o"], group: "Playback", label: "Set loop in / out point", run: (e) => setLoopPoint(e.key.toLowerCase() === "i" ? "a" : "b") },
  { keys: ["l"], group: "Playback", label: "Loop on / off", run: () => toggleLoop() },
  { keys: ["Shift+L"], group: "Playback", label: "Clear the loop", run: () => clearLoop() },
  { keys: ["v"], group: "View", label: "2D / 3D", run: () => setView(S.view === "3d" ? "2d" : "3d") },
  { keys: ["c"], group: "View", label: "3D camera: orbit → chase → padlock", when: () => S.view === "3d", run: () => cycleCam() },
  { keys: ["t"], group: "View", label: "Padlock: next target", when: () => S.view === "3d", run: () => cyclePadlock() },
  { keys: ["Shift+T"], group: "View", label: "Padlock: automatic target", when: () => S.view === "3d", run: () => setPadlock(null) },
  { keys: ["f"], group: "View", label: "Follow the selected aircraft", run: () => setFollow(!S.follow) },
  { keys: ["m"], group: "View", label: "Measuring tape (or Shift-drag)", run: () => setMeasure(map.tool !== "measure") },
  { keys: ["Escape"], group: "View", label: "Close a menu", hidden: true, when: () => !!(display?.isOpen() || sel?.menuOpen()),
    run: () => { display.close(); sel.closeMenu(); } },
  { keys: ["Escape"], group: "View", label: "Cancel measure-from", hidden: true, when: () => !!S.measureFrom,
    run: () => { S.measureFrom = null; S.tapeDraft = null; renderMapChips(); map.invalidate(); } },
  { keys: ["Escape"], group: "View", label: "Leave the weapon cam", hidden: true, when: () => !!S.weaponCam, run: () => stopWeaponCam() },
  { keys: ["Escape"], group: "View", label: "Clear tapes, leave the measure tool", when: () => S.tapes.length > 0 || !!S.tapeDraft || map.tool === "measure",
    run: () => { setMeasure(false); S.tapes = []; S.tapeDraft = null; map.cancelMeasure(); renderTapeHud(); renderMapChips(); map.invalidate(); } },
  { keys: ["Escape"], group: "Selection", label: "Leave isolate, then deselect", hidden: true, when: () => !!(S.isolate || S.selected || S.selTarget),
    run: () => {
      if (S.isolate) setIsolate(null);
      else if (S.selTarget) { S.selTarget = null; sel.set(null); }
      else select(null);
    } },
  { keys: ["Shift+a"], group: "Mode", label: "Dogfight (A-A) mode on / off", run: () => SET.toggle("a2a") },
  { keys: ["Shift+g"], group: "Mode", label: "Ground-attack (A-G) mode on / off", run: () => SET.toggle("a2g") },
  { keys: ["d"], group: "View", label: "Display options", run: () => display.toggle() },
  { keys: ["Shift+C"], group: "Panels", label: "Console (diagnostics)", run: () => openConsole() },
  { keys: ["z"], group: "View", label: "Declutter on / off", run: () => { S.declutter = !S.declutter; onDisplayChange(null); } },
  { keys: ["r"], group: "View", label: "SAM rings: all → hostile → near → off", run: () => cycleSetting("rings", ["all", "hostile", "near", "off"], "SAM rings") },
  { keys: ["b"], group: "View", label: "Bullseye: rings → calls → off", run: () => cycleSetting("bullseye", ["rings", "calls", "off"], "Bullseye") },
  { keys: ["w"], group: "Selection", label: "Weapon cam on the selected weapon", when: () => isWeapon(S.objects.get(S.selected)) || !!S.weaponCam,
    run: () => (S.weaponCam ? stopWeaponCam() : startWeaponCam(S.selected)) },
  { keys: ["j", "k"], group: "Selection", label: "Next / previous aircraft", run: (e) => stepAircraft(e.key.toLowerCase() === "j" ? 1 : -1) },
  { keys: ["e"], group: "Selection", label: "Actions for the selection (or right-click it)", when: () => !!currentTarget(), run: () => openSelectionMenu() },
  { keys: ["x"], group: "Selection", label: "Isolate the selection and what it touched", when: () => !!S.selected || !!S.isolate,
    run: () => setIsolate(S.isolate ? null : S.selected) },
  { keys: ["Shift+n", "Shift+p"], group: "Selection", label: "Next / previous event of the selection", when: () => !!S.selected,
    run: (e) => stepEvent(e.key.toLowerCase() === "n" ? 1 : -1, { only: S.selected }) },
  { keys: ["Ctrl+c"], group: "Selection", label: "Copy BRAA / coordinates of the selection", when: () => !!currentTarget() && !String(window.getSelection?.() || ""),
    run: () => copyDefault(currentTarget()) },
  { keys: ["/"], group: "Selection", label: "Filter objects", run: () => $("objFilter").focus() },
  ...TABS_KEYS(),
  { keys: ["Ctrl+o"], group: "Panels", label: "Recordings library", run: () => showLibrary() },
];

function TABS_KEYS() {
  return Array.from({ length: 8 }, (_, i) => ({
    keys: [String(i + 1)], group: "Panels", label: "Tabs, in the order shown", keysLabel: "1–8",
    hidden: i > 0, run: () => gotoTab(i + 1),
  }));
}

// -- events & loop ---------------------------------------------------------------

let stopsCache = null;
function eventStops() {
  const mine = pref("evMine", "0") === "1" && S.selected;
  const key = `${[...S.eventFilter].sort().join(",")}|${mine ? S.selected : ""}`;
  if (stopsCache?.key === key) return stopsCache.stops;
  const items = S.analysis.timeline.filter((it) => !S.eventFilter.has(it.kind) && (!mine || it.objectIds.includes(S.selected)))
    .sort((a, b) => a.time - b.time);
  const stops = [];
  for (const it of items) {
    const last = stops[stops.length - 1];
    if (last && it.time - last.items[last.items.length - 1].time <= 0.5) last.items.push(it);
    else stops.push({ time: it.time, items: [it] });
  }
  stopsCache = { key, stops };
  return stops;
}

function stepEvent(dir, { only = null } = {}) {
  if (!S.analysis) return;
  const stops = only ? objectStops(only) : eventStops();
  // Right after a step the playhead sits 3 s before that event: step from
  // the event itself.  Anywhere else, step from the playhead.
  const at = S.lastStop !== null && S.lastStop !== undefined && Math.abs(S.t - Math.max(S.start, S.lastStop - 3)) < 0.05 ? S.lastStop : S.t;
  const stop = dir > 0 ? stops.find((x) => x.time > at + 0.01) : [...stops].reverse().find((x) => x.time < at - 0.01);
  togglePlay(false);
  if (!stop) { showChip(null); return; }
  seek(stop.time - 3);
  S.lastStop = stop.time;
  showChip(stop);
}

/** Every event involving one object (the mode's event filter does not apply). */
function objectStops(id) {
  const stops = [];
  for (const it of [...S.analysis.timeline].sort((a, b) => a.time - b.time)) {
    if (!it.objectIds.includes(id)) continue;
    const last = stops[stops.length - 1];
    if (last && it.time - last.items[last.items.length - 1].time <= 0.5) last.items.push(it);
    else stops.push({ time: it.time, items: [it] });
  }
  return stops;
}

let chipTimer = null;
function showChip(stop) {
  const c = $("evChip");
  c.innerHTML = "";
  if (!stop) c.append("No more events");
  else {
    const it = stop.items[0];
    c.append(`${fmtClock(it.time - S.start)} `, el("span", { class: `k k-${it.kind}` }, it.kind), ` · ${it.text}`,
      stop.items.length > 1 ? ` · +${stop.items.length - 1} more` : "");
  }
  c.classList.remove("hidden");
  clearTimeout(chipTimer);
  chipTimer = setTimeout(hideChip, stop ? 6000 : 2000);
}
function hideChip() { clearTimeout(chipTimer); chipTimer = null; $("evChip").classList.add("hidden"); }

const MIN_LOOP = 0.5; // s: shorter loops would freeze playback
function setLoop(a, b, on) {
  const cl = (x) => (isNum(x) ? Math.max(S.start, Math.min(S.end, x)) : null);
  S.loop = { a: cl(a), b: cl(b), on: !!on };
  if (isNum(S.loop.a) && isNum(S.loop.b) && S.loop.a > S.loop.b) [S.loop.a, S.loop.b] = [S.loop.b, S.loop.a];
  if (S.loop.on && !(S.loop.b - S.loop.a >= MIN_LOOP)) S.loop.on = false;
  updateLoopBand();
}
function setLoopPoint(which) {
  if (!S.analysis) return;
  const l = { ...S.loop, [which]: S.t };
  setLoop(l.a, l.b, isNum(l.a) && isNum(l.b) && Math.abs(l.b - l.a) >= MIN_LOOP ? true : l.on);
}
function toggleLoop() {
  if (!S.analysis) return;
  if (isNum(S.loop.a) && isNum(S.loop.b)) setLoop(S.loop.a, S.loop.b, !S.loop.on);
  else setLoop(S.t - 10, S.t + 20, true);
}
function clearLoop() { setLoop(null, null, false); }

function updateLoopBand(paint) {
  const sc = $("scrub");
  let band = sc.querySelector(".loopband");
  const a = paint ? Math.min(paint.a, paint.b) : S.loop.a, b = paint ? Math.max(paint.a, paint.b) : S.loop.b;
  $("btnLoop").classList.toggle("active", S.loop.on);
  if (!S.analysis || !isNum(a) || !isNum(b)) { band?.remove(); return; }
  if (!band) { band = el("div", { class: "loopband" }); sc.append(band); }
  const span = S.end - S.start || 1;
  band.style.left = `${((a - S.start) / span) * 100}%`;
  band.style.width = `${((b - a) / span) * 100}%`;
  band.classList.toggle("on", !!paint || S.loop.on);
  band.title = `Loop ${fmtClock(a - S.start)}–${fmtClock(b - S.start)}`;
}

// -- padlock & threats -------------------------------------------------------------

function alive(o, t) {
  const d = S.deaths.get(o.id);
  if (isNum(d) && t >= d) return null;
  return sampleTrack(o.pb, t);
}

function hostileAircraftAt(t, focusId) {
  const me = S.objects.get(focusId);
  const mp = me && alive(me, t);
  if (!mp) return [];
  const out = [];
  for (const o of S.objects.values()) {
    if (!AIR.includes(o.category) || o.id === focusId || !isHostile(me, o)) continue;
    const p = alive(o, t);
    if (p && isNum(p.lon)) out.push({ id: o.id, o, p, range: slantRange(mp.lon, mp.lat, mp.alt, p.lon, p.lat, p.alt) });
  }
  return out.sort((a, b) => a.range - b.range);
}

function padlockCandidates(t, focusId) {
  const me = S.objects.get(focusId);
  const mp = me && alive(me, t);
  const list = hostileAircraftAt(t, focusId).map((x) => ({ id: x.id, range: x.range }));
  if (mp) {
    for (const sh of S.analysis.weapons.shots) {
      if (sh.targetId !== focusId || !sh.weaponId || t < sh.launchTime || t > (sh.endTime ?? sh.launchTime)) continue;
      const w = S.objects.get(sh.weaponId);
      const p = w && sampleTrack(w.pb, t);
      if (p) list.push({ id: sh.weaponId, range: slantRange(mp.lon, mp.lat, mp.alt, p.lon, p.lat, p.alt) });
    }
  }
  return list.sort((a, b) => a.range - b.range);
}

function padlockTarget() {
  if (!S.analysis) return null;
  const focus = S.selected || S.me;
  const pinned = S.padlockId && S.objects.get(S.padlockId);
  if (pinned && pinned.id !== focus && alive(pinned, S.t)) return pinned.id;
  const lock = activeLocks(S.t).get(focus);
  if (lock && S.objects.get(lock) && alive(S.objects.get(lock), S.t)) return lock;
  return hostileAircraftAt(S.t, focus)[0]?.id || null;
}

function setPadlock(id) {
  S.padlockId = id;
  if (id && S.view === "3d" && S.cam !== "padlock") setCam("padlock");
  onTimeChange(true);
}

function cyclePadlock() {
  const list = padlockCandidates(S.t, S.selected || S.me);
  if (!list.length) return;
  const cur = padlockTarget();
  const i = list.findIndex((x) => x.id === cur);
  setPadlock(list[(i + 1) % list.length].id);
}

/** Threats to the focus aircraft at t, for the off-screen pointers. */
function threatsAt(t, focusId) {
  if (!S.analysis || !focusId) return [];
  const me = S.objects.get(focusId);
  const mp = me && alive(me, t);
  if (!mp) return [];
  const out = [];
  const rangeTo = (o, tt) => {
    const a = sampleTrack(me.pb, tt), b = sampleTrack(o.pb, tt);
    return a && b ? slantRange(a.lon, a.lat, a.alt, b.lon, b.lat, b.alt) : null;
  };
  for (const sh of S.analysis.weapons.shots) {
    if (sh.targetId !== focusId || !sh.weaponId || t < sh.launchTime || t > (sh.endTime ?? sh.launchTime)) continue;
    const w = S.objects.get(sh.weaponId);
    const p = w && sampleTrack(w.pb, t);
    if (!p) continue;
    const r = rangeTo(w, t), r0 = rangeTo(w, t - 0.5), r1 = rangeTo(w, t + 0.5);
    const closure = isNum(r0) && isNum(r1) ? r0 - r1 : null;
    const tti = isNum(closure) && closure > 1 ? r / closure : null;
    out.push({ id: w.id, lon: p.lon, lat: p.lat, color: "#ff3b3b", level: 3,
      text: `${sh.weaponName} ${fmtDist(r)}${isNum(tti) ? ` ${Math.round(tti)}s` : ""}` });
  }
  const spikes = new Set();
  for (const [owner, target] of activeLocks(t)) {
    if (target !== focusId) continue;
    const o = S.objects.get(owner);
    const p = o && alive(o, t);
    if (!p) continue;
    spikes.add(owner);
    out.push({ id: owner, lon: p.lon, lat: p.lat, color: "#ff9f43", level: 2,
      text: `${o.pilot || o.name} SPIKE ${fmtDist(distance(mp.lon, mp.lat, p.lon, p.lat))}` });
  }
  for (const h of hostileAircraftAt(t, focusId)) {
    if (spikes.has(h.id) || h.range > 60000 || !isNum(h.p.hdg)) continue;
    if (aspectDeg(h.p.lon, h.p.lat, h.p.hdg, mp.lon, mp.lat) < 135) continue;
    out.push({ id: h.id, lon: h.p.lon, lat: h.p.lat, color: "#ffd166", level: 1,
      text: `${h.o.name} HOT ${fmtDist(distance(mp.lon, mp.lat, h.p.lon, h.p.lat))}` });
  }
  return out;
}

// -- measuring tape ------------------------------------------------------------------

function setMeasure(on) {
  map.tool = on ? "measure" : null;
  $("btnMeasure").classList.toggle("active", on);
  $("map").classList.toggle("measuring", on);
}

function snapAt(px, py) {
  const h = hitAt(px, py);
  return h ? snapEnd(h) : null;
}

function addTape(t) {
  const used = new Set(S.tapes.map((x) => x.color));
  if (S.tapes.length >= 3) { used.delete(S.tapes[0].color); S.tapes.shift(); }
  t.color = TAPE_COLORS.find((c) => !used.has(c)) || TAPE_COLORS[0];
  S.tapes.push(t);
  renderTapeHud();
  map.invalidate();
}

/** Resolve a tape end at t: {lon, lat, alt, obj, present}. */
function tapeEnd(end, t) {
  if (end.lonlat) return { lon: end.lonlat[0], lat: end.lonlat[1], alt: null, obj: null, present: true };
  const o = S.objects.get(end.id);
  if (!o) return null;
  const p = alive(o, t);
  if (p) return { ...p, obj: o, present: true };
  const n = o.pb.t.length;
  const q = sampleTrack(o.pb, Math.max(o.pb.t[0], Math.min(o.pb.end ?? o.pb.t[n - 1], t)));
  return q ? { ...q, obj: o, present: false } : null;
}

function tapeLabel(tape, t) {
  const A = tapeEnd(tape.a, t), B = tapeEnd(tape.b, t);
  if (!A || !B) return null;
  const brg = bearing(A.lon, A.lat, B.lon, B.lat);
  const d = distance(A.lon, A.lat, B.lon, B.lat);
  if (!A.present || !B.present) return { A, B, lines: ["—"], short: "—", stale: true };
  if (A.obj && B.obj) {
    const slant = slantRange(A.lon, A.lat, A.alt, B.lon, B.lat, B.alt);
    const at = (tt) => { const a = tapeEnd(tape.a, tt), b = tapeEnd(tape.b, tt); return a && b && a.present && b.present ? slantRange(a.lon, a.lat, a.alt, b.lon, b.lat, b.alt) : null; };
    const r0 = at(t - 0.5), r1 = at(t + 0.5);
    const closure = isNum(r0) && isNum(r1) ? r0 - r1 : null;
    const dAlt = isNum(A.alt) && isNum(B.alt) ? B.alt - A.alt : null;
    const nameA = A.obj.pilot || A.obj.name, nameB = B.obj.pilot || B.obj.name;
    const l2 = [`${fmtDist(slant, { precise: true })} slant`];
    if (isNum(dAlt)) l2.push(`Δ${dAlt >= 0 ? "+" : "−"}${fmtAlt(Math.abs(dAlt))}`);
    if (isNum(closure)) l2.push(`C ${closure >= 0 ? "+" : "−"}${fmtSpeed(Math.abs(closure))}`);
    return { A, B, lines: [`${nameA} → ${nameB} ${fmtHdg(brg)}`, l2.join(" · ")], short: `${nameA} → ${nameB} ${fmtDist(slant)}` };
  }
  if (A.obj || B.obj) {
    const O = A.obj ? A : B, P = A.obj ? B : A;
    const b2 = bearing(O.lon, O.lat, P.lon, P.lat);
    const name = O.obj.pilot || O.obj.name;
    const txt = `${name} → BRG ${fmtHdg(b2)} · ${fmtDist(d, { precise: true })}`;
    return { A, B, lines: [txt], short: txt };
  }
  const sel = S.selected && S.objects.get(S.selected);
  let eta = "";
  if (sel) {
    const p0 = sampleTrack(sel.pb, t - 0.5), p1 = sampleTrack(sel.pb, t + 0.5);
    const gs = p0 && p1 ? distance(p0.lon, p0.lat, p1.lon, p1.lat) : null;
    if (isNum(gs) && gs > 20) eta = ` · ${fmtClock(d / gs)} @ ${fmtSpeed(gs)}`;
  }
  const txt = `BRG ${fmtHdg(brg)} / ${fmtHdg(brg + 180)} · ${fmtDist(d, { precise: true })}`;
  return { A, B, lines: [txt + eta], short: txt };
}

function drawTapes(ctx, m) {
  const all = S.tapeDraft ? [...S.tapes, { ...S.tapeDraft, color: "#ffffff" }] : S.tapes;
  for (const tape of all) {
    const L = tapeLabel(tape, S.t);
    if (!L) continue;
    const a = m.project(L.A.lon, L.A.lat), b = m.project(L.B.lon, L.B.lat);
    ctx.save();
    ctx.strokeStyle = L.stale ? "rgba(160,160,160,0.8)" : tape.color;
    ctx.lineWidth = 1.5;
    if (L.stale) ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.setLineDash([]);
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]) + Math.PI / 2;
    for (const [x, y] of [a, b]) {
      ctx.beginPath(); ctx.moveTo(x - Math.cos(ang) * 5, y - Math.sin(ang) * 5); ctx.lineTo(x + Math.cos(ang) * 5, y + Math.sin(ang) * 5); ctx.stroke();
    }
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    const w = Math.max(...L.lines.map((l) => ctx.measureText(l).width)) + 12;
    const h = L.lines.length * 14 + 6;
    const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
    ctx.fillStyle = "rgba(8,12,17,0.85)";
    ctx.strokeStyle = L.stale ? "rgba(160,160,160,0.8)" : tape.color;
    ctx.lineWidth = 1;
    ctx.fillRect(mx - w / 2, my - h - 6, w, h);
    ctx.strokeRect(mx - w / 2, my - h - 6, w, h);
    ctx.fillStyle = L.stale ? "#aaa" : tape.color;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    L.lines.forEach((l, i) => ctx.fillText(l, mx, my - h - 3 + i * 14));
    ctx.restore();
  }
}

function tapeNear(px, py) {
  for (let i = S.tapes.length - 1; i >= 0; i--) {
    const L = tapeLabel(S.tapes[i], S.t);
    if (!L) continue;
    const [ax, ay] = map.project(L.A.lon, L.A.lat), [bx, by] = map.project(L.B.lon, L.B.lat);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
    const f = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    if (Math.hypot(ax + dx * f - px, ay + dy * f - py) <= 6) return i;
  }
  return -1;
}

function renderTapeHud() {
  const hud = $("tapeHud");
  hud.classList.toggle("hidden", !S.tapes.length);
  const rows = [...hud.querySelectorAll(".row")];
  // Rebuild only when the set of tapes changed, so the × buttons are not
  // replaced mid-click while the labels update during playback.
  if (rows.length !== S.tapes.length || rows.some((r, i) => r._tape !== S.tapes[i])) {
    hud.innerHTML = "";
    for (const tape of S.tapes) {
      const row = el("div", { class: "row" }, el("span", { class: "sw", style: { background: tape.color } }),
        el("span", { class: "txt" }),
        el("button", { class: "ghost", title: "Delete this tape", onclick: () => {
          const i = S.tapes.indexOf(tape);
          if (i >= 0) S.tapes.splice(i, 1);
          renderTapeHud(); map.invalidate();
        } }, "×"));
      row._tape = tape;
      hud.append(row);
    }
  }
  for (const row of hud.querySelectorAll(".row")) {
    const L = S.analysis ? tapeLabel(row._tape, S.t) : null;
    const txt = L?.short || "tape";
    const span = row.querySelector(".txt");
    if (span.textContent !== txt) span.textContent = txt;
  }
}

// -- trail colours ------------------------------------------------------------------------

const TRAIL_MODES = {
  side: null,
  alt: { title: "Altitude", kind: "seq" },
  speed: { title: "Speed", kind: "seq" },
  g: { title: "G", kind: "limit", lo: 0, hi: 9, limit: 7.5, channel: "GLoad" },
  ps: { title: "Ps", kind: "div", lo: -60, hi: 60, limit: 3, channel: "Ps" },
  aoa: { title: "AOA", kind: "limit", lo: 0, hi: 25, limit: 20, channel: "AOA" },
  // Afterburner from recorded engine data (0 = not recorded, 1 = dry or no AB, 2 = lit).
  heat: { title: "Heat", kind: "cat", lo: 0, hi: 2 },
};
// [r, g, b] 0..1 like rampColor(): not recorded (grey, never the side colour), dry, lit.
const HEAT_TRAIL = [[0.42, 0.46, 0.52], [0.85, 0.57, 0.23], [1, 0.945, 0.66]];
const rgbCss = (c) => `rgb(${c.map((v) => Math.round(v * 255)).join(",")})`;
const trailCache = new Map();
const trailRanges = new Map();

function setTrailColor(mode) {
  const m = TRAIL_MODES[mode] !== undefined ? mode : "side";
  if (S.trailColor !== m) S.trailColor = m;
  if (TRAIL_MODES[S.trailColor]?.channel && S.analysis) fetchTrailSeries();
  updateLegend();
  onTimeChange(true);
}

async function fetchTrailSeries() {
  const key = S.key;
  const ids = [...S.objects.values()].filter((o) => AIR.includes(o.category) && !S.trailSeries.has(o.id)).map((o) => o.id);
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++];
      S.trailSeries.set(id, null); // in flight
      try {
        const { body, status } = await api(`/api/recording/${key}/series/${encodeURIComponent(id)}?channels=GLoad,Ps,AOA&max=4000`);
        if (key !== S.key) return;
        if (status === 200) S.trailSeries.set(id, body);
        for (const m of ["g", "ps", "aoa"]) trailCache.delete(`${id}:${m}`);
        map.invalidate(); onTimeChange(true);
      } catch { S.trailSeries.delete(id); }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
}

/** Per-sample values for an object's playback track in a trail-colour mode. */
function valuesFor(o, mode) {
  const ck = `${o.id}:${mode}`;
  if (trailCache.has(ck)) return trailCache.get(ck);
  const pb = o.pb, n = pb.t.length;
  let out = null;
  if (mode === "alt") out = Float32Array.from(pb.alt || [], (v) => (isNum(v) ? v : NaN));
  else if (mode === "heat") {
    const h = S.analysis?.ir?.heat?.[o.id];
    out = Float32Array.from(pb.t, (t) => { const lit = abAt(h, t); return lit === null ? 0 : lit ? 2 : 1; });
  }
  else if (mode === "speed") {
    out = new Float32Array(n).fill(NaN);
    for (let k = 1; k < n; k++) {
      const dt = pb.t[k] - pb.t[k - 1];
      if (dt <= 0 || !isNum(pb.lon[k]) || !isNum(pb.lon[k - 1])) continue;
      out[k] = slantRange(pb.lon[k - 1], pb.lat[k - 1], pb.alt?.[k - 1], pb.lon[k], pb.lat[k], pb.alt?.[k]) / dt;
    }
    if (n > 1) out[0] = out[1];
  } else {
    const ser = S.trailSeries.get(o.id);
    const ch = ser?.channels?.[TRAIL_MODES[mode].channel];
    if (!ch) return null; // loading, or no such channel: side colour
    out = new Float32Array(n).fill(NaN);
    for (let k = 0; k < n; k++) {
      const j = bisectRight(ser.t, pb.t[k]);
      if (j >= 0 && isNum(ch[j])) out[k] = ch[j];
    }
  }
  trailCache.set(ck, out);
  return out;
}

function trailRange(mode) {
  const def = TRAIL_MODES[mode];
  if (isNum(def.lo)) return [def.lo, def.hi];
  if (trailRanges.has(mode)) return trailRanges.get(mode);
  const vals = [];
  for (const o of S.objects.values()) {
    if (!AIR.includes(o.category)) continue;
    const v = valuesFor(o, mode);
    if (v) for (const x of v) if (isNum(x)) vals.push(x);
  }
  vals.sort((a, b) => a - b);
  let r = [0, 1];
  if (vals.length) r = mode === "speed" ? [vals[Math.floor(vals.length * 0.02)], vals[Math.floor(vals.length * 0.98)]] : [vals[0], vals[vals.length - 1]];
  trailRanges.set(mode, r);
  return r;
}

function trailColorAt(vals, k, mode, range) {
  const def = TRAIL_MODES[mode];
  if (def.kind === "cat") return HEAT_TRAIL[vals[k]] || HEAT_TRAIL[0];
  return rampColor(vals[k], range[0], range[1], def.kind, def.limit);
}

function updateLegend() {
  const box = $("trailLegend");
  const def = TRAIL_MODES[S.trailColor];
  box.innerHTML = "";
  S.legendHeat = !!S.lobesDrawn;
  if (S.analysis && S.legendHeat) {
    box.append(el("div", { title: HEAT_NOTE }, "Heat (DCS IR, Su-27 dry = 1) · tail ×1.5 · beam ×1 · nose ×0.5"),
      el("div", { class: "faint" }, "dotted = if in afterburner (not recorded)"),
      el("div", { class: "legend-bar", style: { background: HEAT_CSS } }),
      el("div", { class: "legend-ends" }, el("span", {}, "⅛"), el("span", {}, "1"), el("span", {}, "8")));
  }
  if (def?.kind === "cat" && S.analysis) {
    box.append(el("div", { class: "legend-cats" }, ...[["AB lit", 2], ["dry / no AB", 1], ["not recorded", 0]].map(([label, v]) =>
      el("span", {}, el("i", { style: { background: rgbCss(HEAT_TRAIL[v]) } }), label))));
  }
  if (!def || !S.analysis || def.kind === "cat") { box.classList.toggle("hidden", !box.childElementCount); return; }
  const [lo, hi] = trailRange(S.trailColor);
  const ends = {
    alt: [fmtAlt(lo, { suffix: false }), fmtAlt(hi)],
    speed: [fmtSpeed(lo, { suffix: false }), fmtSpeed(hi)],
    g: ["0", "9 g"],
    ps: units.metric ? ["−60", "+60 m/s"] : ["−200", "+200 ft/s"],
    aoa: ["0°", "25°"],
  }[S.trailColor];
  const note = { g: " (magenta > 7.5)", aoa: " (magenta > 20°)", ps: " (grey = sustaining)" }[S.trailColor] || "";
  box.append(el("div", {}, `${def.title} ${ends[0]} ${S.trailColor === "ps" ? "…" : "–"} ${ends[1]}${note}`),
    el("div", { class: "legend-bar", style: { background: rampCss(def.kind, {
      limitFrac: isNum(def.limit) && isNum(def.lo) ? (def.limit - def.lo) / (def.hi - def.lo) : 0.85,
      deadFrac: def.kind === "div" ? def.limit / Math.max(Math.abs(def.lo), Math.abs(def.hi)) : 0.05,
    }) } }),
    el("div", { class: "legend-ends" }, el("span", {}, ends[0]), el("span", {}, ends[1])));
  box.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Map scene
// ---------------------------------------------------------------------------

function activeLocks(t) {
  const out = new Map();
  for (const ep of S.analysis.radar.locks) {
    if (ep.targetId && ep.start <= t && t <= ep.end) out.set(ep.ownerId, ep.targetId);
  }
  return out;
}

/** Hostile SAM / AAA / armed ship: has an engagement ring. */
const isThreatUnit = (o) => ["ground", "sea"].includes(o.category) && isNum(o.pb?.eng);

/**
 * Does the display (filters, mode, hidden list) show this object?  The
 * selection, the padlock target, tape ends and missiles at "me" are always
 * shown, whatever the mode says (a filtered map must never hide a threat).
 */
function shown(o, t) {
  if (o.id === S.selected || o.id === S.padlockId || S.pinned.has(o.id)) return true;
  if (S.tapes.some((tp) => tp.a.id === o.id || tp.b.id === o.id)) return true;
  if (S.hidden.has(o.id)) return false;
  // No filter or mode hides a missile guided at me.
  if (o.category === "weapon" && !o.dispenser && atMe(o, t)) return true;
  // Flares and chaff follow the side of the jet that dropped them (unknown: neutral).
  const owner = o.category === "countermeasure" && o.cmOwner ? S.objects.get(o.cmOwner) : null;
  const c = ((owner || o).coalition || "").toLowerCase();
  const side = c.includes("allies") || c.includes("blue") ? "blue" : c.includes("enem") || c.includes("red") ? "red" : "neutral";
  if (!cfg(side)) return false;
  const cat = o.category;
  if (cat === "weapon") {
    if (o.dispenser) return cfg("bomblets") !== "hide";
    const w = cfg("weapons");
    if (w === "none") return false;
    const ag = S.strikeIds.has(o.id);
    if (w === "a2a" && ag) return false;
    if (w === "a2g" && !ag) return false;
    return true;
  }
  if (cat === "countermeasure") return cfg("cm") === "show" || (cfg("cm") === "flares" && o.cmKind !== "chaff");
  if (AIR.includes(cat)) return cfg("air") !== "hide";
  if (["ground", "sea"].includes(cat) || cat === "misc" || cat === "navaid") {
    const g = cfg("ground");
    if (g === "hide") return false;
    if (g === "threats") return isThreatUnit(o);
  }
  return true;
}

/** Is this weapon a missile shot at "me" (or the selected jet)?  A hostile missile with no known target counts too. */
function atMe(o, t) {
  const focus = S.selected || S.me;
  const me = S.objects.get(S.me);
  return S.analysis.weapons.shots.some((sh) => sh.weaponId === o.id && t <= (sh.endTime ?? sh.launchTime) + 1 &&
    (sh.targetId ? sh.targetId === focus || sh.targetId === S.me : !S.strikeIds.has(o.id) && !!me && isHostile(me, o)));
}

/** Ids related to an object: its weapons and their targets, who shot at it, its group. */
function relatedIds(id) {
  const o = S.objects.get(id);
  const ids = new Set([id]);
  if (!o) return ids;
  const w = S.analysis.weapons;
  for (const sh of w.shots) {
    if (sh.launcherId === id || sh.weaponId === id || sh.targetId === id) {
      [sh.launcherId, sh.weaponId, sh.targetId].forEach((x) => x && ids.add(x));
    }
  }
  for (const b of w.bursts) {
    if (b.launcherId === id || b.targetId === id) [b.launcherId, b.targetId].forEach((x) => x && ids.add(x));
  }
  for (const k of w.kills) if (k.killerId === id || k.victimId === id) [k.killerId, k.victimId, k.weaponId].forEach((x) => x && ids.add(x));
  for (const p of S.strikes) {
    const x = p.s;
    const hit = (x.damage || []).some((d) => d.id === id);
    if (x.launcherId === id || x.weaponId === id || x.targetId === id || hit) {
      [x.launcherId, x.weaponId, x.targetId].forEach((v) => v && ids.add(v));
      (x.damage || []).forEach((d) => ids.add(d.id));
      (S.analysis.weapons.submunitions?.[x.weaponId] || []).forEach((b) => ids.add(b));
    }
  }
  for (const ep of S.analysis.radar.locks) if (ep.ownerId === id || ep.targetId === id) [ep.ownerId, ep.targetId].forEach((x) => x && ids.add(x));
  if (o.group) for (const x of S.objects.values()) if (x.group === o.group && x.coalition === o.coalition) ids.add(x.id);
  return ids;
}

function setIsolate(id) {
  S.isolate = id ? { id, ids: relatedIds(id) } : null;
  renderMapChips();
  renderObjectList();
  onTimeChange(true);
}

/** Labels for hostile ground units near a strike (label mode "targets"). */
let targetIdsCache = null;
function strikeTargetIds() {
  if (targetIdsCache?.key === S.key) return targetIdsCache.ids;
  const ids = new Set();
  for (const p of S.strikes) {
    if (p.s.targetId) ids.add(p.s.targetId);
    (p.s.damage || []).forEach((d) => ids.add(d.id));
  }
  for (const x of S.analysis?.targets || []) ids.add(x.id);
  targetIdsCache = { key: S.key, ids };
  return ids;
}

/**
 * Aircraft that get a heat lobe now: Map id -> true when it is the target of
 * an IR missile in flight (its heat label shows too).
 */
function heatLobeIds(t) {
  const out = new Map();
  const mode = cfg("irHeat");
  if (mode === "off" || !S.ir) return out;
  for (const x of irInFlight(S.ir, t)) if (x.target) out.set(x.target.id, true);
  if (mode === "all") {
    for (const o of S.objects.values()) if (AIR.includes(o.category) && !out.has(o.id)) out.set(o.id, false);
    return out;
  }
  if (S.selected && AIR.includes(S.objects.get(S.selected)?.category) && !out.has(S.selected)) out.set(S.selected, false);
  if (mode === "focus" && S.me && !out.has(S.me)) out.set(S.me, false);
  return out;
}

/** Does the IR-seeker setting show this IR shot? */
function seekerShown(x) {
  const mode = cfg("irSeeker");
  if (mode === "all") return true;
  if (mode === "off") return false;
  const sh = x.s;
  return [sh.weaponId, sh.launcherId, sh.targetId].includes(S.selected) || (!!S.me && sh.targetId === S.me);
}

/** Engine heat for the 3D plumes: the jets that have a heat lobe on the map. */
function heat3d() {
  if (!S.ir) return null;
  const ids = heatLobeIds(S.t);
  return (id) => (ids.has(id) ? heatNow(S.ir.heat[id], S.t) : null);
}

/** The reach estimate's fallback seeker (DCS AIM_9: SeekerSensivityDistance 20 km). */
const REF_SEEKER = { key: "AIM_9", short: "AIM-9M", ssd: 20000 };

/** Heat lobes, IR seekers and the seeker-reach estimate (the IR overlay). */
function drawIR(ctx, m, objs, phase) {
  if (!S.ir) return;
  const scale = { s: 0.9, m: 1, l: 1.25, xl: 1.5 }[cfg("labelSize")] || 1;
  const byId = new Map(objs.map((o) => [o.id, o]));
  if (phase === "under") {
    const ids = heatLobeIds(S.t);
    const small = cfg("irHeat") === "all" ? (o) => o.id !== S.selected && !ids.get(o.id) : null;
    S.lobesDrawn = ids.size ? drawHeatLobes(ctx, m, objs.filter((o) => ids.has(o.id) && (!S.isolate || S.isolate.ids.has(o.id))), S.t, S.ir.heat, { scale, small }) : 0;
    if (!!S.lobesDrawn !== !!S.legendHeat) updateLegend();
    return;
  }
  const list = irInFlight(S.ir, S.t).filter((x) => seekerShown(x) && byId.has(x.s.weaponId));
  if (list.length) {
    if (!S.ir.flareObjs) S.ir.flareObjs = [...S.objects.values()].filter((o) => o.category === "countermeasure" && o.cmKind !== "chaff");
    // Only flares on the map: hidden ones (filters, Z) get no ring either.
    const flares = S.ir.flareObjs.filter((f) => byId.has(f.id) && f.pb.t[0] <= S.t && S.t <= (f.pb.end ?? f.pb.t[f.pb.t.length - 1]));
    const sel = S.selected;
    drawSeekers(ctx, m, list, S.t, {
      labelScale: scale, flares,
      detail: (x) => list.length <= 2 || [x.s.weaponId, x.s.launcherId, x.s.targetId].includes(sel),
      alphaOf: S.isolate ? (id) => isoAlpha(id) : null,
    });
  }
  if (cfg("irReach")) {
    const items = [], done = new Set();
    for (const x of list) {
      const o = x.target && byId.get(x.target.id);
      if (!o || done.has(o.id)) continue;
      done.add(o.id);
      items.push({ target: o, sk: x.sk, hn: heatNow(S.ir.heat[o.id], S.t) });
    }
    // The selected jet, against the IR missile its enemies fired most in this recording (else an AIM-9M).
    const so = byId.get(S.selected);
    if (so && AIR.includes(so.category) && !done.has(so.id)) {
      const counts = new Map();
      for (const x of S.ir.shots) {
        const l = x.s.launcherId && S.objects.get(x.s.launcherId);
        if (l && isHostile(l, so)) counts.set(x.sk.key, (counts.get(x.sk.key) || 0) + 1);
      }
      const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      const sk = best ? S.ir.shots.find((x) => x.sk.key === best[0]).sk : REF_SEEKER;
      items.push({ target: so, sk, hn: heatNow(S.ir.heat[so.id], S.t),
        label: best ? `against the ${sk.short || sk.key} its enemies fired` : "no IR shots at it here: AIM-9M as reference" });
    }
    if (items.length) drawReach(ctx, m, items, { labelScale: scale });
  }
}

function sceneObjects() {
  if (!S.analysis) return [];
  const t = S.t;
  const locks = activeLocks(t);
  const out = [];
  const meP = S.me && S.objects.get(S.me) ? alive(S.objects.get(S.me), t) : null;
  const braaOn = cfg("braa") && meP;
  const bullsCalls = cfg("bullseye") === "calls" && S.analysis.bullseye;
  const deadMode = cfg("dead");
  const targets = cfg("labels") === "targets" ? strikeTargetIds() : null;
  const heatIds = heatLobeIds(t);
  for (const o of S.objects.values()) {
    const p = sampleTrack(o.pb, t);
    if (!p || !isNum(p.lon)) continue;
    const death = S.deaths.get(o.id);
    const dead = isNum(death) && t >= death;
    if (dead && ["fixedwing", "rotorcraft", "air"].includes(o.category) && t > death + 2) continue;
    const keep = o.id === S.selected || S.pinned.has(o.id) || S.tapes.some((tp) => tp.a.id === o.id || tp.b.id === o.id);
    if (dead && deadMode === "hide" && !keep) continue;
    if (dead && deadMode === "fade" && t > death + 60 && !keep) continue;
    if (!shown(o, t)) continue;
    const row = { ...o, lon: p.lon, lat: p.lat, alt: p.alt, hdg: p.hdg, pitch: p.pitch, roll: p.roll, dead, v: {} };
    if (targets && targets.has(o.id)) row.labelMe = true;
    if (o.category === "countermeasure") {
      // DCS writes no owner on flares: coloured by the jet it came from (inferred), fading over its life.
      row.cmColor = flareColor(o.cmOwner ? S.objects.get(o.cmOwner) : null);
      row.age = t - o.pb.t[0];
      row.name = o.cmKind === "chaff" ? "chaff" : "flare"; // DCS gives them no name
      if (o.cmKind !== "chaff") {
        // A short smoke tail from its own recorded track.
        const pb = o.pb, tail = [];
        for (let k = Math.max(0, bisectRight(pb.t, t - 1.5)); k < pb.t.length && pb.t[k] <= t; k++) if (isNum(pb.lon[k])) tail.push([pb.lon[k], pb.lat[k]]);
        tail.push([p.lon, p.lat]);
        if (tail.length > 1) row.cmTail = tail;
      }
    }
    if (heatIds.has(o.id) && !dead) {
      const txt = heatText(heatNow(S.analysis.ir?.heat?.[o.id], t));
      if (txt) row.tag2 = txt; // every jet with a lobe gets its number
    }
    if (o.category === "weapon") {
      const irName = S.irNames?.get(o.id);
      row.name = irName ? `${irName} · IR` : weaponLabel(o.name);
      if (irName) row.irSeeker = true;
      // The strike overlay tags weapons in flight ("AGM-154A → target · 0:42"): no second label.
      if (S.strikeIds.has(o.id) && cfg("strikeTti")) row.noLabel = true;
    }
    if (AIR.includes(o.category) && !dead && o.id !== S.me && isHostile(S.objects.get(S.me), o)) {
      const bits = [];
      if (braaOn) {
        const asp = isNum(p.hdg) ? aspectDeg(p.lon, p.lat, p.hdg, meP.lon, meP.lat) : null;
        const hc = isNum(asp) ? (asp >= 135 ? "HOT" : asp <= 45 ? "COLD" : "FLANK") : "";
        bits.push(`BRAA ${braa(meP.lon, meP.lat, p.lon, p.lat, p.alt)} ${hc}`.trim());
      }
      if (bullsCalls) bits.push(`BULLS ${braa(S.analysis.bullseye.longitude, S.analysis.bullseye.latitude, p.lon, p.lat, p.alt)}`);
      if (bits.length) row.tag = bits.join(" · ");
    }
    // Ground speed from the playback track, for labels.
    const i = p.i, pb = o.pb;
    if (i > 0 && pb.t[i] > pb.t[i - 1]) {
      row.tas = distance(pb.lon[i - 1], pb.lat[i - 1], pb.lon[i], pb.lat[i]) / (pb.t[i] - pb.t[i - 1]);
    }
    if (isNum(pb.eng)) { row.v.EngagementRange = pb.eng; row.engSrc = pb.engSrc; }
    if (isNum(pb.engV)) row.v.VerticalEngagementRange = pb.engV;
    if (locks.has(o.id)) row.lock = locks.get(o.id);
    if (S.trailSec > 0 && ["fixedwing", "rotorcraft", "air", "weapon"].includes(o.category)) {
      const t0 = t - S.trailSec;
      const a = Math.max(0, bisectRight(pb.t, t0));
      const trail = [];
      const mode = AIR.includes(o.category) && TRAIL_MODES[S.trailColor] ? S.trailColor : null;
      const vals = mode ? valuesFor(o, mode) : null;
      const range = vals ? trailRange(mode) : null;
      const colors = vals ? [] : null;
      for (let k = a; k <= i; k++) {
        if (!isNum(pb.lon[k])) continue;
        trail.push([pb.lon[k], pb.lat[k], pb.alt?.[k]]);
        if (colors) colors.push(trailColorAt(vals, k, mode, range));
      }
      trail.push([p.lon, p.lat, p.alt]);
      if (colors) colors.push(trailColorAt(vals, Math.max(0, i), mode, range));
      row.trail = trail;
      if (colors) row.trailColors = colors;
    }
    const rad = S.radar !== "none" || S.pinned.has(o.id) ? radarAt(pb, i, t) : null;
    if (rad) Object.assign(row.v, rad);
    else if (o.id === S.selected) {
      const ser = S.series.get(o.id);
      if (ser) {
        const j = bisectRight(ser.t, t);
        for (const k of ["RadarMode", "RadarAzimuth", "RadarRange", "RadarHorizontalBeamwidth"]) {
          const c = ser.channels[k];
          if (c && j >= 0) row.v[k] = c[j];
        }
      }
    }
    out.push(row);
  }
  return out;
}

function currentRounds() {
  return roundsAt(S.rounds, S.t, { mode: S.bullets, maxLife: S.roundLife });
}

/** Engagement ring filter for the "rings" setting. */
function ringFilter(o) {
  if (S.pinned.has(o.id)) return true;
  const mode = cfg("rings");
  if (mode === "off") return false;
  if (mode === "all") return true;
  const focus = S.objects.get(S.selected) && AIR.includes(S.objects.get(S.selected).category) ? S.selected : S.me;
  const me = S.objects.get(focus);
  if (!isHostile(me, o) && me) return false;
  if (mode === "hostile") return true;
  // "near": only while the jet is within 1.5x the ring (or has no position).
  const mp = me && alive(me, S.t);
  const r = o.v?.EngagementRange;
  return !mp || !isNum(r) || distance(mp.lon, mp.lat, o.lon, o.lat) <= r * 1.5;
}

const isoAlpha = (id) => (!S.isolate || S.isolate.ids.has(id) ? 1 : 0.15);

let hitboxes = [];
function drawMap(ctx, m) {
  const objs = sceneObjects();
  map.gridOverlay = cfg("grid");
  drawIR(ctx, m, objs, "under");
  hitboxes = drawScene(ctx, m, objs, {
    selectedId: S.selected, focusId: S.me, labels: S.labels, showTrails: S.trailSec > 0, showRadar: S.radar,
    rounds: currentRounds(), ringFilter, lockLines: cfg("lockLines"), vectors: cfg("vectors"),
    bullseye: cfg("bullseye") !== "off", alphaOf: S.isolate ? (o) => isoAlpha(o.id) : null,
    labelScale: { s: 0.9, m: 1, l: 1.25, xl: 1.5 }[cfg("labelSize")] || 1,
  });
  if (S.strikes.length && S.analysis) {
    const hits = drawStrikes(ctx, m, S.strikes, S.t, {
      layers: strikeLayers(), selectedId: S.selected, objects: S.objects, target: S.target,
      labels: cfg("strikeLabels"),
      // Hidden weapons, coalition and weapon filters apply to their strike marks too.
      alphaOf: (id) => { const o = S.objects.get(id); return o && !shown(o, S.t) ? 0 : isoAlpha(id); },
    });
    // Objects win over strike marks at the same spot (they come first).
    hitboxes = hitboxes.concat(hits);
  }
  drawIR(ctx, m, objs, "over");
  // Pinned objects keep their radar cone whatever the radar setting says.
  if (S.pinned.size && S.radar !== "all") {
    for (const o of objs) if (S.pinned.has(o.id) && o.id !== S.selected) drawRadar(ctx, m, o, { assumed: true });
  }
  if (S.target) drawTargetMark(ctx, m, S.target);
  if (cfg("exposure")) drawExposure(ctx, m);
  const pointers = cfg("pointers");
  if (S.analysis && pointers !== "off" && (S.follow || pointers === "always")) {
    const focus = S.selected && AIR.includes(S.objects.get(S.selected)?.category) ? S.selected : S.me;
    const me = objs.find((o) => o.id === focus);
    const from = me ? m.project(me.lon, me.lat) : [m.w / 2, m.h / 2];
    // Keep the arrows clear of the map tools column on the right and the HUD column on the left.
    const tools = document.querySelector(".map-tools")?.getBoundingClientRect();
    drawEdgePointers(ctx, m, from, threatsAt(S.t, focus), { top: 48, right: tools ? tools.width + 22 : 22, bottom: 40, left: 22 });
  }
  if (S.measureFrom && S.hoverLonLat) {
    S.tapeDraft = { a: S.measureFrom, b: { lonlat: S.hoverLonLat } };
  }
  if (S.tapes.length || S.tapeDraft) drawTapes(ctx, m);
  if (S.tapes.length && Math.abs((S._tapeHudT ?? -1e9) - S.t) > 0.5) { S._tapeHudT = S.t; renderTapeHud(); }
}

/**
 * Where a jet flew inside a hostile SAM / AAA envelope (horizontal range
 * within the ring, height above the site within its vertical range):
 * [{t0, t1, site}] per aircraft, computed once per recording.
 */
const exposureCache = new Map();
function exposure(id) {
  const key = `${S.key}|${id}`;
  if (exposureCache.has(key)) return exposureCache.get(key);
  const jet = S.objects.get(id);
  const out = [];
  if (jet) {
    const sites = [...S.objects.values()].filter((o) => isThreatUnit(o) && isHostile(jet, o));
    const pb = jet.pb;
    let cur = null;
    for (let i = 0; i < pb.t.length; i++) {
      const t = pb.t[i];
      if (!isNum(pb.lon[i])) continue;
      let inside = null;
      for (const o of sites) {
        const d = S.deaths.get(o.id);
        if (isNum(d) && t >= d) continue;
        const q = sampleTrack(o.pb, t);
        if (!q) continue;
        const up = isNum(pb.alt?.[i]) && isNum(q.alt) ? pb.alt[i] - q.alt : 0;
        if (distance(q.lon, q.lat, pb.lon[i], pb.lat[i]) <= o.pb.eng && (!isNum(o.pb.engV) || up <= o.pb.engV)) { inside = o; break; }
      }
      if (inside && cur && cur.site === inside.name && t - cur.t1 <= 2) cur.t1 = t;
      else if (inside) { cur = { t0: t, t1: t, site: inside.name }; out.push(cur); }
      else cur = null;
    }
  }
  exposureCache.set(key, out);
  return out;
}

/** Red overlay on the flown path where the selected jet (or me) was inside a SAM envelope. */
function drawExposure(ctx, m) {
  const id = S.selected && AIR.includes(S.objects.get(S.selected)?.category) ? S.selected : S.me;
  const jet = S.objects.get(id);
  if (!jet) return;
  const pb = jet.pb;
  ctx.save();
  ctx.strokeStyle = "rgba(255,59,59,0.55)";
  ctx.lineWidth = 6;
  ctx.lineCap = "round";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  for (const iv of exposure(id)) {
    if (iv.t0 > S.t) break;
    const t1 = Math.min(iv.t1, S.t);
    ctx.beginPath();
    let first = true;
    for (let i = Math.max(0, bisectRight(pb.t, iv.t0)); i < pb.t.length && pb.t[i] <= t1; i++) {
      if (!isNum(pb.lon[i])) continue;
      const [x, y] = m.project(pb.lon[i], pb.lat[i]);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const q = sampleTrack(pb, iv.t0);
    if (q && t1 - iv.t0 >= 2) {
      const [x, y] = m.project(q.lon, q.lat);
      ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,9,13,0.9)";
      const txt = `in ${iv.site} WEZ ${Math.round(t1 - iv.t0)} s`;
      ctx.strokeText(txt, x + 8, y + 14);
      ctx.fillStyle = "#ff8080";
      ctx.fillText(txt, x + 8, y + 14);
      ctx.lineWidth = 6; ctx.strokeStyle = "rgba(255,59,59,0.55)";
    }
  }
  ctx.restore();
}

/** The user's target point: a diamond with its name. */
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
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(6,9,13,0.9)";
  ctx.strokeText(`TGT ${tg.name || ""}`, x + 12, y);
  ctx.fillStyle = "#ffd166";
  ctx.fillText(`TGT ${tg.name || ""}`, x + 12, y);
  ctx.restore();
}

/** Hit test: objects first, strike marks only where no object is. */
function hitAt(px, py) {
  // Objects first, then flares and chaff (they sit right behind the jet that dropped them), then strike marks.
  const tier = (h) => (h.strike ? 2 : h.cm ? 1 : 0);
  for (const k of [0, 1, 2]) {
    let best = null, bd = Infinity;
    for (const h of hitboxes) {
      if (tier(h) !== k) continue;
      const d = Math.hypot(h.x - px, h.y - py);
      if (d < h.r && d < bd) { best = h; bd = d; }
    }
    if (best) return best;
  }
  return null;
}

/** A tape end for a hit: an object follows it; a strike mark stays where it was drawn. */
const snapEnd = (h) => (h.strike ? { lonlat: h.lonlat || map.unproject(h.x, h.y) } : { id: h.id });
const pointTarget = (h) => { const [lon, lat] = h.lonlat || map.unproject(h.x, h.y); return { kind: "point", lon, lat }; };

function onMapClick({ px, py, lonlat }) {
  const best = hitAt(px, py);
  if (S.measureFrom) {
    // Second click of "Measure from here": an object or a map point.
    addTape({ a: S.measureFrom, b: best ? snapEnd(best) : { lonlat } });
    S.measureFrom = null; S.tapeDraft = null;
    renderMapChips();
    return;
  }
  if (best?.strike) {
    // A release or impact mark: the weapon, with its strike card open.
    S.openStrikes.add(best.id);
    S.tab = "strike";
    select(best.id);
    requestAnimationFrame(() => document.querySelector(`.strike-anchor[data-weapon="${CSS.escape(best.id)}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" }));
    return;
  }
  if (best) { select(best.id); return; }
  // A bomblet dot selects the weapon that dispensed it.
  const b = bombletNear(px, py);
  if (b) select(b);
}

/** Dispenser id of a bomblet (falling or landed) within 10 px, or null. */
function bombletNear(px, py) {
  const footprints = cfg("strikeFootprints");
  for (const p of S.strikes) {
    if (!p.bomblets.length || S.t < (p.geom?.dispense?.time ?? Infinity) || isoAlpha(p.s.weaponId) < 1) continue;
    for (const id of S.analysis.weapons.submunitions?.[p.s.weaponId] || []) {
      const o = S.objects.get(id);
      if (!o) continue;
      const end = o.pb.end ?? o.pb.t[o.pb.t.length - 1];
      // Landed bomblets are drawn only by the footprint layer; falling ones as dots or the cloud.
      if (S.t >= end ? !footprints : !(shown(o, S.t) || (footprints && p.cloud.length))) continue;
      const q = posAt(o, S.t);
      if (!q) continue;
      const [x, y] = map.project(q.lon, q.lat);
      if (Math.hypot(x - px, y - py) <= 10) return p.s.weaponId;
    }
  }
  return null;
}

function onMapHover(ev) {
  const hud = $("hudHover");
  S.hoverLonLat = ev?.lonlat || null;
  if (S.measureFrom) map.invalidate();
  if (!ev || !S.analysis) { hud.classList.add("hidden"); return; }
  const [lon, lat] = ev.lonlat;
  const lines = [fmtCoord(lon, lat, cfg("coords"))];
  const be = S.analysis.bullseye;
  if (be) lines.push(`BE ${braa(be.longitude, be.latitude, lon, lat)}`);
  const me = S.selected && S.objects.get(S.selected);
  const p = me && sampleTrack(me.pb, S.t);
  if (p) lines.push(`from ${me.pilot || me.name}: ${braa(p.lon, p.lat, lon, lat)}`);
  hud.textContent = lines.join("   ·   ");
  hud.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Selection & object list
// ---------------------------------------------------------------------------

async function select(id) {
  if (id !== S.selected) {
    S.prevSelected = S.selected;
    if (S.selected && !isWeapon(S.objects.get(S.selected))) S.selBeforeWeapon = S.selected;
  }
  S.selected = id;
  S.selTarget = null;
  sel?.set(id ? objectTarget(id) : null);
  if (S.view === "3d") onTimeChange(true);
  renderObjectList();
  map.invalidate();
  const o = id && S.objects.get(id);
  if (o && ["fixedwing", "rotorcraft", "air"].includes(o.category) && !S.series.has(id)) {
    try {
      const { body, status } = await api(`/api/recording/${S.key}/series/${encodeURIComponent(id)}`);
      if (status === 200) S.series.set(id, body);
    } catch (err) { toast(`Telemetry load failed: ${err.message}`); }
  }
  renderAllPanels();
}

const OBJ_CHIPS = [["all", "All"], ["air", "Air"], ["surface", "Surface"], ["weapons", "Weapons"], ["hostile", "Hostile"], ["alive", "Alive"]];

function renderObjectList() {
  const list = $("objList");
  list.innerHTML = "";
  if (!S.analysis) return;
  // Filter chips (persisted) and the hidden / isolated chips.
  const chip = cfg("objChip");
  const chips = el("div", { class: "chips objchips" }, ...OBJ_CHIPS.map(([k, label]) => el("button", {
    class: chip === k ? "active" : "", onclick: () => { SET.set("objChip", k); renderObjectList(); } }, label)));
  if (S.hidden.size) chips.append(el("button", { class: "warnchip", title: "Show every hidden object again", onclick: () => { S.hidden.clear(); renderObjectList(); renderMapChips(); onTimeChange(true); } }, `${S.hidden.size} hidden · show`));
  list.append(chips);
  const me = S.objects.get(S.me);
  const groups = new Map();
  const statsById = new Map(S.analysis.aircraft.map((a) => [a.id, a]));
  for (const o of S.objects.values()) {
    if (!["fixedwing", "rotorcraft", "air", "ground", "sea", "weapon"].includes(o.category)) continue;
    if (o.category === "weapon" && /Shell|Bullet|Projectile/.test(o.type || "")) continue; // see Weapons tab
    if (o.dispenser) continue; // bomblets: counted on their dispenser's row
    const label = `${o.pilot || ""} ${o.name} ${o.group || ""}`.toLowerCase();
    if (S.filter && !label.includes(S.filter)) continue;
    const surface = ["ground", "sea"].includes(o.category);
    if (chip === "air" && !AIR.includes(o.category)) continue;
    if (chip === "surface" && !surface) continue;
    if (chip === "weapons" && o.category !== "weapon") continue;
    if (chip === "hostile" && !(me && isHostile(me, o))) continue;
    if (chip === "alive" && S.deaths.has(o.id) && S.t >= S.deaths.get(o.id)) continue;
    // Tacview names sides absolutely (Allies = the blue coalition), so flying
    // red listed your own jet under "ENEMIES".  Label them relative to you,
    // and keep the coalition's own name in the row's tooltip.
    const side = !me || !o.coalition ? (o.coalition || "Unknown")
      : o.coalition === me.coalition ? "Friendly"
      : isHostile(me, o) ? "Hostile" : (o.coalition || "Unknown");
    const g = o.category === "weapon" ? "Weapons"
      : o.category === "person" ? "Ejected pilots"
      : `${side} · ${surface ? "surface" : "air"}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }
  // The mode decides which groups come first and which start collapsed.
  const mode = SET.mode;
  const rank = (g) => {
    const surface = g.endsWith("surface"), weapons = g === "Weapons";
    if (mode === "a2g") return surface ? 0 : weapons ? 1 : 2;
    return weapons ? 2 : surface ? 1 : 0;
  };
  const order = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  S.listOrder = order.flatMap((g) => groups.get(g).map((o) => o.id));
  for (const g of order) {
    const items = groups.get(g);
    const defCollapsed = (mode === "a2a" && g.endsWith("surface")) || (mode === "a2g" && g.endsWith("air") && !items.some((o) => o.id === S.me));
    const ck = `${mode}|${g}`;
    const collapsed = S.collapsed.has(ck) ? S.collapsed.get(ck) : defCollapsed;
    const head = el("h4", { class: "click", title: collapsed ? "Show this group" : "Collapse this group",
      onclick: () => { S.collapsed.set(ck, !collapsed); renderObjectList(); } },
      el("span", {}, collapsed ? "▸ " : "▾ ", g), el("span", {}, items.length));
    const grp = el("div", { class: "objgroup" }, head);
    if (collapsed) { list.append(grp); continue; }
    for (const o of items.slice(0, 300)) {
      const dead = S.deaths.has(o.id) && S.t >= S.deaths.get(o.id);
      const st = statsById.get(o.id)?.stats;
      const subs = S.subCount?.get(o.id);
      const dim = S.isolate && !S.isolate.ids.has(o.id);
      grp.append(el("div", {
        class: `objrow${o.id === S.selected ? " selected" : ""}${dead ? " dead" : ""}${dim ? " gone" : ""}${S.hidden.has(o.id) ? " hid" : ""}`,
        "data-id": o.id,
        // What DCS calls the side, since the heading now says friendly/hostile.
        title: o.coalition ? `Coalition: ${o.coalition}` : "",
        onclick: (e) => {
          if (e.shiftKey) { setPadlock(o.id); return; }
          select(o.id); const p = sampleTrack(o.pb, S.t) || sampleTrack(o.pb, o.pb.t[0]); if (p) map.setView(p.lon, p.lat);
        },
        oncontextmenu: (e) => {
          e.preventDefault();
          if (o.id !== S.selected) select(o.id);
          const r = document.querySelector(".mapwrap").getBoundingClientRect();
          sel.openMenu(objectTarget(o.id), Math.max(8, e.clientX - r.left), e.clientY - r.top);
        },
      },
      el("span", { class: "dot", style: { background: sideColor(o) } }),
      el("span", { class: "nm" }, o.pilot || (o.category === "weapon" ? weaponLabel(o.name) : o.name), o.pilot ? el("small", {}, o.name) : "",
        subs ? el("small", { title: `${subs} submunitions recorded` }, `· ${subs} bomblets`) : "",
        o.id === S.me ? el("span", { class: "me-badge" }, "ME") : ""),
      el("span", { class: "st" }, st?.maxAltitude ? fmtAlt(st.maxAltitude, { suffix: false }) : o.category === "weapon" ? fmtClock(o.firstSeen - S.start) : "")));
    }
    list.append(grp);
  }
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

const TABS = [
  ["flight", "Flight"], ["charts", "Charts"], ["weapons", "Weapons"], ["strike", "Strike"], ["landings", "Landings"],
  ["radar", "Radar"], ["events", "Events"], ["aircraft", "All aircraft"],
];

/** Tabs keep their order and numbers (1-8) whatever the recording or mode. */
function visibleTabs() {
  return TABS;
}

function renderTabs() {
  const nav = $("tabs");
  nav.innerHTML = "";
  for (const [idx, [id, label]] of visibleTabs().entries()) {
    const count = !S.analysis ? "" : id === "weapons" ? S.analysis.weapons.shots.length + S.analysis.weapons.bursts.length
      : id === "strike" ? S.strikes.length
      : id === "landings" ? S.analysis.landings.length : id === "events" ? S.analysis.timeline.length
      : id === "radar" ? S.analysis.radar.locks.length : "";
    nav.append(el("button", { class: S.tab === id ? "active" : "", role: "tab", title: `${label} (${idx + 1})`, onclick: () => { S.tab = id; renderAllPanels(); } },
      label, count !== "" ? el("span", { class: "count" }, count) : ""));
  }
}

function renderAllPanels() {
  renderTabs();
  renderObjectList();
  const panel = $("tabpanel");
  panel.innerHTML = "";
  charts = [];
  strikeCards = [];
  flightEls = null;
  if (!S.analysis) { panel.append(el("div", { class: "empty" }, "Open a recording to begin.")); return; }
  ({ flight: renderFlight, charts: renderCharts, weapons: renderWeapons, strike: renderStrike, landings: renderLandings,
    radar: renderRadar, events: renderEvents, aircraft: renderAircraft })[S.tab](panel);
  updateLivePanels();
}

let charts = [];
let flightEls = null;

function updateLivePanels() {
  if (!S.analysis) return;
  if (S.tab === "flight" && flightEls?.adi.isConnected) updateFlight();
  for (const c of charts) c.setMarker(c._markerFn ? c._markerFn(S.t) : S.t);
  for (const c of strikeCards) c._setTime?.(S.t);
  if (S.tab === "events") {
    for (const row of document.querySelectorAll(".timeline-list .ev")) {
      const t = +row.dataset.t;
      row.classList.toggle("past", t < S.t - 5);
      row.classList.toggle("now", Math.abs(t - S.t) <= 5);
    }
  }
  for (const row of document.querySelectorAll(".objrow[data-id]")) {
    const d = S.deaths.get(row.dataset.id);
    row.classList.toggle("dead", isNum(d) && S.t >= d);
  }
  sel?.refresh();
  renderWif();
}

/** "Weapons in flight" for the selected jet (or me): time to impact, progress. */
function renderWif() {
  const box = $("wifHud");
  const who = S.selected && AIR.includes(S.objects.get(S.selected)?.category) ? S.selected : S.me;
  const list = cfg("strikeTti") ? weaponsInFlight(S.strikes, S.t, who) : [];
  if (!list.length) { box.classList.add("hidden"); box._sig = ""; return; }
  box.classList.remove("hidden");
  const sig = list.map((x) => x.s.weaponId).join(",");
  if (box._sig !== sig) {
    box._sig = sig;
    box.innerHTML = "";
    box.append(el("div", { class: "wif-h" }, "Weapons in flight"));
    for (const x of list) {
      box.append(el("div", { class: "wif-row", "data-id": x.s.weaponId, title: "Select this weapon",
        onclick: () => select(x.s.weaponId) },
        el("span", { class: "nm" }, `${weaponLabel(x.s.weaponName)}${x.s.targetName ? ` → ${x.s.targetName}` : ""}`),
        el("span", { class: "tti" }), el("div", { class: "prog" }, el("i"))));
    }
  }
  for (const x of list) {
    const row = box.querySelector(`.wif-row[data-id="${CSS.escape(x.s.weaponId)}"]`);
    if (!row) continue;
    row.querySelector(".tti").textContent = isNum(x.opens) ? `opens ${fmtClock(x.opens)}` : fmtClock(x.left);
    row.querySelector(".prog i").style.width = `${Math.round(x.frac * 100)}%`;
  }
}

// -- Flight tab ---------------------------------------------------------------

function seriesAt(id) {
  const ser = S.series.get(id);
  if (!ser) return null;
  const i = bisectRight(ser.t, S.t);
  if (i < 0) return null;
  const v = {};
  for (const [k, arr] of Object.entries(ser.channels)) v[k] = arr[i];
  const lock = ser.text?.LockedTarget;
  if (lock?.length) {
    let cur = null;
    for (const [tt, val] of lock) if (tt <= S.t) cur = val;
    v.LockedTarget = cur;
  }
  return v;
}

function tile(k, id) { return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v", id })); }
function barRow(label, id, cls = "") {
  return el("div", { class: "barrow" }, el("span", { class: "lbl" }, label),
    el("div", { class: `bar ${cls}`, id }, el("div", { class: "fill" })), el("span", { class: "val", id: `${id}v` }));
}

function renderFlight(panel) {
  const o = S.selected && S.objects.get(S.selected);
  if (!o) { panel.append(el("div", { class: "empty" }, "Select an aircraft on the map or in the list.")); return; }
  const air = ["fixedwing", "rotorcraft", "air"].includes(o.category);
  panel.append(el("div", { class: "ac-head" },
    el("div", { class: "who" }, o.pilot || o.name, el("small", {}, [o.name, o.group, o.coalition].filter(Boolean).join(" · "))),
    air && o.id !== S.me ? el("button", { onclick: () => setMe(o) }, "This is me") : el("span", { class: "pill on" }, o.id === S.me ? "ME" : o.category)));
  if (!air) {
    const eng = o.pb?.eng;
    panel.append(el("dl", { class: "kv" }, el("dt", {}, "Type"), el("dd", {}, o.type || "—"),
      ...(isNum(eng) ? [el("dt", {}, "Engagement range"), el("dd", { title: o.pb.engSrc === "recorded" ? "From the recording" : `From ${o.pb.engSrc}: DCS recordings do not carry it` }, `${fmtDist(eng)} (${o.pb.engSrc})`)] : []),
      el("dt", {}, "First seen"), el("dd", {}, fmtClock(o.firstSeen - S.start)),
      el("dt", {}, "Last seen"), el("dd", {}, fmtClock((o.endsAt ?? o.lastSeen) - S.start)),
      el("dt", {}, "Parent"), el("dd", {}, o.parent ? (S.objects.get(o.parent)?.pilot || S.objects.get(o.parent)?.name || o.parent) : "—")));
    flightEls = null;
    return;
  }
  if (!S.series.has(o.id)) panel.append(el("div", { class: "empty" }, "Loading telemetry…"));
  const adi = el("canvas", { class: "adi" });
  const stick = el("canvas", { class: "stick" });
  const stickLabel = el("div", { class: "faint", style: { fontSize: "11px" } });
  panel.append(
    el("div", { class: "adi-row" }, adi, el("div", {}, el("div", { class: "muted", style: { fontSize: "11px", marginBottom: "4px" } }, "Stick & rudder"), stick, stickLabel)),
    el("div", { class: "section" }, el("div", { class: "tiles" },
      tile("IAS", "fIAS"), tile("Mach", "fMach"), tile("Altitude", "fAlt"),
      tile("Vert speed", "fVS"), tile("Heading", "fHdg"), tile("AGL", "fAGL"),
      tile("AOA", "fAOA"), tile("G", "fG"), tile("Turn rate", "fTurn"),
      tile("TAS", "fTAS"), tile("Ground spd", "fGS"), tile("Ps", "fPs"))),
    el("div", { class: "section" }, el("h3", {}, "Controls & configuration"), el("div", { class: "bars" },
      barRow("Throttle", "bThr"), barRow("Afterburner", "bAB", "ab"), barRow("Gear", "bGear"), barRow("Flaps", "bFlaps"),
      barRow("Speed brake", "bBrk"), barRow("Hook", "bHook"), barRow("Trigger", "bTrig", "ab"))),
    el("div", { class: "section" }, el("h3", {}, "Fuel & sensors"), el("dl", { class: "kv", id: "fKv" })),
  );
  flightEls = { adi, stick, stickLabel };
}

function updateFlight() {
  if (!flightEls) return;
  const o = S.objects.get(S.selected);
  const v = seriesAt(S.selected);
  if (!o || !v) return;
  const set = (id, txt, cls = "") => { const n = $(id); if (n) { n.textContent = txt; n.className = `v ${cls}`; } };
  set("fIAS", fmtSpeed(v.IAS)); set("fMach", fmtNum(v.Mach, 2)); set("fAlt", fmtAlt(v.Altitude));
  set("fVS", fmtVs(v.VerticalSpeed)); set("fHdg", fmtHdg(v.Yaw ?? v.HDG)); set("fAGL", fmtAlt(v.AGL));
  set("fAOA", fmtDeg(v.AOA, 1), v.AOA > 20 ? "warn" : "");
  set("fG", fmtNum(v.GLoad, 1), v.GLoad > 7.5 || v.GLoad < -1.5 ? "danger" : v.GLoad > 6 ? "warn" : "");
  set("fTurn", isNum(v.TurnRate) ? `${Math.abs(v.TurnRate).toFixed(1)}°/s` : "—");
  set("fTAS", fmtSpeed(v.TAS ?? v.Speed)); set("fGS", fmtSpeed(v.GroundSpeed));
  set("fPs", isNum(v.Ps) ? (units.metric ? `${v.Ps.toFixed(0)} m/s` : `${Math.round(v.Ps * M_TO_FT)} ft/s`) : "—");
  const spd = v.Speed ?? v.TAS;
  const fpa = isNum(v.VerticalSpeed) && isNum(spd) && spd > 1 ? (Math.asin(Math.max(-1, Math.min(1, v.VerticalSpeed / spd))) * 180) / Math.PI : null;
  drawADI(flightEls.adi, { pitch: v.Pitch, roll: v.Roll, fpa });

  const hasInput = isNum(v.PitchControlInput) || isNum(v.RollControlInput);
  const hasSurf = isNum(v.Elevator) || isNum(v.AileronLeft);
  drawStick(flightEls.stick, hasInput
    ? { pitch: v.PitchControlInput, roll: v.RollControlInput, yaw: v.YawControlInput }
    : { pitch: v.Elevator, roll: isNum(v.AileronLeft) ? v.AileronLeft : v.AileronRight, yaw: v.Rudder });
  const readDcs = hasSurf && (S.analysis.dcs?.channelList || []).includes(`${o.id}:Elevator`);
  flightEls.stickLabel.textContent = hasInput ? "pilot inputs" : hasSurf ? (readDcs ? "control surfaces · read from DCS" : "control surfaces") :
    "not in this recording — install the DCS bridge for live inputs";

  const th = v.Throttle;
  bar($("bThr"), isNum(th) ? Math.min(th, 1) : th); $("bThrv").textContent = fmtPct(th);
  if (isNum(v.Afterburner)) { bar($("bAB"), v.Afterburner); $("bABv").textContent = fmtPct(v.Afterburner); }
  else {
    // No Afterburner channel: what the IR analysis read from engine data (or that the type has none).
    const h = S.analysis.ir?.heat?.[o.id];
    const lit = abAt(h, S.t);
    bar($("bAB"), lit === null ? null : lit ? 1 : 0);
    $("bABv").textContent = h?.state === "noAB" ? "none" : lit === null ? "—" : lit ? "ON" : "OFF";
    $("bABv").title = h?.state === "recorded" ? `from ${h.src === "FuelFlowWeight" ? "fuel flow" : h.src}` : h?.state === "noAB" ? "This type has no afterburner (DCS)" : "Not recorded";
  }
  bar($("bGear"), v.LandingGear); $("bGearv").textContent = isNum(v.LandingGear) ? (v.LandingGear > 0.95 ? "DOWN" : v.LandingGear < 0.05 ? "UP" : "TRANS") : "—";
  bar($("bFlaps"), v.Flaps); $("bFlapsv").textContent = fmtPct(v.Flaps);
  bar($("bBrk"), v.AirBrakes); $("bBrkv").textContent = fmtPct(v.AirBrakes);
  bar($("bHook"), v.Tailhook); $("bHookv").textContent = fmtPct(v.Tailhook);
  bar($("bTrig"), v.TriggerPressed); $("bTrigv").textContent = v.TriggerPressed > 0.5 ? "FIRE" : "—";

  const kv = $("fKv");
  kv.innerHTML = "";
  const add = (k, val) => kv.append(el("dt", {}, k), el("dd", {}, val));
  add("Fuel", fmtMass(v.FuelWeight));
  if (isNum(v.FuelFlowWeight)) add("Fuel flow", `${fmtMass(v.FuelFlowWeight)}/h`);
  const hn = heatNow(S.analysis.ir?.heat?.[o.id], S.t);
  if (hn) kv.append(el("dt", { title: HEAT_NOTE }, "Heat (IR)"), el("dd", { title: HEAT_NOTE }, `${heatText(hn).replace(/^IR /, "")} · DCS scale`));
  add("Radar", isNum(v.RadarMode) ? (v.RadarMode > 0 ? `ON · ${fmtDist(v.RadarRange)}` : "OFF") : isNum(v.RadarActive) ? (v.RadarActive > 0 ? "ON (DCS)" : "OFF (DCS)") : "—");
  const row = sceneObjects().find((x) => x.id === o.id);
  const vol = row && radarVolume(row, { assumed: true });
  if (vol) add("Radar cone", { recorded: "recorded in the ACMI", dcs: "read from DCS", type: "typical for type", assumed: "assumed (not recorded)" }[vol.source] || vol.source);
  if (isNum(v.ScanAz)) add("Scan zone", `±${Math.round(v.ScanAz)}° az · ±${fmtNum(v.ScanEl, 1)}° el (DCS)`);
  if (isNum(v.RadarAzimuth)) add("Antenna", `${fmtDeg(v.RadarAzimuth)} az / ${fmtDeg(v.RadarElevation)} el`);
  const locked = v.LockedTarget && (!isNum(v.LockedTargetMode) || v.LockedTargetMode > 0) ? S.objects.get(v.LockedTarget) : null;
  const me = sampleTrack(o.pb, S.t);
  let lockTxt = "—";
  if (locked) {
    const tp = sampleTrack(locked.pb, S.t);
    lockTxt = `${locked.pilot || locked.name}${tp && me ? ` · ${fmtDist(distance(me.lon, me.lat, tp.lon, tp.lat))}` : ""}`;
  }
  add("Locked", lockTxt);
  if (isNum(v.GlideslopeVerticalDeviation)) add("ILS dev", `${fmtAlt(v.GlideslopeVerticalDeviation)} / ${fmtAlt(v.LocalizerLateralDeviation)}`);
  if (me) {
    add("Position", fmtCoord(me.lon, me.lat, cfg("coords")));
    const be = S.analysis.bullseye;
    if (be) add("Bullseye", braa(be.longitude, be.latitude, me.lon, me.lat));
  }
}

// -- Charts tab -----------------------------------------------------------------

const CHART_DEFS = {
  Altitude: { series: [["Altitude", "#4ea8ff"], ["AGL", "#5fd38d"]], f: (v) => (units.metric ? v : v * M_TO_FT), fmt: (v) => `${Math.round(v).toLocaleString()}` },
  Speed: { series: [["IAS", "#ffd166"], ["TAS", "#ff9f43"], ["GroundSpeed", "#8d9aab"]], f: (v) => (units.metric ? v * 3.6 : v * MPS_TO_KT), fmt: (v) => v.toFixed(0) },
  Mach: { series: [["Mach", "#b48cff"]], f: (v) => v, fmt: (v) => v.toFixed(2) },
  AOA: { series: [["AOA", "#ff9f43"]], f: (v) => v, fmt: (v) => v.toFixed(1) },
  G: { series: [["GLoad", "#ff5c5c"]], f: (v) => v, fmt: (v) => v.toFixed(1) },
  "Vert speed": { series: [["VerticalSpeed", "#4dd8e6"]], f: (v) => (units.metric ? v : v * MPS_TO_FPM), fmt: (v) => v.toFixed(0) },
  Throttle: { series: [["Throttle", "#5fd38d"], ["Afterburner", "#ff9f43"]], f: (v) => v * 100, fmt: (v) => `${v.toFixed(0)}%` },
  Fuel: { series: [["FuelWeight", "#ffd166"]], f: (v) => (units.metric ? v : v * 2.20462), fmt: (v) => v.toFixed(0) },
  Energy: { series: [["Ps", "#5fd38d"]], f: (v) => (units.metric ? v : v * M_TO_FT), fmt: (v) => v.toFixed(0) },
  "Turn rate": { series: [["TurnRate", "#4ea8ff"]], f: (v) => Math.abs(v), fmt: (v) => v.toFixed(1) },
  Controls: { series: [["PitchControlInput", "#ffd166"], ["RollControlInput", "#4ea8ff"], ["YawControlInput", "#4dd8e6"], ["Elevator", "#ff9f43"], ["Rudder", "#b48cff"]], f: (v) => v, fmt: (v) => v.toFixed(2) },
  Radar: { series: [["RadarAzimuth", "#4dd8e6"], ["LockedTargetAzimuth", "#ff9f43"]], f: (v) => v, fmt: (v) => v.toFixed(0) },
  // Counts left, read from DCS by the bridge (your own jet only).
  Flares: { series: [["FlareCount", "#ffb347"], ["ChaffCount", "#9aa4b1"]], f: (v) => v, fmt: (v) => v.toFixed(0) },
};
const chartSel = () => new Set(String(cfg("charts") || "").split(",").filter(Boolean));

function renderCharts(panel) {
  const ser = S.selected && S.series.get(S.selected);
  if (!ser) { panel.append(el("div", { class: "empty" }, "Select an aircraft to chart its telemetry.")); return; }
  const picked = chartSel();
  const picker = el("div", { class: "chart-picker" });
  for (const name of Object.keys(CHART_DEFS)) {
    const has = CHART_DEFS[name].series.some(([k]) => ser.channels[k]);
    if (!has) continue;
    picker.append(el("button", { class: picked.has(name) ? "active" : "", onclick: () => {
      picked.has(name) ? picked.delete(name) : picked.add(name);
      SET.set("charts", [...picked].join(",")); renderAllPanels();
    } }, name));
  }
  // "Compare with me": the other jet's series drawn dashed on the same charts.
  const other = S.compare && S.compare !== S.selected ? S.series.get(S.compare) : null;
  const wrap = el("div", { class: "charts" });
  const head = el("div", { class: "muted", style: { marginBottom: "6px" } }, `${ser.summary.pilot || ser.summary.name} — click a chart to jump there`);
  if (S.compare && S.compare !== S.selected) {
    const o = S.objects.get(S.compare);
    head.append(" ", filterChip(`dashed: ${o?.pilot || o?.name || S.compare}${other ? "" : " (loading…)"}`, () => { S.compare = null; renderAllPanels(); }));
  }
  panel.append(head, picker, wrap);
  for (const name of Object.keys(CHART_DEFS)) {
    if (!picked.has(name)) continue;
    const def = CHART_DEFS[name];
    const lockMode = ser.channels.LockedTargetMode;
    const series = def.series.filter(([k]) => ser.channels[k]).map(([k, color]) => ({
      name: k, color, x: ser.t,
      // Locked-target values are held after the lock drops; show them only while locked.
      y: ser.channels[k].map((v, i) => (isNum(v) && !(k.startsWith("LockedTarget") && lockMode && !(lockMode[i] > 0)) ? def.f(v) : null)),
    }));
    if (other) {
      for (const [k, color] of def.series) {
        if (!other.channels[k] || k.startsWith("LockedTarget")) continue;
        series.push({ name: `${k} (${other.summary.pilot || other.summary.name})`, color, dash: [5, 4], x: other.t,
          y: other.channels[k].map((v) => (isNum(v) ? def.f(v) : null)) });
      }
    }
    if (!series.length) continue;
    const canvas = el("canvas");
    wrap.append(canvas);
    const chart = new LineChart(canvas, { title: name, yFormat: def.fmt, xFormat: (x) => fmtClock(x - S.start), onSeek: seek });
    chart.setData(series, { xMin: S.start, xMax: S.end });
    charts.push(chart);
  }
}

// -- Weapons tab ----------------------------------------------------------------

function outcomePill(o) {
  const cls = { kill: "kill", miss: "miss", active: "active", damage: "lock" }[o] || "";
  return el("span", { class: `pill ${cls}` }, o);
}

function dcsBadge(title = "Reported by DCS itself") { return el("span", { class: "dcs-badge", title }, "DCS"); }

function replayShot(shot) {
  setLoop(shot.launchTime - 5, (shot.endTime ?? shot.launchTime) + 3, true);
  const who = shot.targetId && S.objects.has(shot.targetId) ? shot.targetId : shot.launcherId;
  if (who) select(who);
  if (SET.get("trailSec") === 0 || SET.get("trailSec") === 30) TEMP.trailSec = 90;
  seek(shot.launchTime - 5);
  togglePlay(true);
}

/** Is this shot an air-to-ground release (it has a strike record)? */
const isAG = (sh) => !!sh.weaponId && S.strikeIds.has(sh.weaponId);

function filterChip(label, clear) {
  return el("button", { class: "filterchip", title: "Clear this filter", onclick: clear }, label, " ×");
}

function renderWeapons(panel) {
  const w = S.analysis.weapons;
  const dcs = S.analysis.dcs;
  const tab = S.wtabOverride ?? cfg("wtab");
  const agShots = w.shots.filter(isAG).length;
  const seg = el("div", { class: "seg wtab" }, ...[["all", "All", w.shots.length], ["a2a", "A-A", w.shots.length - agShots], ["a2g", "A-G", agShots]]
    .map(([k, label, n]) => el("button", { class: tab === k ? "active" : "", onclick: () => { S.wtabOverride = null; SET.set("wtab", k); renderAllPanels(); } }, `${label} ${n}`)));
  const head = el("div", { class: "tabhead" }, seg);
  const shooter = S.shooterFilter && S.objects.get(S.shooterFilter);
  if (shooter) head.append(filterChip(`Shooter or target: ${shooter.pilot || shooter.name}`, () => { S.shooterFilter = null; renderAllPanels(); }));
  panel.append(head);
  if (dcs) {
    panel.append(el("div", { class: "dcs-note" }, dcsBadge(),
      ` Hits and kills below are read from DCS (flight log ${dcs.log}: ${dcs.hits ?? 0} hits, ${dcs.kills ?? 0} kills`,
      dcs.killsCorrected ? `, ${dcs.killsCorrected} kill credit corrected` : "", dcs.killsAdded ? `, ${dcs.killsAdded} added` : "",
      `). Clock offset ${dcs.offset >= 0 ? "+" : ""}${dcs.offset.toFixed(1)} s, flight paths agree to ${Math.round(dcs.medianError)} m.`));
  }
  const inTab = (sh) => (tab === "all" || (tab === "a2g") === isAG(sh)) &&
    (!S.shooterFilter || sh.launcherId === S.shooterFilter || sh.targetId === S.shooterFilter);
  const shotList = w.shots.filter(inTab);
  // Shooters: counted from the rows shown, so A-A Pk is not diluted by bombs.
  const tally = new Map();
  for (const sh of shotList) {
    if (!sh.launcherId) continue;
    const t = tally.get(sh.launcherId) || { id: sh.launcherId, name: sh.launcherName, pilot: sh.launcherPilot, color: S.objects.get(sh.launcherId)?.color, coalition: S.objects.get(sh.launcherId)?.coalition, shots: 0, kills: 0 };
    t.shots += 1;
    if (sh.outcome === "kill") t.kills += 1;
    tally.set(sh.launcherId, t);
  }
  if (tab !== "a2g") {
    for (const b of Object.values(w.byShooter)) {
      if (!b.gunBursts || (S.shooterFilter && b.id !== S.shooterFilter)) continue;
      const t = tally.get(b.id) || { id: b.id, name: b.name, pilot: b.pilot, color: b.color, coalition: b.coalition, shots: 0, kills: 0 };
      t.gunBursts = b.gunBursts; t.gunRounds = b.gunRounds;
      tally.set(b.id, t);
    }
  }
  if (tally.size) {
    const t = el("table", { class: "grid" }, el("tr", {}, ...["Shooter", "Shots", "Kills", tab === "a2g" ? "Hit rate" : "Pk", "Gun"].map((h) => el("th", {}, h))));
    for (const x of tally.values()) {
      t.append(el("tr", { class: "click", onclick: () => select(x.id) },
        el("td", {}, el("span", { class: "dot", style: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", marginRight: "6px", background: sideColor(x) } }), x.pilot || x.name),
        el("td", { class: "num" }, x.shots), el("td", { class: "num" }, x.kills),
        el("td", { class: "num" }, x.shots ? `${Math.round((x.kills / x.shots) * 100)}%` : "—"),
        el("td", { class: "num" }, x.gunBursts ? `${x.gunBursts} / ${x.gunRounds}rd` : "—")));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, "Shooters"), t));
  }
  const shots = el("table", { class: "grid" }, el("tr", {}, ...["", "Time", "Shooter", "Weapon", "Target", tab === "a2g" ? "Miss" : "Range", "Result"].map((h) => el("th", {}, h))));
  for (const s of shotList) {
    const g = s.geometry || {};
    const ag = isAG(s);
    const strike = ag ? S.strikes.find((p) => p.s.weaponId === s.weaponId)?.s : null;
    const key = s.weaponId || `t${s.launchTime}`;
    const openSet = ag ? S.openStrikes : S.openShots;
    const open = openSet.has(key);
    const toggle = () => { open ? openSet.delete(key) : openSet.add(key); renderAllPanels(); };
    shots.append(el("tr", { class: "click", title: ag ? `TOF ${fmtNum(strike?.timeOfFall, 0)} s · released at ${kAlt(strike?.release?.altitude)}` : `Aspect ${fmtDeg(g.aspect)} · off-boresight ${fmtDeg(g.offBoresight)} · TOF ${fmtNum(s.timeOfFlight, 1)}s · closest ${fmtDist(s.closestApproach)}`,
      onclick: (e) => { if (e.altKey) { toggle(); return; } seek(s.launchTime - 3); if (s.launcherId) select(ag ? s.weaponId : s.launcherId); } },
      el("td", { class: "tog", title: ag ? "Strike card: release, fall, impact, BDA" : "Why did it hit / miss?", onclick: (e) => { e.stopPropagation(); toggle(); } }, open ? "▾" : "▸"),
      el("td", { class: "num" }, fmtClock(s.launchTime - S.start)),
      el("td", {}, s.launcherPilot || s.launcherName || "?"),
      el("td", { title: s.ir ? `DCS name ${s.weaponName}` : null }, weaponLabel(s.weaponName),
        s.ir ? el("span", { class: "ir-pill", title: s.ir.seeker?.fromEvent ? "Heat-seeker: DCS's own shot event says IR guidance (not in the DCS seeker table, so no seeker limits)."
          : `Heat-seeker (DCS: IR seeker${s.ir.seeker?.allAspect ? ", all-aspect" : ", rear-aspect only"}). No RWR warning; flares can decoy it.` }, "IR") : ""),
      el("td", {}, ag ? strike?.targetName || "—" : s.targetPilot || s.targetName || "—"),
      el("td", { class: "num" }, ag ? fmtShort(strike?.missDistance) : fmtDist(g.range)),
      el("td", {}, outcomePill(ag ? strike?.result || s.outcome : s.outcome), s.dcsHit ? dcsBadge(`DCS reported a hit on ${s.dcsHit}`) : s.dcsConfirmed ? dcsBadge("DCS reported this launch") : "",
        s.ir?.decoy ? el("span", { class: "ir-pill decoy", title: `Estimate: from ${fmtRel(s.ir.decoy.t)} its predicted miss was ${fmtShort(s.ir.decoy.zemFlare)} to a flare vs ${fmtShort(s.ir.decoy.zemTarget)} to the jet` }, "flare?") : "")));
    if (open) {
      const card = ag && strike ? strikeCard(strike) : buildShotCard(s, { objects: S.objects, start: S.start, seek, onReplay: replayShot, charts });
      shots.append(el("tr", { class: "shotcard-row" }, el("td", { colspan: 7 }, card)));
    }
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, tab === "a2g" ? "Air-to-ground releases" : tab === "a2a" ? "Missiles & rockets" : "Missiles, rockets & bombs"),
    shotList.length ? shots : el("div", { class: "empty" }, tab === "a2g" ? "No air-to-ground releases in this recording." : "None")));
  const bursts = w.bursts.filter((x) => !S.shooterFilter || x.launcherId === S.shooterFilter || x.targetId === S.shooterFilter);
  if (bursts.length && tab !== "a2g") {
    const hasDcs = bursts.some((x) => isNum(x.dcsHits));
    const heads = ["Time", "Shooter", "Rounds", "On target", ...(hasDcs ? ["DCS hits"] : []), "Target", "Range", "Result"];
    const b = el("table", { class: "grid" }, el("tr", {}, ...heads.map((h) => el("th", { title: h === "DCS hits" ? "Hits DCS itself reported for this burst" : h === "On target" ? "Rounds whose recorded path passed within 12 m of the target" : null }, h))));
    for (const x of bursts) {
      const hits = isNum(x.roundsOnTarget) && x.rounds ? `${x.roundsOnTarget} (${Math.round((100 * x.roundsOnTarget) / x.rounds)}%)` : "—";
      const dcsTargets = x.dcsHitTargets ? Object.entries(x.dcsHitTargets).map(([k, v]) => `${k} ×${v}`).join(", ") : "";
      b.append(el("tr", {
        class: "click",
        title: [x.weaponName, isNum(x.fireRate) ? `${Math.round(x.fireRate)} rds/s recorded` : "", isNum(x.timeOfFlight) ? `mean time of flight ${x.timeOfFlight.toFixed(1)} s` : "",
          isNum(x.closestApproach) ? `closest round ${units.metric ? `${x.closestApproach.toFixed(1)} m` : `${Math.round(x.closestApproach * M_TO_FT)} ft`}` : "", dcsTargets ? `DCS hits: ${dcsTargets}` : ""].filter(Boolean).join(" · "),
        onclick: () => { seek(x.start - 1.5); select(x.launcherId); if (SET.get("bullets") === "off") TEMP.bullets = "paths"; },
      },
        el("td", { class: "num" }, fmtClock(x.start - S.start)), el("td", {}, x.launcherPilot || x.launcherName),
        el("td", { class: "num" }, x.rounds || "trigger"), el("td", { class: "num" }, hits),
        ...(hasDcs ? [el("td", { class: "num" }, isNum(x.dcsHits) ? String(x.dcsHits) : "—")] : []),
        el("td", {}, x.targetName || "—"),
        el("td", { class: "num" }, fmtDist(x.rangeAtOpen)), el("td", {}, outcomePill(x.kill ? "kill" : "no kill"))));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, "Gun"), b));
  }
  const kills = el("div");
  const agKill = (k) => ["ground", "sea"].includes(k.victimCategory) || S.strikeIds.has(k.weaponId);
  const killList = w.kills.filter((k) => (tab === "all" || (tab === "a2g") === agKill(k)) &&
    (!S.shooterFilter || k.killerId === S.shooterFilter || k.victimId === S.shooterFilter));
  for (const k of killList) {
    kills.append(el("div", { class: "ev", style: { padding: "4px 0", cursor: "pointer" }, onclick: () => seek(k.time - 5) },
      el("span", { class: "num muted" }, fmtClock(k.time - S.start), "  "),
      el("b", { class: "k-kill" }, k.victimPilot || k.victimName), " ",
      k.killerId ? `← ${k.killerPilot || k.killerName} (${weaponLabel(k.weaponName)})` : `destroyed (${k.cause})`,
      k.confirmedBy === "DCS" ? dcsBadge("DCS reported this kill") : "",
      k.note ? el("div", { class: "faint", style: { fontSize: "11px", marginLeft: "52px" } }, k.note) : ""));
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Kills & losses"), killList.length ? kills : el("div", { class: "empty" }, "None")));
}

// -- Strike tab -------------------------------------------------------------------

function strikeCard(strike) {
  const card = buildStrikeCard(strike, {
    objects: S.objects, start: S.start, seek, charts, target: S.target && S.selected === strike.weaponId ? S.target : null,
    onReplay: replayStrike, onWeaponCam: (x) => startWeaponCam(x.weaponId), onShowOnMap: showStrikeOnMap, onSelect: (id) => select(id),
    series: async (id) => {
      if (S.series.has(id)) return S.series.get(id);
      try { const { body, status } = await api(`/api/recording/${S.key}/series/${encodeURIComponent(id)}`); if (status === 200) { S.series.set(id, body); return body; } } catch { /* offline */ }
      return null;
    },
  });
  strikeCards.push(card);
  return card;
}
let strikeCards = [];

function replayStrike(x) {
  const pass = groupPasses(S.analysis.strikes).find((p) => p.strikes.includes(x)) || { strikes: [x] };
  const a = Math.min(...pass.strikes.map((q) => q.releaseTime)) - 10;
  const b = Math.max(...pass.strikes.map((q) => q.impactTime)) + 5;
  setLoop(a, b, true);
  select(x.weaponId);
  if (SET.get("trailSec") < 300) TEMP.trailSec = 300;
  seek(a);
  togglePlay(true);
}

function showStrikeOnMap(x) {
  const g = strikeGeometry(x, S.objects);
  if (!g) return;
  const lons = [g.release.lon, g.impact.lon], lats = [g.release.lat, g.impact.lat];
  if (g.target) { lons.push(g.target.lon); lats.push(g.target.lat); }
  if (S.view === "3d") setView("2d");
  setFollow(false);
  map.fitBounds(Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats));
  select(x.weaponId);
  if (S.t < x.impactTime) seek(x.impactTime + 1);
}

/**
 * Surface units in sites: their ACMI Group when the recording has one, else
 * units of one coalition within 1 km of each other (a column, a SAM site).
 * {of: Map id -> site name, members: Map name -> [objects]}
 */
let sitesCache = null;
function surfaceSites() {
  if (sitesCache?.key === S.key) return sitesCache;
  const units = [...S.objects.values()].filter((o) => isSurface(o) && !o.dispenser);
  const pos = new Map(units.map((o) => [o.id, posAt(o, o.pb.t[0])]));
  const parent = new Map(units.map((o) => [o.id, o.id]));
  const find = (x) => { while (parent.get(x) !== x) x = parent.get(x); return x; };
  for (let i = 0; i < units.length; i++) {
    for (let j = i + 1; j < units.length; j++) {
      const a = units[i], b = units[j];
      if (a.group || b.group || a.coalition !== b.coalition) continue;
      const pa = pos.get(a.id), pb = pos.get(b.id);
      if (pa && pb && distance(pa.lon, pa.lat, pb.lon, pb.lat) <= 1000) parent.set(find(a.id), find(b.id));
    }
  }
  const byRoot = new Map();
  for (const o of units) {
    const k = o.group ? `g:${o.group}` : find(o.id);
    if (!byRoot.has(k)) byRoot.set(k, []);
    byRoot.get(k).push(o);
  }
  const of = new Map(), members = new Map();
  for (const [k, list] of byRoot) {
    if (list.length < 2 && !k.startsWith("g:")) continue;
    // Name a proximity group after what its units share ("SA-11 Buk"), else its most common type.
    let name = k.startsWith("g:") ? k.slice(2) : null;
    if (!name) {
      const words = list.map((o) => o.name.split(/\s+/));
      const common = [];
      for (let i = 0; words.every((w) => w.length > i + 1 && w[i] === words[0][i]); i++) common.push(words[0][i]);
      const types = new Map();
      for (const o of list) types.set(o.name, (types.get(o.name) || 0) + 1);
      const top = common.length ? common.join(" ") : [...types].sort((a, b) => b[1] - a[1])[0][0];
      name = `${top} group (${list.length} units)`;
      if (members.has(name)) name = `${name} #${members.size + 1}`;
    }
    members.set(name, list);
    for (const o of list) of.set(o.id, name);
  }
  sitesCache = { key: S.key, of, members };
  return sitesCache;
}

function renderStrike(panel) {
  const all = S.analysis.strikes || [];
  const list = all.filter((x) => !S.shooterFilter || x.launcherId === S.shooterFilter || x.targetId === S.shooterFilter ||
    (x.damage || []).some((d) => d.id === S.shooterFilter));
  const who = S.shooterFilter && S.objects.get(S.shooterFilter);
  if (who) panel.append(el("div", { class: "tabhead" }, filterChip(`Filtered: ${who.pilot || who.name}`, () => { S.shooterFilter = null; renderAllPanels(); })));
  if (!list.length) { panel.append(el("div", { class: "empty" }, "No air-to-ground releases.")); return; }
  // Summary.
  const byType = new Map();
  for (const x of list) byType.set(weaponLabel(x.weaponName), (byType.get(weaponLabel(x.weaponName)) || 0) + 1);
  const destroyed = new Set(list.flatMap((x) => (x.damage || []).map((d) => d.id)));
  const unitary = list.filter((x) => !x.submunitions && isNum(x.missDistance)).map((x) => x.missDistance).sort((a, b) => a - b);
  const median = unitary.length ? unitary[Math.floor(unitary.length / 2)] : null;
  const first = Math.min(...list.map((x) => x.releaseTime)), last = Math.max(...list.map((x) => x.impactTime));
  panel.append(el("div", { class: "section" }, el("h3", {}, "Strike summary"), el("div", { class: "tiles" },
    miniTile("Releases", String(list.length)),
    miniTile("Destroyed", String(destroyed.size)),
    miniTile("Misses", String(list.filter((x) => x.result === "miss").length)),
    miniTile("Median miss", median === null ? "—" : fmtShort(median)),
    miniTile("First → last", `${fmtClock(first - S.start)}–${fmtClock(last - S.start)}`),
    el("div", { class: "tile wide" }, el("div", { class: "k" }, "Weapons"), el("div", { class: "v" }, [...byType].map(([k, n]) => `${n}× ${k}`).join(", "))))));

  // Targets, by ACMI group ("SA-11 site: 3/4 destroyed"), else by proximity.
  const targets = (S.analysis.targets || []).filter((t) => !S.shooterFilter || list.some((x) => x.targetId === t.id || (x.damage || []).some((d) => d.id === t.id)));
  if (targets.length) {
    const sites = surfaceSites();
    const groups = new Map();
    for (const t of targets) {
      const g = sites.of.get(t.id) || "Other targets";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    // Sites first, lone units last.
    const other = groups.get("Other targets");
    if (other) { groups.delete("Other targets"); groups.set("Other targets", other); }
    const box = el("div", { class: "section" }, el("h3", {}, "Targets"));
    const tbl = el("table", { class: "grid targets" }, el("tr", {}, ...["", "Target", "Weapons", "Best miss", "Result"].map((h) => el("th", {}, h))));
    box.append(tbl);
    for (const [g, rows] of groups) {
      const members = sites.members.get(g) || [];
      if (g === "Other targets" && groups.size > 1) tbl.append(el("tr", { class: "tgroup" }, el("td", { colspan: 5 }, el("b", {}, g))));
      if (members.length > 1) {
        const dead = members.filter((o) => S.deaths.has(o.id)).length;
        tbl.append(el("tr", { class: "tgroup" }, el("td", { colspan: 5 }, el("b", {}, g), ` · ${dead}/${members.length} destroyed`,
          members.length > dead && dead > 0 ? el("span", { class: "pill lock", title: "Units of this group survived: candidates for a re-attack" }, "restrike") : "")));
      }
      for (const t of rows) {
        const strikesOn = list.filter((x) => x.targetId === t.id || (x.damage || []).some((d) => d.id === t.id));
        const wcount = new Map();
        for (const x of strikesOn) wcount.set(weaponLabel(x.weaponName), (wcount.get(weaponLabel(x.weaponName)) || 0) + 1);
        const misses = t.weapons.map((x) => x.miss).filter(isNum);
        const thumbStrike = strikesOn.find((x) => x.targetId === t.id) || strikesOn[0];
        tbl.append(el("tr", { class: "click", onclick: () => {
          if (!strikesOn.length) return;
          const a = Math.min(...strikesOn.map((x) => x.releaseTime)) - 10, b = Math.max(...strikesOn.map((x) => x.impactTime)) + 5;
          setLoop(a, b, true); select(t.id); seek(a);
        } },
          el("td", {}, thumbStrike ? buildStrikeThumb(thumbStrike, S.objects, 48) : ""),
          el("td", {}, t.name),
          el("td", {}, [...wcount].map(([k, n]) => `${n}× ${k}`).join(", ") || "—"),
          el("td", { class: "num" }, misses.length ? fmtShort(Math.min(...misses)) : "—"),
          el("td", {}, isNum(t.destroyed) ? [outcomePill("kill"), ` ${fmtClock(t.destroyed - S.start)}`, t.destroyedBy ? el("small", { class: "muted", style: { display: "block" } }, weaponLabel(t.destroyedBy)) : ""]
            : el("span", { class: "muted" }, "survived"))));
      }
    }
    panel.append(box);
  }

  // Passes: releases by one jet within a few seconds of each other.
  const box = el("div", { class: "section" }, el("h3", {}, "Passes"));
  groupPasses(list).forEach((pass, i) => {
    const l = S.objects.get(pass.launcherId);
    const names = new Map();
    for (const x of pass.strikes) names.set(weaponLabel(x.weaponName), (names.get(weaponLabel(x.weaponName)) || 0) + 1);
    box.append(el("div", { class: "pass-h" }, el("b", {}, `Pass ${i + 1}`), ` · ${fmtClock(pass.first - S.start)} · ${l?.pilot || l?.name || "?"} · `,
      [...names].map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(", ")));
    const tbl = el("table", { class: "grid" }, el("tr", {}, ...["", "Weapon", "Target", "TOF", "Miss", "Result"].map((h) => el("th", {}, h))));
    for (const x of pass.strikes) {
      const open = S.openStrikes.has(x.weaponId);
      const toggle = () => { open ? S.openStrikes.delete(x.weaponId) : S.openStrikes.add(x.weaponId); renderAllPanels(); };
      const kills = new Set((x.damage || []).map((d) => d.id)).size;
      tbl.append(el("tr", { class: `click${x.weaponId === S.selected ? " current" : ""}`, onclick: (e) => { if (e.altKey) { toggle(); return; } seek(x.releaseTime - 3); select(x.weaponId); } },
        el("td", { class: "tog", title: "Strike card", onclick: (e) => { e.stopPropagation(); toggle(); } }, open ? "▾" : "▸"),
        el("td", {}, weaponLabel(x.weaponName), el("small", { class: "muted" }, ` ${FAMILY_LABEL[x.family] || ""}`)),
        el("td", {}, x.targetName || "—"),
        el("td", { class: "num" }, `${Math.round(x.timeOfFall)}s`),
        el("td", { class: "num" }, fmtShort(x.missDistance)),
        el("td", {}, el("span", { class: `pill ${x.result === "destroyed" ? "kill" : x.result === "damaged" ? "lock" : "miss"}` }, kills ? `${x.result} · ${kills} K` : x.result),
          isNum(x.dcsHits) && x.dcsHits > 0 ? dcsBadge(`DCS reported ${x.dcsHits} hits`) : "")));
      if (open) tbl.append(el("tr", { class: "shotcard-row strike-anchor", "data-weapon": x.weaponId }, el("td", { colspan: 6 }, strikeCard(x))));
    }
    box.append(tbl);
  });
  panel.append(box);
}

// -- Landings tab -----------------------------------------------------------------

function gradeClass(score) { return score >= 85 ? "" : score >= 65 ? "mid" : "bad"; }

function renderLandings(panel) {
  const onlySel = pref("landSel", "0") === "1";
  panel.append(el("label", { class: "muted", style: { display: "block", marginBottom: "8px" } },
    el("input", { type: "checkbox", checked: onlySel, onchange: (e) => { setPref("landSel", e.target.checked ? "1" : "0"); renderAllPanels(); } }),
    " Only the selected aircraft"));
  const lands = S.analysis.landings.filter((l) => !onlySel || l.aircraftId === S.selected);
  if (!lands.length) panel.append(el("div", { class: "empty" }, "No landings detected."));
  for (const l of lands) {
    const td = l.touchdown || {};
    const card = el("div", { class: "card" });
    card.append(el("div", { class: "card-head" },
      el("div", { class: "t" }, `${l.pilot || l.aircraftName} — ${l.outcome} at ${l.location}`,
        el("small", {}, `${fmtClock(l.time - S.start)} · ${l.kind} · ${fmtDeg(l.referenceGlideslope, 1)} reference${l.confirmedByEvent ? "" : " · detected"}`)),
      el("span", { class: `grade ${gradeClass(l.score)}` }, l.grade)));
    card.append(el("div", { class: "tiles" },
      miniTile("Touchdown", fmtSpeed(td.ias)), miniTile("Sink", units.metric ? `${fmtNum(td.sinkRate, 1)} m/s` : `${Math.round(td.sinkRateFpm ?? NaN) || "—"} fpm`),
      miniTile("AOA", fmtDeg(td.aoa, 1)), miniTile("Crab", fmtDeg(td.crab, 1)), miniTile("Bank", fmtDeg(td.bank, 1)),
      miniTile("Rollout", fmtShort(l.rollout?.distance))));
    if (l.runway) {
      const rw = l.runway;
      const tdz = isNum(l.touchdownFromThreshold) && l.touchdownFromThreshold >= 0 && l.touchdownFromThreshold <= 914;
      card.append(el("div", { class: "tiles", style: { marginTop: "6px" } },
        el("div", { class: "tile", title: `Runway geometry read from DCS: ${Math.round(rw.length)} m × ${Math.round(rw.width)} m, heading ${fmtHdg(rw.heading)}` },
          el("div", { class: "k" }, "Runway", rw.source === "DCS" ? dcsBadge("Runway position, heading and length read from DCS") : ""),
          el("div", { class: "v" }, `${rw.airbase} ${rw.name}`)),
        el("div", { class: "tile", title: "Touchdown distance past the landing threshold (touchdown zone: first 914 m / 3000 ft)" },
          el("div", { class: "k" }, "From threshold"), el("div", { class: `v ${tdz ? "" : "warn"}` }, fmtShort(l.touchdownFromThreshold))),
        el("div", { class: "tile", title: "Runway left ahead when the rollout ended" },
          el("div", { class: "k" }, "Remaining"), el("div", { class: `v ${isNum(l.runwayRemaining) && l.runwayRemaining < 300 ? "danger" : ""}` }, fmtShort(l.runwayRemaining)))));
    }
    const raw = l.profile || {};
    const keep = (raw.distance || []).map((d, i) => (d <= 6 * 1852 ? i : -1)).filter((i) => i >= 0);
    const prof = { t: keep.map((i) => raw.t[i]), distance: keep.map((i) => raw.distance[i]),
      height: keep.map((i) => raw.height[i]), lateral: keep.map((i) => raw.lateral[i]) };
    if (prof.distance.length > 1) {
      const toX = (d) => (units.metric ? d / 1000 : d / 1852);
      const toY = (h) => (units.metric ? h : h * M_TO_FT);
      const xs = prof.distance.map(toX);
      const tan = Math.tan((l.referenceGlideslope * Math.PI) / 180);
      const c1 = el("canvas");
      card.append(c1);
      const gp = new LineChart(c1, { title: "Glidepath", invertX: true, yFormat: (v) => v.toFixed(0), xFormat: (v) => v.toFixed(1) });
      const maxD = Math.min(Math.max(...prof.distance), 6 * 1852);
      gp.setData([
        { name: "flown", color: "#ffd166", x: xs, y: prof.height.map(toY) },
        { name: `${l.referenceGlideslope}°`, color: "#5fd38d", dash: [5, 4], x: [0, toX(maxD)], y: [0, toY(maxD * tan)], readout: false },
      ], { xMin: 0, xMax: toX(maxD), yMin: 0 });
      const c2 = el("canvas");
      card.append(c2);
      const lat = new LineChart(c2, { title: "Centreline (right +)", invertX: true, yFormat: (v) => v.toFixed(0), xFormat: (v) => v.toFixed(1) });
      lat.setData([{ name: "lateral", color: "#4ea8ff", x: xs, y: prof.lateral.map(toY) },
        { name: "", color: "rgba(255,255,255,0.3)", x: [0, toX(maxD)], y: [0, 0], readout: false, legend: false }], { xMin: 0, xMax: toX(maxD) });
      const tAbs = (dist) => {
        let best = 0;
        for (let i = 0; i < prof.distance.length; i++) if (Math.abs(prof.distance[i] - dist) < Math.abs(prof.distance[best] - dist)) best = i;
        return best;
      };
      for (const ch of [gp, lat]) {
        ch._markerFn = (t) => {
          const rel = t - l.time;
          if (rel > 0 || rel < (prof.t[0] ?? 0)) return null;
          let i = bisectRight(prof.t, rel);
          if (i < 0) i = 0;
          return xs[i];
        };
        ch.opts.onSeek = (x) => { const d = units.metric ? x * 1000 : x * 1852; seek(l.time + prof.t[tAbs(d)]); };
        charts.push(ch);
      }
    }
    if (l.gates?.length) {
      const t = el("table", { class: "grid" }, el("tr", {}, ...["Gate", "Height", "GS dev", "Lateral", "Speed", "AOA"].map((h) => el("th", {}, h))));
      for (const g of l.gates) {
        t.append(el("tr", { class: "click", onclick: () => seek(g.time) },
          el("td", { class: "num" }, units.metric ? `${(g.distanceNm * 1.852).toFixed(1)} km` : `${g.distanceNm} nm`),
          el("td", { class: "num" }, fmtAlt(g.height)),
          el("td", { class: "num", style: { color: Math.abs(g.gsDeviationDeg) > 0.7 ? "var(--warn)" : "" } }, `${g.gsDeviationDeg >= 0 ? "+" : ""}${g.gsDeviationDeg.toFixed(2)}°`),
          el("td", { class: "num" }, fmtAlt(g.lateralM)), el("td", { class: "num" }, fmtSpeed(g.ias)), el("td", { class: "num" }, fmtDeg(g.aoa, 1))));
      }
      card.append(t);
    }
    card.append(el("ul", {}, ...(l.comments || []).map((c) => el("li", {}, c))));
    card.append(el("button", { onclick: () => { select(l.aircraftId); seek(l.time - 60); setFollow(true); } }, "Replay approach"));
    panel.append(card);
  }
  const tos = S.analysis.takeoffs.filter((t) => !onlySel || t.aircraftId === S.selected);
  if (tos.length) {
    const t = el("table", { class: "grid" }, el("tr", {}, ...["Time", "Aircraft", "From", "Liftoff", "Roll", "Gear up"].map((h) => el("th", {}, h))));
    for (const x of tos) {
      t.append(el("tr", { class: "click", onclick: () => seek(x.time - 20) },
        el("td", { class: "num" }, fmtClock(x.time - S.start)), el("td", {}, x.pilot || x.aircraftName), el("td", {}, x.location),
        el("td", { class: "num" }, fmtSpeed(x.liftoffIas)), el("td", { class: "num" }, fmtShort(x.groundRollM)),
        el("td", { class: "num" }, isNum(x.gearUpAfterS) ? `+${x.gearUpAfterS.toFixed(1)}s` : "—")));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, "Takeoffs"), t));
  }
}

function miniTile(k, v) { return el("div", { class: "tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v)); }

// -- Radar tab ------------------------------------------------------------------

function renderRadar(panel) {
  const r = S.analysis.radar;
  const t = el("table", { class: "grid" }, el("tr", {}, ...["Start", "Owner", "Target", "Range", "Held", "Ended"].map((h) => el("th", {}, h))));
  for (const ep of r.locks) {
    t.append(el("tr", { class: "click", onclick: () => { seek(ep.start - 2); select(ep.ownerId); } },
      el("td", { class: "num" }, fmtClock(ep.start - S.start)), el("td", {}, ep.ownerPilot || ep.ownerName),
      el("td", {}, ep.targetPilot || ep.targetName || "?"), el("td", { class: "num" }, fmtDist(ep.rangeStart)),
      el("td", { class: "num" }, `${Math.round(ep.duration)}s`), el("td", { class: "muted" }, ep.endedBy)));
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Lock episodes"), r.locks.length ? t : el("div", { class: "empty" }, "No lock data in this recording.")));
  const sp = S.selected && r.spikes[S.selected];
  const o = S.selected && S.objects.get(S.selected);
  if (o) {
    const list = el("div");
    for (const s of sp || []) {
      list.append(el("div", { class: "ev", style: { cursor: "pointer", padding: "3px 0" }, onclick: () => seek(s.start - 2) },
        el("span", { class: "num muted" }, fmtClock(s.start - S.start), "  "), el("b", { class: "k-spiked" }, s.byPilot || s.byName),
        ` at ${fmtDist(s.rangeStart)} for ${Math.round(s.end - s.start)}s${s.shots ? ` · ${s.shots} shot(s)` : ""}`));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, `Who locked ${o.pilot || o.name}`), sp?.length ? list : el("div", { class: "empty" }, "Nobody.")));
  }
  const iv = el("table", { class: "grid" }, el("tr", {}, ...["Radar", "On", "Off", "Max range"].map((h) => el("th", {}, h))));
  for (const x of r.intervals) {
    const ob = S.objects.get(x.ownerId);
    iv.append(el("tr", {}, el("td", {}, ob ? ob.pilot || ob.name : x.ownerId), el("td", { class: "num" }, fmtClock(x.start - S.start)),
      el("td", { class: "num" }, fmtClock(x.end - S.start)), el("td", { class: "num" }, fmtDist(x.maxRange))));
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Emitters"), r.intervals.length ? iv : el("div", { class: "empty" }, "None")));
}

// -- Events tab -------------------------------------------------------------------

function renderEvents(panel) {
  const kinds = [...new Set(S.analysis.timeline.map((e) => e.kind))];
  const chips = el("div", { class: "chips" });
  for (const k of kinds) {
    chips.append(el("button", { class: S.eventFilter.has(k) ? "" : "active", onclick: () => { toggleEventKind(k); renderAllPanels(); } }, k));
  }
  const mine = pref("evMine", "0") === "1";
  panel.append(chips, el("label", { class: "muted", style: { display: "block", marginBottom: "6px" } },
    el("input", { type: "checkbox", checked: mine, onchange: (e) => { setPref("evMine", e.target.checked ? "1" : "0"); renderAllPanels(); } }),
    " Only events involving the selected aircraft"));
  const list = el("div", { class: "timeline-list" });
  for (const it of S.analysis.timeline) {
    if (S.eventFilter.has(it.kind)) continue;
    if (mine && S.selected && !it.objectIds.includes(S.selected)) continue;
    list.append(el("div", { class: "ev", "data-t": it.time, onclick: () => seek(it.time - 3),
      ondblclick: () => { setLoop(it.time - 10, it.time + 20, true); seek(it.time - 10); togglePlay(true); } },
      el("span", { class: "t" }, fmtClock(it.time - S.start)), el("span", { class: `k k-${it.kind}` }, it.kind), el("span", {}, it.text)));
  }
  panel.append(list);
}

// -- All aircraft tab --------------------------------------------------------------

function renderAircraft(panel) {
  const t = el("table", { class: "grid" }, el("tr", {}, ...["Aircraft", "Time", "Max alt", "Max spd", "Max G", "Fuel"].map((h) => el("th", {}, h))));
  for (const a of S.analysis.aircraft) {
    const s = a.stats || {};
    t.append(el("tr", { class: `click${a.id === S.selected ? " current" : ""}`, onclick: () => select(a.id) },
      el("td", {}, el("span", { style: { color: sideColor(a) } }, "● "), a.pilot || a.name, a.pilot ? el("div", { class: "faint" }, a.name) : ""),
      el("td", { class: "num" }, fmtClock(s.duration)), el("td", { class: "num" }, fmtAlt(s.maxAltitude, { suffix: false })),
      el("td", { class: "num" }, fmtSpeed(s.maxIAS ?? s.maxTAS, { suffix: false })), el("td", { class: "num" }, fmtNum(s.maxG, 1)),
      el("td", { class: "num" }, isNum(s.fuelUsed) ? fmtMass(s.fuelUsed) : "—")));
  }
  panel.append(el("div", { class: "muted", style: { marginBottom: "8px" } },
    `Altitude in ${units.metric ? "m" : "ft"}, speed in ${units.metric ? "km/h" : "kt"}. Click a row to select.`), t);
}

init();
