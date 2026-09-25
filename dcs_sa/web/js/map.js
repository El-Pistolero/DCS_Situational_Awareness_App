// Canvas tactical map: Web Mercator, slippy tiles, pan/zoom/rotate.
//
// Deliberately dependency-free.  Tiles are optional decoration - if the
// machine is offline the map falls back to a lat/lon grid and everything
// tactical still draws.

const TILE = 256;

export const LAYERS = {
  dark: {
    label: "Dark",
    url: (z, x, y) => `https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/dark_all/${z}/${x}/${y}.png`,
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 19,
  },
  satellite: {
    label: "Satellite",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    maxZoom: 18,
    dim: 0.45,
  },
  terrain: {
    label: "Topo",
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`,
    attribution: "© Esri, HERE, Garmin, USGS",
    maxZoom: 18,
    dim: 0.55,
  },
  grid: { label: "Grid only", url: null, attribution: "", maxZoom: 22 },
};

const lonToX = (lon, z) => ((lon + 180) / 360) * TILE * 2 ** z;
const latToY = (lat, z) => {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * TILE * 2 ** z;
};
const xToLon = (x, z) => (x / (TILE * 2 ** z)) * 360 - 180;
const yToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / (TILE * 2 ** z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

export class TacticalMap {
  constructor(canvas, { layer = "dark", minZoom = 3, maxZoom = 17 } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.center = [41.6, 41.6];
    this.zoom = 9;
    this.rotation = 0; // degrees; map is rotated so this bearing points up
    this.minZoom = minZoom;
    this.maxZoom = maxZoom;
    this.layer = LAYERS[layer] ? layer : "dark";
    this.tiles = new Map();
    this.failedTiles = 0;
    this.scene = null;
    this.listeners = {};
    this.dirty = true;
    this.dpr = window.devicePixelRatio || 1;
    this.interactive = true;
    this._drag = null;
    this._bindEvents();
    this._resizeObserver = new ResizeObserver(() => this.resize());
    this._resizeObserver.observe(canvas);
    this.resize();
    const loop = () => {
      if (this.dirty) {
        this.dirty = false;
        this._draw();
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  on(evt, fn) { (this.listeners[evt] ||= []).push(fn); }
  emit(evt, ...a) { (this.listeners[evt] || []).forEach((fn) => fn(...a)); }
  invalidate() { this.dirty = true; }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = Math.max(1, r.width);
    this.h = Math.max(1, r.height);
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.invalidate();
  }

  setLayer(name) {
    if (!LAYERS[name]) return;
    this.layer = name;
    this.tiles.clear();
    this.failedTiles = 0;
    this.invalidate();
  }

  setView(lon, lat, zoom = this.zoom) {
    this.center = [lon, lat];
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.invalidate();
  }

  setRotation(deg) {
    this.rotation = ((deg % 360) + 360) % 360;
    this.invalidate();
  }

  fitBounds(minLon, minLat, maxLon, maxLat, pad = 60) {
    if (![minLon, minLat, maxLon, maxLat].every(Number.isFinite)) return;
    const cx = (minLon + maxLon) / 2, cy = (minLat + maxLat) / 2;
    let z = this.maxZoom;
    for (; z > this.minZoom; z -= 0.25) {
      const w = lonToX(maxLon, z) - lonToX(minLon, z);
      const h = latToY(minLat, z) - latToY(maxLat, z);
      if (w <= this.w - pad * 2 && h <= this.h - pad * 2) break;
    }
    this.setView(cx, cy, z);
  }

  /** Metres represented by one CSS pixel at the map centre. */
  metersPerPixel() {
    const lat = (this.center[1] * Math.PI) / 180;
    return (156543.03392 * Math.cos(lat)) / 2 ** this.zoom;
  }

  /** Zoom so that *meters* span *pixels* at the current centre. */
  zoomForRange(meters, pixels) {
    const lat = (this.center[1] * Math.PI) / 180;
    return Math.log2((156543.03392 * Math.cos(lat) * pixels) / meters);
  }

  project(lon, lat) {
    const z = this.zoom;
    let dx = lonToX(lon, z) - lonToX(this.center[0], z);
    const dy = latToY(lat, z) - latToY(this.center[1], z);
    // Wrap across the antimeridian.
    const world = TILE * 2 ** z;
    if (dx > world / 2) dx -= world; else if (dx < -world / 2) dx += world;
    if (!this.rotation) return [this.w / 2 + dx, this.h / 2 + dy];
    const a = (-this.rotation * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    return [this.w / 2 + dx * c - dy * s, this.h / 2 + dx * s + dy * c];
  }

  unproject(px, py) {
    let dx = px - this.w / 2, dy = py - this.h / 2;
    if (this.rotation) {
      const a = (this.rotation * Math.PI) / 180;
      const c = Math.cos(a), s = Math.sin(a);
      [dx, dy] = [dx * c - dy * s, dx * s + dy * c];
    }
    const z = this.zoom;
    return [xToLon(lonToX(this.center[0], z) + dx, z), yToLat(latToY(this.center[1], z) + dy, z)];
  }

  /** Screen angle (radians, canvas convention) for a true bearing. */
  screenAngle(bearingDeg) {
    return ((bearingDeg - this.rotation - 90) * Math.PI) / 180;
  }

  // -- interaction -----------------------------------------------------------

  _bindEvents() {
    const c = this.canvas;
    c.addEventListener("wheel", (e) => {
      if (!this.interactive) return;
      e.preventDefault();
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const before = this.unproject(px, py);
      const factor = e.deltaMode === 1 ? 0.25 : 0.0022;
      this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom - e.deltaY * factor));
      const after = this.unproject(px, py);
      this.center = [this.center[0] + before[0] - after[0], this.center[1] + before[1] - after[1]];
      this.emit("viewchange", { user: true });
      this.invalidate();
    }, { passive: false });

    c.addEventListener("pointerdown", (e) => {
      if (!this.interactive) return;
      c.setPointerCapture(e.pointerId);
      this._drag = { x: e.clientX, y: e.clientY, moved: false, center: [...this.center] };
    });
    c.addEventListener("pointermove", (e) => {
      const r = c.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      if (this._drag) {
        const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this._drag.moved = true;
        if (this._drag.moved) {
          // Re-centre on the point that sat under the screen centre when
          // the drag began, shifted by the drag distance.
          this.center = this._drag.center;
          this.center = this.unproject(this.w / 2 - dx, this.h / 2 - dy);
          this.emit("viewchange", { user: true });
          this.invalidate();
        }
      }
      this.emit("hover", { px, py, lonlat: this.unproject(px, py) });
    });
    const end = (e) => {
      if (!this._drag) return;
      const r = c.getBoundingClientRect();
      if (!this._drag.moved) {
        const px = e.clientX - r.left, py = e.clientY - r.top;
        this.emit("click", { px, py, lonlat: this.unproject(px, py) });
      }
      this._drag = null;
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => { this._drag = null; });
    c.addEventListener("pointerleave", () => this.emit("hover", null));
  }

  // -- rendering -------------------------------------------------------------

  _draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0b0f14";
    ctx.fillRect(0, 0, this.w, this.h);
    const layer = LAYERS[this.layer];
    if (layer.url && this.failedTiles < 24) this._drawTiles(layer);
    if (!layer.url || this.failedTiles >= 24) this._drawGrid();
    if (layer.dim) {
      ctx.fillStyle = `rgba(8,11,16,${layer.dim})`;
      ctx.fillRect(0, 0, this.w, this.h);
    }
    if (this.scene) {
      ctx.save();
      this.scene(ctx, this);
      ctx.restore();
    }
    this._drawScale();
    if (layer.attribution && this.failedTiles < 24) {
      ctx.font = "10px system-ui, sans-serif";
      ctx.fillStyle = "rgba(200,205,214,0.55)";
      ctx.textAlign = "right";
      ctx.fillText(layer.attribution, this.w - 6, this.h - 6);
    }
  }

  _drawTiles(layer) {
    const ctx = this.ctx;
    const zi = Math.max(0, Math.min(layer.maxZoom, Math.round(this.zoom)));
    const scale = 2 ** (this.zoom - zi);
    const cx = lonToX(this.center[0], zi), cy = latToY(this.center[1], zi);
    const radius = Math.hypot(this.w, this.h) / 2 / scale + TILE;
    const n = 2 ** zi;
    const x0 = Math.floor((cx - radius) / TILE), x1 = Math.floor((cx + radius) / TILE);
    const y0 = Math.max(0, Math.floor((cy - radius) / TILE)), y1 = Math.min(n - 1, Math.floor((cy + radius) / TILE));

    ctx.save();
    ctx.translate(this.w / 2, this.h / 2);
    ctx.rotate((-this.rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.imageSmoothingEnabled = true;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const wx = ((tx % n) + n) % n;
        const img = this._tile(layer, zi, wx, ty);
        const dx = tx * TILE - cx, dy = ty * TILE - cy;
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, dx, dy, TILE + 0.5, TILE + 0.5);
        } else {
          // Parent tile as a placeholder while this one loads.
          const pz = zi - 1;
          if (pz >= 0) {
            const parent = this.tiles.get(`${this.layer}/${pz}/${wx >> 1}/${ty >> 1}`);
            if (parent && parent.complete && parent.naturalWidth) {
              const sx = (wx & 1) * 128, sy = (ty & 1) * 128;
              ctx.drawImage(parent, sx, sy, 128, 128, dx, dy, TILE + 0.5, TILE + 0.5);
            }
          }
        }
      }
    }
    ctx.restore();
  }

  _tile(layer, z, x, y) {
    const key = `${this.layer}/${z}/${x}/${y}`;
    let img = this.tiles.get(key);
    if (!img) {
      img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => this.invalidate();
      img.onerror = () => { this.failedTiles += 1; this.invalidate(); };
      img.src = layer.url(z, x, y);
      this.tiles.set(key, img);
      if (this.tiles.size > 600) {
        const first = this.tiles.keys().next().value;
        this.tiles.delete(first);
      }
    }
    return img;
  }

  _drawGrid() {
    const ctx = this.ctx;
    const mpp = this.metersPerPixel();
    const spanDeg = (mpp * Math.max(this.w, this.h)) / 111320;
    const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
    const step = steps.find((s) => spanDeg / s < 14) || 10;
    const tl = this.unproject(0, 0), br = this.unproject(this.w, this.h);
    const tr = this.unproject(this.w, 0), bl = this.unproject(0, this.h);
    const lons = [tl[0], br[0], tr[0], bl[0]], lats = [tl[1], br[1], tr[1], bl[1]];
    const minLon = Math.floor(Math.min(...lons) / step) * step, maxLon = Math.max(...lons);
    const minLat = Math.floor(Math.min(...lats) / step) * step, maxLat = Math.max(...lats);
    ctx.strokeStyle = "rgba(120,140,160,0.14)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(160,175,190,0.4)";
    ctx.font = "10px ui-monospace, monospace";
    for (let lon = minLon; lon <= maxLon; lon += step) {
      const a = this.project(lon, minLat), b = this.project(lon, maxLat);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
    }
    for (let lat = minLat; lat <= maxLat; lat += step) {
      const a = this.project(minLon, lat), b = this.project(maxLon, lat);
      ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke();
      const p = this.project(this.center[0], lat);
      ctx.fillText(`${lat.toFixed(step < 1 ? 2 : 0)}°`, 6, p[1] - 3);
    }
  }

  _drawScale() {
    const ctx = this.ctx;
    const mpp = this.metersPerPixel();
    const metric = (localStorage.getItem("dcs-sa.units") || "imperial") === "metric";
    const unit = metric ? 1000 : 1852;
    const target = mpp * 120 / unit;
    const nice = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 500].find((v) => v >= target * 0.6) || 500;
    const px = (nice * unit) / mpp;
    const x = 12, y = this.h - 16;
    ctx.strokeStyle = "rgba(220,225,232,0.8)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5);
    ctx.stroke();
    ctx.fillStyle = "rgba(220,225,232,0.85)";
    ctx.font = "11px ui-monospace, monospace";
    ctx.textAlign = "left";
    ctx.fillText(`${nice} ${metric ? "km" : "nm"}`, x + px + 6, y);
  }
}
