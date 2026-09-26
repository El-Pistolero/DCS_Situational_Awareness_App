// Missile shot post-mortem card: launch geometry, fly-out charts and a
// plain-language verdict ("why did it miss?").

import { LineChart } from "./charts.js";
import { K7, heatColor } from "./irviz.js";
import {
  el, fmtAlt, fmtDeg, fmtDist, fmtRel, fmtShort, isNum, sampleTrack, sideColor, speedOfSound, units, wrap180,
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
    // Past the last recorded sample the position is only held, not flown:
    // no speed there (the weapon is deleted a frame after its last sample).
    const lastT = W.pb.t[W.pb.t.length - 1];
    for (let t = t0; t <= t1 + 1e-6; t += STEP) wp.push([t, t <= lastT + 1e-6 ? sampleTrack(W.pb, t) : null]);
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
      const tp = p && T && sampleTrack(T.pb, t);
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

  // Countermeasures from the target during the flight.  The analysis names
  // each flare's owner (DCS writes none); without it, anything within 150 m.
  const ir = shot.ir || null;
  const cms = [], chaff = [];
  if (T) {
    for (const o of ctx.objects.values()) {
      if (o.category !== "countermeasure" || !isNum(o.firstSeen) || o.firstSeen < t0 || o.firstSeen > t1) continue;
      if (o.cmKind) {
        if (o.cmOwner === T.id) (o.cmKind === "chaff" ? chaff : cms).push(o.firstSeen - t0);
        continue;
      }
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
  // Redraw on every size change (panel resize, or first layout after insertion).
  new ResizeObserver(() => drawDiagram(diag, shot, L, T)).observe(diag);

  // -- (2) fly-out charts ----------------------------------------------------------
  if (xs.length > 1) {
    const vb = [...beams.map((w) => ({ ...w, color: BEAM })), ...colds.map((w) => ({ ...w, color: COLD }))];
    // Flare releases amber, chaff grey, the estimated decoy moment white.
    const marks = [...cms.map((x) => ({ x, w: 1, color: "rgba(255,159,67,0.95)" })), ...chaff.map((x) => ({ x, w: 1, color: "rgba(154,164,177,0.9)" })),
      ...(ir?.decoy ? [{ x: ir.decoy.t, w: 1, color: "rgba(255,255,255,0.8)" }] : [])];
    const mk = (title, series, yFormat, { yMin, yMax, xMax, bands } = {}) => {
      const c = el("canvas", { class: "flyout" });
      card.append(c);
      const ch = new LineChart(c, { title, yFormat, xFormat: (x) => fmtRel(x), onSeek: (x) => ctx.seek(t0 + x) });
      const x1 = xMax ?? xs[xs.length - 1];
      ch.setData(series, { xMin: 0, xMax: x1, yMin, yMax });
      ch.setVBands(bands ?? vb);
      ch.setMarks(marks.filter((m) => m.x <= x1));
      ch._markerFn = (t) => (t >= t0 && t <= t1 ? t - t0 : null);
      ctx.charts.push(ch);
    };
    if (ir?.series?.length) irCharts(ir, card, mk, xs);
    if (T) mk("Range to target", [{ name: units.metric ? "km" : "nm", color: "#ffd166", x: xs, y: range.map((r) => (isNum(r) ? (units.metric ? r / 1000 : r * M_TO_NM) : null)) }], (v) => v.toFixed(1));
    mk("Missile Mach", [{ name: "Mach", color: "#b48cff", x: xs, y: mach }], (v) => v.toFixed(1));
  }

  // -- (3) verdict chips -------------------------------------------------------------
  const chips = el("div", { class: "chips verdict" });
  const chip = (text, cls = "", title = null) => chips.append(el("span", { class: cls, title }, text));
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
    while (i > 0 && !isNum(mach[i])) i--; // last recorded speed before the closest point
    if (isNum(mach[i])) chip(`Arrived at Mach ${mach[i].toFixed(1)}`, mach[i] < 1 ? "warn" : "");
  }
  if (ir) irChips(ir, shot, chip, cms, chaff, T);
  else if (cms.length || chaff.length) {
    chip([cms.length ? `Flares ×${cms.length} (${cms.filter((x) => x >= xs[xs.length - 1] - 5).length} in the last 5 s)` : "",
      chaff.length ? `chaff ×${chaff.length}` : ""].filter(Boolean).join(" · "));
  }
  if (isNum(shot.closestApproach)) {
    chip(`Closest approach ${shot.closestApproach < 1852 ? fmtShort(shot.closestApproach) : fmtDist(shot.closestApproach)}${isNum(shot.closestTime) ? ` at ${fmtRel(shot.closestTime - t0)}` : ""}`);
  }
  card.append(chips);

  if (ir) {
    card.append(el("div", { class: "irnote" },
      "IR: seeker limits and heat values are DCS data (DCS 2.9 Lua; heat 1.0 = a Su-27 without afterburner, ×1.5 from the tail, ×0.5 nose-on). ",
      "Flare owners, the decoy call and seeker reach are estimates from the recorded paths. DCS records no lock or tone."));
  }

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
  const heat = shot.ir?.heat;
  if (shot.targetId && heat && isNum(heat.ir)) {
    // The target's heat as DCS models it, out of its tailpipe (same scale as the map lobes).
    const c = heat.ab && isNum(heat.irAB) ? heat.irAB : heat.ir;
    const tail = ((th + 180 - 90) * Math.PI) / 180;
    const lobe = (k) => {
      ctx.beginPath();
      for (let i = 0; i <= 48; i++) {
        const phi = (i / 48) * Math.PI * 2, rr = Math.min(46, 14 * Math.sqrt(k * (1 + (1 - K7) * Math.cos(phi))));
        const px = tx + rr * Math.cos(tail + phi), py = ty + rr * Math.sin(tail + phi);
        i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
    };
    lobe(c);
    ctx.fillStyle = heatColor(c * 1.5, 0.28); ctx.fill();
    ctx.strokeStyle = heatColor(c * 1.5, 0.8); ctx.lineWidth = 1; ctx.stroke();
    if (heat.ab === null && isNum(heat.irAB)) {
      lobe(heat.irAB);
      ctx.setLineDash([2, 3]); ctx.strokeStyle = heatColor(heat.irAB * 1.5, 0.6); ctx.stroke(); ctx.setLineDash([]);
    }
  }
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
    isNum(heat?.seen) ? `heat seen ${heat.seen.toFixed(2)}${isNum(heat.seenAB) ? ` · ${heat.seenAB.toFixed(1)} if AB` : ""}` : "",
  ].filter(Boolean);
  lines.forEach((s, i) => ctx.fillText(s, 10, 16 + i * 14));
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(141,154,171,0.9)";
  ctx.fillText("line of sight ↑", w - 8, h - 10);
}

// -- IR shots ------------------------------------------------------------------------------

const k2 = (v) => (v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2));

/** Chips for an IR missile: DCS seeker facts, heat at launch, flares, the decoy estimate. */
function irChips(ir, shot, chip, cms, chaff, T) {
  const sk = ir.seeker || {}, h = ir.heat || {}, g = shot.geometry || {}, L = ir.launch || {};
  const name = sk.short || sk.display || shot.weaponName;
  const src = `DCS ${sk.dcsVersion || "2.9"} · ${sk.src || "rockets"}`;
  const dcs = (text, cls = "") => chip(text, `${cls} dcs`.trim(), src);
  const est = (text, cls = "", title = null) => chip(`~ ${text}`, `${cls} est`.trim(), title);
  dcs(sk.allAspect ? `${name} · IR seeker · all-aspect` : `${name} · IR seeker · rear-aspect only (within ${Math.round(sk.aspectLimit)}° of the tail)`);
  if (isNum(sk.ccm)) dcs(`flare resistance ${sk.ccm} (DCS ccm_k0: 0 immune · 1 medium · higher = easier to decoy)`);
  const lim = [isNum(sk.gimbal) ? `gimbal ${Math.round(sk.gimbal)}°` : "", isNum(sk.trackRate) ? `${Math.round(sk.trackRate)}°/s` : "",
    isNum(sk.offBoresight) ? `launch look angle ${Math.round(sk.offBoresight)}°` : "", isNum(sk.fuze) ? `fuze ${sk.fuze} m` : "",
    isNum(sk.power) ? `seeker power ${sk.power} s` : ""].filter(Boolean);
  if (lim.length) dcs(lim.join(" · "));
  if (L.outsideLookAngle) dcs(`launched ${Math.round(L.offBoresight3d)}° off boresight (DCS launch look angle ${Math.round(sk.offBoresight)}°)`, "warn");
  if (h.outsideAspect) dcs(`launched outside the rear-aspect cone (tail angle ${Math.round(h.tailAngle)}°, DCS limit ${Math.round(sk.aspectLimit)}°)`, "warn");
  // The target's heat at launch, as the missile saw it: DCS coefficient x DCS aspect factor.
  if (isNum(h.ir) && isNum(h.seen) && isNum(h.aspectFactor)) {
    const where = h.tailAngle < 60 ? "tail" : h.tailAngle > 120 ? "nose" : "beam";
    const from = h.abSrc === "Afterburner" ? "recorded" : h.abSrc === "DcsFuelFlow" ? "from DCS bridge fuel flow" : "from fuel flow";
    if (h.ab === true) chip(`${h.type} heat ${k2(h.irAB)} (afterburner, ${from}) × ${where} ${h.aspectFactor.toFixed(2)} = ${k2(h.seen)}`, "warn", HEAT_TIP);
    else if (h.ab === false) chip(`${h.type} heat ${k2(h.ir)}${h.abState === "noAB" ? "" : ` (dry, ${from})`} × ${where} ${h.aspectFactor.toFixed(2)} = ${k2(h.seen)}`, "", HEAT_TIP);
    else chip(`${h.type} heat ${k2(h.ir)} dry × ${where} ${h.aspectFactor.toFixed(2)} = ${k2(h.seen)} · ${k2(h.seenAB)} if in AB (not recorded)`, "", HEAT_TIP);
  }
  // Flares (chaff apart: it fools radars, not heat-seekers).
  const f = ir.flares || {};
  if (cms.length || chaff.length || f.beforeLaunch) {
    const bits = [];
    if (cms.length) bits.push(`Flares from target ×${cms.length} (first at ${fmtRel(Math.min(...cms))})`);
    if (f.beforeLaunch) bits.push(`${f.beforeLaunch} in the 5 s before launch`);
    if (chaff.length) bits.push(`chaff ×${chaff.length}`);
    chip(bits.join(" · "));
  }
  if (ir.decoy) {
    const d = ir.decoy;
    const whose = d.owner && d.owner === T?.id ? `${T.pilot || T.name}'s flare` : "a flare";
    est(`Likely went for a flare at ${fmtRel(d.t)} (est.): predicted miss ${fmtShort(d.zemFlare)} from ${whose} vs ${fmtShort(d.zemTarget)} from the jet`, "warn",
      "Estimate from the recorded paths: from two samples in a row, the missile's zero-effort miss against a flare from the target's side was under 60 m and under 0.3 x its miss against the jet.");
  }
  const nf = ir.nearestFlare;
  if (nf && nf.dist < 50) chip(`Passed ${fmtShort(nf.dist)} from a flare at ${fmtRel(nf.t)}`, "", "Recorded: the closest the missile's path came to a flare from the target's side");
  if (isNum(ir.gimbalExceeded)) dcs(`look angle beyond the DCS gimbal (+8° margin) at ${fmtRel(ir.gimbalExceeded)}`, "warn");
  if (isNum(sk.power) && isNum(shot.timeOfFlight) && shot.timeOfFlight > sk.power) dcs("flight time longer than the seeker power time", "warn");
  if (isNum(sk.fuze) && isNum(shot.closestApproach) && shot.outcome !== "kill" && shot.closestApproach > 2 * sk.fuze + 10) {
    dcs(`passed outside the DCS fuze distance (${sk.fuze} m)`);
  }
}

const HEAT_TIP = "DCS IR emission coefficient (1.0 = a Su-27 without afterburner) × DCS aspect factor (tail ×1.5, beam ×1, nose ×0.5)";

/** Fly-out charts for an IR missile: predicted miss and look angle, target vs the best flare. */
function irCharts(ir, card, mk, xs) {
  const ser = ir.series;
  const x = ser.map((r) => r.t);
  const lg = (v) => (isNum(v) ? Math.log10(Math.max(1, Math.min(v, 3000))) : null); // log scale 1 m - 3 km
  // Up to where the missile passed the target: the end of the flare fight.
  const xMax = Math.min(xs[xs.length - 1], x[x.length - 1] + 1);
  const bands = ir.decoy ? [{ x0: ir.decoy.t, x1: xMax, color: "rgba(255,159,67,.14)" }] : [];
  const flareSeen = ser.some((r) => isNum(r.zemFlare));
  mk("Predicted miss (est., log scale)", [
    { name: "jet", color: "#ffd166", x, y: ser.map((r) => lg(r.zem)) },
    flareSeen ? { name: "best flare", color: "#ff9f43", x, y: ser.map((r) => lg(r.zemFlare)), dash: [4, 3] } : null,
  ].filter(Boolean), (v) => fmtShort(10 ** v), { yMin: 0, yMax: Math.log10(3000), xMax, bands });
  const gim = ir.seeker?.gimbal;
  mk("Seeker look angle (°)", [
    { name: "jet", color: "#ffd166", x, y: ser.map((r) => (isNum(r.look) ? r.look : null)) },
    flareSeen ? { name: "best flare", color: "#ff9f43", x, y: ser.map((r) => (isNum(r.lookFlare) ? r.lookFlare : null)), dash: [4, 3] } : null,
    isNum(gim) ? { name: `gimbal ${Math.round(gim)}° (DCS)`, color: "rgba(255,92,92,.7)", x: [x[0], x[x.length - 1]], y: [gim, gim], dash: [2, 3] } : null,
  ].filter(Boolean), (v) => `${Math.round(v)}°`, { yMin: 0, xMax, bands });
  if (ser.some((r) => isNum(r.heat))) {
    mk("Heat seen by the missile (DCS scale)", [
      { name: "heat", color: "#ff9f43", x, y: ser.map((r) => (isNum(r.heat) ? r.heat : null)) },
      ser.some((r) => isNum(r.heatAB)) ? { name: "if in AB", color: "#fff1a8", x, y: ser.map((r) => (isNum(r.heatAB) ? r.heatAB : null)), dash: [2, 3] } : null,
    ].filter(Boolean), (v) => v.toFixed(1), { yMin: 0, xMax, bands });
  }
}
