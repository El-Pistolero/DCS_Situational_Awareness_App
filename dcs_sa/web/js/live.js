// Live second-screen view.

import {
  api, bearing, distance, el, fmtAlt, fmtDist, fmtHdg, fmtNum, fmtSpeed, fmtVs, isHostile, isNum, sideColor, units,
  M_TO_FT,
} from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawEdgePointers, drawScene } from "./symbols.js";
import { Scene3D } from "./scene3d.js";
import { bindShortcuts } from "./keys.js";
import { watchRecordings } from "./watch.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.live.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.live.${k}`, v); } catch { /* ignore */ } };
const AIR = ["fixedwing", "rotorcraft", "air"];
const RANGES = [5, 10, 20, 40, 80, 160];
const LB = 2.20462;

const map = new TacticalMap($("map"), { layer: pref("layer", "satellite") });
const S = {
  snap: null, trails: new Map(), rangeNm: +pref("range", 40), headingUp: pref("hdgUp", "1") === "1",
  sound: false, lastMissiles: new Set(), events: [], userPanned: false, panTimer: null,
  radar: pref("radar", "all"), bullets: pref("bullets", "paths"), cam: pref("cam", "chase"),
  glance: pref("glance", "0") === "1", glanceAuto: false, lastMissileAt: 0,
  padlockId: null, hist: [], histKey: null, home: null, homeTried: 0, bingoShown: false,
  bridgeSeen: false, bridgeLostAt: null, seenHits: new Set(), status: null,
};
$("radarSel").value = S.radar;
$("radarSel").onchange = (e) => { S.radar = e.target.value; setPref("radar", S.radar); map.invalidate(); };
$("bulletSel").value = S.bullets;
$("bulletSel").onchange = (e) => { S.bullets = e.target.value; setPref("bullets", S.bullets); map.invalidate(); };

/** Trail plus the current position, without repeating it (the server's trail may already end there). */
function withHead(trail, head) {
  const last = trail[trail.length - 1];
  return last && last[0] === head[0] && last[1] === head[1] ? [...trail] : [...trail, head];
}

/** Live rounds -> the drawable shape roundsAt() produces for recordings. */
function liveRounds(snap) {
  if (S.bullets === "off") return [];
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
      scene3d.onPick = (id) => api("/api/live/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
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
function setRange(nm) {
  S.rangeNm = nm;
  $("rangeSel").value = String(nm);
  setPref("range", String(nm));
  S.userPanned = false;
  clearTimeout(S.panTimer);
  if (S.snap) onSnapshot(S.snap, { redraw: true });
}
$("rangeSel").value = String(S.rangeNm);
$("rangeSel").onchange = (e) => setRange(+e.target.value);
function stepRange(dir) {
  const i = RANGES.indexOf(S.rangeNm);
  const j = Math.max(0, Math.min(RANGES.length - 1, (i < 0 ? 3 : i) + dir));
  setRange(RANGES[j]);
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
function recenter() { S.userPanned = false; clearTimeout(S.panTimer); if (S.snap) onSnapshot(S.snap, { redraw: true }); }
map.on("viewchange", (e) => {
  if (!e?.user) return;
  S.userPanned = true;
  clearTimeout(S.panTimer);
  S.panTimer = setTimeout(() => { S.userPanned = false; }, 15000);
});
map.on("click", async ({ px, py }) => {
  // Edge arrows first: bring that contact into view.
  for (const h of ptrHits) {
    if (Math.hypot(h.x - px, h.y - py) > h.r) continue;
    if (h.item.home) return;
    // Pick the range at which the contact lands inside the arrow rectangle
    // (not just inside the outer ring), and always zoom out at least a step.
    const [fx, fy] = ptrFrom;
    const avail = Math.max(40, Math.hypot(h.x - fx, h.y - fy)) * 0.9;
    const ringPx = Math.min(map.w, map.h) * 0.45;
    const need = ((h.item.range || 0) / 1852) * ringPx / avail;
    const next = RANGES.find((r) => r >= need && r > S.rangeNm) || RANGES[RANGES.length - 1];
    setRange(next);
    return;
  }
  let best = null, bd = 16;
  for (const h of hits) { const d = Math.hypot(h.x - px, h.y - py); if (d < bd) { best = h; bd = d; } }
  if (best && S.snap?.objects.find((o) => o.id === best.id && AIR.includes(o.category))) {
    await api("/api/live/focus", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: best.id }) });
  }
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
// One listener for the threat list: rows are rebuilt five times a second, so a
// per-row onclick would often be lost between mousedown and mouseup.
$("threats").addEventListener("pointerdown", (e) => {
  const row = e.target.closest(".threat[data-id]");
  if (!row) return;
  S.padlockId = row.dataset.id;
  if (S.snap) { renderThreats(S.snap.threats); onSnapshot(S.snap, { redraw: true }); }
});
$("own").addEventListener("dblclick", () => setGlance(!S.glance));
$("autoGlance").checked = pref("autoGlance", "0") === "1";
$("autoGlance").onchange = (e) => setPref("autoGlance", e.target.checked ? "1" : "0");
document.body.classList.toggle("glance", S.glance);
$("btnGlance").classList.toggle("active", S.glance);

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
      el("div", {}, p.found ? `DCS profile: ${p.player || "(no logbook pilot found)"} · bridge ${p.bridgeInstalled ? "installed" : "NOT installed in Export.lua"}` : "DCS Saved Games folder not found on this PC."));
  } catch { /* offline */ }
  if (!dlg.open) dlg.showModal();
}
$("btnSetup").onclick = openSetup;
$("btnSetup2").onclick = openSetup;
const post = (body) => api("/api/live/source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
$("btnTv").onclick = async () => { await post({ type: "tacview", host: $("tvHost").value, port: +$("tvPort").value, password: $("tvPass").value }); $("setup").close(); };
$("btnRp").onclick = async () => { await post({ type: "replay", key: $("rpFile").value, speed: +$("rpSpeed").value }); $("setup").close(); };
$("btnInstall").onclick = async () => {
  try {
    const { body } = await api("/api/install-bridge", { method: "POST" });
    alert(body.ok ? `Installed in:\n${body.installed.join("\n")}\n\nRestart DCS (or the mission) to activate.` : body.error);
  } catch (err) { alert(`Install failed: ${err.message}`); }
  openSetup();
};
$("btnDisc").onclick = async () => { await post({ type: "none" }); S.trails.clear(); };

// -- keyboard -----------------------------------------------------------------------

const LIVE_KEYS = [
  { keys: ["v"], group: "View", label: "2D / 3D", run: () => setView(S.view === "3d" ? "2d" : "3d") },
  { keys: ["c"], group: "View", label: "3D camera: orbit → chase → padlock", when: () => S.view === "3d", run: () => cycleCam() },
  { keys: ["t"], group: "View", label: "Padlock: next threat", run: () => cyclePadlock() },
  { keys: ["+", "="], group: "View", label: "Zoom out (larger range)", run: () => stepRange(1) },
  { keys: ["-"], group: "View", label: "Zoom in (smaller range)", run: () => stepRange(-1) },
  { keys: ["h"], group: "View", label: "Heading-up / north-up", run: () => toggleOrient() },
  { keys: ["n"], group: "View", label: "Re-centre on my jet", run: () => recenter() },
  { keys: ["g"], group: "View", label: "Glance (big-number) layout", run: () => setGlance(!S.glance) },
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

function onSnapshot(snap, { redraw = false } = {}) {
  if (!redraw) {
    if (snap.session !== S.session) {
      // New live session (reconnect / mission restart): start clean.
      S.session = snap.session;
      S.events = [];
      S.trails.clear();
      S.lastMissiles = new Set();
      S.hist = []; S.home = null; S.homeTried = 0; S.bingoShown = false; S.seenHits.clear();
    }
    S.snap = snap;
    // Maintain trails client-side; the server only sends them occasionally.
    const alive = new Set();
    for (const o of snap.objects) {
      alive.add(o.id);
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
    for (const e of snap.events) {
      // DCS hit runs are updated in place (same id, higher seq): replace the row.
      const i = isNum(e.id) ? S.events.findIndex((x) => x.id === e.id) : -1;
      if (i >= 0) S.events.splice(i, 1);
      S.events.unshift(e);
      if (e.againstMe && e.kind === "DCS hit" && !S.seenHits.has(e.id ?? e.seq)) {
        S.seenHits.add(e.id ?? e.seq);
        // Opening the page mid-mission replays old events: only alert on new hits.
        if (!isNum(snap.time) || !isNum(e.time) || snap.time - e.time < 5) flashHit(e);
      }
    }
    S.events.length = Math.min(S.events.length, 40);
  }

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
  $("empty").classList.toggle("hidden", snap.objects.length > 0);

  const me = snap.objects.find((o) => o.id === snap.focus);
  if (me) {
    if (S.headingUp && isNum(me.hdg)) map.setRotation(me.hdg); else if (!S.headingUp) map.setRotation(0);
    if (!S.userPanned) {
      const px = Math.min(map.w, map.h) * 0.45;
      map.setView(me.lon, me.lat, map.zoomForRange(S.rangeNm * 1852, px));
    }
  }
  if (!redraw) pushHist(me, snap.ownship, snap);
  updateHome(me, snap.ownship);
  renderOwn(me, snap.ownship);
  renderThreats(snap.threats);
  renderEvents();
  renderStores(snap.ownship);
  renderRWR(snap.ownship, me);
  if (S.glanceAuto && Date.now() - S.lastMissileAt > 15000) setGlance(false);
  map.invalidate();
  if (S.view === "3d" && scene3d) {
    scene3d.update(snap.objects.map((o) => ({
      ...o, pitch: o.v?.Pitch, roll: o.v?.Roll, ias: o.v?.IAS, tas: o.v?.TAS ?? o.d?.gs, trail: S.trails.get(o.id),
    })), { focusId: snap.focus, radar: S.glance ? "focus" : S.radar, rounds: liveRounds(snap), padlockId: S.cam === "padlock" ? padlockTarget(snap) : null });
    scene3d.setPointers(pointerList(snap).map((p) => ({ id: p.id, color: p.color, text: p.text })));
  }
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
  if (S.snap) { renderThreats(S.snap.threats); onSnapshot(S.snap, { redraw: true }); }
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
    const text = missile ? `${t.name} ${fmtDist(t.range)}${isNum(t.tti) ? ` ${Math.round(t.tti)}s` : ""}`
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

// -- map ------------------------------------------------------------------------

let hits = [];
let ptrHits = [];
let ptrFrom = [0, 0];
map.scene = (ctx, m) => {
  const snap = S.snap;
  if (!snap) return;
  const objs = snap.objects.map((o) => ({
    ...o, ias: o.v?.IAS, tas: o.v?.TAS ?? o.d?.gs, trail: S.trails.get(o.id),
  }));
  const me = objs.find((o) => o.id === snap.focus);
  if (me) drawRangeRings(ctx, m, me);
  hits = drawScene(ctx, m, objs, { focusId: snap.focus, labels: S.glance ? "minimal" : "aircraft",
    showRadar: S.glance ? "focus" : S.radar, rounds: liveRounds(snap) });
  // Threat lines from inbound missiles to me.
  if (me) {
    ctx.save();
    ctx.setLineDash([3, 4]);
    for (const t of snap.threats) {
      if (t.kind !== "missile") continue;
      const o = objs.find((x) => x.id === t.id);
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
  // Keep the arrows below the ownship strip and missile warning.
  const own = $("own");
  const top = own && !own.classList.contains("hidden") ? own.offsetTop + own.offsetHeight + 16 : 22;
  ptrHits = drawEdgePointers(ctx, m, from, list, { top, right: 22, bottom: 36, left: 22 });
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
  const step = S.rangeNm / 4;
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.font = "11px ui-monospace, monospace";
  ctx.lineWidth = 1;
  for (let i = 1; i <= 4; i++) {
    const r = (step * i * 1852) / mpp;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(units.metric ? `${Math.round(step * i * 1.852)}` : `${step * i}`, x + 4, y - r - 3);
  }
  // Compass ticks on the outer ring.
  const R = (S.rangeNm * 1852) / mpp;
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

// -- panels -----------------------------------------------------------------------

function trend(rate, { dead, fast, levels, fmt }) {
  if (!isNum(rate) || Math.abs(rate) < dead) return "";
  const n = levels ? 1 + levels.filter((l) => Math.abs(rate) > l).length : 1;
  const arrow = (rate > 0 ? "▲" : "▼").repeat(n);
  const cls = `trend ${rate > 0 ? "up" : "down"}${isNum(fast) && rate < fast ? " fast" : ""}`;
  return el("span", { class: cls }, `${arrow}${fmt ? fmt(Math.abs(rate)) : ""}`);
}

function renderOwn(me, own) {
  const box = $("own");
  box.innerHTML = "";
  if (!me && !own) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  // Bridge values describe the player's own jet: use them only when that is
  // the aircraft in focus, never mixed with a wingman's numbers.
  const mine = !me || !S.snap?.ownId || me.id === S.snap.ownId;
  if (!mine) own = null;
  const s = own?.self || {};
  const v = me?.v || {};
  const d = me?.d || {};
  const ias = v.IAS ?? s.ias, alt = me?.alt ?? s.alt, hdg = me?.hdg ?? s.hdg;
  const aoa = v.AOA ?? s.aoa, g = v.VerticalGForce ?? s.g?.y ?? d.g, mach = v.Mach ?? s.mach;
  const vs = s.vs ?? d.vs;
  const tas = v.TAS ?? s.tas ?? d.gs;
  const cell = (k, val, cls = "", extra = "") => [el("div", {}, el("div", { class: "k" }, k), el("div", { class: `v ${cls}` }, val, extra))];

  // Trends: IAS rate (kt/s or km/h per s), climb arrows, specific excess power.
  const dIas = slope("ias", 3), dTas = slope("tas", 3);
  // Thresholds in m/s (1 kt/s shown, red below -5 kt/s); only the number is converted.
  const iasTrend = trend(dIas, { dead: 0.514, fast: -2.57, fmt: (x) => Math.round(x * (units.metric ? 3.6 : 1.943844)) });
  const altTrend = trend(isNum(vs) ? vs * 196.85 : null, { dead: 300, levels: [3000, 10000] });
  const ps = isNum(vs) && isNum(tas) && isNum(dTas) ? vs + (tas / 9.80665) * dTas : null;
  const psTxt = isNum(ps) ? `${ps >= 0 ? "+" : ""}${Math.round(units.metric ? ps : ps * M_TO_FT)}` : "—";
  const psCls = isNum(ps) ? (ps * M_TO_FT > 10 ? "good" : ps * M_TO_FT < -10 ? "bad" : "") : "";

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

  if (S.glance) {
    box.append(
      ...cell("IAS", fmtSpeed(ias, { suffix: false }), "", iasTrend),
      ...cell(units.metric ? "ALT m" : "ALT ft", fmtAlt(alt, { suffix: false }), "", altTrend),
      ...cell("G", fmtNum(g, 1), g > 7.5 ? "danger" : g > 6 ? "warn" : ""),
      ...cell(units.metric ? "FUEL kg" : "FUEL lb", fuelTxt, fuelCls),
    );
    return;
  }
  box.append(
    ...cell("IAS", fmtSpeed(ias, { suffix: false }), "", iasTrend),
    ...cell(units.metric ? "ALT m" : "ALT ft", fmtAlt(alt, { suffix: false }), "", altTrend),
    ...cell("HDG", fmtHdg(hdg)), ...cell("MACH", fmtNum(mach, 2)),
    ...cell("AOA", isNum(aoa) ? aoa.toFixed(1) : "—", aoa > 20 ? "warn" : ""),
    ...cell("G", fmtNum(g, 1), g > 7.5 ? "danger" : g > 6 ? "warn" : ""),
    ...cell("V/S", fmtVs(vs).replace(" fpm", "").replace(" m/s", "")),
    ...cell(units.metric ? "Ps m/s" : "Ps ft/s", psTxt, psCls),
    ...cell(units.metric ? "FUEL kg" : "FUEL lb", fuelTxt, fuelCls),
  );
  const cfg = el("div", { class: "cfg" });
  const gear = own?.mech?.gear ?? v.LandingGear, flaps = own?.mech?.flaps ?? v.Flaps, brk = own?.mech?.speedbrakes ?? v.AirBrakes;
  if (isNum(gear)) cfg.append(el("span", {}, "Gear ", el("b", {}, gear > 0.95 ? "DOWN" : gear < 0.05 ? "UP" : "TRANSIT")));
  if (isNum(flaps)) cfg.append(el("span", {}, "Flaps ", el("b", {}, `${Math.round(flaps * 100)}%`)));
  if (isNum(brk) && brk > 0.05) cfg.append(el("span", {}, "Brake ", el("b", {}, "OUT")));
  if (own?.cm) cfg.append(el("span", {}, "CHF ", el("b", {}, own.cm.chaff ?? "—"), " FLR ", el("b", {}, own.cm.flare ?? "—")));
  const c = own?.controls;
  if (c && isNum(c.pitch)) cfg.append(el("span", {}, "Stick ", el("b", {}, `${c.pitch >= 0 ? "+" : ""}${c.pitch.toFixed(2)} / ${c.roll >= 0 ? "+" : ""}${(c.roll ?? 0).toFixed(2)}`)));
  if (me?.pilot || s.pilot) cfg.append(el("span", {}, el("b", {}, me?.pilot || s.pilot), ` · ${me?.name || s.name || ""}`));
  box.append(cfg);
}

function renderThreats(threats) {
  const box = $("threats");
  box.innerHTML = "";
  const missiles = threats.filter((t) => t.kind === "missile" && t.level >= 3);
  const ids = new Set(missiles.map((m) => m.id));
  const fresh = [...ids].some((id) => !S.lastMissiles.has(id));
  S.lastMissiles = ids;
  if (missiles.length) S.lastMissileAt = Date.now();
  if (fresh && S.sound) { beep(1200, 0.15); setTimeout(() => beep(1200, 0.15), 220); }
  // Deferred: setGlance re-renders this list.
  if (fresh && !S.glance && pref("autoGlance", "0") === "1") queueMicrotask(() => setGlance(true, { auto: true }));
  const warn = $("warn");
  if (missiles.length) {
    const m = missiles[0];
    warn.textContent = `MISSILE ${m.clock} O'CLOCK${isNum(m.tti) ? ` · ${Math.round(m.tti)}s` : ""}`;
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");

  if (!threats.length) { box.append(el("div", { class: "empty" }, "No threats")); return; }
  const pad = S.cam === "padlock" && S.snap ? padlockTarget(S.snap) : S.padlockId;
  for (const t of threats.slice(0, S.glance ? 3 : 12)) {
    const tag = t.kind === "missile" ? (isNum(t.tti) ? `${Math.round(t.tti)}s` : "MSL") : t.text || (t.kind === "aircraft" ? "A/C" : t.kind.toUpperCase());
    const alt = isNum(t.altDelta) ? (units.metric ? `${t.altDelta >= 0 ? "+" : ""}${Math.round(t.altDelta)}m` : `${t.altDelta >= 0 ? "+" : ""}${Math.round((t.altDelta * M_TO_FT) / 1000)}k`) : "";
    const who = t.kind === "missile" ? `${t.name}${t.shooterPilot || t.shooter ? ` ← ${t.shooterPilot || t.shooter}` : ""}` : `${t.pilot || t.name}${t.pilot ? ` · ${t.name}` : ""}`;
    const bits = [fmtHdg(t.bearing), fmtDist(t.range), alt];
    if (isNum(t.aspect)) bits.push(`asp ${Math.round(t.aspect)}°`);
    if (isNum(t.closure)) bits.push(`${t.closure >= 0 ? "+" : ""}${fmtSpeed(t.closure, { suffix: false })}`);
    box.append(el("div", { class: `threat l${t.level}${t.id === pad ? " pad" : ""}`, title: "Click to padlock this contact in 3D", "data-id": t.id },
      el("div", { class: "clock" }, `${t.clock}`, el("small", {}, "o'clock")),
      el("div", { class: "what" }, el("b", {}, who), el("span", {}, bits.filter(Boolean).join(" · "))),
      el("span", { class: "tag" }, tag)));
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
  void me; void sideColor;
}

connect();
if (pref("view", "2d") === "3d") setView("3d");
