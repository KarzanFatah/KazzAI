import * as CANNON from "cannon-es";
import * as THREE from "three";
import type { GameContext, Prop } from "./types";

export type ZombieKind = "walker" | "runner" | "brute";

export interface ZombieHit {
  index: number;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  headshot: boolean;
}

export type WavePhase = "intermission" | "active";

/*
 * Zombie survival horde. Everything is data-oriented and allocation-free per frame:
 *  - one InstancedMesh per body part (7 draw calls for the whole horde + 2 for pickups),
 *    matrices rebuilt on the CPU every frame from a smoothed per-zombie pose,
 *  - a flow field (Dijkstra on a 1 m grid around static cover) steers zombies through gaps,
 *  - a uniform spatial hash handles separation; circle-vs-box pushes keep them out of cover,
 *  - physics props in the way get shoved with impulses (brutes hit hard).
 */

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const CAPACITY = 150; // living + corpses
const MAX_ALIVE = 110;
const START_DELAY = 4;
const INTERMISSION = 7;
const SPAWN_INTERVAL = [0.15, 0.5] as const;
const SPAWN_MIN_DIST = 22;
const RISE_TIME = 1.2;
const CORPSE_TIME = 8;
const SINK_TIME = 1.6;
const FLASH_TIME = 0.1;
/** Head top of a standing (hunched) zombie at scale 1. */
const HEIGHT = 1.68;
const HEADSHOT_FRACTION = 0.82;
const BODY_RADIUS = 0.38;
const HIT_RADIUS = 0.36;
const SEPARATION_RADIUS = 0.75;
const PLAYER_RADIUS = 0.35;
const HASH_CELL = 1.5;
const NAV_CELL = 1;
const COLLISION_CELL = 2;
const GROAN_RATE = 2.5;
const EXPLOSION_DAMAGE = 450;
const AMMO_CHANCE = 0.09;
const HEALTH_CHANCE = 0.05;
const PICKUP_CAPACITY = 12;
const PICKUP_LIFE = 20;
const PICKUP_BLINK = 4;
const PICKUP_RADIUS = 1.3;
const PICKUP_AMMO = 0.25;
const PICKUP_HEAL = 35;
/** Used when the boundary fence cannot be found among the props. */
const FALLBACK_ARENA = { minX: -30, maxX: 30, minZ: -45, maxZ: 24 };

interface KindDef {
  speed: readonly [number, number];
  hp: number;
  damage: number;
  scale: readonly [number, number];
  /** Horizontal bulk (x scale) relative to height. */
  bulk: number;
  reach: number;
  headshotMul: number;
  /** Seconds from the start of an attack until the swipe lands. */
  windup: number;
  turnRate: number;
  accel: number;
  /** Ground covered per half gait cycle at scale 1 (m). */
  stepLength: number;
  /** Force (N) pushed into physics props in the way. */
  pushForce: number;
  /** Share of a prop overlap the zombie resolves by moving itself. */
  pushYield: number;
  fallTime: number;
}

const KINDS: Record<ZombieKind, KindDef> = {
  walker: {
    speed: [1.2, 1.9],
    hp: 60,
    damage: 10,
    scale: [0.92, 1.06],
    bulk: 1,
    reach: 1.15,
    headshotMul: 2.5,
    windup: 0.45,
    turnRate: 4,
    accel: 5,
    stepLength: 0.5,
    pushForce: 170,
    pushYield: 0.85,
    fallTime: 0.62,
  },
  runner: {
    speed: [3.8, 4.6],
    hp: 40,
    damage: 8,
    scale: [0.9, 1.0],
    bulk: 0.9,
    reach: 1.15,
    headshotMul: 2.5,
    windup: 0.32,
    turnRate: 7,
    accel: 7,
    stepLength: 0.95,
    pushForce: 260,
    pushYield: 0.8,
    fallTime: 0.5,
  },
  brute: {
    speed: [1.0, 1.2],
    hp: 280,
    damage: 24,
    scale: [1.36, 1.44],
    bulk: 1.16,
    reach: 1.5,
    headshotMul: 1.6,
    windup: 0.6,
    turnRate: 2.6,
    accel: 3,
    stepLength: 0.55,
    pushForce: 1400,
    pushYield: 0.35,
    fallTime: 0.85,
  },
};

const hexes = (list: number[]): THREE.Color[] =>
  list.map((c) => new THREE.Color(c));
const SKIN = hexes([
  0xa8a594, 0x9c9a86, 0xb5ae9c, 0x8e927e, 0xbdb2a0, 0x9a968c,
]);
const RUNNER_SKIN = hexes([0xa09484, 0x9a8c7c, 0x8f8a78]);
const BRUTE_SKIN = hexes([0x6f7a62, 0x757a6a, 0x66705c]);
const SHIRT = hexes([
  0x6b6151, 0x6e5a48, 0x7a7466, 0x4a5a3f, 0x7a3e36, 0x55505e, 0x8f8a7c,
]);
const BRUTE_SHIRT = hexes([0x3b3531, 0x42463c, 0x4a3a32]);
const PANTS = hexes([0x45403a, 0x4b4236, 0x2f3330, 0x5a5444, 0x3a3833]);
const FLASH = new THREE.Color(1, 0.62, 0.55);
const AMMO_COLOR = new THREE.Color(1.6, 1.15, 0.35);
const HEALTH_COLOR = new THREE.Color(0.45, 1.6, 0.7);
const GROUND_DUST = new THREE.Color(0x6a7590);

// Zombie states and death styles.
const FREE = 0;
const RISING = 1;
const ALIVE = 2;
const DEAD = 3;
const TUMBLE = 0; // falls along the bullet, pivoting at the feet
const CRUMPLE = 1; // headshot: knees give, slumps over
const FLING = 2; // explosion: ballistic with spin

// Pose channels (radians, except HIP_Y in metres at scale 1).
const HIP_Y = 0;
const PELVIS_X = 1;
const PELVIS_Z = 2;
const TORSO_X = 3;
const TORSO_Y = 4;
const TORSO_Z = 5;
const HEAD_X = 6;
const HEAD_Z = 7;
const ARM_LX = 8;
const ARM_LZ = 9;
const ARM_RX = 10;
const ARM_RZ = 11;
const ELBOW_L = 12;
const ELBOW_R = 13;
const THIGH_LX = 14;
const THIGH_LZ = 15;
const THIGH_RX = 16;
const THIGH_RZ = 17;
const KNEE_L = 18;
const KNEE_R = 19;
const POSE_N = 20;

const STAND_HIP = 0.86;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

// Scratch objects (never allocated per frame).
const _root = new THREE.Matrix4();
const _hips = new THREE.Matrix4();
const _torso = new THREE.Matrix4();
const _limb = new THREE.Matrix4();
const _end = new THREE.Matrix4();
const _local = new THREE.Matrix4();
const _euler = new THREE.Euler();
const _qYaw = new THREE.Quaternion();
const _qTilt = new THREE.Quaternion();
const _quat = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const _pos = new THREE.Vector3();
const _off = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _impulse = new CANNON.Vec3();
const _relPoint = new CANNON.Vec3(0, 0.12, 0);

/** out = parent * T(x, y, z) * R(rx, ry, rz). */
function joint(
  out: THREE.Matrix4,
  parent: THREE.Matrix4,
  x: number,
  y: number,
  z: number,
  rx: number,
  ry: number,
  rz: number,
): THREE.Matrix4 {
  _local.makeRotationFromEuler(_euler.set(rx, ry, rz));
  const e = _local.elements;
  e[12] = x;
  e[13] = y;
  e[14] = z;
  return out.multiplyMatrices(parent, _local);
}

// ---------------------------------------------------------------------------
// Geometry (boxes merged per part, grey vertex shades multiply the instance colour)
// ---------------------------------------------------------------------------

/** [width, height, depth, x, y, z, shade] */
type BoxSpec = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** Merge geometries into one non-indexed mesh with a per-part grey shade as vertex colour. */
function mergeShaded(
  parts: readonly [THREE.BufferGeometry, number][],
): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  for (const [source, shade] of parts) {
    const geo = source.index ? source.toNonIndexed() : source;
    const p = geo.getAttribute("position");
    const n = geo.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      positions.push(p.getX(i), p.getY(i), p.getZ(i));
      normals.push(n.getX(i), n.getY(i), n.getZ(i));
      colors.push(shade, shade, shade);
    }
    if (geo !== source) geo.dispose();
    source.dispose();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeBoxes(specs: readonly BoxSpec[]): THREE.BufferGeometry {
  return mergeShaded(
    specs.map(([w, h, d, x, y, z, shade]) => [
      new THREE.BoxGeometry(w, h, d).translate(x, y, z),
      shade,
    ]),
  );
}

/**
 * Gaunt, lumpy skull (faceted, slightly long and narrow) with sunken eyes, a hanging jaw and
 * patchy hair, so the silhouette reads as a decayed human head rather than a block.
 */
function buildHead(): THREE.BufferGeometry {
  const skull = new THREE.IcosahedronGeometry(0.155, 1);
  const pos = skull.getAttribute("position");
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Hollow cheeks and a heavier brow; deterministic lumps.
    const lump = 1 + 0.06 * Math.sin(x * 37 + y * 23) * Math.cos(z * 29);
    const cheek = y < 0 && z > 0 ? 0.86 : 1;
    pos.setXYZ(i, x * 0.92 * cheek * lump, y * 1.12 * lump, z * lump);
  }
  skull.computeVertexNormals();
  skull.translate(0, 0.19, 0.02);
  const eye = (side: number) =>
    new THREE.IcosahedronGeometry(0.034, 0)
      .scale(1.2, 0.8, 0.6)
      .translate(side * 0.058, 0.215, 0.145);
  const jaw = new THREE.BoxGeometry(0.15, 0.05, 0.12)
    .rotateX(0.35)
    .translate(0, 0.07, 0.07);
  const hair = new THREE.IcosahedronGeometry(0.13, 1)
    .scale(1, 0.45, 1.05)
    .translate(-0.025, 0.315, -0.02);
  const neck = new THREE.CylinderGeometry(0.045, 0.055, 0.1, 6).translate(
    0,
    0.02,
    0,
  );
  return mergeShaded([
    [neck, 0.85],
    [skull, 1],
    [hair, 0.4],
    [eye(1), 0.1],
    [eye(-1), 0.1],
    [jaw, 0.7],
  ]);
}

// Each part's origin is its joint; limbs hang along -Y, the body faces +Z.
const TORSO: BoxSpec[] = [
  [0.42, 0.5, 0.24, 0, 0.27, 0, 1],
  [0.3, 0.2, 0.1, 0, 0.36, -0.13, 0.9], // hunched upper back
  [0.13, 0.13, 0.02, 0.08, 0.22, 0.125, 0.4], // torn hole
  [0.43, 0.05, 0.25, 0, 0.03, 0, 0.55], // belt line
];
const PELVIS: BoxSpec[] = [[0.36, 0.18, 0.22, 0, 0, 0, 1]];
const UPPER_ARM: BoxSpec[] = [[0.11, 0.32, 0.11, 0, -0.14, 0, 1]];
const FOREARM: BoxSpec[] = [
  [0.09, 0.28, 0.09, 0, -0.13, 0, 1],
  [0.1, 0.1, 0.06, 0, -0.31, 0.01, 0.85], // hand
  [0.09, 0.06, 0.03, 0, -0.38, 0.025, 0.65], // hooked fingers
];
const THIGH: BoxSpec[] = [[0.15, 0.42, 0.16, 0, -0.2, 0, 1]];
const SHIN: BoxSpec[] = [
  [0.12, 0.4, 0.13, 0, -0.2, 0, 1],
  [0.13, 0.07, 0.24, 0, -0.42, 0.05, 0.35], // worn shoe
];
const AMMO_BOX: BoxSpec[] = [
  [0.38, 0.2, 0.24, 0, 0, 0, 0.55],
  [0.4, 0.035, 0.07, 0, 0.1, 0, 1],
  [0.07, 0.21, 0.25, -0.12, 0, 0, 0.8],
  [0.07, 0.21, 0.25, 0.12, 0, 0, 0.8],
];
const HEALTH_BOX: BoxSpec[] = [
  [0.32, 0.2, 0.32, 0, 0, 0, 0.55],
  [0.22, 0.025, 0.07, 0, 0.11, 0, 1.2],
  [0.07, 0.025, 0.22, 0, 0.11, 0, 1.2],
];

function instanced(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  castShadow: boolean,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const colors = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * 3).fill(1),
    3,
  );
  colors.setUsage(THREE.DynamicDrawUsage);
  mesh.instanceColor = colors;
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  return mesh;
}

/** Upload only the instances in use. */
function flush(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  const m = mesh.instanceMatrix;
  m.clearUpdateRanges();
  m.addUpdateRange(0, count * 16);
  m.needsUpdate = true;
  const c = mesh.instanceColor;
  if (c) {
    c.clearUpdateRanges();
    c.addUpdateRange(0, count * 3);
    c.needsUpdate = true;
  }
}

function setColor(
  mesh: THREE.InstancedMesh,
  index: number,
  base: THREE.Color,
  flash: number,
): void {
  const c = mesh.instanceColor;
  if (!c) return;
  c.setXYZ(
    index,
    base.r + (FLASH.r - base.r) * flash,
    base.g + (FLASH.g - base.g) * flash,
    base.b + (FLASH.b - base.b) * flash,
  );
}

// ---------------------------------------------------------------------------
// Zombie record
// ---------------------------------------------------------------------------

class Zombie {
  state = FREE;
  kind: ZombieKind = "walker";
  def: KindDef = KINDS.walker;
  x = 0;
  y = 0; // height of the pivot (feet, or body centre while flung)
  z = 0;
  vx = 0;
  vy = 0;
  vz = 0;
  yaw = 0;
  scale = 1;
  bulk = 1;
  speed = 1;
  hp = 0;
  // Look and gait.
  seed = 0;
  phase = 0;
  limp = 0;
  dangle = false;
  bareArms = false;
  wander = 0;
  // Behaviour timers.
  riseT = 0;
  attackT = -1;
  attackCooldown = 0;
  attackArm = 0;
  attackLanded = false;
  flinch = 0;
  flinchSide = 1;
  flash = 0;
  stagger = 0;
  feed = 0;
  groanTimer = 0;
  // Navigation.
  flowTimer = 0;
  stuckClock = 0;
  stuckTime = 0;
  lastDist = 0;
  sidestep = 0;
  sidestepSign = 1;
  // Death.
  deathType = TUMBLE;
  fallT = 0;
  tilt = 0;
  tiltTarget = 0;
  spin = 0;
  axisX = 1;
  axisZ = 0;
  pivot = 0; // 0 = feet, else body-centre height at scale 1
  landed = false;
  buried = 0;
  sink = 0;
  corpseT = 0;
  readonly pose = new Float32Array(POSE_N);
  readonly target = new Float32Array(POSE_N);
  readonly skin = new THREE.Color();
  readonly shirt = new THREE.Color();
  readonly pants = new THREE.Color();
  readonly sleeve = new THREE.Color();
}

// ---------------------------------------------------------------------------
// Static cover: collision boxes + flow field
// ---------------------------------------------------------------------------

const INF = 0x3fffffff;
const HEAP_KEY = 8192; // > number of nav cells
const NEIGHBOURS = [
  [1, 0, 10],
  [-1, 0, 10],
  [0, 1, 10],
  [0, -1, 10],
  [1, 1, 14],
  [1, -1, 14],
  [-1, 1, 14],
  [-1, -1, 14],
] as const;
const NEIGHBOUR_LEN = NEIGHBOURS.map(([x, z]) => Math.hypot(x, z));

/**
 * Static props as oriented boxes in a coarse lookup grid (circle pushes), plus a 1 m navigation
 * grid with a Dijkstra cost field toward the player (octile costs 10/14, no corner cutting).
 */
class CoverMap {
  minX = 0;
  minZ = 0;
  cols = 0;
  rows = 0;
  blocked = new Uint8Array(0);
  cost = new Int32Array(0);
  /** flow() result. */
  dirX = 0;
  dirZ = 0;
  /** resolve() result. */
  outX = 0;
  outZ = 0;

  private heap = new Float64Array(0);
  private heapSize = 0;
  private source = -1;
  private boxes = new Float32Array(0); // cx, cz, hx, hz, cos, sin
  private colMinX = 0;
  private colMinZ = 0;
  private colCols = 0;
  private colRows = 0;
  private colStart = new Int32Array(1);
  private colItems = new Int32Array(0);

  build(
    props: readonly Prop[],
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): void {
    const statics = props.filter((p) => !p.dynamic && p.bounds);
    const boxes = new Float32Array(statics.length * 6);
    statics.forEach((p, i) => {
      const b = p.bounds!;
      boxes.set(
        [
          b.center.x,
          b.center.z,
          b.halfExtents.x,
          b.halfExtents.z,
          Math.cos(b.yaw),
          Math.sin(b.yaw),
        ],
        i * 6,
      );
    });
    this.boxes = boxes;

    // Collision lookup: each box listed in every cell its inflated AABB touches.
    const margin = 0.8;
    this.colMinX = minX - 4;
    this.colMinZ = minZ - 4;
    this.colCols = Math.ceil((maxX - minX + 8) / COLLISION_CELL);
    this.colRows = Math.ceil((maxZ - minZ + 8) / COLLISION_CELL);
    const lists: number[][] = Array.from(
      { length: this.colCols * this.colRows },
      () => [],
    );
    for (let i = 0; i < statics.length; i++) {
      const o = i * 6;
      const ex =
        Math.abs(boxes[o + 2] * boxes[o + 4]) +
        Math.abs(boxes[o + 3] * boxes[o + 5]);
      const ez =
        Math.abs(boxes[o + 2] * boxes[o + 5]) +
        Math.abs(boxes[o + 3] * boxes[o + 4]);
      const c0 = this.colCell(boxes[o] - ex - margin, true);
      const c1 = this.colCell(boxes[o] + ex + margin, true);
      const r0 = this.colCell(boxes[o + 1] - ez - margin, false);
      const r1 = this.colCell(boxes[o + 1] + ez + margin, false);
      for (let r = r0; r <= r1; r++)
        for (let c = c0; c <= c1; c++) lists[r * this.colCols + c].push(i);
    }
    this.colStart = new Int32Array(lists.length + 1);
    let total = 0;
    lists.forEach((list, i) => {
      this.colStart[i] = total;
      total += list.length;
    });
    this.colStart[lists.length] = total;
    this.colItems = new Int32Array(total);
    lists.forEach((list, i) => this.colItems.set(list, this.colStart[i]));

    // Navigation grid: a cell is blocked when its centre is within a body radius of cover.
    this.minX = minX;
    this.minZ = minZ;
    this.cols = Math.ceil((maxX - minX) / NAV_CELL);
    this.rows = Math.ceil((maxZ - minZ) / NAV_CELL);
    const cells = this.cols * this.rows;
    this.blocked = new Uint8Array(cells);
    this.cost = new Int32Array(cells).fill(INF);
    this.heap = new Float64Array(cells * 8 + 8);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const x = minX + (c + 0.5) * NAV_CELL;
        const z = minZ + (r + 0.5) * NAV_CELL;
        if (this.insideAny(x, z, 0.42)) this.blocked[r * this.cols + c] = 1;
      }
    }
    this.source = -1;
  }

  cellAt(x: number, z: number): number {
    const c = clamp(Math.floor((x - this.minX) / NAV_CELL), 0, this.cols - 1);
    const r = clamp(Math.floor((z - this.minZ) / NAV_CELL), 0, this.rows - 1);
    return r * this.cols + c;
  }

  /** Walkable and connected to the player. */
  isOpen(x: number, z: number): boolean {
    const i = this.cellAt(x, z);
    return this.blocked[i] === 0 && this.cost[i] < INF;
  }

  /** Path length (m) from (x, z) to the player, Infinity when unreachable. */
  pathLength(x: number, z: number): number {
    const c = this.cost[this.cellAt(x, z)];
    return c >= INF ? Infinity : (c / 10) * NAV_CELL;
  }

  /** Rebuild the cost field when the player enters another cell. */
  updateField(px: number, pz: number): void {
    const src = this.cellAt(px, pz);
    if (src === this.source) return;
    this.source = src;
    const { cost, blocked, cols, rows } = this;
    cost.fill(INF);
    cost[src] = 0;
    this.heapSize = 0;
    this.push(src);
    while (this.heapSize > 0) {
      const key = this.pop();
      const here = Math.floor(key / HEAP_KEY);
      const cell = key - here * HEAP_KEY;
      if (here > cost[cell]) continue;
      const cx = cell % cols;
      const cz = (cell - cx) / cols;
      for (let k = 0; k < 8; k++) {
        const nb = NEIGHBOURS[k];
        const nx = cx + nb[0];
        const nz = cz + nb[1];
        if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
        const n = nz * cols + nx;
        if (blocked[n]) continue;
        if (k >= 4 && (blocked[cz * cols + nx] || blocked[nz * cols + cx]))
          continue;
        const next = here + nb[2];
        if (next < cost[n]) {
          cost[n] = next;
          this.push(n);
        }
      }
    }
  }

  /** Downhill direction of the cost field at (x, z) into dirX/dirZ; false if none. */
  flow(x: number, z: number): boolean {
    const { cost, blocked, cols, rows } = this;
    const cell = this.cellAt(x, z);
    const cx = cell % cols;
    const cz = (cell - cx) / cols;
    let lowest = INF;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NEIGHBOURS[k][0];
      const nz = cz + NEIGHBOURS[k][1];
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const n = nz * cols + nx;
      if (!blocked[n] && cost[n] < lowest) lowest = cost[n];
    }
    if (lowest >= INF) return false;
    const here = cost[cell] < INF ? cost[cell] : lowest + 10;
    let sx = 0;
    let sz = 0;
    for (let k = 0; k < 8; k++) {
      const nx = cx + NEIGHBOURS[k][0];
      const nz = cz + NEIGHBOURS[k][1];
      if (nx < 0 || nz < 0 || nx >= cols || nz >= rows) continue;
      const n = nz * cols + nx;
      if (blocked[n] || cost[n] >= here) continue;
      const w = (here - cost[n]) / (NEIGHBOUR_LEN[k] * NEIGHBOUR_LEN[k]);
      sx += NEIGHBOURS[k][0] * w;
      sz += NEIGHBOURS[k][1] * w;
    }
    // Pull toward the cell centre a little so bodies do not hug corners.
    sx += (this.minX + (cx + 0.5) * NAV_CELL - x) * 0.6;
    sz += (this.minZ + (cz + 0.5) * NAV_CELL - z) * 0.6;
    const len = Math.hypot(sx, sz);
    if (len < 1e-5) return false;
    this.dirX = sx / len;
    this.dirZ = sz / len;
    return true;
  }

  /** Push a circle out of every static box; result in outX/outZ. Returns the push length. */
  resolve(x: number, z: number, r: number): number {
    const sx = x;
    const sz = z;
    const c = clamp(
      Math.floor((x - this.colMinX) / COLLISION_CELL),
      0,
      this.colCols - 1,
    );
    const row = clamp(
      Math.floor((z - this.colMinZ) / COLLISION_CELL),
      0,
      this.colRows - 1,
    );
    const cell = row * this.colCols + c;
    const b = this.boxes;
    for (let i = this.colStart[cell]; i < this.colStart[cell + 1]; i++) {
      const o = this.colItems[i] * 6;
      const cos = b[o + 4];
      const sin = b[o + 5];
      const hx = b[o + 2];
      const hz = b[o + 3];
      const dx = x - b[o];
      const dz = z - b[o + 1];
      let lx = dx * cos - dz * sin;
      let lz = dx * sin + dz * cos;
      const ex = lx - clamp(lx, -hx, hx);
      const ez = lz - clamp(lz, -hz, hz);
      const d2 = ex * ex + ez * ez;
      if (d2 >= r * r) continue;
      if (d2 > 1e-8) {
        const d = Math.sqrt(d2);
        const k = (r - d) / d;
        lx += ex * k;
        lz += ez * k;
      } else if (hx - Math.abs(lx) < hz - Math.abs(lz)) {
        lx = (lx < 0 ? -1 : 1) * (hx + r);
      } else {
        lz = (lz < 0 ? -1 : 1) * (hz + r);
      }
      x = b[o] + lx * cos + lz * sin;
      z = b[o + 1] - lx * sin + lz * cos;
    }
    this.outX = x;
    this.outZ = z;
    return Math.hypot(x - sx, z - sz);
  }

  private insideAny(x: number, z: number, pad: number): boolean {
    const b = this.boxes;
    for (let o = 0; o < b.length; o += 6) {
      const dx = x - b[o];
      const dz = z - b[o + 1];
      const lx = dx * b[o + 4] - dz * b[o + 5];
      const lz = dx * b[o + 5] + dz * b[o + 4];
      if (Math.abs(lx) <= b[o + 2] + pad && Math.abs(lz) <= b[o + 3] + pad)
        return true;
    }
    return false;
  }

  private colCell(v: number, isX: boolean): number {
    return isX
      ? clamp(
          Math.floor((v - this.colMinX) / COLLISION_CELL),
          0,
          this.colCols - 1,
        )
      : clamp(
          Math.floor((v - this.colMinZ) / COLLISION_CELL),
          0,
          this.colRows - 1,
        );
  }

  private push(cell: number): void {
    const h = this.heap;
    let i = this.heapSize++;
    h[i] = this.cost[cell] * HEAP_KEY + cell;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (h[parent] <= h[i]) break;
      const t = h[parent];
      h[parent] = h[i];
      h[i] = t;
      i = parent;
    }
  }

  private pop(): number {
    const h = this.heap;
    const top = h[0];
    const last = h[--this.heapSize];
    let i = 0;
    const n = this.heapSize;
    if (n > 0) {
      h[0] = last;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const m = r < n && h[r] < h[l] ? r : l;
        if (h[i] <= h[m]) break;
        const t = h[m];
        h[m] = h[i];
        h[i] = t;
        i = m;
      }
    }
    return top;
  }
}

// ---------------------------------------------------------------------------
// Spatial hash (counting sort, rebuilt every frame)
// ---------------------------------------------------------------------------

class SpatialHash {
  readonly start: Int32Array;
  readonly items = new Int32Array(CAPACITY);
  private readonly cellOf = new Int32Array(CAPACITY);

  constructor(
    readonly minX: number,
    readonly minZ: number,
    readonly cols: number,
    readonly rows: number,
  ) {
    this.start = new Int32Array(cols * rows + 1);
  }

  cellX(x: number): number {
    return clamp(Math.floor((x - this.minX) / HASH_CELL), 0, this.cols - 1);
  }

  cellZ(z: number): number {
    return clamp(Math.floor((z - this.minZ) / HASH_CELL), 0, this.rows - 1);
  }

  build(zombies: readonly Zombie[]): void {
    const { start, cellOf } = this;
    start.fill(0);
    for (let i = 0; i < zombies.length; i++) {
      const z = zombies[i];
      if (z.state !== ALIVE && z.state !== RISING) {
        cellOf[i] = -1;
        continue;
      }
      const c = this.cellZ(z.z) * this.cols + this.cellX(z.x);
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 1; c < start.length; c++) start[c] += start[c - 1];
    // Fill using start[c] as a cursor, then shift back.
    for (let i = 0; i < zombies.length; i++) {
      const c = cellOf[i];
      if (c >= 0) this.items[start[c]++] = i;
    }
    for (let c = start.length - 1; c > 0; c--) start[c] = start[c - 1];
    start[0] = 0;
  }
}

// ---------------------------------------------------------------------------
// Pickups
// ---------------------------------------------------------------------------

const AMMO = 0;
const HEALTH = 1;

/** Glowing ammo crates / health kits dropped by zombies (two instanced meshes). */
class Pickups {
  readonly ammoMesh: THREE.InstancedMesh;
  readonly healthMesh: THREE.InstancedMesh;
  private readonly kind = new Uint8Array(PICKUP_CAPACITY);
  private readonly active = new Uint8Array(PICKUP_CAPACITY);
  private readonly px = new Float32Array(PICKUP_CAPACITY);
  private readonly pz = new Float32Array(PICKUP_CAPACITY);
  private readonly age = new Float32Array(PICKUP_CAPACITY);
  private readonly spinSeed = new Float32Array(PICKUP_CAPACITY);
  private next = 0;
  private readonly eventPos = new THREE.Vector3();

  constructor(private readonly ctx: GameContext) {
    const material = new THREE.MeshBasicMaterial({ vertexColors: true });
    this.ammoMesh = instanced(
      mergeBoxes(AMMO_BOX),
      material,
      PICKUP_CAPACITY,
      false,
    );
    this.healthMesh = instanced(
      mergeBoxes(HEALTH_BOX),
      material,
      PICKUP_CAPACITY,
      false,
    );
  }

  spawn(kind: number, x: number, z: number): void {
    let slot = this.active.indexOf(0);
    if (slot < 0) {
      slot = this.next;
      this.next = (this.next + 1) % PICKUP_CAPACITY;
    }
    this.active[slot] = 1;
    this.kind[slot] = kind;
    this.px[slot] = x;
    this.pz[slot] = z;
    this.age[slot] = 0;
    this.spinSeed[slot] = Math.random() * TAU;
  }

  update(dt: number, time: number): void {
    const { player, weapons, events } = this.ctx;
    let ammo = 0;
    let health = 0;
    for (let i = 0; i < PICKUP_CAPACITY; i++) {
      if (!this.active[i]) continue;
      const age = (this.age[i] += dt);
      const x = this.px[i];
      const z = this.pz[i];
      const isAmmo = this.kind[i] === AMMO;
      const dx = player.position.x - x;
      const dz = player.position.z - z;
      const wanted = isAmmo || player.health < player.maxHealth;
      if (
        !player.dead &&
        wanted &&
        dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS
      ) {
        if (isAmmo) weapons.addAmmo(PICKUP_AMMO);
        else player.heal(PICKUP_HEAL);
        events.emit("pickup", {
          kind: isAmmo ? "ammo" : "health",
          position: this.eventPos.set(x, 0.3, z),
        });
        this.active[i] = 0;
        continue;
      }
      if (age >= PICKUP_LIFE) {
        this.active[i] = 0;
        continue;
      }
      // Blink before despawning.
      if (age > PICKUP_LIFE - PICKUP_BLINK && Math.floor(age * 8) % 2 === 1)
        continue;
      const appear = Math.min(1, age * 4);
      _pos.set(x, 0.32 + 0.07 * Math.sin(time * 3 + this.spinSeed[i]), z);
      _quat.setFromAxisAngle(UP, time * 1.8 + this.spinSeed[i]);
      _scale.setScalar(appear);
      _end.compose(_pos, _quat, _scale);
      const mesh = isAmmo ? this.ammoMesh : this.healthMesh;
      const index = isAmmo ? ammo++ : health++;
      mesh.setMatrixAt(index, _end);
      setColor(mesh, index, isAmmo ? AMMO_COLOR : HEALTH_COLOR, 0);
    }
    flush(this.ammoMesh, ammo);
    flush(this.healthMesh, health);
  }

  clear(): void {
    this.active.fill(0);
    flush(this.ammoMesh, 0);
    flush(this.healthMesh, 0);
  }
}

// ---------------------------------------------------------------------------
// Horde
// ---------------------------------------------------------------------------

/**
 * Waves of zombies: instanced low-poly bodies with procedural animation, steering toward the
 * player around cover, attacks, deaths/corpses, explosions, ammo/health pickups.
 */
export class ZombieHorde {
  /** Current wave number (0 before the first wave starts). */
  wave = 0;
  phase: WavePhase = "intermission";
  /** Seconds left in the break before the next wave. */
  intermissionLeft = 0;
  /** Zombies alive right now. */
  alive = 0;
  /** Zombies of this wave not yet killed (alive + still to spawn). */
  remaining = 0;
  /** True between start() and reset(). */
  started = false;

  private readonly zombies: Zombie[] = Array.from(
    { length: CAPACITY },
    () => new Zombie(),
  );
  private readonly cover = new CoverMap();
  private hash: SpatialHash | null = null;
  private readonly pickups: Pickups;
  private readonly root = new THREE.Group();
  private readonly headMesh: THREE.InstancedMesh;
  private readonly torsoMesh: THREE.InstancedMesh;
  private readonly pelvisMesh: THREE.InstancedMesh;
  private readonly upperArmMesh: THREE.InstancedMesh;
  private readonly forearmMesh: THREE.InstancedMesh;
  private readonly thighMesh: THREE.InstancedMesh;
  private readonly shinMesh: THREE.InstancedMesh;

  private ready = false;
  private arena = { ...FALLBACK_ARENA };
  private toSpawn = 0;
  private spawnTimer = 0;
  private fieldTimer = 0;
  private time = 0;
  private groanTokens = 1;
  private spawnX = 0;
  private spawnZ = 0;
  // Per-frame list of physics props zombies can bump into.
  private readonly dynBodies: CANNON.Body[] = [];
  private dynBox = new Float32Array(4 * 128);
  private dynCount = 0;

  private readonly frustum = new THREE.Frustum();
  private readonly viewProj = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere(new THREE.Vector3(), 1.2);
  private readonly eventPos = new THREE.Vector3();
  private readonly offExplosion: () => void;

  constructor(private readonly ctx: GameContext) {
    const material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.headMesh = instanced(buildHead(), material, CAPACITY, true);
    this.torsoMesh = instanced(mergeBoxes(TORSO), material, CAPACITY, true);
    this.pelvisMesh = instanced(mergeBoxes(PELVIS), material, CAPACITY, false);
    this.upperArmMesh = instanced(
      mergeBoxes(UPPER_ARM),
      material,
      CAPACITY * 2,
      false,
    );
    this.forearmMesh = instanced(
      mergeBoxes(FOREARM),
      material,
      CAPACITY * 2,
      false,
    );
    this.thighMesh = instanced(
      mergeBoxes(THIGH),
      material,
      CAPACITY * 2,
      false,
    );
    this.shinMesh = instanced(mergeBoxes(SHIN), material, CAPACITY * 2, false);
    this.pickups = new Pickups(ctx);
    this.root.name = "zombies";
    this.root.add(
      this.headMesh,
      this.torsoMesh,
      this.pelvisMesh,
      this.upperArmMesh,
      this.forearmMesh,
      this.thighMesh,
      this.shinMesh,
      this.pickups.ammoMesh,
      this.pickups.healthMesh,
    );
    ctx.scene.add(this.root);
    this.offExplosion = ctx.events.on("explosion", ({ position, radius }) =>
      this.onExplosion(position, radius),
    );
  }

  /** Begin the countdown to wave 1 (called once the player dismisses the intro). */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.phase = "intermission";
    this.intermissionLeft = START_DELAY;
  }

  /** Closest living zombie along a ray (dir normalised) within maxDist; writes into out. */
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    out: ZombieHit,
  ): ZombieHit | null {
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const dx = dir.x;
    const dy = dir.y;
    const dz = dir.z;
    const a = dx * dx + dz * dz;
    let best = maxDist;
    let bestIndex = -1;
    let hx = 0;
    let hy = 0;
    let hz = 0;
    let nx = 0;
    let ny = 0;
    let nz = 0;
    for (let i = 0; i < CAPACITY; i++) {
      const zb = this.zombies[i];
      if (zb.state !== ALIVE && (zb.state !== RISING || zb.riseT < 0.35))
        continue;
      const s = zb.scale;
      const r = HIT_RADIUS * s * zb.bulk;
      // The hunch puts the upper body a little ahead of the feet.
      const cx = zb.x + Math.sin(zb.yaw) * 0.1 * s;
      const cz = zb.z + Math.cos(zb.yaw) * 0.1 * s;
      const ex = ox - cx;
      const ez = oz - cz;
      // Cheap 2D reject: the ray's closest approach misses the circle.
      const along = -(ex * dx + ez * dz);
      if (along < -r || along - r > best * Math.sqrt(a) + r) continue;
      const bottom = zb.y + 0.25;
      const capY = zb.y + HEIGHT * s - r;
      let t = -1;
      let side = false;
      if (a > 1e-6) {
        const b = ex * dx + ez * dz;
        const c = ex * ex + ez * ez - r * r;
        const disc = b * b - a * c;
        if (disc < 0) continue;
        const sq = Math.sqrt(disc);
        if ((-b + sq) / a < 0) continue;
        const t0 = Math.max(0, (-b - sq) / a);
        const y0 = oy + dy * t0;
        if (y0 >= bottom && y0 <= capY) {
          t = t0;
          side = true;
        }
      }
      if (t < 0) {
        // Rounded top (skull) for steep or high rays.
        const sy = oy - capY;
        const b = ex * dx + sy * dy + ez * dz;
        const c = ex * ex + sy * sy + ez * ez - r * r;
        const disc = b * b - c;
        if (disc < 0) continue;
        t = Math.max(0, -b - Math.sqrt(disc));
        if (-b + Math.sqrt(disc) < 0) continue;
      }
      if (t >= best) continue;
      best = t;
      bestIndex = i;
      hx = ox + dx * t;
      hy = oy + dy * t;
      hz = oz + dz * t;
      if (side) {
        nx = (hx - cx) / r;
        ny = 0;
        nz = (hz - cz) / r;
      } else {
        nx = (hx - cx) / r;
        ny = (hy - capY) / r;
        nz = (hz - cz) / r;
      }
    }
    if (bestIndex < 0) return null;
    const zb = this.zombies[bestIndex];
    out.index = bestIndex;
    out.distance = best;
    out.point.set(hx, hy, hz);
    out.normal.set(nx, ny, nz).normalize();
    out.headshot = hy - zb.y > HEADSHOT_FRACTION * HEIGHT * zb.scale;
    return out;
  }

  /** Apply bullet damage. dir = bullet direction, point = hit point. */
  damage(
    index: number,
    amount: number,
    dir: THREE.Vector3,
    point: THREE.Vector3,
    headshot: boolean,
  ): void {
    const z = this.zombies[index];
    if (!z || (z.state !== ALIVE && z.state !== RISING) || amount <= 0) return;
    z.hp -= amount * (headshot ? z.def.headshotMul : 1);
    z.flash = FLASH_TIME;
    z.flinch = Math.min(1, z.flinch + 0.35 + amount / 60);
    z.flinchSide = Math.random() < 0.5 ? -1 : 1;
    if (z.state === ALIVE) {
      const shove = Math.min(1.5, amount / 25) / (z.scale * z.scale);
      z.vx += dir.x * shove;
      z.vz += dir.z * shove;
    }
    if (headshot) this.ctx.fx.blood(point, dir, 0.9);
    this.ctx.events.emit("zombieHit", {
      position: this.eventPos.copy(point),
      headshot,
    });
    if (z.hp <= 0) {
      this.kill(z, headshot ? CRUMPLE : TUMBLE, dir.x, dir.z, headshot);
      this.ctx.fx.blood(point, dir, headshot ? 2.6 : 2);
    }
  }

  update(dt: number): void {
    if (!this.ready && !this.init()) return;
    this.time += dt;
    const player = this.ctx.player;
    this.updateWaves(dt);

    this.fieldTimer -= dt;
    if (this.fieldTimer <= 0) {
      this.fieldTimer = 0.2;
      this.cover.updateField(player.position.x, player.position.z);
    }
    this.collectDynamicProps();
    this.hash!.build(this.zombies);

    this.groanTokens = Math.min(2, this.groanTokens + GROAN_RATE * dt);
    const kAlive = 1 - Math.exp(-20 * dt);
    const kRise = 1 - Math.exp(-12 * dt);
    const kDead = 1 - Math.exp(-8 * dt);

    let drawn = 0;
    for (let i = 0; i < CAPACITY; i++) {
      const z = this.zombies[i];
      if (z.state === FREE) continue;
      z.flash = Math.max(0, z.flash - dt);
      z.flinch = Math.max(0, z.flinch - dt * 4);
      if (z.state === ALIVE) {
        this.think(z, i, dt);
        this.poseAlive(z);
        this.smoothPose(z, kAlive);
      } else if (z.state === RISING) {
        this.updateRising(z, dt);
        this.smoothPose(z, kRise);
      } else {
        this.updateDead(z, dt);
        if (z.state === FREE) continue;
        this.smoothPose(z, kDead);
      }
      this.draw(z, drawn++);
    }
    flush(this.headMesh, drawn);
    flush(this.torsoMesh, drawn);
    flush(this.pelvisMesh, drawn);
    flush(this.upperArmMesh, drawn * 2);
    flush(this.forearmMesh, drawn * 2);
    flush(this.thighMesh, drawn * 2);
    flush(this.shinMesh, drawn * 2);
    this.pickups.update(dt, this.time);
    this.remaining = this.toSpawn + this.alive;
  }

  /** Back to wave 0 with an empty arena (F9 / restart). */
  reset(): void {
    for (const z of this.zombies) z.state = FREE;
    this.wave = 0;
    this.phase = "intermission";
    this.intermissionLeft = 0;
    this.alive = 0;
    this.remaining = 0;
    this.toSpawn = 0;
    this.started = false;
    this.pickups.clear();
    for (const mesh of [
      this.headMesh,
      this.torsoMesh,
      this.pelvisMesh,
      this.upperArmMesh,
      this.forearmMesh,
      this.thighMesh,
      this.shinMesh,
    ])
      flush(mesh, 0);
  }

  dispose(): void {
    this.offExplosion();
    this.ctx.scene.remove(this.root);
  }

  // -------------------------------------------------------------------------
  // Setup and waves
  // -------------------------------------------------------------------------

  /** Builds the cover map once the world exists. */
  private init(): boolean {
    const props = this.ctx.world.props;
    if (props.length === 0) return false;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const p of props) {
      if (p.kind !== "fence" || !p.bounds) continue;
      minX = Math.min(minX, p.bounds.center.x);
      maxX = Math.max(maxX, p.bounds.center.x);
      minZ = Math.min(minZ, p.bounds.center.z);
      maxZ = Math.max(maxZ, p.bounds.center.z);
    }
    if (maxX - minX > 10 && maxZ - minZ > 10)
      this.arena = { minX, maxX, minZ, maxZ };
    const a = this.arena;
    this.cover.build(props, a.minX, a.maxX, a.minZ, a.maxZ);
    this.hash = new SpatialHash(
      a.minX - 2,
      a.minZ - 2,
      Math.ceil((a.maxX - a.minX + 4) / HASH_CELL),
      Math.ceil((a.maxZ - a.minZ + 4) / HASH_CELL),
    );
    this.ready = true;
    return true;
  }

  private updateWaves(dt: number): void {
    if (!this.started) return;
    if (this.phase === "intermission") {
      this.intermissionLeft = Math.max(0, this.intermissionLeft - dt);
      if (this.intermissionLeft > 0) return;
      this.wave++;
      this.phase = "active";
      this.toSpawn = 14 + 9 * (this.wave - 1);
      this.spawnTimer = 0.3;
      this.ctx.events.emit("waveStart", {
        wave: this.wave,
        count: this.toSpawn,
      });
      return;
    }
    this.spawnTimer -= dt;
    if (this.toSpawn > 0 && this.spawnTimer <= 0) {
      const burst = this.wave >= 3 && Math.random() < 0.4 ? 2 : 1;
      for (let n = 0; n < burst && this.toSpawn > 0; n++) {
        if (this.alive >= MAX_ALIVE || !this.pickSpawnPoint()) break;
        if (!this.spawn(this.rollKind(), this.spawnX, this.spawnZ)) break;
        this.toSpawn--;
      }
      this.spawnTimer = rand(SPAWN_INTERVAL[0], SPAWN_INTERVAL[1]);
    }
    if (this.toSpawn === 0 && this.alive === 0) {
      this.ctx.events.emit("waveCleared", { wave: this.wave });
      this.phase = "intermission";
      this.intermissionLeft = INTERMISSION;
    }
  }

  private rollKind(): ZombieKind {
    const r = Math.random();
    const brute = this.wave >= 4 ? 0.08 : 0;
    const runner = this.wave >= 3 ? 0.2 : 0;
    if (r < brute) return "brute";
    if (r < brute + runner) return "runner";
    return "walker";
  }

  /**
   * Somewhere on the arena edge (or a reachable open cell) at least SPAWN_MIN_DIST from the
   * player, preferably off-screen and not absurdly far. Writes spawnX/spawnZ.
   */
  private pickSpawnPoint(): boolean {
    const cam = this.ctx.cameraRig.camera;
    this.viewProj.multiplyMatrices(
      cam.projectionMatrix,
      cam.matrixWorldInverse,
    );
    this.frustum.setFromProjectionMatrix(this.viewProj);
    const p = this.ctx.player.position;
    const a = this.arena;
    const inset = 1.4;
    const w = a.maxX - a.minX - inset * 2;
    const h = a.maxZ - a.minZ - inset * 2;
    let bestScore = -Infinity;
    for (let i = 0; i < 16; i++) {
      let x: number;
      let z: number;
      if (Math.random() < 0.7) {
        let t = Math.random() * (w + h) * 2;
        if (t < w) ((x = a.minX + inset + t), (z = a.minZ + inset));
        else if ((t -= w) < w) ((x = a.minX + inset + t), (z = a.maxZ - inset));
        else if ((t -= w) < h) ((x = a.minX + inset), (z = a.minZ + inset + t));
        else ((x = a.maxX - inset), (z = a.minZ + inset + (t - h)));
      } else {
        x = a.minX + inset + Math.random() * w;
        z = a.minZ + inset + Math.random() * h;
      }
      if (!this.cover.isOpen(x, z)) continue;
      const d = Math.hypot(x - p.x, z - p.z);
      if (d < SPAWN_MIN_DIST) continue;
      this.sphere.center.set(x, 0.9, z);
      const hidden = !this.frustum.intersectsSphere(this.sphere);
      const score = (hidden ? 100 : 0) - Math.abs(d - 27);
      if (score > bestScore) {
        bestScore = score;
        this.spawnX = x;
        this.spawnZ = z;
        if (hidden && d < 34) break;
      }
    }
    return bestScore > -Infinity;
  }

  private spawn(kind: ZombieKind, x: number, z: number): boolean {
    const slot = this.allocSlot();
    if (slot < 0) return false;
    const zb = this.zombies[slot];
    const def = KINDS[kind];
    const waveMul = 1 + Math.min(0.3, 0.035 * (this.wave - 1));
    zb.state = RISING;
    zb.kind = kind;
    zb.def = def;
    zb.x = x;
    zb.z = z;
    zb.vx = zb.vy = zb.vz = 0;
    const p = this.ctx.player.position;
    zb.yaw = Math.atan2(p.x - x, p.z - z);
    zb.scale = rand(def.scale[0], def.scale[1]);
    zb.bulk = def.bulk * rand(0.95, 1.06);
    zb.speed = rand(def.speed[0], def.speed[1]) * waveMul;
    zb.hp = def.hp;
    zb.seed = Math.random() * TAU;
    zb.phase = Math.random() * TAU;
    zb.limp = kind === "walker" ? rand(0.3, 1.2) : rand(0, 0.2);
    zb.dangle = kind === "walker" && Math.random() < 0.25;
    zb.wander = rand(-0.5, 0.5);
    zb.riseT = 0;
    zb.buried = -1.75 * zb.scale;
    zb.y = zb.buried;
    zb.attackT = -1;
    zb.attackCooldown = rand(0.2, 0.8);
    zb.flinch = zb.flash = zb.stagger = zb.feed = 0;
    zb.groanTimer = rand(0.3, 4);
    zb.flowTimer = zb.stuckTime = zb.stuckClock = zb.sidestep = 0;
    zb.lastDist = Math.hypot(p.x - x, p.z - z);
    zb.tilt = zb.tiltTarget = 0;
    zb.pivot = 0;
    zb.corpseT = 0;
    zb.sink = 0;

    if (kind === "brute") {
      zb.skin.copy(pick(BRUTE_SKIN));
      zb.shirt.copy(Math.random() < 0.4 ? zb.skin : pick(BRUTE_SHIRT));
    } else {
      zb.skin.copy(pick(kind === "runner" ? RUNNER_SKIN : SKIN));
      zb.shirt.copy(pick(SHIRT));
    }
    // Slight per-zombie tint so a crowd never looks cloned.
    const tint = rand(0.88, 1.08);
    zb.skin.multiplyScalar(tint);
    zb.shirt.multiplyScalar(rand(0.8, 1.05));
    zb.pants.copy(pick(PANTS)).multiplyScalar(rand(0.85, 1.1));
    zb.bareArms = Math.random() < 0.45;
    zb.sleeve.copy(zb.bareArms ? zb.skin : zb.shirt);

    this.poseRising(zb, 0);
    zb.pose.set(zb.target);
    this.alive++;
    _pos.set(x, 0.05, z);
    this.ctx.fx.dust(_pos, UP, 3, GROUND_DUST);
    return true;
  }

  /** A free slot, else the oldest corpse is recycled. */
  private allocSlot(): number {
    let oldest = -1;
    let oldestT = -1;
    for (let i = 0; i < CAPACITY; i++) {
      const z = this.zombies[i];
      if (z.state === FREE) return i;
      if (z.state === DEAD && z.corpseT > oldestT) {
        oldestT = z.corpseT;
        oldest = i;
      }
    }
    return oldest;
  }

  // -------------------------------------------------------------------------
  // Behaviour
  // -------------------------------------------------------------------------

  private updateRising(z: Zombie, dt: number): void {
    z.riseT = Math.min(1, z.riseT + dt / RISE_TIME);
    const u = z.riseT;
    // Jerky claw up: ease out with a few stutters.
    const e =
      1 - (1 - u) * (1 - u) * (1 - u) + Math.sin(u * 22) * 0.025 * (1 - u);
    z.buried = -(1 - Math.min(1, e)) * 1.75 * z.scale;
    z.y = z.buried;
    const p = this.ctx.player.position;
    z.yaw = turnToward(z.yaw, Math.atan2(p.x - z.x, p.z - z.z), dt * 1.5);
    if (u < 0.85 && Math.random() < dt * 14) {
      _pos.set(z.x + rand(-0.4, 0.4), 0.04, z.z + rand(-0.4, 0.4));
      this.ctx.fx.dust(_pos, UP, 1, GROUND_DUST);
    }
    this.poseRising(z, u);
    if (u >= 1) {
      z.state = ALIVE;
      z.y = 0;
      z.buried = 0;
    }
    this.groan(z, Math.hypot(p.x - z.x, p.z - z.z), dt);
  }

  /** Steering, collisions, attacks for one living zombie. */
  private think(z: Zombie, index: number, dt: number): void {
    const def = z.def;
    const player = this.ctx.player;
    const px = player.position.x;
    const pz = player.position.z;
    let dx = px - z.x;
    let dz = pz - z.z;
    const dist = Math.hypot(dx, dz) || 1e-4;
    dx /= dist;
    dz /= dist;
    const reach = def.reach;

    z.attackCooldown -= dt;
    z.stagger = Math.max(0, z.stagger - dt);
    z.flowTimer = Math.max(0, z.flowTimer - dt);

    // Desired heading and speed.
    let tx = 0;
    let tz = 0;
    let speed = z.speed;
    let feeding = false;
    if (player.dead) {
      if (dist < 7) {
        const ring = 0.75 + BODY_RADIUS * z.scale;
        if (dist > ring) {
          tx = dx;
          tz = dz;
          speed *= 0.6;
        } else {
          speed = 0;
          feeding = true;
        }
      } else {
        z.wander += (Math.random() - 0.5) * dt * 2;
        tx = Math.sin(z.wander + z.seed);
        tz = Math.cos(z.wander + z.seed);
        speed = 0.45;
      }
    } else if (dist <= reach * 0.85 || z.stagger > 0) {
      speed = 0;
    } else {
      this.navigate(z, dx, dz, dist, dt);
      tx = this.navX;
      tz = this.navZ;
      if (dist < reach * 1.25) speed *= 0.5;
    }
    z.feed += ((feeding ? 1 : 0) - z.feed) * Math.min(1, dt * 3);
    if (z.attackT >= 0) speed *= 0.25;

    // Separation from neighbours (and a hard overlap fix); queue behind those ahead.
    let sepX = 0;
    let sepZ = 0;
    let crowd = 0;
    const hash = this.hash!;
    const r = BODY_RADIUS * z.scale * z.bulk;
    const hx = hash.cellX(z.x);
    const hz = hash.cellZ(z.z);
    for (
      let cz = Math.max(0, hz - 1);
      cz <= Math.min(hash.rows - 1, hz + 1);
      cz++
    ) {
      for (
        let cx = Math.max(0, hx - 1);
        cx <= Math.min(hash.cols - 1, hx + 1);
        cx++
      ) {
        const c = cz * hash.cols + cx;
        for (let k = hash.start[c]; k < hash.start[c + 1]; k++) {
          const j = hash.items[k];
          if (j === index) continue;
          const o = this.zombies[j];
          const ox = z.x - o.x;
          const oz = z.z - o.z;
          const d2 = ox * ox + oz * oz;
          const sepR = SEPARATION_RADIUS * (z.scale + o.scale) * 0.5;
          if (d2 >= sepR * sepR || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const w = 1 - d / sepR;
          sepX += (ox / d) * w;
          sepZ += (oz / d) * w;
          if (-(ox * tx + oz * tz) / d > 0.5) crowd += w;
          const minD = r + BODY_RADIUS * o.scale * o.bulk;
          if (d < minD) {
            const share =
              o.state === RISING
                ? 1
                : o.def.pushYield > def.pushYield
                  ? 0.35
                  : 0.5;
            const push = (minD - d) * share;
            z.x += (ox / d) * push;
            z.z += (oz / d) * push;
          }
        }
      }
    }

    // Velocity toward the target, with separation steering.
    if (crowd > 0) speed *= Math.max(0.2, 1 - crowd * 0.9);
    const wantX = tx * speed + sepX * 2.4;
    const wantZ = tz * speed + sepZ * 2.4;
    const k = Math.min(1, def.accel * dt);
    z.vx += (wantX - z.vx) * k;
    z.vz += (wantZ - z.vz) * k;
    const startX = z.x;
    const startZ = z.z;
    z.x += z.vx * dt;
    z.z += z.vz * dt;

    // Static cover: slide along it; a hard block switches to the flow field for a while.
    const pushed = this.cover.resolve(z.x, z.z, r);
    z.x = this.cover.outX;
    z.z = this.cover.outZ;
    if (pushed > Math.max(0.002, z.speed * dt * 0.5)) z.flowTimer = 1.5;
    this.pushDynamicProps(z, r, dt);

    // Never stand inside the player or leave the arena.
    const ox = z.x - px;
    const oz = z.z - pz;
    const minP = r + PLAYER_RADIUS;
    const d2 = ox * ox + oz * oz;
    if (d2 < minP * minP && d2 > 1e-8) {
      const d = Math.sqrt(d2);
      z.x = px + (ox / d) * minP;
      z.z = pz + (oz / d) * minP;
    }
    const a = this.arena;
    z.x = clamp(z.x, a.minX + 0.3 + r, a.maxX - 0.3 - r);
    z.z = clamp(z.z, a.minZ + 0.3 + r, a.maxZ - 0.3 - r);

    // Gait phase follows the ground actually covered.
    const moved = Math.hypot(z.x - startX, z.z - startZ);
    z.phase += (moved / (def.stepLength * z.scale)) * Math.PI;

    // Face the player when close or attacking, else the walking direction.
    let face = z.yaw;
    if (dist < 3 || z.attackT >= 0 || feeding) face = Math.atan2(dx, dz);
    else if (z.vx * z.vx + z.vz * z.vz > 0.04) face = Math.atan2(z.vx, z.vz);
    z.yaw = turnToward(z.yaw, face, def.turnRate * dt);

    this.updateAttack(z, dist, dt);
    this.groan(z, dist, dt);
  }

  // navigate() output (avoids returning objects).
  private navX = 0;
  private navZ = 0;

  /** Direct seek when the path is clear, else follow the flow field; stuck → side-step. */
  private navigate(
    z: Zombie,
    dx: number,
    dz: number,
    dist: number,
    dt: number,
  ): void {
    let nx = dx;
    let nz = dz;
    const path = this.cover.pathLength(z.x, z.z);
    const detour = path > dist * 1.12 + 1.5;
    if (
      dist > 2.5 &&
      (detour || z.flowTimer > 0) &&
      this.cover.flow(z.x, z.z)
    ) {
      nx = this.cover.dirX;
      nz = this.cover.dirZ;
    }

    // Stuck detection: little progress toward the player for ~1.5 s.
    z.stuckClock += dt;
    if (z.stuckClock >= 0.5) {
      const progress = z.lastDist - dist;
      z.stuckTime =
        progress < 0.12 * Math.min(1, z.speed) ? z.stuckTime + z.stuckClock : 0;
      z.lastDist = dist;
      z.stuckClock = 0;
      if (z.stuckTime >= 1.5) {
        z.stuckTime = 0;
        z.sidestep = 1;
        z.sidestepSign = Math.random() < 0.5 ? -1 : 1;
        z.flowTimer = 2.5;
      }
    }
    if (z.sidestep > 0) {
      z.sidestep -= dt;
      const s = z.sidestepSign;
      const sx = -nz * s * 0.9 + nx * 0.45;
      const sz = nx * s * 0.9 + nz * 0.45;
      nx = sx;
      nz = sz;
    } else if (dist > 3) {
      // Shamble jitter so crowds don't walk in single file.
      z.wander = clamp(z.wander + (Math.random() - 0.5) * dt * 3, -0.6, 0.6);
      const w = z.wander * Math.min(1, (dist - 3) / 6) * 0.55;
      const c = Math.cos(w);
      const s = Math.sin(w);
      const rx = nx * c - nz * s;
      nz = nx * s + nz * c;
      nx = rx;
    }
    const len = Math.hypot(nx, nz) || 1;
    this.navX = nx / len;
    this.navZ = nz / len;
  }

  /** Physics props in the way: the zombie yields, the prop gets shoved (wakes it up). */
  private pushDynamicProps(z: Zombie, r: number, dt: number): void {
    const box = this.dynBox;
    for (let i = 0; i < this.dynCount; i++) {
      const o = i * 4;
      if (
        z.x < box[o] - r ||
        z.x > box[o + 1] + r ||
        z.z < box[o + 2] - r ||
        z.z > box[o + 3] + r
      )
        continue;
      const qx = clamp(z.x, box[o], box[o + 1]);
      const qz = clamp(z.z, box[o + 2], box[o + 3]);
      let ex = z.x - qx;
      let ez = z.z - qz;
      let d = Math.hypot(ex, ez);
      let overlap: number;
      if (d > 1e-5) {
        overlap = r - d;
        if (overlap <= 0) continue;
        ex /= d;
        ez /= d;
      } else {
        // Centre inside the box: push out from its centre.
        ex = z.x - (box[o] + box[o + 1]) * 0.5;
        ez = z.z - (box[o + 2] + box[o + 3]) * 0.5;
        d = Math.hypot(ex, ez) || 1;
        ex /= d;
        ez /= d;
        overlap = r;
      }
      const yieldShare = z.def.pushYield;
      z.x += ex * overlap * yieldShare;
      z.z += ez * overlap * yieldShare;
      const body = this.dynBodies[i];
      const force = z.def.pushForce * Math.min(1.5, 0.5 + overlap / 0.08);
      _impulse.set(-ex * force * dt, 0, -ez * force * dt);
      body.wakeUp();
      body.applyImpulse(_impulse, _relPoint);
    }
  }

  private updateAttack(z: Zombie, dist: number, dt: number): void {
    const player = this.ctx.player;
    const def = z.def;
    if (z.attackT >= 0) {
      z.attackT += dt;
      if (!z.attackLanded && z.attackT >= def.windup) {
        z.attackLanded = true;
        if (!player.dead && dist <= def.reach + 0.35)
          player.damage(def.damage, this.eventPos.set(z.x, 1, z.z));
      }
      if (z.attackT >= def.windup + 0.45) z.attackT = -1;
      return;
    }
    if (player.dead || z.stagger > 0 || z.attackCooldown > 0) return;
    if (dist > def.reach) return;
    z.attackT = 0;
    z.attackLanded = false;
    z.attackCooldown = rand(0.9, 1.15);
    z.attackArm = z.kind === "brute" ? 2 : 1 - (z.attackArm & 1);
    this.ctx.events.emit("zombieAttack", {
      position: this.eventPos.set(z.x, 1.2 * z.scale, z.z),
    });
  }

  /** Random moans, globally rate limited; far zombies give way to near ones. */
  private groan(z: Zombie, dist: number, dt: number): void {
    z.groanTimer -= dt;
    if (z.groanTimer > 0) return;
    if (this.groanTokens >= 1 && (dist < 16 || Math.random() < 0.3)) {
      this.groanTokens -= 1;
      z.groanTimer = rand(4, 10);
      this.ctx.events.emit("zombieGroan", {
        position: this.eventPos.set(z.x, 1.5 * z.scale, z.z),
        kind: z.kind,
      });
    } else {
      z.groanTimer = rand(0.4, 1.5);
    }
  }

  private collectDynamicProps(): void {
    const props = this.ctx.world.props;
    this.dynBodies.length = 0;
    let n = 0;
    for (let i = 0; i < props.length; i++) {
      const p = props[i];
      const body = p.body;
      if (!p.dynamic || !p.alive || !body) continue;
      if (body.aabbNeedsUpdate) body.updateAABB();
      const lo = body.aabb.lowerBound;
      const hi = body.aabb.upperBound;
      if (lo.y > 1.4 || hi.y < 0.08) continue;
      if ((n + 1) * 4 > this.dynBox.length) {
        const grown = new Float32Array(this.dynBox.length * 2);
        grown.set(this.dynBox);
        this.dynBox = grown;
      }
      const o = n * 4;
      this.dynBox[o] = lo.x;
      this.dynBox[o + 1] = hi.x;
      this.dynBox[o + 2] = lo.z;
      this.dynBox[o + 3] = hi.z;
      this.dynBodies.push(body);
      n++;
    }
    this.dynCount = n;
  }

  // -------------------------------------------------------------------------
  // Death, corpses, explosions
  // -------------------------------------------------------------------------

  private kill(
    z: Zombie,
    type: number,
    dirX: number,
    dirZ: number,
    headshot: boolean,
  ): void {
    const wasRising = z.state === RISING;
    z.state = DEAD;
    z.hp = 0;
    z.attackT = -1;
    z.fallT = 0;
    z.corpseT = wasRising ? CORPSE_TIME - 0.8 : 0;
    z.landed = false;
    z.deathType = type;
    z.pivot = 0;
    z.tilt = 0;
    let len = Math.hypot(dirX, dirZ);
    if (len < 1e-3) {
      dirX = -Math.sin(z.yaw);
      dirZ = -Math.cos(z.yaw);
      len = 1;
    }
    let fx = dirX / len;
    let fz = dirZ / len;
    if (type === CRUMPLE) {
      // Slump roughly forward or sideways, not along the bullet.
      const a = z.yaw + rand(-1.2, 1.2);
      fx = Math.sin(a);
      fz = Math.cos(a);
      z.tiltTarget = 1.38;
    } else {
      z.tiltTarget = Math.PI / 2;
    }
    z.axisX = fz;
    z.axisZ = -fx;
    const kick = type === TUMBLE ? 1.2 / z.scale : 0.2;
    z.vx = fx * kick;
    z.vz = fz * kick;
    this.deathPose(z, type);

    this.alive--;
    const stats = this.ctx.stats;
    stats.kills++;
    if (headshot) stats.headshots++;
    this.ctx.events.emit("zombieKilled", {
      position: this.eventPos.set(z.x, 1, z.z),
      headshot,
      kind: z.kind,
      total: stats.kills,
    });
    if (!wasRising) {
      const roll = Math.random();
      if (roll < AMMO_CHANCE) this.pickups.spawn(AMMO, z.x, z.z);
      else if (roll < AMMO_CHANCE + HEALTH_CHANCE)
        this.pickups.spawn(HEALTH, z.x, z.z);
    }
  }

  /** Throw a dying zombie (or a corpse) away from a blast. */
  private launch(z: Zombie, nx: number, nz: number, power: number): void {
    const s = z.scale;
    if (z.pivot === 0) {
      // Switch the pivot from the feet to the body centre, keeping the body where it is.
      _qYaw.setFromAxisAngle(UP, z.yaw);
      _qTilt.setFromAxisAngle(_axis.set(z.axisX, 0, z.axisZ), z.tilt);
      _off
        .set(0, 0.85 * s, 0)
        .applyQuaternion(_quat.multiplyQuaternions(_qTilt, _qYaw));
      z.x += _off.x;
      z.y = Math.max(z.y + _off.y, 0.2 * s);
      z.z += _off.z;
      z.pivot = 0.85;
    }
    const heavy = z.kind === "brute" ? 0.55 : 1;
    z.deathType = FLING;
    z.landed = false;
    z.fallT = 0;
    z.vx = nx * (4 + 8 * power) * heavy;
    z.vz = nz * (4 + 8 * power) * heavy;
    z.vy = (3.5 + 6.5 * power) * heavy;
    z.axisX = nz;
    z.axisZ = -nx;
    z.spin = rand(5, 11) * (Math.random() < 0.8 ? 1 : -1);
    z.corpseT = Math.min(z.corpseT, CORPSE_TIME - 2);
    this.flailPose(z);
  }

  private updateDead(z: Zombie, dt: number): void {
    const s = z.scale;
    z.fallT += dt;
    if (z.deathType === FLING) {
      this.updateFling(z, dt);
    } else {
      // Fall over around the feet; a short bounce when the body hits the floor.
      const delay = z.deathType === CRUMPLE ? 0.28 : 0;
      const dur = z.deathType === CRUMPLE ? 0.55 : z.def.fallTime;
      const u = clamp((z.fallT - delay) / dur, 0, 1);
      let tilt = z.tiltTarget * u * u;
      if (u >= 1) {
        const after = z.fallT - delay - dur;
        tilt -=
          0.09 * Math.sin(Math.min(Math.PI, after * 12)) * Math.exp(-after * 5);
      }
      z.tilt = tilt;
      const drag = Math.exp(-5 * dt);
      z.vx *= drag;
      z.vz *= drag;
      z.x += z.vx * dt;
      z.z += z.vz * dt;
      // Killed while still half buried: it just slumps back into the ground.
      z.y = z.buried + 0.13 * s * Math.sin(z.tilt);
    }
    if (z.fallT > 1.2) z.corpseT += dt;
    if (z.corpseT > CORPSE_TIME) {
      z.sink += (dt * 0.6 * s) / SINK_TIME;
      if (z.corpseT > CORPSE_TIME + SINK_TIME) z.state = FREE;
    }
  }

  private updateFling(z: Zombie, dt: number): void {
    const s = z.scale;
    const rest = 0.15 * s;
    const a = this.arena;
    if (!z.landed) {
      z.vy -= this.ctx.tuning.gravity * dt;
      z.x = clamp(z.x + z.vx * dt, a.minX + 0.5, a.maxX - 0.5);
      z.z = clamp(z.z + z.vz * dt, a.minZ + 0.5, a.maxZ - 0.5);
      z.y += z.vy * dt;
      z.tilt += z.spin * dt;
      const floor = 0.85 * s * Math.abs(Math.cos(z.tilt)) + rest;
      if (z.y <= floor && z.vy < 0) {
        z.y = floor;
        if (z.vy < -3.5) {
          z.vy *= -0.28;
          z.vx *= 0.55;
          z.vz *= 0.55;
          z.spin *= 0.45;
          _pos.set(z.x, 0.05, z.z);
          this.ctx.fx.dust(_pos, UP, 2, GROUND_DUST);
        } else {
          z.landed = true;
          // Settle on the back or the front, whichever is nearer.
          const half = Math.PI / 2;
          z.tiltTarget = Math.round((z.tilt - half) / Math.PI) * Math.PI + half;
          z.fallT = Math.min(z.fallT, 1);
          this.deathPose(z, TUMBLE);
        }
      }
      return;
    }
    const k = 1 - Math.exp(-10 * dt);
    z.tilt += (z.tiltTarget - z.tilt) * k;
    z.y += (rest - z.y) * k;
  }

  private onExplosion(pos: THREE.Vector3, radius: number): void {
    for (let i = 0; i < CAPACITY; i++) {
      const z = this.zombies[i];
      if (z.state === FREE) continue;
      let dx = z.x - pos.x;
      let dz = z.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d >= radius) continue;
      if (d > 0.05) {
        dx /= d;
        dz /= d;
      } else {
        const a = Math.random() * TAU;
        dx = Math.sin(a);
        dz = Math.cos(a);
      }
      const power = 1 - d / radius;
      if (z.state === DEAD) {
        if (z.corpseT < CORPSE_TIME) this.launch(z, dx, dz, power * 0.8);
        continue;
      }
      z.hp -= EXPLOSION_DAMAGE * power;
      z.flash = FLASH_TIME;
      if (z.hp <= 0) {
        this.kill(z, TUMBLE, dx, dz, false);
        this.launch(z, dx, dz, power);
        _pos.set(z.x, 1, z.z);
        _dir.set(dx, 0.8, dz).normalize();
        this.ctx.fx.blood(_pos, _dir, 2.5 + power * 1.5);
      } else {
        z.stagger = 0.5 + power * 0.6;
        z.flinch = 1;
        z.attackT = -1;
        z.vx += (dx * 6 * power) / z.scale;
        z.vz += (dz * 6 * power) / z.scale;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Poses
  // -------------------------------------------------------------------------

  private smoothPose(z: Zombie, k: number): void {
    const p = z.pose;
    const t = z.target;
    for (let i = 0; i < POSE_N; i++) p[i] += (t[i] - p[i]) * k;
  }

  private poseAlive(z: Zombie): void {
    const o = z.target;
    const t = this.time;
    const m = clamp(Math.hypot(z.vx, z.vz) / Math.max(0.5, z.speed), 0, 1.2);
    const p = z.phase;
    const s = Math.sin(p);
    const c = Math.cos(p);
    const sway = Math.sin(t * 0.8 + z.seed);
    if (z.kind === "runner") {
      o[HIP_Y] = STAND_HIP - 0.04 - 0.06 * m * Math.abs(s);
      o[PELVIS_X] = 0.3;
      o[PELVIS_Z] = 0.06 * m * s;
      o[TORSO_X] = 0.5 + 0.28 * m + 0.06 * Math.sin(2 * p);
      o[TORSO_Y] = 0.2 * m * s;
      o[TORSO_Z] = 0.06 * s + 0.04 * sway;
      o[HEAD_X] = -0.45 - 0.3 * m;
      o[HEAD_Z] = 0.14 * Math.sin(t * 1.1 + z.seed);
      o[ARM_LX] = -1.5 - 0.3 * m + 0.6 * m * s;
      o[ARM_RX] = -1.5 - 0.3 * m - 0.6 * m * s;
      o[ARM_LZ] = 0.22;
      o[ARM_RZ] = 0.22;
      o[ELBOW_L] = -0.5 - 0.5 * Math.max(0, s);
      o[ELBOW_R] = -0.5 - 0.5 * Math.max(0, -s);
      o[THIGH_LX] = -0.3 - 0.75 * m * s;
      o[THIGH_RX] = -0.3 + 0.75 * m * s;
      o[THIGH_LZ] = 0.04;
      o[THIGH_RZ] = 0.04;
      o[KNEE_L] = 0.3 + 1.3 * m * Math.max(0, c);
      o[KNEE_R] = 0.3 + 1.3 * m * Math.max(0, -c);
    } else if (z.kind === "brute") {
      o[HIP_Y] = STAND_HIP - 0.05 - 0.07 * m * Math.abs(s);
      o[PELVIS_X] = 0.2;
      o[PELVIS_Z] = 0.1 * m * s;
      o[TORSO_X] = 0.5 + 0.05 * Math.abs(s) * m;
      o[TORSO_Y] = 0.1 * m * s;
      o[TORSO_Z] = 0.16 * m * s + 0.05 * sway;
      o[HEAD_X] = -0.45;
      o[HEAD_Z] = 0.1 * s + 0.08 * sway;
      o[ARM_LX] = -0.55 - 0.35 * m * s;
      o[ARM_RX] = -0.55 + 0.35 * m * s;
      o[ARM_LZ] = 0.32;
      o[ARM_RZ] = 0.32;
      o[ELBOW_L] = -0.55;
      o[ELBOW_R] = -0.55;
      o[THIGH_LX] = -0.2 - 0.34 * m * s;
      o[THIGH_RX] = -0.2 + 0.34 * m * s;
      o[THIGH_LZ] = 0.13;
      o[THIGH_RZ] = 0.13;
      o[KNEE_L] = 0.3 + 0.65 * m * Math.max(0, c);
      o[KNEE_R] = 0.3 + 0.65 * m * Math.max(0, -c);
    } else {
      // Limping shamble: the bad leg lags, takes a short step and drops the hip.
      const pr = p + Math.PI + z.limp;
      const sr = Math.sin(pr);
      const cr = Math.cos(pr);
      o[HIP_Y] =
        STAND_HIP - m * (0.035 * Math.abs(s) + 0.035 * Math.max(0, -sr));
      o[PELVIS_X] = 0.18;
      o[PELVIS_Z] = 0.08 * m * s;
      o[TORSO_X] = 0.42 + 0.06 * m * Math.sin(2 * p) + 0.05 * sway;
      o[TORSO_Y] = 0.12 * m * s;
      o[TORSO_Z] = 0.1 * m * s + 0.07 * sway;
      o[HEAD_X] = -0.32 + 0.08 * Math.sin(2 * p + 1);
      o[HEAD_Z] = 0.3 * Math.sin(t * 0.9 + z.seed * 2) + 0.1 * m * s;
      o[ARM_LX] = -1.75 + 0.14 * Math.sin(p + z.seed) - 0.08 * sway;
      o[ARM_LZ] = 0.12 + 0.06 * Math.sin(t * 1.1 + z.seed);
      o[ELBOW_L] = -0.25 - 0.15 * Math.sin(t * 1.7 + z.seed);
      if (z.dangle) {
        o[ARM_RX] = -0.2 - 0.35 * m * s;
        o[ARM_RZ] = 0.08;
        o[ELBOW_R] = -0.15;
      } else {
        o[ARM_RX] = -1.62 + 0.14 * Math.sin(pr + z.seed) + 0.06 * sway;
        o[ARM_RZ] = 0.1 + 0.06 * Math.sin(t * 1.3 + z.seed * 3);
        o[ELBOW_R] = -0.2 - 0.15 * Math.sin(t * 1.9 + z.seed);
      }
      o[THIGH_LX] = -0.18 - 0.42 * m * s;
      o[THIGH_RX] = -0.18 - 0.28 * m * sr;
      o[THIGH_LZ] = 0.04;
      o[THIGH_RZ] = 0.07;
      o[KNEE_L] = 0.2 + 0.8 * m * Math.max(0, c);
      o[KNEE_R] = 0.15 + 0.45 * m * Math.max(0, cr);
    }

    // Attack: wind up overhead, slash down toward the player, recover.
    if (z.attackT >= 0) {
      const w = z.def.windup;
      const a = z.attackT;
      let arm: number;
      let lean: number;
      if (a < w) {
        const u = a / w;
        arm = -1.7 - 1.35 * u * (2 - u);
        lean = -0.25 * u;
      } else {
        const u = Math.min(1, (a - w) / 0.14);
        arm = -3.05 + 2.6 * u;
        lean = -0.25 + 0.6 * u;
      }
      const fade = a > w + 0.25 ? Math.max(0, 1 - (a - w - 0.25) / 0.2) : 1;
      if (z.attackArm !== 1) {
        o[ARM_LX] += (arm - o[ARM_LX]) * fade;
        o[ELBOW_L] += (-0.6 - o[ELBOW_L]) * fade;
      }
      if (z.attackArm !== 0) {
        o[ARM_RX] += (arm - o[ARM_RX]) * fade;
        o[ELBOW_R] += (-0.6 - o[ELBOW_R]) * fade;
      }
      o[TORSO_X] += lean * fade;
    }

    // Hit flinch: snap back, arms flung up a little.
    const f = z.flinch;
    if (f > 0) {
      o[TORSO_X] -= 0.55 * f;
      o[TORSO_Z] += 0.25 * f * z.flinchSide;
      o[HEAD_X] -= 0.5 * f;
      o[ARM_LX] -= 0.35 * f;
      o[ARM_RX] -= 0.35 * f;
    }

    // Crouched over the player's body, tearing at it.
    const cf = z.feed;
    if (cf > 0.01) {
      const tear = Math.sin(t * 6 + z.seed);
      o[HIP_Y] -= 0.4 * cf;
      o[THIGH_LX] += (-1.25 - o[THIGH_LX]) * cf;
      o[THIGH_RX] += (-1.1 - o[THIGH_RX]) * cf;
      o[KNEE_L] += (2.1 - o[KNEE_L]) * cf;
      o[KNEE_R] += (1.9 - o[KNEE_R]) * cf;
      o[TORSO_X] += (1.0 - o[TORSO_X]) * cf;
      o[ARM_LX] += (-0.9 + 0.4 * tear - o[ARM_LX]) * cf;
      o[ARM_RX] += (-0.9 - 0.4 * tear - o[ARM_RX]) * cf;
      o[HEAD_X] += (0.2 + 0.15 * tear - o[HEAD_X]) * cf;
    }
  }

  /** Clawing up out of the ground: arms overhead, knees still bent. */
  private poseRising(z: Zombie, u: number): void {
    const o = z.target;
    const t = this.time * 11 + z.seed;
    const v = 1 - u;
    o[HIP_Y] = STAND_HIP - 0.25 * v;
    o[PELVIS_X] = 0.18;
    o[PELVIS_Z] = 0.1 * Math.sin(t * 0.5);
    o[TORSO_X] = 0.42 + 0.3 * v;
    o[TORSO_Y] = 0.15 * Math.sin(t * 0.5);
    o[TORSO_Z] = 0.12 * Math.sin(t * 0.5 + 1);
    o[HEAD_X] = -0.35;
    o[HEAD_Z] = 0.2 * Math.sin(t * 0.3);
    o[ARM_LX] = -2.75 + 0.35 * Math.sin(t) + 1.0 * u * u;
    o[ARM_RX] = -2.75 + 0.35 * Math.sin(t + Math.PI) + 1.1 * u * u;
    o[ARM_LZ] = 0.25;
    o[ARM_RZ] = 0.25;
    o[ELBOW_L] = -0.5 + 0.3 * Math.sin(t);
    o[ELBOW_R] = -0.5 + 0.3 * Math.sin(t + Math.PI);
    o[THIGH_LX] = -0.18 - 0.6 * v;
    o[THIGH_RX] = -0.18 - 0.3 * v;
    o[THIGH_LZ] = 0.05;
    o[THIGH_RZ] = 0.05;
    o[KNEE_L] = 0.2 + 0.9 * v;
    o[KNEE_R] = 0.2 + 0.6 * v;
  }

  /** Limp, splayed pose the body settles into (set once). */
  private deathPose(z: Zombie, type: number): void {
    const o = z.target;
    o[HIP_Y] = type === CRUMPLE ? 0.45 : STAND_HIP;
    o[PELVIS_X] = 0;
    o[PELVIS_Z] = rand(-0.15, 0.15);
    o[TORSO_X] = type === CRUMPLE ? 0.7 : rand(-0.1, 0.15);
    o[TORSO_Y] = rand(-0.3, 0.3);
    o[TORSO_Z] = rand(-0.25, 0.25);
    o[HEAD_X] = rand(-0.5, 0.6);
    o[HEAD_Z] = rand(-0.8, 0.8);
    o[ARM_LX] = rand(-3, -0.2);
    o[ARM_RX] = rand(-3, -0.2);
    o[ARM_LZ] = rand(0.2, 1.2);
    o[ARM_RZ] = rand(0.2, 1.2);
    o[ELBOW_L] = rand(-1.2, 0);
    o[ELBOW_R] = rand(-1.2, 0);
    o[THIGH_LX] = type === CRUMPLE ? -1.35 : rand(-0.6, 0.15);
    o[THIGH_RX] = type === CRUMPLE ? -1.2 : rand(-0.6, 0.15);
    o[THIGH_LZ] = rand(0, 0.35);
    o[THIGH_RZ] = rand(0, 0.35);
    o[KNEE_L] = type === CRUMPLE ? 2.1 : rand(0.1, 1);
    o[KNEE_R] = type === CRUMPLE ? 1.9 : rand(0.1, 1);
  }

  /** Limbs thrown wide while flying. */
  private flailPose(z: Zombie): void {
    const o = z.target;
    o[HIP_Y] = STAND_HIP;
    o[TORSO_X] = rand(-0.5, 0.3);
    o[HEAD_X] = rand(-0.8, 0.3);
    o[ARM_LX] = rand(-3.2, -2);
    o[ARM_RX] = rand(-3.2, -2);
    o[ARM_LZ] = rand(0.8, 1.6);
    o[ARM_RZ] = rand(0.8, 1.6);
    o[THIGH_LX] = rand(-1, 0.3);
    o[THIGH_RX] = rand(-1, 0.3);
    o[THIGH_LZ] = rand(0.2, 0.6);
    o[THIGH_RZ] = rand(0.2, 0.6);
    o[KNEE_L] = rand(0.3, 1.4);
    o[KNEE_R] = rand(0.3, 1.4);
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Writes the 11 part matrices + colours of one zombie as render slot k. */
  private draw(z: Zombie, k: number): void {
    const s = z.scale;
    _qYaw.setFromAxisAngle(UP, z.yaw);
    if (z.tilt !== 0) {
      _qTilt.setFromAxisAngle(_axis.set(z.axisX, 0, z.axisZ), z.tilt);
      _quat.multiplyQuaternions(_qTilt, _qYaw);
    } else {
      _quat.copy(_qYaw);
    }
    _pos.set(z.x, z.y - z.sink, z.z);
    if (z.pivot !== 0) {
      _off.set(0, -z.pivot * s, 0).applyQuaternion(_quat);
      _pos.add(_off);
    }
    _scale.set(s * z.bulk, s, s * (0.5 + z.bulk * 0.5));
    _root.compose(_pos, _quat, _scale);

    const p = z.pose;
    joint(_hips, _root, 0, p[HIP_Y], 0, p[PELVIS_X], 0, p[PELVIS_Z]);
    this.pelvisMesh.setMatrixAt(k, _hips);
    joint(_torso, _hips, 0, 0.07, 0, p[TORSO_X], p[TORSO_Y], p[TORSO_Z]);
    this.torsoMesh.setMatrixAt(k, _torso);
    joint(_end, _torso, 0, 0.5, 0.03, p[HEAD_X], 0, p[HEAD_Z]);
    this.headMesh.setMatrixAt(k, _end);

    const l = k * 2;
    const r = l + 1;
    joint(_limb, _torso, 0.25, 0.43, 0, p[ARM_LX], 0, p[ARM_LZ]);
    this.upperArmMesh.setMatrixAt(l, _limb);
    joint(_end, _limb, 0, -0.29, 0, p[ELBOW_L], 0, 0);
    this.forearmMesh.setMatrixAt(l, _end);
    joint(_limb, _torso, -0.25, 0.43, 0, p[ARM_RX], 0, -p[ARM_RZ]);
    this.upperArmMesh.setMatrixAt(r, _limb);
    joint(_end, _limb, 0, -0.29, 0, p[ELBOW_R], 0, 0);
    this.forearmMesh.setMatrixAt(r, _end);
    joint(_limb, _hips, 0.1, -0.03, 0, p[THIGH_LX], 0, p[THIGH_LZ]);
    this.thighMesh.setMatrixAt(l, _limb);
    joint(_end, _limb, 0, -0.42, 0, p[KNEE_L], 0, 0);
    this.shinMesh.setMatrixAt(l, _end);
    joint(_limb, _hips, -0.1, -0.03, 0, p[THIGH_RX], 0, -p[THIGH_RZ]);
    this.thighMesh.setMatrixAt(r, _limb);
    joint(_end, _limb, 0, -0.42, 0, p[KNEE_R], 0, 0);
    this.shinMesh.setMatrixAt(r, _end);

    const f = z.flash > 0 ? 0.65 : 0;
    setColor(this.headMesh, k, z.skin, f);
    setColor(this.torsoMesh, k, z.shirt, f);
    setColor(this.pelvisMesh, k, z.pants, f);
    setColor(this.upperArmMesh, l, z.sleeve, f);
    setColor(this.upperArmMesh, r, z.sleeve, f);
    setColor(this.forearmMesh, l, z.skin, f);
    setColor(this.forearmMesh, r, z.skin, f);
    setColor(this.thighMesh, l, z.pants, f);
    setColor(this.thighMesh, r, z.pants, f);
    setColor(this.shinMesh, l, z.pants, f);
    setColor(this.shinMesh, r, z.pants, f);
  }
}

/** Rotate angle `from` toward `to` by at most `step` radians (shortest way). */
function turnToward(from: number, to: number, step: number): number {
  let d = (to - from) % TAU;
  if (d > Math.PI) d -= TAU;
  else if (d < -Math.PI) d += TAU;
  return from + clamp(d, -step, step);
}
