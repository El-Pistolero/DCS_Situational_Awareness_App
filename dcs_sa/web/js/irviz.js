// Heat (IR) overlay for the 2D map.
//
// What is DCS data (drawn solid): each aircraft type's IR emission
// coefficient, dry and in afterburner (1.0 = a Su-27 at military power), the
// aspect factor (x1.5 from the tail, x1 beam, x0.5 nose-on: DCS prbCoeff k7),
// and each IR missile's seeker limits (gimbal, launch look angle).
// What is recorded: positions, flares, and afterburner for the recording
// player only (engine data); AI afterburner is never guessed: the dry value
// is drawn solid and the afterburner one dotted, "if in AB".
// What is an estimate (dashed, "est."): which flare a missile went for, and
// how far a seeker could see a jet.

import { destination, distance, fmtDist, isNum, sampleTrack, sideColor } from "./util.js";

const TAU = Math.PI * 2;
const RAD = Math.PI / 180;
/** DCS prbCoeff k7: heat seen nose-on k7, beam 1, tail 2 - k7. */
export const K7 = 0.5;
export const aspectFactor = (tailDeg) => 1 + (1 - K7) * Math.cos(tailDeg * RAD);
export const AMBER = "#ffb347";
export const HEAT_UNKNOWN = "#8d9aab";

// Heat ramp on a log2 scale from 1/8 to 8 (Su-27 dry = 1 sits in the middle).
const HEAT_STOPS = [[0x5b, 0x3a, 0x29], [0xa8, 0x44, 0x2a], [0xe0, 0x66, 0x2b], [0xff, 0x9f, 0x43], [0xff, 0xd2, 0x7a], [0xff, 0xf4, 0xd6]];

/** Colour for a heat value K on DCS's scale. */
export function heatColor(k, a = 1) {
  const f = Math.max(0, Math.min(1, (Math.log2(Math.max(k, 1e-3)) + 3) / 6)) * (HEAT_STOPS.length - 1);
  const i = Math.min(HEAT_STOPS.length - 2, Math.floor(f)), u = f - i;
  const c = HEAT_STOPS[i].map((v, j) => Math.round(v + (HEAT_STOPS[i + 1][j] - v) * u));
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}

/** CSS gradient of the heat ramp (legend). */
export const HEAT_CSS = `linear-gradient(90deg, ${HEAT_STOPS.map((c) => `rgb(${c.join(",")})`).join(", ")})`;

const fmtK = (k) => (k >= 10 ? k.toFixed(0) : k >= 1 ? k.toFixed(1) : k.toFixed(2).replace(/0$/, ""));

/** Afterburner at t: true / false, or null when it is not recorded. */
export function abAt(h, t) {
  if (!h) return null;
  if (h.state === "noAB") return false;
  if (h.state !== "recorded") return null;
  return h.spans.some(([a, b]) => a <= t && t <= b);
}

/**
 * Heat coefficient at t: {c, lit, dry, ab, cAB}.  c is the known value (dry
 * when AB is not recorded, a lower bound); cAB is set only when the jet can
 * light an afterburner and whether it did is not recorded.
 */
export function heatNow(h, t) {
  if (!h || !isNum(h.ir)) return null;
  const lit = abAt(h, t);
  const ab = isNum(h.irAB) ? h.irAB : null;
  return { c: lit && ab ? ab : h.ir, lit, dry: h.ir, ab, cAB: lit === null && ab ? ab : null };
}

/** "IR 0.6" / "IR 3.0 AB" / "IR 0.6 · 3.0 if AB". */
export function heatText(hn) {
  if (!hn) return "";
  if (hn.lit === true) return `IR ${fmtK(hn.c)} AB`;
  if (hn.cAB) return `IR ${fmtK(hn.dry)} · ${fmtK(hn.cAB)} if AB`;
  return `IR ${fmtK(hn.c)}`;
}

/** Tooltip for the heat numbers. */
export const HEAT_NOTE = "DCS IR emission coefficient: 1.0 = a Su-27 without afterburner. Seen from the tail x1.5, "
  + "the beam x1, nose-on x0.5 (DCS prbCoeff k7). Afterburner is only known from recorded engine data "
  + "(the recording player's jet); for others both values are shown.";

/**
 * Everything the IR overlay needs that does not change with time.
 * objects: Map id -> object with .pb.
 */
export function prepareIR(analysis, objects) {
  const ir = analysis?.ir || {};
  const shots = [];
  for (const s of analysis?.weapons?.shots || []) {
    if (!s.ir) continue;
    const decoy = s.ir.decoy || null;
    shots.push({
      s, sk: s.ir.seeker || {}, weapon: objects.get(s.weaponId) || null,
      target: s.targetId ? objects.get(s.targetId) || null : null,
      t0: s.launchTime, t1: isNum(s.endTime) ? s.endTime : s.launchTime + (s.timeOfFlight || 0),
      decoyT: decoy ? s.launchTime + decoy.t : null,
      flare: decoy ? objects.get(decoy.flareId) || null : null,
    });
  }
  return { heat: ir.heat || {}, flares: ir.flares || {}, salvos: ir.salvos || {}, shots };
}

/** IR shots with the missile in flight at t. */
export const irInFlight = (prep, t) => (prep?.shots || []).filter((x) => x.weapon && x.t0 <= t && t <= x.t1 + 0.05);

// ---------------------------------------------------------------------------

function limacon(ctx, x, y, tail, rOf, n = 48) {
  ctx.beginPath();
  for (let k = 0; k <= n; k++) {
    const phi = (k / n) * TAU;
    const r = rOf(phi);
    const px = x + r * Math.cos(tail + phi), py = y + r * Math.sin(tail + phi);
    k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
  }
  ctx.closePath();
}

/**
 * Heat lobes: DCS's aspect model drawn around each jet, pointing out of the
 * tailpipe.  Area is proportional to heat (r ~ sqrt), so an F-16 in
 * afterburner (3.0) covers five times the area of a dry one (0.6).
 * rows: scene rows (lon, lat, hdg, dead, tas); heat: analysis.ir.heat.
 */
export function drawHeatLobes(ctx, map, rows, t, heat, { scale = 1 } = {}) {
  const s = 11 * scale, cap = 60 * scale;
  ctx.save();
  for (const o of rows) {
    if (o.dead || !isNum(o.hdg)) continue;
    if (isNum(o.tas) && o.tas < 30) continue; // parked
    const hn = heatNow(heat[o.id], t);
    if (!hn) continue;
    const [x, y] = map.project(o.lon, o.lat);
    if (x < -80 || y < -80 || x > map.w + 80 || y > map.h + 80) continue;
    const tail = map.screenAngle((o.hdg + 180) % 360);
    const rOf = (c) => (phi) => Math.min(cap, s * Math.sqrt(c * (1 + (1 - K7) * Math.cos(phi))));
    limacon(ctx, x, y, tail, rOf(hn.c));
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.min(cap, s * Math.sqrt(hn.c * 1.5)));
    g.addColorStop(0, heatColor(hn.c * 1.5, hn.lit ? 0.55 : 0.32));
    g.addColorStop(1, heatColor(hn.c, 0.04));
    ctx.fillStyle = g;
    ctx.fill();
    ctx.lineWidth = 1.1;
    ctx.setLineDash([]);
    ctx.strokeStyle = heatColor(hn.c * 1.5, 0.75);
    ctx.stroke();
    if (hn.cAB) {
      // Afterburner not recorded: how big it would be if lit.
      limacon(ctx, x, y, tail, rOf(hn.cAB));
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = heatColor(hn.cAB * 1.5, 0.6);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------

function velocityHeading(pb, t) {
  const a = sampleTrack(pb, Math.max(pb.t[0], t - 0.3)), b = sampleTrack(pb, t);
  if (!a || !b) return null;
  const d = distance(a.lon, a.lat, b.lon, b.lat);
  if (d < 1) return isNum(b.hdg) ? b.hdg : null;
  const y = Math.sin((b.lon - a.lon) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) - Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lon - a.lon) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

/** Local east/north/up metres of b relative to a. */
function enu(a, b) {
  const k = 111320 * Math.cos(a.lat * RAD);
  return [(b.lon - a.lon) * k, (b.lat - a.lat) * 110574, (isNum(b.alt) ? b.alt : 0) - (isNum(a.alt) ? a.alt : 0)];
}
function angle3(u, v) {
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  if (lu < 1e-6 || lv < 1e-6) return null;
  return Math.acos(Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv)))) / RAD;
}

function text(ctx, s, x, y, color, align = "left") {
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(6,9,13,0.9)";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
  ctx.textAlign = "left";
}

/**
 * IR missiles in flight: the gimbal limit (DCS) as a faint wedge ahead of the
 * missile, the line to what it is steering at (its target, or after the
 * estimated decoy moment the flare, dashed), and flares near its line of
 * sight.  list: from irInFlight(); objects: Map for flare lookups.
 * opts: {selectedId, detail(x) -> bool (labels), flareIds: Set of shown flares, alphaOf(id)}
 */
export function drawSeekers(ctx, map, list, t, opts = {}) {
  const mpp = map.metersPerPixel();
  ctx.save();
  ctx.font = `${Math.round(11 * (opts.labelScale || 1))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  for (const x of list) {
    const a = opts.alphaOf ? opts.alphaOf(x.s.weaponId) : 1;
    if (a <= 0) continue;
    ctx.globalAlpha = a;
    const m = sampleTrack(x.weapon.pb, t);
    if (!m || !isNum(m.lon)) continue;
    const hdg = velocityHeading(x.weapon.pb, t);
    const [mx, my] = map.project(m.lon, m.lat);
    const onFlare = isNum(x.decoyT) && t >= x.decoyT && x.flare;
    const tp = x.target ? sampleTrack(x.target.pb, Math.min(t, x.target.pb.end ?? t)) : null;
    const fp = onFlare ? sampleTrack(x.flare.pb, t) : null;
    const aim = fp || tp;
    const detail = opts.detail ? opts.detail(x) : true;
    // Gimbal wedge (DCS Fi_excort) along the missile's flight path.
    const gim = x.sk.gimbal;
    if (isNum(hdg) && isNum(gim)) {
      const rngM = aim ? Math.min(distance(m.lon, m.lat, aim.lon, aim.lat) * 1.15, 3000) : 3000;
      const r = Math.max(24, Math.min(rngM / mpp, 260));
      const c = map.screenAngle(hdg), w = Math.min(gim, 89) * RAD;
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.arc(mx, my, r, c - w, c + w);
      ctx.closePath();
      ctx.fillStyle = "rgba(255,179,71,0.06)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,179,71,0.32)";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // Look line to the target.
    if (tp && isNum(tp.lon)) {
      const [tx, ty] = map.project(tp.lon, tp.lat);
      ctx.lineWidth = 1.2;
      if (onFlare) { ctx.strokeStyle = "rgba(160,170,184,0.55)"; ctx.setLineDash([4, 4]); }
      else { ctx.strokeStyle = "rgba(255,179,71,0.9)"; ctx.setLineDash([]); }
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.setLineDash([]);
      if (detail && !onFlare && isNum(hdg)) {
        const look = angle3(dirVec(hdg, m, x.weapon.pb, t), enu(m, tp));
        if (isNum(look)) {
          const over = isNum(gim) && look > gim;
          text(ctx, `look ${Math.round(look)}°${isNum(gim) ? `/${Math.round(gim)}°` : ""}`, (mx + tx) / 2 + 6, (my + ty) / 2 - 8,
            over ? "#ff8a8a" : AMBER);
        }
      }
      // Flares within 1 deg of the missile-to-target line.
      if (!onFlare && opts.flares) {
        const los = enu(m, tp);
        for (const f of opts.flares) {
          const q = sampleTrack(f.pb, t);
          if (!q) continue;
          const d = enu(m, q);
          if (Math.hypot(...d) > Math.hypot(...los) * 1.2) continue;
          const ang = angle3(los, d);
          if (isNum(ang) && ang <= 1) {
            const [qx, qy] = map.project(q.lon, q.lat);
            ctx.strokeStyle = AMBER; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.arc(qx, qy, 5, 0, TAU); ctx.stroke();
          }
        }
      }
    }
    // After the estimated decoy moment: the line goes to the flare.
    if (fp && isNum(fp.lon)) {
      const [fx, fy] = map.project(fp.lon, fp.lat);
      ctx.strokeStyle = "rgba(255,179,71,0.95)";
      ctx.lineWidth = 1.4;
      ctx.setLineDash([5, 3]);
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(fx, fy); ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(fx, fy - 6); ctx.lineTo(fx + 6, fy); ctx.lineTo(fx, fy + 6); ctx.lineTo(fx - 6, fy); ctx.closePath();
      ctx.stroke();
      if (detail || t - x.decoyT < 3) text(ctx, `flare? +${(x.decoyT - x.t0).toFixed(1)} s (est.)`, fx + 9, fy - 9, AMBER);
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

/** Unit vector of a missile's flight path (heading from the track, pitch from the climb). */
function dirVec(hdg, m, pb, t) {
  const a = sampleTrack(pb, Math.max(pb.t[0], t - 0.3));
  let pitch = 0;
  if (a && isNum(a.alt) && isNum(m.alt)) {
    const d = distance(a.lon, a.lat, m.lon, m.lat);
    if (d > 1) pitch = Math.atan2(m.alt - a.alt, d);
  }
  const h = hdg * RAD;
  return [Math.sin(h) * Math.cos(pitch), Math.cos(h) * Math.cos(pitch), Math.sin(pitch)];
}

// ---------------------------------------------------------------------------

/**
 * Estimated seeker reach around a jet, in map metres: r = SSD * sqrt(K), K
 * the heat DCS gives the jet from each direction.  SSD (DCS
 * SeekerSensivityDistance) is "the range of a target of IR value 1"; how DCS
 * scales it with heat is not published, hence the square root (inverse
 * square law) and the dashed "est." styling.  This is not launch range.
 * items: [{target: scene row, sk: seeker, hn: heatNow(), label}]
 */
export function drawReach(ctx, map, items, { labelScale = 1 } = {}) {
  ctx.save();
  ctx.font = `${Math.round(11 * labelScale)}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "middle";
  for (const it of items) {
    const o = it.target, ssd = it.sk?.ssd;
    if (!o || !isNum(ssd) || !isNum(o.hdg) || !it.hn) continue;
    const draw = (c, dash, alpha) => {
      ctx.beginPath();
      for (let k = 0; k <= 72; k++) {
        const phi = (k / 72) * 360; // from the tail
        const r = ssd * Math.sqrt(c * aspectFactor(phi));
        const [lon, lat] = destination(o.lon, o.lat, (o.hdg + 180 + phi) % 360, r);
        const [px, py] = map.project(lon, lat);
        k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
      }
      ctx.closePath();
      ctx.setLineDash(dash);
      ctx.strokeStyle = `rgba(255,179,71,${alpha})`;
      ctx.lineWidth = 1.3;
      ctx.stroke();
    };
    draw(it.hn.c, [6, 5], 0.6);
    ctx.fillStyle = "rgba(255,179,71,0.03)";
    ctx.fill();
    if (it.hn.cAB) draw(it.hn.cAB, [2, 4], 0.4);
    ctx.setLineDash([]);
    // Labels at the tail and nose tips.
    const tailR = ssd * Math.sqrt(it.hn.c * aspectFactor(0)), noseR = ssd * Math.sqrt(it.hn.c * aspectFactor(180));
    const [tl, tla] = destination(o.lon, o.lat, (o.hdg + 180) % 360, tailR);
    const [nl, nla] = destination(o.lon, o.lat, o.hdg, noseR);
    const [tx, ty] = map.project(tl, tla), [nx, ny] = map.project(nl, nla);
    const name = it.sk.display || it.sk.key || "IR missile";
    text(ctx, `~${fmtDist(tailR)} tail · ${name} seeker reach (est.)`, tx + 6, ty, AMBER);
    text(ctx, `~${fmtDist(noseR)} nose`, nx + 6, ny, AMBER);
    if (it.label) text(ctx, it.label, tx + 6, ty + 13, "rgba(220,225,232,0.75)");
  }
  ctx.restore();
}

/** Side colour of a flare's owner (grey when unknown). */
export function flareColor(owner) {
  return owner ? sideColor(owner) : HEAT_UNKNOWN;
}
