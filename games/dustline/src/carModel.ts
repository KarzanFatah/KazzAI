import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { hash2 } from "./noise";

/** Wheel layout shared with the physics: [x (right = -x), z (forward)] per wheel FL, FR, RL, RR. */
export const WHEEL_POS: [number, number][] = [
  [0.78, 1.38],
  [-0.78, 1.38],
  [0.78, -1.32],
  [-0.78, -1.32],
];
export const WHEEL_RADIUS = 0.36;

const W = 1.76; // body width without bevel
const HALF = W / 2 + 0.04; // side panel position (half width + bevel)
const ARCH_R = 0.43;
const BELT = 0.96; // top of the doors, where the glasshouse starts
const CW = 1.56; // cabin width at the belt line (without bevel)

/** Half width of the cabin side at height y: the glasshouse leans inwards (tumblehome). */
function cabinHalf(y: number): number {
  const t = Math.min(Math.max((y - BELT) / 0.5, 0), 1);
  return (CW / 2 + 0.03) * (1 - 0.12 * t);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3(1, 1, 1);

/** Collects static parts per material and merges each set into one mesh (one draw call each). */
class PartSet {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(mat: THREE.Material, geo: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.clearGroups();
    g.applyMatrix4(_m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s));
    let list = this.parts.get(mat);
    if (!list) this.parts.set(mat, (list = []));
    list.push(g);
  }

  box(mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(mat, new THREE.BoxGeometry(sx, sy, sz), x, y, z, rx, ry, rz);
  }

  /** The same part on both sides of the car (x and -x). */
  pair(mat: THREE.Material, geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): void {
    this.add(mat, geo, x, y, z, rx, ry, rz);
    this.add(mat, geo, -x, y, z, rx, -ry, -rz);
  }

  build(parent: THREE.Object3D, onGeometry?: (mat: THREE.Material, geo: THREE.BufferGeometry) => void): void {
    for (const [mat, list] of this.parts) {
      const geo = mergeGeometries(list);
      onGeometry?.(mat, geo);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
  }
}

/** Flat polygon given as (z, y) points, placed on the cabin side at x = side * (cabinHalf(y) + out). */
function cabinSidePanel(pts: [number, number][], side: number, out: number): THREE.BufferGeometry {
  const geo = new THREE.ShapeGeometry(new THREE.Shape(pts.map(([z, y]) => new THREE.Vector2(z, y))));
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getX(i);
    const y = pos.getY(i);
    pos.setXYZ(i, side * (cabinHalf(y) + out), y, z);
  }
  // The shape faces local +z, which maps to -x: flip the winding on the +x side.
  if (side > 0) geo.index!.array.reverse();
  geo.computeVertexNormals();
  return geo;
}

/**
 * Quad on a sloped window line from (z0, y0) to (z1, y1) with z1 < z0 (so it faces up and out),
 * spanning fractions f0..f1 of the line, inset by `pillar` at the sides and `out` off the line.
 */
function slopedGlass(z0: number, y0: number, z1: number, y1: number, f0: number, f1: number, pillar: number, out: number): THREE.BufferGeometry {
  const len = Math.hypot(z1 - z0, y1 - y0);
  const nz = (y1 - y0) / len;
  const ny = (z0 - z1) / len;
  const pt = (f: number) => [z0 + (z1 - z0) * f + nz * out, y0 + (y1 - y0) * f + ny * out] as const;
  const [za, ya] = pt(f0);
  const [zb, yb] = pt(f1);
  const xa = cabinHalf(ya) - pillar;
  const xb = cabinHalf(yb) - pillar;
  const geo = new THREE.BufferGeometry();
  const v = [-xa, ya, za, xa, ya, za, xb, yb, zb, -xa, ya, za, xb, yb, zb, -xb, yb, zb];
  geo.setAttribute("position", new THREE.Float32BufferAttribute(v, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(new Array(12).fill(0), 2));
  geo.computeVertexNormals();
  return geo;
}

/** Cream paint with a dusty lower body, spray behind the wheels and a few streaks. */
function makeDirtTexture(): THREE.CanvasTexture {
  const w = 256;
  const h = 128;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#efe7d4";
  g.fillRect(0, 0, w, h);
  // Dust builds up towards the sills (canvas y grows downwards = lower on the car).
  const grad = g.createLinearGradient(0, h * 0.35, 0, h);
  grad.addColorStop(0, "rgba(176,140,96,0)");
  grad.addColorStop(0.55, "rgba(176,140,96,0.45)");
  grad.addColorStop(1, "rgba(150,116,78,0.9)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  // Spray fanning out behind each wheel (u runs from the rear bumper to the front).
  for (const wz of [WHEEL_POS[0][1], WHEEL_POS[2][1]]) {
    const cx = ((wz + 2.4) / 4.8) * w;
    const cy = (1 - (WHEEL_RADIUS - 0.25) / 1.3) * h;
    const spray = g.createRadialGradient(cx - 18, cy, 4, cx - 18, cy, 46);
    spray.addColorStop(0, "rgba(140,105,70,0.55)");
    spray.addColorStop(1, "rgba(140,105,70,0)");
    g.fillStyle = spray;
    g.fillRect(0, 0, w, h);
  }
  // Speckles and short vertical streaks.
  for (let i = 0; i < 900; i++) {
    const x = hash2(i, 1, 7) * w;
    const y = h * (0.3 + 0.7 * Math.sqrt(hash2(i, 2, 7)));
    g.fillStyle = `rgba(${120 + hash2(i, 3, 7) * 50},${95 + hash2(i, 4, 7) * 35},70,${0.12 + hash2(i, 5, 7) * 0.25})`;
    g.fillRect(x, y, 1 + hash2(i, 6, 7) * 2, 1 + hash2(i, 8, 7) * (i % 7 === 0 ? 14 : 2));
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Made-up rear licence plate. */
function makePlateTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 32;
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#e9e3cf";
  g.fillRect(0, 0, 128, 32);
  g.strokeStyle = "#2a2a2a";
  g.lineWidth = 2;
  g.strokeRect(2, 2, 124, 28);
  g.fillStyle = "#1f1f22";
  g.font = "bold 20px monospace";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("DL·4827", 64, 17);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Tyre cross-section turned around the axle: rounded shoulders and bulging sidewalls. */
function tyreGeometry(): THREE.BufferGeometry {
  const r = WHEEL_RADIUS;
  const pts = [
    [0.235, -0.105],
    [0.29, -0.128],
    [r - 0.025, -0.122],
    [r - 0.004, -0.095],
    [r, -0.06],
    [r, 0.06],
    [r - 0.004, 0.095],
    [r - 0.025, 0.122],
    [0.29, 0.128],
    [0.235, 0.105],
  ].map(([x, y]) => new THREE.Vector2(x, y));
  const geo = new THREE.LatheGeometry(pts, 20);
  geo.rotateZ(Math.PI / 2); // axle along x
  return geo;
}

/**
 * A slightly battered 1970s/80s boxy sedan (generic) with roof rack and spare tyre.
 * Static parts are merged per material. root sits on the ground between the wheels and faces
 * +Z. `body` is the sprung part.
 */
export class CarModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  private readonly steerPivots: THREE.Group[] = [];
  private readonly brakeLights: THREE.MeshStandardMaterial;

  constructor(paint = 0xffffff) {
    this.root.add(this.body);
    const paintMat = new THREE.MeshPhysicalMaterial({
      color: paint,
      map: makeDirtTexture(),
      roughness: 0.5,
      metalness: 0,
      clearcoat: 0.35,
      clearcoatRoughness: 0.35,
    });
    const glass = new THREE.MeshStandardMaterial({ color: 0x141c22, roughness: 0.06, metalness: 0.55 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xdfe3e6, roughness: 0.18, metalness: 1 });
    const trim = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.65 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x1d1d1f, roughness: 0.92 });
    const rim = new THREE.MeshStandardMaterial({ color: 0xb9bcbf, roughness: 0.35, metalness: 0.8 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xf4f0e2, emissive: 0x3a3424, roughness: 0.08, metalness: 0.3 });
    const amber = new THREE.MeshStandardMaterial({ color: 0xe08a1e, emissive: 0x3a1c00, roughness: 0.2 });
    const plate = new THREE.MeshStandardMaterial({ map: makePlateTexture(), roughness: 0.6 });
    const olive = new THREE.MeshStandardMaterial({ color: 0x5b6b3a, roughness: 0.8 });
    this.brakeLights = new THREE.MeshStandardMaterial({ color: 0xb3221c, emissive: 0x3a0505, roughness: 0.25 });
    const parts = new PartSet();

    // Lower body: side profile (z forward, y up) with wheel arches, extruded across the width.
    const lower = new THREE.Shape();
    const [, frontZ] = WHEEL_POS[0];
    const [, rearZ] = WHEEL_POS[2];
    lower.moveTo(-2.28, 0.36);
    lower.lineTo(rearZ - ARCH_R, 0.36);
    lower.absarc(rearZ, 0.36, ARCH_R, Math.PI, 0, true);
    lower.lineTo(frontZ - ARCH_R, 0.36);
    lower.absarc(frontZ, 0.36, ARCH_R, Math.PI, 0, true);
    lower.lineTo(2.27, 0.36);
    lower.lineTo(2.3, 0.5);
    lower.lineTo(2.3, 0.77);
    lower.lineTo(2.24, 0.85); // hood lip
    lower.lineTo(0.98, 0.92); // hood
    lower.lineTo(-1.4, 0.93);
    lower.lineTo(-2.22, 0.91); // boot lid
    lower.lineTo(-2.3, 0.82);
    lower.lineTo(-2.3, 0.45);
    lower.closePath();
    const lowerGeo = new THREE.ExtrudeGeometry(lower, {
      depth: W,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 2,
      curveSegments: 8,
    });
    lowerGeo.translate(0, 0, -W / 2);
    lowerGeo.rotateY(-Math.PI / 2); // profile x -> world z
    parts.add(paintMat, lowerGeo);

    // Glasshouse: painted roof and pillars, leaning inwards; glass panels sit just proud of it.
    const cab = new THREE.Shape();
    cab.moveTo(1.0, 0.94);
    cab.lineTo(0.28, 1.42);
    cab.lineTo(-0.86, 1.44);
    cab.lineTo(-1.46, 0.94);
    cab.closePath();
    const cabGeo = new THREE.ExtrudeGeometry(cab, {
      depth: CW,
      bevelEnabled: true,
      bevelThickness: 0.03,
      bevelSize: 0.03,
      bevelSegments: 1,
    });
    cabGeo.translate(0, 0, -CW / 2);
    cabGeo.rotateY(-Math.PI / 2);
    const cp = cabGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) {
      const y = cp.getY(i);
      cp.setX(i, (cp.getX(i) * cabinHalf(y)) / cabinHalf(BELT));
    }
    cabGeo.computeVertexNormals();
    parts.add(paintMat, cabGeo);

    for (const side of [1, -1]) {
      // Front and rear door glass, split by the B pillar.
      parts.add(glass, cabinSidePanel([[0.84, 0.99], [0.24, 1.38], [-0.2, 1.38], [-0.2, 0.99]], side, 0.01));
      parts.add(glass, cabinSidePanel([[-0.32, 0.99], [-0.32, 1.38], [-0.8, 1.38], [-1.27, 0.99]], side, 0.01));
    }
    parts.add(glass, slopedGlass(1.0, 0.94, 0.28, 1.42, 0.06, 0.92, 0.09, 0.035)); // windscreen
    parts.add(glass, slopedGlass(-0.86, 1.44, -1.46, 0.94, 0.1, 0.92, 0.11, 0.035)); // rear window

    // Chrome belt line, window top trims and wipers.
    const beltX = cabinHalf(BELT) + 0.015;
    parts.pair(chrome, new THREE.BoxGeometry(0.02, 0.025, 2.3), beltX, BELT + 0.01, -0.22);
    parts.pair(chrome, new THREE.BoxGeometry(0.015, 0.02, 1.02), cabinHalf(1.39) + 0.012, 1.395, -0.28);
    parts.box(chrome, 1.3, 0.02, 0.025, 0, 0.965, 1.045);
    parts.box(chrome, 1.25, 0.02, 0.025, 0, 0.975, -1.505);
    parts.box(trim, 0.5, 0.012, 0.02, 0.2, 1.03, 0.95, 0, 0.25, 0);
    parts.box(trim, 0.5, 0.012, 0.02, -0.38, 1.03, 0.95, 0, 0.25, 0);

    // Panel gaps: door cut lines and the boot / bonnet shut lines.
    const gap = (sy: number, z: number, y: number) =>
      parts.pair(trim, new THREE.BoxGeometry(0.006, sy, 0.012), HALF + 0.001, y, z);
    gap(0.56, 0.92, 0.66); // front door, front edge
    gap(0.58, -0.26, 0.66); // between the doors
    gap(0.26, -0.87, 0.8); // rear door, rear edge above the arch
    parts.pair(trim, new THREE.BoxGeometry(0.006, 0.012, 1.8), HALF + 0.001, 0.375, 0.03); // sill
    parts.box(trim, 1.62, 0.006, 0.012, 0, 0.97, -1.58); // boot lid
    parts.box(trim, 1.66, 0.006, 0.012, 0, 0.957, 1.1); // bonnet

    // Rubbing strip along the doors, handles and mirrors.
    parts.pair(trim, new THREE.BoxGeometry(0.02, 0.045, 1.66), HALF + 0.01, 0.6, 0.02);
    parts.pair(chrome, new THREE.BoxGeometry(0.022, 0.01, 1.66), HALF + 0.012, 0.628, 0.02);
    parts.pair(chrome, new THREE.BoxGeometry(0.03, 0.03, 0.13), HALF + 0.012, 0.84, -0.08);
    parts.pair(chrome, new THREE.BoxGeometry(0.03, 0.03, 0.13), HALF + 0.012, 0.84, -0.7);
    parts.pair(trim, new THREE.BoxGeometry(0.12, 0.03, 0.04), cabinHalf(1.02) + 0.06, 1.02, 0.78);
    parts.pair(chrome, new THREE.BoxGeometry(0.07, 0.09, 0.13), cabinHalf(1.02) + 0.14, 1.05, 0.76, 0, 0.12, 0);

    // Front: recessed black grille with chrome surround and slats, twin round headlights.
    const nose = 2.34;
    parts.box(trim, 0.84, 0.19, 0.04, 0, 0.65, nose);
    parts.box(chrome, 0.9, 0.02, 0.03, 0, 0.755, nose + 0.01);
    parts.box(chrome, 0.9, 0.02, 0.03, 0, 0.545, nose + 0.01);
    for (const y of [0.6, 0.65, 0.7]) parts.box(chrome, 0.84, 0.01, 0.02, 0, y, nose + 0.012);
    const bezel = new THREE.BoxGeometry(0.42, 0.2, 0.03);
    const lens = new THREE.CylinderGeometry(0.072, 0.072, 0.03, 16);
    parts.pair(chrome, bezel, 0.67, 0.65, nose + 0.005);
    for (const x of [0.57, 0.77]) parts.pair(lamp, lens, x, 0.65, nose + 0.02, Math.PI / 2);
    parts.pair(amber, new THREE.BoxGeometry(0.16, 0.035, 0.03), 0.66, 0.53, nose + 0.01);
    parts.pair(amber, new THREE.BoxGeometry(0.01, 0.04, 0.08), HALF + 0.004, 0.72, 1.98); // side repeaters

    // Rear: tail light clusters (red, amber, reversing), plate and exhaust.
    const tail = -2.34;
    parts.pair(chrome, new THREE.BoxGeometry(0.46, 0.18, 0.02), 0.6, 0.7, tail - 0.005);
    parts.pair(this.brakeLights, new THREE.BoxGeometry(0.26, 0.15, 0.03), 0.56, 0.7, tail - 0.012);
    parts.pair(amber, new THREE.BoxGeometry(0.1, 0.15, 0.03), 0.76, 0.7, tail - 0.012);
    parts.pair(lamp, new THREE.BoxGeometry(0.06, 0.15, 0.03), 0.4, 0.7, tail - 0.012);
    const plateGeo = new THREE.PlaneGeometry(0.5, 0.125);
    parts.add(plate, plateGeo, 0, 0.62, tail - 0.012, 0, Math.PI, 0);
    parts.add(trim, new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8), 0.48, 0.3, tail - 0.04, Math.PI / 2);

    // Chrome bumpers wrapping round the corners, with rubber-capped overriders.
    for (const end of [1, -1]) {
      const z = end * 2.41;
      parts.box(chrome, W + 0.02, 0.13, 0.1, 0, 0.44, z);
      parts.pair(chrome, new THREE.BoxGeometry(0.09, 0.13, 0.3), HALF - 0.02, 0.44, end * 2.27, 0, end * 0.18, 0);
      parts.box(trim, 1.2, 0.025, 0.012, 0, 0.44, z + end * 0.052);
      parts.pair(chrome, new THREE.BoxGeometry(0.07, 0.22, 0.09), 0.42, 0.46, z + end * 0.06);
      parts.pair(trim, new THREE.BoxGeometry(0.075, 0.05, 0.095), 0.42, 0.56, z + end * 0.06);
    }

    // Dark wheel wells behind the arches, and mudflaps behind every wheel.
    for (const z of [frontZ, rearZ]) {
      parts.box(trim, 1.26, 0.4, ARCH_R * 2 - 0.04, 0, 0.58, z);
      parts.pair(rubber, new THREE.BoxGeometry(0.26, 0.22, 0.012), 0.78, 0.25, z - ARCH_R - 0.04);
    }

    // Roof rack with a spare tyre and a jerrycan (the car's signature).
    const rackY = 1.53;
    for (const z of [0.12, -0.86]) {
      parts.box(trim, CW + 0.06, 0.04, 0.05, 0, rackY, z);
      parts.pair(trim, new THREE.BoxGeometry(0.05, 0.08, 0.05), cabinHalf(1.44) - 0.02, rackY - 0.04, z);
    }
    parts.pair(trim, new THREE.BoxGeometry(0.04, 0.04, 1.14), 0.7, rackY + 0.04, -0.37);
    const spare = tyreGeometry();
    parts.add(rubber, spare, -0.25, rackY + 0.15, -0.4, 0, 0, Math.PI / 2);
    parts.add(rim, new THREE.CylinderGeometry(0.22, 0.22, 0.2, 14), -0.25, rackY + 0.15, -0.4);
    parts.box(trim, 0.03, 0.02, 0.8, -0.25, rackY + 0.28, -0.4);
    parts.box(olive, 0.3, 0.22, 0.42, 0.42, rackY + 0.13, -0.45);
    parts.box(olive, 0.06, 0.04, 0.16, 0.42, rackY + 0.26, -0.33);

    // Planar side projection for the dirt texture on the paintwork.
    parts.build(this.body, (mat, geo) => {
      if (mat !== paintMat) return;
      const pos = geo.attributes.position as THREE.BufferAttribute;
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getZ(i) + 2.4) / 4.8, (pos.getY(i) - 0.25) / 1.3);
    });

    // Wheels: steer pivot (front) -> spin group -> wheel (tyre with dark dish + spoked rim).
    // The template faces its rim towards +x; right-hand wheels are turned round.
    const wheelParts = new PartSet();
    wheelParts.add(rubber, tyreGeometry());
    wheelParts.add(rubber, new THREE.CylinderGeometry(0.235, 0.235, 0.2, 18), 0, 0, 0, 0, 0, Math.PI / 2);
    wheelParts.add(rim, new THREE.TorusGeometry(0.222, 0.016, 6, 20), 0.1, 0, 0, 0, Math.PI / 2, 0);
    for (let k = 0; k < 5; k++) {
      const a = (k / 5) * Math.PI * 2;
      wheelParts.add(rim, new THREE.BoxGeometry(0.03, 0.055, 0.2), 0.095, Math.sin(a) * 0.11, Math.cos(a) * 0.11, -a, 0, 0);
    }
    wheelParts.add(rim, new THREE.CylinderGeometry(0.06, 0.07, 0.04, 12), 0.11, 0, 0, 0, 0, Math.PI / 2);
    const wheelTemplate = new THREE.Group();
    wheelParts.build(wheelTemplate);
    WHEEL_POS.forEach(([x, z], i) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_RADIUS, z);
      const spin = new THREE.Group();
      const wheel = wheelTemplate.clone();
      if (x < 0) wheel.rotation.y = Math.PI;
      spin.add(wheel);
      pivot.add(spin);
      this.root.add(pivot);
      this.wheels.push(spin);
      if (i < 2) this.steerPivots.push(pivot);
    });
  }

  /**
   * steer = front wheel angle (rad), spin = wheel rotation (rad), roll/pitch = body lean (rad),
   * squat = body vertical offset (m), braking lights the brake lamps.
   */
  pose(steer: number, spin: number, roll: number, pitch: number, squat: number, braking: boolean): void {
    for (const p of this.steerPivots) p.rotation.y = steer;
    for (const w of this.wheels) w.rotation.x = spin;
    this.body.rotation.set(pitch, 0, roll, "YXZ");
    this.body.position.y = squat;
    this.brakeLights.emissive.setHex(braking ? 0xff2a1a : 0x3a0505);
  }
}
