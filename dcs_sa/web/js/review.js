// Debrief / review controller.

import {
  api, aspectDeg, bearing, bisectRight, braa, el, fmtAlt, fmtClock, fmtDeg, fmtDist, fmtHdg, fmtMass, fmtNum, fmtShort,
  fmtPct, fmtSpeed, fmtVs, fmtZulu, isHostile, isNum, radarAt, rampColor, rampCss, roundsAt, sampleTrack,
  sideColor, slantRange, units, distance, M_TO_FT, MPS_TO_KT, MPS_TO_FPM,
} from "./util.js";
import { LAYERS, TacticalMap } from "./map.js";
import { drawEdgePointers, drawScene, radarVolume } from "./symbols.js";
import { LineChart } from "./charts.js";
import { bar, drawADI, drawStick } from "./instruments.js";
import { Scene3D } from "./scene3d.js";
import { bindShortcuts } from "./keys.js";
import { buildShotCard } from "./shotcard.js";
import { watchRecordings } from "./watch.js";

const $ = (id) => document.getElementById(id);
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.${k}`, v); } catch { /* ignore */ } };

const S = {
  key: null, analysis: null, playback: null, objects: new Map(), deaths: new Map(),
  t: 0, start: 0, end: 0, playing: false, speed: 4,
  selected: null, me: null, follow: false,
  series: new Map(), trailSec: 90, labels: "aircraft", radar: pref("radar", "all"), bullets: pref("bullets", "paths"),
  rounds: [], roundLife: 8,
  tab: "flight", status: null, lastPanel: 0, filter: "", eventFilter: new Set(),
  loop: { a: null, b: null, on: false }, padlockId: null, cam: pref("cam", "orbit"),
  tapes: [], tapeDraft: null, trailColor: pref("trailColor", "side"), trailSeries: new Map(),
  openShots: new Set(), keys: null,
};
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
      scene3d.setMode(S.cam);
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
  $("radarSel").value = S.radar;
  $("radarSel").onchange = (e) => { S.radar = e.target.value; setPref("radar", S.radar); onTimeChange(true); };
  $("bulletSel").value = S.bullets;
  $("bulletSel").onchange = (e) => { S.bullets = e.target.value; setPref("bullets", S.bullets); onTimeChange(true); };
  $("btnFollow").onclick = () => setFollow(!S.follow);
  $("btn2d").onclick = () => setView("2d");
  $("btn3d").onclick = () => setView("3d");
  $("btnOrbit").onclick = () => setCam("orbit");
  $("btnChase").onclick = () => setCam("chase");
  $("btnPadlock").onclick = () => setCam("padlock");
  $("trailColorSel").value = S.trailColor;
  $("trailColorSel").onchange = (e) => setTrailColor(e.target.value);
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
    const i = tapeNear(ev.px, ev.py);
    if (i < 0) return;
    ev.event.preventDefault();
    S.tapes.splice(i, 1);
    renderTapeHud(); map.invalidate();
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
  watchRecordings({
    host: document.querySelector(".mapwrap"), placement: "top",
    openHere: (key) => loadRecording(key),
    isIdle: () => !S.analysis || !S.playing,
  });
  // Test hook (?debug): symbol hitboxes and the map, for browser tests.
  if (new URLSearchParams(location.search).has("debug")) window.__dcsSA = { hitboxes: () => hitboxes, map, S };
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
  S.trailSeries.clear(); trailCache.clear(); trailRanges.clear(); stopsCache = null;
  S.loop = { a: null, b: null, on: false }; S.padlockId = null; S.tapes = []; S.tapeDraft = null;
  S.openShots.clear();
  renderTapeHud();
  for (const o of analysis.objects) {
    const pb = playback.objects[o.id];
    if (pb) S.objects.set(o.id, { ...o, pb });
  }
  for (const k of analysis.weapons.kills) S.deaths.set(k.victimId, k.time);
  S.rounds = playback.rounds || [];
  S.roundLife = Math.max(1, ...S.rounds.map((r) => (r.end ?? r.t[r.t.length - 1]) - r.t[0]));
  if (playback.roundsTruncated) toast(`Showing the first ${S.rounds.length} of ${playback.roundsTotal} gun rounds.`);
  S.start = playback.start; S.end = playback.end;
  S.t = S.start;
  S.me = analysis.player;
  $("recTitle").textContent = `${analysis.recording.title} · ${fmtClock(analysis.recording.duration)} · ${analysis.recording.aircraftCount} aircraft`;
  $("btnDebrief").disabled = false;
  renderTicks();
  fitAll();
  select(S.me || analysis.aircraft[0]?.id || null);
  renderAllPanels();
  if (pref("view", "2d") === "3d") { setView("3d"); setCam(S.cam); }
  updateLoopBand();
  setTrailColor(S.trailColor);
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
  if (S.view === "3d" && scene3d && S.analysis) {
    scene3d.follow = true;
    const focus = S.selected || S.me;
    scene3d.update(sceneObjects(), { focusId: focus, selectedId: S.selected, radar: S.radar, rounds: currentRounds(),
      padlockId: S.cam === "padlock" ? padlockTarget() : null });
    scene3d.setPointers(threatsAt(S.t, focus));
  }
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
  let dragging = false, painting = null;
  sc.addEventListener("pointerdown", (e) => {
    sc.setPointerCapture(e.pointerId);
    if (e.shiftKey && S.analysis) { painting = { a: tAt(e), b: tAt(e) }; updateLoopBand(painting); return; }
    dragging = true; seek(tAt(e));
  });
  sc.addEventListener("pointerup", () => {
    if (!painting) return;
    const { a, b } = painting;
    painting = null;
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
  updateLoopBand();
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
  if (!TABS[n - 1]) return;
  S.tab = TABS[n - 1][0];
  renderAllPanels();
}

function stepAircraft(dir) {
  const ids = [...document.querySelectorAll(".objrow[data-id]")].map((r) => r.dataset.id)
    .filter((id) => AIR.includes(S.objects.get(id)?.category));
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
  { keys: ["Escape"], group: "View", label: "Clear tapes, leave the measure tool", when: () => S.tapes.length > 0 || map.tool === "measure",
    run: () => { setMeasure(false); S.tapes = []; renderTapeHud(); map.invalidate(); } },
  { keys: ["j", "k"], group: "Selection", label: "Next / previous aircraft", run: (e) => stepAircraft(e.key.toLowerCase() === "j" ? 1 : -1) },
  { keys: ["/"], group: "Selection", label: "Filter objects", run: () => $("objFilter").focus() },
  ...TABS_KEYS(),
  { keys: ["Ctrl+o"], group: "Panels", label: "Recordings library", run: () => showLibrary() },
];

function TABS_KEYS() {
  const labels = ["Flight", "Charts", "Weapons", "Landings", "Radar", "Events", "All aircraft"];
  return labels.map((name, i) => ({
    keys: [String(i + 1)], group: "Panels", label: `Tabs: ${labels.join(", ")}`, keysLabel: "1–7",
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

function stepEvent(dir) {
  if (!S.analysis) return;
  const stops = eventStops();
  const stop = dir > 0 ? stops.find((x) => x.time > S.t + 3.5) : [...stops].reverse().find((x) => x.time < S.t + 2.5);
  togglePlay(false);
  if (!stop) { showChip(null); return; }
  seek(stop.time - 3);
  showChip(stop);
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

function setLoop(a, b, on) {
  const cl = (x) => (isNum(x) ? Math.max(S.start, Math.min(S.end, x)) : null);
  S.loop = { a: cl(a), b: cl(b), on: !!on };
  if (isNum(S.loop.a) && isNum(S.loop.b) && S.loop.a > S.loop.b) [S.loop.a, S.loop.b] = [S.loop.b, S.loop.a];
  updateLoopBand();
}
function setLoopPoint(which) {
  if (!S.analysis) return;
  const l = { ...S.loop, [which]: S.t };
  setLoop(l.a, l.b, isNum(l.a) && isNum(l.b) ? true : l.on);
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
  let best = null, bd = Infinity;
  for (const h of hitboxes) {
    const d = Math.hypot(h.x - px, h.y - py);
    if (d < h.r && d < bd) { best = h; bd = d; }
  }
  return best ? { id: best.id } : null;
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
  hud.innerHTML = "";
  hud.classList.toggle("hidden", !S.tapes.length);
  S.tapes.forEach((tape, i) => {
    const L = S.analysis ? tapeLabel(tape, S.t) : null;
    hud.append(el("div", { class: "row" }, el("span", { class: "sw", style: { background: tape.color } }),
      el("span", {}, L?.short || "tape"),
      el("button", { class: "ghost", title: "Delete this tape", onclick: () => { S.tapes.splice(i, 1); renderTapeHud(); map.invalidate(); } }, "×")));
  });
}

// -- trail colours ------------------------------------------------------------------------

const TRAIL_MODES = {
  side: null,
  alt: { title: "Altitude", kind: "seq" },
  speed: { title: "Speed", kind: "seq" },
  g: { title: "G", kind: "limit", lo: 0, hi: 9, limit: 7.5, channel: "GLoad" },
  ps: { title: "Ps", kind: "div", lo: -60, hi: 60, limit: 3, channel: "Ps" },
  aoa: { title: "AOA", kind: "limit", lo: 0, hi: 25, limit: 20, channel: "AOA" },
};
const trailCache = new Map();
const trailRanges = new Map();

function setTrailColor(mode) {
  S.trailColor = TRAIL_MODES[mode] !== undefined ? mode : "side";
  $("trailColorSel").value = S.trailColor;
  setPref("trailColor", S.trailColor);
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
  return rampColor(vals[k], range[0], range[1], def.kind, def.limit);
}

function updateLegend() {
  const box = $("trailLegend");
  const def = TRAIL_MODES[S.trailColor];
  if (!def || !S.analysis) { box.classList.add("hidden"); return; }
  const [lo, hi] = trailRange(S.trailColor);
  const ends = {
    alt: [fmtAlt(lo, { suffix: false }), fmtAlt(hi)],
    speed: [fmtSpeed(lo, { suffix: false }), fmtSpeed(hi)],
    g: ["0", "9 g"],
    ps: units.metric ? ["−60", "+60 m/s"] : ["−200", "+200 ft/s"],
    aoa: ["0°", "25°"],
  }[S.trailColor];
  const note = { g: " (magenta > 7.5)", aoa: " (magenta > 20°)", ps: " (grey = sustaining)" }[S.trailColor] || "";
  box.innerHTML = "";
  box.append(el("div", {}, `${def.title} ${ends[0]} ${S.trailColor === "ps" ? "…" : "–"} ${ends[1]}${note}`),
    el("div", { class: "legend-bar", style: { background: rampCss(def.kind) } }),
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
    const row = { ...o, lon: p.lon, lat: p.lat, alt: p.alt, hdg: p.hdg, pitch: p.pitch, roll: p.roll, dead, v: {} };
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
    const rad = S.radar !== "none" ? radarAt(pb, i, t) : null;
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

let hitboxes = [];
function drawMap(ctx, m) {
  const objs = sceneObjects();
  hitboxes = drawScene(ctx, m, objs, {
    selectedId: S.selected, focusId: S.me, labels: S.labels, showTrails: S.trailSec > 0, showRadar: S.radar,
    rounds: currentRounds(),
  });
  if (S.follow && S.analysis) {
    const focus = S.selected || S.me;
    const me = objs.find((o) => o.id === focus);
    const from = me ? m.project(me.lon, me.lat) : [m.w / 2, m.h / 2];
    // Keep the arrows clear of the map tools column on the right.
    const tools = document.querySelector(".map-tools")?.getBoundingClientRect();
    drawEdgePointers(ctx, m, from, threatsAt(S.t, focus), { top: 48, right: tools ? tools.width + 22 : 22, bottom: 40, left: 22 });
  }
  if (S.tapes.length || S.tapeDraft) drawTapes(ctx, m);
  if (S.tapes.length && Math.abs((S._tapeHudT ?? -1e9) - S.t) > 0.5) { S._tapeHudT = S.t; renderTapeHud(); }
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
        onclick: (e) => {
          if (e.shiftKey) { setPadlock(o.id); return; }
          select(o.id); const p = sampleTrack(o.pb, S.t) || sampleTrack(o.pb, o.pb.t[0]); if (p) map.setView(p.lon, p.lat);
        },
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
  for (const [idx, [id, label]] of TABS.entries()) {
    const count = !S.analysis ? "" : id === "weapons" ? S.analysis.weapons.shots.length + S.analysis.weapons.bursts.length
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
    const lockMode = ser.channels.LockedTargetMode;
    const series = def.series.filter(([k]) => ser.channels[k]).map(([k, color]) => ({
      name: k, color, x: ser.t,
      // Locked-target values are held after the lock drops; show them only while locked.
      y: ser.channels[k].map((v, i) => (isNum(v) && !(k.startsWith("LockedTarget") && lockMode && !(lockMode[i] > 0)) ? def.f(v) : null)),
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

function dcsBadge(title = "Reported by DCS itself") { return el("span", { class: "dcs-badge", title }, "DCS"); }

function replayShot(shot) {
  setLoop(shot.launchTime - 5, (shot.endTime ?? shot.launchTime) + 3, true);
  const who = shot.targetId && S.objects.has(shot.targetId) ? shot.targetId : shot.launcherId;
  if (who) select(who);
  if (S.trailSec === 0 || S.trailSec === 30) { S.trailSec = 90; $("trailSel").value = "90"; }
  seek(shot.launchTime - 5);
  togglePlay(true);
}

function renderWeapons(panel) {
  const w = S.analysis.weapons;
  const dcs = S.analysis.dcs;
  if (dcs) {
    panel.append(el("div", { class: "dcs-note" }, dcsBadge(),
      ` Hits and kills below are read from DCS (flight log ${dcs.log}: ${dcs.hits ?? 0} hits, ${dcs.kills ?? 0} kills`,
      dcs.killsCorrected ? `, ${dcs.killsCorrected} kill credit corrected` : "", dcs.killsAdded ? `, ${dcs.killsAdded} added` : "",
      `). Clock offset ${dcs.offset >= 0 ? "+" : ""}${dcs.offset.toFixed(1)} s, flight paths agree to ${Math.round(dcs.medianError)} m.`));
  }
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
  const shots = el("table", { class: "grid" }, el("tr", {}, ...["", "Time", "Shooter", "Weapon", "Target", "Range", "Result"].map((h) => el("th", {}, h))));
  for (const s of w.shots) {
    const g = s.geometry || {};
    const key = s.weaponId || `t${s.launchTime}`;
    const open = S.openShots.has(key);
    const toggle = () => { open ? S.openShots.delete(key) : S.openShots.add(key); renderAllPanels(); };
    shots.append(el("tr", { class: "click", title: `Aspect ${fmtDeg(g.aspect)} · off-boresight ${fmtDeg(g.offBoresight)} · TOF ${fmtNum(s.timeOfFlight, 1)}s · closest ${fmtDist(s.closestApproach)}`,
      onclick: (e) => { if (e.altKey) { toggle(); return; } seek(s.launchTime - 3); if (s.launcherId) select(s.launcherId); } },
      el("td", { class: "tog", title: "Why did it hit / miss?", onclick: (e) => { e.stopPropagation(); toggle(); } }, open ? "▾" : "▸"),
      el("td", { class: "num" }, fmtClock(s.launchTime - S.start)),
      el("td", {}, s.launcherPilot || s.launcherName || "?"),
      el("td", {}, s.weaponName),
      el("td", {}, s.targetPilot || s.targetName || "—"),
      el("td", { class: "num" }, fmtDist(g.range)),
      el("td", {}, outcomePill(s.outcome), s.dcsHit ? dcsBadge(`DCS reported a hit on ${s.dcsHit}`) : s.dcsConfirmed ? dcsBadge("DCS reported this launch") : "")));
    if (open) {
      const card = buildShotCard(s, { objects: S.objects, start: S.start, seek, onReplay: replayShot, charts });
      shots.append(el("tr", { class: "shotcard-row" }, el("td", { colspan: 7 }, card)));
    }
  }
  panel.append(el("div", { class: "section" }, el("h3", {}, "Missiles, rockets & bombs"), w.shots.length ? shots : el("div", { class: "empty" }, "None")));
  if (w.bursts.length) {
    const hasDcs = w.bursts.some((x) => isNum(x.dcsHits));
    const heads = ["Time", "Shooter", "Rounds", "On target", ...(hasDcs ? ["DCS hits"] : []), "Target", "Range", "Result"];
    const b = el("table", { class: "grid" }, el("tr", {}, ...heads.map((h) => el("th", { title: h === "DCS hits" ? "Hits DCS itself reported for this burst" : h === "On target" ? "Rounds whose recorded path passed within 12 m of the target" : null }, h))));
    for (const x of w.bursts) {
      const hits = isNum(x.roundsOnTarget) && x.rounds ? `${x.roundsOnTarget} (${Math.round((100 * x.roundsOnTarget) / x.rounds)}%)` : "—";
      const dcsTargets = x.dcsHitTargets ? Object.entries(x.dcsHitTargets).map(([k, v]) => `${k} ×${v}`).join(", ") : "";
      b.append(el("tr", {
        class: "click",
        title: [x.weaponName, isNum(x.fireRate) ? `${Math.round(x.fireRate)} rds/s recorded` : "", isNum(x.timeOfFlight) ? `mean time of flight ${x.timeOfFlight.toFixed(1)} s` : "",
          isNum(x.closestApproach) ? `closest round ${units.metric ? `${x.closestApproach.toFixed(1)} m` : `${Math.round(x.closestApproach * M_TO_FT)} ft`}` : "", dcsTargets ? `DCS hits: ${dcsTargets}` : ""].filter(Boolean).join(" · "),
        onclick: () => { seek(x.start - 1.5); select(x.launcherId); if (S.bullets === "off") { S.bullets = "paths"; $("bulletSel").value = "paths"; } },
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
  for (const k of w.kills) {
    kills.append(el("div", { class: "ev", style: { padding: "4px 0", cursor: "pointer" }, onclick: () => seek(k.time - 5) },
      el("span", { class: "num muted" }, fmtClock(k.time - S.start), "  "),
      el("b", { class: "k-kill" }, k.victimPilot || k.victimName), " ",
      k.killerId ? `← ${k.killerPilot || k.killerName} (${k.weaponName})` : `destroyed (${k.cause})`,
      k.confirmedBy === "DCS" ? dcsBadge("DCS reported this kill") : "",
      k.note ? el("div", { class: "faint", style: { fontSize: "11px", marginLeft: "52px" } }, k.note) : ""));
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
    chips.append(el("button", { class: S.eventFilter.has(k) ? "" : "active", onclick: () => {
      S.eventFilter.has(k) ? S.eventFilter.delete(k) : S.eventFilter.add(k); stopsCache = null; renderAllPanels();
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
