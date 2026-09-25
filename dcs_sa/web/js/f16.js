// Procedural F-16 Fighting Falcon, built to real proportions
// (15.0 m long, 9.45 m span, 4.9 m tall).  Points north (-Z), up is +Y.

import * as THREE from "three";

/** Planform (seen from above) extruded to a thin slab.  pts: [x, forward] in metres. */
function planform(pts, thickness, y = 0) {
  const shape = new THREE.Shape(pts.map(([x, f]) => new THREE.Vector2(x, f)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateX(-Math.PI / 2); // shape (x, fwd) -> model (x, -z); extrusion -> +y
  g.translate(0, y - thickness / 2, 0);
  return g;
}

/** Side profile extruded sideways.  pts: [aft, up] in metres. */
function profile(pts, thickness) {
  const shape = new THREE.Shape(pts.map(([a, u]) => new THREE.Vector2(a, u)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  g.rotateY(-Math.PI / 2); // shape (aft, up) -> model (z, y); extrusion -> -x
  g.translate(thickness / 2, 0, 0);
  return g;
}

export function buildF16(color = new THREE.Color(0x4ea8ff)) {
  const group = new THREE.Group();
  // Air-superiority grey, lightly tinted towards the coalition colour so the
  // jet still reads as friend/foe at a glance.
  const grey = new THREE.Color(0x8e959c).lerp(color, 0.12);
  const body = new THREE.MeshPhongMaterial({ color: grey, emissive: color, emissiveIntensity: 0.08, shininess: 30, side: THREE.DoubleSide });
  const dark = new THREE.MeshPhongMaterial({ color: 0x3b3f44, shininess: 60 });
  const glass = new THREE.MeshPhongMaterial({ color: 0x6b5a2a, emissive: 0x2a2208, specular: 0xffffff, shininess: 120, transparent: true, opacity: 0.85 });
  const add = (geom, mat = body) => { const m = new THREE.Mesh(geom, mat); group.add(m); return m; };

  // Fuselage: lathe along the nose->tail axis, flattened (blended body).
  const prof = [
    [0.0, -7.5], [0.12, -7.3], [0.3, -6.8], [0.45, -6.1], [0.58, -5.2], [0.68, -4.2],
    [0.76, -3.0], [0.82, -1.5], [0.85, 0.5], [0.85, 3.5], [0.8, 5.0], [0.66, 6.3], [0.55, 6.9], [0.0, 6.9],
  ].map(([r, z]) => new THREE.Vector2(r, z));
  const fus = new THREE.LatheGeometry(prof, 20);
  fus.rotateX(Math.PI / 2);
  fus.scale(1.05, 0.82, 1);
  add(fus);

  // Dorsal spine behind the canopy, blending into the fin.
  const spine = new THREE.CylinderGeometry(0.34, 0.42, 6.5, 12, 1);
  spine.rotateX(Math.PI / 2);
  spine.scale(1, 0.8, 1);
  add(spine).position.set(0, 0.5, 1.4);

  // Bubble canopy.
  const canopy = new THREE.SphereGeometry(1, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2);
  canopy.scale(0.44, 0.52, 1.7);
  add(canopy, glass).position.set(0, 0.48, -3.7);

  // Chin intake: rounded duct under the forward fuselage, dark mouth.
  const intake = new THREE.CylinderGeometry(0.5, 0.58, 4.4, 16, 1, false);
  intake.rotateX(Math.PI / 2);
  intake.scale(1.05, 0.72, 1);
  add(intake).position.set(0, -0.62, -0.9);
  const mouth = new THREE.CircleGeometry(0.46, 16);
  mouth.scale(1.05, 0.72, 1);
  add(mouth, dark).position.set(0, -0.62, -3.11);
  group.children[group.children.length - 1].rotation.y = Math.PI;

  // Cropped-delta wings (40 deg leading-edge sweep) with LERX strakes.
  const wingR = [[0.75, 0.9], [4.72, -2.4], [4.72, -3.55], [0.75, -3.6]];
  add(planform(wingR, 0.16, -0.05));
  add(planform(wingR.map(([x, f]) => [-x, f]), 0.16, -0.05));
  const lerx = [[0.6, 4.6], [1.25, 0.9], [0.6, 0.9]];
  add(planform(lerx, 0.1, 0.05));
  add(planform(lerx.map(([x, f]) => [-x, f]), 0.1, 0.05));

  // All-moving horizontal stabilators with slight anhedral.
  const stab = [[0.55, -4.5], [2.95, -6.35], [2.95, -7.1], [0.55, -7.05]];
  const sR = add(planform(stab, 0.1, 0));
  const sL = add(planform(stab.map(([x, f]) => [-x, f]), 0.1, 0));
  sR.rotation.z = -0.1;
  sL.rotation.z = 0.1;
  sR.position.y = sL.position.y = -0.05;

  // Single vertical tail.
  add(profile([[3.4, 0.55], [6.3, 4.05], [7.15, 4.05], [7.0, 0.55]], 0.14));

  // Ventral fins, canted outwards.
  const ventral = [[4.6, -0.45], [5.8, -1.15], [6.3, -1.15], [6.2, -0.45]];
  const vR = add(profile(ventral, 0.06)); vR.position.x = 0.55; vR.rotation.z = 0.35;
  const vL = add(profile(ventral, 0.06)); vL.position.x = -0.55; vL.rotation.z = -0.35;

  // Engine nozzle.
  const noz = new THREE.CylinderGeometry(0.5, 0.56, 1.0, 16, 1, true);
  noz.rotateX(Math.PI / 2);
  add(noz, dark).position.set(0, 0, 7.3);

  // Wingtip AIM-9s on the launch rails.
  const aim9 = new THREE.CylinderGeometry(0.065, 0.065, 2.9, 8);
  aim9.rotateX(Math.PI / 2);
  for (const side of [1, -1]) add(aim9, dark).position.set(side * 4.84, -0.05, 2.45);

  group.userData.bodyMaterial = body;
  return group;
}

/** True when a DCS / Tacview type name is an F-16 variant. */
export const isF16 = (name) => /\bF-?16/i.test(name || "");
