// Minimal canvas line chart with a playhead, hover readout and click-to-seek.

import { isNum } from "./util.js";

export class LineChart {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts { title, yFormat, xFormat, onSeek, height, yMin, yMax, invertX }
   */
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts;
    this.series = [];
    this.marker = null;
    this.hoverX = null;
    this.bands = [];
    this.pad = { l: 46, r: 10, t: 20, b: 20 };
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener("pointermove", (e) => {
      const r = canvas.getBoundingClientRect();
      this.hoverX = e.clientX - r.left;
      this.draw();
    });
    canvas.addEventListener("pointerleave", () => { this.hoverX = null; this.draw(); });
    canvas.addEventListener("click", (e) => {
      if (!this.opts.onSeek) return;
      const r = canvas.getBoundingClientRect();
      const x = this._invX(e.clientX - r.left);
      if (isNum(x)) this.opts.onSeek(x);
    });
  }

  /** series: [{name, color, x, y, dash, width, fill}] */
  setData(series, { xMin, xMax, yMin, yMax } = {}) {
    this.series = series.filter((s) => s && s.x && s.y && s.x.length);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        const x = s.x[i], y = s.y[i];
        if (!isNum(x) || !isNum(y)) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (!s.ignoreRange) { if (y < y0) y0 = y; if (y > y1) y1 = y; }
      }
    }
    if (!isNum(x0)) { x0 = 0; x1 = 1; }
    if (!isNum(y0)) { y0 = 0; y1 = 1; }
    if (y1 - y0 < 1e-6) { y0 -= 1; y1 += 1; }
    const span = y1 - y0;
    this.x0 = xMin ?? x0; this.x1 = xMax ?? x1;
    this.y0 = yMin ?? this.opts.yMin ?? y0 - span * 0.06;
    this.y1 = yMax ?? this.opts.yMax ?? y1 + span * 0.06;
    this.draw();
  }

  setMarker(x) { this.marker = x; this.draw(); }
  setBands(bands) { this.bands = bands || []; this.draw(); }
  /** Vertical x-ranges shaded behind the series: [{x0, x1, color}]. */
  setVBands(bands) { this.vbands = bands || []; this.draw(); }
  /** Short vertical marks at x positions: [{x, color, w}]. */
  setMarks(marks) { this.marks = marks || []; this.draw(); }

  _sx(x) {
    const { l, r } = this.pad;
    const w = this.w - l - r;
    const f = (x - this.x0) / (this.x1 - this.x0 || 1);
    return this.opts.invertX ? l + w * (1 - f) : l + w * f;
  }
  _sy(y) {
    const { t, b } = this.pad;
    return t + (this.h - t - b) * (1 - (y - this.y0) / (this.y1 - this.y0 || 1));
  }
  _invX(px) {
    const { l, r } = this.pad;
    let f = (px - l) / (this.w - l - r);
    if (this.opts.invertX) f = 1 - f;
    if (f < 0 || f > 1) return null;
    return this.x0 + f * (this.x1 - this.x0);
  }

  draw() {
    const c = this.canvas, ctx = this.ctx;
    const r = c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width; this.h = r.height;
    if (!this.w || !this.h) return;
    c.width = Math.round(this.w * dpr); c.height = Math.round(this.h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    const { l, r: pr, t, b } = this.pad;
    const yf = this.opts.yFormat || ((v) => v.toFixed(0));
    const xf = this.opts.xFormat || ((v) => v.toFixed(0));

    // Bands (e.g. on-speed AOA bracket)
    for (const band of this.bands) {
      ctx.fillStyle = band.color;
      const ya = this._sy(band.from), yb = this._sy(band.to);
      ctx.fillRect(l, Math.min(ya, yb), this.w - l - pr, Math.abs(yb - ya));
    }

    // Grid
    ctx.strokeStyle = "rgba(140,155,175,0.14)";
    ctx.fillStyle = "rgba(170,182,198,0.75)";
    ctx.font = "10px ui-monospace, monospace";
    ctx.lineWidth = 1;
    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = this.y0 + ((this.y1 - this.y0) * i) / ticks;
      const y = this._sy(v);
      ctx.beginPath(); ctx.moveTo(l, y); ctx.lineTo(this.w - pr, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(yf(v), l - 5, y);
    }
    const xt = 5;
    for (let i = 0; i <= xt; i++) {
      const v = this.x0 + ((this.x1 - this.x0) * i) / xt;
      const x = this._sx(v);
      ctx.textAlign = i === 0 ? "left" : i === xt ? "right" : "center";
      ctx.textBaseline = "top";
      ctx.fillText(xf(v), x, this.h - b + 5);
    }

    // Title / legend
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.font = "11px system-ui, sans-serif";
    let lx = l;
    if (this.opts.title) {
      ctx.fillStyle = "rgba(225,230,238,0.9)";
      ctx.fillText(this.opts.title, lx, 3);
      lx += ctx.measureText(this.opts.title).width + 12;
    }
    for (const s of this.series) {
      if (!s.name || s.legend === false) continue;
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, 7, 10, 3);
      ctx.fillStyle = "rgba(200,208,220,0.85)";
      ctx.fillText(s.name, lx + 14, 3);
      lx += ctx.measureText(s.name).width + 28;
    }

    // Series
    ctx.save();
    ctx.beginPath(); ctx.rect(l, t, this.w - l - pr, this.h - t - b); ctx.clip();
    for (const vb of this.vbands || []) {
      const xa = this._sx(vb.x0), xb = this._sx(vb.x1);
      ctx.fillStyle = vb.color;
      ctx.fillRect(Math.min(xa, xb), t, Math.max(1, Math.abs(xb - xa)), this.h - t - b);
    }
    for (const mk of this.marks || []) {
      const xa = this._sx(mk.x), xb = this._sx(mk.x + (mk.w || 0));
      ctx.fillStyle = mk.color;
      ctx.fillRect(Math.min(xa, xb), this.h - b - 8, Math.max(2, Math.abs(xb - xa)), 8);
    }
    for (const s of this.series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 1.5;
      ctx.setLineDash(s.dash || []);
      ctx.beginPath();
      let pen = false;
      const step = Math.max(1, Math.floor(s.x.length / (this.w * 2)));
      for (let i = 0; i < s.x.length; i += step) {
        const x = s.x[i], y = s.y[i];
        if (!isNum(x) || !isNum(y)) { pen = false; continue; }
        const px = this._sx(x), py = this._sy(y);
        if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
      }
      ctx.stroke();
      if (s.fill) {
        ctx.lineTo(this._sx(s.x[s.x.length - 1]), this._sy(Math.max(this.y0, 0)));
        ctx.lineTo(this._sx(s.x[0]), this._sy(Math.max(this.y0, 0)));
        ctx.closePath();
        ctx.fillStyle = s.fill;
        ctx.fill();
      }
    }
    ctx.setLineDash([]);
    ctx.restore();

    // Playhead
    if (isNum(this.marker) && this.marker >= this.x0 && this.marker <= this.x1) {
      const x = this._sx(this.marker);
      ctx.strokeStyle = "#ffd166";
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x, t); ctx.lineTo(x, this.h - b); ctx.stroke();
      this._readout(this.marker, x, false);
    }
    // Hover
    if (isNum(this.hoverX)) {
      const xv = this._invX(this.hoverX);
      if (isNum(xv)) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(this.hoverX, t); ctx.lineTo(this.hoverX, this.h - b); ctx.stroke();
        this._readout(xv, this.hoverX, true);
      }
    }
  }

  _readout(xv, px, hover) {
    const ctx = this.ctx;
    const yf = this.opts.yFormat || ((v) => v.toFixed(1));
    const parts = [];
    for (const s of this.series) {
      if (s.readout === false) continue;
      const i = nearest(s.x, xv);
      if (i < 0 || !isNum(s.y[i])) continue;
      parts.push({ color: s.color, text: yf(s.y[i]) });
      const py = this._sy(s.y[i]);
      ctx.fillStyle = s.color;
      ctx.beginPath(); ctx.arc(this._sx(s.x[i]), py, 2.8, 0, Math.PI * 2); ctx.fill();
    }
    if (!hover || !parts.length) return;
    ctx.font = "11px ui-monospace, monospace";
    const xf = this.opts.xFormat || ((v) => v.toFixed(0));
    const label = xf(xv);
    let w = ctx.measureText(label).width + 12;
    for (const p of parts) w += ctx.measureText(p.text).width + 12;
    let bx = px + 8;
    if (bx + w > this.w) bx = px - w - 8;
    ctx.fillStyle = "rgba(10,14,20,0.9)";
    ctx.fillRect(bx, this.pad.t + 2, w, 18);
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#aab4c3";
    ctx.fillText(label, bx + 6, this.pad.t + 11);
    let x = bx + 6 + ctx.measureText(label).width + 10;
    for (const p of parts) {
      ctx.fillStyle = p.color;
      ctx.fillText(p.text, x, this.pad.t + 11);
      x += ctx.measureText(p.text).width + 12;
    }
  }
}

function nearest(arr, x) {
  if (!arr || !arr.length) return -1;
  let lo = 0, hi = arr.length - 1;
  const asc = arr[hi] >= arr[0];
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((arr[mid] <= x) === asc) lo = mid; else hi = mid;
  }
  return Math.abs(arr[lo] - x) <= Math.abs(arr[hi] - x) ? lo : hi;
}
