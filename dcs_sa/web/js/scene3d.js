// 3D tactical view: satellite-draped terrain, aircraft with full attitude,
// weapons with smoke trails, SAM envelopes, orbit and chase cameras.

import * as THREE from "three";
import { OrbitControls } from "/static/vendor/OrbitControls.js";
import { isNum, sideColor, units, M_TO_FT, MPS_TO_KT } from "./util.js";

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

export class Scene3D {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true, preserveDrawingBuffer: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.domElement.className = "scene3d";
    // Insert underneath any toolbars / HUDs already in the container.
    this.labelLayer = document.createElement("div");
    this.labelLayer.className = "labels3d";
    container.prepend(this.renderer.domElement, this.labelLayer);

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
    const elev = await loadImage(`/tiles/elev/${z}/${x}/${y}.png`);
    let heights = null;
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
    const n = MESH_SEGS;
    const pos = new Float32Array((n + 1) * (n + 1) * 3);
    const uv = new Float32Array((n + 1) * (n + 1) * 2);
    let p = 0, q = 0;
    for (let j = 0; j <= n; j++) {
      for (let i = 0; i <= n; i++) {
        const fx = i / n, fy = j / n;
        const lon = x2lon(x + fx, z), lat = y2lat(y + fy, z);
        let h = 0;
        if (heights) {
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
    const mat = new THREE.MeshLambertMaterial({ color: 0x55664f });
    const mesh = new THREE.Mesh(g, mat);
    mesh.scale.y = this.exaggeration;
    if (this.tiles.get(k) !== entry) { g.dispose(); mat.dispose(); return; }
    this.scene.add(mesh);
    entry.mesh = mesh;
    entry.pending = false;
    if (heights) this.grid.visible = false;

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
          if (!applied) { mat.map = tex; mat.color.set(0xffffff); mat.needsUpdate = true; applied = true; }
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
    const mat = new THREE.MeshLambertMaterial({
      color: o.category === "weapon" ? 0xf2f2f2 : color, emissive: color, emissiveIntensity: 0.35, side: THREE.DoubleSide,
    });
    const model = new THREE.Mesh(geom, mat);
    model.userData.id = o.id;
    group.add(model);
    this.scene.add(group);
    this._pickables.push(model);

    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 1200), 3));
    trailGeo.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeo, new THREE.LineBasicMaterial({
      color: o.category === "weapon" ? 0xe8e8e8 : color, transparent: true, opacity: o.category === "weapon" ? 0.85 : 0.75,
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
    e = { group, model, trail, dome, label, color: sideColor(o) };
    this.objects.set(o.id, e);
    return e;
  }

  _remove(id) {
    const e = this.objects.get(id);
    if (!e) return;
    this.scene.remove(e.group, e.trail);
    if (e.dome) this.scene.remove(e.dome);
    e.trail.geometry.dispose();
    e.model.material.dispose();
    e.label.remove();
    this._pickables = this._pickables.filter((m) => m !== e.model);
    this.objects.delete(id);
  }

  /**
   * objects: [{id, category, type, lon, lat, alt, hdg, pitch, roll, trail, name, pilot,
   *            coalition, color, dead, lock, v:{EngagementRange}}]
   */
  update(objects, { focusId = null, selectedId = null } = {}) {
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
      e.model.material.color.set(o.dead ? 0x555555 : o.category === "weapon" ? 0xf2f2f2 : e.color);
      e.model.material.emissiveIntensity = o.id === focus.id || o.id === selectedId ? 0.8 : 0.35;
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
      const start = Math.max(0, tr.length - 400);
      let k = 0;
      for (let i = start; i < tr.length; i++) {
        const v = this.toLocal(tr[i][0], tr[i][1], tr[i][2]);
        arr[k++] = v.x; arr[k++] = v.y; arr[k++] = v.z;
      }
      arr[k++] = p.x; arr[k++] = p.y; arr[k++] = p.z;
      e.trail.geometry.setDrawRange(0, k / 3);
      e.trail.geometry.attributes.position.needsUpdate = true;
    }
    for (const id of [...this.objects.keys()]) if (!seen.has(id)) this._remove(id);

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
      if (this.mode === "chase") {
        const hdg = (focus.hdg || 0) * D2R;
        const back = 90, up = 22;
        const want = fp.clone().add(new THREE.Vector3(Math.sin(hdg) * -back, up, Math.cos(hdg) * back));
        // Smooth while flying; snap after a seek or when first entering chase.
        const snap = !this.lastFocusPos || this.camera.position.distanceTo(want) > 600;
        this.camera.position.lerp(want, snap ? 1 : 0.25);
        this.camera.lookAt(fp.clone().add(new THREE.Vector3(Math.sin(hdg) * 60, 4, -Math.cos(hdg) * 60)));
      }
      this.lastFocusPos = fp.clone();
    }
  }

  // -- render ------------------------------------------------------------------------

  render() {
    if (this.mode === "orbit") this.controls.update();
    const cam = this.camera.position;
    // Keep models visible at range: never smaller than ~1/150 of the distance.
    for (const e of this.objects.values()) {
      if (!e.pos) continue;
      const d = cam.distanceTo(e.pos);
      const cat = e.obj?.category;
      const div = cat === "weapon" ? 200 : ["fixedwing", "rotorcraft", "air"].includes(cat) ? 260 : 2500;
      const s = Math.min(cat === "sea" ? 6 : 60, Math.max(1, d / div));
      e.model.scale.setScalar(this.mode === "chase" && e.obj?.id === this.focusId ? 1 : s);
    }
    this.renderer.render(this.scene, this.camera);
    this._labels();
  }

  _labels() {
    const w = this.renderer.domElement.clientWidth, h = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
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
      if (hit && this.onPick) this.onPick(hit.object.userData.id);
    });
    el.addEventListener("pointerdown", () => { if (this.mode === "orbit") this.userMoved = true; });
  }
}
