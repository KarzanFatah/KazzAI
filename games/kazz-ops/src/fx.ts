import * as THREE from "three";
import type { GameContext, HitInfo, Surface } from "./types";

/*
 * Pooled visual effects. Everything is drawn with a handful of instanced draw calls:
 *  - two billboard sprite batches (alpha-blended smoke/dust, additive fire/flashes),
 *  - one additive streak batch (sparks, embers, tracers, muzzle flame),
 *  - three debris pools (chips/splinters, brass casings, shotgun shells),
 *  - one decal pool (bullet holes + scorch marks),
 *  - one reused point light for flashes.
 * Pools are fixed-size; when one is full the oldest particle is recycled. Nothing allocates per hit.
 * The particle shaders skip tone mapping: ACES would wash every bright additive colour to white.
 */

const TAU = Math.PI * 2;
const ZERO = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
/** Rotates a Y-axis cylinder onto its side. */
const LIE_FLAT = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(1, 0, 0),
  Math.PI / 2,
);
/** Fraction of its life a particle may advance on the frame it was spawned (so it is always seen). */
const FIRST_FRAME = 0.25;

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpVel = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpQuat2 = new THREE.Quaternion();
const tmpEuler = new THREE.Euler();
const tmpScale = new THREE.Vector3();
const tmpMatrix = new THREE.Matrix4();
const tmpColor = new THREE.Color();
const ZERO_MATRIX = new THREE.Matrix4().makeScale(0, 0, 0);

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

/** Uniformly distributed random unit vector. */
function randomUnit(out: THREE.Vector3): THREE.Vector3 {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * TAU;
  const r = Math.sqrt(1 - z * z);
  return out.set(r * Math.cos(a), z, r * Math.sin(a));
}

/** `axis` pushed by a random vector of length `jitter`, normalised. `out` must not alias `axis`. */
function jitterDir(
  out: THREE.Vector3,
  axis: THREE.Vector3,
  jitter: number,
): THREE.Vector3 {
  return randomUnit(out).multiplyScalar(jitter).add(axis).normalize();
}

/** Linear-space colour, allowed to exceed 1 for additive glow. */
function hdr(r: number, g: number, b: number, k = 1): THREE.Color {
  return new THREE.Color(r * k, g * k, b * k);
}

function dynamicAttribute(
  capacity: number,
  itemSize: number,
): THREE.InstancedBufferAttribute {
  const attr = new THREE.InstancedBufferAttribute(
    new Float32Array(capacity * itemSize),
    itemSize,
  );
  attr.setUsage(THREE.DynamicDrawUsage);
  return attr;
}

function flushAttribute(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count * attr.itemSize);
  attr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Canvas textures (drawn once)
// ---------------------------------------------------------------------------

const TILE = 128;

type Rng = () => number;
type Painter = (g: CanvasRenderingContext2D, rng: Rng) => void;
type Stops = ReadonlyArray<readonly [number, string]>;

function makeRng(seed: number): Rng {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function radial(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  stops: Stops,
): void {
  const grad = g.createRadialGradient(x, y, 0, x, y, r);
  for (const [offset, color] of stops) grad.addColorStop(offset, color);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(x, y, r, 0, TAU);
  g.fill();
}

/** Irregular closed polygon around the origin. */
function jaggedPath(
  g: CanvasRenderingContext2D,
  rng: Rng,
  radius: number,
  jag: number,
  points: number,
): void {
  g.beginPath();
  for (let i = 0; i < points; i++) {
    const a = (i / points) * TAU;
    const r = radius * (1 - jag + rng() * jag * 2);
    if (i === 0) g.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
}

function cracks(
  g: CanvasRenderingContext2D,
  rng: Rng,
  count: number,
  minLen: number,
  maxLen: number,
  color: string,
  angle: () => number,
): void {
  g.strokeStyle = color;
  g.lineCap = "round";
  for (let i = 0; i < count; i++) {
    const a = angle();
    const len = minLen + rng() * (maxLen - minLen);
    const bend = a + (rng() - 0.5) * 0.6;
    g.lineWidth = 1 + rng() * 2.5;
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(Math.cos(a) * len * 0.5, Math.sin(a) * len * 0.5);
    g.lineTo(Math.cos(bend) * len, Math.sin(bend) * len);
    g.stroke();
  }
}

/** Paints tiles into a cols x rows atlas. flipY is off: tile (c, r) sits at uv (c / cols, r / rows). */
function buildAtlas(
  cols: number,
  rows: number,
  painters: Painter[],
  seed: number,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = cols * TILE;
  canvas.height = rows * TILE;
  const g = canvas.getContext("2d");
  if (!g) throw new Error("2D canvas is not available");
  const rng = makeRng(seed);
  painters.forEach((paint, i) => {
    g.save();
    g.translate(
      (i % cols) * TILE + TILE / 2,
      Math.floor(i / cols) * TILE + TILE / 2,
    );
    g.beginPath();
    g.rect(-TILE / 2, -TILE / 2, TILE, TILE);
    g.clip();
    paint(g, rng);
    g.restore();
  });
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.flipY = false;
  return texture;
}

const WHITE_FADE: Stops = [
  [0, "rgba(255,255,255,1)"],
  [1, "rgba(255,255,255,0)"],
];

// Sprite atlas tiles (2 x 2).
const SPRITE_GLOW = 0;
const SPRITE_PUFF = 1;
const SPRITE_STAR = 2;
const SPRITE_FLARE = 3;

const SPRITE_PAINTERS: Painter[] = [
  (g) =>
    radial(g, 0, 0, 60, [
      [0, "rgba(255,255,255,1)"],
      [0.18, "rgba(255,255,255,0.8)"],
      [0.45, "rgba(255,255,255,0.28)"],
      [1, "rgba(255,255,255,0)"],
    ]),
  (g, rng) => {
    for (let i = 0; i < 11; i++) {
      const a = rng() * TAU;
      const d = rng() * 22;
      const shade = Math.round(205 + rng() * 50);
      radial(g, Math.cos(a) * d, Math.sin(a) * d, 20 + rng() * 18, [
        [0, `rgba(${shade},${shade},${shade},0.55)`],
        [1, `rgba(${shade},${shade},${shade},0)`],
      ]);
    }
    g.globalCompositeOperation = "destination-in";
    radial(g, 0, 0, 62, [
      [0, "rgba(255,255,255,1)"],
      [0.5, "rgba(255,255,255,1)"],
      [1, "rgba(255,255,255,0)"],
    ]);
    g.globalCompositeOperation = "source-over";
  },
  (g, rng) => {
    for (let k = 0; k < 8; k++) {
      g.save();
      g.rotate((k / 8) * TAU + (rng() - 0.5) * 0.25);
      g.scale(1, 0.1);
      radial(g, 0, 0, k % 2 === 0 ? 60 : 38, [
        [0, "rgba(255,255,255,1)"],
        [0.4, "rgba(255,255,255,0.5)"],
        [1, "rgba(255,255,255,0)"],
      ]);
      g.restore();
    }
    radial(g, 0, 0, 26, WHITE_FADE);
  },
  (g) =>
    radial(g, 0, 0, 44, [
      [0, "rgba(255,255,255,1)"],
      [0.12, "rgba(255,255,255,0.95)"],
      [0.3, "rgba(255,255,255,0.3)"],
      [1, "rgba(255,255,255,0)"],
    ]),
];

// Decal atlas tiles (4 x 2).
const DECAL_METAL = 0;
const DECAL_WOOD = 1;
const DECAL_CONCRETE = 2;
const DECAL_SCORCH = 3;
const DECAL_SMUDGE = 4;
const DECAL_PLASTIC = 5;
const DECAL_BLOOD = 6;
const DECAL_COLS = 4;
const DECAL_ROWS = 2;

const DECAL_PAINTERS: Painter[] = [
  // Metal: paint flaked off around a dark hole -> bright bare-metal rim.
  (g, rng) => {
    jaggedPath(g, rng, 36, 0.22, 16);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, 40);
    grad.addColorStop(0, "rgba(250,246,236,0.95)");
    grad.addColorStop(0.75, "rgba(185,180,170,0.75)");
    grad.addColorStop(1, "rgba(120,115,108,0.2)");
    g.fillStyle = grad;
    g.fill();
    radial(g, 0, 0, 25, [
      [0, "rgba(0,0,0,1)"],
      [0.6, "rgba(12,10,9,1)"],
      [0.85, "rgba(45,36,30,0.8)"],
      [1, "rgba(45,36,30,0)"],
    ]);
  },
  // Wood: raw splintered wood with cracks along the grain.
  (g, rng) => {
    g.fillStyle = "rgba(200,160,108,0.75)";
    jaggedPath(g, rng, 30, 0.38, 14);
    g.fill();
    cracks(
      g,
      rng,
      7,
      24,
      54,
      "rgba(30,18,10,0.85)",
      () => (rng() < 0.5 ? 0 : Math.PI) + (rng() - 0.5) * 0.8,
    );
    radial(g, 0, 0, 22, [
      [0, "rgba(8,5,3,1)"],
      [0.7, "rgba(28,16,8,0.95)"],
      [1, "rgba(28,16,8,0)"],
    ]);
  },
  // Concrete: light chipped crater with a dark pit.
  (g, rng) => {
    g.fillStyle = "rgba(214,210,200,0.9)";
    jaggedPath(g, rng, 40, 0.3, 11);
    g.fill();
    radial(g, 0, 0, 30, [
      [0, "rgba(70,68,64,1)"],
      [0.5, "rgba(112,108,102,0.9)"],
      [1, "rgba(150,147,140,0)"],
    ]);
    cracks(g, rng, 4, 26, 52, "rgba(60,58,55,0.7)", () => rng() * TAU);
    radial(g, 0, 0, 11, [
      [0, "rgba(10,10,10,1)"],
      [1, "rgba(10,10,10,0)"],
    ]);
  },
  // Scorch: soft black blotches.
  (g, rng) => {
    for (let i = 0; i < 20; i++) {
      const a = rng() * TAU;
      const d = 8 + rng() * 24;
      radial(g, Math.cos(a) * d, Math.sin(a) * d, 12 + rng() * 16, [
        [0, "rgba(8,6,5,0.5)"],
        [1, "rgba(8,6,5,0)"],
      ]);
    }
    radial(g, 0, 0, 34, [
      [0, "rgba(0,0,0,0.8)"],
      [0.6, "rgba(10,8,6,0.45)"],
      [1, "rgba(0,0,0,0)"],
    ]);
  },
  // Smudge: dark puff mark with a small hole (ground, rubber, fabric).
  (g, rng) => {
    for (let i = 0; i < 6; i++) {
      const a = rng() * TAU;
      const d = rng() * 14;
      radial(g, Math.cos(a) * d, Math.sin(a) * d, 14 + rng() * 14, [
        [0, "rgba(0,0,0,0.38)"],
        [1, "rgba(0,0,0,0)"],
      ]);
    }
    radial(g, 0, 0, 11, [
      [0, "rgba(0,0,0,0.95)"],
      [1, "rgba(0,0,0,0)"],
    ]);
  },
  // Plastic: clean round hole with a pale stress ring.
  (g) => {
    g.strokeStyle = "rgba(255,236,215,0.45)";
    g.lineWidth = 6;
    g.beginPath();
    g.arc(0, 0, 23, 0, TAU);
    g.stroke();
    radial(g, 0, 0, 19, [
      [0, "rgba(0,0,0,1)"],
      [0.75, "rgba(22,12,8,1)"],
      [1, "rgba(22,12,8,0)"],
    ]);
  },
  // Blood: irregular dark pool with satellite drops (tinted per splat).
  (g, rng) => {
    g.fillStyle = "rgba(255,255,255,0.9)";
    jaggedPath(g, rng, 30, 0.45, 18);
    g.fill();
    for (let i = 0; i < 14; i++) {
      const a = rng() * TAU;
      const d = 26 + rng() * 30;
      g.beginPath();
      g.arc(Math.cos(a) * d, Math.sin(a) * d, 1.5 + rng() * 4.5, 0, TAU);
      g.fill();
    }
    radial(g, 0, 0, 26, [
      [0, "rgba(120,120,120,0.55)"],
      [1, "rgba(120,120,120,0)"],
    ]);
  },
];

// ---------------------------------------------------------------------------
// Instanced renderers (filled from scratch every frame by the simulations)
// ---------------------------------------------------------------------------

const SPRITE_VERTEX = /* glsl */ `
attribute vec3 iPos;
attribute vec4 iColor;
attribute vec3 iParams; // size, rotation, atlas tile
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float c = cos(iParams.y);
  float s = sin(iParams.y);
  vec2 p = position.xy * iParams.x;
  mv.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  vUv = (uv + vec2(mod(iParams.z, 2.0), floor(iParams.z * 0.5))) * 0.5;
  vColor = iColor;
  gl_Position = projectionMatrix * mv;
}`;

const SPRITE_FRAGMENT = /* glsl */ `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 tex = texture2D(map, vUv);
  gl_FragColor = vec4(vColor.rgb * tex.rgb, vColor.a * tex.a);
  #include <colorspace_fragment>
}`;

/** Camera-facing billboards from an atlas. One draw call. */
class SpriteBatch {
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly pos: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly params: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor(
    private readonly capacity: number,
    map: THREE.Texture,
    blending: THREE.Blending,
    renderOrder: number,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex(quad.getIndex());
    geometry.setAttribute("position", quad.getAttribute("position"));
    geometry.setAttribute("uv", quad.getAttribute("uv"));
    this.pos = dynamicAttribute(capacity, 3);
    this.color = dynamicAttribute(capacity, 4);
    this.params = dynamicAttribute(capacity, 3);
    geometry.setAttribute("iPos", this.pos);
    geometry.setAttribute("iColor", this.color);
    geometry.setAttribute("iParams", this.params);
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: SPRITE_VERTEX,
      fragmentShader: SPRITE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.count = 0;
  }

  push(
    x: number,
    y: number,
    z: number,
    size: number,
    rotation: number,
    tile: number,
    r: number,
    g: number,
    b: number,
    a: number,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.pos.setXYZ(i, x, y, z);
    this.color.setXYZW(i, r, g, b, a);
    this.params.setXYZ(i, size, rotation, tile);
  }

  end(): void {
    const { geometry } = this.mesh;
    if (this.count === 0 && geometry.instanceCount === 0) return;
    geometry.instanceCount = this.count;
    if (this.count === 0) return;
    flushAttribute(this.pos, this.count);
    flushAttribute(this.color, this.count);
    flushAttribute(this.params, this.count);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

const STREAK_VERTEX = /* glsl */ `
attribute vec3 iA; // tail
attribute vec3 iB; // head
attribute vec4 iColor;
attribute float iWidth;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 a = modelViewMatrix * vec4(iA, 1.0);
  vec4 b = modelViewMatrix * vec4(iB, 1.0);
  vec2 d = b.xy - a.xy;
  float len = length(d);
  d = len > 1e-5 ? d / len : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float hw = iWidth * 0.5;
  vec4 p = mix(a, b, position.x);
  p.xy += n * position.y * hw + d * (position.x * 2.0 - 1.0) * hw;
  vUv = position.xy;
  vColor = iColor;
  gl_Position = projectionMatrix * p;
}`;

const STREAK_FRAGMENT = /* glsl */ `
varying vec2 vUv;
varying vec4 vColor;
void main() {
  float across = 1.0 - abs(vUv.y);
  float alpha = vColor.a * across * mix(0.12, 1.0, vUv.x);
  // Hotter core, same hue (tone mapping already whitens the brightest pixels).
  vec3 color = vColor.rgb * (0.7 + 0.7 * smoothstep(0.4, 1.0, across));
  gl_FragColor = vec4(color, alpha);
  #include <colorspace_fragment>
}`;

/** Additive camera-facing line segments with a soft edge, a hot core and a fading tail. */
class StreakBatch {
  readonly mesh: THREE.Mesh<
    THREE.InstancedBufferGeometry,
    THREE.ShaderMaterial
  >;
  private readonly a: THREE.InstancedBufferAttribute;
  private readonly b: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly width: THREE.InstancedBufferAttribute;
  private count = 0;

  constructor(
    private readonly capacity: number,
    renderOrder: number,
  ) {
    const geometry = new THREE.InstancedBufferGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute(
        [0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0],
        3,
      ),
    );
    this.a = dynamicAttribute(capacity, 3);
    this.b = dynamicAttribute(capacity, 3);
    this.color = dynamicAttribute(capacity, 4);
    this.width = dynamicAttribute(capacity, 1);
    geometry.setAttribute("iA", this.a);
    geometry.setAttribute("iB", this.b);
    geometry.setAttribute("iColor", this.color);
    geometry.setAttribute("iWidth", this.width);
    geometry.instanceCount = 0;

    const material = new THREE.ShaderMaterial({
      vertexShader: STREAK_VERTEX,
      fragmentShader: STREAK_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = renderOrder;
  }

  begin(): void {
    this.count = 0;
  }

  push(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    width: number,
    r: number,
    g: number,
    b: number,
    alpha: number,
  ): void {
    if (this.count >= this.capacity) return;
    const i = this.count++;
    this.a.setXYZ(i, ax, ay, az);
    this.b.setXYZ(i, bx, by, bz);
    this.color.setXYZW(i, r, g, b, alpha);
    this.width.setX(i, width);
  }

  end(): void {
    const { geometry } = this.mesh;
    if (this.count === 0 && geometry.instanceCount === 0) return;
    geometry.instanceCount = this.count;
    if (this.count === 0) return;
    flushAttribute(this.a, this.count);
    flushAttribute(this.b, this.count);
    flushAttribute(this.color, this.count);
    flushAttribute(this.width, this.count);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Simulations (struct-of-arrays in one Float32Array, swap-remove on death)
// ---------------------------------------------------------------------------

/** Base for fixed-capacity particle stores. */
abstract class ParticleStore {
  protected readonly data: Float32Array;
  protected count = 0;

  constructor(
    protected readonly capacity: number,
    protected readonly stride: number,
    private readonly ageOffset: number,
    private readonly lifeOffset: number,
  ) {
    this.data = new Float32Array(capacity * stride);
  }

  /** Index of a free slot, or of the most-faded particle when full. */
  protected alloc(): number {
    if (this.count < this.capacity) return this.count++;
    const d = this.data;
    let oldest = 0;
    let oldestT = -Infinity;
    for (let i = 0; i < this.count; i++) {
      const o = i * this.stride;
      const t = d[o + this.ageOffset] / d[o + this.lifeOffset];
      if (t > oldestT) {
        oldestT = t;
        oldest = i;
      }
    }
    return oldest;
  }

  protected remove(i: number): void {
    const last = --this.count;
    if (i !== last) {
      const s = this.stride;
      this.data.copyWithin(i * s, last * s, last * s + s);
    }
  }

  /** Advances the age of particle i; returns false when it died (and was removed). */
  protected advance(i: number, dt: number): boolean {
    const o = i * this.stride;
    const life = this.data[o + this.lifeOffset];
    const age = this.data[o + this.ageOffset];
    const next = age + (age === 0 ? Math.min(dt, life * FIRST_FRAME) : dt);
    this.data[o + this.ageOffset] = next;
    if (next < life) return true;
    this.remove(i);
    return false;
  }

  clear(): void {
    this.count = 0;
  }
}

interface SpritePreset {
  life: readonly [number, number];
  size0: number;
  size1: number;
  /** Velocity damping per second. */
  drag: number;
  /** Vertical acceleration (+ rises like smoke, - falls). */
  lift: number;
  color0: THREE.Color;
  color1: THREE.Color;
  alpha: number;
  /** Fraction of the life spent fading in. */
  fadeIn: number;
  tile: number;
  /** Max rotation speed (rad/s). */
  spin: number;
}

const SP = {
  px: 0,
  py: 1,
  pz: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  age: 6,
  life: 7,
  s0: 8,
  s1: 9,
  rot: 10,
  spin: 11,
  drag: 12,
  lift: 13,
  r0: 14,
  g0: 15,
  b0: 16,
  r1: 17,
  g1: 18,
  b1: 19,
  alpha: 20,
  fadeIn: 21,
  tile: 22,
} as const;
const SP_STRIDE = 23;

class SpriteSim extends ParticleStore {
  constructor(capacity: number) {
    super(capacity, SP_STRIDE, SP.age, SP.life);
  }

  /** `delay` (s) postpones the particle; `color` overrides the preset tint. */
  spawn(
    preset: SpritePreset,
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    scale = 1,
    delay = 0,
    color: THREE.Color | null = null,
    alphaMul = 1,
  ): void {
    const o = this.alloc() * SP_STRIDE;
    const d = this.data;
    const size = scale * rand(0.8, 1.2);
    const shade = rand(0.88, 1.08);
    const c0 = color ?? preset.color0;
    const c1 = color ?? preset.color1;
    d[o + SP.px] = pos.x;
    d[o + SP.py] = pos.y;
    d[o + SP.pz] = pos.z;
    d[o + SP.vx] = vel.x;
    d[o + SP.vy] = vel.y;
    d[o + SP.vz] = vel.z;
    d[o + SP.age] = -delay;
    d[o + SP.life] = rand(preset.life[0], preset.life[1]);
    d[o + SP.s0] = preset.size0 * size;
    d[o + SP.s1] = preset.size1 * size;
    d[o + SP.rot] = Math.random() * TAU;
    d[o + SP.spin] = rand(-1, 1) * preset.spin;
    d[o + SP.drag] = preset.drag;
    d[o + SP.lift] = preset.lift;
    d[o + SP.r0] = c0.r * shade;
    d[o + SP.g0] = c0.g * shade;
    d[o + SP.b0] = c0.b * shade;
    d[o + SP.r1] = c1.r * shade;
    d[o + SP.g1] = c1.g * shade;
    d[o + SP.b1] = c1.b * shade;
    d[o + SP.alpha] = preset.alpha * alphaMul;
    d[o + SP.fadeIn] = preset.fadeIn;
    d[o + SP.tile] = preset.tile;
  }

  update(dt: number, batch: SpriteBatch): void {
    const d = this.data;
    let i = 0;
    while (i < this.count) {
      if (!this.advance(i, dt)) continue;
      const o = i++ * SP_STRIDE;
      const age = d[o + SP.age];
      if (age < 0) continue;

      const damp = Math.exp(-d[o + SP.drag] * dt);
      const vx = (d[o + SP.vx] *= damp);
      const vy = (d[o + SP.vy] = (d[o + SP.vy] + d[o + SP.lift] * dt) * damp);
      const vz = (d[o + SP.vz] *= damp);
      const x = (d[o + SP.px] += vx * dt);
      const y = (d[o + SP.py] += vy * dt);
      const z = (d[o + SP.pz] += vz * dt);
      const rot = (d[o + SP.rot] += d[o + SP.spin] * dt);

      const t = age / d[o + SP.life];
      const grow = 1 - (1 - t) * (1 - t);
      const size = d[o + SP.s0] + (d[o + SP.s1] - d[o + SP.s0]) * grow;
      const fadeIn = d[o + SP.fadeIn];
      const alpha =
        d[o + SP.alpha] * (fadeIn > 0 ? Math.min(1, t / fadeIn) : 1) * (1 - t);
      batch.push(
        x,
        y,
        z,
        size,
        rot,
        d[o + SP.tile],
        d[o + SP.r0] + (d[o + SP.r1] - d[o + SP.r0]) * t,
        d[o + SP.g0] + (d[o + SP.g1] - d[o + SP.g0]) * t,
        d[o + SP.b0] + (d[o + SP.b1] - d[o + SP.b0]) * t,
        alpha,
      );
    }
  }
}

const SK = {
  px: 0,
  py: 1,
  pz: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  age: 6,
  life: 7,
  width: 8,
  trail: 9,
  r: 10,
  g: 11,
  b: 12,
  grav: 13,
  drag: 14,
} as const;
const SK_STRIDE = 15;
const SPARK_HOT = hdr(1, 0.78, 0.32, 1.25);
const SPARK_FLOOR = 0.005;

/** Ballistic streaks: sparks, embers, the muzzle flame tongue. They cool from white-hot to `color`. */
class SparkSim extends ParticleStore {
  constructor(capacity: number) {
    super(capacity, SK_STRIDE, SK.age, SK.life);
  }

  /** `trail` = seconds of motion drawn behind the head (streak length = speed x trail). */
  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    life: number,
    width: number,
    trail: number,
    color: THREE.Color,
    gravityScale = 1,
    drag = 1.2,
  ): void {
    const o = this.alloc() * SK_STRIDE;
    const d = this.data;
    d[o + SK.px] = pos.x;
    d[o + SK.py] = pos.y;
    d[o + SK.pz] = pos.z;
    d[o + SK.vx] = vel.x;
    d[o + SK.vy] = vel.y;
    d[o + SK.vz] = vel.z;
    d[o + SK.age] = 0;
    d[o + SK.life] = life;
    d[o + SK.width] = width;
    d[o + SK.trail] = trail;
    d[o + SK.r] = color.r;
    d[o + SK.g] = color.g;
    d[o + SK.b] = color.b;
    d[o + SK.grav] = gravityScale;
    d[o + SK.drag] = drag;
  }

  update(dt: number, gravity: number, batch: StreakBatch): void {
    const d = this.data;
    let i = 0;
    while (i < this.count) {
      if (!this.advance(i, dt)) continue;
      const o = i++ * SK_STRIDE;
      const damp = Math.exp(-d[o + SK.drag] * dt);
      let vx = d[o + SK.vx] * damp;
      let vy = (d[o + SK.vy] - gravity * d[o + SK.grav] * dt) * damp;
      let vz = d[o + SK.vz] * damp;
      const x = (d[o + SK.px] += vx * dt);
      let y = d[o + SK.py] + vy * dt;
      const z = (d[o + SK.pz] += vz * dt);
      if (y < SPARK_FLOOR && vy < 0) {
        y = SPARK_FLOOR;
        vy *= -0.35;
        vx *= 0.6;
        vz *= 0.6;
      }
      d[o + SK.py] = y;
      d[o + SK.vx] = vx;
      d[o + SK.vy] = vy;
      d[o + SK.vz] = vz;

      const t = d[o + SK.age] / d[o + SK.life];
      const heat = Math.max(0, 1 - t * 2.2);
      const trail = d[o + SK.trail];
      batch.push(
        x - vx * trail,
        Math.max(SPARK_FLOOR, y - vy * trail),
        z - vz * trail,
        x,
        y,
        z,
        d[o + SK.width],
        d[o + SK.r] + (SPARK_HOT.r - d[o + SK.r]) * heat,
        d[o + SK.g] + (SPARK_HOT.g - d[o + SK.g]) * heat,
        d[o + SK.b] + (SPARK_HOT.b - d[o + SK.b]) * heat,
        Math.pow(1 - t, 1.2),
      );
    }
  }
}

const TR = {
  fx: 0,
  fy: 1,
  fz: 2,
  dx: 3,
  dy: 4,
  dz: 5,
  dist: 6,
  age: 7,
  life: 8,
} as const;
const TR_STRIDE = 9;
const TRACER_SPEED = 400;
const TRACER_TAIL = 8;
const TRACER_WIDTH = 0.085;
const TRACER_COLOR = hdr(1, 0.7, 0.22, 1.3);

/** Bullet tracers: a bright head racing from muzzle to impact with a fading tail behind it. */
class TracerSim extends ParticleStore {
  constructor(capacity: number) {
    super(capacity, TR_STRIDE, TR.age, TR.life);
  }

  spawn(from: THREE.Vector3, to: THREE.Vector3): void {
    const dist = from.distanceTo(to);
    if (dist < 0.05) return;
    const o = this.alloc() * TR_STRIDE;
    const d = this.data;
    tmpA.subVectors(to, from).divideScalar(dist);
    d[o + TR.fx] = from.x;
    d[o + TR.fy] = from.y;
    d[o + TR.fz] = from.z;
    d[o + TR.dx] = tmpA.x;
    d[o + TR.dy] = tmpA.y;
    d[o + TR.dz] = tmpA.z;
    d[o + TR.dist] = dist;
    // Age starts slightly positive so the head has left the muzzle on the first frame.
    d[o + TR.age] = 1e-4;
    d[o + TR.life] = (dist + TRACER_TAIL) / TRACER_SPEED;
  }

  update(dt: number, batch: StreakBatch): void {
    const d = this.data;
    let i = 0;
    while (i < this.count) {
      if (!this.advance(i, dt)) continue;
      const o = i++ * TR_STRIDE;
      const dist = d[o + TR.dist];
      const travel = d[o + TR.age] * TRACER_SPEED;
      const head = Math.min(travel, dist);
      const tail = Math.max(0, travel - TRACER_TAIL);
      const fx = d[o + TR.fx];
      const fy = d[o + TR.fy];
      const fz = d[o + TR.fz];
      const dx = d[o + TR.dx];
      const dy = d[o + TR.dy];
      const dz = d[o + TR.dz];
      // Fade out once the head has arrived and the tail is catching up.
      const alpha = travel > dist ? 1 - (tail / dist) * 0.6 : 1;
      batch.push(
        fx + dx * tail,
        fy + dy * tail,
        fz + dz * tail,
        fx + dx * head,
        fy + dy * head,
        fz + dz * head,
        TRACER_WIDTH,
        TRACER_COLOR.r,
        TRACER_COLOR.g,
        TRACER_COLOR.b,
        alpha,
      );
    }
  }
}

const DB = {
  px: 0,
  py: 1,
  pz: 2,
  vx: 3,
  vy: 4,
  vz: 5,
  qx: 6,
  qy: 7,
  qz: 8,
  qw: 9,
  wx: 10,
  wy: 11,
  wz: 12,
  sx: 13,
  sy: 14,
  sz: 15,
  age: 16,
  life: 17,
  bounce: 18,
  hits: 19,
  rest: 20,
  yaw: 21,
  r: 22,
  g: 23,
  b: 24,
} as const;
const DB_STRIDE = 25;

interface DebrisOptions {
  capacity: number;
  /** How a resting piece lies: a box flat on its Y face, or a Y-axis cylinder on its side. */
  shape: "box" | "cylinder";
  /** Seconds spent shrinking away at the end of the life. */
  fadeTime: number;
  maxBounces: number;
  castShadow: boolean;
}

/** Small rigid bits (splinters, chips, casings) that tumble, bounce on y = 0 and settle. */
class DebrisPool extends ParticleStore {
  readonly mesh: THREE.InstancedMesh;
  private readonly colors: THREE.InstancedBufferAttribute;

  constructor(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    private readonly opts: DebrisOptions,
  ) {
    super(opts.capacity, DB_STRIDE, DB.age, DB.life);
    this.mesh = new THREE.InstancedMesh(geometry, material, opts.capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.colors = new THREE.InstancedBufferAttribute(
      new Float32Array(opts.capacity * 3).fill(1),
      3,
    );
    this.colors.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = this.colors;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = opts.castShadow;
  }

  spawn(
    pos: THREE.Vector3,
    vel: THREE.Vector3,
    sx: number,
    sy: number,
    sz: number,
    color: THREE.Color,
    life: number,
    bounce: number,
    spin: number,
  ): void {
    const o = this.alloc() * DB_STRIDE;
    const d = this.data;
    tmpQuat.setFromEuler(
      tmpEuler.set(
        Math.random() * TAU,
        Math.random() * TAU,
        Math.random() * TAU,
      ),
    );
    randomUnit(tmpC).multiplyScalar(spin);
    d[o + DB.px] = pos.x;
    d[o + DB.py] = pos.y;
    d[o + DB.pz] = pos.z;
    d[o + DB.vx] = vel.x;
    d[o + DB.vy] = vel.y;
    d[o + DB.vz] = vel.z;
    d[o + DB.qx] = tmpQuat.x;
    d[o + DB.qy] = tmpQuat.y;
    d[o + DB.qz] = tmpQuat.z;
    d[o + DB.qw] = tmpQuat.w;
    d[o + DB.wx] = tmpC.x;
    d[o + DB.wy] = tmpC.y;
    d[o + DB.wz] = tmpC.z;
    d[o + DB.sx] = sx;
    d[o + DB.sy] = sy;
    d[o + DB.sz] = sz;
    d[o + DB.age] = 0;
    d[o + DB.life] = life;
    d[o + DB.bounce] = bounce;
    d[o + DB.hits] = 0;
    d[o + DB.rest] = 0;
    d[o + DB.yaw] = Math.random() * TAU;
    d[o + DB.r] = color.r;
    d[o + DB.g] = color.g;
    d[o + DB.b] = color.b;
  }

  update(dt: number, gravity: number): void {
    const d = this.data;
    const settle = 1 - Math.exp(-14 * dt);
    const friction = Math.exp(-5 * dt);
    let i = 0;
    while (i < this.count) {
      if (!this.advance(i, dt)) continue;
      const o = i * DB_STRIDE;
      tmpQuat.set(d[o + DB.qx], d[o + DB.qy], d[o + DB.qz], d[o + DB.qw]);
      if (d[o + DB.rest] === 0) this.fly(o, dt, gravity);
      else {
        // Resting: slide to a stop and ease into the lying pose.
        d[o + DB.vx] *= friction;
        d[o + DB.vz] *= friction;
        d[o + DB.px] += d[o + DB.vx] * dt;
        d[o + DB.pz] += d[o + DB.vz] * dt;
        this.restPose(o, tmpQuat2);
        tmpQuat.slerp(tmpQuat2, settle);
      }
      d[o + DB.qx] = tmpQuat.x;
      d[o + DB.qy] = tmpQuat.y;
      d[o + DB.qz] = tmpQuat.z;
      d[o + DB.qw] = tmpQuat.w;

      const remaining = d[o + DB.life] - d[o + DB.age];
      const k = Math.min(1, remaining / this.opts.fadeTime);
      tmpA.set(d[o + DB.px], d[o + DB.py], d[o + DB.pz]);
      tmpScale.set(d[o + DB.sx] * k, d[o + DB.sy] * k, d[o + DB.sz] * k);
      this.mesh.setMatrixAt(i, tmpMatrix.compose(tmpA, tmpQuat, tmpScale));
      this.colors.setXYZ(i, d[o + DB.r], d[o + DB.g], d[o + DB.b]);
      i++;
    }
    this.mesh.count = this.count;
    if (this.count > 0) {
      flushAttribute(this.mesh.instanceMatrix, this.count);
      flushAttribute(this.colors, this.count);
    }
  }

  /** Ballistic step with tumbling and floor bounces (reads/writes tmpQuat). */
  private fly(o: number, dt: number, gravity: number): void {
    const d = this.data;
    d[o + DB.vy] -= gravity * dt;
    d[o + DB.px] += d[o + DB.vx] * dt;
    d[o + DB.py] += d[o + DB.vy] * dt;
    d[o + DB.pz] += d[o + DB.vz] * dt;
    tmpQuat.multiply(
      tmpQuat2.setFromEuler(
        tmpEuler.set(d[o + DB.wx] * dt, d[o + DB.wy] * dt, d[o + DB.wz] * dt),
      ),
    );

    const contact = Math.min(d[o + DB.sx], d[o + DB.sy], d[o + DB.sz]) * 0.5;
    if (d[o + DB.py] > contact || d[o + DB.vy] > 0) return;
    const hits = ++d[o + DB.hits];
    if (d[o + DB.vy] > -0.9 || hits >= this.opts.maxBounces) {
      d[o + DB.rest] = 1;
      d[o + DB.py] = this.restHeight(o);
      d[o + DB.vx] *= 0.5;
      d[o + DB.vy] = 0;
      d[o + DB.vz] *= 0.5;
      return;
    }
    d[o + DB.py] = contact;
    d[o + DB.vy] *= -d[o + DB.bounce];
    d[o + DB.vx] *= 0.65;
    d[o + DB.vz] *= 0.65;
    d[o + DB.wx] *= -0.7;
    d[o + DB.wy] *= 0.7;
    d[o + DB.wz] *= -0.7;
  }

  private restHeight(o: number): number {
    const d = this.data;
    return (this.opts.shape === "box" ? d[o + DB.sy] : d[o + DB.sx]) * 0.5;
  }

  private restPose(o: number, out: THREE.Quaternion): THREE.Quaternion {
    out.setFromAxisAngle(UP, this.data[o + DB.yaw]);
    return this.opts.shape === "box" ? out : out.multiply(LIE_FLAT);
  }

  clear(): void {
    super.clear();
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

// ---------------------------------------------------------------------------
// Decals
// ---------------------------------------------------------------------------

interface DecalRing {
  start: number;
  size: number;
  next: number;
}

/**
 * Bullet holes and scorch marks in one InstancedMesh. Each ring is a recycled block of slots.
 * Decals on dynamic props store their transform in the prop's local space and follow it.
 */
class DecalPool {
  readonly mesh: THREE.InstancedMesh<
    THREE.PlaneGeometry,
    THREE.MeshStandardMaterial
  >;
  private readonly tiles: THREE.InstancedBufferAttribute;
  private readonly colors: THREE.InstancedBufferAttribute;
  private readonly targets: (THREE.Object3D | null)[];
  private readonly locals: THREE.Matrix4[];
  private readonly rings: DecalRing[];
  private used = 0;
  private attached = 0;

  constructor(texture: THREE.Texture, ringSizes: number[]) {
    const capacity = ringSizes.reduce((sum, n) => sum + n, 0);
    let start = 0;
    this.rings = ringSizes.map((size) => {
      const ring = { start, size, next: 0 };
      start += size;
      return ring;
    });
    this.targets = new Array<THREE.Object3D | null>(capacity).fill(null);
    this.locals = Array.from({ length: capacity }, () => new THREE.Matrix4());

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.tiles = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 2),
      2,
    );
    geometry.setAttribute("decalTile", this.tiles);

    const material = new THREE.MeshStandardMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      roughness: 0.85,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
    });
    const tileSize = `vec2(${(1 / DECAL_COLS).toFixed(4)}, ${(1 / DECAL_ROWS).toFixed(4)})`;
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          "#include <common>",
          "#include <common>\nattribute vec2 decalTile;",
        )
        .replace(
          "#include <uv_vertex>",
          `#include <uv_vertex>\n\tvMapUv = vMapUv * ${tileSize} + decalTile;`,
        );
    };
    material.customProgramCacheKey = () => "kazz-decal";

    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    // Slots start hidden: a later ring can raise `count` past slots that were never written.
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, ZERO_MATRIX);
    this.colors = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    this.mesh.instanceColor = this.colors;
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.renderOrder = 1;
  }

  add(
    ringIndex: number,
    point: THREE.Vector3,
    normal: THREE.Vector3,
    size: number,
    tile: number,
    color: THREE.Color,
    offset: number,
    attachTo: THREE.Object3D | null,
  ): void {
    const ring = this.rings[ringIndex];
    const slot = ring.start + ring.next;
    ring.next = (ring.next + 1) % ring.size;
    this.kill(slot);

    tmpA.copy(point).addScaledVector(normal, offset);
    tmpQuat
      .setFromUnitVectors(Z_AXIS, normal)
      .multiply(tmpQuat2.setFromAxisAngle(Z_AXIS, Math.random() * TAU));
    tmpScale.set(size, size, 1);
    tmpMatrix.compose(tmpA, tmpQuat, tmpScale);
    if (attachTo) {
      attachTo.updateWorldMatrix(true, false);
      this.locals[slot].copy(attachTo.matrixWorld).invert().multiply(tmpMatrix);
      this.targets[slot] = attachTo;
      this.attached++;
    }

    this.mesh.setMatrixAt(slot, tmpMatrix);
    this.colors.setXYZ(slot, color.r, color.g, color.b);
    this.tiles.setXY(
      slot,
      (tile % DECAL_COLS) / DECAL_COLS,
      Math.floor(tile / DECAL_COLS) / DECAL_ROWS,
    );
    this.used = Math.max(this.used, slot + 1);
    this.mesh.count = this.used;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.colors.needsUpdate = true;
    this.tiles.needsUpdate = true;
  }

  detachFrom(object: THREE.Object3D): void {
    if (this.attached === 0) return;
    for (let i = 0; i < this.used; i++) {
      if (this.targets[i] === object) this.kill(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Re-place decals that ride on moving props. */
  update(): void {
    if (this.attached === 0) return;
    for (let i = 0; i < this.used; i++) {
      const target = this.targets[i];
      if (!target) continue;
      if (!target.parent) {
        this.kill(i);
        continue;
      }
      if (!target.visible) {
        this.mesh.setMatrixAt(i, ZERO_MATRIX);
        continue;
      }
      target.updateWorldMatrix(true, false);
      tmpMatrix.multiplyMatrices(target.matrixWorld, this.locals[i]);
      this.mesh.setMatrixAt(i, tmpMatrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear(): void {
    for (let i = 0; i < this.used; i++) this.mesh.setMatrixAt(i, ZERO_MATRIX);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.targets.fill(null);
    this.attached = 0;
    this.used = 0;
    this.mesh.count = 0;
    for (const ring of this.rings) ring.next = 0;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
    this.mesh.dispose();
  }

  private kill(slot: number): void {
    if (this.targets[slot]) {
      this.targets[slot] = null;
      this.attached--;
    }
    this.mesh.setMatrixAt(slot, ZERO_MATRIX);
  }
}

// ---------------------------------------------------------------------------
// Flash light
// ---------------------------------------------------------------------------

/** One reused point light for muzzle flashes and explosions; a brighter flash wins. */
class FlashLight {
  readonly light = new THREE.PointLight(0xffffff, 0, 8, 2);
  private peak = 0;
  private age = 0;
  private life = 1;

  flash(
    pos: THREE.Vector3,
    color: THREE.Color,
    intensity: number,
    distance: number,
    life: number,
  ): void {
    if (this.current() > intensity) return;
    this.light.position.copy(pos);
    this.light.color.copy(color);
    this.light.distance = distance;
    this.peak = intensity;
    this.life = life;
    this.age = 0;
  }

  update(dt: number): void {
    if (this.peak === 0) return;
    this.age += this.age === 0 ? Math.min(dt, this.life * FIRST_FRAME) : dt;
    const value = this.current();
    this.light.intensity = value;
    if (value === 0) this.peak = 0;
  }

  clear(): void {
    this.peak = 0;
    this.light.intensity = 0;
  }

  private current(): number {
    const t = this.age / this.life;
    return t >= 1 ? 0 : this.peak * (1 - t) * (1 - t);
  }
}

// ---------------------------------------------------------------------------
// Presets and palettes
// ---------------------------------------------------------------------------

const MUZZLE_STAR: SpritePreset = {
  life: [0.045, 0.06],
  size0: 0.6,
  size1: 0.8,
  drag: 0,
  lift: 0,
  color0: hdr(1, 0.8, 0.45, 1.5),
  color1: hdr(1, 0.45, 0.1, 1),
  alpha: 1,
  fadeIn: 0,
  tile: SPRITE_STAR,
  spin: 0,
};
const MUZZLE_GLOW: SpritePreset = {
  life: [0.06, 0.08],
  size0: 1.0,
  size1: 1.2,
  drag: 0,
  lift: 0,
  color0: hdr(1, 0.5, 0.15, 0.8),
  color1: hdr(1, 0.35, 0.08, 0.4),
  alpha: 0.55,
  fadeIn: 0,
  tile: SPRITE_GLOW,
  spin: 0,
};
const IMPACT_FLARE: SpritePreset = {
  life: [0.05, 0.07],
  size0: 0.32,
  size1: 0.45,
  drag: 0,
  lift: 0,
  color0: hdr(1, 0.8, 0.5, 1.4),
  color1: hdr(1, 0.45, 0.15, 0.8),
  alpha: 1,
  fadeIn: 0,
  tile: SPRITE_FLARE,
  spin: 0,
};
const EXPLOSION_CORE: SpritePreset = {
  life: [0.11, 0.15],
  size0: 3.2,
  size1: 5.2,
  drag: 0,
  lift: 0,
  color0: hdr(1, 0.88, 0.65, 1.6),
  color1: hdr(1, 0.5, 0.15, 1),
  alpha: 1,
  fadeIn: 0,
  tile: SPRITE_GLOW,
  spin: 0,
};
const FIREBALL: SpritePreset = {
  life: [0.45, 0.8],
  size0: 0.9,
  size1: 2.6,
  drag: 3.5,
  lift: 2.5,
  color0: hdr(1, 0.62, 0.22, 1.3),
  color1: hdr(0.75, 0.16, 0.02),
  alpha: 0.85,
  fadeIn: 0.04,
  tile: SPRITE_PUFF,
  spin: 2,
};
const FLAME: SpritePreset = {
  life: [0.25, 0.4],
  size0: 0.22,
  size1: 0.45,
  drag: 1,
  lift: 3,
  color0: hdr(1, 0.6, 0.2, 1.2),
  color1: hdr(0.8, 0.2, 0.03),
  alpha: 0.9,
  fadeIn: 0.1,
  tile: SPRITE_PUFF,
  spin: 2,
};
const DUST: SpritePreset = {
  life: [0.5, 1.0],
  size0: 0.14,
  size1: 0.6,
  drag: 4.5,
  lift: 0.2,
  color0: new THREE.Color(0x6a7590),
  color1: new THREE.Color(0x6a7590),
  alpha: 0.55,
  fadeIn: 0.08,
  tile: SPRITE_PUFF,
  spin: 1.5,
};
const MUZZLE_SMOKE: SpritePreset = {
  life: [0.8, 1.3],
  size0: 0.15,
  size1: 0.7,
  drag: 2.5,
  lift: 0.6,
  color0: new THREE.Color(0xc8ccd2),
  color1: new THREE.Color(0x9aa0a8),
  alpha: 0.24,
  fadeIn: 0.1,
  tile: SPRITE_PUFF,
  spin: 1,
};
const SMOKE_COLUMN: SpritePreset = {
  life: [2.2, 3.4],
  size0: 0.9,
  size1: 3.4,
  drag: 1,
  lift: 1.2,
  color0: new THREE.Color(0x1d1b19),
  color1: new THREE.Color(0x55585c),
  alpha: 0.72,
  fadeIn: 0.1,
  tile: SPRITE_PUFF,
  spin: 0.5,
};
const BLOOD_MIST: SpritePreset = {
  life: [0.25, 0.45],
  size0: 0.12,
  size1: 0.42,
  drag: 6,
  lift: -0.6,
  color0: new THREE.Color(0x5a0b08),
  color1: new THREE.Color(0x3a0705),
  alpha: 0.6,
  fadeIn: 0.05,
  tile: SPRITE_PUFF,
  spin: 1.5,
};
const BLAST_DUST: SpritePreset = {
  life: [0.7, 1.2],
  size0: 0.6,
  size1: 2.0,
  drag: 3.2,
  lift: 0.4,
  color0: new THREE.Color(0x6b6f78),
  color1: new THREE.Color(0x50545c),
  alpha: 0.45,
  fadeIn: 0.05,
  tile: SPRITE_PUFF,
  spin: 1,
};

const DUST_COLOR: Record<Surface, THREE.Color> = {
  metal: new THREE.Color(0x8f8177),
  steel: new THREE.Color(0xd2d2d2),
  wood: new THREE.Color(0xa88a62),
  concrete: new THREE.Color(0xc9c6bf),
  plastic: new THREE.Color(0xe0874a),
  rubber: new THREE.Color(0x3c3c3c),
  fabric: new THREE.Color(0xb9a37a),
  flesh: new THREE.Color(0x4a0806),
  ground: new THREE.Color(0x6a7590),
};

const SPARK_COLOR = hdr(1, 0.4, 0.07, 1.25);
const EMBER_COLOR = hdr(1, 0.3, 0.04, 1.2);
const FLAME_TONGUE = hdr(1, 0.6, 0.18, 1.3);
const MUZZLE_LIGHT = new THREE.Color(0xffb35c);
const EXPLOSION_LIGHT = new THREE.Color(0xff9a45);

const WOOD_CHIPS = [0x8a6239, 0xa47a4a, 0x6e4a2a, 0xc09a68].map(
  (c) => new THREE.Color(c),
);
const CONCRETE_CHIPS = [0xbab7af, 0x9c9991, 0xd2cfc8].map(
  (c) => new THREE.Color(c),
);
const PLASTIC_CHIPS = [0xe2681f, 0xf08a3a].map((c) => new THREE.Color(c));
const GROUND_CHIPS = [0x2e3747, 0x3a4456].map((c) => new THREE.Color(c));
const BLAST_DEBRIS = [0x2a2624, 0x3b3330, 0x6b1f1a, 0x1a1817, 0x8a2a1e].map(
  (c) => new THREE.Color(c),
);
const BLOOD_DROPS = [0x4a0705, 0x5e0c08, 0x370504].map(
  (c) => new THREE.Color(c),
);
const BRASS_TINTS = [1, 0.92, 1.06].map((k) => new THREE.Color(k, k, k));
const WHITE = new THREE.Color(1, 1, 1);

interface DecalStyle {
  tile: number;
  size: number;
  color: THREE.Color;
  /** Lift along the normal (curved barrels need a little more). */
  offset: number;
}

/** null = no decal (steel plates swing on hinges, so holes would float). */
const DECAL_STYLE: Record<Surface, DecalStyle | null> = {
  metal: { tile: DECAL_METAL, size: 0.12, color: WHITE, offset: 0.008 },
  steel: null,
  wood: { tile: DECAL_WOOD, size: 0.14, color: WHITE, offset: 0.004 },
  concrete: { tile: DECAL_CONCRETE, size: 0.16, color: WHITE, offset: 0.004 },
  plastic: { tile: DECAL_PLASTIC, size: 0.11, color: WHITE, offset: 0.004 },
  rubber: { tile: DECAL_SMUDGE, size: 0.13, color: WHITE, offset: 0.006 },
  fabric: {
    tile: DECAL_SMUDGE,
    size: 0.15,
    color: new THREE.Color(0x9a8a70),
    offset: 0.006,
  },
  flesh: {
    tile: DECAL_BLOOD,
    size: 0.9,
    color: new THREE.Color(0x3c0604),
    offset: 0.003,
  },
  ground: {
    tile: DECAL_SMUDGE,
    size: 0.18,
    color: new THREE.Color(0xc0c8d8),
    offset: 0.004,
  },
};

// Scorch marks first, then blood pools, so bullet holes are drawn on top of both.
const RING_SCORCH = 0;
const RING_BLOOD = 1;
const RING_HOLES = 2;

type CasingKind = "rifle" | "pistol" | "shell";

/** Casing size: diameter, length (exaggerated ~2x so they read from the top-down camera). */
const CASING_SIZE: Record<CasingKind, readonly [number, number]> = {
  rifle: [0.02, 0.055],
  pistol: [0.022, 0.034],
  shell: [0.042, 0.085],
};

/** Shotgun shell: red hull with a brass base, baked into vertex colours. */
function createShellGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.CylinderGeometry(0.5, 0.5, 1, 8, 4);
  const pos = geometry.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const hull = new THREE.Color(0xb3221a);
  const base = new THREE.Color(0xd8a84a);
  for (let i = 0; i < pos.count; i++) {
    const c = pos.getY(i) < -0.249 ? base : hull;
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return geometry;
}

// ---------------------------------------------------------------------------
// Public facade
// ---------------------------------------------------------------------------

/**
 * Pooled visual effects: muzzle flash, tracers, sparks, dust, splinters, smoke, shell casings,
 * bullet-hole decals, explosions. All methods copy their vector arguments.
 */
export class Effects {
  private readonly root = new THREE.Group();
  private readonly spriteAtlas: THREE.CanvasTexture;
  private readonly decalAtlas: THREE.CanvasTexture;
  private readonly smokeBatch: SpriteBatch;
  private readonly glowBatch: SpriteBatch;
  private readonly streakBatch = new StreakBatch(480, 6);
  private readonly smokeSim = new SpriteSim(420);
  private readonly glowSim = new SpriteSim(260);
  private readonly sparkSim = new SparkSim(400);
  private readonly tracerSim = new TracerSim(64);
  private readonly chips: DebrisPool;
  private readonly casings: DebrisPool;
  private readonly shells: DebrisPool;
  private readonly decals: DecalPool;
  private readonly flashLight = new FlashLight();

  constructor(private readonly ctx: GameContext) {
    this.root.name = "effects";
    this.spriteAtlas = buildAtlas(2, 2, SPRITE_PAINTERS, 7);
    this.decalAtlas = buildAtlas(DECAL_COLS, DECAL_ROWS, DECAL_PAINTERS, 11);

    this.smokeBatch = new SpriteBatch(
      420,
      this.spriteAtlas,
      THREE.NormalBlending,
      5,
    );
    this.glowBatch = new SpriteBatch(
      260,
      this.spriteAtlas,
      THREE.AdditiveBlending,
      7,
    );

    this.chips = new DebrisPool(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.05 }),
      {
        capacity: 220,
        shape: "box",
        fadeTime: 0.4,
        maxBounces: 3,
        castShadow: true,
      },
    );
    this.casings = new DebrisPool(
      new THREE.CylinderGeometry(0.5, 0.5, 1, 7),
      new THREE.MeshStandardMaterial({
        color: 0xd8a84a,
        metalness: 0.55,
        roughness: 0.32,
        emissive: 0x3a2508,
      }),
      {
        capacity: 48,
        shape: "cylinder",
        fadeTime: 0.5,
        maxBounces: 3,
        castShadow: false,
      },
    );
    this.shells = new DebrisPool(
      createShellGeometry(),
      new THREE.MeshStandardMaterial({
        vertexColors: true,
        metalness: 0.25,
        roughness: 0.45,
      }),
      {
        capacity: 24,
        shape: "cylinder",
        fadeTime: 0.5,
        maxBounces: 3,
        castShadow: false,
      },
    );
    this.decals = new DecalPool(this.decalAtlas, [10, 48, 140]);

    this.root.add(
      this.decals.mesh,
      this.chips.mesh,
      this.casings.mesh,
      this.shells.mesh,
      this.smokeBatch.mesh,
      this.streakBatch.mesh,
      this.glowBatch.mesh,
      this.flashLight.light,
    );
    ctx.scene.add(this.root);
  }

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, scale: number): void {
    this.glowSim.spawn(MUZZLE_STAR, pos, ZERO, scale);
    this.glowSim.spawn(MUZZLE_GLOW, pos, ZERO, scale);
    // Short flame tongue jetting forward out of the barrel.
    tmpVel.copy(dir).multiplyScalar(9 * scale);
    this.sparkSim.spawn(
      pos,
      tmpVel,
      0.045,
      0.15 * scale,
      0.045,
      FLAME_TONGUE,
      0,
      0,
    );
    tmpA.copy(pos).addScaledVector(dir, 0.3);
    this.flashLight.flash(tmpA, MUZZLE_LIGHT, 5 * scale * scale, 7, 0.06);
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3): void {
    this.tracerSim.spawn(from, to);
  }

  /** Surface-appropriate impact burst + decal for a bullet hit. dir = bullet direction. */
  impact(hit: HitInfo, dir: THREE.Vector3): void {
    const { point, normal, surface } = hit;
    // Bias debris toward the ricochet direction.
    const reflect = tmpB
      .copy(dir)
      .addScaledVector(normal, -2 * dir.dot(normal))
      .multiplyScalar(0.55)
      .addScaledVector(normal, 0.45)
      .normalize();
    switch (surface) {
      case "metal":
        this.sparks(point, reflect, 12);
        this.glowSim.spawn(IMPACT_FLARE, point, ZERO, 1);
        this.dust(point, normal, 1, DUST_COLOR.metal);
        break;
      case "steel":
        this.sparks(point, reflect, 22);
        this.embers(point, reflect, 4);
        this.glowSim.spawn(IMPACT_FLARE, point, ZERO, 1.8);
        this.dust(point, normal, 1, DUST_COLOR.steel);
        break;
      case "wood":
        this.splinters(point, reflect, 7);
        this.dust(point, normal, 2, DUST_COLOR.wood);
        break;
      case "concrete":
        this.dust(point, normal, 4, DUST_COLOR.concrete);
        this.chipBurst(point, reflect, 4, CONCRETE_CHIPS, 0.025, 0.045);
        this.sparks(point, reflect, 2);
        break;
      case "plastic":
        this.dust(point, normal, 2, DUST_COLOR.plastic);
        this.chipBurst(point, reflect, 3, PLASTIC_CHIPS, 0.02, 0.04);
        break;
      case "rubber":
        this.dust(point, normal, 2, DUST_COLOR.rubber);
        break;
      case "fabric":
        this.dust(point, normal, 4, DUST_COLOR.fabric);
        break;
      case "flesh":
        // Moving bodies: no hole decal, blood() drops occasional pools on the floor instead.
        this.blood(point, dir, 1);
        return;
      case "ground":
        this.dust(point, normal, 3, DUST_COLOR.ground);
        this.chipBurst(point, reflect, 2, GROUND_CHIPS, 0.02, 0.035);
        break;
    }
    const prop = hit.prop;
    this.decal(point, normal, surface, prop?.dynamic ? prop.object : undefined);
  }

  sparks(pos: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      jitterDir(tmpVel, normal, 0.85).multiplyScalar(rand(3, 9));
      this.sparkSim.spawn(
        pos,
        tmpVel,
        rand(0.18, 0.45),
        rand(0.028, 0.045),
        rand(0.018, 0.03),
        SPARK_COLOR,
      );
    }
  }

  dust(
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    count: number,
    color?: THREE.ColorRepresentation,
  ): void {
    const tint =
      color === undefined
        ? DUST_COLOR.ground
        : color instanceof THREE.Color
          ? color
          : tmpColor.set(color);
    tmpA.copy(pos).addScaledVector(normal, 0.06);
    for (let i = 0; i < count; i++) {
      jitterDir(tmpVel, normal, 0.7).multiplyScalar(rand(0.6, 1.8));
      this.smokeSim.spawn(DUST, tmpA, tmpVel, rand(0.8, 1.3), i * 0.02, tint);
    }
  }

  splinters(pos: THREE.Vector3, normal: THREE.Vector3, count: number): void {
    tmpA.copy(pos).addScaledVector(normal, 0.03);
    for (let i = 0; i < count; i++) {
      jitterDir(tmpVel, normal, 0.9).multiplyScalar(rand(2.2, 5));
      tmpVel.y += rand(0.8, 2.4);
      const thick = rand(0.014, 0.028);
      this.chips.spawn(
        tmpA,
        tmpVel,
        rand(0.07, 0.16),
        thick,
        thick * rand(1, 1.7),
        pick(WOOD_CHIPS),
        rand(1.9, 2.5),
        0.35,
        rand(10, 24),
      );
    }
  }

  /**
   * Blood burst at a wound: dark mist plus droplets thrown along `dir` that fall and settle.
   * amount ~1 for a bullet hit, 2-4 for kills/blasts; bigger bursts leave a floor pool.
   */
  blood(pos: THREE.Vector3, dir: THREE.Vector3, amount: number): void {
    const mist = Math.max(1, Math.round(amount * 2));
    for (let i = 0; i < mist; i++) {
      jitterDir(tmpVel, dir, 0.9).multiplyScalar(rand(0.5, 1.6));
      this.smokeSim.spawn(
        BLOOD_MIST,
        pos,
        tmpVel,
        0.8 + amount * 0.15,
        i * 0.015,
      );
    }
    const drops = Math.round(amount * 4);
    for (let i = 0; i < drops; i++) {
      jitterDir(tmpVel, dir, 0.75).multiplyScalar(rand(1.5, 4));
      tmpVel.y += rand(0.3, 1.8);
      const size = rand(0.018, 0.034);
      this.chips.spawn(
        pos,
        tmpVel,
        size,
        size * 0.6,
        size,
        pick(BLOOD_DROPS),
        rand(0.7, 1.2),
        0.05,
        rand(2, 6),
      );
    }
    if (Math.random() < 0.12 + amount * 0.18) {
      const style = DECAL_STYLE.flesh;
      if (!style) return;
      const reach = rand(0.2, 0.7);
      tmpA.set(pos.x + dir.x * reach, 0, pos.z + dir.z * reach);
      this.decals.add(
        RING_BLOOD,
        tmpA,
        UP,
        style.size * rand(0.45, 0.8) * Math.min(1.6, 0.6 + amount * 0.3),
        style.tile,
        tmpColor.copy(style.color).multiplyScalar(rand(0.8, 1.2)),
        style.offset,
        null,
      );
    }
  }

  smoke(pos: THREE.Vector3, dir: THREE.Vector3, amount: number): void {
    const count = Math.max(1, Math.round(amount * 2));
    for (let i = 0; i < count; i++) {
      tmpA.copy(pos).addScaledVector(dir, rand(0.05, 0.25));
      randomUnit(tmpVel)
        .multiplyScalar(0.25)
        .addScaledVector(dir, rand(0.6, 1.6));
      tmpVel.y += rand(0.2, 0.5);
      this.smokeSim.spawn(
        MUZZLE_SMOKE,
        tmpA,
        tmpVel,
        1,
        i * 0.03,
        null,
        amount,
      );
    }
  }

  shellCasing(
    pos: THREE.Vector3,
    velocity: THREE.Vector3,
    kind: "rifle" | "pistol" | "shell",
  ): void {
    const [diameter, length] = CASING_SIZE[kind];
    const pool = kind === "shell" ? this.shells : this.casings;
    pool.spawn(
      pos,
      velocity,
      diameter,
      length,
      diameter,
      kind === "shell" ? WHITE : pick(BRASS_TINTS),
      rand(6, 6.8),
      kind === "shell" ? 0.3 : 0.45,
      rand(14, 28),
    );
  }

  /** Bullet hole. If `attachTo` is given (a dynamic prop's object) the decal follows it. */
  decal(
    point: THREE.Vector3,
    normal: THREE.Vector3,
    surface: Surface,
    attachTo?: THREE.Object3D,
  ): void {
    const style = DECAL_STYLE[surface];
    if (!style) return;
    this.decals.add(
      RING_HOLES,
      point,
      normal,
      style.size * rand(0.85, 1.15),
      style.tile,
      style.color,
      style.offset,
      attachTo ?? null,
    );
  }

  explosion(pos: THREE.Vector3, radius: number): void {
    const k = THREE.MathUtils.clamp(radius / 4, 0.5, 2);
    tmpA.set(pos.x, pos.y + 1.5, pos.z);
    this.flashLight.flash(tmpA, EXPLOSION_LIGHT, 90 * k, 24 * k, 0.45);

    tmpA.set(pos.x, Math.max(pos.y, 0.6), pos.z);
    this.glowSim.spawn(EXPLOSION_CORE, tmpA, ZERO, k);
    for (let i = 0; i < 14; i++) {
      randomUnit(tmpVel);
      tmpVel.y = Math.abs(tmpVel.y) * 0.8 + 0.2;
      tmpB.copy(tmpA).addScaledVector(tmpVel, rand(0.1, 0.5) * k);
      tmpVel.multiplyScalar(rand(2, 6) * k).y += 1.5;
      this.glowSim.spawn(
        FIREBALL,
        tmpB,
        tmpVel,
        k,
        i < 9 ? 0 : rand(0.03, 0.14),
      );
    }
    this.smokeColumn(pos, k);
    this.blastRing(pos, k);
    this.blastSparks(pos, k);

    for (let i = 0; i < 16; i++) {
      randomUnit(tmpVel);
      tmpVel.y = 0;
      tmpVel.normalize().multiplyScalar(rand(3, 7) * k).y = rand(4, 9) * k;
      tmpB.set(pos.x, Math.max(pos.y, 0.4), pos.z);
      const size = rand(0.05, 0.15) * k;
      this.chips.spawn(
        tmpB,
        tmpVel,
        size,
        size * rand(0.3, 0.7),
        size * rand(0.6, 1),
        pick(BLAST_DEBRIS),
        rand(2.6, 3.6),
        0.3,
        rand(6, 16),
      );
    }

    if (pos.y < 2) {
      tmpA.set(pos.x, 0, pos.z);
      this.decals.add(
        RING_SCORCH,
        tmpA,
        UP,
        radius * rand(0.7, 0.85),
        DECAL_SCORCH,
        WHITE,
        0.012,
        null,
      );
    }
  }

  /**
   * Small fire with smoke and embers, e.g. a burning fuse on an explosive barrel. Call every
   * frame while it burns; the spawn rate is frame-rate independent.
   */
  burn(pos: THREE.Vector3, dt: number, intensity = 1): void {
    if (Math.random() < 28 * intensity * dt) {
      randomUnit(tmpVel).multiplyScalar(0.3).y = rand(0.5, 1.2);
      this.glowSim.spawn(FLAME, pos, tmpVel, intensity);
    }
    if (Math.random() < 9 * intensity * dt) {
      randomUnit(tmpVel).multiplyScalar(0.25).y = rand(0.6, 1.1);
      this.smokeSim.spawn(MUZZLE_SMOKE, pos, tmpVel, 1.4, 0, null, 1.6);
    }
    if (Math.random() < 6 * intensity * dt) this.embers(pos, UP, 1);
  }

  /** Remove decals attached to an object that is about to be removed. */
  detachFrom(object: THREE.Object3D): void {
    this.decals.detachFrom(object);
  }

  update(dt: number): void {
    const gravity = this.ctx.tuning.gravity;
    this.smokeBatch.begin();
    this.smokeSim.update(dt, this.smokeBatch);
    this.smokeBatch.end();

    this.glowBatch.begin();
    this.glowSim.update(dt, this.glowBatch);
    this.glowBatch.end();

    this.streakBatch.begin();
    this.sparkSim.update(dt, gravity, this.streakBatch);
    this.tracerSim.update(dt, this.streakBatch);
    this.streakBatch.end();

    this.chips.update(dt, gravity);
    this.casings.update(dt, gravity);
    this.shells.update(dt, gravity);
    this.decals.update();
    this.flashLight.update(dt);
  }

  clear(): void {
    this.smokeSim.clear();
    this.glowSim.clear();
    this.sparkSim.clear();
    this.tracerSim.clear();
    this.chips.clear();
    this.casings.clear();
    this.shells.clear();
    this.decals.clear();
    this.flashLight.clear();
    for (const batch of [this.smokeBatch, this.glowBatch, this.streakBatch]) {
      batch.begin();
      batch.end();
    }
  }

  dispose(): void {
    this.ctx.scene.remove(this.root);
    this.smokeBatch.dispose();
    this.glowBatch.dispose();
    this.streakBatch.dispose();
    this.chips.dispose();
    this.casings.dispose();
    this.shells.dispose();
    this.decals.dispose();
    this.flashLight.light.dispose();
    this.spriteAtlas.dispose();
    this.decalAtlas.dispose();
  }

  private embers(pos: THREE.Vector3, dir: THREE.Vector3, count: number): void {
    for (let i = 0; i < count; i++) {
      jitterDir(tmpVel, dir, 1).multiplyScalar(rand(0.8, 2.5));
      this.sparkSim.spawn(
        pos,
        tmpVel,
        rand(0.9, 1.6),
        rand(0.025, 0.04),
        0.01,
        EMBER_COLOR,
        0.25,
        1.5,
      );
    }
  }

  private chipBurst(
    pos: THREE.Vector3,
    dir: THREE.Vector3,
    count: number,
    palette: readonly THREE.Color[],
    minSize: number,
    maxSize: number,
  ): void {
    for (let i = 0; i < count; i++) {
      jitterDir(tmpVel, dir, 0.9).multiplyScalar(rand(1.5, 4));
      tmpVel.y += rand(0.5, 2);
      const size = rand(minSize, maxSize);
      this.chips.spawn(
        pos,
        tmpVel,
        size,
        size * rand(0.5, 0.9),
        size * rand(0.7, 1.1),
        pick(palette),
        rand(1.2, 1.8),
        0.3,
        rand(8, 18),
      );
    }
  }

  private smokeColumn(pos: THREE.Vector3, k: number): void {
    for (let i = 0; i < 22; i++) {
      randomUnit(tmpVel);
      tmpA.set(
        pos.x + tmpVel.x * 0.6 * k,
        rand(0.5, 1.2),
        pos.z + tmpVel.z * 0.6 * k,
      );
      tmpVel.set(tmpVel.x * 0.8, rand(1.5, 3.2), tmpVel.z * 0.8);
      this.smokeSim.spawn(
        SMOKE_COLUMN,
        tmpA,
        tmpVel,
        k,
        i * 0.05 + rand(0, 0.1),
      );
    }
  }

  private blastRing(pos: THREE.Vector3, k: number): void {
    const n = 14;
    tmpA.set(pos.x, 0.25, pos.z);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU + rand(-0.2, 0.2);
      const speed = rand(6, 9) * k;
      tmpVel.set(Math.cos(a) * speed, 0.2 * speed, Math.sin(a) * speed);
      this.smokeSim.spawn(BLAST_DUST, tmpA, tmpVel, k);
    }
  }

  private blastSparks(pos: THREE.Vector3, k: number): void {
    tmpA.set(pos.x, Math.max(pos.y, 0.5), pos.z);
    for (let i = 0; i < 34; i++) {
      randomUnit(tmpVel);
      tmpVel.y = Math.abs(tmpVel.y) * 0.8 + 0.2;
      tmpVel.multiplyScalar(rand(6, 15) * k);
      this.sparkSim.spawn(
        tmpA,
        tmpVel,
        rand(0.5, 1.1),
        rand(0.03, 0.05),
        0.035,
        SPARK_COLOR,
      );
    }
    this.embers(tmpA, UP, 16);
  }
}
