import * as CANNON from "cannon-es";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { GROUP } from "./physics";
import {
  BARREL_ATLAS,
  type BarrelVariant,
  CRATE_FRAME_UV,
  GRID_TILE_METRES,
  barrelAtlasV,
  barrelMaterial,
  concreteMaterial,
  coneMaterial,
  crateMaterial,
  floorMaterial,
  plasticMaterial,
  rubberMaterial,
  sandbagMaterial,
  seededRandom,
  steelMaterial,
  targetPlateMaterial,
  woodMaterial,
} from "./textures";
import type {
  GameContext,
  HitInfo,
  OrientedBox,
  Prop,
  PropKind,
  Surface,
} from "./types";

// ---------------------------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------------------------

/** Playable area inside the boundary fence (metres). */
const ARENA = { minX: -30, maxX: 30, minZ: -45, maxZ: 24 } as const;
const SPAWN = new THREE.Vector3(0, 0, 8);
const FLOOR_SIZE = 400;
const FOG_NEAR = 34;
const FOG_FAR = 90;

const SHADOW_HALF_SIZE = 22;
const SHADOW_MAP_SIZE = 2048;
/** Sun position relative to its target: high in the north-west, so shadows fall right/down. */
const SUN_OFFSET = new THREE.Vector3(-14, 32, -10);

const FENCE_LENGTH = 2.95;
const FENCE_STRIDE = 3;
const BARREL_RADIUS = 0.29;
const BARREL_HEIGHT = 0.88;
const PALLET_HEIGHT = 0.144;

const EXPLOSIVE_HEALTH = 40;
/** Fuse after bullet damage / after a nearby blast (seconds, random in range). */
const FUSE_TIME = [0.15, 0.6] as const;
const CHAIN_DELAY = [0.08, 0.3] as const;
const EXPLOSION_RADIUS = 6;
/** Peak velocity change (m/s) a barrel-mass prop gets at the centre of a blast. */
const EXPLOSION_FORCE = 9;
const EXPLOSION_MAX_DV = 16;
const EXPLOSION_LIFT = 0.55;

const COLLISION_MIN_SPEED = 1.2;
const COLLISION_FULL_SPEED = 8;
const COLLISION_THROTTLE = 0.09;
const RESPAWN_BELOW_Y = -10;

const TARGET_PIVOT = new THREE.Vector3(0, 0.3, 0.03);
const TARGET_DOWN_ANGLE = -Math.PI / 2 + 0.06;
const TARGET_RAISE_DELAY = 3;
/** Painted plates glow faintly so they read even when facing away from the sun. */
const PLATE_GLOW = 0.14;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const C_X_AXIS = new CANNON.Vec3(1, 0, 0);
const C_Y_AXIS = new CANNON.Vec3(0, 1, 0);
const UP = new THREE.Vector3(0, 1, 0);

// Hot-path temporaries.
const _vec = new THREE.Vector3();
const _blast = new THREE.Vector3();
const _event = new THREE.Vector3();
const _impulse = new CANNON.Vec3();
const _rel = new CANNON.Vec3();
const _cQuat = new CANNON.Quaternion();

type Rand = () => number;
type Vec3Tuple = readonly [number, number, number];

const randRange = ([min, max]: readonly [number, number]): number =>
  min + Math.random() * (max - min);

const cannonVec = (t: Vec3Tuple): CANNON.Vec3 =>
  new CANNON.Vec3(t[0], t[1], t[2]);

// ---------------------------------------------------------------------------------------------
// Geometry building
// ---------------------------------------------------------------------------------------------

type ColorFn = (p: THREE.Vector3, out: THREE.Color) => void;

interface PartOptions {
  at?: Vec3Tuple;
  rot?: Vec3Tuple;
  scale?: Vec3Tuple;
  /** Vertex colour (multiplies the texture). A function receives the part-space position. */
  color?: THREE.ColorRepresentation | ColorFn;
  /**
   * "metric": planar UVs in metres chosen per face by its dominant axis (tiling textures);
   * [u, v]: one constant texel (solid colour); { v }: keep u, constant v (atlas rows).
   * Default keeps the geometry's own UVs.
   */
  uv?: "metric" | readonly [number, number] | { v: number };
  /** For metric UVs: the part-space axis (0 x, 1 y, 2 z) that runs along U (wood grain). */
  grain?: 0 | 1 | 2;
}

const SOLID_UV = [0.5, 0.5] as const;
const _partMatrix = new THREE.Matrix4();
const _partPos = new THREE.Vector3();
const _partQuat = new THREE.Quaternion();
const _partScale = new THREE.Vector3();
const _partEuler = new THREE.Euler();
const _paintPos = new THREE.Vector3();
const _paintColor = new THREE.Color();

/** Accumulates primitive parts into one non-indexed geometry with position/normal/uv/color. */
class GeometryBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];

  /** Takes ownership of `source` (it is disposed or merged). */
  add(source: THREE.BufferGeometry, options: PartOptions = {}): this {
    const g = source.index ? source.toNonIndexed() : source;
    if (g !== source) source.dispose();
    g.clearGroups();
    g.applyMatrix4(partMatrix(options));
    const uv = options.uv;
    if (uv === "metric") applyMetricUv(g, options.grain);
    else if (Array.isArray(uv)) setUv(g, uv[0], uv[1]);
    else if (uv && "v" in uv) setUv(g, null, uv.v);
    paintVertices(g, options.color ?? 0xffffff);
    this.parts.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const merged = mergeGeometries(this.parts);
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    if (!merged) throw new Error("GeometryBuilder: incompatible parts");
    merged.computeBoundingSphere();
    return merged;
  }
}

function partMatrix(o: PartOptions): THREE.Matrix4 {
  const [px, py, pz] = o.at ?? [0, 0, 0];
  const [rx, ry, rz] = o.rot ?? [0, 0, 0];
  const [sx, sy, sz] = o.scale ?? [1, 1, 1];
  _partQuat.setFromEuler(_partEuler.set(rx, ry, rz));
  return _partMatrix.compose(
    _partPos.set(px, py, pz),
    _partQuat,
    _partScale.set(sx, sy, sz),
  );
}

function applyMetricUv(g: THREE.BufferGeometry, grain?: 0 | 1 | 2): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const nor = g.getAttribute("normal") as THREE.BufferAttribute;
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    const dominant = nx >= ny && nx >= nz ? 0 : ny >= nz ? 1 : 2;
    let a = dominant === 0 ? 1 : 0;
    let b = dominant === 2 ? 1 : 2;
    if (grain === b) [a, b] = [b, a];
    uv.setXY(i, pos.getComponent(i, a), pos.getComponent(i, b));
  }
}

/** Sets every UV to a constant (u = null keeps u). */
function setUv(g: THREE.BufferGeometry, u: number | null, v: number): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u ?? uv.getX(i), v);
}

function paintVertices(
  g: THREE.BufferGeometry,
  color: THREE.ColorRepresentation | ColorFn,
): void {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  if (typeof color !== "function") _paintColor.set(color);
  for (let i = 0; i < pos.count; i++) {
    if (typeof color === "function") {
      color(_paintPos.fromBufferAttribute(pos, i), _paintColor);
    }
    _paintColor.toArray(colors, i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/** Near-grey multiplier with a slight warm/cool shift (wood pieces differ a little). */
function woodTint(rand: Rand, brightness: number): THREE.Color {
  const warm = (rand() - 0.5) * 0.1;
  return new THREE.Color(
    brightness * (1 + warm),
    brightness,
    brightness * (1 - warm * 1.6),
  );
}

/** Vertex colour that darkens toward the floor (dirt and splash line). */
function grime(
  base: THREE.ColorRepresentation,
  height: number,
  floorShade: number,
): ColorFn {
  const color = new THREE.Color(base);
  return (p, out) => {
    const t = Math.sqrt(THREE.MathUtils.clamp(p.y / height, 0, 1));
    out.copy(color).multiplyScalar(floorShade + (1 - floorShade) * t);
  };
}

type HalfProfile = ReadonlyArray<readonly [number, number]>;

/**
 * Extrudes a symmetric cross-section along local X, centred on the origin. `half` lists the
 * right half (x ≥ 0) from bottom to top; it ends up across local Z.
 */
function profileGeometry(
  half: HalfProfile,
  length: number,
): THREE.BufferGeometry {
  const right = half.map(([x, y]) => new THREE.Vector2(x, y));
  const left = [...half].reverse().map(([x, y]) => new THREE.Vector2(-x, y));
  const shape = new THREE.Shape([...right, ...left]);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: length,
    bevelEnabled: false,
  });
  g.translate(0, 0, -length / 2);
  g.rotateY(Math.PI / 2);
  return g;
}

// ---------------------------------------------------------------------------------------------
// Prop models (origin on the floor for static props, at the body centre for dynamic ones)
// ---------------------------------------------------------------------------------------------

/** Jersey profile: wide foot, 55° lower slope, near-vertical upper face, chamfered top. */
const CONCRETE_PROFILE: HalfProfile = [
  [0.31, 0],
  [0.31, 0.075],
  [0.19, 0.3],
  [0.13, 0.8],
  [0.09, 0.85],
];
const PLASTIC_PROFILE: HalfProfile = [
  [0.27, 0],
  [0.27, 0.1],
  [0.2, 0.28],
  [0.18, 0.88],
  [0.13, 0.95],
];
/** Tall "T-wall": wide footing, slab with a slight taper. */
const TWALL_PROFILE: HalfProfile = [
  [0.48, 0],
  [0.48, 0.26],
  [0.17, 0.4],
  [0.135, 2.55],
  [0.095, 2.6],
];

/** Wooden panel: two chunky posts, two rails, vertical pickets with ragged tops. */
function fencePanelGeometry(variant: number): THREE.BufferGeometry {
  const rand = seededRandom(200 + variant);
  const b = new GeometryBuilder();
  const post = 0.13;
  const half = FENCE_LENGTH / 2;
  for (const x of [-half + post / 2, half - post / 2]) {
    b.add(new THREE.BoxGeometry(post, 1.56, post), {
      at: [x, 0.78, 0],
      uv: "metric",
      grain: 1,
      color: woodTint(rand, 0.62),
    });
    b.add(new THREE.BoxGeometry(post + 0.035, 0.04, post + 0.035), {
      at: [x, 1.58, 0],
      uv: "metric",
      color: woodTint(rand, 0.55),
    });
  }
  const railLength = FENCE_LENGTH - post * 2;
  for (const y of [0.32, 1.08]) {
    b.add(new THREE.BoxGeometry(railLength, 0.09, 0.05), {
      at: [0, y, -0.038],
      uv: "metric",
      grain: 0,
      color: woodTint(rand, 0.6),
    });
  }
  const pickets = 16;
  const pitch = railLength / pickets;
  for (let i = 0; i < pickets; i++) {
    const h = 1.24 + rand() * 0.15;
    const x = -railLength / 2 + pitch * (i + 0.5) + (rand() - 0.5) * 0.012;
    b.add(new THREE.BoxGeometry(0.105, h, 0.026), {
      at: [x, 0.06 + h / 2, 0],
      rot: [0, 0, (rand() - 0.5) * 0.025],
      uv: "metric",
      grain: 1,
      color: woodTint(rand, 0.68 + rand() * 0.24),
    });
  }
  return b.build();
}

function concreteBarrierGeometry(length: number): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  b.add(profileGeometry(CONCRETE_PROFILE, length), {
    uv: "metric",
    color: grime(0xf4f1ea, 0.35, 0.62),
  });
  const dark = 0x3a3835;
  for (const x of [-length * 0.3, length * 0.3]) {
    // Drainage / forklift slot through the foot.
    b.add(new THREE.BoxGeometry(0.28, 0.08, 0.632), {
      at: [x, 0.04, 0],
      uv: SOLID_UV,
      color: dark,
    });
    // Lifting recess on top.
    b.add(new THREE.BoxGeometry(0.16, 0.012, 0.07), {
      at: [x, 0.85, 0],
      uv: SOLID_UV,
      color: 0x55524d,
    });
  }
  // Steel connector loops on the ends.
  for (const x of [-length / 2 - 0.012, length / 2 + 0.012]) {
    b.add(new THREE.BoxGeometry(0.024, 0.14, 0.09), {
      at: [x, 0.52, 0],
      uv: SOLID_UV,
      color: 0x4a4b4d,
    });
  }
  return b.build();
}

/** Water-filled plastic barrier: fill caps, reflective strips, forklift slots, end lugs. */
function plasticBarrierGeometry(length: number): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  const orange = new THREE.Color(0xf2661a);
  b.add(profileGeometry(PLASTIC_PROFILE, length), {
    uv: "metric",
    color: grime(orange, 0.3, 0.7),
  });
  for (const side of [-1, 1]) {
    b.add(new THREE.BoxGeometry(length * 0.72, 0.065, 0.006), {
      at: [0, 0.7, side * 0.189],
      rot: [-side * 0.0345, 0, 0],
      uv: SOLID_UV,
      color: 0xf6f6f0,
    });
  }
  for (const x of [-length * 0.3, length * 0.3]) {
    b.add(new THREE.CylinderGeometry(0.075, 0.08, 0.03, 16), {
      at: [x, 0.958, 0],
      uv: SOLID_UV,
      color: 0xc04a12,
    });
    b.add(new THREE.CylinderGeometry(0.045, 0.045, 0.012, 12), {
      at: [x, 0.974, 0],
      uv: SOLID_UV,
      color: 0x24160e,
    });
    b.add(new THREE.BoxGeometry(0.3, 0.085, 0.545), {
      at: [x * 0.85, 0.042, 0],
      uv: SOLID_UV,
      color: 0x6b2c0c,
    });
  }
  // Interlocking lugs: low on one end, high on the other.
  const lug = orange.clone().multiplyScalar(0.85);
  b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.34, 10), {
    at: [length / 2, 0.28, 0],
    uv: SOLID_UV,
    color: lug,
  });
  b.add(new THREE.CylinderGeometry(0.06, 0.06, 0.34, 10), {
    at: [-length / 2, 0.66, 0],
    uv: SOLID_UV,
    color: lug,
  });
  return b.build();
}

/** Unit sandbag: a superellipsoid, boxy with soft rounded seams. */
function pillowGeometry(): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(0.5, 12, 8);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    for (let c = 0; c < 3; c++) {
      const v = pos.getComponent(i, c) * 2;
      pos.setComponent(i, c, Math.sign(v) * Math.abs(v) ** 0.55 * 0.5);
    }
  }
  g.computeVertexNormals();
  return g;
}

/** Staggered rows of khaki bags, two deep with a single capping row. */
function sandbagWallGeometry(variant: number): THREE.BufferGeometry {
  const rand = seededRandom(300 + variant);
  const b = new GeometryBuilder();
  const length = STATIC_SPECS.sandbag.length;
  const rows = 5;
  const pitch = 0.47;
  const khaki = [0xc8b48a, 0xb8a27a, 0xd2c29e, 0xa7926e];
  for (let r = 0; r < rows; r++) {
    const y = 0.09 + r * 0.155;
    const depths = r < rows - 1 ? [-0.15, 0.15] : [0];
    const offset = r % 2 === 0 ? 0 : pitch / 2;
    for (const z of depths) {
      for (
        let x = -length / 2 + pitch / 2 - offset;
        x < length / 2;
        x += pitch
      ) {
        const lo = Math.max(x - pitch / 2, -length / 2);
        const hi = Math.min(x + pitch / 2, length / 2);
        if (hi - lo < 0.15) continue;
        const tint = khaki[Math.floor(rand() * khaki.length)];
        b.add(pillowGeometry(), {
          at: [(lo + hi) / 2, y, z + (rand() - 0.5) * 0.03],
          rot: [0, (rand() - 0.5) * 0.12, (rand() - 0.5) * 0.06],
          scale: [(hi - lo) * 1.06, 0.2, 0.33],
          color: new THREE.Color(tint).multiplyScalar(0.85 + rand() * 0.2),
        });
      }
    }
  }
  return b.build();
}

function tWallGeometry(): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  const length = STATIC_SPECS.wall.length - 0.02;
  b.add(profileGeometry(TWALL_PROFILE, length), {
    uv: "metric",
    color: grime(0xf0ede6, 1.0, 0.6),
  });
  for (const x of [-0.42, 0.42]) {
    b.add(new THREE.BoxGeometry(0.14, 0.11, 0.3), {
      at: [x, 2.32, 0],
      uv: SOLID_UV,
      color: 0x2c2b29,
    });
  }
  return b.build();
}

/** Remaps CylinderGeometry UVs (groups: side, top, bottom) onto the barrel atlas. */
function mapBarrelAtlas(g: THREE.CylinderGeometry): void {
  const uv = g.getAttribute("uv") as THREE.BufferAttribute;
  const index = g.getIndex()!;
  const { TOP_LID, BOTTOM_LID } = BARREL_ATLAS;
  g.groups.forEach((group, gi) => {
    const done = new Set<number>();
    for (let k = group.start; k < group.start + group.count; k++) {
      const i = index.getX(k);
      if (done.has(i)) continue;
      done.add(i);
      const u = uv.getX(i);
      const v = uv.getY(i);
      if (gi === 0) {
        uv.setXY(i, u, barrelAtlasV(v));
      } else {
        const r = gi === 1 ? TOP_LID : BOTTOM_LID;
        uv.setXY(i, r.u0 + u * (r.u1 - r.u0), r.v0 + v * (r.v1 - r.v0));
      }
    }
  });
}

/** Steel drum: atlas-mapped shell, two rolling hoops and raised chime rims. */
function barrelGeometry(): THREE.BufferGeometry {
  const r = BARREL_RADIUS;
  const h = BARREL_HEIGHT;
  const shell = new THREE.CylinderGeometry(r, r, h, 24, 1);
  mapBarrelAtlas(shell);
  const b = new GeometryBuilder().add(shell);
  for (const rib of BARREL_ATLAS.RIBS) {
    b.add(new THREE.TorusGeometry(r + 0.003, 0.011, 4, 24), {
      at: [0, (rib - 0.5) * h, 0],
      rot: [Math.PI / 2, 0, 0],
      // Sample plain paint next to the painted hoop; the torus itself catches the light.
      uv: { v: barrelAtlasV(rib) - 0.02 },
    });
  }
  for (const end of [-1, 1]) {
    b.add(new THREE.TorusGeometry(r - 0.008, 0.017, 4, 24), {
      at: [0, end * (h / 2 - 0.004), 0],
      rot: [Math.PI / 2, 0, 0],
      uv: { v: barrelAtlasV(end > 0 ? 0.99 : 0.01) },
    });
  }
  return b.build();
}

/** Crate box (texture per face) with slightly proud edge battens. */
function crateGeometry(size: number): THREE.BufferGeometry {
  const rand = seededRandom(Math.round(size * 100));
  const b = new GeometryBuilder().add(new THREE.BoxGeometry(size, size, size));
  const t = size * 0.085;
  const proud = 0.006;
  const o = size / 2 - t / 2 + proud;
  const len = size + proud * 2;
  const batten = (): PartOptions => ({
    uv: CRATE_FRAME_UV,
    color: woodTint(rand, 0.86 + rand() * 0.14),
  });
  for (const s1 of [-1, 1]) {
    for (const s2 of [-1, 1]) {
      b.add(new THREE.BoxGeometry(len, t, t), {
        at: [0, s1 * o, s2 * o],
        ...batten(),
      });
      b.add(new THREE.BoxGeometry(t, len, t), {
        at: [s1 * o, 0, s2 * o],
        ...batten(),
      });
      b.add(new THREE.BoxGeometry(t, t, len), {
        at: [s1 * o, s2 * o, 0],
        ...batten(),
      });
    }
  }
  return b.build();
}

/** Euro-style pallet: bottom boards, nine blocks, stringers, five deck boards. */
function palletGeometry(): THREE.BufferGeometry {
  const rand = seededRandom(7);
  const b = new GeometryBuilder();
  const board = (size: Vec3Tuple, at: Vec3Tuple, grain: 0 | 1 | 2): void => {
    b.add(new THREE.BoxGeometry(...size), {
      at: [at[0], at[1] - PALLET_HEIGHT / 2, at[2]],
      uv: "metric",
      grain,
      color: woodTint(rand, 0.62 + rand() * 0.22),
    });
  };
  const rows = [-0.45, 0, 0.45];
  for (const z of rows) board([1.2, 0.022, 0.1], [0, 0.011, z], 0);
  for (const x of [-0.55, 0, 0.55]) {
    for (const z of rows) board([0.1, 0.078, 0.11], [x, 0.061, z], 1);
    board([0.1, 0.022, 1.0], [x, 0.111, 0], 2);
  }
  for (let i = 0; i < 5; i++) {
    board([1.2, 0.022, 0.13], [0, 0.133, -0.43 + i * 0.215], 0);
  }
  return b.build();
}

function tireGeometry(): THREE.BufferGeometry {
  return new GeometryBuilder()
    .add(new THREE.TorusGeometry(0.3, 0.12, 10, 24), {
      rot: [Math.PI / 2, 0, 0],
    })
    .build();
}

/** Traffic cone; origin 0.2 m above the floor (roughly its centre of mass). */
function coneGeometry(): THREE.BufferGeometry {
  return new GeometryBuilder()
    .add(new THREE.CylinderGeometry(0.035, 0.165, 0.62, 18, 1, true), {
      at: [0, 0.145, 0],
    })
    .add(new THREE.CylinderGeometry(0.036, 0.036, 0.01, 10), {
      at: [0, 0.455, 0],
      uv: [0.5, 0.97],
    })
    .add(new THREE.BoxGeometry(0.38, 0.035, 0.38), {
      at: [0, -0.1825, 0],
      uv: [0.5, 0.2],
      color: 0xa8a8a8,
    })
    .build();
}

/** Low steel sled with a hinge bar; the plate pivots at TARGET_PIVOT. */
function targetStandGeometry(): THREE.BufferGeometry {
  const b = new GeometryBuilder();
  for (const x of [-0.24, 0.24]) {
    b.add(new THREE.BoxGeometry(0.05, 0.05, 0.64), {
      at: [x, 0.025, -0.08],
      uv: SOLID_UV,
    });
  }
  for (const z of [0.2, -0.36]) {
    b.add(new THREE.BoxGeometry(0.53, 0.05, 0.05), {
      at: [0, 0.05, z],
      uv: SOLID_UV,
    });
  }
  for (const x of [-0.13, 0.13]) {
    b.add(new THREE.BoxGeometry(0.045, 0.27, 0.045), {
      at: [x, 0.165, 0],
      uv: SOLID_UV,
    });
  }
  b.add(new THREE.CylinderGeometry(0.022, 0.022, 0.34, 8), {
    at: [0, TARGET_PIVOT.y, 0],
    rot: [0, 0, Math.PI / 2],
    uv: SOLID_UV,
  });
  return b.build();
}

/** Popper silhouette (tapered body, neck, round head), bottom edge at the pivot, facing +Z. */
function popperPlateGeometry(): THREE.BufferGeometry {
  const neck = 0.065;
  const headY = 0.85;
  const headR = 0.16;
  const a = Math.acos(neck / headR);
  const shape = new THREE.Shape();
  shape.moveTo(-0.08, 0);
  shape.lineTo(0.08, 0);
  shape.lineTo(0.17, 0.56);
  shape.lineTo(neck, headY - Math.sin(a) * headR);
  shape.absarc(0, headY, headR, -a, Math.PI + a, false);
  shape.lineTo(-0.17, 0.56);
  shape.closePath();
  const plate = new THREE.ExtrudeGeometry(shape, {
    depth: 0.022,
    bevelEnabled: false,
    curveSegments: 14,
  });
  return new GeometryBuilder().add(plate, { at: [0, 0, -0.011] }).build();
}

// ---------------------------------------------------------------------------------------------
// Prop specs
// ---------------------------------------------------------------------------------------------

type StaticKind =
  | "fence"
  | "concreteBarrier"
  | "plasticBarrier"
  | "sandbag"
  | "wall";

interface StaticSpec {
  length: number; // along local X
  height: number;
  depth: number; // along local Z
  surface: Surface;
  vaultable: boolean;
  /** Collision boxes in prop space (origin on the floor). */
  boxes: ReadonlyArray<{ half: Vec3Tuple; at: Vec3Tuple }>;
  /** Number of geometry variants (seeded randomness). */
  variants: number;
  geometry: (variant: number) => THREE.BufferGeometry;
  material: () => THREE.Material;
}

const STATIC_SPECS: Record<StaticKind, StaticSpec> = {
  fence: {
    length: FENCE_LENGTH,
    height: 1.56,
    depth: 0.16,
    surface: "wood",
    vaultable: false,
    boxes: [{ half: [FENCE_LENGTH / 2, 0.75, 0.08], at: [0, 0.75, 0] }],
    variants: 3,
    geometry: fencePanelGeometry,
    material: woodMaterial,
  },
  concreteBarrier: {
    length: 3,
    height: 0.85,
    depth: 0.62,
    surface: "concrete",
    vaultable: true,
    boxes: [
      { half: [1.5, 0.15, 0.31], at: [0, 0.15, 0] },
      { half: [1.5, 0.275, 0.16], at: [0, 0.575, 0] },
    ],
    variants: 1,
    geometry: () => concreteBarrierGeometry(3),
    material: concreteMaterial,
  },
  plasticBarrier: {
    length: 1.9,
    height: 0.95,
    depth: 0.54,
    surface: "plastic",
    vaultable: true,
    boxes: [
      { half: [0.95, 0.14, 0.27], at: [0, 0.14, 0] },
      { half: [0.95, 0.335, 0.2], at: [0, 0.615, 0] },
    ],
    variants: 1,
    geometry: () => plasticBarrierGeometry(1.9),
    material: plasticMaterial,
  },
  sandbag: {
    length: 2.4,
    height: 0.8,
    depth: 0.62,
    surface: "fabric",
    vaultable: true,
    boxes: [{ half: [1.2, 0.4, 0.31], at: [0, 0.4, 0] }],
    variants: 2,
    geometry: sandbagWallGeometry,
    material: sandbagMaterial,
  },
  wall: {
    length: 1.5,
    height: 2.6,
    depth: 0.96,
    surface: "concrete",
    vaultable: false,
    boxes: [
      { half: [0.75, 0.2, 0.48], at: [0, 0.2, 0] },
      { half: [0.75, 1.1, 0.15], at: [0, 1.5, 0] },
    ],
    variants: 1,
    geometry: tWallGeometry,
    material: concreteMaterial,
  },
};

type DynamicKind =
  | "barrel"
  | "explosiveBarrel"
  | "crate"
  | "pallet"
  | "tire"
  | "cone";

interface DynamicModel {
  geometryKey: string;
  geometry: () => THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  /** Clone the material per prop (explosive barrels animate their emissive). */
  ownMaterial: boolean;
  shapes: Array<[CANNON.Shape, CANNON.Vec3?]>;
  mass: number;
  surface: Surface;
  health: number;
}

const isBarrel = (kind: PropKind): boolean =>
  kind === "barrel" || kind === "explosiveBarrel";

function dynamicModel(spawn: DynamicSpawn, barrelMass: number): DynamicModel {
  switch (spawn.kind) {
    case "barrel":
    case "explosiveBarrel": {
      const explosive = spawn.kind === "explosiveBarrel";
      const r = BARREL_RADIUS;
      return {
        geometryKey: "barrel",
        geometry: barrelGeometry,
        material: barrelMaterial(explosive ? "explosive" : spawn.variant),
        ownMaterial: explosive,
        shapes: [[new CANNON.Cylinder(r, r, BARREL_HEIGHT, 12)]],
        mass: barrelMass,
        surface: "metal",
        health: explosive ? EXPLOSIVE_HEALTH : Infinity,
      };
    }
    case "crate": {
      const s = spawn.size;
      return {
        geometryKey: `crate-${s}`,
        geometry: () => crateGeometry(s),
        material: crateMaterial(),
        ownMaterial: false,
        shapes: [[new CANNON.Box(new CANNON.Vec3(s / 2, s / 2, s / 2))]],
        mass: 25 * (s / 0.8) ** 3,
        surface: "wood",
        health: Infinity,
      };
    }
    case "pallet":
      return {
        geometryKey: "pallet",
        geometry: palletGeometry,
        material: woodMaterial(),
        ownMaterial: false,
        shapes: [
          [new CANNON.Box(new CANNON.Vec3(0.6, PALLET_HEIGHT / 2, 0.5))],
        ],
        mass: 15,
        surface: "wood",
        health: Infinity,
      };
    case "tire":
      return {
        geometryKey: "tire",
        geometry: tireGeometry,
        material: rubberMaterial(),
        ownMaterial: false,
        shapes: [[new CANNON.Cylinder(0.41, 0.41, 0.24, 10)]],
        mass: 9,
        surface: "rubber",
        health: Infinity,
      };
    case "cone":
      return {
        geometryKey: "cone",
        geometry: coneGeometry,
        material: coneMaterial(),
        ownMaterial: false,
        shapes: [
          [
            new CANNON.Box(new CANNON.Vec3(0.19, 0.0175, 0.19)),
            new CANNON.Vec3(0, -0.1825, 0),
          ],
          [
            new CANNON.Cylinder(0.035, 0.16, 0.62, 8),
            new CANNON.Vec3(0, 0.145, 0),
          ],
        ],
        mass: 2,
        surface: "plastic",
        health: Infinity,
      };
  }
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

interface StaticPlacement {
  kind: StaticKind;
  x: number;
  z: number;
  yaw: number;
}

interface DynamicSpawn {
  kind: DynamicKind;
  /** Body centre. */
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  variant: BarrelVariant;
  /** Crate edge length. */
  size: number;
}

interface TargetPlacement {
  x: number;
  z: number;
  yaw: number;
}

const _layoutQuat = new THREE.Quaternion();

/** Fluent helpers that describe the arena; pure data, no scene access. */
class LayoutBuilder {
  readonly statics: StaticPlacement[] = [];
  readonly dynamics: DynamicSpawn[] = [];
  readonly targets: TargetPlacement[] = [];

  place(kind: StaticKind, x: number, z: number, yaw = 0): this {
    this.statics.push({ kind, x, z, yaw });
    return this;
  }

  /** `count` segments end to end along their local X axis, centred on (x, z). */
  row(
    kind: StaticKind,
    x: number,
    z: number,
    yaw: number,
    count: number,
    gap = 0.03,
  ): this {
    const step = STATIC_SPECS[kind].length + gap;
    for (let i = 0; i < count; i++) {
      const o = (i - (count - 1) / 2) * step;
      this.place(kind, x + Math.cos(yaw) * o, z - Math.sin(yaw) * o, yaw);
    }
    return this;
  }

  /** Fence panels from (x0, z0) to (x1, z1); `gates` lists panel indices left open. */
  fenceLine(
    x0: number,
    z0: number,
    x1: number,
    z1: number,
    gates: number[],
  ): this {
    const dx = x1 - x0;
    const dz = z1 - z0;
    const count = Math.round(Math.hypot(dx, dz) / FENCE_STRIDE);
    const yaw = Math.atan2(-dz, dx);
    for (let i = 0; i < count; i++) {
      if (gates.includes(i)) continue;
      const t = (i + 0.5) / count;
      this.place("fence", x0 + dx * t, z0 + dz * t, yaw);
    }
    return this;
  }

  barrel(x: number, z: number, variant: BarrelVariant, y = 0, yaw = 0): this {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    return this.dynamic(
      "barrel",
      x,
      y + BARREL_HEIGHT / 2 + 0.001,
      z,
      q,
      variant,
    );
  }

  /** A barrel on its side, resting on a flat face of its collision polygon. */
  lyingBarrel(x: number, z: number, variant: BarrelVariant, yaw: number): this {
    const q = new THREE.Quaternion()
      .setFromAxisAngle(UP, yaw)
      .multiply(_layoutQuat.setFromAxisAngle(X_AXIS, Math.PI / 2))
      .multiply(_layoutQuat.setFromAxisAngle(UP, Math.PI / 12));
    const y = BARREL_RADIUS * Math.cos(Math.PI / 12) + 0.002;
    return this.dynamic("barrel", x, y, z, q, variant);
  }

  explosive(x: number, z: number): this {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, x * 2.3 + z * 1.1);
    return this.dynamic("explosiveBarrel", x, BARREL_HEIGHT / 2 + 0.001, z, q);
  }

  /** Upright barrels stacked 3-2-1 along the local X axis. */
  barrelPyramid(
    x: number,
    z: number,
    yaw: number,
    variants: BarrelVariant[],
  ): this {
    const pitch = BARREL_RADIUS * 2 + 0.04;
    let n = 0;
    for (let level = 0; level < 3; level++) {
      const count = 3 - level;
      for (let i = 0; i < count; i++) {
        const o = (i - (count - 1) / 2) * pitch;
        const y = level * (BARREL_HEIGHT + 0.002);
        const variant = variants[n++ % variants.length];
        this.barrel(
          x + Math.cos(yaw) * o,
          z - Math.sin(yaw) * o,
          variant,
          y,
          yaw,
        );
      }
    }
    return this;
  }

  crate(x: number, z: number, size: number, yaw: number, baseY = 0): this {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw);
    return this.dynamic(
      "crate",
      x,
      baseY + size / 2 + 0.001,
      z,
      q,
      "rust",
      size,
    );
  }

  /** 3-2-1 pyramid of large crates along the local X axis. */
  crateStack(x: number, z: number, yaw: number): this {
    const size = 0.8;
    const pitch = size + 0.02;
    for (let level = 0; level < 3; level++) {
      const count = 3 - level;
      for (let i = 0; i < count; i++) {
        const o = (i - (count - 1) / 2) * pitch;
        const cx = x + Math.cos(yaw) * o;
        const cz = z - Math.sin(yaw) * o;
        this.crate(cx, cz, size, yaw, level * (size + 0.002));
      }
    }
    return this;
  }

  pallets(x: number, z: number, count: number, yaw: number): this {
    for (let i = 0; i < count; i++) {
      const jitter = yaw + (i % 2 ? 0.05 : -0.04);
      const q = new THREE.Quaternion().setFromAxisAngle(UP, jitter);
      const y = PALLET_HEIGHT / 2 + i * (PALLET_HEIGHT + 0.002) + 0.001;
      this.dynamic("pallet", x, y, z, q);
    }
    return this;
  }

  tires(x: number, z: number, count: number): this {
    for (let i = 0; i < count; i++) {
      const q = new THREE.Quaternion().setFromAxisAngle(UP, i * 0.7);
      this.dynamic("tire", x + (i % 2) * 0.03, 0.121 + i * 0.242, z, q);
    }
    return this;
  }

  cone(x: number, z: number): this {
    const q = new THREE.Quaternion().setFromAxisAngle(UP, x * 1.7 + z);
    return this.dynamic("cone", x, 0.201, z, q);
  }

  /** A steel popper on its stand, facing the spawn. */
  target(x: number, z: number): this {
    this.targets.push({ x, z, yaw: Math.atan2(SPAWN.x - x, SPAWN.z - z) });
    return this;
  }

  private dynamic(
    kind: DynamicKind,
    x: number,
    y: number,
    z: number,
    quaternion: THREE.Quaternion,
    variant: BarrelVariant = "rust",
    size = 0.8,
  ): this {
    const position = new THREE.Vector3(x, y, z);
    this.dynamics.push({ kind, position, quaternion, variant, size });
    return this;
  }
}

/** The whole arena. Player spawns at (0, 0, 8) facing north (-Z); keep r ≈ 4 m around it clear. */
function buildLayout(): LayoutBuilder {
  const L = new LayoutBuilder();
  const { minX, maxX, minZ, maxZ } = ARENA;
  const inset = 0.12; // side fences stop short of the corners

  // Boundary fence with gates.
  L.fenceLine(minX, minZ, maxX, minZ, [5, 14])
    .fenceLine(minX, maxZ, maxX, maxZ, [9, 10])
    .fenceLine(minX, minZ + inset, minX, maxZ - inset, [7, 16])
    .fenceLine(maxX, minZ + inset, maxX, maxZ - inset, [6, 15]);

  // Reference composition north of the spawn: fence row, orange pair, three drums, concrete.
  // The green drum sits on the spawn axis, so shooting straight ahead hits it.
  L.place("fence", -7.1, -8.7)
    .row("fence", 0.4, -8.7, 0, 2, 0.06)
    .place("fence", 6.9, -8.7)
    .row("plasticBarrier", -3.75, -4.3, 0, 2)
    .barrel(-1.2, -3.85, "blue")
    .barrel(0, -4.65, "green")
    .barrel(1.25, -4.05, "rust")
    .place("concreteBarrier", 3.65, -4.3);

  // Barrel pyramid and loose drums west of the spawn.
  L.barrelPyramid(-9.5, 0.5, 0.2, [
    "rust",
    "blue",
    "green",
    "green",
    "rust",
    "blue",
  ])
    .lyingBarrel(-11.6, 2.8, "blue", 0.6)
    .barrel(-7.4, 2.6, "rust")
    .barrel(-12.2, -1.4, "green");

  // Crate pyramid, loose crates and a pallet stack east of the spawn.
  L.crateStack(9.2, 1.0, -0.15)
    .crate(11.2, 2.6, 0.6, 0.5)
    .crate(7.4, 2.9, 0.8, 0.35)
    .pallets(11.8, -1.6, 4, 0.1);

  // Explosive cluster in the north-west with fodder for chain reactions.
  L.explosive(-15.0, -14.0)
    .explosive(-14.3, -14.6)
    .explosive(-15.6, -14.8)
    .explosive(-12.9, -12.8)
    .crate(-16.9, -13.0, 0.8, 0.2)
    .crate(-16.9, -13.0, 0.6, -0.3, 0.802)
    .barrel(-13.4, -16.0, "rust")
    .barrel(-12.6, -14.4, "blue")
    .lyingBarrel(-16.4, -16.2, "green", 1.2)
    .tires(-18.4, -15.0, 3);

  // Second explosive pocket by the range, and a lone drum seen through the fence gap.
  L.explosive(13.8, -10.6)
    .explosive(14.5, -11.2)
    .crate(15.6, -10.4, 0.8, 0.3)
    .barrel(13.0, -11.8, "green")
    .explosive(4.5, -11.6);

  // Steel poppers downrange (north-east) at increasing distances.
  // Each has a clear line of fire from the spawn (past the fence row and the range props).
  const poppers = [
    [13, -17],
    [16.5, -21.5],
    [20, -26],
    [23, -30.5],
    [26, -35],
    [9, -27],
    [13.5, -37],
  ];
  for (const [x, z] of poppers) L.target(x, z);
  L.place("sandbag", 8, -13, -0.6);

  // Vault lane on the east side: run north and hop every obstacle.
  const laneX = 21;
  L.place("sandbag", laneX, 14)
    .place("concreteBarrier", laneX, 10)
    .row("plasticBarrier", laneX, 6, 0, 2)
    .place("sandbag", laneX, 2)
    .place("concreteBarrier", laneX, -2)
    .row("wall", 25.5, 6, Math.PI / 2, 6, 0.02)
    .cone(19.2, 17.5)
    .cone(22.8, 17.5)
    .cone(19, -4.6)
    .cone(23, -4.6);

  // Tall T-wall cover.
  L.row("wall", -12, 12.5, 0, 3, 0.02)
    .row("wall", -21, -4, Math.PI / 2, 3, 0.02)
    .row("wall", -1.5, -22, 0, 4, 0.02)
    .row("wall", 5.5, -31, Math.PI / 2, 2, 0.02)
    .row("wall", 12.5, 14.5, 0, 2, 0.02);

  // Scattered low cover.
  L.place("concreteBarrier", -7.5, -19, 0.35)
    .row("plasticBarrier", -19, -27, -0.25, 2)
    .place("sandbag", -6, -31, 0.1)
    .place("sandbag", -24, -36, -0.4)
    .place("concreteBarrier", -24, 10, Math.PI / 2);

  // Tyres, pallets, cones and stray drums.
  L.tires(-17.5, 5.5, 3)
    .tires(-16.7, 6.2, 2)
    .tires(-22.5, -19, 4)
    .tires(8.5, -35, 3)
    .tires(14.5, 10.5, 2)
    .pallets(-5.8, 13.5, 1, 0.3)
    .pallets(4.8, 14.2, 1, -0.25)
    .cone(4.6, 3.8)
    .cone(6.2, 5.2)
    .cone(-5.2, 4.6)
    .cone(-8.6, -17.2)
    .cone(13, -7)
    .barrel(-20, 14.2, "blue")
    .barrel(-19.3, 14.8, "rust")
    .barrel(25, -10, "green")
    .barrel(-26, -40, "rust")
    .barrel(3, -36, "blue")
    .lyingBarrel(14.5, 5.6, "rust", 0.2);

  return L;
}

// ---------------------------------------------------------------------------------------------
// Runtime pieces
// ---------------------------------------------------------------------------------------------

interface CollideEvent {
  contact: CANNON.ContactEquation;
}

interface DynamicEntry {
  prop: Prop;
  body: CANNON.Body;
  mesh: THREE.Mesh;
  spawn: DynamicSpawn;
  /** Per-prop material clone (explosive barrels), disposed with the prop. */
  ownMaterial: THREE.MeshStandardMaterial | null;
  fused: boolean;
  lastImpact: number;
  onCollide: (event: CollideEvent) => void;
}

interface Fuse {
  entry: DynamicEntry;
  timer: number;
  puff: number;
}

/** Merges static meshes per material into a handful of draw calls. */
class StaticBatch {
  private readonly groups = new Map<THREE.Material, THREE.BufferGeometry[]>();

  add(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    matrix: THREE.Matrix4,
  ): void {
    let list = this.groups.get(material);
    if (!list) {
      list = [];
      this.groups.set(material, list);
    }
    list.push(geometry.clone().applyMatrix4(matrix));
  }

  build(parent: THREE.Object3D): THREE.Mesh[] {
    const meshes: THREE.Mesh[] = [];
    for (const [material, parts] of this.groups) {
      const merged = mergeGeometries(parts);
      for (const part of parts) part.dispose();
      if (!merged) throw new Error("StaticBatch: incompatible geometries");
      const mesh = new THREE.Mesh(merged, material);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      parent.add(mesh);
      meshes.push(mesh);
    }
    this.groups.clear();
    return meshes;
  }
}

/** Steel popper: static stand + hinged plate that falls back when hit and springs up again. */
class SteelTarget {
  readonly prop: Prop;
  readonly standBody: CANNON.Body;
  readonly plateBody: CANNON.Body;
  /** World position of the plate's centre (event payloads). */
  readonly center = new THREE.Vector3();

  private readonly pivot = new THREE.Object3D();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly yawQuat = new CANNON.Quaternion();
  private angle = 0;
  private angularVelocity = 0;
  private down = false;
  private settled = true;
  private raiseTimer = 0;
  private flash = 0;

  constructor(
    id: number,
    placement: TargetPlacement,
    plateGeometry: THREE.BufferGeometry,
    physicsMaterial: CANNON.Material,
  ) {
    const root = new THREE.Object3D();
    root.position.set(placement.x, 0, placement.z);
    root.rotation.y = placement.yaw;
    root.add(this.pivot);
    this.pivot.position.copy(TARGET_PIVOT);
    root.updateMatrixWorld(true);

    this.material = targetPlateMaterial().clone();
    this.material.emissive.setHex(0xfff0c8);
    this.material.emissiveIntensity = PLATE_GLOW;
    const plate = new THREE.Mesh(plateGeometry, this.material);
    plate.castShadow = true;
    plate.receiveShadow = true;
    this.pivot.add(plate);

    this.yawQuat.setFromAxisAngle(C_Y_AXIS, placement.yaw);
    this.standBody = staticBody(
      physicsMaterial,
      placement.x,
      placement.z,
      placement.yaw,
    );
    this.standBody.addShape(
      new CANNON.Box(new CANNON.Vec3(0.28, 0.16, 0.34)),
      new CANNON.Vec3(0, 0.16, -0.06),
    );
    // Plate body origin = hinge; shapes approximate the body and the head of the popper.
    this.plateBody = new CANNON.Body({
      mass: 0,
      material: physicsMaterial,
      collisionFilterGroup: GROUP.STATIC,
    });
    this.plateBody.addShape(
      new CANNON.Box(new CANNON.Vec3(0.13, 0.33, 0.012)),
      new CANNON.Vec3(0, 0.33, 0),
    );
    this.plateBody.addShape(
      new CANNON.Box(new CANNON.Vec3(0.15, 0.15, 0.012)),
      new CANNON.Vec3(0, 0.85, 0),
    );
    const hinge = this.pivot.getWorldPosition(_vec);
    this.plateBody.position.set(hinge.x, hinge.y, hinge.z);
    this.syncPlate();

    this.center.set(0, 0.55, 0).applyMatrix4(this.pivot.matrixWorld);
    this.prop = {
      id,
      kind: "target",
      object: root,
      body: this.plateBody,
      surface: "steel",
      dynamic: false,
      vaultable: false,
      bounds: orientedBox(
        placement.x,
        placement.z,
        placement.yaw,
        0.6,
        1.45,
        0.7,
      ),
      health: Infinity,
      maxHealth: Infinity,
      alive: true,
    };
  }

  /** Flashes the plate; knocks it down if it is up. Returns true when it fell. */
  knock(push: number): boolean {
    this.flash = 1;
    if (this.down) return false;
    this.down = true;
    this.settled = false;
    this.raiseTimer = TARGET_RAISE_DELAY;
    this.angularVelocity = Math.min(this.angularVelocity, 0) - (5 + push);
    return true;
  }

  update(dt: number): void {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - dt * 5);
      this.material.emissiveIntensity =
        PLATE_GLOW + this.flash * this.flash * 0.9;
    }
    if (this.down) {
      this.raiseTimer -= dt;
      if (this.raiseTimer <= 0) {
        this.down = false;
        this.settled = false;
      }
    }
    if (this.settled) return;

    // Damped spring toward the goal angle; lively on the way up, a hard stop when lying down.
    const goal = this.down ? TARGET_DOWN_ANGLE : 0;
    const stiffness = this.down ? 160 : 70;
    const damping = this.down ? 6 : 5.5;
    const accel =
      stiffness * (goal - this.angle) - damping * this.angularVelocity;
    this.angularVelocity += accel * dt;
    this.angle += this.angularVelocity * dt;
    if (this.angle < TARGET_DOWN_ANGLE) {
      this.angle = TARGET_DOWN_ANGLE;
      this.angularVelocity = Math.abs(this.angularVelocity) * 0.35;
    }
    if (
      Math.abs(this.angle - goal) < 1e-3 &&
      Math.abs(this.angularVelocity) < 1e-2
    ) {
      this.angle = goal;
      this.angularVelocity = 0;
      this.settled = true;
    }
    this.syncPlate();
  }

  reset(): void {
    this.angle = 0;
    this.angularVelocity = 0;
    this.down = false;
    this.settled = true;
    this.raiseTimer = 0;
    this.flash = 0;
    this.material.emissiveIntensity = PLATE_GLOW;
    this.syncPlate();
  }

  dispose(): void {
    this.material.dispose();
  }

  private syncPlate(): void {
    this.pivot.rotation.x = this.angle;
    _cQuat.setFromAxisAngle(C_X_AXIS, this.angle);
    this.yawQuat.mult(_cQuat, this.plateBody.quaternion);
    this.plateBody.aabbNeedsUpdate = true;
  }
}

function staticBody(
  material: CANNON.Material,
  x: number,
  z: number,
  yaw: number,
): CANNON.Body {
  const body = new CANNON.Body({
    mass: 0,
    material,
    collisionFilterGroup: GROUP.STATIC,
  });
  body.position.set(x, 0, z);
  body.quaternion.setFromAxisAngle(C_Y_AXIS, yaw);
  return body;
}

function orientedBox(
  x: number,
  z: number,
  yaw: number,
  length: number,
  height: number,
  depth: number,
): OrientedBox {
  return {
    center: new THREE.Vector3(x, height / 2, z),
    halfExtents: new THREE.Vector3(length / 2, height / 2, depth / 2),
    yaw,
  };
}

/** Teleports a body to its spawn transform, at rest and asleep. */
function placeBody(body: CANNON.Body, spawn: DynamicSpawn): void {
  const { position: p, quaternion: q } = spawn;
  body.position.set(p.x, p.y, p.z);
  body.previousPosition.copy(body.position);
  body.interpolatedPosition.copy(body.position);
  body.quaternion.set(q.x, q.y, q.z, q.w);
  body.previousQuaternion.copy(body.quaternion);
  body.interpolatedQuaternion.copy(body.quaternion);
  body.velocity.setZero();
  body.angularVelocity.setZero();
  body.aabbNeedsUpdate = true;
  body.sleep();
}

function createSun(): THREE.DirectionalLight {
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6);
  sun.castShadow = true;
  const shadow = sun.shadow;
  shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  shadow.bias = -0.0004;
  shadow.normalBias = 0.025;
  const cam = shadow.camera;
  cam.left = -SHADOW_HALF_SIZE;
  cam.right = SHADOW_HALF_SIZE;
  cam.top = SHADOW_HALF_SIZE;
  cam.bottom = -SHADOW_HALF_SIZE;
  cam.near = 1;
  cam.far = SUN_OFFSET.length() + 40;
  cam.updateProjectionMatrix();
  return sun;
}

// ---------------------------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------------------------

/**
 * The level: floor + grid, lighting/shadows, and every prop (static cover, physics barrels/crates,
 * explosive barrels, steel targets). Owns prop damage, explosions and collision sound events.
 */
export class World {
  /** Live props: static cover and targets first, then dynamic props. */
  readonly props: Prop[] = [];
  readonly spawnPoint = SPAWN.clone();
  /** Spawn facing: PI = facing -Z (toward the top of the screen). */
  readonly spawnYaw = Math.PI;

  private readonly root = new THREE.Group();
  private readonly staticRoot = new THREE.Group();
  private readonly hemi = new THREE.HemisphereLight(0xd6e2ff, 0x1c2433, 1.3);
  private readonly sun = createSun();
  /** Shadow camera axes (x, y on the shadow map, z toward the sun) for texel snapping. */
  private readonly sunAxes = shadowAxes(SUN_OFFSET);
  private readonly focus = new THREE.Vector3();

  private readonly layout = buildLayout();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly bodyToProp = new Map<CANNON.Body, Prop>();
  private readonly dynamics: DynamicEntry[] = [];
  private readonly dynamicByProp = new Map<Prop, DynamicEntry>();
  private readonly targets: SteelTarget[] = [];
  private readonly targetByProp = new Map<Prop, SteelTarget>();
  private readonly fuses: Fuse[] = [];
  private staticMeshes: THREE.Mesh[] = [];
  private floor: THREE.Mesh | null = null;
  private nextId = 1;
  private barrelMass = 0;

  constructor(private readonly ctx: GameContext) {}

  /** Create floor, lights and all props. Called once after every system exists. */
  build(): void {
    this.ctx.scene.add(this.root);
    this.root.add(this.staticRoot);
    this.buildEnvironment();

    const batch = new StaticBatch();
    for (const placement of this.layout.statics)
      this.addStatic(placement, batch);
    for (const placement of this.layout.targets)
      this.addTarget(placement, batch);
    this.staticMeshes = batch.build(this.staticRoot);

    this.barrelMass = this.ctx.tuning.barrelMass;
    for (const spawn of this.layout.dynamics) this.spawnDynamic(spawn);
    this.updateShadowFocus(this.spawnPoint);
  }

  /** F9: restore every prop to its initial state (rebuild dynamic ones). */
  reset(): void {
    this.fuses.length = 0;
    for (let i = this.dynamics.length - 1; i >= 0; i--) {
      this.removeDynamic(this.dynamics[i]);
    }
    for (const spawn of this.layout.dynamics) this.spawnDynamic(spawn);
    for (const target of this.targets) target.reset();
  }

  /** Sync dynamic meshes from bodies, run fuses/target timers. After physics each frame. */
  update(dt: number): void {
    this.applyBarrelMass();
    for (const entry of this.dynamics) {
      const { body, mesh } = entry;
      if (body.position.y < RESPAWN_BELOW_Y) placeBody(body, entry.spawn);
      const p = body.interpolatedPosition;
      const q = body.interpolatedQuaternion;
      mesh.position.set(p.x, p.y, p.z);
      mesh.quaternion.set(q.x, q.y, q.z, q.w);
    }
    this.updateFuses(dt);
    for (const target of this.targets) target.update(dt);
  }

  propFromBody(body: CANNON.Body | null): Prop | null {
    return body ? (this.bodyToProp.get(body) ?? null) : null;
  }

  /** Bullet hit: impulse at the hit point, damage, explosive fuse, target knock-down. */
  applyBulletHit(
    prop: Prop,
    hit: HitInfo,
    dir: THREE.Vector3,
    damage: number,
    impulse: number,
  ): void {
    if (!prop.alive) return;
    prop.health -= damage;
    const entry = this.dynamicByProp.get(prop);
    if (entry) {
      const body = entry.body;
      body.wakeUp();
      _impulse.set(dir.x * impulse, dir.y * impulse, dir.z * impulse);
      _rel.set(
        hit.point.x - body.position.x,
        hit.point.y - body.position.y,
        hit.point.z - body.position.z,
      );
      body.applyImpulse(_impulse, _rel);
      if (prop.kind === "explosiveBarrel" && prop.health <= 0) {
        this.startFuse(entry, randRange(FUSE_TIME));
      }
      return;
    }
    const target = this.targetByProp.get(prop);
    if (target && hit.body === target.plateBody) {
      this.knockTarget(target, impulse * 0.6);
    }
  }

  /**
   * Radial impulse + damage. `force` is the peak velocity change (m/s) of a barrel-mass prop at
   * the centre (× tuning.explosionForce); lighter props fly further. Emits "explosion" + FX.
   */
  explode(position: THREE.Vector3, radius: number, force: number): void {
    const { fx, events, tuning } = this.ctx;
    fx.explosion(position, radius);
    events.emit("explosion", { position, radius });

    const refMass = Math.max(1, tuning.barrelMass);
    for (const entry of this.dynamics) {
      const body = entry.body;
      const bp = body.position;
      _vec.set(bp.x - position.x, bp.y - position.y, bp.z - position.z);
      const dist = _vec.length();
      if (dist >= radius) continue;
      const falloff = 1 - dist / radius;

      if (entry.prop.kind === "explosiveBarrel") {
        entry.prop.health -= 30 + 150 * falloff;
        if (entry.prop.health <= 0)
          this.startFuse(entry, randRange(CHAIN_DELAY));
      }

      const dv = Math.min(
        EXPLOSION_MAX_DV,
        force *
          tuning.explosionForce *
          falloff *
          (0.4 + 0.6 * falloff) *
          Math.sqrt(refMass / body.mass),
      );
      _vec.y = 0;
      if (_vec.lengthSq() < 1e-6)
        _vec.set(Math.random() - 0.5, 0, Math.random() - 0.5);
      _vec.normalize();
      _vec.y = EXPLOSION_LIFT + 0.35 * falloff;
      _vec.normalize().multiplyScalar(body.mass * dv);
      _impulse.set(_vec.x, _vec.y, _vec.z);
      // Push below and off the centre so props tumble instead of sliding.
      _rel.set((Math.random() - 0.5) * 0.3, -0.15, (Math.random() - 0.5) * 0.3);
      body.wakeUp();
      body.applyImpulse(_impulse, _rel);
    }

    for (const target of this.targets) {
      if (target.center.distanceTo(position) < radius)
        this.knockTarget(target, 10);
    }
  }

  /** Move the shadow-casting light's frustum to follow the player. */
  updateShadowFocus(center: THREE.Vector3): void {
    // Snap to whole shadow-map texels across the light's view so shadows don't shimmer.
    const texel = (2 * SHADOW_HALF_SIZE) / SHADOW_MAP_SIZE;
    const { x, y, z } = this.sunAxes;
    const sx = Math.round(center.dot(x) / texel) * texel;
    const sy = Math.round(center.dot(y) / texel) * texel;
    this.focus
      .copy(x)
      .multiplyScalar(sx)
      .addScaledVector(y, sy)
      .addScaledVector(z, center.dot(z));
    this.sun.target.position.copy(this.focus);
    this.sun.position.copy(this.focus).add(SUN_OFFSET);
  }

  /** Remove everything this world added to the scene and the physics world. */
  dispose(): void {
    const { physics } = this.ctx;
    this.fuses.length = 0;
    for (let i = this.dynamics.length - 1; i >= 0; i--) {
      this.removeDynamic(this.dynamics[i]);
    }
    for (const prop of this.props) if (prop.body) physics.removeBody(prop.body);
    for (const target of this.targets) {
      physics.removeBody(target.standBody);
      target.dispose();
    }
    this.props.length = 0;
    this.targets.length = 0;
    this.bodyToProp.clear();
    this.targetByProp.clear();
    for (const mesh of this.staticMeshes) mesh.geometry.dispose();
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.floor?.geometry.dispose();
    this.root.removeFromParent();
    this.ctx.scene.fog = null;
  }

  // -------------------------------------------------------------------------------------------

  private buildEnvironment(): void {
    const { scene } = this.ctx;
    const background =
      scene.background instanceof THREE.Color
        ? scene.background.getHex()
        : 0x222b38;
    scene.fog = new THREE.Fog(background, FOG_NEAR, FOG_FAR);

    const geometry = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE);
    geometry.rotateX(-Math.PI / 2);
    const uv = geometry.getAttribute("uv") as THREE.BufferAttribute;
    const tiles = FLOOR_SIZE / GRID_TILE_METRES;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * tiles, uv.getY(i) * tiles);
    }
    this.floor = new THREE.Mesh(geometry, floorMaterial());
    this.floor.receiveShadow = true;
    this.floor.matrixAutoUpdate = false;
    this.root.add(this.floor, this.hemi, this.sun, this.sun.target);
  }

  private geometry(
    key: string,
    create: () => THREE.BufferGeometry,
  ): THREE.BufferGeometry {
    let geometry = this.geometries.get(key);
    if (!geometry) {
      geometry = create();
      this.geometries.set(key, geometry);
    }
    return geometry;
  }

  private addStatic(placement: StaticPlacement, batch: StaticBatch): void {
    const { kind, x, z, yaw } = placement;
    const spec = STATIC_SPECS[kind];
    const anchor = new THREE.Object3D();
    anchor.position.set(x, 0, z);
    anchor.rotation.y = yaw;
    anchor.updateMatrix();
    anchor.matrixAutoUpdate = false;
    this.staticRoot.add(anchor);

    const variant = Math.abs(Math.round(x * 7 + z * 13)) % spec.variants;
    const geometry = this.geometry(`${kind}-${variant}`, () =>
      spec.geometry(variant),
    );
    batch.add(geometry, spec.material(), anchor.matrix);

    const body = staticBody(this.ctx.physics.materials.prop, x, z, yaw);
    for (const box of spec.boxes) {
      body.addShape(new CANNON.Box(cannonVec(box.half)), cannonVec(box.at));
    }
    this.ctx.physics.addBody(body);

    const prop: Prop = {
      id: this.nextId++,
      kind,
      object: anchor,
      body,
      surface: spec.surface,
      dynamic: false,
      vaultable: spec.vaultable,
      bounds: orientedBox(x, z, yaw, spec.length, spec.height, spec.depth),
      health: Infinity,
      maxHealth: Infinity,
      alive: true,
    };
    this.bodyToProp.set(body, prop);
    this.props.push(prop);
  }

  private addTarget(placement: TargetPlacement, batch: StaticBatch): void {
    const plate = this.geometry("popper-plate", popperPlateGeometry);
    const target = new SteelTarget(
      this.nextId++,
      placement,
      plate,
      this.ctx.physics.materials.prop,
    );
    const root = target.prop.object;
    const stand = this.geometry("popper-stand", targetStandGeometry);
    batch.add(stand, steelMaterial(), root.matrixWorld);
    this.root.add(root);
    this.ctx.physics.addBody(target.standBody);
    this.ctx.physics.addBody(target.plateBody);
    this.bodyToProp.set(target.standBody, target.prop);
    this.bodyToProp.set(target.plateBody, target.prop);
    this.targetByProp.set(target.prop, target);
    this.targets.push(target);
    this.props.push(target.prop);
  }

  private spawnDynamic(spawn: DynamicSpawn): void {
    const model = dynamicModel(spawn, this.barrelMass);
    const body = new CANNON.Body({
      mass: model.mass,
      material: this.ctx.physics.materials.prop,
      collisionFilterGroup: GROUP.DYNAMIC,
      linearDamping: 0.05,
      angularDamping: 0.3,
      allowSleep: true,
      sleepSpeedLimit: 0.15,
      sleepTimeLimit: 0.5,
    });
    for (const [shape, offset] of model.shapes) body.addShape(shape, offset);
    placeBody(body, spawn);

    const ownMaterial = model.ownMaterial ? model.material.clone() : null;
    if (ownMaterial) {
      ownMaterial.emissive.setHex(0xff5a14);
      ownMaterial.emissiveIntensity = 0;
    }
    const geometry = this.geometry(model.geometryKey, model.geometry);
    const mesh = new THREE.Mesh(geometry, ownMaterial ?? model.material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.copy(spawn.position);
    mesh.quaternion.copy(spawn.quaternion);
    this.root.add(mesh);

    const prop: Prop = {
      id: this.nextId++,
      kind: spawn.kind,
      object: mesh,
      body,
      surface: model.surface,
      dynamic: true,
      vaultable: false,
      health: model.health,
      maxHealth: model.health,
      alive: true,
    };
    const entry: DynamicEntry = {
      prop,
      body,
      mesh,
      spawn,
      ownMaterial,
      fused: false,
      lastImpact: -Infinity,
      onCollide: (event) => this.onPropCollide(entry, event),
    };
    body.addEventListener("collide", entry.onCollide);
    this.ctx.physics.addBody(body);
    this.bodyToProp.set(body, prop);
    this.dynamicByProp.set(prop, entry);
    this.dynamics.push(entry);
    this.props.push(prop);
  }

  private removeDynamic(entry: DynamicEntry): void {
    const { prop, body, mesh } = entry;
    prop.alive = false;
    body.removeEventListener("collide", entry.onCollide);
    this.ctx.physics.removeBody(body);
    this.ctx.fx.detachFrom(mesh);
    mesh.removeFromParent();
    entry.ownMaterial?.dispose();
    this.bodyToProp.delete(body);
    this.dynamicByProp.delete(prop);
    this.dynamics.splice(this.dynamics.indexOf(entry), 1);
    this.props.splice(this.props.indexOf(prop), 1);
  }

  /** Keeps barrel bodies in sync with the live-tunable barrel mass. */
  private applyBarrelMass(): void {
    const mass = this.ctx.tuning.barrelMass;
    if (mass === this.barrelMass) return;
    this.barrelMass = mass;
    for (const entry of this.dynamics) {
      if (!isBarrel(entry.prop.kind)) continue;
      entry.body.mass = mass;
      entry.body.updateMassProperties();
    }
  }

  private onPropCollide(entry: DynamicEntry, event: CollideEvent): void {
    const speed = Math.abs(event.contact.getImpactVelocityAlongNormal());
    if (speed < COLLISION_MIN_SPEED) return;
    const now = this.ctx.clock.time;
    if (now - entry.lastImpact < COLLISION_THROTTLE) return;
    entry.lastImpact = now;
    const p = entry.body.position;
    this.ctx.events.emit("propCollision", {
      position: _event.set(p.x, p.y, p.z),
      surface: entry.prop.surface,
      strength: Math.min(1, speed / COLLISION_FULL_SPEED),
    });
  }

  private startFuse(entry: DynamicEntry, delay: number): void {
    if (entry.fused) return;
    entry.fused = true;
    this.fuses.push({ entry, timer: delay, puff: 0 });
  }

  private updateFuses(dt: number): void {
    const { fx } = this.ctx;
    // Backwards: detonations splice their own fuse and may append new ones (chains).
    for (let i = this.fuses.length - 1; i >= 0; i--) {
      const fuse = this.fuses[i];
      const { body, ownMaterial } = fuse.entry;
      if (ownMaterial)
        ownMaterial.emissiveIntensity = 0.35 + Math.random() * 1.15;
      fuse.puff -= dt;
      if (fuse.puff <= 0) {
        fuse.puff = 0.05;
        _vec.set(body.position.x, body.position.y + 0.5, body.position.z);
        fx.smoke(_vec, UP, 0.7);
        if (Math.random() < 0.4) fx.sparks(_vec, UP, 2);
      }
      fuse.timer -= dt;
      if (fuse.timer <= 0) {
        this.fuses.splice(i, 1);
        this.detonate(fuse.entry);
      }
    }
  }

  private detonate(entry: DynamicEntry): void {
    const p = entry.body.position;
    _blast.set(p.x, p.y, p.z);
    const kind = entry.prop.kind;
    this.removeDynamic(entry);
    this.ctx.stats.barrelsExploded++;
    this.ctx.events.emit("propDestroyed", { position: _blast, kind });
    this.explode(_blast, EXPLOSION_RADIUS, EXPLOSION_FORCE);
  }

  private knockTarget(target: SteelTarget, push: number): void {
    if (!target.knock(push)) return;
    const { stats, events } = this.ctx;
    stats.targetsDropped++;
    events.emit("targetHit", {
      position: target.center,
      total: stats.targetsDropped,
    });
  }
}

function shadowAxes(offset: THREE.Vector3): {
  x: THREE.Vector3;
  y: THREE.Vector3;
  z: THREE.Vector3;
} {
  // Same basis Matrix4.lookAt builds for the shadow camera (eye = sun, up = +Y).
  const z = offset.clone().normalize();
  const x = new THREE.Vector3().crossVectors(UP, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  return { x, y, z };
}
