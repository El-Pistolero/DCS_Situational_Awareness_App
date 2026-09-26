// Heat (IR) in the 3D view: flares and chaff, a glowing nose on heat-seekers,
// and engine heat behind jets.
//
// The same honesty rules as the map: an afterburner flame is drawn only when
// afterburner is known to be lit (recorded engine data); otherwise the jet
// gets a faint dry haze, never a guessed flame.

import * as THREE from "three";

const FLARE_LIFE = 9;

/** Points clouds for flares (additive, white-hot fading to amber) and chaff (grey specks). */
export function makeCountermeasureClouds() {
  const geo = () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3 * 256), 3));
    g.setAttribute("color", new THREE.BufferAttribute(new Float32Array(3 * 256), 3));
    g.setDrawRange(0, 0);
    return g;
  };
  const flares = new THREE.Points(geo(), new THREE.PointsMaterial({
    size: 5, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const chaff = new THREE.Points(geo(), new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, color: 0x9aa4b1 }));
  flares.frustumCulled = chaff.frustumCulled = false;
  return { flares, chaff };
}

function grow(g, n) {
  for (const name of ["position", "color"]) {
    const a = g.attributes[name];
    if (a.count >= n) continue;
    let cap = a.count;
    while (cap < n) cap *= 2;
    const arr = new Float32Array(cap * 3);
    arr.set(a.array);
    g.setAttribute(name, new THREE.BufferAttribute(arr, 3));
  }
}

const HOT = new THREE.Color(0xfff1c9), EMBER = new THREE.Color(0xff9f43);
const tmp = new THREE.Color();

/**
 * Put this frame's countermeasures into the clouds.
 * items: scene rows with category "countermeasure" (cmKind, age); toLocal(lon, lat, alt, out).
 */
export function fillCountermeasures(clouds, items, toLocal) {
  const v = new THREE.Vector3();
  let nf = 0, nc = 0;
  for (const o of items) {
    const chaff = o.cmKind === "chaff";
    const g = (chaff ? clouds.chaff : clouds.flares).geometry;
    const k = chaff ? nc++ : nf++;
    grow(g, k + 1);
    toLocal(o.lon, o.lat, o.alt, v);
    g.attributes.position.array.set([v.x, v.y, v.z], k * 3);
    // A burning flare fades from white-hot to a dim ember over its life.
    const life = Number.isFinite(o.age) ? Math.max(0, 1 - o.age / FLARE_LIFE) : 1;
    tmp.copy(EMBER).lerp(HOT, life).multiplyScalar(0.35 + 0.65 * life);
    g.attributes.color.array.set([tmp.r, tmp.g, tmp.b], k * 3);
  }
  for (const [cloud, n] of [[clouds.flares, nf], [clouds.chaff, nc]]) {
    cloud.geometry.setDrawRange(0, n);
    cloud.geometry.attributes.position.needsUpdate = true;
    cloud.geometry.attributes.color.needsUpdate = true;
  }
}

/** A heat-seeker's nose: a small glowing ball on the model (models point north, -Z). */
export function markHeatSeeker(e) {
  if (e.irNose) return;
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.35, 10, 8),
    new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false }));
  nose.position.set(0, 0, -2.0);
  e.model.add(nose);
  e.irNose = nose;
}

/**
 * Engine heat behind a jet, from DCS's coefficient: a cone out of the tail,
 * 8 m x sqrt(C) long (scaled with the model).  hn: {c, lit} from heatNow(),
 * or null to hide it.  A flame only when afterburner is known to be lit.
 */
export function updatePlume(e, hn) {
  if (!hn) { if (e.plume) e.plume.visible = false; return; }
  if (!e.plume) {
    const geo = new THREE.ConeGeometry(0.55, 1, 16, 1, true).rotateX(-Math.PI / 2).translate(0, 0, 0.5); // apex aft (+Z)
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    const plume = new THREE.Mesh(geo, mat);
    // At the nozzle: the F-16 model's ends at z = 7.8, the generic jet's tail at 7.
    plume.position.set(0, 0, e.f16 ? 7.8 : 7.0);
    e.model.add(plume);
    e.plume = plume;
  }
  const lit = hn.lit === true;
  e.plume.visible = true;
  e.plume.scale.set(lit ? 1.0 : 0.8, lit ? 1.0 : 0.8, 8 * Math.sqrt(hn.c) * (lit ? 1.3 : 0.6));
  e.plume.material.color.set(lit ? 0xfff4d6 : 0xff9f43);
  e.plume.material.opacity = lit ? 0.75 : 0.18;
}

export function disposeIR(e) {
  for (const m of [e.plume, e.irNose]) {
    if (!m) continue;
    m.geometry.dispose();
    m.material.dispose();
  }
}
