// Air-to-ground geometry shared by the map overlay, the strike card and 3D:
// miss split into range / deflection along the run-in, clock code, target
// motion during the time of fall, off-axis launch, weapon turn, arrival Mach.

import { bearing, bisectRight, distance, isNum, sampleTrack, speedOfSound, wrap180 } from "./util.js";

/** Position of an object at t, held at its first / last sample outside its track. */
export function posAt(obj, t) {
  const pb = obj?.pb;
  if (!pb || !pb.t.length) return null;
  const n = pb.t.length;
  const tt = Math.max(pb.t[0], Math.min(pb.end ?? pb.t[n - 1], pb.t[n - 1], t));
  return sampleTrack(pb, tt);
}

/** Family label for display ("JSOW", "LGB" ...). */
export const FAMILY_LABEL = {
  jsow: "JSOW", jdam: "JDAM", lgb: "LGB", cluster: "Cluster", maverick: "Maverick", harm: "HARM",
  rocket: "Rocket", agm: "AGM", "gp-bomb": "Bomb",
};

/** Seconds between time-of-fall ticks for a weapon. */
export function tofTick(strike) {
  const tof = strike?.timeOfFall;
  return isNum(tof) && tof >= 60 ? 10 : 5;
}

/** Split the vector impact -> target into range (+ = long) and deflection (+ = right) along `runIn` (deg). */
export function missComponents(impact, target, runIn) {
  if (!impact || !target || !isNum(runIn)) return null;
  const d = distance(target.lon, target.lat, impact.lon, impact.lat);
  const brg = bearing(target.lon, target.lat, impact.lon, impact.lat);
  const rel = (wrap180(brg - runIn) * Math.PI) / 180;
  const range = d * Math.cos(rel);
  const deflection = d * Math.sin(rel);
  // Clock code: 12 o'clock = along the run-in, beyond the target (long).
  let clock = Math.round((((brg - runIn) % 360) + 360) % 360 / 30) % 12;
  if (clock === 0) clock = 12;
  let clockN = Math.round((((brg % 360) + 360) % 360) / 30) % 12;
  if (clockN === 0) clockN = 12;
  return { distance: d, range, deflection, clock, clockNorth: clockN, bearing: brg };
}

/** Ground track over the last part of a track: from the last sample >= 2 s and > 20 m back. */
function finalTrack(pb) {
  if (!pb || pb.t.length < 2) return null;
  const n = pb.t.length - 1;
  for (let i = n - 1; i >= 0; i--) {
    if (!isNum(pb.lon[i]) || pb.t[n] - pb.t[i] < 2) continue;
    if (distance(pb.lon[i], pb.lat[i], pb.lon[n], pb.lat[n]) > 20) return bearing(pb.lon[i], pb.lat[i], pb.lon[n], pb.lat[n]);
  }
  return null;
}

/** Ground track (deg) of a playback track over [t0, t1], or null. */
function trackOver(pb, t0, t1) {
  const a = sampleTrack(pb, t0), b = sampleTrack(pb, t1);
  if (!a || !b || distance(a.lon, a.lat, b.lon, b.lat) < 5) return null;
  return bearing(a.lon, a.lat, b.lon, b.lat);
}

/**
 * Everything the overlays and the card need about one strike.
 * objects: Map id -> {...analysis object, pb}.  target: optional user target
 * {lon, lat, alt, name} that replaces the inferred one ("user target").
 */
export function strikeGeometry(strike, objects, { target = null } = {}) {
  if (!strike?.release || !strike.impact) return null;
  const rel = strike.release;
  const weapon = objects?.get(strike.weaponId);
  const out = {
    release: { lon: rel.longitude, lat: rel.latitude, alt: rel.altitude, heading: rel.heading },
    impact: { lon: strike.impact.longitude, lat: strike.impact.latitude, alt: strike.impact.altitude },
    // The attack axis the miss is split along: the weapon's own ground track at
    // the end (a JSOW launched off-axis turns onto its target; a bomb crabs
    // with the wind), else the jet's heading at release.
    runIn: finalTrack(weapon?.pb) ?? rel.heading,
    hat: isNum(rel.altitude) && isNum(strike.impact.altitude) ? rel.altitude - strike.impact.altitude : null,
  };
  // Target at release and at impact.
  let tgt = null;
  if (target && isNum(target.lon)) {
    tgt = { id: target.id || null, name: target.name || "target", lon: target.lon, lat: target.lat, alt: target.alt, user: true };
    tgt.atRelease = { lon: target.lon, lat: target.lat };
    tgt.moved = 0;
  } else if (strike.targetId && objects?.has(strike.targetId)) {
    const o = objects.get(strike.targetId);
    const pi = posAt(o, strike.impactTime), pr = posAt(o, strike.releaseTime);
    if (pi) {
      tgt = { id: o.id, name: o.name, lon: pi.lon, lat: pi.lat, alt: pi.alt, user: false };
      if (pr) {
        tgt.atRelease = { lon: pr.lon, lat: pr.lat };
        tgt.moved = distance(pr.lon, pr.lat, pi.lon, pi.lat);
      }
    }
  }
  out.target = tgt;
  if (tgt) {
    out.miss = missComponents(out.impact, tgt, out.runIn);
    const from = tgt.atRelease || tgt;
    out.offAxis = wrap180(bearing(out.release.lon, out.release.lat, from.lon, from.lat) - rel.heading);
    out.targetRange = distance(out.release.lon, out.release.lat, from.lon, from.lat);
  }
  if (strike.dispense && isNum(strike.dispense.altitude)) {
    out.dispense = { lon: strike.dispense.longitude, lat: strike.dispense.latitude, alt: strike.dispense.altitude, time: strike.dispense.time };
    out.hof = strike.dispense.altitude - strike.impact.altitude;
  }
  const pb = weapon?.pb;
  if (pb && pb.t.length > 2) {
    const n = pb.t.length;
    const t0 = pb.t[0], t1 = pb.end ?? pb.t[n - 1];
    const first = trackOver(pb, t0, Math.min(t1, t0 + 2));
    const last = trackOver(pb, Math.max(t0, t1 - 4), t1);
    if (isNum(first) && isNum(last)) out.headingChange = wrap180(last - first);
    // Arrival speed: the last few recorded samples (the end is extrapolated).
    const k = Math.max(1, n - 1);
    const j = Math.max(0, bisectRight(pb.t, pb.t[k] - 1.0));
    if (k > j && pb.t[k] > pb.t[j] && isNum(pb.lon[j]) && isNum(pb.lon[k])) {
      const dt = pb.t[k] - pb.t[j];
      const dh = distance(pb.lon[j], pb.lat[j], pb.lon[k], pb.lat[k]);
      const dz = isNum(pb.alt?.[k]) && isNum(pb.alt?.[j]) ? pb.alt[k] - pb.alt[j] : 0;
      const v = Math.hypot(dh, dz) / dt;
      out.arrivalSpeed = v;
      out.arrivalMach = v / speedOfSound(pb.alt?.[k]);
      out.arrivalDive = dh > 1 ? (Math.atan2(dz, dh) * 180) / Math.PI : null;
    }
  }
  return out;
}

/** Points of the weapon's path [{t, lon, lat, alt}] from release to its end. */
export function weaponPath(strike, objects) {
  const pb = objects?.get(strike.weaponId)?.pb;
  if (!pb) return [];
  const out = [];
  for (let i = 0; i < pb.t.length; i++) {
    if (isNum(pb.lon[i])) out.push({ t: pb.t[i], lon: pb.lon[i], lat: pb.lat[i], alt: pb.alt?.[i] });
  }
  const end = pb.end;
  if (isNum(end) && out.length && end > out[out.length - 1].t) {
    const p = sampleTrack(pb, end);
    if (p) out.push({ t: end, lon: p.lon, lat: p.lat, alt: p.alt });
  }
  return out;
}

/** Time-of-fall tick positions along a path: [{t, sec, lon, lat, alt}]. */
export function tofTicks(strike, objects) {
  const pb = objects?.get(strike.weaponId)?.pb;
  if (!pb || !isNum(strike.releaseTime)) return [];
  const step = tofTick(strike);
  const end = Math.min(strike.impactTime ?? Infinity, pb.end ?? pb.t[pb.t.length - 1]);
  const out = [];
  for (let s = step; strike.releaseTime + s < end - 0.5; s += step) {
    const p = sampleTrack(pb, strike.releaseTime + s);
    if (p && isNum(p.lon)) out.push({ t: strike.releaseTime + s, sec: s, lon: p.lon, lat: p.lat, alt: p.alt });
  }
  return out;
}

/** Group releases into passes: same launcher, releases <= gap seconds apart. */
export function groupPasses(strikes, gap = 5) {
  const sorted = [...strikes].sort((a, b) => a.releaseTime - b.releaseTime);
  const passes = [];
  for (const s of sorted) {
    const p = passes.find((x) => x.launcherId === s.launcherId && s.releaseTime - x.last <= gap);
    if (p) { p.strikes.push(s); p.last = s.releaseTime; } else passes.push({ launcherId: s.launcherId, strikes: [s], first: s.releaseTime, last: s.releaseTime });
  }
  return passes;
}

// DCS type names that do not say which variant they are.
const WEAPON_ALIASES = {
  AGM_154: "AGM-154C", AGM_154A: "AGM-154A", AGM_154B: "AGM-154B",
  // DCS type names of air-to-air missiles (its Lua "display_name").
  AIM_9: "AIM-9M", AIM_9X: "AIM-9X", "GAR-8": "AIM-9B", AIM_120: "AIM-120B", AIM_120C: "AIM-120C", AIM_7: "AIM-7M",
  P_73: "R-73", P_60: "R-60M", P_27T: "R-27T", P_27TE: "R-27ET", P_27P: "R-27R", P_27PE: "R-27ER", P_77: "R-77",
  P_24T: "R-24T", P_24R: "R-24R", P_40T: "R-40TD", P_40R: "R-40RD", P_33E: "R-33", R_550: "R.550 Magic II", MMagicII: "R.550 Magic II",
  R_550_M1: "R.550 Magic I",
};

/** Display name for a DCS weapon type: "AGM_154" -> "AGM-154C", "P_73" -> "R-73", "GBU_12" -> "GBU-12". */
export const weaponLabel = (name) => WEAPON_ALIASES[name] || String(name || "").replace(/_/g, "-");
