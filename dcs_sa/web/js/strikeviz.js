// Air-to-ground overlay for the 2D map: release marks, whole weapon paths
// with time-of-fall ticks, the JSOW / CBU opening point and every recorded
// bomblet impact, the footprint ellipse, impact marks with the miss split
// into range and deflection, weapon-to-target lines with time to impact,
// the JSOW launch zone from DCS's own table, and BDA badges.
//
// Nothing is drawn before it happens (no spoilers).  The "future" layer
// only adds the rest of the path of a weapon already in flight.

import { M_TO_FT, fmtClock, fmtDist, fmtShort, isNum, sideColor, units } from "./util.js";
import { posAt, strikeGeometry, tofTicks, weaponLabel, weaponPath } from "./strikegeom.js";

const TAU = Math.PI * 2;
export const RESULT_COLOR = { destroyed: "#ff5c5c", damaged: "#ff9f43", miss: "#9aa4b1", intercepted: "#b48cff", unknown: "#9aa4b1" };
const FLYING = "#4dd8e6";
const BOMBLET = "rgba(255,196,120,0.85)";

/** Altitude in thousands: "25.0k" (ft) or "7.6 km". */
export function kAlt(m) {
  if (!isNum(m)) return "—";
  return units.metric ? `${(m / 1000).toFixed(1)} km` : `${((m * M_TO_FT) / 1000).toFixed(1)}k`;
}

/** "30 ft LONG · 12 ft R" from missComponents(). */
export function missText(miss) {
  if (!miss) return "";
  const r = miss.range, d = miss.deflection;
  const parts = [];
  if (Math.abs(r) >= 0.5) parts.push(`${fmtShort(Math.abs(r))} ${r > 0 ? "LONG" : "SHORT"}`);
  if (Math.abs(d) >= 0.5) parts.push(`${fmtShort(Math.abs(d))} ${d > 0 ? "R" : "L"}`);
  return parts.join(" · ");
}

/**
 * Pre-compute what does not change with time: paths, ticks, bomblet
 * landings (from each bomblet's own track) and the miss geometry.
 * submunitions: analysis.weapons.submunitions {dispenserId: [bombletIds]}.
 */
export function prepareStrikes(strikes, objects, submunitions = {}) {
  return (strikes || []).map((s) => {
    const bomblets = [];
    for (const id of submunitions[s.weaponId] || []) {
      const o = objects.get(id);
      const pb = o?.pb;
      if (!pb || !pb.t.length) continue;
      const end = pb.end ?? pb.t[pb.t.length - 1];
      const p = posAt(o, end);
      if (p && isNum(p.lon)) bomblets.push({ t: end, lon: p.lon, lat: p.lat });
    }
    bomblets.sort((a, b) => a.t - b.t);
    const launcher = objects.get(s.launcherId);
    return {
      s, path: weaponPath(s, objects), ticks: tofTicks(s, objects), bomblets,
      // DCS records a dispenser's whole load as one object: the cloud's centre.
      cloud: s.footprint?.estimated ? (submunitions[s.weaponId] || []).map((id) => objects.get(id)).filter(Boolean) : [],
      geom: strikeGeometry(s, objects), color: launcher ? sideColor(launcher) : "#e8ecf2",
      // Bomblets start landing well before the pattern's last one (= impactTime).
      firstLanding: bomblets.length ? bomblets[0].t : s.impactTime,
    };
  });
}

function halo(ctx, text, x, y, color, align = "left") {
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(6,9,13,0.9)";
  ctx.strokeText(text, x, y);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function circledX(ctx, x, y, r, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.stroke();
  const k = r * 0.62;
  ctx.beginPath(); ctx.moveTo(x - k, y - k); ctx.lineTo(x + k, y + k); ctx.moveTo(x + k, y - k); ctx.lineTo(x - k, y + k); ctx.stroke();
}

/** Screen position of a path at time t (interpolated), and the index reached. */
function pathAt(path, t) {
  let i = 0;
  while (i + 1 < path.length && path[i + 1].t <= t) i++;
  const a = path[i], b = path[i + 1];
  if (!b || t <= a.t) return { i, lon: a.lon, lat: a.lat };
  const f = (t - a.t) / (b.t - a.t || 1);
  return { i, lon: a.lon + (b.lon - a.lon) * f, lat: a.lat + (b.lat - a.lat) * f };
}

/**
 * Draw every strike at time t.  opts:
 *   layers: {release, paths, future, impacts, footprints, tti, bda, lar}
 *   selectedId: the selected object (a weapon, its launcher or its target highlights the strike)
 *   objects: Map id -> object (for the target's live position)
 *   alphaOf(id) -> 0..1 (isolate dimming), target: user target {lon, lat, name}
 *   labels: "full" (every tag) | "auto" (tags for the selected strike, or when zoomed in)
 * Returns hitboxes [{id, x, y, r, strike}].
 */
export function drawStrikes(ctx, map, prepared, t, opts = {}) {
  const L = { release: true, paths: true, future: false, impacts: true, footprints: true, tti: true, bda: true, lar: false, ...(opts.layers || {}) };
  const hits = [];
  if (!prepared?.length) return hits;
  const mpp = map.metersPerPixel();
  const P = (lon, lat) => map.project(lon, lat);
  const on = (x, y, pad = 60) => x > -pad && y > -pad && x < map.w + pad && y < map.h + pad;
  ctx.save();
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "middle";
  // Simple label collision: a tag is skipped when its box overlaps one already drawn.
  const boxes = [];
  const tag = (text, x, y, color, align = "left") => {
    const w = ctx.measureText(text).width;
    const x0 = align === "center" ? x - w / 2 : align === "right" ? x - w : x;
    if (boxes.some((b) => x0 < b[2] && x0 + w > b[0] && y - 7 < b[3] && y + 7 > b[1])) return false;
    boxes.push([x0 - 2, y - 7, x0 + w + 2, y + 7]);
    halo(ctx, text, x, y, color, align);
    return true;
  };

  for (const p of prepared) {
    const s = p.s;
    // The selected weapon (or its target) gets every detail; its launcher being selected does not.
    const sel = !!opts.selectedId && (opts.selectedId === s.weaponId || opts.selectedId === s.targetId);
    const started = t >= s.releaseTime, ended = t >= s.impactTime;
    if (!started) continue;
    const alpha = opts.alphaOf ? opts.alphaOf(s.weaponId) : 1;
    if (alpha <= 0) continue;
    // Primary tags (release, time to impact): always in "full", else when selected or zoomed in.
    // Detail tags (miss split, opening height, ticks): selected, or zoomed in.
    const tags = opts.labels === "full" || sel || mpp < 12;
    const detail = sel || mpp < (opts.labels === "full" ? 15 : 6);
    ctx.globalAlpha = alpha;
    const geom = sel && opts.target ? strikeGeometry(s, opts.objects, { target: opts.target }) : p.geom;

    // -- launch zone (JSOW): DCS's max / min range around the target ------------
    const env = s.envelope;
    if (L.lar && env && isNum(env.rmax) && geom && (opts.selectedId === s.weaponId || t - s.releaseTime <= 20)) {
      const c = geom.target?.atRelease || geom.impact;
      const [cx, cy] = P(c.lon, c.lat);
      ctx.save();
      ctx.strokeStyle = "rgba(255,209,102,0.7)";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([8, 6]);
      ctx.beginPath(); ctx.arc(cx, cy, env.rmax / mpp, 0, TAU); ctx.stroke();
      if (isNum(env.rmin)) {
        ctx.setLineDash([2, 4]);
        ctx.beginPath(); ctx.arc(cx, cy, env.rmin / mpp, 0, TAU); ctx.stroke();
      }
      ctx.setLineDash([]);
      const [rx, ry] = P(geom.release.lon, geom.release.lat);
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(cx, cy); ctx.stroke();
      tag(`${weaponLabel(s.weaponName)} Rmax ${fmtDist(env.rmax)} · DCS table for ${kAlt(geom.hat)} / ${units.metric ? `${Math.round(s.release.tas * 3.6)} km/h` : `${Math.round(s.release.tas * 1.943844)} kt`}`,
        cx, cy - env.rmax / mpp - 10, "rgba(255,209,102,0.95)", "center");
      if (isNum(env.rangeFraction)) {
        tag(`released at ${Math.round(env.rangeFraction * 100)}% of Rmax`, (rx + cx) / 2, (ry + cy) / 2 - 10,
          env.inRange ? "rgba(255,209,102,0.95)" : "#ff5c5c", "center");
      }
      ctx.restore();
    }

    // -- weapon path + time-of-fall ticks ---------------------------------------
    const path = p.path;
    let head = null;
    if (L.paths && path.length > 1) {
      const flying = started && !ended;
      const reach = ended ? path.length - 1 : pathAt(path, t).i;
      // A dispenser's own track ends when it opens: from then on the bomblets are the story.
      if (flying && !(geom?.dispense && t >= geom.dispense.time)) head = pathAt(path, t);
      ctx.lineWidth = sel ? 2 : 1.4;
      // Flown part: solid; after impact it fades so the picture builds up.
      {
        ctx.strokeStyle = ended ? `rgba(232,236,242,${sel ? 0.8 : 0.35})` : "rgba(232,236,242,0.85)";
        ctx.beginPath();
        let [x, y] = P(path[0].lon, path[0].lat);
        ctx.moveTo(x, y);
        for (let k = 1; k <= reach; k++) { [x, y] = P(path[k].lon, path[k].lat); ctx.lineTo(x, y); }
        if (head) { [x, y] = P(head.lon, head.lat); ctx.lineTo(x, y); }
        ctx.stroke();
      }
      // Still to fly: dotted, only with the "future" layer.
      if (L.future && !ended) {
        ctx.save();
        ctx.setLineDash([2, 5]);
        ctx.strokeStyle = "rgba(232,236,242,0.45)";
        ctx.beginPath();
        const from = head || path[0];
        let [x, y] = P(from.lon, from.lat);
        ctx.moveTo(x, y);
        for (let k = Math.max(0, reach + 1); k < path.length; k++) { [x, y] = P(path[k].lon, path[k].lat); ctx.lineTo(x, y); }
        ctx.stroke();
        ctx.restore();
      }
      // Ticks every 5 s (10 s for long glides); labels every 30 s, or every tick when selected.
      let lastLabel = null;
      for (let k = 0; k < p.ticks.length; k++) {
        const tk = p.ticks[k];
        if (tk.t > t && !L.future) break;
        if (mpp > 150) break; // ticks would merge into the line
        const [x, y] = P(tk.lon, tk.lat);
        if (!on(x, y)) continue;
        const nxt = p.ticks[k + 1] || p.ticks[k - 1];
        let ang = 0;
        if (nxt) { const [nx, ny] = P(nxt.lon, nxt.lat); ang = Math.atan2(ny - y, nx - x) + Math.PI / 2; }
        ctx.strokeStyle = tk.t > t ? "rgba(232,236,242,0.4)" : "rgba(232,236,242,0.9)";
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(x - Math.cos(ang) * 4, y - Math.sin(ang) * 4); ctx.lineTo(x + Math.cos(ang) * 4, y + Math.sin(ang) * 4);
        ctx.stroke();
        if (detail && (sel || tk.sec % 30 === 0) && (!lastLabel || Math.hypot(lastLabel[0] - x, lastLabel[1] - y) > 44)) {
          if (tag(`+${tk.sec}s`, x + Math.cos(ang) * 7, y + Math.sin(ang) * 7, "rgba(220,225,232,0.8)")) lastLabel = [x, y];
        }
      }
    }

    // -- release mark -----------------------------------------------------------
    if (L.release && geom) {
      const [x, y] = P(geom.release.lon, geom.release.lat);
      if (on(x, y)) {
        ctx.fillStyle = p.color;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x - 6, y - 5); ctx.lineTo(x + 6, y - 5); ctx.lineTo(x, y + 5); ctx.closePath();
        ctx.fill(); ctx.stroke();
        hits.push({ id: s.weaponId, x, y, r: 9, strike: s, kind: "release" });
        if (tags) {
          const r = s.release;
          const bits = [`REL ${kAlt(r.altitude)}`, isNum(r.mach) ? `M${r.mach.toFixed(2)}` : "",
            isNum(r.dive) && Math.abs(r.dive) >= 1 ? `${Math.round(r.dive)}°` : "", isNum(r.g) ? `${r.g.toFixed(1)} g` : ""];
          if (isNum(r.bank) && Math.abs(r.bank) > 5) bits.push(`bank ${Math.round(Math.abs(r.bank))}°`);
          tag(`${weaponLabel(s.weaponName)} · ${bits.filter(Boolean).join(" · ")}`, x + 10, y - 10, p.color);
        }
      }
    }

    // -- dispense point and bomblet impacts ---------------------------------------
    const disp = geom?.dispense;
    if (disp && t >= disp.time) {
      const [x, y] = P(disp.lon, disp.lat);
      ctx.strokeStyle = "#ffc478";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * TAU;
        ctx.moveTo(x + Math.cos(a) * 3, y + Math.sin(a) * 3); ctx.lineTo(x + Math.cos(a) * 7, y + Math.sin(a) * 7);
      }
      ctx.stroke();
      if (detail && isNum(geom.hof)) tag(`opened ${fmtShort(geom.hof)} above target`, x + 10, y + 10, "#ffc478");
    }
    // The falling cloud (DCS's single object for all the bomblets): a disc
    // that spreads from the opening point to the typical pattern size.
    if (L.footprints && p.cloud.length && disp && t >= disp.time && t < s.impactTime) {
      const f = Math.max(0, Math.min(1, (t - disp.time) / Math.max(1, s.impactTime - disp.time)));
      for (const c of p.cloud) {
        const q = posAt(c, t);
        if (!q) continue;
        const [x, y] = P(q.lon, q.lat);
        const r = Math.max(4, ((10 + f * ((s.footprint.minor || 50) - 10)) / mpp));
        ctx.save();
        ctx.fillStyle = "rgba(255,196,120,0.18)";
        ctx.strokeStyle = "rgba(255,196,120,0.7)";
        ctx.setLineDash([2, 3]);
        ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); ctx.stroke();
        ctx.restore();
        if (tags) tag(`${s.submunitions}× ${s.submunitionName || "bomblets"} falling`, x + r + 6, y, "#ffc478");
      }
    }
    if (L.footprints && p.bomblets.length && t >= p.firstLanding && !p.cloud.length) {
      ctx.fillStyle = BOMBLET;
      for (const b of p.bomblets) {
        if (b.t > t) break;
        const [x, y] = P(b.lon, b.lat);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    const fp = s.footprint;
    if (L.footprints && fp && isNum(fp.major) && t >= s.impactTime) {
      const [x, y] = P(fp.lon, fp.lat);
      const col = RESULT_COLOR[s.result] || RESULT_COLOR.unknown;
      ctx.save();
      // Measured patterns: short dashes; a typical (estimated) pattern: long faint dashes.
      ctx.setLineDash(fp.estimated ? [9, 6] : [5, 4]);
      ctx.strokeStyle = fp.estimated ? `${col}aa` : col;
      ctx.fillStyle = `${col}${fp.estimated ? "10" : "1a"}`;
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      // The major axis lies along fp.bearing; screenAngle gives that direction on the canvas.
      ctx.ellipse(x, y, Math.max(2, fp.major / mpp), Math.max(1.5, fp.minor / mpp), map.screenAngle(fp.bearing), 0, TAU);
      ctx.fill(); ctx.stroke();
      ctx.restore();
      if (detail) {
        tag(`${s.submunitions}× ${s.submunitionName || subName(s).trim()} · ${fp.estimated ? "typical pattern " : ""}${fmtShort(2 * fp.major)} × ${fmtShort(2 * fp.minor)}${fp.estimated ? " (est.)" : ""}`,
          x, y + Math.max(fp.major, fp.minor) / mpp + 12, col, "center");
      }
    }

    // -- in flight: line to the target and time to impact -------------------------
    if (L.tti && head) {
      const [hx, hy] = P(head.lon, head.lat);
      const tgtObj = s.targetId && opts.objects?.get(s.targetId);
      const tp = (tgtObj && posAt(tgtObj, t)) || (geom ? geom.impact : null);
      if (tp) {
        const [tx, ty] = P(tp.lon, tp.lat);
        ctx.save();
        ctx.setLineDash([3, 5]);
        ctx.strokeStyle = "rgba(77,216,230,0.75)";
        ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(tx, ty); ctx.stroke();
        ctx.restore();
      }
      const opens = disp && t < disp.time;
      const left = (opens ? disp.time : s.impactTime) - t;
      const txt = `${weaponLabel(s.weaponName)}${s.targetName ? ` → ${s.targetName}` : ""} · ${opens ? "opens " : ""}${fmtClock(left)}`;
      if (on(hx, hy) && (tags || sel)) tag(txt, hx + 10, hy + 12, FLYING);
    }

    // -- impact, miss and BDA --------------------------------------------------------
    if (L.impacts && ended && geom) {
      const col = RESULT_COLOR[s.result] || RESULT_COLOR.unknown;
      const [ix, iy] = P(geom.impact.lon, geom.impact.lat);
      const tg = geom.target;
      if (tg) {
        const [tx, ty] = P(tg.lon, tg.lat);
        // Target motion during the time of fall (coordinate weapons miss movers).
        if (tg.atRelease && tg.moved > 30) {
          const [ax, ay] = P(tg.atRelease.lon, tg.atRelease.lat);
          ctx.save();
          ctx.setLineDash([2, 3]);
          ctx.strokeStyle = "rgba(255,209,102,0.8)";
          ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(tx, ty); ctx.stroke();
          ctx.restore();
          if (detail) tag(`target moved ${fmtShort(tg.moved)}`, (ax + tx) / 2 + 6, (ay + ty) / 2, "rgba(255,209,102,0.95)");
        }
        // Scoring rings round the target when zoomed right in.
        if (sel && mpp < 1.5) {
          ctx.save();
          ctx.strokeStyle = "rgba(255,255,255,0.28)";
          ctx.lineWidth = 1;
          for (const r of [10, 25, 50]) { ctx.beginPath(); ctx.arc(tx, ty, r / mpp, 0, TAU); ctx.stroke(); }
          ctx.restore();
        }
        if (geom.miss && geom.miss.distance > 3) {
          ctx.save();
          ctx.setLineDash([4, 3]);
          ctx.strokeStyle = `${col}cc`;
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(ix, iy); ctx.lineTo(tx, ty); ctx.stroke();
          ctx.restore();
          if (detail) {
            const mx = (ix + tx) / 2, my = (iy + ty) / 2;
            const pre = tg.user ? "your target: " : s.targetSource === "nearest" ? "nearest: " : "";
            tag(`${pre}${fmtShort(geom.miss.distance)} · ${geom.miss.clock} o'clock · ${missText(geom.miss)}`, mx + 8, my - 8, col);
          }
        }
        // Target cross, also after the unit is gone.
        ctx.strokeStyle = "rgba(255,255,255,0.8)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(tx - 5, ty); ctx.lineTo(tx + 5, ty); ctx.moveTo(tx, ty - 5); ctx.lineTo(tx, ty + 5); ctx.stroke();
      }
      circledX(ctx, ix, iy, sel ? 7 : 5.5, col);
      hits.push({ id: s.weaponId, x: ix, y: iy, r: 9, strike: s, kind: "impact" });
      if (L.bda) {
        const killed = new Set((s.damage || []).filter((d) => d.time <= t).map((d) => d.id));
        const txt = killed.size ? `${killed.size} K` : s.result === "miss" && (detail || t - s.impactTime < 30) ? "MISS" : "";
        if (txt) {
          ctx.font = "bold 10px ui-monospace, monospace";
          const w = ctx.measureText(txt).width + 8;
          const bx = ix + 9, by = iy - 17;
          ctx.fillStyle = killed.size ? "rgba(184,50,50,0.92)" : "rgba(60,68,78,0.9)";
          ctx.fillRect(bx, by, w, 14);
          ctx.fillStyle = "#fff";
          ctx.textAlign = "left";
          ctx.fillText(txt, bx + 4, by + 7);
          ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
        }
      }
    }
  }
  ctx.restore();
  return hits;
}

/** Bomblet type for the footprint label. */
function subName(s) {
  const n = String(s.weaponName || "");
  if (/AGM_154A|CBU_87|CBU_103/.test(n)) return " BLU-97";
  if (/CBU_97|CBU_105/.test(n)) return " BLU-108";
  return " bomblets";
}

/** Weapons of `launcherId` in flight at t, soonest impact first: [{s, left, opens}]. */
export function weaponsInFlight(prepared, t, launcherId = null) {
  const out = [];
  for (const p of prepared || []) {
    const s = p.s;
    if (t < s.releaseTime || t >= s.impactTime) continue;
    if (launcherId && s.launcherId !== launcherId) continue;
    const opens = p.geom?.dispense && t < p.geom.dispense.time;
    out.push({ s, left: s.impactTime - t, opens: opens ? p.geom.dispense.time - t : null, frac: (t - s.releaseTime) / Math.max(1, s.impactTime - s.releaseTime) });
  }
  return out.sort((a, b) => a.left - b.left);
}

/** Impact point of a prepared strike (the 3D weapon cam holds on it). */
export function impactPoint(p) { return p?.geom ? { lon: p.geom.impact.lon, lat: p.geom.impact.lat, alt: p.geom.impact.alt } : null; }
