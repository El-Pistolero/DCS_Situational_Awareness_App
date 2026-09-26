// A radar readout for the live view: a B-scope, azimuth across, range up.
//
// Honest about what it is.  DCS does not export its radar's contact list, so
// this is not the picture on your MFD; it is every aircraft that falls inside
// the radar volume DCS *does* tell us about (scan zone from the bridge, or
// the recorded antenna values).  A contact shown here is one your radar would
// very likely be painting - not one it has certainly locked.
//
// What is known rather than worked out is drawn differently: the target DCS
// reports as locked is filled and labelled, everything else is an open brick.

import { M_TO_FT, isNum, sideColor, wrap180 } from "./util.js";
import { cssVar, rgba } from "./theme.js";
import { radarVolume } from "./symbols.js";

const NM = 1852;
//: Ranges the scale snaps to, so the picture does not jitter every sweep.
const RANGE_STEPS = [5, 10, 20, 40, 80, 160];

/** Bearing and range from one point to another, plus the height difference. */
function relative(me, o) {
  const dLat = (o.lat - me.lat) * 111320;
  const dLon = (o.lon - me.lon) * 111320 * Math.cos((me.lat * Math.PI) / 180);
  const range = Math.hypot(dLat, dLon);
  const brg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
  return { range, brg: (brg + 360) % 360, dAlt: (o.alt ?? 0) - (me.alt ?? 0) };
}

/**
 * Which contacts the radar would be painting.
 * me: the focused object row; objects: all rows; returns {vol, contacts, range}.
 */
export function readout(me, objects, { maxRange = null } = {}) {
  const vol = me ? radarVolume(me, { assumed: true }) : null;
  if (!me || !vol || vol.surface) return null;
  const heading = isNum(me.hdg) ? me.hdg : 0;
  // The scan centre is relative to the nose for a body-frame antenna.
  const centreAz = (vol.bodyFrame ? heading : 0) + (vol.centerAz || 0);
  const halfAz = Math.max(5, vol.az || 30);
  const limit = maxRange || RANGE_STEPS.find((r) => r * NM >= (vol.range || 0) * 0.95) * NM
    || RANGE_STEPS[RANGE_STEPS.length - 1] * NM;

  const contacts = [];
  for (const o of objects) {
    if (o.id === me.id) continue;
    if (!["fixedwing", "rotorcraft", "air"].includes(o.category)) continue;
    if (!isNum(o.lat) || !isNum(o.lon)) continue;
    const r = relative(me, o);
    if (r.range > limit) continue;
    const az = wrap180(r.brg - centreAz);
    if (Math.abs(az) > halfAz) continue;
    // Elevation is checked loosely: the scan bars sweep, so a contact inside
    // the azimuth at a plausible height is one the radar would find.
    const el = (Math.atan2(r.dAlt, Math.max(r.range, 1)) * 180) / Math.PI;
    if (Math.abs(el) > Math.max(10, (vol.el || 5) * 2.5)) continue;
    contacts.push({
      o, az, range: r.range, el,
      locked: me.lock != null && String(me.lock) === String(o.id),
    });
  }
  contacts.sort((a, b) => a.range - b.range);
  return { vol, contacts, range: limit, halfAz, centreAz };
}

/** Draw the B-scope into a canvas context sized w x h (CSS pixels). */
export function drawBScope(ctx, w, h, data, { metric = false } = {}) {
  ctx.clearRect(0, 0, w, h);
  const pad = { l: 26, r: 8, t: 8, b: 16 };
  const gw = w - pad.l - pad.r, gh = h - pad.t - pad.b;
  const line = rgba("--line-2", 0.9), faint = rgba("--muted", 0.75);
  ctx.font = `10px ${cssVar("--mono") || "monospace"}`;

  if (!data) {
    ctx.fillStyle = faint;
    ctx.textAlign = "center";
    ctx.fillText("radar off", w / 2, h / 2);
    return;
  }
  const { contacts, range, halfAz } = data;
  const unit = metric ? 1000 : NM;
  const x = (az) => pad.l + gw * (0.5 + az / (2 * halfAz));
  const y = (r) => pad.t + gh * (1 - r / range);

  // Frame, azimuth ticks and range rings.
  ctx.strokeStyle = line;
  ctx.lineWidth = 1;
  ctx.strokeRect(pad.l, pad.t, gw, gh);
  ctx.strokeStyle = rgba("--line-2", 0.45);
  ctx.fillStyle = faint;
  ctx.textAlign = "center";
  for (const az of [-halfAz / 2, 0, halfAz / 2]) {
    ctx.beginPath();
    ctx.moveTo(x(az), pad.t); ctx.lineTo(x(az), pad.t + gh);
    ctx.stroke();
  }
  ctx.fillText(`${Math.round(halfAz)}L`, pad.l + 12, h - 4);
  ctx.fillText(`${Math.round(halfAz)}R`, pad.l + gw - 12, h - 4);
  ctx.textAlign = "right";
  const rings = 4;
  for (let i = 1; i <= rings; i++) {
    const r = (range / rings) * i;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(r)); ctx.lineTo(pad.l + gw, y(r));
    ctx.stroke();
    ctx.fillText(`${Math.round(r / unit)}`, pad.l - 3, y(r) + 3);
  }

  // Contacts: an open brick each, filled when DCS says it is locked.
  for (const c of contacts) {
    const cx = x(c.az), cy = y(c.range);
    const col = sideColor(c.o);
    ctx.strokeStyle = col;
    ctx.fillStyle = col;
    ctx.lineWidth = c.locked ? 2 : 1.4;
    if (c.locked) ctx.fillRect(cx - 5, cy - 3, 10, 6);
    else ctx.strokeRect(cx - 5, cy - 3, 10, 6);
    // Height difference in thousands of feet, the way a radar page shows it.
    const kft = c.o.alt != null ? (c.o.alt * M_TO_FT) / 1000 : null;
    if (kft != null) {
      ctx.fillStyle = rgba("--text", 0.8);
      ctx.textAlign = "left";
      ctx.fillText(`${kft >= 0 ? "" : "-"}${Math.abs(kft).toFixed(0)}`, cx + 8, cy + 3);
    }
    if (c.locked) {
      ctx.fillStyle = col;
      ctx.textAlign = "center";
      ctx.fillText(c.o.pilot || c.o.name || "", cx, cy - 7);
    }
  }
  if (!contacts.length) {
    ctx.fillStyle = faint;
    ctx.textAlign = "center";
    ctx.fillText("no contacts in the scan", pad.l + gw / 2, pad.t + gh / 2);
  }
}

/** One line describing where the picture came from, for under the scope. */
export function scopeCaption(data) {
  if (!data) return "Radar off, or no scan data from DCS.";
  const src = data.vol.source === "dcs" ? "DCS scan zone"
    : data.vol.source === "recorded" ? "recorded antenna" : "typical for the type";
  const n = data.contacts.length;
  return `${n} contact${n === 1 ? "" : "s"} · ${Math.round(data.range / NM)} nm · ${src}`;
}
