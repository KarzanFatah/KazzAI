import * as THREE from "three";
import { makeCamoTexture } from "./textures";
import type { CharacterAnimState, WeaponDef } from "./types";

type WeaponId = WeaponDef["id"];

const TAU = Math.PI * 2;

// Proportions in metres (~1.85 m to the top of the helmet). Model space: +Z forward, -X = right.
const HIPS_HEIGHT = 0.96;
const CROUCH_DROP = 0.45;
const SLIDE_DROP = 0.5;
const HIP_JOINT_X = 0.1;
const HIP_JOINT_Y = -0.03;
const THIGH_LEN = 0.43;
const SHIN_LEN = 0.43;
const ANKLE_HEIGHT = 0.085;
const SPINE_Y = 0.1;
const CHEST_Y = 0.15;
const SHOULDER_X = 0.2;
const SHOULDER_Y = 0.26;
const NECK_Y = 0.31;
const UPPER_ARM_LEN = 0.29;
const FOREARM_LEN = 0.31; // elbow to palm centre

const PUMP_TIME = 0.32;
const PUMP_TRAVEL = 0.085;
const PUMP_DELAY_AFTER_SHOT = 0.16;
const SLIDE_TIME = 0.1;
const SLIDE_TRAVEL = 0.03;

const clamp = THREE.MathUtils.clamp;
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth01 = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach of `current` toward `target`. */
const damp = (current: number, target: number, rate: number, dt: number): number =>
  target + (current - target) * Math.exp(-rate * dt);
const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

/** Back-and-forth travel (0 → 1 → 0) of a pump or slide for normalised time u. */
function cycleTravel(u: number, backFraction: number): number {
  if (!(u >= 0 && u < 1)) return 0;
  return u < backFraction
    ? smooth01(u / backFraction)
    : 1 - smooth01((u - backFraction) / (1 - backFraction));
}

/** Under-damped scalar spring resting at 0, used for recoil kicks. */
class Spring {
  value = 0;
  private velocity = 0;

  constructor(
    private readonly omega: number,
    private readonly zeta: number,
  ) {}

  /** Velocity impulse sized so the peak displacement is roughly `peak`. */
  kick(peak: number): void {
    this.velocity += peak * this.omega * 1.85;
  }

  update(dt: number): void {
    const k = this.omega * this.omega;
    const c = 2 * this.zeta * this.omega;
    // Small semi-implicit steps keep the stiff spring stable at low frame rates.
    for (let left = dt; left > 1e-6; left -= 1 / 120) {
      const h = Math.min(left, 1 / 120);
      this.velocity += (-k * this.value - c * this.velocity) * h;
      this.value += this.velocity * h;
    }
  }
}

// Reused temporaries (no allocations per frame).
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _grip = new THREE.Vector3();
const _support = new THREE.Vector3();
const _target = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _joint = new THREE.Vector3();
const _shoulderL = new THREE.Vector3();
const _shoulderR = new THREE.Vector3();
const _keyA = new THREE.Vector3();
const _keyB = new THREE.Vector3();
const _qUpper = new THREE.Quaternion();
const _qLower = new THREE.Quaternion();
const _qTmp = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, "YXZ");
const _ikDir = new THREE.Vector3();
const _ikBend = new THREE.Vector3();
const _ikMid = new THREE.Vector3();
const _ikEnd = new THREE.Vector3();
const _boneX = new THREE.Vector3();
const _boneY = new THREE.Vector3();
const _boneZ = new THREE.Vector3();
const _basis = new THREE.Matrix4();

/** Orientation of a bone running from `from` to `to` along its local -Y, local +Z toward `bend`. */
function boneOrientation(
  from: THREE.Vector3,
  to: THREE.Vector3,
  bend: THREE.Vector3,
  out: THREE.Quaternion,
): void {
  const y = _boneY.subVectors(from, to).normalize();
  const z = _boneZ.copy(bend).addScaledVector(y, -bend.dot(y)).normalize();
  const x = _boneX.crossVectors(y, z);
  out.setFromRotationMatrix(_basis.makeBasis(x, y, z));
}

/**
 * Analytic two-bone IK, everything in one coordinate frame. The middle joint is pushed toward
 * `pole`. Writes the orientation of both bones (bones extend along local -Y).
 */
function solveTwoBone(
  root: THREE.Vector3,
  target: THREE.Vector3,
  pole: THREE.Vector3,
  upperLen: number,
  lowerLen: number,
  outUpper: THREE.Quaternion,
  outLower: THREE.Quaternion,
): void {
  const dir = _ikDir.subVectors(target, root);
  const rawDist = dir.length();
  if (rawDist < 1e-5) dir.set(0, -1, 0);
  else dir.divideScalar(rawDist);
  const dist = clamp(rawDist, Math.abs(upperLen - lowerLen) + 1e-3, (upperLen + lowerLen) * 0.999);

  const bend = _ikBend.copy(pole).addScaledVector(dir, -pole.dot(dir));
  if (bend.lengthSq() < 1e-8) bend.set(0, 0, 1).addScaledVector(dir, -dir.z);
  bend.normalize();

  const cosA = clamp(
    (upperLen * upperLen + dist * dist - lowerLen * lowerLen) / (2 * upperLen * dist),
    -1,
    1,
  );
  const sinA = Math.sqrt(1 - cosA * cosA);
  const mid = _ikMid
    .copy(root)
    .addScaledVector(dir, cosA * upperLen)
    .addScaledVector(bend, sinA * upperLen);
  const end = _ikEnd.copy(root).addScaledVector(dir, dist);
  boneOrientation(root, mid, bend, outUpper);
  boneOrientation(mid, end, bend, outLower);
}

// ---------------------------------------------------------------------------------------------
// Materials and primitive parts

function createMaterials() {
  const std = (color: number, roughness: number, metalness = 0) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    camo: new THREE.MeshStandardMaterial({ map: makeCamoTexture(), roughness: 0.85 }),
    vest: std(0x1b1d20, 0.8),
    pouch: std(0x5d6268, 0.85),
    pouchDark: std(0x3d4147, 0.85),
    pack: std(0x2a2d32, 0.8),
    trousers: std(0x3a3f46, 0.9),
    kneePad: std(0x202225, 0.6),
    boots: std(0x17181a, 0.65),
    sole: std(0x0c0d0e, 0.9),
    gloves: std(0x1a1b1d, 0.7),
    helmet: std(0xe8eaed, 0.5),
    helmetTrim: std(0xc2c7cd, 0.6),
    gear: std(0x2b2e33, 0.7),
    lens: std(0x0d1013, 0.15, 0.6),
    skin: std(0xc49478, 0.75),
    gunMetal: std(0x26282c, 0.42, 0.55),
    gunPolymer: std(0x303237, 0.68, 0.1),
    shell: std(0xb3241c, 0.55),
    brass: std(0xc9a24a, 0.35, 0.8),
  };
}

type Materials = ReturnType<typeof createMaterials>;
type Axis = "x" | "y" | "z";

/** Builds the primitive meshes the soldier and guns are made of; owns their geometries. */
class PartFactory {
  private readonly geometries = new Map<string, THREE.BufferGeometry>();

  box(
    parent: THREE.Object3D,
    mat: THREE.Material,
    w: number,
    h: number,
    d: number,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh {
    const geo = this.geometry(`box${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
    return this.mesh(parent, geo, mat, x, y, z);
  }

  /** Cylinder whose length runs along `axis` (the top radius points to +axis). */
  cylinder(
    parent: THREE.Object3D,
    mat: THREE.Material,
    radius: number,
    length: number,
    x = 0,
    y = 0,
    z = 0,
    axis: Axis = "y",
    radiusBottom = radius,
    segments = 10,
  ): THREE.Mesh {
    const key = `cyl${radius},${radiusBottom},${length},${axis},${segments}`;
    const geo = this.geometry(key, () => {
      const g = new THREE.CylinderGeometry(radius, radiusBottom, length, segments);
      if (axis === "x") g.rotateZ(-Math.PI / 2);
      if (axis === "z") g.rotateX(Math.PI / 2);
      return g;
    });
    return this.mesh(parent, geo, mat, x, y, z);
  }

  /** Capsule along Y; `length` includes the caps. */
  capsule(
    parent: THREE.Object3D,
    mat: THREE.Material,
    radius: number,
    length: number,
    x = 0,
    y = 0,
    z = 0,
  ): THREE.Mesh {
    const geo = this.geometry(
      `cap${radius},${length}`,
      () => new THREE.CapsuleGeometry(radius, Math.max(length - 2 * radius, 0.001), 4, 10),
    );
    return this.mesh(parent, geo, mat, x, y, z);
  }

  /** Sphere, or a cap of one when thetaLength < π (measured down from the top). */
  sphere(
    parent: THREE.Object3D,
    mat: THREE.Material,
    radius: number,
    x = 0,
    y = 0,
    z = 0,
    thetaLength = Math.PI,
  ): THREE.Mesh {
    const geo = this.geometry(
      `sph${radius},${thetaLength}`,
      () => new THREE.SphereGeometry(radius, 18, 10, 0, TAU, 0, thetaLength),
    );
    return this.mesh(parent, geo, mat, x, y, z);
  }

  dispose(): void {
    for (const geo of this.geometries.values()) geo.dispose();
    this.geometries.clear();
  }

  private geometry(key: string, create: () => THREE.BufferGeometry): THREE.BufferGeometry {
    let geo = this.geometries.get(key);
    if (!geo) {
      geo = create();
      this.geometries.set(key, geo);
    }
    return geo;
  }

  private mesh(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  }
}

function anchor(parent: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  const obj = new THREE.Object3D();
  obj.position.set(x, y, z);
  parent.add(obj);
  return obj;
}

// ---------------------------------------------------------------------------------------------
// Body

/** Two-bone chain: `upper` sits at the joint, bones extend along local -Y. */
interface Limb {
  upper: THREE.Group;
  lower: THREE.Group;
  end: THREE.Group;
  upperLen: number;
  lowerLen: number;
}

interface BodyRig {
  hips: THREE.Group;
  spine: THREE.Group;
  chest: THREE.Group;
  head: THREE.Group;
  armL: Limb;
  armR: Limb;
  legL: Limb;
  legR: Limb;
}

function createLimb(
  parent: THREE.Object3D,
  x: number,
  y: number,
  upperLen: number,
  lowerLen: number,
): Limb {
  const upper = new THREE.Group();
  const lower = new THREE.Group();
  const end = new THREE.Group();
  upper.position.set(x, y, 0);
  lower.position.y = -upperLen;
  end.position.y = -lowerLen;
  parent.add(upper);
  upper.add(lower);
  lower.add(end);
  return { upper, lower, end, upperLen, lowerLen };
}

function buildTorso(f: PartFactory, m: Materials, hips: THREE.Group, spine: THREE.Group, chest: THREE.Group): void {
  // Pelvis, belt and belt kit.
  f.box(hips, m.trousers, 0.32, 0.2, 0.21, 0, -0.02, 0);
  f.box(hips, m.vest, 0.34, 0.055, 0.23, 0, 0.065, 0);
  f.box(hips, m.pouchDark, 0.05, 0.08, 0.09, 0.175, 0.04, -0.02);
  f.box(hips, m.gear, 0.05, 0.13, 0.08, -0.18, 0, 0.01);
  f.box(hips, m.pouchDark, 0.13, 0.075, 0.05, 0, 0.05, -0.13);

  f.box(spine, m.camo, 0.29, 0.18, 0.19, 0, 0.06, 0);

  // Shirt under a black plate carrier.
  f.box(chest, m.camo, 0.35, 0.33, 0.2, 0, 0.13, 0);
  f.box(chest, m.vest, 0.39, 0.17, 0.25, 0, 0, 0);
  f.box(chest, m.vest, 0.34, 0.3, 0.07, 0, 0.12, 0.085);
  f.box(chest, m.vest, 0.34, 0.32, 0.07, 0, 0.13, -0.085);
  for (const x of [-0.11, 0.11]) f.box(chest, m.vest, 0.09, 0.035, 0.22, x, 0.28, 0);
  // Front: three mag pouches with flaps and an admin pouch.
  for (const x of [-0.09, 0, 0.09]) {
    f.box(chest, m.pouch, 0.078, 0.11, 0.055, x, 0.02, 0.145);
    f.box(chest, m.pouchDark, 0.082, 0.025, 0.06, x, 0.08, 0.145);
  }
  f.box(chest, m.pouchDark, 0.17, 0.08, 0.035, 0, 0.16, 0.135);
  // Back: small assault pack and a radio with antenna.
  f.box(chest, m.pack, 0.27, 0.28, 0.09, 0, 0.1, -0.165);
  f.box(chest, m.pouch, 0.2, 0.05, 0.08, 0, 0.255, -0.16);
  f.box(chest, m.pouchDark, 0.07, 0.15, 0.06, 0.14, 0.13, -0.15);
  f.cylinder(chest, m.gear, 0.006, 0.24, 0.155, 0.32, -0.16);
  f.cylinder(chest, m.gear, 0.075, 0.06, 0, 0.295, 0);
}

function buildHead(f: PartFactory, m: Materials, head: THREE.Group): void {
  f.cylinder(head, m.gear, 0.055, 0.1, 0, 0.03, 0);
  f.sphere(head, m.skin, 0.1, 0, 0.13, 0.012).scale.set(0.92, 1.05, 1);
  // Helmet: big light dome with a lip, goggles band and NVG shroud on the front (reads from above).
  f.sphere(head, m.helmet, 0.155, 0, 0.15, -0.005, Math.PI * 0.56).scale.set(1, 0.92, 1.1);
  f.cylinder(head, m.helmetTrim, 0.158, 0.03, 0, 0.14, -0.005, "y", 0.165, 18).scale.z = 1.1;
  f.cylinder(head, m.gear, 0.157, 0.022, 0, 0.172, -0.005, "y", 0.157, 18).scale.z = 1.1;
  f.box(head, m.lens, 0.17, 0.045, 0.04, 0, 0.178, 0.162);
  f.box(head, m.gear, 0.055, 0.045, 0.03, 0, 0.235, 0.145);
  for (const x of [-0.152, 0.152]) {
    f.box(head, m.gear, 0.018, 0.03, 0.15, x, 0.165, 0);
    f.cylinder(head, m.gear, 0.045, 0.04, x * 0.72, 0.115, 0, "x");
  }
  f.box(head, m.pouchDark, 0.08, 0.05, 0.035, 0, 0.2, -0.16);
}

function buildBody(f: PartFactory, m: Materials): BodyRig {
  const hips = new THREE.Group();
  const spine = new THREE.Group();
  const chest = new THREE.Group();
  const head = new THREE.Group();
  spine.position.y = SPINE_Y;
  chest.position.y = CHEST_Y;
  head.position.y = NECK_Y;
  hips.add(spine);
  spine.add(chest);
  chest.add(head);
  for (const g of [hips, spine, chest, head]) g.rotation.order = "YXZ";

  buildTorso(f, m, hips, spine, chest);
  buildHead(f, m, head);

  const armL = createLimb(chest, SHOULDER_X, SHOULDER_Y, UPPER_ARM_LEN, FOREARM_LEN);
  const armR = createLimb(chest, -SHOULDER_X, SHOULDER_Y, UPPER_ARM_LEN, FOREARM_LEN);
  for (const arm of [armL, armR]) {
    f.sphere(arm.upper, m.camo, 0.072, 0, -0.025, 0);
    f.capsule(arm.upper, m.camo, 0.056, 0.31, 0, -0.145, 0);
    f.capsule(arm.lower, m.camo, 0.048, 0.27, 0, -0.12, 0);
    f.cylinder(arm.lower, m.gloves, 0.044, 0.05, 0, -0.245, 0);
    f.box(arm.end, m.gloves, 0.07, 0.1, 0.055, 0, -0.005, 0);
  }

  const legL = createLimb(hips, HIP_JOINT_X, HIP_JOINT_Y, THIGH_LEN, SHIN_LEN);
  const legR = createLimb(hips, -HIP_JOINT_X, HIP_JOINT_Y, THIGH_LEN, SHIN_LEN);
  for (const leg of [legL, legR]) {
    f.capsule(leg.upper, m.trousers, 0.088, 0.46, 0, -0.2, 0);
    f.capsule(leg.lower, m.trousers, 0.07, 0.42, 0, -0.2, 0);
    f.box(leg.lower, m.kneePad, 0.11, 0.12, 0.05, 0, -0.01, 0.062);
    f.cylinder(leg.end, m.boots, 0.068, 0.14, 0, 0.02, 0);
    f.box(leg.end, m.boots, 0.115, 0.08, 0.26, 0, -0.04, 0.05);
    f.box(leg.end, m.sole, 0.12, 0.022, 0.27, 0, -0.074, 0.05);
  }
  f.box(legR.upper, m.gear, 0.05, 0.15, 0.11, -0.095, -0.16, 0);

  return { hips, spine, chest, head, armL, armR, legL, legR };
}

// ---------------------------------------------------------------------------------------------
// Weapons. Weapon space: origin = firing-hand palm on the grip, +Z = barrel, -X = right side.

/** Grip placement relative to the shoulder centre (model axes) + pitch/yaw/roll (YXZ). */
interface Pose {
  pos: THREE.Vector3;
  rot: THREE.Vector3;
}

const pose = (x: number, y: number, z: number, pitch: number, yaw: number, roll: number): Pose => ({
  pos: new THREE.Vector3(x, y, z),
  rot: new THREE.Vector3(pitch, yaw, roll),
});

/** Peak visual recoil per shot (metres / radians; negative pitch = muzzle up). */
interface RecoilProfile {
  back: number;
  rise: number;
  pitch: number;
  yaw: number;
  torso: number;
}

type AnchorName = "muzzle" | "ejection" | "support" | "well" | "wellOut" | "bolt" | "boltBack";
type ReloadTarget = Exclude<AnchorName, "muzzle" | "ejection"> | "pouch";
type TimeWindow = readonly [number, number];

interface WeaponRig {
  id: WeaponId;
  group: THREE.Group;
  anchors: Record<AnchorName, THREE.Object3D>;
  /** Support-hand path over reloadProgress (keys sorted by t, first at 0, last at 1). */
  reloadKeys: { t: number; to: ReloadTarget }[];
  /** Chest-space point the support hand visits for a fresh mag / shell. */
  pouch: THREE.Vector3;
  /** Magazine on the gun, hidden while it is out during a reload. */
  mag: THREE.Object3D | null;
  magOut: TimeWindow | null;
  /** Mag / shell carried by the support hand during parts of the reload. */
  handItem: THREE.Object3D;
  handItemWindows: TimeWindow[];
  pump: THREE.Object3D | null;
  slide: THREE.Object3D | null;
  movingPartBase: number;
  poses: { ready: Pose; aim: Pose; lowered: Pose; reload: Pose };
  /** Chest twist while aiming (negative = left shoulder forward). */
  blade: number;
  /** Head roll onto the stock while aiming. */
  cheek: number;
  recoil: RecoilProfile;
}

function inWindow(t: number, w: TimeWindow): boolean {
  return t >= w[0] && t < w[1];
}

function buildCarbine(f: PartFactory, m: Materials): WeaponRig {
  const g = new THREE.Group();
  const bore = 0.095;
  f.box(g, m.gunPolymer, 0.032, 0.11, 0.05, 0, -0.01, -0.005).rotation.x = -0.28;
  f.box(g, m.gunMetal, 0.05, 0.06, 0.2, 0, 0.05, 0.05);
  f.box(g, m.gunMetal, 0.056, 0.05, 0.33, 0, bore + 0.01, 0.08);
  f.box(g, m.gunPolymer, 0.06, 0.066, 0.2, 0, bore - 0.008, 0.33);
  f.cylinder(g, m.gunMetal, 0.027, 0.32, 0, bore, 0.58, "z", 0.027, 12);
  f.cylinder(g, m.gunPolymer, 0.029, 0.03, 0, bore, 0.725, "z", 0.029, 12);
  f.box(g, m.gunMetal, 0.034, 0.04, 0.2, 0, 0.085, -0.15);
  f.box(g, m.gunPolymer, 0.036, 0.035, 0.13, 0, 0.12, -0.18);
  f.box(g, m.gunPolymer, 0.045, 0.13, 0.03, 0, 0.065, -0.265);
  f.box(g, m.gunMetal, 0.024, 0.02, 0.06, 0, bore + 0.045, 0.08);
  f.box(g, m.gunPolymer, 0.038, 0.048, 0.1, 0, bore + 0.075, 0.08);
  f.box(g, m.lens, 0.03, 0.03, 0.005, 0, bore + 0.078, 0.131);
  f.box(g, m.gunMetal, 0.012, 0.012, 0.055, 0, 0.012, 0.045);
  f.box(g, m.gunMetal, 0.02, 0.016, 0.035, 0.036, bore + 0.012, 0.02);
  const mag = f.box(g, m.gunPolymer, 0.03, 0.17, 0.068, 0, -0.04, 0.14);
  mag.rotation.x = -0.25;

  const handItem = new THREE.Group();
  f.box(handItem, m.gunPolymer, 0.03, 0.17, 0.068, 0, -0.08, 0);

  return {
    id: "carbine",
    group: g,
    anchors: {
      muzzle: anchor(g, 0, bore, 0.75),
      ejection: anchor(g, -0.036, bore + 0.01, 0.1),
      support: anchor(g, 0, bore - 0.06, 0.31),
      well: anchor(g, 0, -0.09, 0.155),
      wellOut: anchor(g, 0, -0.26, 0.18),
      bolt: anchor(g, 0.05, bore + 0.012, 0.02),
      boltBack: anchor(g, 0.05, bore + 0.012, -0.05),
    },
    reloadKeys: [
      { t: 0, to: "support" },
      { t: 0.14, to: "well" },
      { t: 0.2, to: "well" },
      { t: 0.32, to: "wellOut" },
      { t: 0.42, to: "pouch" },
      { t: 0.48, to: "pouch" },
      { t: 0.56, to: "wellOut" },
      { t: 0.64, to: "well" },
      { t: 0.76, to: "bolt" },
      { t: 0.86, to: "boltBack" },
      { t: 1, to: "support" },
    ],
    pouch: new THREE.Vector3(0.09, 0.0, 0.2),
    mag,
    magOut: [0.2, 0.64],
    handItem,
    handItemWindows: [
      [0.2, 0.37],
      [0.44, 0.64],
    ],
    pump: null,
    slide: null,
    movingPartBase: 0,
    poses: {
      ready: pose(-0.12, -0.15, 0.25, 0.16, 0.06, 0),
      aim: pose(-0.11, -0.06, 0.27, 0, 0.02, 0),
      lowered: pose(-0.06, -0.33, 0.2, 0.55, 0.85, -0.35),
      reload: pose(-0.05, -0.17, 0.27, -0.18, 0.3, 0.55),
    },
    blade: -0.34,
    cheek: 0.12,
    recoil: { back: 0.022, rise: 0.006, pitch: -0.045, yaw: 0.012, torso: 0.006 },
  };
}

function buildPistol(f: PartFactory, m: Materials): WeaponRig {
  const g = new THREE.Group();
  f.box(g, m.gunPolymer, 0.03, 0.1, 0.045, 0, -0.005, -0.005).rotation.x = -0.22;
  f.box(g, m.gunPolymer, 0.028, 0.028, 0.165, 0, 0.05, 0.045);
  f.box(g, m.gunPolymer, 0.01, 0.02, 0.045, 0, 0.022, 0.055);
  const slide = new THREE.Group();
  slide.position.set(0, 0.08, 0.045);
  g.add(slide);
  f.box(slide, m.gunMetal, 0.032, 0.034, 0.19, 0, 0, 0);
  f.box(slide, m.gunMetal, 0.006, 0.01, 0.01, 0, 0.021, 0.088);
  f.box(slide, m.gunMetal, 0.022, 0.01, 0.01, 0, 0.021, -0.085);
  const mag = f.box(g, m.gunMetal, 0.028, 0.02, 0.042, 0, -0.06, -0.017);

  const handItem = new THREE.Group();
  f.box(handItem, m.gunMetal, 0.024, 0.1, 0.035, 0, -0.06, 0);

  return {
    id: "pistol",
    group: g,
    anchors: {
      muzzle: anchor(g, 0, 0.08, 0.142),
      ejection: anchor(g, -0.02, 0.09, 0.05),
      support: anchor(g, 0.032, -0.02, 0.012),
      well: anchor(g, 0, -0.08, -0.02),
      wellOut: anchor(g, 0, -0.2, -0.02),
      bolt: anchor(g, 0.012, 0.1, -0.03),
      boltBack: anchor(g, 0.012, 0.1, -0.085),
    },
    reloadKeys: [
      { t: 0, to: "support" },
      { t: 0.14, to: "well" },
      { t: 0.2, to: "well" },
      { t: 0.3, to: "wellOut" },
      { t: 0.42, to: "pouch" },
      { t: 0.48, to: "pouch" },
      { t: 0.58, to: "wellOut" },
      { t: 0.64, to: "well" },
      { t: 0.75, to: "bolt" },
      { t: 0.85, to: "boltBack" },
      { t: 1, to: "support" },
    ],
    pouch: new THREE.Vector3(0.12, -0.17, 0.16),
    mag,
    magOut: [0.2, 0.64],
    handItem,
    handItemWindows: [
      [0.2, 0.35],
      [0.44, 0.64],
    ],
    pump: null,
    slide,
    movingPartBase: slide.position.z,
    poses: {
      ready: pose(-0.04, -0.16, 0.38, 0.12, 0.03, 0),
      aim: pose(-0.035, -0.02, 0.46, 0, 0.01, 0),
      lowered: pose(-0.03, -0.32, 0.18, 1.05, 0.15, 0),
      reload: pose(-0.03, -0.17, 0.28, -0.4, 0.2, 0.4),
    },
    blade: -0.12,
    cheek: 0.03,
    recoil: { back: 0.03, rise: 0.018, pitch: -0.2, yaw: 0.02, torso: 0.01 },
  };
}

function buildShotgun(f: PartFactory, m: Materials): WeaponRig {
  const g = new THREE.Group();
  const bore = 0.1;
  f.box(g, m.gunPolymer, 0.034, 0.105, 0.05, 0, -0.01, -0.005).rotation.x = -0.3;
  f.box(g, m.gunMetal, 0.052, 0.085, 0.24, 0, 0.075, 0.075);
  f.cylinder(g, m.gunMetal, 0.016, 0.48, 0, bore, 0.43, "z");
  f.cylinder(g, m.gunMetal, 0.015, 0.4, 0, 0.058, 0.39, "z");
  f.box(g, m.gunMetal, 0.03, 0.06, 0.02, 0, 0.08, 0.58);
  f.box(g, m.brass, 0.006, 0.008, 0.008, 0, bore + 0.02, 0.66);
  f.box(g, m.gunPolymer, 0.042, 0.085, 0.24, 0, 0.06, -0.15).rotation.x = 0.07;
  f.box(g, m.gear, 0.046, 0.125, 0.03, 0, 0.045, -0.275);
  f.box(g, m.gunMetal, 0.012, 0.014, 0.06, 0, 0.022, 0.045);
  // Side saddle with spare shells on the left of the receiver.
  for (let i = 0; i < 4; i++) {
    const z = 0.035 + i * 0.026;
    f.cylinder(g, m.shell, 0.011, 0.055, 0.034, 0.08, z);
    f.cylinder(g, m.brass, 0.0115, 0.014, 0.034, 0.047, z);
  }
  const pump = new THREE.Group();
  pump.position.set(0, 0.058, 0.36);
  g.add(pump);
  f.cylinder(pump, m.gunPolymer, 0.028, 0.17, 0, 0, 0, "z");
  for (const z of [-0.05, 0, 0.05]) f.cylinder(pump, m.gunMetal, 0.03, 0.012, 0, 0, z, "z");

  const handItem = new THREE.Group();
  f.cylinder(handItem, m.shell, 0.012, 0.06, 0, -0.06, 0);
  f.cylinder(handItem, m.brass, 0.0125, 0.015, 0, -0.03, 0);

  return {
    id: "shotgun",
    group: g,
    anchors: {
      muzzle: anchor(g, 0, bore, 0.68),
      ejection: anchor(g, -0.03, 0.09, 0.1),
      support: anchor(pump, 0, -0.035, 0),
      well: anchor(g, 0, 0.015, 0.13),
      wellOut: anchor(g, 0, -0.06, 0.09),
      bolt: anchor(pump, 0, -0.035, 0),
      boltBack: anchor(pump, 0, -0.035, 0),
    },
    reloadKeys: [
      { t: 0, to: "pouch" },
      { t: 0.3, to: "pouch" },
      { t: 0.6, to: "wellOut" },
      { t: 0.78, to: "well" },
      { t: 1, to: "pouch" },
    ],
    pouch: new THREE.Vector3(0.11, -0.1, 0.18),
    mag: null,
    magOut: null,
    handItem,
    handItemWindows: [[0.12, 0.8]],
    pump,
    slide: null,
    movingPartBase: pump.position.z,
    poses: {
      ready: pose(-0.12, -0.15, 0.24, 0.16, 0.06, 0),
      aim: pose(-0.11, -0.07, 0.27, 0, 0.02, 0),
      lowered: pose(-0.06, -0.32, 0.2, 0.55, 0.8, -0.35),
      reload: pose(-0.04, -0.18, 0.24, -0.12, 0.25, 0.75),
    },
    blade: -0.38,
    cheek: 0.12,
    recoil: { back: 0.07, rise: 0.03, pitch: -0.26, yaw: 0.03, torso: 0.08 },
  };
}

const IDLE_STATE: CharacterAnimState = {
  state: "idle",
  speed: 0,
  moveLocal: new THREE.Vector2(),
  aiming: false,
  crouched: false,
  reloading: false,
  reloadProgress: 0,
  weaponId: "carbine",
  shotsFired: 0,
  vaultProgress: 0,
  slideProgress: 0,
  weaponLowered: false,
};

/**
 * Low-poly soldier built from primitives, with procedural animation and three weapon meshes.
 * `root` sits at the feet and faces local +Z; Player sets root.position / root.rotation.y.
 * Legs and arms are solved with two-bone IK: feet follow a distance-driven gait, hands stay on
 * the weapon, which is posed in model space relative to the chest.
 */
export class CharacterModel {
  readonly root = new THREE.Group();

  private readonly parts = new PartFactory();
  private readonly mats = createMaterials();
  private readonly body: BodyRig;
  private readonly weaponRoot = new THREE.Group();
  private readonly weapons: Record<WeaponId, WeaponRig>;
  private weapon: WeaponRig;

  // Smoothed blend weights, 0..1.
  private aimW = 0;
  private lowerW = 0;
  private reloadW = 0;
  private crouchW = 0;
  private slideW = 0;
  private vaultW = 0;
  private tacticalW = 0;
  private gaitW = 0;
  private runW = 0;
  private vaultTuck = 0;
  private switchDip = 0;

  // Gait: phase 0..1 per two steps; left foot strikes at 0, right at 0.5.
  private phase = 0;
  private stanceFrac = 0.6;
  private stride = 0.3; // half stride length
  private liftHeight = 0.1;
  private readonly velLocal = new THREE.Vector3();
  private readonly gaitDir = new THREE.Vector3(0, 0, 1);
  private accelFwd = 0;
  private accelSide = 0;
  private strafeYaw = 0;
  private lean = 0;

  private time = 0;
  private prevYaw = Number.NaN;
  private turnLag = 0;
  private reloadProgress = 0;
  private wasReloading = false;
  private pumpClock = Infinity;
  private slideClock = Infinity;

  private readonly kickBack = new Spring(28, 0.5);
  private readonly kickRise = new Spring(24, 0.55);
  private readonly kickPitch = new Spring(22, 0.45);
  private readonly kickYaw = new Spring(20, 0.5);
  private readonly kickTorso = new Spring(14, 0.5);

  /** Smoothed weapon pose (relative to the shoulder centre, model axes). */
  private readonly posePos = new THREE.Vector3();
  private readonly poseRot = new THREE.Vector3();
  /** Chest frame relative to root, rebuilt every update. */
  private readonly chestMatrix = new THREE.Matrix4();
  private readonly chestQuat = new THREE.Quaternion();

  constructor() {
    this.body = buildBody(this.parts, this.mats);
    this.root.add(this.body.hips);
    this.weaponRoot.rotation.order = "YXZ";
    this.root.add(this.weaponRoot);

    this.weapons = {
      carbine: buildCarbine(this.parts, this.mats),
      pistol: buildPistol(this.parts, this.mats),
      shotgun: buildShotgun(this.parts, this.mats),
    };
    for (const rig of Object.values(this.weapons)) {
      rig.group.visible = false;
      rig.handItem.visible = false;
      this.weaponRoot.add(rig.group);
      this.body.armL.end.add(rig.handItem);
    }
    this.weapon = this.weapons.carbine;
    this.weapon.group.visible = true;
    this.posePos.copy(this.weapon.poses.ready.pos);
    this.poseRot.copy(this.weapon.poses.ready.rot);
    this.update(0, IDLE_STATE);
  }

  setWeapon(id: WeaponDef["id"]): void {
    if (id === this.weapon.id) return;
    this.weapon.group.visible = false;
    this.weapon.handItem.visible = false;
    if (this.weapon.mag) this.weapon.mag.visible = true;
    this.weapon = this.weapons[id];
    this.weapon.group.visible = true;
    this.switchDip = 1;
    this.pumpClock = Infinity;
    this.slideClock = Infinity;
    this.wasReloading = false;
  }

  update(dt: number, anim: CharacterAnimState): void {
    if (anim.weaponId !== this.weapon.id) this.setWeapon(anim.weaponId);
    const step = clamp(dt, 0, 0.1);
    this.time += step;
    this.updateBlends(step, anim);
    this.updateGait(step, anim);
    this.updateActions(step, anim);
    this.poseTorso();
    this.poseWeapon(step, anim);
    this.poseArms();
    this.poseLegs();
    this.poseHead();
  }

  /** World position of the muzzle and the barrel's forward direction (normalised). */
  getMuzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    const muzzle = this.weapon.anchors.muzzle;
    muzzle.updateWorldMatrix(true, false);
    outPos.setFromMatrixPosition(muzzle.matrixWorld);
    outDir.set(0, 0, 1).transformDirection(muzzle.matrixWorld);
  }

  /** World position of the ejection port (for shell casings). */
  getEjectionPort(outPos: THREE.Vector3): void {
    const port = this.weapon.anchors.ejection;
    port.updateWorldMatrix(true, false);
    outPos.setFromMatrixPosition(port.matrixWorld);
  }

  dispose(): void {
    this.root.removeFromParent();
    this.parts.dispose();
    // The camo texture is shared and cached by textures.ts, so only materials are disposed.
    for (const mat of Object.values(this.mats)) mat.dispose();
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame state

  private updateBlends(dt: number, a: CharacterAnimState): void {
    const s = a.state;
    const lowered = a.weaponLowered || s === "tactical" || s === "vault";
    this.aimW = damp(this.aimW, a.aiming && !lowered ? 1 : 0, 14, dt);
    this.lowerW = damp(this.lowerW, lowered ? 1 : s === "run" && !a.aiming ? 0.25 : 0, 9, dt);
    this.reloadW = damp(this.reloadW, a.reloading ? 1 : 0, 10, dt);
    const crouched = a.crouched || s === "crouch" || s === "crouchWalk";
    this.crouchW = damp(this.crouchW, crouched ? 1 : 0, 9, dt);
    this.slideW = damp(this.slideW, s === "slide" ? 1 : 0, 12, dt);
    this.vaultW = damp(this.vaultW, s === "vault" ? 1 : 0, 16, dt);
    this.tacticalW = damp(this.tacticalW, s === "tactical" ? 1 : 0, 8, dt);
    const tuck = s === "vault" ? Math.sin(Math.PI * clamp01(a.vaultProgress)) : 0;
    this.vaultTuck = damp(this.vaultTuck, tuck, 20, dt);
    this.switchDip = damp(this.switchDip, 0, 7, dt);
    if (a.reloading) this.reloadProgress = clamp01(a.reloadProgress);

    // Turning fast makes the weapon trail slightly behind the body.
    const yaw = this.root.rotation.y;
    const yawRate =
      dt > 0 && !Number.isNaN(this.prevYaw) ? wrapAngle(yaw - this.prevYaw) / dt : 0;
    this.prevYaw = yaw;
    const lag = clamp(-yawRate * 0.02, -0.18, 0.18) * (1 - 0.6 * this.aimW);
    this.turnLag = damp(this.turnLag, lag, 12, dt);
  }

  private updateGait(dt: number, a: CharacterAnimState): void {
    const speed = a.speed;
    const mx = a.moveLocal.x;
    const my = a.moveLocal.y;
    const len = Math.hypot(mx, my);
    // moveLocal is (right, forward); model right is -X.
    if (len > 1e-3) _v1.set(-mx / len, 0, my / len).multiplyScalar(speed);
    else _v1.set(0, 0, 0);
    const prevX = this.velLocal.x;
    const prevZ = this.velLocal.z;
    this.velLocal.lerp(_v1, 1 - Math.exp(-12 * dt));
    if (dt > 0) {
      this.accelFwd = damp(this.accelFwd, (this.velLocal.z - prevZ) / dt, 8, dt);
      this.accelSide = damp(this.accelSide, (this.velLocal.x - prevX) / dt, 8, dt);
    }
    const vLen = this.velLocal.length();
    if (vLen > 0.05) this.gaitDir.copy(this.velLocal).divideScalar(vLen);

    const legsFree = a.state !== "slide" && a.state !== "vault";
    this.gaitW = damp(this.gaitW, legsFree ? clamp01(speed / 0.8) : 0, 9, dt);
    this.runW = damp(this.runW, clamp01((speed - 3.8) / 2.4), 6, dt);
    // Fixed stride, cadence scales with speed; stance shrinks into a running flight phase.
    this.stanceFrac = clamp(0.62 - 0.06 * speed, 0.28, 0.62);
    this.stride = 0.3 + 0.1 * this.crouchW + 0.03 * this.runW;
    const cycle = (2 * this.stride) / this.stanceFrac;
    this.phase = (this.phase + (speed * dt) / cycle) % 1;
    this.liftHeight = (0.09 + 0.14 * this.runW + 0.05 * this.tacticalW) * (1 - 0.4 * this.crouchW);

    // Strafing turns the pelvis toward the movement; backpedalling turns it the other way.
    const right = -this.gaitDir.x;
    const strafe = vLen > 0.3 ? -0.45 * right * (this.gaitDir.z >= -0.15 ? 1 : -1) : 0;
    this.strafeYaw = damp(this.strafeYaw, strafe * this.gaitW, 6, dt);
  }

  private updateActions(dt: number, a: CharacterAnimState): void {
    if (a.shotsFired > 0) this.applyRecoil(a.shotsFired);
    // Shotgun: rack the pump once the last shell is in.
    if (this.wasReloading && !a.reloading && this.weapon.pump) this.pumpClock = -0.05;
    this.wasReloading = a.reloading;

    const prevPump = this.pumpClock;
    this.pumpClock += dt;
    if (prevPump < 0 && this.pumpClock >= 0) {
      this.kickBack.kick(0.012);
      this.kickPitch.kick(0.03);
    }
    this.slideClock += dt;

    this.kickBack.update(dt);
    this.kickRise.update(dt);
    this.kickPitch.update(dt);
    this.kickYaw.update(dt);
    this.kickTorso.update(dt);
  }

  private applyRecoil(shots: number): void {
    const r = this.weapon.recoil;
    const k = Math.min(shots, 3) * (1 - 0.35 * this.aimW);
    this.kickBack.kick(r.back * k);
    this.kickRise.kick(r.rise * k);
    this.kickPitch.kick(r.pitch * k);
    this.kickYaw.kick(r.yaw * k * (Math.random() * 2 - 1));
    this.kickTorso.kick(r.torso * k);
    if (this.weapon.slide) this.slideClock = 0;
    if (this.weapon.pump) this.pumpClock = -PUMP_DELAY_AFTER_SHOT;
  }

  // -------------------------------------------------------------------------------------------
  // Posing

  private poseTorso(): void {
    const { hips, spine, chest } = this.body;
    const g = this.gaitW;
    const p = this.phase * TAU;
    const t = this.time;

    // Two dips per cycle, at each foot strike.
    const bob = -(0.02 + 0.025 * this.runW) * Math.cos(2 * p) * g * (1 - 0.5 * this.crouchW);
    const drop = Math.max(CROUCH_DROP * this.crouchW, SLIDE_DROP * this.slideW);
    hips.position.set(
      0.012 * Math.sin(t * 0.6) * (1 - g),
      HIPS_HEIGHT -
        drop -
        0.04 * g -
        0.03 * this.runW -
        0.04 * this.tacticalW -
        0.02 * this.aimW +
        bob,
      -0.06 * this.crouchW - 0.04 * this.slideW,
    );
    const hipsYaw = this.strafeYaw - (0.06 + 0.08 * this.runW) * Math.cos(p) * g;
    const hipsPitch = 0.12 * this.crouchW - 0.3 * this.slideW + 0.05 * this.runW;
    const hipsRoll = 0.04 * Math.sin(p) * g;
    hips.rotation.set(hipsPitch, hipsYaw, hipsRoll);

    // Lean into speed and acceleration; aiming straightens up; sliding leans back.
    let lean =
      0.05 +
      clamp(0.022 * this.velLocal.z, -0.08, 0.17) +
      clamp(0.006 * this.accelFwd, -0.15, 0.12) +
      0.22 * this.tacticalW +
      0.18 * this.crouchW +
      0.3 * this.vaultW;
    lean = lean * (1 - 0.6 * this.aimW) + 0.04 * this.aimW;
    lean -= 0.6 * this.slideW + this.kickTorso.value;
    this.lean = lean;
    const sideLean = clamp(-0.02 * this.velLocal.x - 0.004 * this.accelSide, -0.15, 0.15);
    const breath = Math.sin(t * 1.7) * 0.012 * (1 - 0.5 * g);
    // Blade the shoulders behind the weapon; shoulders counter-swing against the hips.
    const twist =
      this.weapon.blade * (0.4 + 0.6 * this.aimW) * (1 - 0.8 * this.lowerW) +
      (0.08 + 0.1 * this.runW) * Math.cos(p) * g * (1 - 0.5 * this.aimW) +
      0.5 * this.turnLag;
    const bend = lean - hipsPitch;
    spine.rotation.set(bend * 0.5, -hipsYaw * 0.6 + twist * 0.4, sideLean * 0.5 - hipsRoll * 0.6);
    chest.rotation.set(
      bend * 0.5 - breath,
      -hipsYaw * 0.4 + twist * 0.6,
      sideLean * 0.5 - hipsRoll * 0.4,
    );

    hips.updateMatrix();
    spine.updateMatrix();
    chest.updateMatrix();
    this.chestMatrix.multiplyMatrices(hips.matrix, spine.matrix).multiply(chest.matrix);
    this.chestQuat.copy(hips.quaternion).multiply(spine.quaternion).multiply(chest.quaternion);
  }

  private poseWeapon(dt: number, a: CharacterAnimState): void {
    const w = this.weapon;
    const P = w.poses;
    _v1.copy(P.ready.pos).lerp(P.aim.pos, this.aimW).lerp(P.reload.pos, this.reloadW);
    _v1.lerp(P.lowered.pos, this.lowerW);
    _v2.copy(P.ready.rot).lerp(P.aim.rot, this.aimW).lerp(P.reload.rot, this.reloadW);
    _v2.lerp(P.lowered.rot, this.lowerW);
    // Weapon switch: dip and raise.
    _v1.y -= 0.22 * this.switchDip;
    _v1.z -= 0.06 * this.switchDip;
    _v2.x += 0.9 * this.switchDip;
    _v2.z -= 0.3 * this.switchDip;
    const k = 1 - Math.exp(-16 * dt);
    this.posePos.lerp(_v1, k);
    this.poseRot.lerp(_v2, k);

    // Breathing sway at rest, step bob while moving; both calmer when aiming.
    const g = this.gaitW;
    const p = this.phase * TAU;
    const t = this.time;
    const steady = 1 - 0.6 * this.aimW;
    const still = (1 - g) * steady;
    const stepAmp = g * (1 + this.lowerW) * steady;

    const wr = this.weaponRoot;
    wr.rotation.set(
      this.poseRot.x + this.kickPitch.value + 0.01 * Math.sin(t * 1.3) * still,
      this.poseRot.y + this.turnLag + this.kickYaw.value + 0.008 * Math.sin(t * 0.7) * still,
      this.poseRot.z + 0.04 * Math.sin(p) * stepAmp,
    );
    _v3.set(0, SHOULDER_Y, 0).applyMatrix4(this.chestMatrix);
    _v4.set(0, this.kickRise.value, -this.kickBack.value).applyQuaternion(wr.quaternion);
    wr.position.copy(_v3).add(this.posePos).add(_v4);
    wr.position.x += 0.005 * Math.sin(t * 0.9) * still + 0.012 * Math.sin(p) * stepAmp;
    wr.position.y += 0.004 * Math.sin(t * 1.7) * still + 0.01 * Math.cos(2 * p) * stepAmp;

    if (w.pump) {
      w.pump.position.z = w.movingPartBase - PUMP_TRAVEL * cycleTravel(this.pumpClock / PUMP_TIME, 0.4);
    }
    if (w.slide) {
      w.slide.position.z = w.movingPartBase - SLIDE_TRAVEL * cycleTravel(this.slideClock / SLIDE_TIME, 0.3);
    }
    const rp = this.reloadProgress;
    if (w.mag) w.mag.visible = !(a.reloading && w.magOut && inWindow(rp, w.magOut));
    let holding = false;
    if (a.reloading) for (const win of w.handItemWindows) holding ||= inWindow(rp, win);
    w.handItem.visible = holding;
  }

  private poseArms(): void {
    const { armL, armR } = this.body;
    _grip.copy(this.weaponRoot.position);
    this.rootPosition(this.weapon.anchors.support, _support);
    if (this.reloadW > 0.001) _support.lerp(this.reloadTarget(_target), this.reloadW);

    _shoulderL.set(SHOULDER_X, SHOULDER_Y, 0).applyMatrix4(this.chestMatrix);
    _shoulderR.set(-SHOULDER_X, SHOULDER_Y, 0).applyMatrix4(this.chestMatrix);

    // Tactical sprint: the support arm lets go and pumps with the stride.
    const pumpArm = this.tacticalW * (1 - this.reloadW);
    if (pumpArm > 0.001) {
      const swing = -Math.cos(this.phase * TAU) * this.gaitW;
      _target.set(0.04, -0.4 + 0.12 * Math.max(0, swing), 0.1 + 0.24 * swing).add(_shoulderL);
      _support.lerp(_target, pumpArm);
    }
    // Vault: support hand reaches down to plant on the obstacle.
    if (this.vaultW > 0.001) {
      _target.set(0.16, 0.92 - 0.12 * this.vaultTuck, 0.34);
      _support.lerp(_target, this.vaultW);
    }

    // Elbow hints; aiming tucks the elbows in.
    _pole.set(-0.8, -0.55, -0.35).lerp(_v1.set(-0.45, -0.85, -0.2), this.aimW);
    this.solveLimb(armR, this.chestQuat, _shoulderR, _grip, _pole);
    _pole.set(0.65, -0.75, -0.1).lerp(_v1.set(0.3, -0.95, 0.05), this.aimW);
    _pole.lerp(_v1.set(0.3, -0.3, -0.9), pumpArm);
    this.solveLimb(armL, this.chestQuat, _shoulderL, _support, _pole);
  }

  private poseLegs(): void {
    const { hips, legL, legR } = this.body;
    const g = this.gaitW;
    const sf = this.stanceFrac;
    // Sideways steps are shorter so the feet do not cross too far.
    const half = this.stride * (1 - 0.4 * Math.abs(this.gaitDir.x));
    const stepToe = g * (0.6 + 0.6 * this.runW);
    const crouchRest = this.crouchW * (1 - g);

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const leg = i === 0 ? legL : legR;

      // Gait foot: planted while in stance (moves back at body speed), arcs forward in swing.
      const p = (this.phase + i * 0.5) % 1;
      let along: number;
      let lift: number;
      let toe: number;
      if (p < sf) {
        const s = p / sf;
        const heel = smooth01((s - 0.6) / 0.4) * this.runW;
        along = half * (1 - 2 * s);
        lift = 0.05 * heel;
        toe = 0.4 * heel;
      } else {
        const u = (p - sf) / (1 - sf);
        along = half * (2 * smooth01(u) - 1);
        lift = this.liftHeight * Math.sin(Math.PI * u);
        toe = (0.55 * (1 - u) - 0.35 * u) * Math.sin(Math.PI * u);
      }
      _v1.set(side * 0.11, ANKLE_HEIGHT + lift, 0).addScaledVector(this.gaitDir, along);

      // Rest stance: staggered, bladed when aiming, wide with the rear heel up when crouched.
      const standZ = THREE.MathUtils.lerp(side > 0 ? 0.04 : -0.06, side > 0 ? 0.12 : -0.12, this.aimW);
      const restZ = THREE.MathUtils.lerp(standZ, side > 0 ? 0.16 : -0.2, this.crouchW);
      const rearHeel = side < 0 ? crouchRest : 0;
      _v2.set(side * (0.12 + 0.04 * this.crouchW), ANKLE_HEIGHT + 0.07 * rearHeel, restZ);
      _target.lerpVectors(_v2, _v1, g);
      let pitch = toe * stepToe + 0.45 * rearHeel;

      // Slide: lead (left) leg extended, trailing leg folded under.
      if (this.slideW > 0.001) {
        if (side > 0) _v3.set(0.12, 0.13, 0.72);
        else _v3.set(-0.2, 0.09, 0.02);
        _target.lerp(_v3, this.slideW);
        pitch = THREE.MathUtils.lerp(pitch, side > 0 ? -0.5 : 1.0, this.slideW);
      }
      // Vault: legs tucked up and swung to the right.
      const tuck = this.vaultW * this.vaultTuck;
      if (tuck > 0.001) {
        _v3.set(side * 0.1 - 0.12, ANKLE_HEIGHT + 0.38, side > 0 ? 0.12 : -0.05);
        _target.lerp(_v3, tuck);
        pitch = THREE.MathUtils.lerp(pitch, 0.6, tuck);
      }

      // Knees point where the pelvis faces (trailing knee out during the slide).
      _pole.set(0, 0, 1).applyQuaternion(hips.quaternion);
      _pole.x += side * 0.15;
      if (side < 0) _pole.lerp(_v3.set(-0.9, -0.3, 0.3), this.slideW);
      _joint.set(side * HIP_JOINT_X, HIP_JOINT_Y, 0).applyMatrix4(hips.matrix);
      this.solveLimb(leg, hips.quaternion, _joint, _target, _pole);

      // Feet stay flat to the floor (toes slightly out) apart from the step roll.
      _qTmp.setFromEuler(_euler.set(pitch, side * 0.1 + 0.4 * this.strafeYaw, 0));
      leg.end.quaternion.copy(_qLower).invert().multiply(_qTmp);
    }
  }

  private poseHead(): void {
    // Look straight ahead (the facing is the aim), dip onto the sights, lead turns a little.
    const pitch = 0.05 + 0.3 * this.lean + 0.18 * this.aimW;
    _qTmp.setFromEuler(_euler.set(pitch, -0.6 * this.turnLag, this.weapon.cheek * this.aimW));
    this.body.head.quaternion.copy(this.chestQuat).invert().multiply(_qTmp);
  }

  /** IK a limb toward a model-space target; writes local rotations (leaves the lower bone's model-space rotation in _qLower). */
  private solveLimb(
    limb: Limb,
    parentQuat: THREE.Quaternion,
    joint: THREE.Vector3,
    target: THREE.Vector3,
    pole: THREE.Vector3,
  ): void {
    solveTwoBone(joint, target, pole, limb.upperLen, limb.lowerLen, _qUpper, _qLower);
    limb.upper.quaternion.copy(parentQuat).invert().multiply(_qUpper);
    limb.lower.quaternion.copy(_qUpper).invert().multiply(_qLower);
  }

  /** Support-hand target along the weapon's reload path at the current progress. */
  private reloadTarget(out: THREE.Vector3): THREE.Vector3 {
    const keys = this.weapon.reloadKeys;
    const t = this.reloadProgress;
    let i = 0;
    while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
    const a = keys[i];
    const b = keys[i + 1];
    const u = smooth01((t - a.t) / Math.max(b.t - a.t, 1e-4));
    this.reloadPoint(a.to, _keyA);
    this.reloadPoint(b.to, _keyB);
    return out.lerpVectors(_keyA, _keyB, u);
  }

  private reloadPoint(target: ReloadTarget, out: THREE.Vector3): THREE.Vector3 {
    if (target === "pouch") return out.copy(this.weapon.pouch).applyMatrix4(this.chestMatrix);
    return this.rootPosition(this.weapon.anchors[target], out);
  }

  /** Position of `obj` in root (model) space. */
  private rootPosition(obj: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
    out.set(0, 0, 0);
    for (let o: THREE.Object3D | null = obj; o && o !== this.root; o = o.parent) {
      o.updateMatrix();
      out.applyMatrix4(o.matrix);
    }
    return out;
  }
}
