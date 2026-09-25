// Missile shot post-mortem card: launch geometry, fly-out charts and a
// plain-language verdict ("why did it miss?").

import { LineChart } from "./charts.js";
import {
  el, fmtAlt, fmtDeg, fmtDist, fmtRel, isNum, sampleTrack, sideColor, speedOfSound, units, wrap180,
  M_TO_FT, M_TO_NM,
} from "./util.js";

const STEP = 0.25;
const BEAM = "rgba(77,216,230,.18)";
const COLD = "rgba(180,140,255,.18)";

function enu(p, ref) {
  const k = 111320;
  return [(p.lon - ref.lon) * k * Math.cos((ref.lat * Math.PI) / 180), (p.lat - ref.lat) * k, (p.alt ?? 0) - (ref.alt ?? 0)];
}

/** Runs of `test(value)` lasting >= minDur seconds: [{x0, x1}] in seconds since launch. */
function windows(xs, vals, test, minDur = 2) {
  const out = [];
  let a = null;
  for (let i = 0; i <= xs.length; i++) {
    const on = i < xs.length && isNum(vals[i]) && test(vals[i]);
    if (on && a === null) a = i;
    if (!on && a !== null) {
      const x0 = xs[a], x1 = xs[i - 1];
      if (x1 - x0 >= minDur) out.push({ x0, x1 });
      a = null;
    }
  }
  return out;
}

/**
 * ctx: { objects: Map(id -> {pb, category, parent, ...}), start, seek(t), onReplay(shot), charts: [] }
 * Returns the card element; LineCharts are pushed into ctx.charts.
 */
export function buildShotCard(shot, ctx) {
  const card = el("div", { class: "shotcard" });
  const W = shot.weaponId && ctx.objects.get(shot.weaponId);
  const T = shot.targetId && ctx.objects.get(shot.targetId);
  const L = shot.launcherId && ctx.objects.get(shot.launcherId);
  const t0 = shot.launchTime, t1 = shot.endTime ?? t0;
  const g = shot.geometry || {};

  // -- samples ------------------------------------------------------------------
  const xs = [], range = [], mach = [], aspect = [], talt = [];
  let peak = null;
  if (W) {
    const wp = [];
    for (let t = t0; t <= t1 + 1e-6; t += STEP) wp.push([t, sampleTrack(W.pb, t)]);
    const spd = [];
    for (let i = 0; i < wp.length; i++) {
      const [t, p] = wp[i];
      const q = wp[Math.min(wp.length - 1, i + 1)][1], r = wp[Math.max(0, i - 1)][1];
      let v = null;
      if (p && q && r && q !== r) {
        const a = enu(q, r), dt = (Math.min(wp.length - 1, i + 1) - Math.max(0, i - 1)) * STEP;
        v = Math.hypot(...a) / dt;
      }
      spd.push(v);
      xs.push(t - t0);
      const tp = T && sampleTrack(T.pb, t);
      if (p && tp) {
        const d = enu(tp, p);
        range.push(Math.hypot(...d));
        const tn = T && sampleTrack(T.pb, Math.min(t + STEP, T.pb.end ?? Infinity));
        if (tn) {
          // Target aspect to the missile: angle between the target's velocity
          // and the target->missile vector. 0 = flying at it, 90 = beam.
          const vel = enu(tn, tp), tm = enu(p, tp);
          const nv = Math.hypot(vel[0], vel[1]), nm = Math.hypot(tm[0], tm[1]);
          aspect.push(nv > 1e-3 && nm > 1e-3 ? (Math.acos(Math.max(-1, Math.min(1, (vel[0] * tm[0] + vel[1] * tm[1]) / (nv * nm)))) * 180) / Math.PI : null);
        } else aspect.push(null);
        talt.push(tp.alt);
      } else { range.push(null); aspect.push(null); talt.push(null); }
    }
    // Mach, smoothed over 3 samples.
    for (let i = 0; i < spd.length; i++) {
      const w = [spd[i - 1], spd[i], spd[i + 1]].filter(isNum);
      const p = wp[i][1];
      const m = w.length && p ? w.reduce((a, b) => a + b, 0) / w.length / speedOfSound(p.alt) : null;
      mach.push(m);
      if (isNum(m) && (!peak || m > peak.m)) peak = { m, x: xs[i] };
    }
  }
  const beams = windows(xs, aspect, (a) => a >= 70 && a <= 110);
  const colds = windows(xs, aspect, (a) => a > 120);

  // Countermeasures from the target during the flight.
  const cms = [];
  if (T) {
    for (const o of ctx.objects.values()) {
      if (o.category !== "countermeasure" || !isNum(o.firstSeen) || o.firstSeen < t0 || o.firstSeen > t1) continue;
      let mine = o.parent === T.id;
      if (!mine) {
        const cp = sampleTrack(o.pb, o.firstSeen), tp = sampleTrack(T.pb, o.firstSeen);
        mine = cp && tp && Math.hypot(...enu(cp, tp)) <= 150;
      }
      if (mine) cms.push(o.firstSeen - t0);
    }
  }

  // -- (1) launch diagram --------------------------------------------------------
  const diag = el("canvas", { class: "diagram" });
  card.append(diag);
  requestAnimationFrame(() => drawDiagram(diag, shot, L, T));

  // -- (2) fly-out charts ----------------------------------------------------------
  if (xs.length > 1) {
    const vb = [...beams.map((w) => ({ ...w, color: BEAM })), ...colds.map((w) => ({ ...w, color: COLD }))];
    const marks = cms.map((x) => ({ x, w: 1, color: "rgba(255,159,67,0.95)" }));
    const mk = (title, series, yFormat) => {
      const c = el("canvas", { class: "flyout" });
      card.append(c);
      const ch = new LineChart(c, { title, yFormat, xFormat: (x) => fmtRel(x), onSeek: (x) => ctx.seek(t0 + x) });
      ch.setData(series, { xMin: 0, xMax: xs[xs.length - 1] });
      ch.setVBands(vb);
      ch.setMarks(marks);
      ch._markerFn = (t) => (t >= t0 && t <= t1 ? t - t0 : null);
      ctx.charts.push(ch);
    };
    if (T) mk("Range to target", [{ name: units.metric ? "km" : "nm", color: "#ffd166", x: xs, y: range.map((r) => (isNum(r) ? (units.metric ? r / 1000 : r * M_TO_NM) : null)) }], (v) => v.toFixed(1));
    mk("Missile Mach", [{ name: "Mach", color: "#b48cff", x: xs, y: mach }], (v) => v.toFixed(1));
  }

  // -- (3) verdict chips -------------------------------------------------------------
  const chips = el("div", { class: "chips verdict" });
  const chip = (text, cls = "") => chips.append(el("span", { class: cls }, text));
  const pillCls = { kill: "kill", miss: "miss", active: "active", damage: "lock" }[shot.outcome] || "";
  chips.append(el("span", { class: `pill ${pillCls}` }, shot.outcome));
  if (shot.outcomeDetail) chip(shot.outcomeDetail);
  if (shot.dcsConfirmed) chip("DCS confirmed the launch", "good");
  if (shot.dcsHit) chip(`DCS reported a hit on ${shot.dcsHit}`, "good");
  const dAlt = g.altitudeDelta;
  const bits = [];
  if (isNum(g.range)) bits.push(`Launched ${fmtDist(g.range)}`);
  if (isNum(g.offBoresight)) bits.push(`${Math.round(g.offBoresight)}° off boresight`);
  if (isNum(dAlt)) bits.push(`target ${dAlt >= 0 ? "+" : "−"}${fmtAlt(Math.abs(dAlt))}`);
  if (isNum(g.aspect)) bits.push(`aspect ${Math.round(g.aspect)}°`);
  if (bits.length) chip(bits.join(" · "));
  if (isNum(g.offBoresight) && g.offBoresight > 30) chip(`Off-boresight ${Math.round(g.offBoresight)}° at launch`, "warn");
  if (isNum(g.aspect) && g.aspect < 60 && isNum(g.range) && g.range > 10 * 1852) chip(`Target cold at launch (aspect ${Math.round(g.aspect)}°)`, "warn");
  if (isNum(dAlt) && dAlt > 3000) chip(`Target ${units.metric ? `${(dAlt / 1000).toFixed(1)} km` : `${Math.round((dAlt * M_TO_FT) / 1000)}k ft`} above`, "warn");
  if (beams.length) chip(`Target beamed at ${fmtRel(beams[0].x0)} for ${Math.round(beams[0].x1 - beams[0].x0)} s`);
  if (colds.length) chip(`Target turned cold at ${fmtRel(colds[0].x0)}`);
  const alts = talt.filter(isNum);
  if (alts.length > 1 && Math.abs(alts[alts.length - 1] - alts[0]) > 1500) {
    const d = alts[alts.length - 1] - alts[0];
    chip(`Target ${d < 0 ? "descended" : "climbed"} ${fmtAlt(Math.abs(d))}`);
  }
  if (peak) chip(`Peak Mach ${peak.m.toFixed(1)} at ${fmtRel(peak.x)}`);
  if (isNum(shot.closestTime) && xs.length) {
    let i = 0;
    for (let k = 0; k < xs.length; k++) if (Math.abs(xs[k] - (shot.closestTime - t0)) < Math.abs(xs[i] - (shot.closestTime - t0))) i = k;
    if (isNum(mach[i])) chip(`Arrived at Mach ${mach[i].toFixed(1)}`, mach[i] < 1 ? "warn" : "");
  }
  if (cms.length) chip(`Chaff/flares ×${cms.length} (${cms.filter((x) => x >= xs[xs.length - 1] - 5).length} in the last 5 s)`);
  if (isNum(shot.closestApproach)) {
    chip(`Closest approach ${fmtDist(shot.closestApproach)}${isNum(shot.closestTime) ? ` at ${fmtRel(shot.closestTime - t0)}` : ""}`);
  }
  card.append(chips);

  // -- (4) replay ------------------------------------------------------------------------
  card.append(el("button", { onclick: () => ctx.onReplay(shot) }, "Replay shot"));
  return card;
}

function drawDiagram(canvas, shot, L, T) {
  const r = canvas.getBoundingClientRect();
  if (!r.width) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr; canvas.height = r.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height;
  const g = shot.geometry || {};
  const sx = w / 2, sy = h - 22, tx = w / 2, ty = 24;
  ctx.fillStyle = "#0d141b";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255,255,255,0.25)";
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
  ctx.setLineDash([]);
  // Line of sight is "up": shooter heading relative to LOS = off-boresight
  // side; target heading relative to LOS from its aspect.
  const los = g.bearing;
  const sh = isNum(los) && isNum(shot.launch?.heading) ? wrap180(shot.launch.heading - los) : 0;
  const th = isNum(los) && isNum(g.targetHeading) ? wrap180(g.targetHeading - los) : 180;
  const vmax = Math.max(shot.launch?.tas || 0, g.targetSpeed || 0, 1);
  const len = (v) => 18 + 32 * ((v || vmax * 0.8) / vmax);
  const jet = (x, y, hdg, color, v, label) => {
    const a = ((hdg - 90) * Math.PI) / 180;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + Math.cos(a) * len(v), y + Math.sin(a) * len(v)); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.font = "11px ui-monospace, monospace"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(225,230,238,0.9)";
    ctx.fillText(label, x + 10, y + (y > h / 2 ? 10 : -10));
  };
  jet(sx, sy, sh, L ? sideColor(L) : "#4ea8ff", shot.launch?.tas, shot.launcherPilot || shot.launcherName || "shooter");
  if (shot.targetId) jet(tx, ty, th, T ? sideColor(T) : "#ff5c5c", g.targetSpeed, shot.targetPilot || shot.targetName || "target");
  ctx.fillStyle = "rgba(200,208,220,0.9)";
  ctx.font = "11px ui-monospace, monospace";
  ctx.textAlign = "left";
  const lines = [
    `range ${fmtDist(g.range)}`,
    `aspect ${fmtDeg(g.aspect)}`,
    `off-boresight ${fmtDeg(g.offBoresight)}`,
    isNum(g.altitudeDelta) ? `Δalt ${g.altitudeDelta >= 0 ? "+" : "−"}${fmtAlt(Math.abs(g.altitudeDelta))}` : "",
    isNum(g.closure) ? `closure ${units.metric ? `${Math.round(g.closure * 3.6)} km/h` : `${Math.round(g.closure * 1.943844)} kt`}` : "",
  ].filter(Boolean);
  lines.forEach((s, i) => ctx.fillText(s, 10, 16 + i * 14));
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(141,154,171,0.9)";
  ctx.fillText("line of sight ↑", w - 8, h - 10);
}
