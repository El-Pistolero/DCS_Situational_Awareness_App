// Debrief / review controller.

import {
  api, bisectRight, braa, el, fmtAlt, fmtClock, fmtDeg, fmtDist, fmtHdg, fmtMass, fmtNum,
  fmtPct, fmtSpeed, fmtVs, fmtZulu, isNum, sampleTrack, sideColor, units, distance,
  M_TO_FT, MPS_TO_KT, MPS_TO_FPM,
} from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawScene } from "./symbols.js";
import { LineChart } from "./charts.js";
import { bar, drawADI, drawStick } from "./instruments.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.${k}`, v); } catch { /* ignore */ } };

const S = {
  key: null, analysis: null, playback: null, objects: new Map(), deaths: new Map(),
  t: 0, start: 0, end: 0, playing: false, speed: 4,
  selected: null, me: null, follow: false,
  series: new Map(), trailSec: 90, labels: "aircraft", radar: "focus",
  tab: "flight", status: null, lastPanel: 0, filter: "", eventFilter: new Set(),
};

const map = new TacticalMap($("map"), { layer: pref("layer", "satellite") });

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function init() {
  for (const [k, v] of Object.entries(LAYERS)) $("layerSel").append(el("option", { value: k }, v.label));
  $("layerSel").value = map.layer;
  $("layerSel").onchange = (e) => { map.setLayer(e.target.value); setPref("layer", e.target.value); };
  $("unitSel").value = units.system;
  $("unitSel").onchange = (e) => { units.set(e.target.value); renderAllPanels(); map.invalidate(); };
  $("labelSel").onchange = (e) => { S.labels = e.target.value; map.invalidate(); };
  $("trailSel").onchange = (e) => { S.trailSec = +e.target.value; map.invalidate(); };
  $("radarSel").onchange = (e) => { S.radar = e.target.value; map.invalidate(); };
  $("btnFollow").onclick = () => setFollow(!S.follow);
  $("btnFit").onclick = fitAll;
  $("btnLibrary").onclick = showLibrary;
  $("btnPlay").onclick = togglePlay;
  $("speedSel").onchange = (e) => { S.speed = +e.target.value; };
  $("btnBack").onclick = () => seek(S.t - 10);
  $("btnFwd").onclick = () => seek(S.t + 10);
  $("objFilter").oninput = (e) => { S.filter = e.target.value.toLowerCase(); renderObjectList(); };
  $("btnDebrief").onclick = () => {
    if (S.key) window.open(`/api/recording/${S.key}/markdown${S.me ? `?focus=${S.me}` : ""}`, "_blank");
  };
  document.querySelector('a[href="/live"]').addEventListener("click", async (e) => {
    if (S.status?.desktop) { e.preventDefault(); await api("/api/open-live", { method: "POST" }); }
  });
  setupScrubber();
  setupKeys();
  map.scene = drawMap;
  map.on("click", onMapClick);
  map.on("hover", onMapHover);
  map.on("viewchange", (ev) => { if (ev?.user && S.follow) setFollow(false); });
  renderTabs();

  try { S.status = (await api("/api/status")).body; } catch { /* offline */ }
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get("rec")) loadRecording(hash.get("rec"));
  else showLibrary();
  requestAnimationFrame(tick);
}

function toast(msg) {
  const t = el("div", { class: "toast" }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

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
  );
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
    box.append(el("div", { class: "hint", html:
      `Searched: ${body.dirs.map((d) => `<code>${d.replace(/</g, "&lt;")}</code>`).join(" ")}<br>` +
      "Tacview saves to <code>Documents\\Tacview</code> by default. Enable the recorder in DCS under " +
      "<code>Options → Special → Tacview</code>." }));
  } catch (err) {
    lib.innerHTML = "";
    lib.append(el("div", { class: "empty" }, `Could not list recordings: ${err.message}`));
  }
}

async function upload(file) {
  try {
    const { body } = await api("/api/upload", { method: "POST", headers: { "X-Filename": encodeURIComponent(file.name) }, body: file });
    loadRecording(body.key);
  } catch (err) { toast(`Upload failed: ${err.message}`); }
}

async function loadRecording(key) {
  const w = $("welcome");
  w.classList.remove("hidden");
  w.innerHTML = "";
  const fill = el("div", { class: "fill" });
  const label = el("div", {}, "Loading recording…");
  w.append(el("div", { class: "loading" }, label, el("div", { class: "progressbar" }, fill)));
  try {
    for (;;) {
      const { body } = await api(`/api/recording/${key}/load`);
      fill.style.width = `${Math.round((body.progress || 0) * 100)}%`;
      if (body.state === "ready") break;
      if (body.state === "error") throw new Error(body.error);
      label.textContent = body.state === "analyzing" ? "Analysing…" : "Parsing recording…";
      await new Promise((r) => setTimeout(r, 300));
    }
    const [a, p] = await Promise.all([api(`/api/recording/${key}/analysis`), api(`/api/recording/${key}/playback`)]);
    setupRecording(key, a.body, p.body);
    w.classList.add("hidden");
    history.replaceState(null, "", `#rec=${key}`);
  } catch (err) {
    toast(`Could not load recording: ${err.message}`);
    showLibrary();
  }
}

function setupRecording(key, analysis, playback) {
  S.key = key; S.analysis = analysis; S.playback = playback;
  S.series.clear(); S.objects.clear(); S.deaths.clear();
  for (const o of analysis.objects) {
    const pb = playback.objects[o.id];
    if (pb) S.objects.set(o.id, { ...o, pb });
  }
  for (const k of analysis.weapons.kills) S.deaths.set(k.victimId, k.time);
  S.start = playback.start; S.end = playback.end;
  S.t = S.start;
  S.me = analysis.player;
  $("recTitle").textContent = `${analysis.recording.title} · ${fmtClock(analysis.recording.duration)} · ${analysis.recording.aircraftCount} aircraft`;
  $("btnDebrief").disabled = false;
  renderTicks();
  fitAll();
  select(S.me || analysis.aircraft[0]?.id || null);
  renderAllPanels();
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
    if (S.t >= S.end) { S.t = S.end; togglePlay(false); }
    onTimeChange();
  }
  requestAnimationFrame(tick);
}

function togglePlay(force) {
  S.playing = typeof force === "boolean" ? force : !S.playing;
  if (S.playing && S.t >= S.end) S.t = S.start;
  $("btnPlay").textContent = S.playing ? "❚❚" : "▶";
}

function seek(t) {
  if (!S.analysis) return;
  S.t = Math.max(S.start, Math.min(S.end, t));
  onTimeChange(true);
}

function onTimeChange(force = false) {
  if (S.follow && S.selected) {
    const o = S.objects.get(S.selected);
    const p = o && sampleTrack(o.pb, S.t);
    if (p && isNum(p.lon)) map.setView(p.lon, p.lat);
  }
  map.invalidate();
  updateScrubber();
  const now = performance.now();
  if (force || now - S.lastPanel > 100) {
    S.lastPanel = now;
    updateLivePanels();
  }
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
  let dragging = false;
  sc.addEventListener("pointerdown", (e) => { dragging = true; sc.setPointerCapture(e.pointerId); seek(tAt(e)); });
  sc.addEventListener("pointermove", (e) => {
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
  sc.querySelectorAll(".tick").forEach((n) => n.remove());
  const span = S.end - S.start || 1;
  for (const it of S.analysis.timeline) {
    if (!["kill", "shot", "landing", "takeoff", "lock"].includes(it.kind)) continue;
    if (it.kind === "shot" && it.text.includes(": ")) continue; // outcome rows
    sc.append(el("div", { class: `tick ${it.kind}`, title: `${fmtClock(it.time - S.start)} ${it.text}`,
      style: { left: `${((it.time - S.start) / span) * 100}%` } }));
  }
}

function updateScrubber() {
  const f = (S.t - S.start) / (S.end - S.start || 1);
  document.querySelector(".scrub .progress").style.width = `${f * 100}%`;
  document.querySelector(".scrub .head").style.left = `${f * 100}%`;
  const z = fmtZulu(S.analysis?.recording.referenceTime, S.t);
  $("clock").innerHTML = "";
  $("clock").append(`${fmtClock(S.t - S.start)} / ${fmtClock(S.end - S.start)}`, z ? el("span", { class: "z" }, z) : "");
}

function setupKeys() {
  window.addEventListener("keydown", (e) => {
    if (e.target.matches("input, select, textarea")) return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "ArrowLeft") seek(S.t - (e.shiftKey ? 30 : 5));
    else if (e.key === "ArrowRight") seek(S.t + (e.shiftKey ? 30 : 5));
    else if (e.key === "f" || e.key === "F") setFollow(!S.follow);
    else if (e.key === "]" || e.key === "[") {
      const opts = [...$("speedSel").options].map((o) => +o.value);
      const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(S.speed) + (e.key === "]" ? 1 : -1)));
      S.speed = opts[i]; $("speedSel").value = String(S.speed);
    }
  });
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

function sceneObjects() {
  if (!S.analysis) return [];
  const t = S.t;
  const locks = activeLocks(t);
  const out = [];
  for (const o of S.objects.values()) {
    const p = sampleTrack(o.pb, t);
    if (!p || !isNum(p.lon)) continue;
    const death = S.deaths.get(o.id);
    const dead = isNum(death) && t >= death;
    if (dead && ["fixedwing", "rotorcraft", "air"].includes(o.category) && t > death + 2) continue;
    const row = { ...o, lon: p.lon, lat: p.lat, alt: p.alt, hdg: p.hdg, dead, v: {} };
    // Ground speed from the playback track, for labels.
    const i = p.i, pb = o.pb;
    if (i > 0 && pb.t[i] > pb.t[i - 1]) {
      row.tas = distance(pb.lon[i - 1], pb.lat[i - 1], pb.lon[i], pb.lat[i]) / (pb.t[i] - pb.t[i - 1]);
    }
    if (isNum(pb.eng)) row.v.EngagementRange = pb.eng;
    if (locks.has(o.id)) row.lock = locks.get(o.id);
    if (S.trailSec > 0 && ["fixedwing", "rotorcraft", "air", "weapon"].includes(o.category)) {
      const t0 = t - S.trailSec;
      const a = Math.max(0, bisectRight(pb.t, t0));
      const trail = [];
      for (let k = a; k <= i; k++) if (isNum(pb.lon[k])) trail.push([pb.lon[k], pb.lat[k], pb.alt?.[k]]);
      trail.push([p.lon, p.lat, p.alt]);
      row.trail = trail;
    }
    if (o.id === S.selected || S.radar === "all") {
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

let hitboxes = [];
function drawMap(ctx, m) {
  const objs = sceneObjects();
  hitboxes = drawScene(ctx, m, objs, {
    selectedId: S.selected, focusId: S.me, labels: S.labels, showTrails: S.trailSec > 0, showRadar: S.radar,
  });
}

function onMapClick({ px, py }) {
  let best = null, bd = Infinity;
  for (const h of hitboxes) {
    const d = Math.hypot(h.x - px, h.y - py);
    if (d < h.r && d < bd) { best = h; bd = d; }
  }
  if (best) select(best.id);
}

function onMapHover(ev) {
  const hud = $("hudHover");
  if (!ev || !S.analysis) { hud.classList.add("hidden"); return; }
  const [lon, lat] = ev.lonlat;
  const lines = [`${lat.toFixed(4)}°, ${lon.toFixed(4)}°`];
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
  S.selected = id;
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

function renderObjectList() {
  const list = $("objList");
  list.innerHTML = "";
  if (!S.analysis) return;
  const groups = new Map();
  const statsById = new Map(S.analysis.aircraft.map((a) => [a.id, a]));
  for (const o of S.objects.values()) {
    if (!["fixedwing", "rotorcraft", "air", "ground", "sea", "weapon"].includes(o.category)) continue;
    if (o.category === "weapon" && /Shell|Bullet|Projectile/.test(o.type || "")) continue; // see Weapons tab
    const label = `${o.pilot || ""} ${o.name} ${o.group || ""}`.toLowerCase();
    if (S.filter && !label.includes(S.filter)) continue;
    const g = o.category === "weapon" ? "Weapons" : `${o.coalition || "Unknown"} · ${["ground", "sea"].includes(o.category) ? "surface" : "air"}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(o);
  }
  const order = [...groups.keys()].sort((a, b) => (a === "Weapons") - (b === "Weapons") || a.localeCompare(b));
  for (const g of order) {
    const items = groups.get(g);
    const grp = el("div", { class: "objgroup" }, el("h4", {}, g, el("span", {}, items.length)));
    for (const o of items.slice(0, 300)) {
      const dead = S.deaths.has(o.id) && S.t >= S.deaths.get(o.id);
      const st = statsById.get(o.id)?.stats;
      grp.append(el("div", {
        class: `objrow${o.id === S.selected ? " selected" : ""}${dead ? " dead" : ""}`,
        "data-id": o.id,
        onclick: () => { select(o.id); const p = sampleTrack(o.pb, S.t) || sampleTrack(o.pb, o.pb.t[0]); if (p) map.setView(p.lon, p.lat); },
      },
      el("span", { class: "dot", style: { background: sideColor(o) } }),
      el("span", { class: "nm" }, o.pilot || o.name, o.pilot ? el("small", {}, o.name) : "",
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
  ["flight", "Flight"], ["charts", "Charts"], ["weapons", "Weapons"], ["landings", "Landings"],
  ["radar", "Radar"], ["events", "Events"], ["aircraft", "All aircraft"],
];

function renderTabs() {
  const nav = $("tabs");
  nav.innerHTML = "";
  for (const [id, label] of TABS) {
    const count = !S.analysis ? "" : id === "weapons" ? S.analysis.weapons.shots.length + S.analysis.weapons.bursts.length
      : id === "landings" ? S.analysis.landings.length : id === "events" ? S.analysis.timeline.length
      : id === "radar" ? S.analysis.radar.locks.length : "";
    nav.append(el("button", { class: S.tab === id ? "active" : "", role: "tab", onclick: () => { S.tab = id; renderAllPanels(); } },
      label, count !== "" ? el("span", { class: "count" }, count) : ""));
  }
}

function renderAllPanels() {
  renderTabs();
  renderObjectList();
  const panel = $("tabpanel");
  panel.innerHTML = "";
  charts = [];
  if (!S.analysis) { panel.append(el("div", { class: "empty" }, "Open a recording to begin.")); return; }
  ({ flight: renderFlight, charts: renderCharts, weapons: renderWeapons, landings: renderLandings,
    radar: renderRadar, events: renderEvents, aircraft: renderAircraft })[S.tab](panel);
  updateLivePanels();
}

let charts = [];
let flightEls = null;

function updateLivePanels() {
  if (!S.analysis) return;
  if (S.tab === "flight") updateFlight();
  for (const c of charts) c.setMarker(c._markerFn ? c._markerFn(S.t) : S.t);
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
  const hud = $("hudSel");
  const o = S.selected && S.objects.get(S.selected);
  const p = o && sampleTrack(o.pb, S.t);
  if (p) {
    hud.classList.remove("hidden");
    hud.textContent = `${o.pilot || o.name} · ${fmtHdg(p.hdg)} · ${fmtAlt(p.alt)}${S.follow ? " · following" : ""}`;
  } else hud.classList.add("hidden");
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
    air && o.id !== S.me ? el("button", { onclick: () => { S.me = o.id; renderAllPanels(); map.invalidate(); } }, "This is me") : el("span", { class: "pill on" }, o.id === S.me ? "ME" : o.category)));
  if (!air) {
    panel.append(el("dl", { class: "kv" }, el("dt", {}, "Type"), el("dd", {}, o.type || "—"),
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
  flightEls.stickLabel.textContent = hasInput ? "pilot inputs" : hasSurf ? "control surfaces" :
    "not in this recording — install the DCS bridge for live inputs";

  const th = v.Throttle;
  bar($("bThr"), isNum(th) ? Math.min(th, 1) : th); $("bThrv").textContent = fmtPct(th);
  bar($("bAB"), v.Afterburner); $("bABv").textContent = fmtPct(v.Afterburner);
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
  add("Radar", isNum(v.RadarMode) ? (v.RadarMode > 0 ? `ON · ${fmtDist(v.RadarRange)}` : "OFF") : "—");
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
    add("Position", `${me.lat.toFixed(4)}, ${me.lon.toFixed(4)}`);
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
};
let chartSel = new Set((pref("charts", "Altitude,Speed,AOA,G,Throttle,Energy")).split(","));

function renderCharts(panel) {
  const ser = S.selected && S.series.get(S.selected);
  if (!ser) { panel.append(el("div", { class: "empty" }, "Select an aircraft to chart its telemetry.")); return; }
  const picker = el("div", { class: "chart-picker" });
  for (const name of Object.keys(CHART_DEFS)) {
    const has = CHART_DEFS[name].series.some(([k]) => ser.channels[k]);
    if (!has) continue;
    picker.append(el("button", { class: chartSel.has(name) ? "active" : "", onclick: () => {
      chartSel.has(name) ? chartSel.delete(name) : chartSel.add(name);
      setPref("charts", [...chartSel].join(",")); renderAllPanels();
    } }, name));
  }
  const wrap = el("div", { class: "charts" });
  panel.append(el("div", { class: "muted", style: { marginBottom: "6px" } }, `${ser.summary.pilot || ser.summary.name} — click a chart to jump there`), picker, wrap);
  for (const name of Object.keys(CHART_DEFS)) {
    if (!chartSel.has(name)) continue;
    const def = CHART_DEFS[name];
    const series = def.series.filter(([k]) => ser.channels[k]).map(([k, color]) => ({
      name: k, color, x: ser.t, y: ser.channels[k].map((v) => (isNum(v) ? def.f(v) : null)),
    }));
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

function renderWeapons(panel) {
  const w = S.analysis.weapons;
  const shooters = Object.values(w.byShooter);
  if (shooters.length) {
    const t = el("table", { class: "grid" }, el("tr", {}, ...["Shooter", "Shots", "Kills", "Pk", "Gun"].map((h) => el("th", {}, h))));
    for (const s of shooters) {
      t.append(el("tr", { class: "click", onclick: () => select(s.id) },
        el("td", {}, el("span", { class: "dot", style: { display: "inline-block", width: "8px", height: "8px", borderRadius: "50%", marginRight: "6px", background: sideColor(s) } }), s.pilot || s.name),
        el("td", { class: "num" }, s.shots), el("td", { class: "num" }, s.kills),
        el("td", { class: "num" }, isNum(s.pk) ? `${Math.round(s.pk * 100)}%` : "—"),
        el("td", { class: "num" }, s.gunBursts ? `${s.gunBursts} / ${s.gunRounds}rd` : "—")));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, "Shooters"), t));
  }
  const shots = el("table", { class: "grid" }, el("tr", {}, ...["Time", "Shooter", "Weapon", "Target", "Range", "Result"].map((h) => el("th", {}, h))));
  for (const s of w.shots) {
    const g = s.geometry || {};
    shots.append(el("tr", { class: "click", title: `Aspect ${fmtDeg(g.aspect)} · off-boresight ${fmtDeg(g.offBoresight)} · TOF ${fmtNum(s.timeOfFlight, 1)}s · closest ${fmtDist(s.closestApproach)}`,
      onclick: () => { seek(s.launchTime - 3); if (s.launcherId) select(s.launcherId); } },
      el("td", { class: "num" }, fmtClock(s.launchTime - S.start)),
      el("td", {}, s.launcherPilot || s.launcherName || "?"),
      el("td", {}, s.weaponName),
      el("td", {}, s.targetPilot || s.targetName || "—"),
      el("td", { class: "num" }, fmtDist(g.range)),
      el("td", {}, outcomePill(s.outcome))));
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Missiles, rockets & bombs"), w.shots.length ? shots : el("div", { class: "empty" }, "None")));
  if (w.bursts.length) {
    const b = el("table", { class: "grid" }, el("tr", {}, ...["Time", "Shooter", "Rounds", "Target", "Range", "Result"].map((h) => el("th", {}, h))));
    for (const x of w.bursts) {
      b.append(el("tr", { class: "click", onclick: () => seek(x.start - 2) },
        el("td", { class: "num" }, fmtClock(x.start - S.start)), el("td", {}, x.launcherPilot || x.launcherName),
        el("td", { class: "num" }, x.rounds || "trigger"), el("td", {}, x.targetName || "—"),
        el("td", { class: "num" }, fmtDist(x.rangeAtOpen)), el("td", {}, outcomePill(x.kill ? "kill" : "no kill"))));
    }
    panel.append(el("div", { class: "section" }, el("h3", {}, "Gun"), b));
  }
  const kills = el("div");
  for (const k of w.kills) {
    kills.append(el("div", { class: "ev", style: { padding: "4px 0", cursor: "pointer" }, onclick: () => seek(k.time - 5) },
      el("span", { class: "num muted" }, fmtClock(k.time - S.start), "  "),
      el("b", { class: "k-kill" }, k.victimPilot || k.victimName), " ",
      k.killerId ? `← ${k.killerPilot || k.killerName} (${k.weaponName})` : `destroyed (${k.cause})`));
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Kills & losses"), w.kills.length ? kills : el("div", { class: "empty" }, "None")));
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
      miniTile("Rollout", fmtDist(l.rollout?.distance))));
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
        el("td", { class: "num" }, fmtSpeed(x.liftoffIas)), el("td", { class: "num" }, fmtDist(x.groundRollM)),
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
    chips.append(el("button", { class: S.eventFilter.has(k) ? "" : "active", onclick: () => {
      S.eventFilter.has(k) ? S.eventFilter.delete(k) : S.eventFilter.add(k); renderAllPanels();
    } }, k));
  }
  const mine = pref("evMine", "0") === "1";
  panel.append(chips, el("label", { class: "muted", style: { display: "block", marginBottom: "6px" } },
    el("input", { type: "checkbox", checked: mine, onchange: (e) => { setPref("evMine", e.target.checked ? "1" : "0"); renderAllPanels(); } }),
    " Only events involving the selected aircraft"));
  const list = el("div", { class: "timeline-list" });
  for (const it of S.analysis.timeline) {
    if (S.eventFilter.has(it.kind)) continue;
    if (mine && S.selected && !it.objectIds.includes(S.selected)) continue;
    list.append(el("div", { class: "ev", "data-t": it.time, onclick: () => seek(it.time - 3) },
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
