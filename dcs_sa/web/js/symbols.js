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

function drawWeapon(ctx, x, y, ang, color) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.strokeStyle = color;
  ctx.fillStyle = "#fff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-7, 0); ctx.lineTo(7, 0);
  ctx.stroke();
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

/** Radar coverage wedge and antenna line for one aircraft. */
export function drawRadar(ctx, map, obj) {
  const v = obj.v || {};
  if (!isNum(v.RadarMode) || v.RadarMode <= 0 || !isNum(obj.hdg)) return;
  const range = isNum(v.RadarRange) && v.RadarRange > 0 ? v.RadarRange : 74000;
  const color = sideColor(obj);
  const mpp = map.metersPerPixel();
  const rpx = Math.min(range / mpp, 4000);
  const [x, y] = map.project(obj.lon, obj.lat);
  ctx.save();
  // Generic +/-60 deg search volume - ACMI does not carry scan limits.
  ctx.fillStyle = withAlpha(color, 0.06);
  ctx.strokeStyle = withAlpha(color, 0.25);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.arc(x, y, rpx, map.screenAngle(obj.hdg - 60), map.screenAngle(obj.hdg + 60));
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (isNum(v.RadarAzimuth)) {
    const az = obj.hdg + v.RadarAzimuth;
    const bw = isNum(v.RadarHorizontalBeamwidth) ? v.RadarHorizontalBeamwidth : 3;
    ctx.fillStyle = withAlpha(color, 0.22);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.arc(x, y, rpx, map.screenAngle(az - bw / 2), map.screenAngle(az + bw / 2));
    ctx.closePath();
    ctx.fill();
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
 * Draw a set of objects.
 * opts: { selectedId, focusId, labels: "all"|"aircraft"|"none", showTrails, trailSeconds,
 *         showRadar: "focus"|"all"|"none", showRings, lockLines, byId }
 */
export function drawScene(ctx, map, objects, opts = {}) {
  const byId = opts.byId || new Map(objects.map((o) => [o.id, o]));
  const hits = [];

  // Pass 1: rings, radar, trails, lock lines (underneath symbols).
  for (const o of objects) {
    if (o.category === "bullseye") { drawBullseye(ctx, map, o); continue; }
    if (opts.showRings !== false) drawEngagementRing(ctx, map, o);
    const radarMode = opts.showRadar || "focus";
    if (radarMode === "all" || (radarMode === "focus" && (o.id === opts.focusId || o.id === opts.selectedId))) {
      drawRadar(ctx, map, o);
    }
  }
  if (opts.showTrails !== false) {
    for (const o of objects) {
      const trail = o.trail;
      if (!trail || trail.length < 2) continue;
      const color = sideColor(o);
      const weapon = o.category === "weapon";
      ctx.lineWidth = weapon ? 1.4 : o.id === opts.focusId ? 2.2 : 1.5;
      const n = trail.length;
      let prev = map.project(trail[0][0], trail[0][1]);
      for (let i = 1; i < n; i++) {
        const p = map.project(trail[i][0], trail[i][1]);
        ctx.strokeStyle = withAlpha(weapon ? "#ffffff" : color, (weapon ? 0.55 : 0.75) * (0.15 + 0.85 * (i / n)));
        ctx.beginPath(); ctx.moveTo(prev[0], prev[1]); ctx.lineTo(p[0], p[1]); ctx.stroke();
        prev = p;
      }
    }
  }
  if (opts.lockLines !== false) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.lineWidth = 1.3;
    for (const o of objects) {
      if (!o.lock) continue;
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
        drawWeapon(ctx, x, y, ang, color);
        hits.push({ id: o.id, x, y, r: 9 });
        break;
      case "countermeasure":
        ctx.fillStyle = "rgba(255,210,120,0.8)";
        ctx.beginPath(); ctx.arc(x, y, 1.6, 0, TAU); ctx.fill();
        break;
      default:
        drawGround(ctx, x, y, color, o);
        hits.push({ id: o.id, x, y, r: 9 });
    }
  }

  // Pass 3: labels.
  const labels = opts.labels || "aircraft";
  if (labels !== "none") {
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.textBaseline = "middle";
    for (const o of sorted) {
      const air = ["fixedwing", "rotorcraft", "air"].includes(o.category);
      const show = air || (labels === "all" && o.category !== "countermeasure") ||
        o.id === opts.selectedId || (o.category === "weapon" && labels !== "minimal");
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
      } else if (o.category === "weapon") {
        lines.push(o.name);
      } else {
        lines.push(o.name);
      }
      const color = o.category === "weapon" ? "#e8ecf2" : sideColor(o);
      const lx = x + 14, ly = y - 8;
      for (let i = 0; i < lines.length; i++) {
        const txt = lines[i];
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(6,9,13,0.85)";
        ctx.strokeText(txt, lx, ly + i * 12);
        ctx.fillStyle = i === 0 ? color : "rgba(220,225,232,0.8)";
        ctx.fillText(txt, lx, ly + i * 12);
      }
    }
  }
  return hits;
}

/** Destination helper re-exported for heading/velocity vectors. */
export function vectorEnd(o, seconds) {
  const spd = isNum(o.tas) ? o.tas : isNum(o.ias) ? o.ias : null;
  if (!isNum(spd) || !isNum(o.hdg)) return null;
  return destination(o.lon, o.lat, o.hdg, spd * seconds);
}

export { COLORS, withAlpha };
