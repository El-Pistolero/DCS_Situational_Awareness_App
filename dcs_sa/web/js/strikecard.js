// Air-to-ground strike card, the A-G counterpart of the shot card: release
// parameters, bomb plot, side-view profile, fly-out and attack-run charts,
// plain-language verdicts and the battle damage the strike caused.

import { LineChart } from "./charts.js";
import { FAMILY_LABEL, posAt, strikeGeometry, tofTicks, weaponLabel, weaponPath } from "./strikegeom.js";
import {
  bearing, bisectRight, distance, el, fmtAlt, fmtClock, fmtDeg, fmtDist, fmtHdg, fmtRel, fmtShort, fmtSpeed,
  isNum, sampleTrack, sideColor, speedOfSound, units, COLORS, M_TO_FT, M_TO_NM, MPS_TO_KT,
} from "./util.js";

const RESULT_COLOR = { destroyed: "#ff5c5c", damaged: "#ff9f43", miss: "#9aa4b1" };
const resultColor = (r) => RESULT_COLOR[r] || "#c8cdd6";
const PILL = { destroyed: "kill", damaged: "damaged", miss: "miss", "in flight": "active" };
const CHIP = { good: "good", warn: "warn", bad: "bad", info: "" };
const RINGS = [10, 25, 50, 100, 200, 300];
const MIN_VIEW = 110; // m: the 100 m ring always shows
const MAX_VIEW = 330; // m: past this the plot points at the impact instead of zooming out
const JET_BEFORE = 30, JET_AFTER = 10;
const TERRAIN = "rgba(176,146,98,0.85)";
const DEG = Math.PI / 180;
const M_PER_DEG = 111195; // matches util.distance's sphere

// Bomb plot frame, shared by every card so the toggle flips them all.
let northUp = false;

// -- small helpers -------------------------------------------------------------------

const altUnit = () => (units.metric ? "m" : "ft");
const toAlt = (m) => (units.metric ? m : m * M_TO_FT);

/** "190 × 120 ft" from two lengths in metres. */
function fmtPair(a, b) {
  const k = units.metric ? 1 : M_TO_FT;
  return `${Math.round(a * k).toLocaleString()} × ${Math.round(b * k).toLocaleString()} ${altUnit()}`;
}

/** "2× SA-11 LN, BTR-80" from damage rows. */
function countNames(rows) {
  const n = new Map();
  for (const r of rows) n.set(r.name, (n.get(r.name) || 0) + 1);
  const parts = [...n].map(([name, c]) => (c > 1 ? `${c}× ${name}` : name));
  return parts.length > 4 ? `${parts.slice(0, 3).join(", ")} and ${parts.length - 3} more` : parts.join(", ");
}

const missOf = (strike, geom) => (isNum(geom?.miss?.distance) ? geom.miss.distance : strike.missDistance);
const DIRECT_HIT = 1.0; // m: closer than this the direction of the miss is noise
/** Miss lengths: a decimal for small metric values, where whole metres hide the answer. */
const fmtMiss = (m) => (units.metric && isNum(m) && Math.abs(m) < 10 ? `${Math.abs(m).toFixed(1)} m` : fmtShort(Math.abs(m)));
const signedSec = (s) => (isNum(s) ? `${s >= 0 ? "+" : "−"}${Math.abs(s).toFixed(1)} s` : "—");
/**
 * Battle-damage times count from the opening for a cluster weapon: its impactTime
 * is the last bomblet (or the cloud centre) landing, so kills come before it.
 */
const fromOpening = (strike) => strike.submunitions > 0 && isNum(strike.dispense?.time);
const damageT0 = (strike) => (fromOpening(strike) ? strike.dispense.time : strike.impactTime);

/** Local metres (east, north) around a centre point. */
function localFrame(c) {
  const kx = M_PER_DEG * Math.cos(c.lat * DEG);
  return (lon, lat) => [(lon - c.lon) * kx, (lat - c.lat) * M_PER_DEG];
}

function niceStep(span, n) {
  const raw = span / Math.max(1, n);
  const p = 10 ** Math.floor(Math.log10(raw || 1));
  const f = raw / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

const compact = (v) => (Math.abs(v) >= 1000 ? `${+(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
const short = (v) => String(+v.toFixed(2));

/**
 * y bounds for a LineChart (4 equal gridlines) that put every gridline on a
 * round number that is a multiple of `quantum` (what the labels show);
 * minSpan keeps flat traces from filling the chart with noise.
 */
function niceY(arrays, minSpan, quantum = 1, n = 4) {
  let lo = Infinity, hi = -Infinity;
  for (const a of arrays) for (const v of a || []) if (isNum(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  if (!isNum(lo) || !(minSpan > 0)) return {};
  if (hi - lo < minSpan) { const c = (hi + lo) / 2; lo = c - minSpan / 2; hi = c + minSpan / 2; }
  hi += (hi - lo) * 0.03;
  for (let p = 10 ** Math.floor(Math.log10((hi - lo) / n)); ; p *= 10) {
    for (const f of [1, 1.5, 2, 2.5, 4, 5, 7.5]) {
      const step = f * p;
      if (Math.abs(step / quantum - Math.round(step / quantum)) > 1e-6) continue; // 7.5 kt steps label as 308, 323
      const y0 = Math.floor(lo / step + 1e-9) * step;
      if (y0 + n * step >= hi) return { yMin: y0, yMax: y0 + n * step };
    }
  }
}

/** Text with a dark outline so it stays legible over plot marks. */
function label(ctx, text, x, y, color) {
  ctx.lineWidth = 3; ctx.strokeStyle = "rgba(13,20,27,0.9)"; ctx.lineJoin = "round";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
}

/** Size a canvas to its box at devicePixelRatio; null while it has no layout. */
function fitCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const dpr = window.devicePixelRatio || 1;
  const pw = Math.round(r.width * dpr), ph = Math.round(r.height * dpr);
  if (canvas.width !== pw || canvas.height !== ph) { canvas.width = pw; canvas.height = ph; }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height, dpr };
}

function arrow(ctx, x, y, brg, len, color, head = 5) {
  const a = (brg - 90) * DEG;
  const dx = Math.cos(a), dy = Math.sin(a);
  const x0 = x - (dx * len) / 2, y0 = y - (dy * len) / 2, x1 = x + (dx * len) / 2, y1 = y + (dy * len) / 2;
  ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1 - dx * head * 0.6, y1 - dy * head * 0.6); ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - dx * head - dy * head * 0.6, y1 - dy * head + dx * head * 0.6);
  ctx.lineTo(x1 - dx * head + dy * head * 0.6, y1 - dy * head - dx * head * 0.6);
  ctx.closePath(); ctx.fill();
}

// -- verdicts ------------------------------------------------------------------------

/**
 * Plain-language verdicts for a strike: [{level: "good"|"warn"|"bad"|"info", text}].
 * geom is strikeGeometry()'s result (may be null). Only claims what the data supports.
 */
export function strikeVerdicts(strike, geom) {
  const out = [];
  const add = (level, text) => out.push({ level, text });
  if (!strike) return out;
  const rel = strike.release || {};
  const fam = strike.family;
  const cluster = strike.submunitions > 0;
  const dmg = strike.damage || [];

  // Result first: it is what the pilot wants to know.
  if (dmg.length) {
    const first = Math.min(...dmg.map((d) => d.time));
    const dt = first - damageT0(strike);
    const when = !isNum(dt) ? ""
      : fromOpening(strike) ? ` (${dt.toFixed(1)} s after opening)` : ` (${signedSec(Math.max(0, dt))} after impact)`;
    add("good", `Destroyed ${countNames(dmg)}${when}`);
  } else if (strike.result === "damaged") {
    add("warn", "Hit recorded, but nothing destroyed");
  } else if (strike.result === "miss") {
    add("bad", "No damage recorded");
  } else if (strike.result === "in flight") {
    add("info", "Still falling when the recording ended");
  }
  if (isNum(strike.dcsHits) && strike.dcsHits > 0) add("good", `DCS reported ${strike.dcsHits} hit${strike.dcsHits === 1 ? "" : "s"}`);

  // Launch envelope (JSOW, from DCS's AI launch table).
  const env = strike.envelope;
  if (fam === "jsow" && env && isNum(env.rmax)) {
    const frac = isNum(env.rangeFraction) ? env.rangeFraction : strike.groundRange / env.rmax;
    const pct = Math.round(frac * 100);
    if (frac > 1) add("bad", `Released beyond DCS's max range (${pct}% of Rmax)`);
    else if (isNum(env.rmin) && isNum(strike.groundRange) && strike.groundRange < env.rmin) {
      add("bad", `Released inside DCS's min range (${fmtDist(strike.groundRange)}, min ${fmtDist(env.rmin)})`);
    } else if (isNum(frac)) add("info", `Released at ${pct}% of max range (DCS table for this altitude and speed)`);
  }

  // Coordinate-guided weapons fly to where the target was.
  const moved = geom?.target?.moved;
  if ((fam === "jsow" || fam === "jdam") && isNum(moved) && moved > 30) {
    const tof = isNum(strike.timeOfFall) ? `${Math.round(strike.timeOfFall)} s TOF` : "the fall";
    add("warn", `Target moved ${fmtShort(moved)} during ${tof}: coordinate-guided weapons do not follow movers`);
  }

  // Release attitude matters for anything unguided.
  if (fam === "gp-bomb" || fam === "cluster" || fam === "rocket") {
    const bank = isNum(rel.bank) ? Math.abs(rel.bank) : null, g = rel.g;
    const badBank = isNum(bank) && bank > 5, badG = isNum(g) && Math.abs(g - 1) > 0.3;
    if (badBank || badG) {
      const what = [badBank && `${Math.round(bank)}° bank`, badG && `${g.toFixed(1)} g`].filter(Boolean).join(" / ");
      const err = [badBank && "line", badG && "range"].filter(Boolean).join(" and ");
      add("warn", `Released in ${what}: expect a ${err} error`);
    } else if (isNum(bank) && isNum(g)) add("good", `Wings-level, ${g.toFixed(1)} g release`);
  }
  if (fam === "gp-bomb" && isNum(rel.dive) && rel.dive < -5) {
    add("info", `${Math.round(-rel.dive)}° dive, released at ${isNum(rel.agl) ? `${fmtAlt(rel.agl)} AGL` : `${fmtAlt(geom?.hat)} above the target`}`);
  }

  if (fam === "jsow" && isNum(geom?.offAxis) && Math.abs(geom.offAxis) > 45) {
    const turn = isNum(geom.headingChange) ? `: the JSOW turned ${Math.round(Math.abs(geom.headingChange))}° after release` : "";
    add("info", `Launched ${Math.round(Math.abs(geom.offAxis))}° off-axis${turn}`);
  }

  if (cluster && isNum(geom?.hof)) {
    const fp = strike.footprint || {};
    const pat = isNum(fp.major) && isNum(fp.minor) ? `: pattern ${fmtPair(2 * fp.major, 2 * fp.minor)}` : "";
    if (geom.hof > 900) add("warn", `Opened ${fmtShort(geom.hof)} above the target${pat}; high opening: thin pattern`);
    else add("info", `Opened ${fmtShort(geom.hof)} above the target${pat}`);
  }

  // Which way a unitary weapon missed.
  const m = geom?.miss;
  if (!cluster && m && isNum(m.distance) && m.distance > 10) {
    const r = m.range, d = m.deflection;
    const dom = Math.abs(r) >= Math.abs(d) ? (r > 0 ? "LONG" : "SHORT") : (d > 0 ? "RIGHT" : "LEFT");
    add("info", `Mostly ${dom}: ${fmtMiss(r)} ${r > 0 ? "long" : "short"}, ${fmtMiss(d)} ${d > 0 ? "right" : "left"}`);
  }
  return out;
}

// -- card ----------------------------------------------------------------------------

/**
 * ctx: { objects: Map(id -> {...analysisObject, pb}), start, seek(t), charts: [],
 *        onReplay(strike), onWeaponCam(strike), onShowOnMap(strike), onSelect(id),
 *        series: async (id) => series body | null, target?: {lon, lat, alt, name}, strikes?: [] }
 * Returns the card element. LineCharts go into ctx.charts; card._setTime(t) moves
 * the profile's playhead.
 */
export function buildStrikeCard(strike, ctx = {}) {
  const objects = ctx.objects || new Map();
  const geom = strikeGeometry(strike, objects, { target: ctx.target || null });
  const card = el("div", { class: "strikecard" });

  card.append(header(strike, ctx));
  card.append(tileSection("Release", releaseTiles(strike, geom)));
  card.append(tileSection("Result", resultTiles(strike, geom, objects)));

  // -- bomb plot + profile -------------------------------------------------------------
  let setProfile = null;
  if (geom) {
    const p = plots(strike, geom, objects);
    card.append(p.el);
    setProfile = p.setTime;
  } else card.append(el("div", { class: "stk-note" }, "No impact recorded: nothing to plot."));
  // The owner calls this on playback. The time is kept for the attack-run charts,
  // which arrive later and would otherwise show no playhead until the next seek.
  card._setTime = (t) => { card._t = t; setProfile?.(t); };

  // -- fly-out and attack run --------------------------------------------------------------
  const fly = flyoutCharts(strike, geom, objects, ctx);
  if (fly) card.append(fly);
  if (strike.launcherId && typeof ctx.series === "function") card.append(attackRun(strike, ctx, card));

  // -- verdicts, damage, actions -------------------------------------------------------------
  const verdicts = strikeVerdicts(strike, geom);
  if (verdicts.length) {
    card.append(el("div", { class: "chips verdict" }, ...verdicts.map((v) => el("span", { class: CHIP[v.level] || "" }, v.text))));
  }
  if (strike.damage?.length) card.append(bdaList(strike, ctx));
  const btn = (text, fn, title) => (typeof fn === "function" ? el("button", { title, onclick: () => fn(strike) }, text) : null);
  const acts = el("div", { class: "stk-actions" },
    btn("Replay pass", ctx.onReplay, "Replay the attack from before the release"),
    btn("Weapon cam", ctx.onWeaponCam, "Ride along with the weapon to impact"),
    btn("Show on map", ctx.onShowOnMap, "Frame the release, flight path and impact on the map"));
  if (acts.childElementCount) card.append(acts);
  return card;
}

function plots(strike, geom, objects) {
  const bd = bombData(strike, geom, objects);
  const bomb = el("canvas", { class: "stk-bomb" });
  const flip = el("button", { class: "stk-frame", title: "Flip the bomb plot between run-in up and north up" });
  bomb._redraw = () => {
    flip.textContent = northUp ? "North up" : "Run-in up";
    drawBombPlot(bomb, bd);
  };
  flip.addEventListener("click", () => {
    northUp = !northUp;
    // Every card on the page follows; detached ones pick it up when they are next laid out.
    for (const c of document.querySelectorAll("canvas.stk-bomb")) c._redraw?.();
    if (!bomb.isConnected) bomb._redraw();
  });
  new ResizeObserver(() => bomb._redraw()).observe(bomb);

  const prof = el("canvas", { class: "stk-prof" });
  const pd = profileData(strike, geom, objects);
  let layer = null, lastT = null;
  // Only the ResizeObserver renders the static layer: it fires once the canvas
  // has a size, so playback never forces a layout on a hidden card.
  new ResizeObserver(() => {
    layer = renderProfile(prof, pd);
    if (layer) blitProfile(prof, layer, pd, lastT);
  }).observe(prof);
  const live = (t) => pd && isNum(t) && t >= pd.rt - JET_BEFORE && t <= pd.tEnd + 1;
  // Only the playhead moves; the rest is cached.
  const setTime = (t) => {
    if (t === lastT) return;
    const was = live(lastT);
    lastT = t;
    if (layer && (was || live(t))) blitProfile(prof, layer, pd, t);
  };
  return { el: el("div", { class: "stk-plots" }, el("div", { class: "stk-plot" }, bomb, flip), el("div", { class: "stk-plot" }, prof)), setTime };
}

function header(strike, ctx) {
  const fam = FAMILY_LABEL[strike.family] || strike.family;
  const tgt = ctx.target ? ctx.target.name || "target" : strike.targetName;
  const who = strike.launcherPilot || strike.launcherName;
  const dcs = isNum(strike.dcsHits) && strike.dcsHits > 0
    ? el("span", { class: "dcs-badge", title: `DCS reported ${strike.dcsHits} hit${strike.dcsHits === 1 ? "" : "s"} for this weapon` }, "DCS")
    : null;
  return el("div", { class: "stk-head" },
    el("div", { class: "stk-title" },
      el("div", { class: "stk-wpn" }, el("b", {}, weaponLabel(strike.weaponName)), fam ? el("span", { class: "stk-fam" }, fam) : null),
      el("div", { class: "stk-sub" },
        [who, `released ${fmtClock(strike.releaseTime - (ctx.start ?? 0))}`].filter(Boolean).join(" · "),
        tgt ? el("span", { class: "stk-tgt" }, ` → ${tgt}`, ctx.target ? el("span", { class: "stk-user" }, " (your target)") : null) : null)),
    el("div", { class: "stk-res" }, el("span", { class: `pill ${PILL[strike.result] || ""}` }, strike.result || "unknown"), dcs));
}

function tile(k, v, { title = null, cls = "" } = {}) {
  // Long values ("2,025 ft SHORT") step down a size rather than being cut off.
  const sm = String(v).length > 11 ? " sm" : "";
  return el("div", { class: "tile", title }, el("div", { class: "k" }, k), el("div", { class: `v ${cls}${sm}` }, v));
}

function tileSection(title, tiles) {
  return el("div", { class: "stk-sect" }, el("div", { class: "stk-label" }, title), el("div", { class: "tiles" }, ...tiles));
}

function releaseTiles(strike, geom) {
  const r = strike.release || {};
  const tof = strike.timeOfFall;
  const out = [
    tile("Alt MSL", fmtAlt(r.altitude), { title: "Release altitude above sea level" }),
    tile("HAT", fmtAlt(geom?.hat), { title: "Height above the impact point at release" }),
    tile(units.metric ? "IAS / Mach" : "KCAS / Mach", `${fmtSpeed(r.ias, { suffix: false })} · ${isNum(r.mach) ? `M${r.mach.toFixed(2)}` : "—"}`,
      { title: `Indicated airspeed (${units.metric ? "km/h" : "kt"}) and Mach at release` }),
    tile("Dive", fmtDeg(r.dive), { title: "Flight-path angle at release: negative = diving" }),
    tile("G", isNum(r.g) ? `${r.g.toFixed(1)} g` : "—", { title: "Load factor at release" }),
    tile("Bank", isNum(r.bank) ? fmtDeg(Math.abs(r.bank)) : "—", { title: "Bank angle at release" }),
    tile("Heading", fmtHdg(r.heading), { title: "Jet heading at release (the run-in)" }),
    tile("TOF", isNum(tof) ? `${tof.toFixed(tof < 100 ? 1 : 0)} s` : "—", { title: "Time of fall, release to impact" }),
    tile("Ground range", fmtDist(strike.groundRange), { title: "Ground distance from the release point to the impact" }),
  ];
  if (isNum(strike.glideRatio)) out.push(tile("Glide ratio", `${strike.glideRatio.toFixed(1)}:1`, { title: "Ground range per unit of height lost" }));
  if (isNum(geom?.offAxis)) {
    const a = geom.offAxis;
    out.push(tile("Off-axis", `${Math.round(Math.abs(a))}°${Math.abs(a) >= 0.5 ? (a > 0 ? " R" : " L") : ""}`,
      { title: "Bearing from the jet to the target at release, off the jet's heading" }));
  }
  const env = strike.envelope;
  if (strike.family === "jsow" && env && isNum(env.rmax)) {
    const frac = isNum(env.rangeFraction) ? env.rangeFraction : strike.groundRange / env.rmax;
    const bad = frac > 1 || (isNum(env.rmin) && isNum(strike.groundRange) && strike.groundRange < env.rmin);
    out.push(tile("LAR", isNum(frac) ? `${Math.round(frac * 100)}% Rmax` : "—", {
      cls: bad ? "warn" : "",
      title: `Max range ${fmtDist(env.rmax, { precise: true })} / min ${fmtDist(env.rmin, { precise: true })} for this release altitude and speed, from DCS's own AI launch table`,
    }));
  }
  return out;
}

function resultTiles(strike, geom, objects) {
  const out = [];
  const cluster = strike.submunitions > 0;
  const m = geom?.miss;
  out.push(tile("Miss", isNum(missOf(strike, geom)) ? fmtMiss(missOf(strike, geom)) : "—", {
    title: cluster ? "Pattern centre to the target at impact" : "Impact to the target at impact time (ground distance)",
  }));
  if (m && m.distance < DIRECT_HIT) {
    out.push(tile("Clock", "direct hit", { title: `Impact within ${fmtMiss(DIRECT_HIT)} of the target: too close to call a direction` }));
  } else if (m) {
    out.push(tile("Range error", `${fmtMiss(m.range)} ${m.range > 0 ? "LONG" : "SHORT"}`, { title: "Along the run-in: long = beyond the target" }));
    out.push(tile("Deflection", `${fmtMiss(m.deflection)} ${m.deflection > 0 ? "R" : "L"}`, { title: "Across the run-in, looking down the run-in" }));
    out.push(tile("Clock", `${m.clock} o'clock`, { title: "Clock code from the target: 12 o'clock = long, along the run-in" }));
  }
  if (cluster) {
    out.push(tile("Bomblets", String(strike.submunitions), { title: "Submunitions the dispenser released" }));
    if (isNum(geom?.hof)) out.push(tile("HOF", fmtShort(geom.hof), { title: "height the dispenser opened above the target" }));
    const fp = strike.footprint || {};
    if (isNum(fp.major) && isNum(fp.minor)) {
      out.push(tile("Pattern", fmtPair(2 * fp.major, 2 * fp.minor), { title: "Bomblet pattern: full axes of the 2-sigma ellipse, along x across" }));
    }
  }
  const moved = geom?.target?.moved;
  if (isNum(moved) && moved > 5) out.push(tile("Target moved", fmtShort(moved), { title: "How far the target drove between release and impact" }));
  // A dispenser's track ends where it opens: its last speed is the opening speed.
  const W = objects.get(strike.weaponId);
  const wEnd = W?.pb ? (W.pb.end ?? W.pb.t[W.pb.t.length - 1]) : null;
  const atOpen = cluster && isNum(strike.dispense?.time) && isNum(wEnd) && Math.abs(wEnd - strike.dispense.time) < 1.5;
  if (isNum(geom?.arrivalMach)) {
    out.push(tile(atOpen ? "Opening Mach" : "Arrival Mach", `M${geom.arrivalMach.toFixed(2)}`,
      { title: atOpen ? "Dispenser speed when it opened" : "Weapon speed over its last recorded second" }));
  }
  if (isNum(geom?.arrivalDive)) {
    out.push(tile(atOpen ? "Opening dive" : "Arrival dive", fmtDeg(geom.arrivalDive),
      { title: atOpen ? "Dispenser flight-path angle when it opened" : "Weapon flight-path angle over its last recorded second (negative = descending)" }));
  }
  return out;
}

function bdaList(strike, ctx) {
  const cluster = strike.submunitions > 0;
  const open = fromOpening(strike), t0 = damageT0(strike);
  const list = el("div", { class: "stk-bda" }, el("div", { class: "stk-label" }, open ? "Battle damage · time from opening" : "Battle damage"));
  for (const r of strike.damage) {
    const dcs = r.cause === "event" || r.cause === "dcs";
    const dt = signedSec(r.time - t0);
    list.append(el("div", {
      class: "stk-bda-row",
      title: "Jump to 3 s before and select the unit",
      onclick: () => { ctx.seek?.(r.time - 3); ctx.onSelect?.(r.id); },
    },
    el("span", { class: "stk-bda-name", title: r.name }, r.name),
    el("span", { class: "stk-bda-meta", title: `Destroyed ${dt} ${open ? "after the dispenser opened" : "from the impact"}, ${fmtShort(r.distance)} from the ${cluster ? "pattern centre" : "impact point"}` },
      `${dt} · ${fmtShort(r.distance)} from ${cluster ? "centre" : "impact"}`),
    dcs ? el("span", { class: "dcs-badge", title: "DCS recorded this unit's destruction" }, "DCS")
      : el("span", { class: "stk-inf", title: `Inferred from the recording (${r.cause || "near the impact"})` }, "inferred")));
  }
  return list;
}

// -- bomb plot -----------------------------------------------------------------------------

function bombData(strike, geom, objects) {
  const c = geom?.target || geom?.impact;
  if (!c || !isNum(c.lon)) return null;
  const loc = localFrame(c);
  const d = { strike, geom, runIn: isNum(geom.runIn) ? geom.runIn : 0, color: resultColor(strike.result) };
  d.impact = loc(geom.impact.lon, geom.impact.lat);
  const fp = strike.footprint || {};
  d.points = (fp.points || []).map(([lon, lat]) => loc(lon, lat));
  if (isNum(fp.lon) && isNum(fp.major)) d.ellipse = { c: loc(fp.lon, fp.lat), major: fp.major, minor: fp.minor, bearing: fp.bearing || 0 };
  d.kills = [];
  for (const r of strike.damage || []) {
    const o = objects.get(r.id);
    const p = o && posAt(o, strike.impactTime);
    if (p && isNum(p.lon)) d.kills.push(loc(p.lon, p.lat));
  }
  if (geom.target?.atRelease && geom.target.moved > 5) d.from = loc(geom.target.atRelease.lon, geom.target.atRelease.lat);
  // The weapon's ground track into the plot: the tail of its path near the target.
  const path = weaponPath(strike, objects);
  d.track = [];
  for (let i = path.length - 1; i >= 0; i--) {
    const p = loc(path[i].lon, path[i].lat);
    if (Math.hypot(p[0], p[1]) > 2500) break;
    d.track.push(p);
  }
  if (geom.dispense) d.dispense = loc(geom.dispense.lon, geom.dispense.lat);
  let far = Math.hypot(...d.impact);
  for (const p of d.points) far = Math.max(far, Math.hypot(p[0], p[1]));
  if (d.ellipse) far = Math.max(far, Math.hypot(...d.ellipse.c) + d.ellipse.major);
  d.view = Math.min(MAX_VIEW, Math.max(MIN_VIEW, far * 1.12));
  return d;
}

function drawBombPlot(canvas, d) {
  const f = fitCanvas(canvas);
  if (!f) return;
  const { ctx, w, h } = f;
  ctx.fillStyle = "#0d141b";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "11px ui-monospace, monospace";
  if (!d) {
    ctx.fillStyle = "rgba(141,154,171,0.9)"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("No impact recorded", w / 2, h / 2);
    return;
  }
  const cx = w / 2, cy = h / 2 + 4;
  const rpx = Math.max(24, Math.min(w / 2 - 14, h / 2 - 26));
  const s = rpx / d.view;
  const rotDeg = northUp ? 0 : d.runIn;
  const cr = Math.cos(rotDeg * DEG), sr = Math.sin(rotDeg * DEG);
  // Local (east, north) metres -> screen, with the frame's "up" at bearing rotDeg.
  const P = ([x, y]) => [cx + (x * cr - y * sr) * s, cy - (y * cr + x * sr) * s];

  // Rings, labelled along the diagonal farthest from the run-in line.
  const runScr = d.runIn - rotDeg;
  const off = (b) => Math.min(...[runScr, runScr + 180].map((r) => Math.abs(((b - r) % 360 + 540) % 360 - 180)));
  const diag = [45, 315, 135, 225].reduce((best, b) => (off(b) > off(best) + 1 ? b : best));
  const dx = Math.sin(diag * DEG), dy = -Math.cos(diag * DEG);
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = dx > 0 ? "left" : "right"; ctx.textBaseline = dy < 0 ? "bottom" : "top";
  let lastLbl = -Infinity;
  for (const r of RINGS) {
    const rr = r * s;
    if (r > d.view * 1.001 || rr < 4) continue;
    // label() leaves a 3 px outline width behind: reset it for every ring.
    ctx.lineWidth = 1;
    ctx.strokeStyle = r === 100 ? "rgba(140,155,175,0.34)" : "rgba(140,155,175,0.2)";
    ctx.beginPath(); ctx.arc(cx, cy, rr, 0, Math.PI * 2); ctx.stroke();
    if (rr >= 16 && rr - lastLbl >= 14) {
      label(ctx, fmtShort(r), cx + rr * dx + Math.sign(dx) * 2, cy + rr * dy + Math.sign(dy), "rgba(141,154,171,0.8)");
      lastLbl = rr;
    }
  }
  // Run-in line through the target, with long / short at its ends.
  const ux = Math.sin(runScr * DEG), uy = -Math.cos(runScr * DEG);
  ctx.strokeStyle = "rgba(140,155,175,0.22)"; ctx.lineWidth = 1;
  ctx.setLineDash([3, 4]);
  ctx.beginPath(); ctx.moveTo(cx - ux * rpx, cy - uy * rpx); ctx.lineTo(cx + ux * rpx, cy + uy * rpx); ctx.stroke();
  ctx.setLineDash([]);
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  // An off-plot impact gets an arrow at the edge: leave that end of the line to it.
  const dist = Math.hypot(...d.impact);
  const impScr = Math.atan2(d.impact[0], d.impact[1]) / DEG - rotDeg;
  const near = (b) => dist > d.view && Math.abs(((impScr - b) % 360 + 540) % 360 - 180) < 30;
  if (!near(runScr)) label(ctx, "long", cx + ux * (rpx - 10) + uy * 14, cy + uy * (rpx - 10) - ux * 14, "rgba(141,154,171,0.7)");
  if (!near(runScr + 180)) label(ctx, "short", cx - ux * (rpx - 10) + uy * 14, cy - uy * (rpx - 10) - ux * 14, "rgba(141,154,171,0.7)");

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, rpx + 6, 0, Math.PI * 2); ctx.clip();
  // Weapon's final ground track, and the bomblets' run from the opening point.
  if (d.track.length > 1) {
    ctx.strokeStyle = "rgba(255,255,255,0.35)"; ctx.lineWidth = 1.2;
    ctx.beginPath();
    d.track.forEach((p, i) => { const [x, y] = P(p); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
  }
  if (d.dispense) {
    const [x0, y0] = P(d.dispense), [x1, y1] = P(d.ellipse ? d.ellipse.c : d.impact);
    ctx.strokeStyle = "rgba(255,159,67,0.45)"; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    ctx.setLineDash([]);
  }
  // Where a moving target was at release.
  if (d.from) {
    const [x, y] = P(d.from);
    ctx.strokeStyle = "rgba(255,209,102,0.55)"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(cx, cy); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.stroke();
  }
  // Bomblet pattern: impacts and the 2-sigma ellipse.
  if (d.points.length) {
    ctx.fillStyle = d.color; ctx.globalAlpha = 0.55;
    for (const p of d.points) { const [x, y] = P(p); ctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4); }
    ctx.globalAlpha = 1;
  }
  if (d.ellipse) {
    const [x, y] = P(d.ellipse.c);
    ctx.strokeStyle = d.color; ctx.lineWidth = 1.2; ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(1, d.ellipse.major * s), Math.max(1, d.ellipse.minor * s), (d.ellipse.bearing - rotDeg - 90) * DEG, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  ctx.restore();

  // Target crosshair.
  if (d.geom.target) {
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (const [a, b] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.moveTo(cx + a * 3, cy + b * 3); ctx.lineTo(cx + a * 10, cy + b * 10); }
    ctx.stroke();
  }
  // Impact: a dot, or an arrow at the edge when it is off the plot.
  if (dist <= d.view) {
    const [x, y] = P(d.impact);
    ctx.fillStyle = d.color; ctx.strokeStyle = "#0d141b"; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    const brg = impScr;
    const ex = cx + Math.sin(brg * DEG) * (rpx - 8), ey = cy - Math.cos(brg * DEG) * (rpx - 8);
    arrow(ctx, ex, ey, brg, 16, d.color, 7);
    ctx.fillStyle = d.color; ctx.font = "10px ui-monospace, monospace";
    ctx.textAlign = ex > cx ? "right" : "left"; ctx.textBaseline = "middle";
    ctx.fillText(`impact ${fmtShort(dist)}`, ex + (ex > cx ? -12 : 12), ey + (ey > cy ? -12 : 12));
  }

  // Units destroyed by this strike, over the impact dot (a direct hit hides under it otherwise).
  ctx.strokeStyle = "#f4f6f9"; ctx.lineWidth = 1.6;
  for (const k of d.kills) {
    if (Math.hypot(k[0], k[1]) > d.view) continue;
    const [x, y] = P(k);
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
  }
  // Header: the miss in words.
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(225,230,238,0.92)";
  const m = d.geom.miss;
  const line = !m ? "no target: centred on the impact"
    : m.distance < DIRECT_HIT ? `direct hit · ${fmtMiss(m.distance)}`
      : `${fmtMiss(m.range)} ${m.range >= 0 ? "long" : "short"} · ${fmtMiss(m.deflection)} ${m.deflection >= 0 ? "R" : "L"} · ${m.clock} o'clock`;
  ctx.fillText(line, 8, 7);
  // Run-in arrow and heading, bottom left.
  arrow(ctx, 17, h - 17, d.runIn - rotDeg, 20, "rgba(225,230,238,0.85)", 6);
  ctx.fillStyle = "rgba(170,182,198,0.85)"; ctx.font = "10px ui-monospace, monospace";
  ctx.textBaseline = "middle";
  ctx.fillText(`run-in ${fmtHdg(d.runIn)}`, 32, h - 17);
  // North pointer, top right (only meaningful when the frame is rotated).
  if (!northUp) {
    arrow(ctx, w - 14, 36, -rotDeg, 14, "rgba(141,154,171,0.8)", 5);
    ctx.fillStyle = "rgba(141,154,171,0.9)"; ctx.textAlign = "center";
    ctx.fillText("N", w - 14, 22);
  }
  // Legend, when there is room between the run-in label and the toggle.
  if (w >= 330) {
    ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let x = 120;
    const y = h - 17;
    ctx.fillStyle = d.color;
    ctx.beginPath(); ctx.arc(x + 3, y, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "rgba(170,182,198,0.85)"; ctx.fillText(d.points.length ? "centre" : "impact", x + 10, y);
    x += 22 + ctx.measureText(d.points.length ? "centre" : "impact").width;
    if (d.kills.some((k) => Math.hypot(k[0], k[1]) <= d.view)) {
      ctx.strokeStyle = "#f4f6f9"; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(x, y - 3); ctx.lineTo(x + 6, y + 3); ctx.moveTo(x + 6, y - 3); ctx.lineTo(x, y + 3); ctx.stroke();
      ctx.fillText("destroyed", x + 10, y);
    }
  }
}

// -- profile (side view) -------------------------------------------------------------------

function profileData(strike, geom, objects) {
  if (!geom) return null;
  const rel = geom.release, imp = geom.impact;
  const rt = strike.releaseTime;
  const axis = distance(rel.lon, rel.lat, imp.lon, imp.lat) > 5 ? bearing(rel.lon, rel.lat, imp.lon, imp.lat) : geom.runIn || 0;
  // Distance along the release -> impact line: a true side view, negative behind the release point.
  const proj = (lon, lat) => {
    const dd = distance(rel.lon, rel.lat, lon, lat);
    return dd < 0.5 ? 0 : dd * Math.cos((bearing(rel.lon, rel.lat, lon, lat) - axis) * DEG);
  };
  const L = objects.get(strike.launcherId), W = objects.get(strike.weaponId);
  const jet = [];
  if (L?.pb) {
    for (let t = rt - JET_BEFORE; t <= rt + JET_AFTER + 1e-6; t += 0.5) {
      const p = sampleTrack(L.pb, t);
      if (p && isNum(p.lon) && isNum(p.alt)) jet.push({ t, x: proj(p.lon, p.lat), alt: p.alt });
    }
  }
  const wpn = weaponPath(strike, objects).filter((p) => isNum(p.alt)).map((p) => ({ t: p.t, x: proj(p.lon, p.lat), alt: p.alt }));
  const ticks = tofTicks(strike, objects).filter((p) => isNum(p.alt)).map((p) => ({ sec: p.sec, x: proj(p.lon, p.lat), alt: p.alt }));
  const terrain = isNum(imp.alt) ? imp.alt : Math.min(...wpn.map((p) => p.alt), rel.alt);
  const out = {
    rt, proj, L, W, jet, wpn, ticks, terrain,
    release: { x: 0, alt: rel.alt },
    impact: { x: proj(imp.lon, imp.lat), alt: isNum(imp.alt) ? imp.alt : terrain },
    jetColor: L ? sideColor(L) : COLORS.blue,
    resColor: resultColor(strike.result),
    tEnd: Math.max(strike.impactTime ?? rt, rt + JET_AFTER),
  };
  if (geom.dispense) out.dispense = { x: proj(geom.dispense.lon, geom.dispense.lat), alt: geom.dispense.alt, hof: geom.hof, t: geom.dispense.time };
  if (geom.target) out.target = { x: proj(geom.target.lon, geom.target.lat), alt: isNum(geom.target.alt) ? geom.target.alt : terrain };
  // A sample of the bomblets, for the playhead while they fall.
  out.bomblets = [];
  if (strike.submunitions > 0) {
    const all = [];
    for (const o of objects.values()) if (o.dispenser === strike.weaponId && o.pb) all.push(o.pb);
    const step = Math.max(1, Math.floor(all.length / 24));
    for (let i = 0; i < all.length; i += step) out.bomblets.push(all[i]);
    if (out.bomblets.length) out.tEnd = Math.max(out.tEnd, ...out.bomblets.map((b) => b.end ?? b.t[b.t.length - 1]));
  }
  return out;
}

/** Draw the static profile into an offscreen layer; returns {layer, X, Y, dpr} or null. */
function renderProfile(canvas, pd) {
  const f = fitCanvas(canvas);
  if (!f) return null;
  const { w, h, dpr } = f;
  const layer = document.createElement("canvas");
  layer.width = canvas.width; layer.height = canvas.height;
  const ctx = layer.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d141b";
  ctx.fillRect(0, 0, w, h);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(225,230,238,0.9)";
  ctx.fillText("Profile", 8, 5);
  const tw = ctx.measureText("Profile").width;
  ctx.fillStyle = "rgba(141,154,171,0.85)"; ctx.font = "10px system-ui, sans-serif";
  ctx.fillText(`${altUnit()} MSL · ${units.metric ? "km" : "nm"} from release`, 8 + tw + 8, 6);
  if (!pd) {
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "11px ui-monospace, monospace";
    ctx.fillText("No release data", w / 2, h / 2);
    return { layer, X: null, Y: null, dpr };
  }
  const pad = { l: 36, r: 10, t: 24, b: 18 };
  const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;

  // x: the weapon's part gets at least ~55% of the width; the run-in before it is cut at the left edge.
  let xMaxW = Math.max(0, pd.impact.x, ...pd.wpn.map((p) => p.x));
  if (pd.target) xMaxW = Math.max(xMaxW, pd.target.x);
  const cut = -0.8 * Math.max(xMaxW, 1000);
  const jetVis = pd.jet.filter((p) => p.x >= cut);
  let x0 = Math.min(0, ...jetVis.map((p) => p.x)), x1 = Math.max(xMaxW, ...jetVis.map((p) => p.x));
  const xp = (x1 - x0) * 0.04 || 100;
  x0 -= xp; x1 += xp;
  const alts = [pd.terrain, pd.release.alt, ...pd.wpn.map((p) => p.alt), ...jetVis.map((p) => p.alt)].filter(isNum);
  if (pd.dispense) alts.push(pd.dispense.alt);
  const aMax = Math.max(...alts), span = Math.max(50, aMax - pd.terrain);
  const y0 = pd.terrain - span * 0.14, y1 = aMax + span * 0.12;
  const X = (x) => pad.l + ((x - x0) / (x1 - x0)) * pw;
  const Y = (a) => pad.t + (1 - (a - y0) / (y1 - y0)) * ph;

  // Grid and labels, in display units.
  ctx.font = "10px ui-monospace, monospace";
  ctx.strokeStyle = "rgba(140,155,175,0.12)"; ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(170,182,198,0.75)";
  const ky = units.metric ? 1 : M_TO_FT;
  const ys = niceStep((y1 - y0) * ky, 3);
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  // Integer tick counters: accumulating the step drifts into "-0.0" labels.
  for (let i = Math.ceil((y0 * ky) / ys); i * ys <= y1 * ky; i++) {
    const v = i * ys;
    if (v < 0) continue;
    const y = Y(v / ky);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(compact(v), pad.l - 4, y);
  }
  const kx = units.metric ? 1 / 1000 : M_TO_NM;
  const xs = niceStep((x1 - x0) * kx, Math.max(2, Math.floor(pw / 70)));
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  for (let i = Math.ceil((x0 * kx) / xs); i * xs <= x1 * kx + 1e-9; i++) {
    const v = i * xs;
    const x = X(v / kx);
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, h - pad.b); ctx.stroke();
    ctx.fillText(xs < 1 ? String(+v.toFixed(2)) : String(Math.round(v)), x, h - pad.b + 4);
  }

  ctx.save();
  ctx.beginPath(); ctx.rect(pad.l, pad.t - 8, pw, ph + 8); ctx.clip();
  // Terrain at the impact altitude.
  const yT = Y(pd.terrain);
  ctx.fillStyle = "rgba(176,146,98,0.12)";
  ctx.fillRect(pad.l, yT, pw, h - pad.b - yT);
  ctx.strokeStyle = TERRAIN; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, yT); ctx.lineTo(w - pad.r, yT); ctx.stroke();
  const line = (pts, color, width = 1.6, dash = []) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p.x), Y(p.alt)) : ctx.moveTo(X(p.x), Y(p.alt))));
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line(pd.jet, pd.jetColor, 1.6);
  line(pd.wpn, "rgba(255,255,255,0.92)", 1.6);
  // Bomblets: straight from the opening point to the pattern centre.
  if (pd.dispense) line([pd.dispense, pd.impact], "rgba(255,159,67,0.85)", 1.3, [4, 3]);
  // Time-of-fall ticks, labels spaced out so they do not collide.
  ctx.font = "9px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  let lastX = X(0); // keep clear of the release label
  for (const k of pd.ticks) {
    const x = X(k.x), y = Y(k.alt);
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
    if (x - lastX >= 30 && x < w - pad.r - 12 && x > pad.l + 10) {
      label(ctx, `${k.sec}s`, x, y - 4, "rgba(170,182,198,0.85)");
      lastX = x;
    }
  }
  ctx.restore();

  // Release point.
  const rx = X(0), ry = Y(pd.release.alt);
  ctx.fillStyle = pd.jetColor; ctx.strokeStyle = "#e3e8ef"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(rx, ry, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = rx < pad.l + 40 ? "left" : "center"; ctx.textBaseline = "top";
  label(ctx, "release", rx, ry + 6, "rgba(200,208,220,0.9)");
  // Opening point (cluster weapons).
  if (pd.dispense && isNum(pd.dispense.alt)) {
    const x = X(pd.dispense.x), y = Y(pd.dispense.alt);
    ctx.fillStyle = COLORS.orange;
    ctx.beginPath(); ctx.moveTo(x, y - 4.5); ctx.lineTo(x + 4.5, y); ctx.lineTo(x, y + 4.5); ctx.lineTo(x - 4.5, y); ctx.closePath(); ctx.fill();
    const txt = `opened · HOF ${fmtShort(pd.dispense.hof)}`;
    ctx.font = "10px system-ui, sans-serif";
    const tw2 = ctx.measureText(txt).width;
    // Below and behind the opening point (the weapon came from above), or in
    // the ground band when it opened too low for that.
    const left = x - 8 - tw2 >= pad.l;
    const yT = Y(pd.terrain);
    ctx.textAlign = left ? "right" : "left"; ctx.textBaseline = "top";
    label(ctx, txt, left ? x - 8 : x + 8, yT - (y + 5) >= 13 ? y + 5 : yT + 2, "rgba(255,190,130,0.95)");
  }
  // Target and impact on the ground.
  if (pd.target) {
    const x = X(pd.target.x), y = Y(pd.target.alt);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.moveTo(x, y - 7); ctx.lineTo(x + 4.5, y); ctx.lineTo(x - 4.5, y); ctx.closePath(); ctx.fill();
  }
  const ix = X(pd.impact.x), iy = Y(pd.impact.alt);
  ctx.fillStyle = pd.resColor; ctx.strokeStyle = "#0d141b"; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(ix, iy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  return { layer, X, Y, dpr, xMin: pad.l, xMax: w - pad.r };
}

function blitProfile(canvas, L, pd, t) {
  const ctx = canvas.getContext("2d");
  if (L.layer.width !== canvas.width || L.layer.height !== canvas.height) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(L.layer, 0, 0);
  if (!pd || !L.X || !isNum(t)) return;
  ctx.setTransform(L.dpr, 0, 0, L.dpr, 0, 0);
  const dot = (p, stroke) => {
    if (!p || !isNum(p.lon) || !isNum(p.alt)) return;
    const x = L.X(pd.proj(p.lon, p.lat));
    // The run-in is cut at the left edge: no dot over the axis labels.
    if (!(x >= L.xMin && x <= L.xMax)) return;
    ctx.fillStyle = "#ffd166"; ctx.strokeStyle = stroke; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(x, L.Y(p.alt), 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };
  if (pd.L?.pb && t >= pd.rt - JET_BEFORE && t <= pd.rt + JET_AFTER) dot(sampleTrack(pd.L.pb, t), pd.jetColor);
  if (pd.W?.pb) dot(sampleTrack(pd.W.pb, t), "#0d141b");
  // Bomblets: the mean of a sample of them while they fall.
  if (pd.bomblets.length && isNum(pd.dispense?.t) && t > pd.dispense.t) {
    let n = 0, sx = 0, sa = 0;
    for (const b of pd.bomblets) {
      const p = sampleTrack(b, t);
      if (p && isNum(p.lon) && isNum(p.alt)) { sx += pd.proj(p.lon, p.lat); sa += p.alt; n++; }
    }
    if (n) {
      ctx.fillStyle = "#ffd166"; ctx.strokeStyle = COLORS.orange; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(L.X(sx / n), L.Y(sa / n), 3.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  }
}

// -- charts --------------------------------------------------------------------------------------

function flyoutCharts(strike, geom, objects, ctx) {
  const pb = objects.get(strike.weaponId)?.pb;
  const rt = strike.releaseTime;
  if (!pb || pb.t.length < 3 || !isNum(rt)) return null;
  const idx = [];
  for (let i = 0; i < pb.t.length; i++) if (isNum(pb.lon[i]) && isNum(pb.lat[i]) && isNum(pb.alt?.[i])) idx.push(i);
  if (idx.length < 3) return null;
  const xs = [], alt = [], spd = [];
  for (let k = 0; k < idx.length; k++) {
    const i = idx[k];
    xs.push(pb.t[i] - rt);
    alt.push(toAlt(pb.alt[i]));
    // Central differences that never touch the first sample: it is the spawn
    // frame, still at the jet's position, and doubles the first step's speed.
    const a = k >= 2 ? idx[k - 1] : null, b = idx[k + 1];
    const dt = isNum(a) && isNum(b) ? pb.t[b] - pb.t[a] : 0;
    const v = dt > 0 ? Math.hypot(distance(pb.lon[a], pb.lat[a], pb.lon[b], pb.lat[b]), pb.alt[b] - pb.alt[a]) / dt : null;
    spd.push(isNum(v) ? v / speedOfSound(pb.alt[i]) : null);
  }
  // Mach smoothed over 3 samples: positions are rounded, single steps are noisy.
  const mach = spd.map((_, i) => {
    const w = [spd[i - 1], spd[i], spd[i + 1]].filter(isNum);
    return w.length ? w.reduce((p, q) => p + q, 0) / w.length : null;
  });
  const xMax = xs[xs.length - 1];
  const tEnd = rt + xMax;
  const marks = isNum(strike.dispense?.time) ? [{ x: strike.dispense.time - rt, color: "rgba(255,159,67,0.95)" }] : [];
  const wrap = el("div", { class: "stk-charts" });
  const mk = (title, series, yFormat, minSpan, quantum) => {
    const c = el("canvas", { class: "stk-chart" });
    wrap.append(c);
    const ch = new LineChart(c, { title, yFormat, xFormat: (x) => fmtRel(x), onSeek: (x) => ctx.seek?.(rt + x) });
    series = series.filter(Boolean);
    ch.setData(series, { xMin: 0, xMax, ...niceY(series.map((q) => q.y), minSpan, quantum) });
    if (marks.length) ch.setMarks(marks);
    ch._markerFn = (t) => (t >= rt && t <= tEnd ? t - rt : null);
    ctx.charts?.push(ch);
  };
  const terr = geom?.impact?.alt;
  mk(`Weapon altitude (${altUnit()})`, [
    { name: "weapon", color: "#e3e8ef", x: xs, y: alt, legend: false },
    isNum(terr) ? { name: "impact elevation", color: TERRAIN, dash: [4, 4], x: [0, xMax], y: [toAlt(terr), toAlt(terr)], readout: false } : null,
  ], (v) => Math.round(v).toLocaleString(), toAlt(300), 1);
  if (mach.some(isNum)) mk("Weapon Mach", [{ name: "Mach", color: "#b48cff", x: xs, y: mach, legend: false }], short, 0.2, 0.01);
  return el("div", { class: "stk-sect" }, el("div", { class: "stk-label" }, "Weapon fly-out"), wrap);
}

/** Release times of this launcher's weapons in [t0, t1]: from ctx.strikes, else guessed from the objects. */
function releasesIn(strike, ctx, t0, t1) {
  const out = new Set([strike.releaseTime]);
  if (Array.isArray(ctx.strikes)) {
    for (const s of ctx.strikes) if (s.launcherId === strike.launcherId && s.releaseTime >= t0 && s.releaseTime <= t1) out.add(s.releaseTime);
    return [...out];
  }
  const L = ctx.objects?.get(strike.launcherId);
  if (!L?.pb || !ctx.objects) return [...out];
  for (const o of ctx.objects.values()) {
    if (o.category !== "weapon" || o.dispenser || !o.pb || !isNum(o.firstSeen) || o.firstSeen < t0 || o.firstSeen > t1) continue;
    if (/Shell|Bullet|Projectile/.test(o.type || "")) continue;
    let mine = o.parent === strike.launcherId;
    if (!mine && !o.parent) {
      const a = sampleTrack(o.pb, o.firstSeen), b = sampleTrack(L.pb, o.firstSeen);
      mine = a && b && isNum(a.lon) && isNum(b.lon) && distance(a.lon, a.lat, b.lon, b.lat) < 300 && Math.abs((a.alt ?? 0) - (b.alt ?? 0)) < 300;
    }
    if (mine) out.add(o.firstSeen);
  }
  return [...out];
}

function attackRun(strike, ctx, card) {
  const rt = strike.releaseTime;
  const t0 = rt - 60, t1 = rt + 15;
  const holder = el("div", { class: "stk-sect" }, el("div", { class: "stk-label" }, "Attack run"));
  const note = el("div", { class: "stk-note" }, "Loading attack run…");
  holder.append(note);
  const show = (body) => {
    const t = body?.t, ch = body?.channels || {};
    if (!t?.length) { note.textContent = "No telemetry for the attack run."; return; }
    const i0 = Math.max(0, bisectRight(t, t0)), i1 = Math.min(t.length, bisectRight(t, t1) + 2);
    const x = t.slice(i0, i1);
    const pick = (name, f) => (Array.isArray(ch[name]) ? ch[name].slice(i0, i1).map((v) => (isNum(v) ? f(v) : null)) : null);
    const altF = (v) => toAlt(v);
    const msl = pick("Altitude", altF), agl = pick("AGL", altF);
    const ias = pick("IAS", (v) => (units.metric ? v * 3.6 : v * MPS_TO_KT));
    const gl = pick("GLoad", (v) => v) || pick("VerticalGForce", (v) => v);
    if (!x.length || !(msl || agl || ias || gl)) { note.textContent = "No telemetry for the attack run."; return; }
    note.remove();
    const rel = releasesIn(strike, ctx, t0, t1);
    const marks = rel.map((r) => ({ x: r, w: 0, color: r === rt ? "#ffd166" : "rgba(255,159,67,0.95)" }));
    const wrap = el("div", { class: "stk-charts" });
    holder.append(wrap);
    const mk = (title, series, yFormat, minSpan, quantum) => {
      const c = el("canvas", { class: "stk-chart run" });
      wrap.append(c);
      const lc = new LineChart(c, { title, yFormat, xFormat: (v) => fmtRel(v - rt), onSeek: (v) => ctx.seek?.(v) });
      lc.setData(series, { xMin: t0, xMax: t1, ...niceY(series.map((q) => q.y), minSpan, quantum) });
      lc.setMarks(marks);
      if (isNum(card._t)) lc.setMarker(card._t);
      ctx.charts?.push(lc);
    };
    const altSeries = [msl && { name: "MSL", color: "#ffd166", x, y: msl }, agl && { name: "AGL", color: "#4dd8e6", x, y: agl }].filter(Boolean);
    if (altSeries.length) mk(`Altitude (${altUnit()})`, altSeries, (v) => Math.round(v).toLocaleString(), toAlt(300), 1);
    if (ias) mk(`IAS (${units.metric ? "km/h" : "kt"})`, [{ name: "IAS", color: "#5fd38d", x, y: ias, legend: false }], (v) => v.toFixed(0), units.metric ? 40 : 20, 1);
    if (gl) mk("G", [{ name: "G", color: "#b48cff", x, y: gl, legend: false }], short, 1, 0.01);
  };
  Promise.resolve()
    .then(() => ctx.series(strike.launcherId))
    .then(async (body) => {
      // Built but not yet inserted is fine; inserted and then removed is not.
      if (!card.isConnected) await new Promise((r) => requestAnimationFrame(r));
      if (!card.isConnected) return;
      show(body);
    })
    .catch(() => { note.textContent = "Attack run unavailable."; });
  return holder;
}

// -- thumbnail -------------------------------------------------------------------------------------

/** Tiny north-up plot, 1 km across: target cross, impact / bomblets, release direction. */
export function buildStrikeThumb(strike, objects, size = 64) {
  const c = el("canvas", { class: "strikethumb", style: { width: `${size}px`, height: `${size}px` } });
  const dpr = window.devicePixelRatio || 1;
  c.width = Math.round(size * dpr); c.height = Math.round(size * dpr);
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#0d141b";
  ctx.fillRect(0, 0, size, size);
  const geom = strikeGeometry(strike, objects || new Map());
  const m = geom?.miss;
  c.title = [weaponLabel(strike.weaponName), strike.result,
    isNum(missOf(strike, geom)) ? `miss ${fmtShort(missOf(strike, geom))}` : "",
    m ? `${m.clock} o'clock` : ""].filter(Boolean).join(" · ");
  const centre = geom?.target || geom?.impact;
  if (!centre || !isNum(centre.lon)) return c;
  const loc = localFrame(centre);
  const s = size / 1000, h = size / 2;
  const P = ([x, y]) => [h + x * s, h - y * s];
  const col = resultColor(strike.result);
  // 100 m ring for scale.
  ctx.strokeStyle = "rgba(140,155,175,0.25)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(h, h, 100 * s, 0, Math.PI * 2); ctx.stroke();
  // Release direction: an arrow coming in from the edge along the run-in.
  if (isNum(geom.runIn)) {
    const b = geom.runIn * DEG;
    const ex = h - Math.sin(b) * h * 0.95, ey = h + Math.cos(b) * h * 0.95;
    const mx = h - Math.sin(b) * h * 0.45, my = h + Math.cos(b) * h * 0.45;
    arrow(ctx, (ex + mx) / 2, (ey + my) / 2, geom.runIn, Math.hypot(ex - mx, ey - my), "rgba(225,230,238,0.55)", 4);
  }
  ctx.fillStyle = col; ctx.globalAlpha = 0.7;
  for (const [lon, lat] of strike.footprint?.points || []) {
    const [x, y] = P(loc(lon, lat));
    ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
  }
  ctx.globalAlpha = 1;
  if (geom.target) {
    ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(h - 5, h); ctx.lineTo(h + 5, h); ctx.moveTo(h, h - 5); ctx.lineTo(h, h + 5); ctx.stroke();
  }
  const ip = loc(geom.impact.lon, geom.impact.lat);
  const d = Math.hypot(...ip);
  if (d <= 480) {
    const [x, y] = P(ip);
    ctx.fillStyle = col; ctx.strokeStyle = "#0d141b"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(x, y, 2.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  } else {
    // Off the thumbnail: a pip on the edge in its direction.
    const brg = Math.atan2(ip[0], ip[1]) / DEG;
    arrow(ctx, h + Math.sin(brg * DEG) * (h - 5), h - Math.cos(brg * DEG) * (h - 5), brg, 7, col, 4);
  }
  return c;
}

