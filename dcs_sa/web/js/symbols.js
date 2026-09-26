// Drawing of tactical objects on the map.  Shared by review and live views.

import { COLORS, M_TO_FT, MPS_TO_KT, destination, isNum, sideColor, units } from "./util.js";

const TAU = Math.PI * 2;

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Short altitude label: flight level style in imperial, hundreds of metres in metric. */
function altTag(alt) {
  if (!isNum(alt)) return "";
  return units.metric ? `${Math.round(alt / 100)}` : `${Math.round((alt * M_TO_FT) / 100)}`;
}

// F-16 top view, nose at -1, normalised to half-length 1.
const F16_OUTLINE = [
  [0, -1], [0.05, -0.9], [0.09, -0.72], [0.11, -0.55], [0.17, -0.12], [0.63, 0.32], [0.65, 0.3],
  [0.65, 0.47], [0.13, 0.48], [0.12, 0.62], [0.39, 0.86], [0.39, 0.95], [0.08, 0.94], [0.07, 1],
  [-0.07, 1], [-0.08, 0.94], [-0.39, 0.95], [-0.39, 0.86], [-0.12, 0.62], [-0.13, 0.48], [-0.65, 0.47],
  [-0.65, 0.3], [-0.63, 0.32], [-0.17, -0.12], [-0.11, -0.55], [-0.09, -0.72], [-0.05, -0.9],
];

function drawAircraft(ctx, x, y, ang, color, size, rotor, f16 = false) {
  if (f16 && !rotor) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang + Math.PI / 2);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0,0,0,0.65)";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    F16_OUTLINE.forEach(([px, py], i) => (i ? ctx.lineTo(px * size * 1.25, py * size * 1.25) : ctx.moveTo(px * size * 1.25, py * size * 1.25)));
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    return;
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang + Math.PI / 2);
  ctx.fillStyle = color;
  ctx.strokeStyle = "rgba(0,0,0,0.65)";
  ctx.lineWidth = 1.2;
  const s = size;
  ctx.beginPath();
  if (rotor) {
    ctx.arc(0, 0, s * 0.55, 0, TAU);
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-s, 0); ctx.lineTo(s, 0);
    ctx.moveTo(0, -s); ctx.lineTo(0, s);
    ctx.stroke();
  } else {
    // Swept-wing silhouette pointing "up" (= heading after rotation).
    ctx.moveTo(0, -s);
    ctx.lineTo(s * 0.18, -s * 0.35);
    ctx.lineTo(s * 0.9, s * 0.25);
    ctx.lineTo(s * 0.9, s * 0.42);
    ctx.lineTo(s * 0.16, s * 0.18);
    ctx.lineTo(s * 0.14, s * 0.62);
    ctx.lineTo(s * 0.42, s * 0.88);
    ctx.lineTo(s * 0.42, s);
    ctx.lineTo(0, s * 0.86);
    ctx.lineTo(-s * 0.42, s);
    ctx.lineTo(-s * 0.42, s * 0.88);
    ctx.lineTo(-s * 0.14, s * 0.62);
    ctx.lineTo(-s * 0.16, s * 0.18);
    ctx.lineTo(-s * 0.9, s * 0.42);
    ctx.lineTo(-s * 0.9, s * 0.25);
    ctx.lineTo(-s * 0.18, -s * 0.35);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

function drawWeapon(ctx, x, y, ang, color, ir = false) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = color;
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
  ctx.stroke();
  if (ir) {
    // A heat-seeker: a hot, glowing nose.
    const g = ctx.createRadialGradient(7, 0, 0, 7, 0, 7);
    g.addColorStop(0, "rgba(255,210,122,0.45)");
    g.addColorStop(1, "rgba(255,159,67,0)");
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(7, 0, 7, 0, TAU); ctx.fill();
    ctx.fillStyle = "#ffd27a";
    ctx.beginPath(); ctx.arc(7, 0, 2.6, 0, TAU); ctx.fill();
    ctx.restore();
    return;
  }
  ctx.beginPath();
  ctx.arc(7, 0, 2.4, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawGround(ctx, x, y, color, obj) {
  const tags = obj.type || "";
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = withAlpha(color, 0.25);
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  if (tags.includes("AntiAircraft")) {
    // Diamond with a dot: air defence.
    ctx.moveTo(0, -7); ctx.lineTo(7, 0); ctx.lineTo(0, 7); ctx.lineTo(-7, 0); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(0, 0, 2, 0, TAU); ctx.fill();
  } else if (tags.includes("Sea")) {
    const big = tags.includes("AircraftCarrier");
    const L = big ? 11 : 8;
    ctx.moveTo(-L, -3); ctx.lineTo(L - 3, -3); ctx.lineTo(L, 0); ctx.lineTo(L - 3, 3); ctx.lineTo(-L, 3); ctx.closePath();
    ctx.fill(); ctx.stroke();
  } else if (tags.includes("Building") || tags.includes("Aerodrome")) {
    ctx.rect(-5, -5, 10, 10);
    ctx.stroke();
  } else {
    ctx.rect(-5.5, -4, 11, 8);
    ctx.fill(); ctx.stroke();
    if (tags.includes("Armor")) {
      ctx.beginPath(); ctx.ellipse(0, 0, 3.5, 2, 0, 0, TAU); ctx.stroke();
    }
  }
  if (obj.dead) {
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(-6, -6); ctx.lineTo(6, 6); ctx.moveTo(6, -6); ctx.lineTo(-6, 6); ctx.stroke();
  }
  ctx.restore();
}

function drawBullseye(ctx, map, obj) {
  const [x, y] = map.project(obj.lon, obj.lat);
  const nm = 1852;
  ctx.save();
  ctx.strokeStyle = "rgba(200,205,214,0.35)";
  ctx.fillStyle = "rgba(200,205,214,0.55)";
  ctx.font = "10px ui-monospace, monospace";
  ctx.lineWidth = 1;
  const mpp = map.metersPerPixel();
  const ringStep = [10, 20, 40, 80].find((r) => (r * nm) / mpp > 60) || 80;
  for (let r = ringStep; r <= ringStep * 4; r += ringStep) {
    const rp = (r * nm) / mpp;
    ctx.beginPath(); ctx.arc(x, y, rp, 0, TAU); ctx.stroke();
    ctx.fillText(`${r}`, x + 3, y - rp - 2);
  }
  ctx.strokeStyle = "rgba(200,205,214,0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, 6, 0, TAU); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke();
  ctx.fillText("BULLSEYE", x + 9, y + 14);
  ctx.restore();
}

/**
 * Radar search volumes by DCS type name (ACMI Name=): half-angles in degrees.
 * From DCS's own sensor data and the module manuals: F-16C APG-68 A6 = +/-60,
 * F/A-18C APG-73 +/-70, FC3 Russian radars scan 60 deg wide, 4 bars ~ +/-5 deg.
 * Real DCS recordings carry no radar properties, so for other jets this table
 * is what an "assumed" cone is drawn from.
 */
const RADAR_TYPES = [
  [/^F-16/, { az: 60, el: 5 }], [/^FA-18|^F\/A-18/, { az: 70, el: 3.6 }], [/^F-15/, { az: 60, el: 5 }],
  [/^F-14/, { az: 65, el: 5 }], [/^MiG-29/, { az: 30, el: 5 }], [/^(Su-27|Su-33|J-11)/, { az: 30, el: 5 }],
  [/^Su-30/, { az: 60, el: 5 }], [/^JF-17/, { az: 60, el: 5 }], [/^M-2000/, { az: 60, el: 5 }],
  [/^Mirage-F1/, { az: 60, el: 5 }], [/^F-5E/, { az: 45, el: 5 }], [/^MiG-21/, { az: 30, el: 5 }],
  [/^AJS37/, { az: 60, el: 5 }], [/^MiG-31/, { az: 70, el: 5, range: 200000 }], [/^MiG-25/, { az: 30, el: 5 }],
  [/^(E-3|A-50|KJ-2000|E-2)/, { az: 180, el: 10, range: 400000, surface: true }],
];
const DEFAULT_AIR_RANGE = 74000; // 40 nm display range

export function radarType(name) {
  for (const [re, spec] of RADAR_TYPES) if (re.test(name || "")) return spec;
  return null;
}

/**
 * The radar volume to draw for an object, from the best source available:
 *   recorded  - Radar* properties in the recording (ACMI: the beamwidths are the
 *               volume's full size, angles relative to the airframe)
 *   dcs       - read live from DCS (your scan zone; every unit's radar on/off)
 *   assumed   - per-type table, for radar-equipped aircraft in flight
 * Returns null when nothing should be drawn.
 */
export function radarVolume(o, { assumed = true } = {}) {
  const v = o.v || {};
  const air = ["fixedwing", "rotorcraft", "air"].includes(o.category);
  const spec = air ? radarType(o.name) : null;
  const surfaceSpec = !air;
  const range = (isNum(v.RadarRange) && v.RadarRange > 0) ? v.RadarRange : (spec && spec.range) || (air ? DEFAULT_AIR_RANGE : 90000);

  if (isNum(v.RadarMode)) {
    if (v.RadarMode <= 0) return null;
    const H = v.RadarHorizontalBeamwidth, V = v.RadarVerticalBeamwidth;
    if (isNum(H) && H > 0) {
      return {
        source: "recorded", surface: surfaceSpec || H >= 359, range,
        az: Math.min(H / 2, 180), el: Math.max((isNum(V) && V > 0 ? V : H) / 2, 0.5),
        centerAz: isNum(v.RadarAzimuth) ? v.RadarAzimuth : 0, centerEl: isNum(v.RadarElevation) ? v.RadarElevation : 0,
        roll: isNum(v.RadarRoll) ? v.RadarRoll : 0, bodyFrame: air,
      };
    }
  }
  if (isNum(v.ScanAz) && v.ScanAz > 0) {
    return {
      source: "dcs", surface: false, range, az: v.ScanAz, el: isNum(v.ScanEl) && v.ScanEl > 0 ? v.ScanEl : 5,
      centerAz: isNum(v.ScanCenterAz) ? v.ScanCenterAz : 0, centerEl: isNum(v.ScanCenterEl) ? v.ScanCenterEl : 0,
      roll: 0, bodyFrame: false, label: v.ScanLabel,
    };
  }
  const on = isNum(v.RadarMode) ? v.RadarMode > 0 : isNum(v.RadarActive) ? v.RadarActive > 0 : null;
  if (on === false) return null;
  if (air && spec) {
    if (on === null && !assumed) return null;
    const airborne = !(isNum(o.agl) && o.agl < 20) && !(isNum(o.tas) && o.tas < 40);
    if (!airborne && !spec.surface) return null;
    return {
      // Radar known to be on (recorded mode or DCS unit flag), volume from the type table.
      source: on === null ? "assumed" : "type", surface: !!spec.surface, range,
      az: spec.az, el: spec.el, centerAz: 0, centerEl: spec.surface ? spec.el : 0, roll: 0, bodyFrame: false,
    };
  }
  if (!air && on) {
    // Surface search radar reported on with no geometry: full circle up to 30 deg.
    return { source: isNum(v.RadarMode) ? "recorded" : "dcs", surface: true, range, az: 180, el: 15, centerAz: 0, centerEl: 15, roll: 0, bodyFrame: false };
  }
  return null;
}

/** Radar search volume footprint: wedge (air) or ring (surface / 360 deg). */
export function drawRadar(ctx, map, obj, { assumed = true } = {}) {
  const r = radarVolume(obj, { assumed });
  if (!r) return;
  const hdg = isNum(obj.hdg) ? obj.hdg : 0;
  const color = sideColor(obj);
  const mpp = map.metersPerPixel();
  const rpx = Math.min(r.range / mpp, 4000);
  const [x, y] = map.project(obj.lon, obj.lat);
  const guess = r.source === "assumed";
  ctx.save();
  ctx.fillStyle = withAlpha(color, r.surface ? 0.03 : guess ? 0.035 : 0.07);
  ctx.strokeStyle = withAlpha(color, guess ? 0.3 : 0.45);
  ctx.lineWidth = 1;
  if (guess) ctx.setLineDash([5, 5]);
  ctx.beginPath();
  if (r.surface || r.az >= 180) {
    ctx.arc(x, y, rpx, 0, TAU);
  } else {
    const c = hdg + r.centerAz;
    ctx.moveTo(x, y);
    ctx.arc(x, y, rpx, map.screenAngle(c - r.az), map.screenAngle(c + r.az));
    ctx.closePath();
  }
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/** Gun rounds from roundsAt(): faint path, bright tracer head, impact puff. */
export function drawRounds(ctx, map, rounds) {
  if (!rounds || !rounds.length) return;
  ctx.save();
  ctx.lineCap = "round";
  for (const r of rounds) {
    const color = sideColor(r);
    const pts = r.pts.map((p) => map.project(p[0], p[1]));
    if (pts.length >= 2) {
      ctx.strokeStyle = withAlpha(color, 0.45 * r.fade);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(...pts[0]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(...pts[i]);
      ctx.stroke();
    }
    const [hx, hy] = map.project(r.head[0], r.head[1]);
    if (r.impacted) {
      ctx.fillStyle = `rgba(255,190,110,${0.8 * r.fade})`;
      ctx.beginPath(); ctx.arc(hx, hy, 2.2, 0, TAU); ctx.fill();
    } else {
      // Tracer: a short bright streak ending at the round, pointing along
      // its path (the last point that is not the head itself).
      let prev = null;
      for (let k = pts.length - 1; k >= 0; k--) {
        if (Math.hypot(pts[k][0] - hx, pts[k][1] - hy) > 0.5) { prev = pts[k]; break; }
      }
      ctx.strokeStyle = "rgba(255,226,140,0.95)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (prev) {
        const dx = hx - prev[0], dy = hy - prev[1], len = Math.hypot(dx, dy) || 1;
        const l = Math.min(len, 9);
        ctx.moveTo(hx - (dx / len) * l, hy - (dy / len) * l);
      } else ctx.moveTo(hx - 1, hy);
      ctx.lineTo(hx, hy);
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function drawEngagementRing(ctx, map, obj) {
  const v = obj.v || {};
  const r = v.EngagementRange;
  if (!isNum(r) || r <= 0) return;
  const [x, y] = map.project(obj.lon, obj.lat);
  const rpx = r / map.metersPerPixel();
  if (rpx < 4 || rpx > 6000) return;
  const color = sideColor(obj);
  ctx.save();
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = withAlpha(color, 0.55);
  ctx.fillStyle = withAlpha(color, 0.04);
  ctx.lineWidth = 1.3;
  ctx.beginPath(); ctx.arc(x, y, rpx, 0, TAU); ctx.fill(); ctx.stroke();
  ctx.restore();
}

/**
 * Draw a set of objects (o.noLabel suppresses an object's label).
 * opts: { selectedId, focusId, labels: "all"|"aircraft"|"targets"|"minimal"|"none", showTrails, trailSeconds,
 *         showRadar: "focus"|"all"|"known"|"none", showRings (false = none), ringFilter(o) -> bool,
 *         lockLines, byId, alphaOf(o) -> 0..1 (dimming), vectors: seconds of velocity vector (0 = off),
 *         bullseye: false hides the bullseye, labelScale: label text size (1 = 11 px) }
 * Objects may carry `tag` (an extra label line), `labelMe` (label it in
 * "targets" mode) and `dispenser` (a bomblet: drawn as a dot, nothing else).
 */
export function drawScene(ctx, map, objects, opts = {}) {
  const byId = opts.byId || new Map(objects.map((o) => [o.id, o]));
  const hits = [];
  const alphaOf = opts.alphaOf || (() => 1);
  const fade = (o) => { const a = alphaOf(o); ctx.globalAlpha = a; return a; };

  // Pass 1: rings, radar, trails, lock lines (underneath symbols).
  for (const o of objects) {
    if (o.category === "bullseye") { ctx.globalAlpha = 1; if (opts.bullseye !== false) drawBullseye(ctx, map, o); continue; }
    if (o.dispenser || fade(o) <= 0) continue;
    // A destroyed SAM no longer threatens anyone.
    if (!o.dead && opts.showRings !== false && (!opts.ringFilter || opts.ringFilter(o))) drawEngagementRing(ctx, map, o);
    const radarMode = opts.showRadar || "focus";
    if (radarMode === "all" || radarMode === "known" || (radarMode === "focus" && (o.id === opts.focusId || o.id === opts.selectedId))) {
      drawRadar(ctx, map, o, { assumed: radarMode !== "known" });
    }
  }
  ctx.globalAlpha = 1;
  if (opts.showTrails !== false) {
    for (const o of objects) {
      const trail = o.trail;
      if (!trail || trail.length < 2 || o.dispenser) continue;
      if (fade(o) <= 0) continue;
      const color = sideColor(o);
      const weapon = o.category === "weapon";
      ctx.lineWidth = weapon ? 1.4 : o.id === opts.focusId ? 2.2 : 1.5;
      const n = trail.length;
      const tc = !weapon && o.trailColors && o.trailColors.length === n ? o.trailColors : null;
      let prev = map.project(trail[0][0], trail[0][1]);
      for (let i = 1; i < n; i++) {
        const p = map.project(trail[i][0], trail[i][1]);
        const alpha = (weapon ? 0.55 : tc ? 0.9 : 0.75) * (0.15 + 0.85 * (i / n));
        const c = tc && tc[i];
        ctx.strokeStyle = c ? `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${alpha})`
          : withAlpha(weapon ? "#ffffff" : color, alpha);
        if (tc) ctx.lineWidth = o.id === opts.focusId ? 3 : 2.2;
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
        prev = p;
      }
    }
    ctx.globalAlpha = 1;
  }
  if (opts.rounds) drawRounds(ctx, map, opts.rounds);
  if (opts.vectors > 0) {
    // Where each aircraft will be in `vectors` seconds at its current speed and heading.
    ctx.save();
    ctx.lineWidth = 1.6;
    for (const o of objects) {
      if (!["fixedwing", "rotorcraft", "air"].includes(o.category) || o.dead || fade(o) <= 0) continue;
      const end = vectorEnd(o, opts.vectors);
      if (!end) continue;
      const a = map.project(o.lon, o.lat), b = map.project(end[0], end[1]);
      ctx.strokeStyle = withAlpha(sideColor(o), 0.85);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      ctx.beginPath(); ctx.arc(b[0], b[1], 2, 0, TAU); ctx.fill();
    }
    ctx.restore();
  }
  if (opts.lockLines !== false) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.3;
    for (const o of objects) {
      if (!o.lock || fade(o) <= 0) continue;
      const t = byId.get(o.lock);
      if (!t) continue;
      const a = map.project(o.lon, o.lat), b = map.project(t.lon, t.lat);
      ctx.strokeStyle = withAlpha(sideColor(o), 0.8);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    ctx.restore();
  }

  // Pass 2: symbols.
  const order = { ground: 0, sea: 0, navaid: 0, misc: 0, countermeasure: 1, weapon: 2, rotorcraft: 3, air: 3, fixedwing: 3 };
  const sorted = objects.filter((o) => o.category !== "bullseye").sort((a, b) => (order[a.category] ?? 0) - (order[b.category] ?? 0));
  for (const o of sorted) {
    const [x, y] = map.project(o.lon, o.lat);
    if (x < -50 || y < -50 || x > map.w + 50 || y > map.h + 50) continue;
    if (fade(o) <= 0) continue;
    if (o.dispenser) {
      // A bomblet: a dot, no label or hitbox (a JSOW-A releases 145 of them).
      ctx.fillStyle = "rgba(255,196,120,0.9)";
      ctx.fillRect(x - 1, y - 1, 2, 2);
      continue;
    }
    const color = sideColor(o);
    const ang = isNum(o.hdg) ? map.screenAngle(o.hdg) : -Math.PI / 2;
    const selected = o.id === opts.selectedId;
    const focus = o.id === opts.focusId;
    switch (o.category) {
      case "fixedwing": case "rotorcraft": case "air":
        if (selected || focus) {
          ctx.save();
          ctx.strokeStyle = focus ? "#ffd166" : "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 15, 0, TAU); ctx.stroke();
          ctx.restore();
        }
        drawAircraft(ctx, x, y, ang, o.dead ? "#777" : color, focus ? 11 : 9, o.category === "rotorcraft", /\bF-?16/i.test(o.name || ""));
        hits.push({ id: o.id, x, y, r: 14 });
        break;
      case "weapon":
        drawWeapon(ctx, x, y, ang, color, !!o.irSeeker);
        hits.push({ id: o.id, x, y, r: 9 });
        break;
      case "countermeasure":
        if (o.cmKind === "chaff") {
          ctx.fillStyle = "rgba(200,205,214,0.6)";
          ctx.fillRect(x - 0.8, y - 0.8, 1.6, 1.6);
        } else {
          // A flare: a white-hot core fading over its ~9 s life, ringed in its jet's side colour.
          const life = isNum(o.age) ? Math.max(0, 1 - o.age / 9) : 1;
          const a0 = fade(o);
          if (o.cmTail) {
            ctx.globalAlpha = 0.35 * a0;
            ctx.strokeStyle = "#ffb347";
            ctx.lineWidth = 1;
            ctx.beginPath();
            o.cmTail.forEach(([lo, la], i) => { const [px, py] = map.project(lo, la); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
            ctx.stroke();
          }
          ctx.globalAlpha = (0.35 + 0.65 * life) * a0;
          ctx.fillStyle = "#fff1c9";
          ctx.beginPath(); ctx.arc(x, y, 2.2, 0, TAU); ctx.fill();
          if (o.cmColor) {
            ctx.strokeStyle = withAlpha(o.cmColor, 0.9);
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.arc(x, y, 3.6, 0, TAU); ctx.stroke();
          }
          ctx.globalAlpha = fade(o);
          hits.push({ id: o.id, x, y, r: 6 });
        }
        break;
      default:
        drawGround(ctx, x, y, color, o);
        if (selected) {
          ctx.save();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, 12, 0, TAU); ctx.stroke();
          ctx.restore();
        }
        hits.push({ id: o.id, x, y, r: 9 });
    }
  }
  ctx.globalAlpha = 1;

  // Pass 3: labels.
  const labels = opts.labels || "aircraft";
  if (labels !== "none") {
    const fs = Math.round(11 * (opts.labelScale || 1));
    ctx.font = `${fs}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.textBaseline = "middle";
    for (const o of sorted) {
      if (o.dispenser || alphaOf(o) < 0.5) continue; // no labels on dimmed objects
      const air = ["fixedwing", "rotorcraft", "air"].includes(o.category);
      const show = !o.noLabel && (air || (labels === "all" && o.category !== "countermeasure") || (labels === "targets" && o.labelMe) ||
        o.id === opts.selectedId || (o.category === "weapon" && labels !== "minimal") || !!o.tag || !!o.tag2);
      if (!show) continue;
      const [x, y] = map.project(o.lon, o.lat);
      if (x < -50 || y < -50 || x > map.w + 50 || y > map.h + 50) continue;
      const lines = [];
      if (air) {
        lines.push(o.pilot || o.name);
        const spd = isNum(o.ias) ? o.ias : isNum(o.tas) ? o.tas : null;
        const bits = [altTag(o.alt)];
        if (isNum(spd)) bits.push(units.metric ? `${Math.round(spd * 3.6)}` : `${Math.round(spd * MPS_TO_KT)}`);
        if (o.pilot && o.name && labels !== "minimal") lines.push(`${o.name}`);
        lines.push(bits.filter(Boolean).join(" · "));
      } else {
        lines.push(o.name);
      }
      if (o.tag) lines.push(o.tag);
      if (o.tag2) lines.push(o.tag2);
      const color = o.category === "weapon" ? "#e8ecf2" : sideColor(o);
      const lx = x + 14, ly = y - 8;
      for (let i = 0; i < lines.length; i++) {
        const txt = lines[i];
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(6,9,13,0.85)";
        ctx.strokeText(txt, lx, ly + i * (fs + 1));
        ctx.fillStyle = i === 0 ? color : "rgba(220,225,232,0.8)";
        ctx.fillText(txt, lx, ly + i * (fs + 1));
      }
    }
  }
  return hits;
}

/**
 * Where the ray from (x0, y0) towards (x1, y1) leaves the rectangle
 * [inset, w - inset] x [inset, h - inset].  {x, y, ang} with ang the ray's
 * screen angle, or null when (x1, y1) is inside the rectangle.
 */
export function edgeAnchor(x0, y0, x1, y1, w, h, inset = 22) {
  const ins = typeof inset === "number" ? { top: inset, right: inset, bottom: inset, left: inset } : { top: 22, right: 22, bottom: 22, left: 22, ...inset };
  const L = ins.left, T = ins.top, Rr = w - ins.right, B = h - ins.bottom;
  if (x1 >= L && x1 <= Rr && y1 >= T && y1 <= B) return null;
  // Start from inside the rectangle even when the origin is off screen.
  const cx = Math.max(L, Math.min(Rr, x0)), cy = Math.max(T, Math.min(B, y0));
  const dx = x1 - cx, dy = y1 - cy;
  let kx = Infinity, ky = Infinity;
  if (dx > 0) kx = (Rr - cx) / dx; else if (dx < 0) kx = (L - cx) / dx;
  if (dy > 0) ky = (B - cy) / dy; else if (dy < 0) ky = (T - cy) / dy;
  const k = Math.min(kx, ky);
  if (!Number.isFinite(k)) return null;
  // edge: "v" = left/right side (stack along y), "h" = top/bottom (stack along x).
  return { x: cx + dx * k, y: cy + dy * k, ang: Math.atan2(dy, dx), edge: kx <= ky ? "v" : "h", rect: { L, T, R: Rr, B } };
}

/**
 * Arrowheads on the map edge pointing at off-screen contacts.
 * list: [{id, lon, lat, color, text, dashed?}]; inset: px or {top, right, bottom, left}
 * (to keep arrows clear of HUD panels).  Returns hitboxes [{id, x, y, r, item}].
 */
export function drawEdgePointers(ctx, map, from, list, inset = 22) {
  const hits = [];
  const placed = [];
  ctx.save();
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  // Most urgent first, so it keeps the exact spot and others stack beside it.
  const ordered = [...list].sort((p, q) => (q.level ?? 0) - (p.level ?? 0));
  for (const it of ordered) {
    const [x1, y1] = map.project(it.lon, it.lat);
    const a = edgeAnchor(from[0], from[1], x1, y1, map.w, map.h, inset);
    if (!a) continue;
    // Contacts on (nearly) the same bearing: take the first free slot along
    // the edge the arrow sits on (alternating sides, kept on the canvas), so
    // every arrow, tag and hitbox stays readable.
    const along = a.edge === "v" ? [0, 1] : [1, 0];
    const free = (x, y) => !placed.some((p) => Math.hypot(p.x - x, p.y - y) < 22);
    let clash = 0;
    if (!free(a.x, a.y)) {
      for (let n = 1; n < 40; n++) {
        const s = (n % 2 ? 1 : -1) * Math.ceil(n / 2) * 24;
        const x = Math.max(a.rect.L, Math.min(a.rect.R, a.x + along[0] * s));
        const y = Math.max(a.rect.T, Math.min(a.rect.B, a.y + along[1] * s));
        if (free(x, y)) { a.x = x; a.y = y; clash = n; break; }
      }
    }
    placed.push({ x: a.x, y: a.y });
    if (it.dashed) {
      ctx.save();
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = it.color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(from[0], from[1]); ctx.lineTo(a.x, a.y); ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(a.x, a.y);
    ctx.rotate(a.ang);
    ctx.fillStyle = it.color;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(-6, -7); ctx.lineTo(-2, 0); ctx.lineTo(-6, 7); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
    if (it.text) {
      // Tag on the inward side of the arrow.
      const tw = ctx.measureText(it.text).width;
      const ix = a.x - Math.cos(a.ang) * 16, iy = a.y - Math.sin(a.ang) * 16;
      let tx = Math.cos(a.ang) > 0.3 ? ix - tw : Math.cos(a.ang) < -0.3 ? ix : ix - tw / 2;
      tx = Math.max(4, Math.min(map.w - tw - 4, tx));
      // On the top/bottom edge, stacked arrows get stacked tags too.
      const vert = Math.sin(a.ang) > 0.3 ? -1 : Math.sin(a.ang) < -0.3 ? 1 : 0;
      const ty = Math.max(10, Math.min(map.h - 10, iy + vert * (8 + (a.edge === "h" ? 13 * clash : 0))));
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(6,9,13,0.9)";
      ctx.strokeText(it.text, tx, ty);
      ctx.fillStyle = it.color;
      ctx.fillText(it.text, tx, ty);
    }
    hits.push({ id: it.id, x: a.x, y: a.y, r: 16, item: it });
  }
  ctx.restore();
  return hits;
}

/** Destination helper re-exported for heading/velocity vectors. */
export function vectorEnd(o, seconds) {
  const spd = isNum(o.tas) ? o.tas : isNum(o.ias) ? o.ias : null;
  if (!isNum(spd) || !isNum(o.hdg)) return null;
  return destination(o.lon, o.lat, o.hdg, spd * seconds);
}

export { COLORS, withAlpha };
