// Cockpit-style instruments drawn on canvas.

import { isNum } from "./util.js";

function setup(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

/** Attitude indicator with pitch ladder, bank scale and a flight-path marker. */
export function drawADI(canvas, { pitch, roll, fpa, aoa } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !h) return;
  const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 2;
  const p = isNum(pitch) ? pitch : 0, r = isNum(roll) ? roll : 0;
  const ppd = R / 30; // pixels per degree of pitch

  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
  ctx.translate(cx, cy);
  ctx.rotate((-r * Math.PI) / 180);
  const hy = p * ppd;
  ctx.fillStyle = "#2f6aa3"; ctx.fillRect(-R * 2, -R * 3 + hy, R * 4, R * 3);
  ctx.fillStyle = "#6b4a2b"; ctx.fillRect(-R * 2, hy, R * 4, R * 3);
  ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(-R * 2, hy); ctx.lineTo(R * 2, hy); ctx.stroke();
  ctx.font = "9px ui-monospace, monospace"; ctx.fillStyle = "#fff"; ctx.textBaseline = "middle";
  for (let d = -60; d <= 60; d += 5) {
    if (!d) continue;
    const y = hy - d * ppd;
    if (Math.abs(y) > R) continue;
    const len = d % 10 === 0 ? R * 0.34 : R * 0.16;
    ctx.beginPath(); ctx.moveTo(-len, y); ctx.lineTo(len, y); ctx.stroke();
    if (d % 10 === 0) {
      ctx.textAlign = "right"; ctx.fillText(Math.abs(d), -len - 3, y);
      ctx.textAlign = "left"; ctx.fillText(Math.abs(d), len + 3, y);
    }
  }
  ctx.restore();

  // Bank scale
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5;
  for (const a of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
    const rad = ((a - 90) * Math.PI) / 180;
    const inner = a % 30 === 0 ? R - 10 : R - 6;
    ctx.beginPath(); ctx.moveTo(Math.cos(rad) * inner, Math.sin(rad) * inner);
    ctx.lineTo(Math.cos(rad) * R, Math.sin(rad) * R); ctx.stroke();
  }
  ctx.rotate((-r * Math.PI) / 180);
  ctx.fillStyle = "#ffd166";
  ctx.beginPath(); ctx.moveTo(0, -R + 11); ctx.lineTo(-5, -R + 19); ctx.lineTo(5, -R + 19); ctx.closePath(); ctx.fill();
  ctx.restore();

  // Aircraft reference + flight path marker
  ctx.strokeStyle = "#ffd166"; ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(cx - R * 0.5, cy); ctx.lineTo(cx - R * 0.16, cy); ctx.lineTo(cx - R * 0.08, cy + 7);
  ctx.moveTo(cx + R * 0.5, cy); ctx.lineTo(cx + R * 0.16, cy); ctx.lineTo(cx + R * 0.08, cy + 7);
  ctx.stroke();
  ctx.fillStyle = "#ffd166"; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();
  if (isNum(fpa)) {
    // Flight path marker sits (pitch - fpa) below the nose, rotated with bank.
    const off = (p - fpa) * ppd;
    const a = (r * Math.PI) / 180;
    const fx = cx - Math.sin(a) * -off, fy = cy + Math.cos(a) * off;
    ctx.strokeStyle = "#5fd38d"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(fx, fy, 6, 0, Math.PI * 2);
    ctx.moveTo(fx - 13, fy); ctx.lineTo(fx - 6, fy); ctx.moveTo(fx + 6, fy); ctx.lineTo(fx + 13, fy);
    ctx.moveTo(fx, fy - 6); ctx.lineTo(fx, fy - 11);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(0,0,0,0.6)"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  void aoa;
}

/** Stick position box (pitch/roll) plus rudder bar.  Values in -1..1. */
export function drawStick(canvas, { pitch, roll, yaw, label = "" } = {}) {
  const { ctx, w, h } = setup(canvas);
  if (!w || !h) return;
  const size = Math.min(w, h - 16);
  const x0 = (w - size) / 2, y0 = 2;
  ctx.strokeStyle = "rgba(170,182,198,0.35)"; ctx.lineWidth = 1;
  ctx.strokeRect(x0, y0, size, size);
  ctx.beginPath();
  ctx.moveTo(x0 + size / 2, y0); ctx.lineTo(x0 + size / 2, y0 + size);
  ctx.moveTo(x0, y0 + size / 2); ctx.lineTo(x0 + size, y0 + size / 2);
  ctx.stroke();
  const has = isNum(pitch) || isNum(roll);
  if (has) {
    // Aft stick (positive pitch input) plots down, like looking at the grip.
    const sx = x0 + size / 2 + (isNum(roll) ? roll : 0) * (size / 2 - 4);
    const sy = y0 + size / 2 + (isNum(pitch) ? pitch : 0) * (size / 2 - 4);
    ctx.fillStyle = "#ffd166";
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.fillStyle = "rgba(170,182,198,0.5)";
    ctx.font = "10px system-ui, sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("no data", x0 + size / 2, y0 + size / 2);
  }
  const by = y0 + size + 6;
  ctx.strokeStyle = "rgba(170,182,198,0.35)";
  ctx.strokeRect(x0, by, size, 7);
  if (isNum(yaw)) {
    const yx = x0 + size / 2 + yaw * (size / 2);
    ctx.fillStyle = "#4dd8e6";
    ctx.fillRect(Math.min(x0 + size / 2, yx), by + 1, Math.abs(yx - (x0 + size / 2)), 5);
  }
  if (label) {
    ctx.fillStyle = "rgba(170,182,198,0.7)"; ctx.font = "9px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "top"; ctx.fillText(label, x0 + 2, y0 + 2);
  }
}

/** Horizontal fill bar, value 0..max. */
export function bar(el, value, max = 1, { warn = null, color = null } = {}) {
  const fill = el.querySelector(".fill");
  const v = isNum(value) ? Math.max(0, Math.min(1, value / max)) : 0;
  fill.style.width = `${v * 100}%`;
  fill.style.background = color || (warn != null && isNum(value) && value > warn ? "var(--warn)" : "");
  el.classList.toggle("nodata", !isNum(value));
}
