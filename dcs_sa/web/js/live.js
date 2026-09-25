// Live second-screen view.

import { api, el, fmtAlt, fmtDist, fmtHdg, fmtNum, fmtSpeed, fmtVs, isNum, sideColor, units, M_TO_FT } from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawScene } from "./symbols.js";
import { Scene3D } from "./scene3d.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.live.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.live.${k}`, v); } catch { /* ignore */ } };

const map = new TacticalMap($("map"), { layer: pref("layer", "satellite") });
const S = {
  snap: null, trails: new Map(), rangeNm: +pref("range", 40), headingUp: pref("hdgUp", "1") === "1",
  sound: false, lastMissiles: new Set(), events: [], userPanned: false, panTimer: null,
};

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
}
function setCam(mode) {
  scene3d?.setMode(mode);
  $("btnOrbit").classList.toggle("active", mode === "orbit");
  $("btnChase").classList.toggle("active", mode === "chase");
  setPref("cam", mode);
}
$("btn2d").onclick = () => setView("2d");
$("btn3d").onclick = () => { setView("3d"); setCam(pref("cam", "chase")); };
$("btnOrbit").onclick = () => setCam("orbit");
$("btnChase").onclick = () => setCam("chase");

// -- controls ---------------------------------------------------------------

for (const [k, v] of Object.entries(LAYERS)) $("layerSel").append(el("option", { value: k }, v.label));
$("layerSel").value = map.layer;
$("layerSel").onchange = (e) => { map.setLayer(e.target.value); setPref("layer", e.target.value); };
$("rangeSel").value = String(S.rangeNm);
$("rangeSel").onchange = (e) => { S.rangeNm = +e.target.value; setPref("range", e.target.value); S.userPanned = false; };
const orientLabel = () => { $("btnOrient").textContent = S.headingUp ? "Heading up" : "North up"; };
orientLabel();
$("btnOrient").onclick = () => { S.headingUp = !S.headingUp; setPref("hdgUp", S.headingUp ? "1" : "0"); orientLabel(); if (!S.headingUp) map.setRotation(0); };
$("btnSound").onclick = () => {
  S.sound = !S.sound;
  $("btnSound").textContent = S.sound ? "🔊 Sound" : "🔇 Sound";
  if (S.sound) beep(880, 0.08);
};
map.on("viewchange", (e) => {
  if (!e?.user) return;
  S.userPanned = true;
  clearTimeout(S.panTimer);
  S.panTimer = setTimeout(() => { S.userPanned = false; }, 15000);
});
map.on("click", async ({ px, py }) => {
  let best = null, bd = 16;
  for (const h of hits) { const d = Math.hypot(h.x - px, h.y - py); if (d < bd) { best = h; bd = d; } }
  if (best && S.snap?.objects.find((o) => o.id === best.id && ["fixedwing", "rotorcraft", "air"].includes(o.category))) {
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

// -- setup dialog -------------------------------------------------------------

async function openSetup() {
  const dlg = $("setup");
  try {
    const [{ body: st }, { body: lib }] = await Promise.all([api("/api/status"), api("/api/recordings")]);
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
  dlg.showModal();
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

// -- stream -------------------------------------------------------------------

function connect() {
  const es = new EventSource("/api/live/stream?rate=5");
  es.onmessage = (m) => { try { onSnapshot(JSON.parse(m.data)); } catch (err) { console.error(err); } };
  es.onerror = () => { $("status").textContent = "App not reachable, retrying…"; $("recDot").className = "rec"; };
}

function onSnapshot(snap) {
  S.snap = snap;
  // Maintain trails client-side; the server only sends them occasionally.
  const alive = new Set();
  for (const o of snap.objects) {
    alive.add(o.id);
    let tr = S.trails.get(o.id);
    if (o.trail) { tr = o.trail.slice(); S.trails.set(o.id, tr); }
    else if (["fixedwing", "rotorcraft", "air", "weapon"].includes(o.category)) {
      if (!tr) { tr = []; S.trails.set(o.id, tr); }
      const last = tr[tr.length - 1];
      if (!last || last[0] !== o.lon || last[1] !== o.lat) tr.push([o.lon, o.lat, o.alt]);
      if (tr.length > 400) tr.splice(0, tr.length - 400);
    }
  }
  for (const id of [...S.trails.keys()]) if (!alive.has(id)) S.trails.delete(id);
  for (const e of snap.events) S.events.unshift(e);
  S.events.length = Math.min(S.events.length, 40);

  const st = snap.status || {};
  const bridge = snap.bridge?.state === "receiving" && snap.ownship;
  const live = st.state === "connected" || bridge;
  $("recDot").className = `rec ${live ? (snap.stale && !bridge ? "stale" : "on") : ""}`;
  const parts = [];
  if (st.source) parts.push(`${st.source === "tacview" ? "Tacview" : st.source === "replay" ? "Replay" : st.source}: ${st.state}${st.detail ? ` (${st.detail})` : ""}`);
  if (bridge) parts.push("DCS bridge: receiving");
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
  renderOwn(me, snap.ownship);
  renderThreats(snap.threats);
  renderEvents();
  renderStores(snap.ownship);
  renderRWR(snap.ownship, me);
  map.invalidate();
  if (S.view === "3d" && scene3d) {
    scene3d.update(snap.objects.map((o) => ({
      ...o, pitch: o.v?.Pitch, roll: o.v?.Roll, ias: o.v?.IAS, tas: o.v?.TAS ?? o.d?.gs, trail: S.trails.get(o.id),
    })), { focusId: snap.focus });
  }
}

// -- map ------------------------------------------------------------------------

let hits = [];
map.scene = (ctx, m) => {
  const snap = S.snap;
  if (!snap) return;
  const objs = snap.objects.map((o) => ({
    ...o, ias: o.v?.IAS, tas: o.v?.TAS ?? o.d?.gs, trail: S.trails.get(o.id),
  }));
  const me = objs.find((o) => o.id === snap.focus);
  if (me) drawRangeRings(ctx, m, me);
  hits = drawScene(ctx, m, objs, { focusId: snap.focus, labels: "aircraft", showRadar: "focus" });
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
};

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

function renderOwn(me, own) {
  const box = $("own");
  box.innerHTML = "";
  if (!me && !own) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const s = own?.self || {};
  const v = me?.v || {};
  const d = me?.d || {};
  const ias = v.IAS ?? s.ias, alt = me?.alt ?? s.alt, hdg = me?.hdg ?? s.hdg;
  const aoa = v.AOA ?? s.aoa, g = v.VerticalGForce ?? s.g?.y ?? d.g, mach = v.Mach ?? s.mach;
  const vs = s.vs ?? d.vs;
  const cell = (k, val, cls = "") => [el("div", {}, el("div", { class: "k" }, k), el("div", { class: `v ${cls}` }, val))];
  box.append(
    ...cell("IAS", fmtSpeed(ias, { suffix: false })), ...cell(units.metric ? "ALT m" : "ALT ft", fmtAlt(alt, { suffix: false })),
    ...cell("HDG", fmtHdg(hdg)), ...cell("MACH", fmtNum(mach, 2)),
    ...cell("AOA", isNum(aoa) ? aoa.toFixed(1) : "—", aoa > 20 ? "warn" : ""),
    ...cell("G", fmtNum(g, 1), g > 7.5 ? "danger" : g > 6 ? "warn" : ""),
    ...cell("V/S", fmtVs(vs).replace(" fpm", "").replace(" m/s", "")),
    ...cell("FUEL", isNum(own?.engine?.fuel_internal) ? (units.metric ? `${Math.round(own.engine.fuel_internal)}` : `${Math.round(own.engine.fuel_internal * 2.20462)}`) : isNum(v.FuelWeight) ? (units.metric ? `${Math.round(v.FuelWeight)}` : `${Math.round(v.FuelWeight * 2.20462)}`) : "—"),
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
  if (fresh && S.sound) { beep(1200, 0.15); setTimeout(() => beep(1200, 0.15), 220); }
  const warn = $("warn");
  if (missiles.length) {
    const m = missiles[0];
    warn.textContent = `MISSILE ${m.clock} O'CLOCK${isNum(m.tti) ? ` · ${Math.round(m.tti)}s` : ""}`;
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");

  if (!threats.length) { box.append(el("div", { class: "empty" }, "No threats")); return; }
  for (const t of threats.slice(0, 12)) {
    const tag = t.kind === "missile" ? (isNum(t.tti) ? `${Math.round(t.tti)}s` : "MSL") : t.text || (t.kind === "aircraft" ? "A/C" : t.kind.toUpperCase());
    const alt = isNum(t.altDelta) ? (units.metric ? `${t.altDelta >= 0 ? "+" : ""}${Math.round(t.altDelta)}m` : `${t.altDelta >= 0 ? "+" : ""}${Math.round((t.altDelta * M_TO_FT) / 1000)}k`) : "";
    const who = t.kind === "missile" ? `${t.name}${t.shooterPilot || t.shooter ? ` ← ${t.shooterPilot || t.shooter}` : ""}` : `${t.pilot || t.name}${t.pilot ? ` · ${t.name}` : ""}`;
    const bits = [fmtHdg(t.bearing), fmtDist(t.range), alt];
    if (isNum(t.aspect)) bits.push(`asp ${Math.round(t.aspect)}°`);
    if (isNum(t.closure)) bits.push(`${t.closure >= 0 ? "+" : ""}${fmtSpeed(t.closure, { suffix: false })}`);
    box.append(el("div", { class: `threat l${t.level}` },
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
    box.append(el("div", {}, `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} `,
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
if (pref("view", "2d") === "3d") { setView("3d"); setCam(pref("cam", "chase")); }
