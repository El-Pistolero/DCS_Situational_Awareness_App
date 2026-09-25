// 3D tactical view: satellite-draped terrain, aircraft with full attitude,
// weapons with smoke trails, SAM envelopes, orbit and chase cameras.

import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { bisectRight, fmtDist, fmtShort, isHostile, isNum, sideColor, slantRange, units, M_TO_FT, MPS_TO_KT } from "./util.js";
import { buildF16, isF16 } from "./f16.js";
import { radarVolume } from "./symbols.js";
import { tofTicks, weaponPath } from "./strikegeom.js";

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

function weaponGeometry() {
  // ~4 m store pointing north: body, nose cone and cruciform tail fins, so the
  // weapon cam shows its attitude from behind.
  const body = new THREE.CylinderGeometry(0.25, 0.25, 3.3, 8).rotateX(Math.PI / 2).translate(0, 0, 0.35);
  const nose = new THREE.ConeGeometry(0.25, 0.7, 8).rotateX(-Math.PI / 2).translate(0, 0, -1.65);
  const v = [...body.toNonIndexed().attributes.position.array, ...nose.toNonIndexed().attributes.position.array];
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
    const p = (r, z) => [c * r, s * r, z];
    v.push(...p(0.2, 1.1), ...p(0.75, 1.6), ...p(0.75, 2.0), ...p(0.2, 1.1), ...p(0.75, 2.0), ...p(0.2, 2.0));
  }
  body.dispose(); nose.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

const GEOM = {
  jet: jetGeometry(),
  heli: heliGeometry(),
  missile: weaponGeometry(),
  ground: new THREE.BoxGeometry(7, 3, 10),
  sam: new THREE.CylinderGeometry(3, 4, 4, 8),
  ship: new THREE.BoxGeometry(16, 10, 110),
  carrier: new THREE.BoxGeometry(70, 20, 330),
};

// ---------------------------------------------------------------------------
// Radar volumes
// ---------------------------------------------------------------------------

const radarGeomCache = new Map();

/**
 * Unit-radius search volume centred on -Z: azimuth +-azDeg, elevation from
 * elLoDeg to elHiDeg (a raster scan covers an az/el box, so the elevation
 * band is built in, not produced by tilting), plus its outline.
 */
function radarGeometry(azDeg, elLoDeg, elHiDeg) {
  const q = (x) => Math.round(x * 2) / 2; // cache on half degrees
  const key = `${q(azDeg)}/${q(elLoDeg)}/${q(elHiDeg)}`;
  let g = radarGeomCache.get(key);
  if (g) return g;
  const az = Math.min(q(azDeg), 180) * D2R;
  const lo = Math.max(-89.5, q(elLoDeg)) * D2R, hi = Math.min(89.5, Math.max(q(elHiDeg), q(elLoDeg) + 0.5)) * D2R;
  const full = azDeg >= 180;
  const fill = new THREE.SphereGeometry(1, full ? 64 : 32, 6, 1.5 * Math.PI - az, 2 * az, Math.PI / 2 - hi, hi - lo);
  // Outline: far-surface rims at the top and bottom of the volume, plus the
  // four radial edges for a sector.
  const pts = [];
  const dir = (a, e) => new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), -Math.cos(a) * Math.cos(e));
  const steps = full ? 72 : 24;
  for (const e of [lo, hi]) {
    for (let i = 0; i < steps; i++) {
      const a0 = -az + (2 * az * i) / steps, a1 = -az + (2 * az * (i + 1)) / steps;
      pts.push(dir(a0, e), dir(a1, e));
    }
  }
  if (!full) {
    for (const a of [-az, az]) {
      for (const e of [lo, hi]) pts.push(new THREE.Vector3(0, 0, 0), dir(a, e));
      pts.push(dir(a, lo), dir(a, hi));
    }
  }
  const edges = new THREE.BufferGeometry().setFromPoints(pts);
  g = { fill, edges };
  radarGeomCache.set(key, g);
  return g;
}

// ---------------------------------------------------------------------------
// Air-to-ground marks, stalks, lighting
// ---------------------------------------------------------------------------

const AIR_CATS = ["fixedwing", "rotorcraft", "air"];
const STALK_CATS = new Set([...AIR_CATS, "weapon"]);
const RESULT_COLOR = { destroyed: "#ff5c5c", damaged: "#ff9f43", miss: "#9aa4b1", unknown: "#c8cdd6" };
const REL_COLOR = "#ffd166";
const RING_SEGS = 48;
const FOOT_SEGS = 48, FOOT_RINGS = 3; // concentric rings so the fill follows the terrain
const DIM_OPACITY = 0.2;
const LABEL_RANGE = 60000;

// Scene background / fog, hemisphere and sun per lighting mode; `emissive` is
// added to object materials so aircraft still read against a dark sky.
const LIGHTING = {
  day: { sky: 0x8fa9c4, hemiSky: 0xdfeaff, hemiGround: 0x3a3326, hemi: 1.1, sun: 0xffffff, sunI: 1.6, dir: [-0.6, 1, 0.4], emissive: 0 },
  dusk: { sky: 0x5e5870, hemiSky: 0xffc9a6, hemiGround: 0x2a2430, hemi: 0.75, sun: 0xff9d5c, sunI: 1.3, dir: [-1, 0.22, 0.25], emissive: 0.12 },
  night: { sky: 0x0b1120, hemiSky: 0x50608a, hemiGround: 0x0d1016, hemi: 0.5, sun: 0xa8bcff, sunI: 0.4, dir: [0.4, 1, -0.3], emissive: 0.35 },
};

// Fields that change a strike's geometry or labels: callers rebuild the list
// ({...strike, pb}) every time, so compare these instead of identity.
const STRIKE_KEYS = ["weaponId", "pb", "release", "impact", "footprint", "dispense", "damage", "releaseTime", "impactTime", "result", "missDistance"];
const sameStrikes = (a, b) => !!b && a.length === b.length && a.every((s, i) => s === b[i] || STRIKE_KEYS.every((k) => s[k] === b[i][k]));

/** The geometry's `name` attribute (3 floats per vertex) with room for n vertices; grows by doubling, keeps its data. */
function growAttr(g, name, n) {
  let a = g.attributes[name];
  if (a && a.count >= n) return a;
  let cap = a ? a.count : 64;
  while (cap < n) cap *= 2;
  const arr = new Float32Array(cap * 3);
  if (a) arr.set(a.array);
  a = new THREE.BufferAttribute(arr, 3);
  g.setAttribute(name, a);
  return a;
}

function dynamicGeometry(colors) {
  const g = new THREE.BufferGeometry();
  growAttr(g, "position", 64);
  if (colors) growAttr(g, "color", 64);
  g.setDrawRange(0, 0);
  return g;
}

/** "REL 25.0k · M0.79": release altitude in thousands of ft (or m). */
function releaseText(s) {
  const r = s.release;
  const alt = isNum(r.altitude) ? ` ${((units.metric ? r.altitude : r.altitude * M_TO_FT) / 1000).toFixed(1)}k` : "";
  return `REL${alt}${isNum(r.mach) ? ` · M${r.mach.toFixed(2)}` : ""}`;
}

/** "19 m · DESTROYED" / "miss 44 m". */
function impactText(s) {
  const d = s.missDistance, res = s.result || "unknown";
  if (res === "miss") return isNum(d) ? `miss ${fmtShort(d)}` : "miss";
  if (res === "unknown") return isNum(d) ? fmtShort(d) : "impact";
  return isNum(d) ? `${fmtShort(d)} · ${res.toUpperCase()}` : res.toUpperCase();
}

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

    this.hemi = new THREE.HemisphereLight(0xdfeaff, 0x3a3326, 1.1);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.6, 1, 0.4);
    this.scene.add(sun);
    this.sun = sun;
    this.lighting = "day";
    this._emissiveBoost = 0;

    // Fallback ground so there is always something under the aircraft.
    const base = new THREE.Mesh(new THREE.PlaneGeometry(2e6, 2e6).rotateX(-Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x3d4a3f }));
    base.position.y = -2;
    this.scene.add(base);
    this.grid = new THREE.GridHelper(400000, 80, 0x60707a, 0x4b5860);
    this.grid.position.y = -1;
    this.scene.add(this.grid);
    this._initRounds();
    this._initOverlays();

    this.origin = null;
    this.exaggeration = 1;
    this.tiles = new Map(); // key -> {mesh, z, x, y}
    this._terrainGen = 0; // bumped whenever a terrain mesh appears or goes, to re-drape ground marks
    this._strikeList = [];
    this._strikes = [];
    this._tmpV = new THREE.Vector3();
    this._want = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this.loader = new Loader(6);
    this.objects = new Map(); // id -> {group, model, trail, label}
    this.mode = "orbit";
    this.follow = true;
    this.focusId = null;
    this.lastFocusPos = null;
    this.visible = false;
    this.onPick = null;
    this.onContext = null; // (id | null, {clientX, clientY, lon, lat}) on a right click
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
    for (const t of this.tiles.values()) if (t.mesh) t.mesh.scale.y = x; // tiles still loading pick it up when built
    this._terrainGen++; // strike marks rebuild on the exaggeration change itself
  }

  /** "day" (default) | "dusk" | "night": sky, fog, lights and a little extra glow on the models. */
  setLighting(mode) {
    const L = LIGHTING[mode] || LIGHTING.day;
    this.lighting = LIGHTING[mode] ? mode : "day";
    this.scene.background.set(L.sky);
    this.scene.fog.color.set(L.sky);
    this.hemi.color.set(L.hemiSky);
    this.hemi.groundColor.set(L.hemiGround);
    this.hemi.intensity = L.hemi;
    this.sun.color.set(L.sun);
    this.sun.intensity = L.sunI;
    this.sun.position.set(...L.dir);
    this._emissiveBoost = L.emissive;
    // Apply now too: update() may not run again until playback moves.
    for (const e of this.objects.values()) if (isNum(e.emiss)) e.mat.emissiveIntensity = e.emiss + L.emissive;
    for (const m of ["dusk", "night"]) this.labelLayer.classList.toggle(m, this.lighting === m);
  }

  // -- coordinates ------------------------------------------------------------

  toLocal(lon, lat, alt = 0, out = new THREE.Vector3()) {
    const [lon0, lat0] = this.origin;
    const x = (lon - lon0) * R_LAT * Math.cos(lat0 * D2R);
    const z = -(lat - lat0) * R_LAT;
    return out.set(x, (alt || 0) * this.exaggeration, z);
  }

  /** Inverse of toLocal on the ground plane: local x/z -> [lon, lat]. */
  fromLocal(x, z) {
    const [lon0, lat0] = this.origin;
    return [lon0 + x / (R_LAT * Math.cos(lat0 * D2R)), lat0 - z / R_LAT];
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
    this._terrainGen++;
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
    this._terrainGen++;
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
    e = { ...(e || {}), group, model, mat, trail, dome, label, color: sideColor(o), sideCol: new THREE.Color(sideColor(o)),
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
    if (rd) { this.scene.remove(rd.root); rd.mats.forEach((m) => m.dispose()); this.radars.delete(id); }
    this.objects.delete(id);
  }

  /**
   * objects: [{id, category, type, lon, lat, alt, hdg, pitch, roll, trail, name, pilot,
   *            coalition, color, dead, lock, dispenser, v:{EngagementRange}}]
   * Options beyond the original five all default to the old behaviour:
   *   t: recording time for the strike marks (none = show them all);
   *   strikeLayers: {release, paths, impacts, footprints} (each default true; future: whole paths ahead of time);
   *   stalks: "off" | "selected" | "all"; rings: "all" | "hostile" | "off"; pinned: Set of ids whose dome always shows;
   *   lockLines: false hides lock lines; dim: Set of ids to keep, the rest drawn faint;
   *   weaponCamHoldAt: {lon, lat, alt} to look at from where the weapon cam is (after impact).
   */
  update(objects, {
    focusId = null, selectedId = null, radar = "all", rounds = [], padlockId = null,
    t = null, strikeLayers = null, stalks = "off", rings = "all", pinned = null, lockLines: showLocks = true,
    dim = null, weaponCamHoldAt = null,
  } = {}) {
    const wanted = focusId != null ? objects.find((o) => o.id === focusId) : null;
    const focus = wanted || objects.find((o) => o.id === selectedId) ||
      objects.find((o) => ["fixedwing", "rotorcraft"].includes(o.category)) || objects.find((o) => typeof o.dispenser !== "string");
    if (!focus) return;
    // Weapon cam hold: given (the impact point once the weapon is gone), or
    // implied when the weapon being ridden leaves the recording early (a JSOW
    // dispensing its bomblets): stay put and keep looking.
    const cw = this._camWeapon;
    let hold = null;
    if (this.mode === "chase") {
      if (weaponCamHoldAt && isNum(weaponCamHoldAt.lon) && isNum(weaponCamHoldAt.lat)) hold = weaponCamHoldAt;
      else if (!wanted && focusId != null && cw?.id === focusId) hold = cw;
    }
    this._ensureOrigin(focus.lon, focus.lat);
    this._updateTerrain(hold ? hold.lon : focus.lon, hold ? hold.lat : focus.lat);
    this.focusId = focus.id;
    this.selectedId = selectedId;
    const ringMode = rings || "all";
    const boost = this._emissiveBoost;

    const seen = new Set();
    const cloud = this.bombletCloud.geometry;
    let nb = 0;
    for (const o of objects) {
      if (!isNum(o.lon) || !isNum(o.lat) || o.category === "bullseye" || o.category === "countermeasure") continue;
      if (typeof o.dispenser === "string") {
        // Bomblets (hundreds at once): one point cloud, no meshes, trails, labels or picking.
        const arr = growAttr(cloud, "position", nb + 1).array;
        const v = this.toLocal(o.lon, o.lat, o.alt, this._tmpV);
        arr[nb * 3] = v.x; arr[nb * 3 + 1] = v.y; arr[nb * 3 + 2] = v.z;
        nb++;
        continue;
      }
      seen.add(o.id);
      const e = this._entry(o);
      const dimmed = !!dim && !dim.has(o.id);
      if (!!e.dimmed !== dimmed) this._dimEntry(e, dimmed);
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
      e.emiss = e.f16 ? (hi ? 0.4 : e.baseEmissive) : (hi ? 0.8 : 0.35);
      e.mat.emissiveIntensity = e.emiss + boost;
      e.pos = p;
      e.obj = o;
      if (e.dome) {
        const show = !!pinned?.has(o.id) ||
          (!dimmed && (ringMode === "all" || (ringMode === "hostile" && isHostile(o, focus))));
        e.dome.visible = show;
        if (show) {
          const r = o.v.EngagementRange;
          e.dome.position.set(p.x, 0, p.z);
          e.dome.scale.set(r, (o.v.VerticalEngagementRange || r) * this.exaggeration, r);
        }
      }
      if (dimmed) continue; // no trail while isolated away
      // Trail
      const tr = o.trail || [];
      const arr = e.trail.geometry.attributes.position.array;
      const colAttr = e.trail.geometry.attributes.color;
      const col = colAttr?.array;
      const tc = o.trailColors && o.trailColors.length === tr.length ? o.trailColors : null;
      const base = e.sideCol; // side colour (the F-16 body colour is mostly grey)
      const lin = this._lin ||= new THREE.Color();
      // Ramp colours are sRGB (as in the 2D map and legend); vertex colours are linear.
      const put = (k, c) => {
        if (c) { lin.setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace); col[k] = lin.r; col[k + 1] = lin.g; col[k + 2] = lin.b; }
        else { col[k] = base.r; col[k + 1] = base.g; col[k + 2] = base.b; }
      };
      const start = Math.max(0, tr.length - 400);
      let k = 0;
      for (let i = start; i < tr.length; i++) {
        const v = this.toLocal(tr[i][0], tr[i][1], tr[i][2]);
        if (col) put(k, tc?.[i]);
        arr[k++] = v.x; arr[k++] = v.y; arr[k++] = v.z;
      }
      if (col) {
        put(k, tc?.[tc.length - 1]);
        colAttr.needsUpdate = true;
      }
      arr[k++] = p.x; arr[k++] = p.y; arr[k++] = p.z;
      e.trail.geometry.setDrawRange(0, k / 3);
      e.trail.geometry.attributes.position.needsUpdate = true;
    }
    for (const id of [...this.objects.keys()]) if (!seen.has(id)) this._remove(id);
    cloud.setDrawRange(0, nb);
    if (nb) cloud.attributes.position.needsUpdate = true;
    this._updateRadars(objects, radar, focus.id, selectedId);
    this._updateRounds(rounds);
    this._updateStalks(stalks, focus.id, selectedId);
    this._strikeT = isNum(t) ? t : Infinity;
    this._strikeLayers = strikeLayers;
    this._syncStrikes();
    this._strikeVisibility();

    // Lock lines.
    if (!this.lockLines) {
      this.lockLines = new THREE.LineSegments(new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0xffd166, dashSize: 400, gapSize: 300, transparent: true, opacity: 0.8 }));
      this.lockLines.frustumCulled = false;
      this.scene.add(this.lockLines);
    }
    this.lockLines.visible = showLocks !== false;
    if (this.lockLines.visible) {
      const lp = [];
      for (const o of objects) {
        if (!o.lock) continue;
        const a = this.objects.get(o.id), b = this.objects.get(o.lock);
        if (a?.pos && b?.pos && !(a.dimmed && b.dimmed)) lp.push(a.pos.x, a.pos.y, a.pos.z, b.pos.x, b.pos.y, b.pos.z);
      }
      this.lockLines.geometry.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
      this.lockLines.computeLineDistances();
    }

    // Camera follow.
    const fp = this.objects.get(focus.id)?.pos;
    const smooth = (want) => {
      const now = performance.now();
      const dt = this._lastChase ? Math.min(1, (now - this._lastChase) / 1000) : 1;
      this._lastChase = now;
      const snap = !this.lastFocusPos || this._lastFocusId !== focus.id || this.camera.position.distanceTo(want) > 600;
      this.camera.position.lerp(want, snap ? 1 : 1 - Math.exp(-dt / 0.08));
      return dt;
    };
    if (hold) {
      this._updatePadLine(null);
      this._padTarget = null;
      const target = hold === cw ? cw.look : this.toLocal(hold.lon, hold.lat, isNum(hold.alt) ? hold.alt : 0, this._want);
      // Ease the view from where the weapon cam was looking onto the hold point.
      const dt = this._lastChase ? Math.min(1, (performance.now() - this._lastChase) / 1000) : 1;
      this._lastChase = performance.now();
      if (!this._holdLook) this._holdLook = (cw && this._lastFocusId === cw.id ? cw.look : target).clone();
      else this._holdLook.lerp(target, 1 - Math.exp(-dt / 0.35));
      this.camera.lookAt(this._holdLook);
      this._lastFocusId = null; // snap back onto whatever is followed once the hold ends
    } else if (fp) {
      this._holdLook = null;
      if (this.mode === "orbit" && this.follow && this.lastFocusPos) {
        const delta = fp.clone().sub(this.lastFocusPos);
        this.camera.position.add(delta);
        this.controls.target.add(delta);
      } else if (this.mode === "orbit" && !this.lastFocusPos) {
        this.controls.target.copy(fp);
        this.camera.position.copy(fp).add(new THREE.Vector3(-4000, 2500, 6000));
      }
      // Chase/padlock: carry the camera along with the jet first, then smooth
      // only the change in offset (heading, target direction).  Smoothing the
      // jet's own motion would make the lag grow with playback speed.
      const tracking = this.mode === "chase" || this.mode === "padlock";
      if (tracking && this.lastFocusPos && this._lastFocusId === focus.id) {
        this.camera.position.add(fp.clone().sub(this.lastFocusPos));
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
        smooth(want);
        this.camera.lookAt(fp.clone().lerp(tp, 0.3));
        this._updatePadLine(fp, tp, slant);
      } else this._updatePadLine(null);
      if (this.mode === "chase" && focus.category === "weapon") {
        // Weapon cam: tight behind the weapon along its heading and pitch, so
        // a bomb or a JSOW fills the view.
        const hdg = (isNum(focus.hdg) ? focus.hdg : 0) * D2R, pit = (isNum(focus.pitch) ? focus.pitch : 0) * D2R;
        const dir = this._tmpV.set(Math.sin(hdg) * Math.cos(pit), Math.sin(pit) * this.exaggeration, -Math.cos(hdg) * Math.cos(pit)).normalize();
        this._want.copy(fp).addScaledVector(dir, -14).y += 4;
        smooth(this._want);
        const c = this._camWeapon ||= { id: null, lon: 0, lat: 0, alt: 0, look: new THREE.Vector3() };
        c.look.copy(fp).addScaledVector(dir, 30);
        this.camera.lookAt(c.look);
        c.id = focus.id; c.lon = focus.lon; c.lat = focus.lat; c.alt = focus.alt;
      } else if (this.mode === "chase" || (this.mode === "padlock" && !this._padTarget)) {
        const hdg = (focus.hdg || 0) * D2R;
        const back = 42, up = 11; // close enough to see the jet's shape
        const want = fp.clone().add(new THREE.Vector3(Math.sin(hdg) * -back, up, Math.cos(hdg) * back));
        // Time-based smoothing: the same feel at 60 Hz playback and 5 Hz live
        // updates.  Snap after a seek, a focus change or when first entering chase.
        smooth(want);
        this.camera.lookAt(fp.clone().add(new THREE.Vector3(Math.sin(hdg) * 40, 3, -Math.cos(hdg) * 40)));
      }
      if (this._camWeapon && !(this.mode === "chase" && focus.category === "weapon")) this._camWeapon.id = null;
      this.lastFocusPos = fp.clone();
      this._lastFocusId = focus.id;
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
      if (!behind && Math.abs(x) <= 1 && Math.abs(y) <= 1) { d.style.display = "none"; return; } // on screen: its label is enough
      if (!behind) k = Math.min(k, 1); // off screen: onto the ellipse; behind: always on its edge
      if (!Number.isFinite(k) || Math.hypot(x, y) < 1e-6) { x = 0; y = -0.88; k = 1; }
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

  // -- isolate, stalks, bomblets ------------------------------------------------------

  _initOverlays() {
    // Bomblets in flight: one cloud for all of them.
    this.bombletCloud = new THREE.Points(dynamicGeometry(false),
      new THREE.PointsMaterial({ color: 0xd9c3a5, size: 3, sizeAttenuation: false }));
    // Altitude stalks: one segment per object and a dot where it meets the ground.
    this.stalks = new THREE.LineSegments(dynamicGeometry(true),
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false }));
    this.stalkDots = new THREE.Points(dynamicGeometry(true),
      new THREE.PointsMaterial({ vertexColors: true, size: 4, sizeAttenuation: false }));
    for (const o of [this.bombletCloud, this.stalks, this.stalkDots]) {
      o.frustumCulled = false;
      this.scene.add(o);
    }
    this._stalkWhite = new THREE.Color(0xe8e8e8);
  }

  /** Isolate: draw an object faint (no label or trail); undo restores its materials exactly. */
  _dimEntry(e, on) {
    e.dimmed = on;
    e.trail.visible = !on;
    e.model.traverse((m) => {
      if (!m.isMesh) return;
      const mat = m.material, u = mat.userData;
      if (on && !u.undim) {
        u.undim = { transparent: mat.transparent, opacity: mat.opacity, depthWrite: mat.depthWrite };
        mat.transparent = true;
        mat.opacity = u.undim.opacity * DIM_OPACITY;
        mat.depthWrite = false;
        mat.needsUpdate = true;
      } else if (!on && u.undim) {
        Object.assign(mat, u.undim);
        delete u.undim;
        mat.needsUpdate = true;
      }
    });
  }

  _updateStalks(mode, focusId, selectedId) {
    const g = this.stalks.geometry, dg = this.stalkDots.geometry;
    const put = (arr, at, c) => { arr[at] = c.r; arr[at + 1] = c.g; arr[at + 2] = c.b; };
    let n = 0;
    if (mode === "all" || mode === "selected") {
      for (const e of this.objects.values()) {
        const o = e.obj;
        if (!o || !e.pos || e.dimmed || !STALK_CATS.has(o.category)) continue;
        if (mode === "selected" && o.id !== focusId && o.id !== selectedId) continue;
        const pos = growAttr(g, "position", 2 * n + 2).array, col = growAttr(g, "color", 2 * n + 2).array;
        const dot = growAttr(dg, "position", n + 1).array, dcol = growAttr(dg, "color", n + 1).array;
        const gy = this._terrainAt(o.lon, o.lat) ?? 0;
        const c = o.category === "weapon" ? this._stalkWhite : e.sideCol;
        const k = n * 6, j = n * 3;
        pos[k] = e.pos.x; pos[k + 1] = e.pos.y; pos[k + 2] = e.pos.z;
        pos[k + 3] = e.pos.x; pos[k + 4] = gy; pos[k + 5] = e.pos.z;
        dot[j] = e.pos.x; dot[j + 1] = gy + 1; dot[j + 2] = e.pos.z;
        put(col, k, c); put(col, k + 3, c); put(dcol, j, c);
        n++;
      }
    }
    g.setDrawRange(0, 2 * n);
    dg.setDrawRange(0, n);
    this.stalks.visible = this.stalkDots.visible = n > 0;
    if (!n) return;
    g.attributes.position.needsUpdate = g.attributes.color.needsUpdate = true;
    dg.attributes.position.needsUpdate = dg.attributes.color.needsUpdate = true;
  }

  // -- air-to-ground strikes -----------------------------------------------------------

  /**
   * Strike marks: analysis strikes, each with `pb` (the weapon's playback
   * track), or null to clear.  Geometry is built once (again on an origin or
   * exaggeration change) and update() shows each part from its time on.
   */
  setStrikes(list) {
    const next = Array.isArray(list) ? list.filter((s) => s?.release && s.impact) : [];
    if (sameStrikes(next, this._strikeList)) return;
    this._strikeList = next;
    this._clearStrikes();
    this._syncStrikes();
    this._strikeVisibility();
  }

  _clearStrikes() {
    for (const st of this._strikes) {
      this.scene.remove(st.group);
      st.group.traverse((m) => { if (m.geometry && m.geometry !== this._strikeRes?.sphere) m.geometry.dispose(); });
      st.relLabel.remove();
      st.impLabel.remove();
    }
    this._strikes = [];
    if (this._strikeRes) {
      this._strikeRes.sphere.dispose();
      for (const m of this._strikeRes.mats) m.dispose();
      this._strikeRes = null;
    }
    this._builtOrigin = null;
  }

  /** Build the marks once the scene has an origin; rebuild on origin / exaggeration change, re-drape on new terrain. */
  _syncStrikes() {
    if (!this.origin || !this._strikeList.length) return;
    if (this._builtOrigin !== this.origin || this._builtExag !== this.exaggeration) {
      this._clearStrikes();
      this._buildStrikes();
      this._builtOrigin = this.origin;
      this._builtExag = this.exaggeration;
      this._strikeVisibility();
    } else if (this._drapedGen !== this._terrainGen) this._drapeStrikes();
  }

  _buildStrikes() {
    const mats = [];
    const mk = (m) => { mats.push(m); return m; };
    const res = this._strikeRes = { sphere: new THREE.SphereGeometry(1, 12, 8), mats, ring: {} };
    res.post = mk(new THREE.LineBasicMaterial({ color: REL_COLOR, transparent: true, opacity: 0.75 }));
    res.rel = mk(new THREE.MeshBasicMaterial({ color: REL_COLOR }));
    res.path = mk(new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 }));
    res.tick = mk(new THREE.PointsMaterial({ color: 0xffffff, size: 5, sizeAttenuation: false }));
    res.disp = mk(new THREE.MeshBasicMaterial({ color: 0xffb347 }));
    res.footLine = mk(new THREE.LineBasicMaterial({ color: 0xf2c94c, transparent: true, opacity: 0.9 }));
    res.footFill = mk(new THREE.MeshBasicMaterial({ color: 0xf2c94c, transparent: true, opacity: 0.14, depthWrite: false, side: THREE.DoubleSide }));
    res.bomb = mk(new THREE.PointsMaterial({ color: 0xffe2b0, size: 3.5, sizeAttenuation: false }));
    for (const [k, c] of Object.entries(RESULT_COLOR)) {
      res.ring[k] = mk(new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide }));
    }
    for (const s of this._strikeList) {
      const st = this._buildStrike(s, res);
      if (st) this._strikes.push(st);
    }
    this._drapeStrikes();
  }

  _buildStrike(s, res) {
    const rel = s.release, imp = s.impact;
    if (!isNum(rel.longitude) || !isNum(rel.latitude) || !isNum(imp.longitude) || !isNum(imp.latitude)) return null;
    const group = new THREE.Group();
    const impAlt = isNum(imp.altitude) ? imp.altitude : 0;
    const st = { s, group, impY: impAlt * this.exaggeration, ringBucket: null, relShow: false, impShow: false };
    const add = (Ctor, verts, mat) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(verts, 3));
      const o = new Ctor(g, mat);
      o.frustumCulled = false; // draped later; the bounding sphere would go stale
      group.add(o);
      return o;
    };

    // Release post: terrain -> release point, a marker on top.
    st.relPos = this.toLocal(rel.longitude, rel.latitude, rel.altitude);
    st.post = add(THREE.Line, new Float32Array([st.relPos.x, st.impY, st.relPos.z, st.relPos.x, st.relPos.y, st.relPos.z]), res.post);
    st.top = new THREE.Mesh(res.sphere, res.rel);
    st.top.position.copy(st.relPos);
    group.add(st.top);

    // Weapon path, drawn up to "now" while the weapon flies, with time-of-fall ticks.
    const objs = new Map([[s.weaponId, { id: s.weaponId, pb: s.pb }]]);
    const pts = s.pb ? weaponPath(s, objs) : [];
    if (pts.length >= 2) {
      const verts = new Float32Array(pts.length * 3);
      st.pathT = new Float64Array(pts.length);
      pts.forEach((q, i) => {
        const v = this.toLocal(q.lon, q.lat, q.alt, this._tmpV);
        verts.set([v.x, v.y, v.z], i * 3);
        st.pathT[i] = q.t;
      });
      st.path = add(THREE.Line, verts, res.path);
      const ticks = tofTicks(s, objs);
      if (ticks.length) {
        const tv = new Float32Array(ticks.length * 3);
        st.tickT = new Float64Array(ticks.length);
        ticks.forEach((q, i) => {
          const v = this.toLocal(q.lon, q.lat, q.alt, this._tmpV);
          tv.set([v.x, v.y, v.z], i * 3);
          st.tickT[i] = q.t;
        });
        st.ticks = add(THREE.Points, tv, res.tick);
      }
    }

    // Impact ring (draped per camera-distance bucket in render()).
    st.impPos = this.toLocal(imp.longitude, imp.latitude, impAlt);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(RING_SEGS * 2 * 3), 3));
    const ri = [];
    for (let i = 0; i < RING_SEGS; i++) {
      const a = i, b = (i + 1) % RING_SEGS, c = RING_SEGS + i, d = RING_SEGS + b;
      ri.push(a, c, b, b, c, d);
    }
    rg.setIndex(ri);
    st.color = RESULT_COLOR[s.result] || RESULT_COLOR.unknown;
    st.ring = new THREE.Mesh(rg, res.ring[s.result] || res.ring.unknown);
    st.ring.frustumCulled = false;
    st.ring.renderOrder = 3;
    group.add(st.ring);

    // Cluster footprint: the 2-sigma ellipse and the recorded bomblet impacts.
    const fpr = s.footprint;
    if (fpr && isNum(fpr.major) && isNum(fpr.minor) && fpr.major > 0 && isNum(fpr.lon)) {
      const c = this.toLocal(fpr.lon, fpr.lat, 0, this._tmpV);
      const b = (isNum(fpr.bearing) ? fpr.bearing : 0) * D2R;
      // Major axis along the bearing (x east, z south), minor across it.
      const ax = Math.sin(b), az = -Math.cos(b), bx = Math.cos(b), bz = Math.sin(b);
      const nv = 1 + FOOT_RINGS * FOOT_SEGS;
      const xz = new Float32Array(nv * 2);
      xz[0] = c.x; xz[1] = c.z;
      for (let r = 1; r <= FOOT_RINGS; r++) {
        const f = r / FOOT_RINGS;
        for (let i = 0; i < FOOT_SEGS; i++) {
          const th = (i / FOOT_SEGS) * Math.PI * 2;
          const u = Math.cos(th) * fpr.major * f, w = Math.sin(th) * fpr.minor * f;
          const k = (1 + (r - 1) * FOOT_SEGS + i) * 2;
          xz[k] = c.x + u * ax + w * bx;
          xz[k + 1] = c.z + u * az + w * bz;
        }
      }
      const idx = [];
      const at = (r, i) => (r === 0 ? 0 : 1 + (r - 1) * FOOT_SEGS + (i % FOOT_SEGS));
      for (let i = 0; i < FOOT_SEGS; i++) idx.push(0, at(1, i), at(1, i + 1));
      for (let r = 1; r < FOOT_RINGS; r++) {
        for (let i = 0; i < FOOT_SEGS; i++) idx.push(at(r, i), at(r + 1, i), at(r, i + 1), at(r, i + 1), at(r + 1, i), at(r + 1, i + 1));
      }
      const fill = add(THREE.Mesh, new Float32Array(nv * 3), res.footFill);
      fill.geometry.setIndex(idx);
      fill.renderOrder = 2;
      const outline = add(THREE.LineLoop, new Float32Array(FOOT_SEGS * 3), res.footLine);
      st.foot = { xz, fill, outline };
    }
    const bp = (fpr?.points || []).filter((q) => isNum(q?.[0]) && isNum(q?.[1]));
    if (bp.length) {
      st.bombXZ = new Float32Array(bp.length * 2);
      bp.forEach((q, i) => {
        const v = this.toLocal(q[0], q[1], 0, this._tmpV);
        st.bombXZ[i * 2] = v.x; st.bombXZ[i * 2 + 1] = v.z;
      });
      st.bombs = add(THREE.Points, new Float32Array(bp.length * 3), res.bomb);
      // All at once, from the first hit or 10 s after the dispense, whichever is earlier.
      const cand = [];
      for (const d of s.damage || []) if (isNum(d.time)) cand.push(d.time);
      if (isNum(s.dispense?.time)) cand.push(s.dispense.time + 10);
      st.bombT = cand.length ? Math.min(...cand) : s.impactTime;
    }

    // Dispense point.
    const dsp = s.dispense;
    if (dsp && isNum(dsp.longitude) && isNum(dsp.latitude)) {
      st.disp = new THREE.Mesh(res.sphere, res.disp);
      this.toLocal(dsp.longitude, dsp.latitude, dsp.altitude, st.disp.position);
      st.dispT = dsp.time;
      group.add(st.disp);
    }

    st.relLabel = document.createElement("div");
    st.relLabel.className = "lbl3d strike rel";
    st.relLabel.style.color = REL_COLOR;
    st.impLabel = document.createElement("div");
    st.impLabel.className = "lbl3d strike imp";
    st.impLabel.style.color = st.color;
    st.relLabel.style.display = st.impLabel.style.display = "none";
    this.labelLayer.append(st.relLabel, st.impLabel);
    this.scene.add(group);
    return st;
  }

  /** Put the ground ends of the marks on the terrain (or the impact altitude where no tile is loaded). */
  _drapeStrikes() {
    this._drapedGen = this._terrainGen;
    for (const st of this._strikes) {
      const ground = (x, z) => this._groundAtLocal(x, z) ?? st.impY;
      const pa = st.post.geometry.attributes.position;
      pa.array[1] = Math.min(ground(pa.array[0], pa.array[2]), pa.array[4]);
      pa.needsUpdate = true;
      st.impPos.y = ground(st.impPos.x, st.impPos.z);
      st.ringBucket = null; // re-drape the ring on the next frame
      if (st.foot) {
        const { xz, fill, outline } = st.foot;
        const fa = fill.geometry.attributes.position, oa = outline.geometry.attributes.position;
        for (let i = 0; i < xz.length / 2; i++) {
          const x = xz[i * 2], z = xz[i * 2 + 1];
          fa.array[i * 3] = x; fa.array[i * 3 + 1] = ground(x, z) + 3; fa.array[i * 3 + 2] = z;
        }
        // Outline on the outer ring, a little above the fill.
        const o0 = (1 + (FOOT_RINGS - 1) * FOOT_SEGS) * 3;
        for (let i = 0; i < FOOT_SEGS * 3; i++) oa.array[i] = fa.array[o0 + i] + (i % 3 === 1 ? 1 : 0);
        fa.needsUpdate = oa.needsUpdate = true;
      }
      if (st.bombs) {
        const ba = st.bombs.geometry.attributes.position;
        for (let i = 0; i < st.bombXZ.length / 2; i++) {
          const x = st.bombXZ[i * 2], z = st.bombXZ[i * 2 + 1];
          ba.array[i * 3] = x; ba.array[i * 3 + 1] = ground(x, z) + 2; ba.array[i * 3 + 2] = z;
        }
        ba.needsUpdate = true;
      }
    }
  }

  /** Impact ring of radius r (m) lying on the terrain. */
  _drapeRing(st, r) {
    const a = st.ring.geometry.attributes.position, arr = a.array;
    const lift = 1.5 + r * 0.01;
    for (let i = 0; i < RING_SEGS; i++) {
      const th = (i / RING_SEGS) * Math.PI * 2, c = Math.cos(th), s = Math.sin(th);
      for (let k = 0; k < 2; k++) {
        const rr = k ? r : r * 0.78;
        const x = st.impPos.x + c * rr, z = st.impPos.z + s * rr, j = (k * RING_SEGS + i) * 3;
        arr[j] = x; arr[j + 1] = (this._groundAtLocal(x, z) ?? st.impY) + lift; arr[j + 2] = z;
      }
    }
    a.needsUpdate = true;
  }

  /** Show each mark from its time on (no spoilers), per layer. */
  _strikeVisibility() {
    const T = this._strikeT ?? Infinity, L = this._strikeLayers || {};
    const rel = L.release !== false, paths = L.paths !== false, imps = L.impacts !== false, foot = L.footprints !== false;
    for (const st of this._strikes) {
      const s = st.s;
      // `!(T < x)` is true when x is missing too: no time, nothing to hide.
      st.relShow = rel && !(T < s.releaseTime);
      st.post.visible = st.top.visible = st.relShow;
      if (st.path) {
        const n = L.future === true ? st.pathT.length : Math.min(st.pathT.length, bisectRight(st.pathT, T) + 1);
        st.path.geometry.setDrawRange(0, n);
        st.path.visible = paths && n >= 2;
        if (st.ticks) {
          const m = L.future === true ? st.tickT.length : bisectRight(st.tickT, T) + 1;
          st.ticks.geometry.setDrawRange(0, m);
          st.ticks.visible = st.path.visible && m > 0;
        }
      }
      if (st.disp) st.disp.visible = paths && !(T < st.dispT);
      const hit = !(T < s.impactTime);
      st.impShow = st.ring.visible = imps && hit;
      if (st.foot) st.foot.fill.visible = st.foot.outline.visible = foot && hit;
      if (st.bombs) st.bombs.visible = foot && !(T < st.bombT);
    }
  }

  /** Per-frame: keep the markers a readable size, re-drape rings on scale change. */
  _scaleStrikes() {
    const cam = this.camera.position;
    for (const st of this._strikes) {
      if (st.top.visible) st.top.scale.setScalar(Math.max(3, cam.distanceTo(st.relPos) / 180));
      if (st.disp?.visible) st.disp.scale.setScalar(Math.max(1.5, cam.distanceTo(st.disp.position) / 200));
      if (st.ring.visible) {
        // ~25 m, growing with distance like the models; quantised so the drape runs rarely.
        const s = Math.min(60, Math.max(1, cam.distanceTo(st.impPos) / 2000));
        const b = Math.round(Math.log(s) * 12);
        if (b !== st.ringBucket) { st.ringBucket = b; st.ringR = 25 * Math.exp(b / 12); this._drapeRing(st, st.ringR); }
      }
    }
  }

  _strikeLabels(w, h, v) {
    const cam = this.camera.position;
    const pxPerRad = h / 2 / Math.tan((this.camera.fov * D2R) / 2);
    const boxes = this._lblBoxes ||= []; // x, y, width of the labels placed this frame
    boxes.length = 0;
    // Only near the camera (a strike package would bury the view in text) and on screen.
    const place = (el, show, pos, dx, dy, s, rel) => {
      if (show) {
        v.copy(pos).project(this.camera);
        show = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05 && cam.distanceTo(pos) < LABEL_RANGE;
      }
      el.style.display = show ? "block" : "none";
      if (!show) return;
      const txt = rel ? releaseText(s) : impactText(s);
      if (el.textContent !== txt) el.textContent = txt;
      const x = ((v.x + 1) / 2) * w + dx, bw = txt.length * 6.7;
      let y = ((1 - v.y) / 2) * h + dy;
      // Stack instead of overprinting (a pair released together, neighbouring impacts).
      for (let i = 0; i < boxes.length; i += 3) {
        if (x < boxes[i] + boxes[i + 2] && boxes[i] < x + bw && Math.abs(y - boxes[i + 1]) < 13) { y = boxes[i + 1] + 13; i = -3; }
      }
      boxes.push(x, y, bw);
      el.style.transform = `translate(${x}px, ${y}px)`;
    };
    for (const st of this._strikes) {
      place(st.relLabel, st.relShow, st.relPos, 10, -16, st.s, true);
      // Impact label just clear of the ring.
      const ringPx = st.ringR ? (st.ringR / Math.max(1, cam.distanceTo(st.impPos))) * pxPerRad : 0;
      place(st.impLabel, st.impShow, st.impPos, 6 + Math.min(ringPx, 60), 2, st.s, false);
    }
  }

  // -- terrain lookup --------------------------------------------------------------------

  /** Terrain height (scene units, exaggerated) at lon/lat from the loaded tiles, detail first; null if none. */
  _terrainAt(lon, lat) {
    return this._tileHeight(DETAIL_Z, lon, lat) ?? this._tileHeight(COARSE_Z, lon, lat);
  }

  _groundAtLocal(x, z) {
    const [lon0, lat0] = this.origin;
    return this._terrainAt(lon0 + x / (R_LAT * Math.cos(lat0 * D2R)), lat0 - z / R_LAT);
  }

  /**
   * Height on a tile's grid, interpolated on the same triangles as the mesh:
   * no raycast, so stalks and draped marks can ask hundreds of times a frame.
   */
  _tileHeight(z, lon, lat) {
    const fx = lon2x(lon, z), fy = lat2y(lat, z);
    const tx = Math.floor(fx), ty = Math.floor(fy);
    // One cached tile per zoom level, valid until the terrain changes.
    const c = (this._hCache ||= {})[z] ||= { gen: -1, tx: 0, ty: 0, mesh: null };
    if (c.gen !== this._terrainGen || c.tx !== tx || c.ty !== ty) {
      c.gen = this._terrainGen; c.tx = tx; c.ty = ty;
      c.mesh = this.tiles.get(`${z}/${tx}/${ty}`)?.mesh || null;
    }
    if (!c.mesh) return null;
    const n = MESH_SEGS, pos = c.mesh.geometry.attributes.position.array;
    const gx = (fx - tx) * n, gy = (fy - ty) * n;
    const i = Math.min(n - 1, Math.floor(gx)), j = Math.min(n - 1, Math.floor(gy));
    const u = gx - i, w = gy - j;
    const a = j * (n + 1) + i, b = a + 1, cc = a + n + 1, d = cc + 1;
    const ha = pos[a * 3 + 1], hb = pos[b * 3 + 1], hc = pos[cc * 3 + 1], hd = pos[d * 3 + 1];
    // The mesh splits each cell into (a, c, b) and (b, c, d).
    const y = u + w <= 1 ? ha + (hb - ha) * u + (hc - ha) * w : hd + (hc - hd) * (1 - u) + (hb - hd) * (1 - w);
    return y * c.mesh.scale.y;
  }

  // -- radar -------------------------------------------------------------------------

  _updateRadars(objects, mode, focusId, selectedId) {
    const shown = new Set();
    if (mode !== "none") {
      for (const o of objects) {
        if (mode === "focus" && o.id !== focusId && o.id !== selectedId) continue;
        const e = this.objects.get(o.id);
        if (!e?.pos || o.dead || e.dimmed) continue;
        const r = radarVolume(o, { assumed: mode !== "known" });
        if (!r) continue;
        shown.add(o.id);
        const guess = r.source === "assumed";
        let rd = this.radars.get(o.id);
        const elLo = r.centerEl - r.el, elHi = r.centerEl + r.el;
        const key = `${Math.round(r.az * 2)}/${Math.round(elLo * 2)}/${Math.round(elHi * 2)}/${guess}`;
        if (!rd || rd.key !== key) {
          if (rd) { this.scene.remove(rd.root); rd.mats.forEach((m) => m.dispose()); }
          const color = new THREE.Color(e.color);
          const g = radarGeometry(r.az, elLo, elHi);
          const fillMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: r.surface ? 0.015 : guess ? 0.03 : 0.07, depthWrite: false, side: THREE.DoubleSide });
          // Assumed volumes get dashed outlines so they never pass for data.
          const edgeMat = guess
            ? new THREE.LineDashedMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, dashSize: 0.025, gapSize: 0.02 })
            : new THREE.LineBasicMaterial({ color, transparent: true, opacity: r.surface ? 0.18 : 0.45, depthWrite: false });
          // root: position + vertical terrain exaggeration (applied after the
          // rotations, like every altitude in the scene); outer: attitude and
          // range; inner: the radar's azimuth offset and roll.
          const root = new THREE.Group();
          const outer = new THREE.Group();
          const inner = new THREE.Group();
          const edges = new THREE.LineSegments(g.edges, edgeMat);
          if (guess) edges.computeLineDistances();
          inner.add(new THREE.Mesh(g.fill, fillMat), edges);
          outer.add(inner);
          root.add(outer);
          this.scene.add(root);
          rd = { key, root, outer, inner, mats: [fillMat, edgeMat] };
          this.radars.set(o.id, rd);
        }
        const hdg = isNum(o.hdg) ? o.hdg : 0;
        rd.root.position.copy(e.pos);
        rd.root.scale.set(1, this.exaggeration, 1);
        if (r.bodyFrame) {
          // ACMI radar angles are relative to the airframe: aircraft attitude
          // first, then the radar's own azimuth/elevation/roll.
          rd.outer.rotation.set((isNum(o.pitch) ? o.pitch : 0) * D2R, -hdg * D2R, -(isNum(o.roll) ? o.roll : 0) * D2R, "YXZ");
        } else {
          // Search volumes are roll/pitch stabilised: heading only.
          rd.outer.rotation.set(0, -hdg * D2R, 0, "YXZ");
        }
        // Elevation is in the geometry; only azimuth and roll rotate here.
        rd.inner.rotation.set(0, -r.centerAz * D2R, -(r.roll || 0) * D2R, "YXZ");
        rd.outer.scale.setScalar(r.range);
        rd.root.visible = true;
      }
    }
    for (const [id, rd] of this.radars) if (!shown.has(id)) rd.root.visible = false;
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
    // Start above the highest candidate tile (tiles are stretched by the
    // terrain exaggeration), or a high peak would be missed from inside.
    const top = Math.max(...meshes.map((m) => m.geometry.boundingBox.max.y * m.scale.y)) + 10;
    this._downRay ||= new THREE.Raycaster();
    this._downRay.set(new THREE.Vector3(x, Math.max(20000, top), z), new THREE.Vector3(0, -1, 0));
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
    this._syncStrikes(); // tiles keep arriving while playback is paused
    this._scaleStrikes();
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
      if (!o || !e.pos || e.dimmed || (!air && o.id !== this.selectedId && o.category !== "weapon")) { e.label.style.display = "none"; continue; }
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
    this._strikeLabels(w, h, v);
    this._pointers(w, h);
  }

  _bindPick() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener("pointerup", (e) => {
      // A click, not a drag (OrbitControls rotates / pans on drags).
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects(this._pickables, false)[0];
      if (e.button === 2 && this.onContext) {
        const ll = this._groundPick(ray);
        this.onContext(hit ? hit.object.userData.id : null, { clientX: e.clientX, clientY: e.clientY, lon: ll?.[0] ?? null, lat: ll?.[1] ?? null });
        return;
      }
      if (hit && this.onPick) this.onPick(hit.object.userData.id, { shift: e.shiftKey });
    });
    // The right button belongs to onContext and panning, never the browser menu.
    el.addEventListener("contextmenu", (e) => e.preventDefault());
    el.addEventListener("pointerdown", () => { if (this.mode === "orbit") this.userMoved = true; });
  }

  /** [lon, lat] of the terrain under a pick ray (the y = 0 plane where no tile is loaded), or null. */
  _groundPick(ray) {
    if (!this.origin) return null;
    const meshes = [];
    for (const t of this.tiles.values()) if (t.mesh) meshes.push(t.mesh);
    let p = ray.intersectObjects(meshes, false)[0]?.point;
    if (!p) p = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    return p ? this.fromLocal(p.x, p.z) : null;
  }
}
