// Shared helpers: units, formatting, colours, small DOM utilities.

export const M_TO_FT = 3.280839895;
export const MPS_TO_KT = 1.943844492;
export const M_TO_NM = 1 / 1852;
export const MPS_TO_FPM = 196.8503937;

const UNIT_KEY = "dcs-sa.units";

export const units = {
  system: (() => { try { return localStorage.getItem(UNIT_KEY) || "imperial"; } catch { return "imperial"; } })(),
  set(system) {
    this.system = system;
    try { localStorage.setItem(UNIT_KEY, system); } catch { /* private mode */ }
  },
  get metric() { return this.system === "metric"; },
};

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function fmtAlt(m, { suffix = true } = {}) {
  if (!isNum(m)) return "—";
  return units.metric
    ? `${Math.round(m).toLocaleString()}${suffix ? " m" : ""}`
    : `${Math.round(m * M_TO_FT).toLocaleString()}${suffix ? " ft" : ""}`;
}

export function fmtSpeed(mps, { suffix = true } = {}) {
  if (!isNum(mps)) return "—";
  return units.metric
    ? `${Math.round(mps * 3.6)}${suffix ? " km/h" : ""}`
    : `${Math.round(mps * MPS_TO_KT)}${suffix ? " kt" : ""}`;
}

export function fmtDist(m, { suffix = true, precise = false } = {}) {
  if (!isNum(m)) return "—";
  if (units.metric) {
    if (m < 2000) return `${Math.round(m)}${suffix ? " m" : ""}`;
    return `${(m / 1000).toFixed(precise ? 2 : 1)}${suffix ? " km" : ""}`;
  }
  const nm = m * M_TO_NM;
  return `${nm < 10 || precise ? nm.toFixed(1) : Math.round(nm)}${suffix ? " nm" : ""}`;
}

/** Short distances (runway, rollout): feet or metres rather than nm/km. */
export function fmtShort(m) {
  if (!isNum(m)) return "—";
  return units.metric ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m * M_TO_FT).toLocaleString()} ft`;
}

export function fmtVs(mps) {
  if (!isNum(mps)) return "—";
  return units.metric
    ? `${mps >= 0 ? "+" : ""}${mps.toFixed(1)} m/s`
    : `${mps >= 0 ? "+" : ""}${Math.round(mps * MPS_TO_FPM).toLocaleString()} fpm`;
}

export const fmtDeg = (d, digits = 0) => (isNum(d) ? `${d.toFixed(digits)}°` : "—");
export const fmtHdg = (d) => (isNum(d) ? `${String(Math.round(((d % 360) + 360) % 360) || 360).padStart(3, "0")}°` : "—");
export const fmtNum = (v, digits = 1) => (isNum(v) ? v.toFixed(digits) : "—");
export const fmtPct = (v) => (isNum(v) ? `${Math.round(v * 100)}%` : "—");
export const fmtMass = (kg) => (!isNum(kg) ? "—" : units.metric ? `${Math.round(kg).toLocaleString()} kg` : `${Math.round(kg * 2.20462).toLocaleString()} lb`);

export function fmtClock(sec) {
  if (!isNum(sec)) return "--:--";
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const mm = String(m).padStart(2, "0");
  const sss = String(ss).padStart(2, "0");
  return h ? `${h}:${mm}:${sss}` : `${mm}:${sss}`;
}

/** Wall-clock (mission) time from a reference ISO string plus offset seconds. */
export function fmtZulu(refIso, offset) {
  if (!refIso || !isNum(offset)) return "";
  const d = new Date(new Date(refIso).getTime() + offset * 1000);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}:${String(d.getUTCSeconds()).padStart(2, "0")}Z`;
}

// --- geodesy (mirror of analysis/geo.py) ------------------------------------

const R = 6371008.8;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distance(lon1, lat1, lon2, lat2) {
  const p1 = rad(lat1), p2 = rad(lat2);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(rad(lon2 - lon1) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function bearing(lon1, lat1, lon2, lat2) {
  const p1 = rad(lat1), p2 = rad(lat2), dl = rad(lon2 - lon1);
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function destination(lon, lat, brg, dist) {
  const d = dist / R, b = rad(brg), p1 = rad(lat), l1 = rad(lon);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [deg(l2), deg(p2)];
}

export const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Bearing/range/altitude from a reference point, as a BRAA/bullseye string. */
export function braa(fromLon, fromLat, toLon, toLat, toAlt) {
  const b = bearing(fromLon, fromLat, toLon, toLat);
  const r = distance(fromLon, fromLat, toLon, toLat);
  const alt = isNum(toAlt) ? (units.metric ? ` / ${Math.round(toAlt)} m` : ` / ${Math.round((toAlt * M_TO_FT) / 1000)}k`) : "";
  return `${fmtHdg(b)} / ${fmtDist(r, { suffix: false })}${alt}`;
}

// --- colours ------------------------------------------------------------------

export const COLORS = {
  blue: "#4ea8ff",
  red: "#ff5c5c",
  green: "#5fd38d",
  yellow: "#f2c94c",
  orange: "#ff9f43",
  violet: "#b48cff",
  cyan: "#4dd8e6",
  neutral: "#c8cdd6",
};

export function sideColor(obj) {
  const c = (obj.color || "").toLowerCase();
  if (COLORS[c]) return COLORS[c];
  const co = (obj.coalition || "").toLowerCase();
  if (co.includes("allies") || co.includes("blue")) return COLORS.blue;
  if (co.includes("enem") || co.includes("red")) return COLORS.red;
  return COLORS.neutral;
}

// --- DOM ----------------------------------------------------------------------

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
    else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const ctype = res.headers.get("Content-Type") || "";
  const body = ctype.includes("json") ? await res.json() : await res.text();
  if (!res.ok && res.status !== 202) {
    throw new Error((body && body.error) || `${res.status} ${res.statusText}`);
  }
  return { status: res.status, body };
}

export function debounce(fn, ms) {
  let h;
  return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); };
}

/** Binary search: index of last element <= x (or -1). */
export function bisectRight(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo - 1;
}

/**
 * Radar state (ACMI channel names) at playback index i, or null.  Emitters
 * whose positions are sampled coarsely carry their own radar times (r.t);
 * then time t picks the sample.
 */
export function radarAt(pb, i, t) {
  const r = pb && pb.radar;
  if (r && r.t && isNum(t)) i = bisectRight(r.t, t);
  if (!r || i < 0) return null;
  const at = (a) => (a && isNum(a[i]) ? a[i] : undefined);
  return {
    RadarMode: at(r.mode), RadarAzimuth: at(r.az), RadarElevation: at(r.el), RadarRoll: at(r.roll),
    RadarRange: at(r.range), RadarHorizontalBeamwidth: at(r.hbw), RadarVerticalBeamwidth: at(r.vbw),
    // From the DCS flight log (read in the cockpit), when one was merged.
    ScanAz: at(r.scanAz), ScanEl: at(r.scanEl), ScanCenterAz: at(r.scanCAz), ScanCenterEl: at(r.scanCEl),
    RadarActive: at(r.active),
  };
}

/**
 * Gun rounds visible at time t, as drawable paths.
 * mode "paths": each round's path from the muzzle to where it is now, and the
 * whole path lingers `linger` seconds after impact; "tracers": only a short
 * streak at the round's current position.
 */
export function roundsAt(rounds, t, { mode = "paths", linger = 2.5, maxLife = 8 } = {}) {
  if (!rounds || !rounds.length || mode === "off") return [];
  const out = [];
  // rounds are sorted by first sample; skip anything fired long before t.
  let lo = 0, hi = rounds.length;
  const from = t - maxLife - linger;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (rounds[mid].t[0] < from) lo = mid + 1; else hi = mid; }
  for (let k = lo; k < rounds.length; k++) {
    const r = rounds[k];
    const t0 = r.t[0];
    if (t0 > t) break;
    const end = r.end ?? r.t[r.t.length - 1];
    const keep = mode === "paths" ? linger : 0;
    if (t > end + keep) continue;
    const n = r.t.length;
    let i = bisectRight(r.t, t);
    if (i < 0) i = 0;
    // Position at any time inside the round's samples (linear).
    const at = (tt) => {
      let k = bisectRight(r.t, tt);
      k = Math.max(0, Math.min(n - 2, k));
      if (n < 2) return [r.lon[0], r.lat[0], r.alt[0]];
      const f = Math.max(0, Math.min(1, (tt - r.t[k]) / Math.max(1e-6, r.t[k + 1] - r.t[k])));
      return [r.lon[k] + (r.lon[k + 1] - r.lon[k]) * f, r.lat[k] + (r.lat[k + 1] - r.lat[k]) * f, r.alt[k] + (r.alt[k + 1] - r.alt[k]) * f];
    };
    const flying = t <= end && n > 1 && t <= r.t[n - 1];
    const head = flying ? at(t) : [r.lon[n - 1], r.lat[n - 1], r.alt[n - 1]];
    const pts = [];
    if (mode === "tracers") {
      // A streak of constant length: from 0.15 s back (never before the muzzle) to the head.
      if (flying) pts.push(at(Math.max(t0, t - 0.15)), head);
      else if (t <= end && n > 1) pts.push(at(Math.max(t0, r.t[n - 1] - 0.15)), head);
    } else {
      for (let j = 0; j <= Math.min(i, n - 1); j++) pts.push([r.lon[j], r.lat[j], r.alt[j]]);
      if (flying && t > r.t[Math.min(i, n - 1)] + 1e-6) pts.push(head);
    }
    const impacted = t > end;
    out.push({ id: r.id, shooter: r.shooter, color: r.color, coalition: r.coalition, pts, head, impacted,
      fade: impacted ? Math.max(0, 1 - (t - end) / Math.max(linger, 1e-6)) : 1 });
  }
  return out;
}

/** Interpolate an object's playback arrays at time t. */
export function sampleTrack(tr, t) {
  const n = tr.t.length;
  if (!n || t < tr.t[0] - 1e-6 || t > (tr.end ?? tr.t[n - 1]) + 1e-6) return null;
  let i = bisectRight(tr.t, t);
  if (i < 0) i = 0;
  const j = Math.min(i + 1, n - 1);
  const t0 = tr.t[i], t1 = tr.t[j];
  const f = j > i && t1 > t0 ? Math.min(1, Math.max(0, (t - t0) / (t1 - t0))) : 0;
  const lerp = (a) => (a && isNum(a[i]) ? (isNum(a[j]) ? a[i] + (a[j] - a[i]) * f : a[i]) : null);
  let hdg = null;
  if (tr.yaw && isNum(tr.yaw[i])) {
    const a = tr.yaw[i], b = isNum(tr.yaw[j]) ? tr.yaw[j] : a;
    hdg = (a + wrap180(b - a) * f + 360) % 360;
  }
  return { lon: lerp(tr.lon), lat: lerp(tr.lat), alt: lerp(tr.alt), hdg, pitch: lerp(tr.pitch), roll: lerp(tr.roll), i };
}

// --- geometry helpers shared by the tape, padlock and threat pointers ---------

/** Hostile if both sides are known and differ. */
export function isHostile(a, b) {
  const side = (o) => {
    const c = (o?.coalition || "").toLowerCase();
    if (!c || c.includes("neutral") || c.includes("unknown")) return null;
    return c;
  };
  const sa = side(a), sb = side(b);
  return !!sa && !!sb && sa !== sb;
}

/** Straight-line distance between two points given as lon/lat/alt (m). */
export function slantRange(lonA, latA, altA, lonB, latB, altB) {
  const g = distance(lonA, latA, lonB, latB);
  const dz = isNum(altA) && isNum(altB) ? altB - altA : 0;
  return Math.hypot(g, dz);
}

/** Aspect angle of target T seen from O: 180 = T flying straight at O (hot). */
export function aspectDeg(tLon, tLat, tHdg, oLon, oLat) {
  return Math.abs(wrap180(bearing(tLon, tLat, oLon, oLat) - tHdg + 180));
}

const RAMP_SEQ = [[0.12, 0.2, 0.62], [0.12, 0.62, 0.86], [0.3, 0.82, 0.45], [0.98, 0.84, 0.25], [0.95, 0.3, 0.25]];

/**
 * Colour for a value: kind "seq" (dark blue -> red), "div" (red - grey - green,
 * centred on 0 with a grey dead band) or "limit" (seq, magenta above `limit`).
 * Returns [r, g, b] in 0..1.
 */
export function rampColor(v, lo, hi, kind = "seq", limit = null) {
  if (!isNum(v)) return null;
  if (kind === "limit" && isNum(limit) && v > limit) return [1, 0.25, 0.95];
  if (kind === "div") {
    const m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
    const f = Math.max(-1, Math.min(1, v / m));
    if (Math.abs(v) < (isNum(limit) ? limit : 3)) return [0.62, 0.66, 0.7];
    return f < 0 ? [0.62 + 0.36 * -f, 0.66 - 0.4 * -f, 0.7 - 0.45 * -f] : [0.62 - 0.32 * f, 0.66 + 0.24 * f, 0.7 - 0.3 * f];
  }
  const f = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1))) * (RAMP_SEQ.length - 1);
  const i = Math.min(RAMP_SEQ.length - 2, Math.floor(f)), k = f - i;
  const a = RAMP_SEQ[i], b = RAMP_SEQ[i + 1];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/** CSS gradient matching rampColor, for legends. */
export function rampCss(kind = "seq") {
  const c = (rgb) => `rgb(${rgb.map((x) => Math.round(x * 255)).join(",")})`;
  if (kind === "div") return `linear-gradient(90deg, ${c([0.98, 0.26, 0.25])}, ${c([0.62, 0.66, 0.7])} 45%, ${c([0.62, 0.66, 0.7])} 55%, ${c([0.3, 0.9, 0.4])})`;
  const stops = RAMP_SEQ.map((rgb, i) => `${c(rgb)} ${(i / (RAMP_SEQ.length - 1)) * (kind === "limit" ? 85 : 100)}%`);
  if (kind === "limit") stops.push("rgb(255,64,242) 85%", "rgb(255,64,242) 100%");
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** mm:ss from seconds, for relative labels like "+12s". */
export function fmtRel(sec) {
  return isNum(sec) ? `${sec >= 0 ? "+" : "−"}${Math.round(Math.abs(sec))}s` : "—";
}

/** Speed of sound (m/s) at altitude h (m), ISA. */
export function speedOfSound(h) {
  const T = Math.max(216.65, 288.15 - 0.0065 * (isNum(h) ? h : 0));
  return 20.05 * Math.sqrt(T);
}
