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

/** Radar state (ACMI channel names) at playback index i, or null. */
export function radarAt(pb, i) {
  const r = pb && pb.radar;
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
    const pts = [];
    const tailFrom = mode === "tracers" ? t - 0.15 : -Infinity;
    for (let j = 0; j <= Math.min(i, n - 1); j++) if (r.t[j] >= tailFrom) pts.push([r.lon[j], r.lat[j], r.alt[j]]);
    let head;
    if (i < n - 1 && t <= end) {
      const f = (t - r.t[i]) / Math.max(1e-6, r.t[i + 1] - r.t[i]);
      head = [r.lon[i] + (r.lon[i + 1] - r.lon[i]) * f, r.lat[i] + (r.lat[i + 1] - r.lat[i]) * f, r.alt[i] + (r.alt[i + 1] - r.alt[i]) * f];
      pts.push(head);
    } else {
      head = [r.lon[n - 1], r.lat[n - 1], r.alt[n - 1]];
    }
    if (mode === "tracers" && pts.length < 2 && i > 0) pts.unshift([r.lon[i - 1], r.lat[i - 1], r.alt[i - 1]]);
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
