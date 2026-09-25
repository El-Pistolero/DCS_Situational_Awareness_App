// Coordinate formats pilots type into DCS jets: decimal degrees, deg-min
// (F-16 DED / A-10 style), deg-min-sec and MGRS; plus a clipboard helper.
// Dependency-free so it also runs under node for tests.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const pad = (n, w) => String(n).padStart(w, "0");

export const COORD_FORMATS = [["dd", "Decimal °"], ["ddm", "Deg-min (DED)"], ["dms", "Deg-min-sec"], ["mgrs", "MGRS"]];

// Each format rounds once, to integer ticks of its last printed digit, and
// splits those: 41.99999° carries to 42°00.000', never 41°60.000'.
const FIELDS = {
  dd: [1e4, (t, w) => `${pad(Math.floor(t / 1e4), w)}.${pad(t % 1e4, 4)}°`],
  ddm: [6e4, (t, w) => `${pad(Math.floor(t / 6e4), w)}°${pad(Math.floor((t % 6e4) / 1e3), 2)}.${pad(t % 1e3, 3)}'`],
  dms: [36e3, (t, w) => `${pad(Math.floor(t / 36e3), w)}°${pad(Math.floor((t % 36e3) / 600), 2)}'${pad(Math.floor((t % 600) / 10), 2)}.${t % 10}"`],
};

/** [text, hemisphere letter]; a value that rounds to zero is N / E, never "S 00°00.000'". */
function axis(v, w, fmt, pos, neg) {
  const [perDeg, render] = FIELDS[fmt];
  const t = Math.round(Math.abs(v) * perDeg);
  return [render(t, w), t && v < 0 ? neg : pos];
}

const wrapLon = (lon) => (lon < -180 || lon > 180 ? ((((lon + 180) % 360) + 360) % 360) - 180 : lon);

/**
 * dd   41.6421°N 041.7171°E
 * ddm  N 41°38.526' E 041°43.028'
 * dms  N 41°38'31.6" E 041°43'01.7"
 * mgrs 37T GG 09863 10345 ("" outside 80°S-84°N, where MGRS uses UPS instead)
 */
export function fmtCoord(lon, lat, fmt = "dd") {
  if (!isNum(lon) || !isNum(lat) || Math.abs(lat) > 90) return "—";
  lon = wrapLon(lon);
  if (fmt === "mgrs") return toMGRS(lon, lat);
  const f = FIELDS[fmt] ? fmt : "dd";
  const [la, ns] = axis(lat, 2, f, "N", "S"), [lo, ew] = axis(lon, 3, f, "E", "W");
  return f === "dd" ? `${la}${ns} ${lo}${ew}` : `${ns} ${la} ${ew} ${lo}`;
}

// --- UTM (WGS84 transverse Mercator) ----------------------------------------

const A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
const E = Math.sqrt(F * (2 - F));
// Krüger series to n^6 (Karney 2011): nanometre-accurate across the widened
// Norway / Svalbard zones, where the classic Snyder series drifts.
const N1 = F / (2 - F), N2 = N1 * N1, N3 = N2 * N1, N4 = N3 * N1, N5 = N4 * N1, N6 = N5 * N1;
const RECT = (A / (1 + N1)) * (1 + N2 / 4 + N4 / 64 + N6 / 256);
const ALPHA = [
  N1 / 2 - (2 / 3) * N2 + (5 / 16) * N3 + (41 / 180) * N4 - (127 / 288) * N5 + (7891 / 37800) * N6,
  (13 / 48) * N2 - (3 / 5) * N3 + (557 / 1440) * N4 + (281 / 630) * N5 - (1983433 / 1935360) * N6,
  (61 / 240) * N3 - (103 / 140) * N4 + (15061 / 26880) * N5 + (167603 / 181440) * N6,
  (49561 / 161280) * N4 - (179 / 168) * N5 + (6601661 / 7257600) * N6,
  (34729 / 80640) * N5 - (3418889 / 1995840) * N6,
  (212378941 / 319334400) * N6,
];

// 8° bands from 80°S; X is stretched to 12° (72-84°N).
const BANDS = "CDEFGHJKLMNPQRSTUVWX";
const bandFor = (lat) => BANDS[Math.min(19, Math.floor((lat + 80) / 8))];

function zoneFor(lon, lat) {
  const zone = Math.min(60, Math.floor((lon + 180) / 6) + 1);
  // Norway: 32V widened west to 3°E. Svalbard: 31X/33X/35X/37X, no 32/34/36X.
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;
  if (lat >= 72 && lon >= 0 && lon < 42) return lon < 9 ? 31 : lon < 21 ? 33 : lon < 33 ? 35 : 37;
  return zone;
}

/** {zone, band, easting, northing, hemisphere} in metres; null outside 80°S-84°N. */
export function toUTM(lon, lat) {
  if (!isNum(lon) || !isNum(lat) || lat < -80 || lat > 84) return null;
  lon = wrapLon(lon);
  const zone = zoneFor(lon, lat);
  const lam = (lon - (zone * 6 - 183)) * (Math.PI / 180);
  const tau = Math.tan(lat * (Math.PI / 180));
  const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
  const tauP = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xiP = Math.atan2(tauP, Math.cos(lam));
  const etaP = Math.asinh(Math.sin(lam) / Math.sqrt(tauP * tauP + Math.cos(lam) ** 2));
  let xi = xiP, eta = etaP;
  ALPHA.forEach((a, i) => {
    const j = 2 * (i + 1);
    xi += a * Math.sin(j * xiP) * Math.cosh(j * etaP);
    eta += a * Math.cos(j * xiP) * Math.sinh(j * etaP);
  });
  return {
    zone,
    band: bandFor(lat),
    easting: K0 * RECT * eta + 500000,
    northing: K0 * RECT * xi + (lat < 0 ? 10000000 : 0),
    hemisphere: lat < 0 ? "S" : "N",
  };
}

// --- MGRS -------------------------------------------------------------------

// 100 km column letters by set (zone % 3: 1, 2, 0); row letters cycle every
// 2,000 km, even zones starting at F.
const COLS = ["STUVWXYZ", "ABCDEFGH", "JKLMNPQR"];
const ROWS = "ABCDEFGHJKLMNPQRSTUV";

/** "37T GG 09863 10345" with `digits` (1-5) per axis; "" where MGRS does not apply (poles). */
export function toMGRS(lon, lat, digits = 5) {
  const u = toUTM(lon, lat);
  if (!u) return "";
  const col = COLS[u.zone % 3][Math.floor(u.easting / 1e5) - 1];
  const row = ROWS[(Math.floor(u.northing / 1e5) + (u.zone % 2 ? 0 : 5)) % 20];
  if (!col || !row) return "";
  const n = isNum(digits) ? Math.min(5, Math.max(1, Math.floor(digits))) : 5;
  // MGRS truncates, it does not round: the grid square must contain the point.
  const cut = (v) => pad(Math.floor((Math.floor(v) % 1e5) / 10 ** (5 - n)), n);
  return `${u.zone}${u.band} ${col}${row} ${cut(u.easting)} ${cut(u.northing)}`;
}

// --- Clipboard ----------------------------------------------------------------

/** Copy text to the clipboard; true on success, never throws. */
export async function copyText(text) {
  const s = String(text ?? "");
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(s);
      return true;
    }
  } catch { /* not a secure context or no permission: fall back below */ }
  let ta = null, prev = null;
  try {
    prev = document.activeElement;
    ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", ""); // no on-screen keyboard on touch devices
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
    document.body.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    return document.execCommand("copy") === true;
  } catch {
    return false;
  } finally {
    try { ta?.remove(); prev?.focus?.({ preventScroll: true }); } catch { /* detached */ }
  }
}
