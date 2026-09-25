// Coordinate formats pilots type into DCS jets: decimal degrees, deg-min
// (F-16 DED / A-10 style), deg-min-sec and MGRS; plus a clipboard helper.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const COORD_FORMATS = [["dd", "Decimal °"], ["ddm", "Deg-min (DED)"], ["dms", "Deg-min-sec"], ["mgrs", "MGRS"]];

/** Degrees and minutes with `digits` decimals, carrying 60' into the next degree. */
function degMin(v, digits) {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Number(((a - d) * 60).toFixed(digits));
  if (m >= 60) { d += 1; m = 0; }
  return [d, m];
}

function degMinSec(v, digits) {
  const a = Math.abs(v);
  let d = Math.floor(a);
  let m = Math.floor((a - d) * 60);
  let s = Number(((a - d - m / 60) * 3600).toFixed(digits));
  if (s >= 60) { s = 0; m += 1; }
  if (m >= 60) { m = 0; d += 1; }
  return [d, m, s];
}

const pad = (n, w, digits = 0) => {
  const txt = n.toFixed(digits);
  const [i, f] = txt.split(".");
  return `${i.padStart(w, "0")}${f !== undefined ? `.${f}` : ""}`;
};

export function fmtCoord(lon, lat, fmt = "dd") {
  if (!isNum(lon) || !isNum(lat)) return "—";
  const ns = lat >= 0 ? "N" : "S", ew = lon >= 0 ? "E" : "W";
  if (fmt === "ddm") {
    const [ad, am] = degMin(lat, 3), [od, om] = degMin(lon, 3);
    return `${ns} ${pad(ad, 2)}°${pad(am, 2, 3)}' ${ew} ${pad(od, 3)}°${pad(om, 2, 3)}'`;
  }
  if (fmt === "dms") {
    const [ad, am, as] = degMinSec(lat, 1), [od, om, os] = degMinSec(lon, 1);
    return `${ns} ${pad(ad, 2)}°${pad(am, 2)}'${pad(as, 2, 1)}" ${ew} ${pad(od, 3)}°${pad(om, 2)}'${pad(os, 2, 1)}"`;
  }
  if (fmt === "mgrs") return toMGRS(lon, lat) || fmtCoord(lon, lat, "ddm");
  return `${Math.abs(lat).toFixed(4)}°${ns} ${pad(Math.abs(lon), 3, 4)}°${ew}`;
}

// --- UTM / MGRS (WGS84) -------------------------------------------------------

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
const BANDS = "CDEFGHJKLMNPQRSTUVWXX"; // 8° bands from 80°S; X is 12° (72-84°N)

function zoneFor(lon, lat) {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Norway and Svalbard exceptions.
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return zone;
}

export function toUTM(lon, lat) {
  if (!isNum(lon) || !isNum(lat) || lat < -80 || lat > 84) return null;
  const zone = zoneFor(lon, lat);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * (Math.PI / 180);
  const phi = lat * (Math.PI / 180), lam = lon * (Math.PI / 180);
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin);
  const T = tan * tan, C = EP2 * cos * cos, Aa = cos * (lam - lon0);
  const e4 = E2 * E2, e6 = e4 * E2;
  const M = A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const easting = K0 * N * (Aa + ((1 - T + C) * Aa ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120) + 500000;
  let northing = K0 * (M + N * tan * ((Aa * Aa) / 2 + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720));
  const hemisphere = lat >= 0 ? "N" : "S";
  if (lat < 0) northing += 10000000;
  const band = BANDS[Math.min(20, Math.floor((lat + 80) / 8))];
  return { zone, band, easting, northing, hemisphere };
}

const COLS = ["ABCDEFGH", "JKLMNPQR", "STUVWXYZ"];
const ROWS = "ABCDEFGHJKLMNPQRSTUV";

/** MGRS with `digits` (1-5) digits per axis; "" where MGRS does not apply (poles). */
export function toMGRS(lon, lat, digits = 5) {
  const u = toUTM(lon, lat);
  if (!u) return "";
  const n = Math.max(1, Math.min(5, Math.round(digits)));
  const set = (u.zone - 1) % 3;
  const col = COLS[set][Math.floor(u.easting / 100000) - 1];
  // Row letters repeat every 2,000 km; even zones start 5 letters (F) later.
  const row = ROWS[(Math.floor(u.northing / 100000) + (u.zone % 2 === 0 ? 5 : 0)) % 20];
  if (!col) return "";
  // MGRS truncates, it does not round.
  const e = Math.floor(u.easting % 100000), no = Math.floor(u.northing % 100000);
  const cut = (v) => String(Math.floor(v / 10 ** (5 - n))).padStart(n, "0");
  return `${u.zone}${u.band} ${col}${row} ${cut(e)} ${cut(no)}`;
}

/** Copy text to the clipboard; never throws. */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; }
  } catch { /* fall back below (no permission, not a secure context) */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch { return false; }
}
