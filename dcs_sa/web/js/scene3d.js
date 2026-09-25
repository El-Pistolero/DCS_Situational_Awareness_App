// 3D tactical view: satellite-draped terrain, aircraft with full attitude,
// weapons with smoke trails, SAM envelopes, orbit and chase cameras.

import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { fmtDist, isNum, sideColor, slantRange, units, M_TO_FT, MPS_TO_KT } from "./util.js";
import { buildF16, isF16 } from "./f16.js";
import { radarVolume } from "./symbols.js";

const R_LAT = 111320;
const D2R = Math.PI / 180;
const COARSE_Z = 10;   // ~30 km tiles around the area
const DETAIL_Z = 11;   // ~15 km tiles next to the focus aircraft
const COARSE_RADIUS = 3;
const MESH_SEGS = 40;

const lon2x = (lon, z) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat, z) => {
  const r = lat * D2R;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x, z) => (x / 2 ** z) * 360 - 180;
const y2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) / D2R;

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// DCS surface types (land.SurfaceType): colour when there is no imagery, and
// a multiplier over the satellite imagery so game water/roads/runways show.
const SURF_BASE = { 1: null, 2: [0.36, 0.55, 0.62], 3: [0.13, 0.27, 0.42], 4: [0.46, 0.46, 0.44], 5: [0.24, 0.24, 0.26] };
const SURF_TINT = { 1: [1, 1, 1], 2: [0.8, 0.95, 1.05], 3: [0.55, 0.75, 1.0], 4: [0.9, 0.9, 0.9], 5: [0.55, 0.55, 0.6] };

function landColour(h) {
  // Lowland green -> upland brown -> rock -> snow.
  const stops = [[0, [0.30, 0.40, 0.24]], [400, [0.36, 0.42, 0.25]], [1200, [0.45, 0.40, 0.30]], [2400, [0.52, 0.50, 0.48]], [3400, [0.92, 0.93, 0.95]]];
  for (let i = 1; i < stops.length; i++) {
    if (h <= stops[i][0]) {
      const [h0, c0] = stops[i - 1], [h1, c1] = stops[i];
      const f = Math.max(0, (h - h0) / (h1 - h0));
      return c0.map((c, k) => c + (c1[k] - c) * f);
    }
  }
  return stops[stops.length - 1][1];
}

async function fetchDcsTile(z, x, y) {
  try {
    const res = await fetch(`/tiles/dcs/${z}/${x}/${y}`);
    if (res.status === 200) return { tile: await res.json() };
    if (res.status === 202) return { pending: true };
  } catch { /* app unreachable */ }
  return {};
}

/** Tiny priority queue so near tiles load before far ones. */
class Loader {
  constructor(concurrency = 6) { this.q = []; this.active = 0; this.max = concurrency; }
  push(prio, fn) { this.q.push({ prio, fn }); this.q.sort((a, b) => a.prio - b.prio); this.pump(); }
  clear() { this.q.length = 0; }
  pump() {
    while (this.active < this.max && this.q.length) {
      const { fn } = this.q.shift();
      this.active++;
      Promise.resolve().then(fn).catch(() => {}).finally(() => { this.active--; this.pump(); });
    }
  }
}

// ---------------------------------------------------------------------------
// Aircraft / weapon models
// ---------------------------------------------------------------------------

function jetGeometry() {
  // Built pointing north (-Z), wings along X, ~15 m long.
  const g = new THREE.BufferGeometry();
  const v = [];
  const tri = (a, b, c) => v.push(...a, ...b, ...c);
  const quad = (a, b, c, d) => { tri(a, b, c); tri(a, c, d); };
  const nose = [0, 0, -8], tail = [0, 0, 7];
  const w = 0.9, h = 0.8;
  const fus = [[w, 0, -3], [0, h, -3], [-w, 0, -3], [0, -h * 0.8, -3]];
  const fusT = fus.map(([x, y]) => [x * 0.7, y * 0.7, 7]);
  for (let i = 0; i < 4; i++) {
    const a = fus[i], b = fus[(i + 1) % 4];
    tri(nose, b, a);
    quad(a, b, fusT[(i + 1) % 4], fusT[i]);
  }
  tri(fusT[0], fusT[1], tail); tri(fusT[1], fusT[2], tail); tri(fusT[2], fusT[3], tail); tri(fusT[3], fusT[0], tail);
  // Wings (double-sided via material).
  quad([0.8, 0, -2.5], [5.2, 0, 3.2], [5.2, 0, 4.3], [0.8, 0, 3.8]);
  quad([-0.8, 0, -2.5], [-0.8, 0, 3.8], [-5.2, 0, 4.3], [-5.2, 0, 3.2]);
  // Stabilisers and fin.
  quad([0.6, 0, 5], [2.8, 0, 6.8], [2.8, 0, 7.4], [0.6, 0, 7.2]);
  quad([-0.6, 0, 5], [-0.6, 0, 7.2], [-2.8, 0, 7.4], [-2.8, 0, 6.8]);
  quad([0, 0.6, 3.6], [0, 3.8, 6.6], [0, 3.8, 7.3], [0, 0.6, 7.2]);
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

function heliGeometry() {
  const g = new THREE.CapsuleGeometry(1.4, 7, 4, 8);
  g.rotateX(Math.PI / 2);
  return g;
}

const GEOM = {
  jet: jetGeometry(),
  heli: heliGeometry(),
  missile: new THREE.CylinderGeometry(0.25, 0.25, 4, 6).rotateX(Math.PI / 2),
  ground: new THREE.BoxGeometry(7, 3, 10),
  sam: new THREE.CylinderGeometry(3, 4, 4, 8),
  ship: new THREE.BoxGeometry(16, 10, 110),
  carrier: new THREE.BoxGeometry(70, 20, 330),
};

// ---------------------------------------------------------------------------
// Radar volumes
// ---------------------------------------------------------------------------

const radarGeomCache = new Map();

/** Unit-radius search volume (spherical sector) centred on -Z, plus its outline. */
function radarGeometry(azDeg, elDeg) {
  const key = `${azDeg}/${elDeg}`;
  let g = radarGeomCache.get(key);
  if (g) return g;
  const az = Math.min(azDeg, 180) * D2R, el = elDeg * D2R;
  const full = azDeg >= 180;
  const fill = new THREE.SphereGeometry(1, full ? 64 : 32, 6, 1.5 * Math.PI - az, 2 * az, Math.PI / 2 - el, 2 * el);
  // Outline: far-surface rims at the top and bottom of the volume, plus the
  // four radial edges for a sector.
  const pts = [];
  const dir = (a, e) => new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
  const steps = full ? 72 : 24;
  for (const e of [-el, el]) {
    for (let i = 0; i < steps; i++) {
      const a0 = -az + (2 * az * i) / steps, a1 = -az + (2 * az * (i + 1)) / steps;
      pts.push(dir(a0, e), dir(a1, e));
    }
  }
  if (!full) {
    for (const a of [-az, az]) {
      for (const e of [-el, el]) pts.push(new THREE.Vector3(0, 0, 0), dir(a, e));
      pts.push(dir(a, -el), dir(a, el));
    }
  }
  const edges = new THREE.BufferGeometry().setFromPoints(pts);
  g = { fill, edges };
  radarGeomCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = "scene3d";
    // Insert underneath any toolbars / HUDs already in the container.
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "labels3d";
    this.terrainHud = document.createElement("div");
    this.terrainHud.className = "terrain-hud";
    container.prepend(this.renderer.domElement, this.labelLayer, this.terrainHud);
    this.terrainSources = { dcs: 0, online: 0 };
    this.runwayGroup = new THREE.Group();
    this.airbasesFor = null;
    this.radars = new Map();

    this.scene = new THREE.Scene();
    const sky = new THREE.Color(0x8fa9c4);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 90000, 260000);
    this.camera = new THREE.PerspectiveCamera(55, 1, 2, 800000);
    this.camera.position.set(0, 20000, 30000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 20;
    this.controls.maxDistance = 400000;

    this.scene.add(new THREE.HemisphereLight(0xdfeaff, 0x3a3326, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.6, 1, 0.4);
    this.scene.add(sun);

    // Fallback ground so there is always something under the aircraft.
    const base = new THREE.Mesh(new THREE.PlaneGeometry(2e6, 2e6).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x3d4a3f }));
    base.position.y = -2;
    this.scene.add(base);
    this.grid = new THREE.GridHelper(400000, 80, 0x60707a, 0x4b5860);
    this.grid.position.y = -1;
    this.scene.add(this.grid);
    this._initRounds();

    this.origin = null;
    this.exaggeration = 1;
    this.tiles = new Map(); // key -> {mesh, z, x, y}
    this.loader = new Loader(6);
    this.objects = new Map(); // id -> {group, model, trail, label}
    this.mode = "orbit";
    this.follow = true;
    this.focusId = null;
    this.lastFocusPos = null;
    this.visible = false;
    this.onPick = null;
    this.tileCenter = null;
    this._pickables = [];
    this._bindPick();
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    const loop = () => {
      if (this.visible) this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  setVisible(v) {
    this.visible = v;
    this.renderer.domElement.style.display = v ? "block" : "none";
    this.labelLayer.style.display = v ? "block" : "none";
    this.terrainHud.style.display = v ? "block" : "none";
    if (v) this.resize();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.renderer.setSize(r.width, r.height, false);
    this.renderer.domElement.style.width = `${r.width}px`;
    this.renderer.domElement.style.height = `${r.height}px`;
    this.camera.aspect = r.width / r.height;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode) {
    this.mode = mode;
    this.controls.enabled = mode === "orbit";
    if (mode === "orbit" && this.lastFocusPos) {
      this.controls.target.copy(this.lastFocusPos);
      this.camera.position.copy(this.lastFocusPos).add(new THREE.Vector3(0, 3000, 6000));
    }
  }

  setExaggeration(x) {
    this.exaggeration = x;
    for (const t of this.tiles.values()) t.mesh.scale.y = x;
  }

  // -- coordinates ------------------------------------------------------------

  toLocal(lon, lat, alt = 0) {
    const [lon0, lat0] = this.origin;
    const x = (lon - lon0) * R_LAT * Math.cos(lat0 * D2R);
    const z = -(lat - lat0) * R_LAT;
    return new THREE.Vector3(x, (alt || 0) * this.exaggeration, z);
  }

  _ensureOrigin(lon, lat) {
    if (this.origin) {
      const dx = (lon - this.origin[0]) * R_LAT * Math.cos(lat * D2R);
      const dz = (lat - this.origin[1]) * R_LAT;
      if (Math.hypot(dx, dz) < 400000) return;
    }
    this.origin = [lon, lat];
    for (const t of this.tiles.values()) this._disposeTile(t);
    this.tiles.clear();
    this.loader.clear();
    this.tileCenter = null;
    const p = this.toLocal(lon, lat, 0);
    this.controls.target.copy(p);
    this.terrainSources = { dcs: 0, online: 0 };
    this._loadAirbases(lon, lat);
  }

  // -- DCS airbases ------------------------------------------------------------

  async _loadAirbases(lon, lat) {
    this.scene.remove(this.runwayGroup);
    for (const a of this.airbaseLabels || []) a.el.remove();
    this.airbaseLabels = [];
    this.runwayGroup = new THREE.Group();
    this.scene.add(this.runwayGroup);
    let data;
    try { data = await (await fetch(`/api/dcsmap?lon=${lon}&lat=${lat}`)).json(); } catch { return; }
    this.dcsStatus = data;
    this._hud();
    const asphalt = new THREE.MeshLambertMaterial({ color: 0x2c2d31, polygonOffset: true, polygonOffsetFactor: -4 });
    const paint = new THREE.LineBasicMaterial({ color: 0xf2f2f2, transparent: true, opacity: 0.8 });
    for (const ab of data.airbaseList || []) {
      if (!this.origin) return;
      for (const rw of ab.runways || []) {
        if (!isNum(rw.lat) || !isNum(rw.length) || !isNum(rw.heading) || rw.length < 50) continue;
        const c = this.toLocal(rw.lon, rw.lat, 0);
        const y = (isNum(ab.alt) ? ab.alt : 0) + 1.5;
        const strip = new THREE.Mesh(new THREE.BoxGeometry(Math.max(rw.width || 45, 20), 1.5, rw.length), asphalt);
        strip.position.set(c.x, y * this.exaggeration, c.z);
        strip.rotation.y = -rw.heading * D2R;
        this.runwayGroup.add(strip);
        const half = rw.length / 2 - 60;
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 1, -half), new THREE.Vector3(0, 1, half)]), paint);
        line.position.copy(strip.position);
        line.rotation.y = strip.rotation.y;
        this.runwayGroup.add(line);
      }
      if (ab.category === 0 && (ab.runways || []).length) {
        const lbl = document.createElement("div");
        lbl.className = "lbl3d airbase";
        lbl.textContent = ab.name;
        this.labelLayer.append(lbl);
        (this.airbaseLabels ||= []).push({ el: lbl, pos: this.toLocal(ab.lon, ab.lat, (ab.alt || 0) + 30) });
      }
    }
  }

  _hud() {
    const s = this.terrainSources, st = this.dcsStatus;
    let txt;
    if (s.dcs && !s.online) txt = `Terrain: DCS World${st?.theatre ? ` (${st.theatre})` : ""}`;
    else if (s.dcs) txt = `Terrain: DCS World + online elevation${st?.connected ? " (sampling DCS…)" : ""}`;
    else if (st?.connected) txt = "Terrain: sampling DCS World…";
    else txt = "Terrain: online elevation · run a mission with the DCS-SA hook to use the game's own map";
    this.terrainHud.textContent = txt;
  }

  // -- terrain -------------------------------------------------------------------

  _updateTerrain(lon, lat) {
    const cx = Math.floor(lon2x(lon, COARSE_Z)), cy = Math.floor(lat2y(lat, COARSE_Z));
    const key = `${cx}/${cy}`;
    if (this.tileCenter === key) return;
    this.tileCenter = key;
    const wanted = new Set();
    for (let dy = -COARSE_RADIUS; dy <= COARSE_RADIUS; dy++) {
      for (let dx = -COARSE_RADIUS; dx <= COARSE_RADIUS; dx++) {
        const x = cx + dx, y = cy + dy;
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        if (dist <= 1) {
          for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) wanted.add(`${DETAIL_Z}/${x * 2 + ox}/${y * 2 + oy}/${dist}`);
        } else {
          wanted.add(`${COARSE_Z}/${x}/${y}/${dist}`);
        }
      }
    }
    const wantedKeys = new Set([...wanted].map((k) => k.split("/").slice(0, 3).join("/")));
    for (const [k, t] of this.tiles) {
      if (!wantedKeys.has(k)) {
        this._disposeTile(t);
        this.tiles.delete(k);
      }
    }
    this.loader.clear();
    for (const w of wanted) {
      const [z, x, y, dist] = w.split("/").map(Number);
      const k = `${z}/${x}/${y}`;
      if (this.tiles.has(k)) continue;
      this.tiles.set(k, { pending: true, mesh: null });
      this.loader.push(dist, () => this._buildTile(z, x, y));
    }
  }

  _rebuildTile(z, x, y, retries) {
    const k = `${z}/${x}/${y}`;
    const old = this.tiles.get(k);
    if (!old) return;
    const entry = { pending: true, mesh: null, retries };
    this.tiles.set(k, entry);
    this._buildTile(z, x, y).then(() => {
      if (old.mesh) { this._disposeTile(old); if (old.source) this.terrainSources[old.source] -= 1; this._hud(); }
    });
  }

  _disposeTile(t) {
    if (!t.mesh) return; // still loading; _buildTile notices it was dropped
    this.scene.remove(t.mesh);
    t.mesh.geometry.dispose();
    t.mesh.material.map?.dispose();
    t.mesh.material.dispose();
  }

  async _buildTile(z, x, y) {
    const k = `${z}/${x}/${y}`;
    const entry = this.tiles.get(k);
    if (!entry) return;
    const n = MESH_SEGS;
    const dcs = await fetchDcsTile(z, x, y);
    if (this.tiles.get(k) !== entry) return;
    let heights = null, surface = null, source = "online";
    if (dcs.tile && dcs.tile.n === n + 1) {
      heights = Float32Array.from(dcs.tile.h, (v) => Math.max(0, v));
      surface = dcs.tile.s;
      source = "dcs";
    } else if (dcs.pending && (entry.retries || 0) < 10) {
      // DCS is sampling this tile; show online data now, upgrade when it lands.
      entry.retries = (entry.retries || 0) + 1;
      setTimeout(() => {
        const cur = this.tiles.get(k);
        if (cur === entry || cur?.source === "online") this._rebuildTile(z, x, y, entry.retries);
      }, 2500);
    }
    const elev = heights ? null : await loadImage(`/tiles/elev/${z}/${x}/${y}.png`);
    if (elev) {
      const c = document.createElement("canvas");
      c.width = c.height = 256;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(elev, 0, 0);
      const d = ctx.getImageData(0, 0, 256, 256).data;
      heights = new Float32Array(256 * 256);
      for (let i = 0; i < heights.length; i++) {
        const h = d[i * 4] * 256 + d[i * 4 + 1] + d[i * 4 + 2] / 256 - 32768;
        heights[i] = Math.max(0, h); // sea surface, not bathymetry
      }
    }
    if (this.tiles.get(k) !== entry || !this.origin) return;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const uv = new Float32Array((n + 1) * (n + 1) * 2);
    let p = 0, q = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const fx = i / n, fy = j / n;
        const lon = x2lon(x + fx, z), lat = y2lat(y + fy, z);
        let h = 0;
        if (source === "dcs") {
          h = heights[j * (n + 1) + i];
        } else if (heights) {
          const px = Math.min(255, Math.round(fx * 255)), py = Math.min(255, Math.round(fy * 255));
          h = heights[py * 256 + px];
        }
        const v = this.toLocal(lon, lat, 0);
        pos[p++] = v.x; pos[p++] = h; pos[p++] = v.z;
        uv[q++] = fx; uv[q++] = 1 - fy;
      }
    }
    const idx = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    // Vertex colours: terrain palette until imagery arrives, then a tint that
    // keeps DCS water / roads / runways visible over the photo.
    const base = new Float32Array((n + 1) * (n + 1) * 3), tint = new Float32Array(base.length);
    for (let v = 0; v < (n + 1) * (n + 1); v++) {
      const st = surface ? +surface[v] : 1;
      const c = SURF_BASE[st] || landColour(pos[v * 3 + 1]);
      const t = SURF_TINT[st] || SURF_TINT[1];
      base.set(c, v * 3); tint.set(t, v * 3);
    }
    g.setAttribute("color", new THREE.BufferAttribute(base, 3));
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true });
    const mesh = new THREE.Mesh(g, mat);
    mesh.scale.y = this.exaggeration;
    if (this.tiles.get(k) !== entry) { g.dispose(); mat.dispose(); return; }
    this.scene.add(mesh);
    entry.mesh = mesh;
    entry.pending = false;
    entry.source = source;
    this.terrainSources[source] += 1;
    this._hud();
    if (heights || elev) this.grid.visible = false;

    // Satellite imagery two zoom levels finer, composited progressively.
    const sub = 4, size = 256 * sub, iz = z + 2;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d");
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    let applied = false;
    const jobs = [];
    for (let sy = 0; sy < sub; sy++) {
      for (let sx = 0; sx < sub; sx++) {
        jobs.push(loadImage(`/tiles/sat/${iz}/${x * sub + sx}/${y * sub + sy}.jpg`).then((img) => {
          if (!img || !this.tiles.has(k)) return;
          ctx.drawImage(img, sx * 256, sy * 256);
          tex.needsUpdate = true;
          if (!applied) {
            g.setAttribute("color", new THREE.BufferAttribute(tint, 3));
            mat.map = tex; mat.needsUpdate = true; applied = true;
          }
        }));
      }
    }
    await Promise.all(jobs);
  }

  // -- objects ---------------------------------------------------------------------

  _entry(o) {
    let e = this.objects.get(o.id);
    if (e) return e;
    const color = new THREE.Color(sideColor(o));
    const group = new THREE.Group();
    let geom = GEOM.ground;
    const type = o.type || "";
    if (o.category === "fixedwing" || o.category === "air") geom = GEOM.jet;
    else if (o.category === "rotorcraft") geom = GEOM.heli;
    else if (o.category === "weapon") geom = GEOM.missile;
    else if (type.includes("AircraftCarrier")) geom = GEOM.carrier;
    else if (o.category === "sea") geom = GEOM.ship;
    else if (type.includes("AntiAircraft")) geom = GEOM.sam;
    let model, mat;
    if (["fixedwing", "air"].includes(o.category) && isF16(o.name)) {
      model = buildF16(color);
      mat = model.userData.bodyMaterial;
      e = { f16: true };
    } else {
      mat = new THREE.MeshLambertMaterial({
        color: o.category === "weapon" ? 0xf2f2f2 : color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide,
      });
      model = new THREE.Mesh(geom, mat);
    }
    model.traverse((m) => { if (m.isMesh) { m.userData.id = o.id; this._pickables.push(m); } });
    group.add(model);
    this.scene.add(group);

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 1200), 3));
    trailGeo.setDrawRange(0, 0);
    const weapon = o.category === "weapon";
    if (!weapon) trailGeo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * 1200), 3));
    // Aircraft trails carry per-vertex colour (side colour, or the trail-colour ramp).
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
      color: weapon ? 0xe8e8e8 : 0xffffff, vertexColors: !weapon, transparent: true, opacity: weapon ? 0.85 : 0.8,
    }));
    trail.frustumCulled = false;
    this.scene.add(trail);

    let dome = null;
    const eng = o.v?.EngagementRange;
    if (isNum(eng) && eng > 0) {
      dome = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 12, 0, Math.PI * 2, 0, Math.PI / 2),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide }));
      // Just the ground ring and a few meridians, so the envelope reads without clutter.
      const ring = [];
      for (let i = 0; i <= 96; i++) { const a = (i / 96) * Math.PI * 2; ring.push(Math.cos(a), 0.002, Math.sin(a)); }
      dome.add(new THREE.Line(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(ring, 3)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 })));
      for (let m = 0; m < 4; m++) {
        const arc = [];
        for (let i = 0; i <= 24; i++) { const t = (i / 24) * Math.PI; arc.push(Math.cos(t) * Math.cos(m * Math.PI / 4), Math.sin(t), Math.cos(t) * Math.sin(m * Math.PI / 4)); }
        dome.add(new THREE.Line(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute(arc, 3)),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.18 })));
      }
      this.scene.add(dome);
    }
    const label = document.createElement("div");
    label.className = "lbl3d";
    this.labelLayer.append(label);
    e = { ...(e || {}), group, model, mat, trail, dome, label, color: sideColor(o),
      baseColor: mat.color.clone(), baseEmissive: mat.emissiveIntensity };
    this.objects.set(o.id, e);
    return e;
  }

  _remove(id) {
    const e = this.objects.get(id);
    if (!e) return;
    this.scene.remove(e.group, e.trail);
    if (e.dome) this.scene.remove(e.dome);
    e.trail.geometry.dispose();
    e.model.traverse((m) => {
      if (!m.isMesh) return;
      if (m.geometry && !Object.values(GEOM).includes(m.geometry)) m.geometry.dispose();
      m.material.dispose();
    });
    e.label.remove();
    this._pickables = this._pickables.filter((m) => m.userData.id !== id);
    const rd = this.radars.get(id);
    if (rd) { this.scene.remove(rd.outer); rd.mats.forEach((m) => m.dispose()); this.radars.delete(id); }
    this.objects.delete(id);
  }

  /**
   * objects: [{id, category, type, lon, lat, alt, hdg, pitch, roll, trail, name, pilot,
   *            coalition, color, dead, lock, v:{EngagementRange}}]
   */
  update(objects, { focusId = null, selectedId = null, radar = "all", rounds = [], padlockId = null } = {}) {
    const focus = objects.find((o) => o.id === focusId) || objects.find((o) => o.id === selectedId) ||
      objects.find((o) => ["fixedwing", "rotorcraft"].includes(o.category)) || objects[0];
    if (!focus) return;
    this._ensureOrigin(focus.lon, focus.lat);
    this._updateTerrain(focus.lon, focus.lat);
    this.focusId = focus.id;
    this.selectedId = selectedId;

    const seen = new Set();
    for (const o of objects) {
      if (!isNum(o.lon) || !isNum(o.lat) || o.category === "bullseye" || o.category === "countermeasure") continue;
      seen.add(o.id);
      const e = this._entry(o);
      const p = this.toLocal(o.lon, o.lat, o.alt);
      e.group.position.copy(p);
      e.group.rotation.set(
        isNum(o.pitch) ? o.pitch * D2R : 0,
        -(isNum(o.hdg) ? o.hdg : 0) * D2R,
        -(isNum(o.roll) ? o.roll : 0) * D2R,
        "YXZ",
      );
      if (o.dead) e.mat.color.set(0x555555); else e.mat.color.copy(e.baseColor);
      const hi = o.id === focus.id || o.id === selectedId;
      e.mat.emissiveIntensity = e.f16 ? (hi ? 0.4 : e.baseEmissive) : (hi ? 0.8 : 0.35);
      e.pos = p;
      e.obj = o;
      if (e.dome) {
        const r = o.v.EngagementRange;
        e.dome.position.set(p.x, 0, p.z);
        e.dome.scale.set(r, (o.v.VerticalEngagementRange || r) * this.exaggeration, r);
      }
      // Trail
      const tr = o.trail || [];
      const arr = e.trail.geometry.attributes.position.array;
      const colAttr = e.trail.geometry.attributes.color;
      const col = colAttr?.array;
      const tc = o.trailColors && o.trailColors.length === tr.length ? o.trailColors : null;
      const base = e.baseColor;
      const start = Math.max(0, tr.length - 400);
      let k = 0;
      for (let i = start; i < tr.length; i++) {
        const v = this.toLocal(tr[i][0], tr[i][1], tr[i][2]);
        if (col) {
          const c = tc?.[i];
          col[k] = c ? c[0] : base.r; col[k + 1] = c ? c[1] : base.g; col[k + 2] = c ? c[2] : base.b;
        }
        arr[k++] = v.x; arr[k++] = v.y; arr[k++] = v.z;
      }
      if (col) {
        const c = tc?.[tc.length - 1];
        col[k] = c ? c[0] : base.r; col[k + 1] = c ? c[1] : base.g; col[k + 2] = c ? c[2] : base.b;
        colAttr.needsUpdate = true;
      }
      arr[k++] = p.x; arr[k++] = p.y; arr[k++] = p.z;
      e.trail.geometry.setDrawRange(0, k / 3);
      e.trail.geometry.attributes.position.needsUpdate = true;
    }
    for (const id of [...this.objects.keys()]) if (!seen.has(id)) this._remove(id);
    this._updateRadars(objects, radar, focus.id, selectedId);
    this._updateRounds(rounds);

    // Lock lines.
    if (!this.lockLines) {
      this.lockLines = new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 400, gapSize: 300, transparent: true, opacity: 0.8 }));
      this.lockLines.frustumCulled = false;
      this.scene.add(this.lockLines);
    }
    const lp = [];
    for (const o of objects) {
      if (!o.lock) continue;
      const a = this.objects.get(o.id), b = this.objects.get(o.lock);
      if (a?.pos && b?.pos) lp.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z);
    }
    this.lockLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    this.lockLines.computeLineDistances();

    // Camera follow.
    const fp = this.objects.get(focus.id)?.pos;
    if (fp) {
      if (this.mode === "orbit" && this.follow && this.lastFocusPos) {
        const delta = fp.clone().sub(this.lastFocusPos);
        this.camera.position.add(delta);
        this.controls.target.add(delta);
      } else if (this.mode === "orbit" && !this.lastFocusPos) {
        this.controls.target.copy(fp);
        this.camera.position.copy(fp).add(new THREE.Vector3(-4000, 2500, 6000));
      }
      const target = this.mode === "padlock" && padlockId && padlockId !== focus.id ? this.objects.get(padlockId) : null;
      this._padTarget = target?.pos ? { from: focus, to: target.obj } : null;
      if (this._padTarget) {
        // Padlock: behind the jet on the line of sight, looking a third of
        // the way to the target, so both stay in frame.
        const tp = target.pos;
        const dir = tp.clone().sub(fp).normalize();
        const slant = slantRange(focus.lon, focus.lat, focus.alt, target.obj.lon, target.obj.lat, target.obj.alt);
        const back = slant < 1000 ? 120 : 60;
        const want = fp.clone().sub(dir.clone().multiplyScalar(back)).add(new THREE.Vector3(0, back * 0.3, 0));
        const now = performance.now();
        const dt = this._lastChase ? (now - this._lastChase) / 1000 : 1;
        this._lastChase = now;
        const snap = !this.lastFocusPos || this.camera.position.distanceTo(want) > 600;
        this.camera.position.lerp(want, snap ? 1 : 1 - Math.exp(-dt / 0.08));
        this.camera.lookAt(fp.clone().lerp(tp, 0.3));
        this._updatePadLine(fp, tp, slant);
      } else this._updatePadLine(null);
      if (this.mode === "chase" || (this.mode === "padlock" && !this._padTarget)) {
        const hdg = (focus.hdg || 0) * D2R;
        const back = 42, up = 11; // close enough to see the jet's shape
        const want = fp.clone().add(new THREE.Vector3(Math.sin(hdg) * -back, up, Math.cos(hdg) * back));
        // Time-based smoothing: the same feel at 60 Hz playback and 5 Hz live
        // updates.  Snap after a seek or when first entering chase.
        const now = performance.now();
        const dt = this._lastChase ? (now - this._lastChase) / 1000 : 1;
        this._lastChase = now;
        const snap = !this.lastFocusPos || this.camera.position.distanceTo(want) > 600;
        this.camera.position.lerp(want, snap ? 1 : 1 - Math.exp(-dt / 0.08));
        this.camera.lookAt(fp.clone().add(new THREE.Vector3(Math.sin(hdg) * 40, 3, -Math.cos(hdg) * 40)));
      }
      this.lastFocusPos = fp.clone();
    }
  }

  _updatePadLine(a, b, slant) {
    if (!this.padLine) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(6), 3));
      this.padLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 30, gapSize: 20, transparent: true, opacity: 0.9, depthTest: false }));
      this.padLine.frustumCulled = false;
      this.padLine.renderOrder = 10;
      this.scene.add(this.padLine);
      this.padLabel = document.createElement("div");
      this.padLabel.className = "lbl3d pad";
      this.labelLayer.append(this.padLabel);
    }
    if (!a) { this.padLine.visible = false; this.padLabel.style.display = "none"; this._padMid = null; return; }
    const arr = this.padLine.geometry.attributes.position.array;
    arr.set([a.x, a.y, a.z, b.x, b.y, b.z]);
    this.padLine.geometry.attributes.position.needsUpdate = true;
    this.padLine.computeLineDistances();
    // Dash length scales with range so the line reads as dashed at any distance.
    const d = a.distanceTo(b);
    this.padLine.material.dashSize = Math.max(8, d / 60);
    this.padLine.material.gapSize = Math.max(6, d / 90);
    this.padLine.visible = true;
    this._padMid = a.clone().lerp(b, 0.5);
    this.padLabel.textContent = fmtDist(slant);
  }

  /** Off-screen threat arrows: [{id, color, text}] (positions come from the scene). */
  setPointers(list) {
    this._pointerList = list || [];
    this._ptrPool ||= [];
    while (this._ptrPool.length < this._pointerList.length) {
      const d = document.createElement("div");
      d.className = "ptr3d";
      d.append(document.createElement("i"), document.createElement("span"));
      this.labelLayer.append(d);
      this._ptrPool.push(d);
    }
  }

  _pointers(w, h) {
    const v = new THREE.Vector3();
    const list = this._pointerList || [];
    (this._ptrPool || []).forEach((d, i) => {
      const it = list[i];
      const e = it && this.objects.get(it.id);
      if (!e?.pos) { d.style.display = "none"; return; }
      v.copy(e.pos).project(this.camera);
      let x = v.x, y = v.y;
      const behind = v.z > 1;
      if (behind) { x = -x; y = -y; }
      let k = 1 / Math.hypot(x / 0.92, y / 0.88);
      if (!behind && k >= 1) { d.style.display = "none"; return; } // on screen: its label is enough
      if (!Number.isFinite(k) || Math.hypot(x, y) < 1e-6) { x = 0; y = -0.88; k = 1; }
      if (behind) k = Math.min(k, 1 / Math.hypot(x / 0.92, y / 0.88));
      const X = x * k, Y = y * k;
      const px = ((X + 1) / 2) * w, py = ((1 - Y) / 2) * h;
      d.style.display = "block";
      d.style.color = it.color;
      d.style.transform = `translate(${px}px, ${py}px)`;
      d.firstChild.style.transform = `translate(-50%, -50%) rotate(${Math.atan2(-Y, X)}rad)`;
      const span = d.lastChild;
      if (span.textContent !== it.text) span.textContent = it.text;
      span.style.transform = `translate(${X > 0.3 ? "calc(-100% - 14px)" : X < -0.3 ? "14px" : "-50%"}, ${Y > 0.3 ? "12px" : Y < -0.3 ? "calc(-100% - 12px)" : "-50%"})`;
    });
  }

  // -- radar -------------------------------------------------------------------------

  _updateRadars(objects, mode, focusId, selectedId) {
    const shown = new Set();
    if (mode !== "none") {
      for (const o of objects) {
        if (mode === "focus" && o.id !== focusId && o.id !== selectedId) continue;
        const e = this.objects.get(o.id);
        if (!e?.pos || o.dead) continue;
        const r = radarVolume(o, { assumed: mode !== "known" });
        if (!r) continue;
        shown.add(o.id);
        const guess = r.source === "assumed";
        let rd = this.radars.get(o.id);
        const key = `${r.az}/${r.el}/${guess}`;
        if (!rd || rd.key !== key) {
          if (rd) { this.scene.remove(rd.outer); rd.mats.forEach((m) => m.dispose()); }
          const color = new THREE.Color(e.color);
          const g = radarGeometry(r.az, r.el);
          const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: r.surface ? 0.015 : guess ? 0.03 : 0.07, depthWrite: false, side: THREE.DoubleSide });
          // Assumed volumes get dashed outlines so they never pass for data.
          const edgeMat = guess
            ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, dashSize: 0.025, gapSize: 0.02 })
            : new THREE.LineBasicMaterial({ color, transparent: true, opacity: r.surface ? 0.18 : 0.45, depthWrite: false });
          const outer = new THREE.Group();
          const inner = new THREE.Group();
          const edges = new THREE.LineSegments(g.edges, edgeMat);
          if (guess) edges.computeLineDistances();
          inner.add(new THREE.Mesh(g.fill, fillMat), edges);
          outer.add(inner);
          this.scene.add(outer);
          rd = { key, outer, inner, mats: [fillMat, edgeMat] };
          this.radars.set(o.id, rd);
        }
        const hdg = isNum(o.hdg) ? o.hdg : 0;
        rd.outer.position.copy(e.pos);
        if (r.bodyFrame) {
          // ACMI radar angles are relative to the airframe: aircraft attitude
          // first, then the radar's own azimuth/elevation/roll.
          rd.outer.rotation.set((isNum(o.pitch) ? o.pitch : 0) * D2R, -hdg * D2R, -(isNum(o.roll) ? o.roll : 0) * D2R, "YXZ");
        } else {
          // Search volumes are roll/pitch stabilised: heading only.
          rd.outer.rotation.set(0, -hdg * D2R, 0, "YXZ");
        }
        rd.inner.rotation.set(r.centerEl * D2R, -r.centerAz * D2R, -(r.roll || 0) * D2R, "YXZ");
        rd.outer.scale.setScalar(r.range);
        rd.outer.visible = true;
      }
    }
    for (const [id, rd] of this.radars) if (!shown.has(id)) rd.outer.visible = false;
  }

  // -- gun rounds ----------------------------------------------------------------------

  _initRounds() {
    const mk = (Ctor, mat) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 1024), 3));
      g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * 1024), 3));
      g.setDrawRange(0, 0);
      const obj = new Ctor(g, mat);
      obj.frustumCulled = false;
      obj.renderOrder = 5;
      this.scene.add(obj);
      return obj;
    };
    const additive = { vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false };
    this.roundPaths = mk(THREE.LineSegments, new THREE.LineBasicMaterial({ ...additive, opacity: 0.55 }));
    this.roundHeads = mk(THREE.Points, new THREE.PointsMaterial({ ...additive, size: 5, sizeAttenuation: false }));
    this.roundImpacts = mk(THREE.Points, new THREE.PointsMaterial({ ...additive, size: 7, sizeAttenuation: false }));
  }

  _fill(obj, verts, cols) {
    const g = obj.geometry;
    let pos = g.attributes.position, col = g.attributes.color;
    if (pos.array.length < verts.length) {
      let cap = pos.array.length;
      while (cap < verts.length) cap *= 2;
      pos = new THREE.BufferAttribute(new Float32Array(cap), 3);
      col = new THREE.BufferAttribute(new Float32Array(cap), 3);
      g.setAttribute("position", pos);
      g.setAttribute("color", col);
    }
    pos.array.set(verts);
    col.array.set(cols);
    pos.needsUpdate = true;
    col.needsUpdate = true;
    g.setDrawRange(0, verts.length / 3);
  }

  _updateRounds(rounds) {
    const pv = [], pc = [], hv = [], hc = [], iv = [], ic = [];
    const tracer = [1.0, 0.88, 0.55];
    for (const r of rounds || []) {
      const c = new THREE.Color(sideColor(r));
      // Many overlapping additive paths saturate to white; keep each faint.
      const f = (r.fade ?? 1) * 0.35;
      let prev = null;
      for (const p of r.pts) {
        const v = this.toLocal(p[0], p[1], p[2]);
        if (prev) {
          pv.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
          // Additive blending: darker colour == more transparent, so fading
          // is just scaling the colour.
          pc.push(c.r * f, c.g * f, c.b * f, c.r * f, c.g * f, c.b * f);
        }
        prev = v;
      }
      const h = this.toLocal(r.head[0], r.head[1], r.head[2]);
      if (r.impacted) { iv.push(h.x, h.y, h.z); ic.push(1.0 * f, 0.6 * f, 0.25 * f); }
      else { hv.push(h.x, h.y, h.z); hc.push(...tracer); }
    }
    this._fill(this.roundPaths, pv, pc);
    this._fill(this.roundHeads, hv, hc);
    this._fill(this.roundImpacts, iv, ic);
  }

  // -- render ------------------------------------------------------------------------

  /** Terrain height under a point (local x/z), or null if no tile is there. */
  groundHeight(x, z) {
    // Only test the tile(s) whose footprint contains the point.
    const meshes = [];
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      const g = t.mesh.geometry;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox;
      if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) meshes.push(t.mesh);
    }
    if (!meshes.length) return null;
    this._downRay ||= new THREE.Raycaster();
    this._downRay.set(new THREE.Vector3(x, 20000, z), new THREE.Vector3(0, -1, 0));
    const hit = this._downRay.intersectObjects(meshes, false)[0];
    return hit ? hit.point.y : null;
  }

  render() {
    if (this.mode === "orbit") {
      this.controls.update();
      // Never let the orbit camera sink into the terrain.
      const cam = this.camera.position;
      const g = this.groundHeight(cam.x, cam.z);
      const floor = Math.max(g ?? 0, 0) + 15;
      if (cam.y < floor) cam.y = floor;
    }
    const cam = this.camera.position;
    // Keep models visible at range: never smaller than ~1/150 of the distance.
    for (const e of this.objects.values()) {
      if (!e.pos) continue;
      const d = cam.distanceTo(e.pos);
      const cat = e.obj?.category;
      const div = cat === "weapon" ? 200 : ["fixedwing", "rotorcraft", "air"].includes(cat) ? 260 : 2500;
      const s = Math.min(cat === "sea" ? 6 : 60, Math.max(1, d / div));
      e.model.scale.setScalar((this.mode === "chase" || this.mode === "padlock") && e.obj?.id === this.focusId ? 1 : s);
    }
    this.renderer.render(this.scene, this.camera);
    this._labels();
  }

  _labels() {
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
    for (const a of this.airbaseLabels || []) {
      v.copy(a.pos).project(this.camera);
      const d = this.camera.position.distanceTo(a.pos);
      const show = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && d < 120000;
      a.el.style.display = show ? "block" : "none";
      if (show) a.el.style.transform = `translate(${((v.x + 1) / 2) * w - 20}px, ${((1 - v.y) / 2) * h}px)`;
    }
    for (const e of this.objects.values()) {
      const o = e.obj;
      const air = o && ["fixedwing", "rotorcraft", "air"].includes(o.category);
      if (!o || !e.pos || (!air && o.id !== this.selectedId && o.category !== "weapon")) { e.label.style.display = "none"; continue; }
      v.copy(e.pos).project(this.camera);
      if (v.z > 1 || v.x < -1.1 || v.x > 1.1 || v.y < -1.1 || v.y > 1.1) { e.label.style.display = "none"; continue; }
      e.label.style.display = "block";
      e.label.style.transform = `translate(${((v.x + 1) / 2) * w + 12}px, ${((1 - v.y) / 2) * h - 10}px)`;
      const alt = isNum(o.alt) ? (units.metric ? `${Math.round(o.alt)} m` : `${Math.round((o.alt * M_TO_FT) / 100)}`) : "";
      const spd = isNum(o.ias) ? o.ias : o.tas;
      const text = air ? `${o.pilot || o.name}\n${alt}${isNum(spd) ? ` · ${Math.round(spd * (units.metric ? 3.6 : MPS_TO_KT))}` : ""}` : o.name;
      if (e.label.textContent !== text) e.label.textContent = text;
      e.label.style.color = o.category === "weapon" ? "#f2f2f2" : e.color;
      e.label.classList.toggle("focus", o.id === this.focusId);
    }
    if (this._padMid && this.padLabel) {
      v.copy(this._padMid).project(this.camera);
      const show = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      this.padLabel.style.display = show ? "block" : "none";
      if (show) this.padLabel.style.transform = `translate(${((v.x + 1) / 2) * w + 6}px, ${((1 - v.y) / 2) * h - 6}px)`;
    }
    this._pointers(w, h);
  }

  _bindPick() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this._pickables, false)[0];
      if (hit && this.onPick) this.onPick(hit.object.userData.id, { shift: e.shiftKey });
    });
    el.addEventListener("pointerdown", () => { if (this.mode === "orbit") this.userMoved = true; });
  }
}
