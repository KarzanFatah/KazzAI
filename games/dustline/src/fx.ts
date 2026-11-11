import * as THREE from "three";
import { rng } from "./noise";
import { SEA_LEVEL, type Terrain } from "./terrain";

const rand = rng(0x5eed);
const range = (a: number, b: number) => a + (b - a) * rand();
const TAU = Math.PI * 2;

/** Light breeze the dust drifts with (m/s). */
const WIND_X = 0.9;
const WIND_Z = -0.5;
/** Direction towards the sun until a DirectionalLight is found in the scene: low, south-west. */
const DEFAULT_SUN = new THREE.Vector3(-0.6, 0.45, 0.65).normalize();

// Particle behaviours.
const PUFF = 0; // drifts towards the wind, rises, stays above the ground
const DROP = 1; // ballistic, dies when it hits the ground or the water
const BOUNCE = 2; // ballistic debris that bounces and settles
const FOAM = 3; // floats on the water surface

/** Settings for the next spawned particle; emitters fill it in before each emit (no allocation). */
const P = {
  life: 1,
  s0: 1, // diameter at birth (m)
  s1: 1, // diameter at death (m)
  alpha: 1,
  hard: 0, // 0 = soft puff, 1 = crisp dot
  grav: 0, // vertical acceleration (m/s²); small positive = buoyant
  drag: 1, // 1/s
  kind: PUFF,
  color: new THREE.Color(),
};

/** Stochastic rounding of rate * dt. */
function emitCount(rate: number, dt: number): number {
  const n = rate * dt;
  const k = Math.floor(n);
  return k + (rand() < n - k ? 1 : 0);
}

/**
 * Time covered by a continuous emitter's call: the gap since it was last called in an earlier
 * frame. Emission stays the same whether the game calls every frame or at a fixed tick rate;
 * calls within one frame (one per wheel) share the gap.
 */
class EmitClock {
  private last = -1;
  private gap = 1 / 60;
  /** True when the previous call was recent, i.e. the emitter is running continuously. */
  continuous = false;

  interval(now: number, frameDt: number): number {
    if (now !== this.last) {
      this.continuous = this.last >= 0 && now - this.last <= 0.1;
      this.gap = this.continuous ? Math.max(now - this.last, frameDt) : frameDt;
      this.last = now;
    }
    return this.gap;
  }
}

const VERT = /* glsl */ `
attribute vec2 aDyn;  // diameter (m), alpha
attribute vec3 aColor;
attribute vec2 aMisc; // hardness, seed
uniform float uScale; // pixels per metre at distance 1
uniform float uMaxSize;
varying vec4 vColor;
varying vec2 vMisc;
#include <fog_pars_vertex>
void main() {
  if (aDyn.y <= 0.0) {
    gl_Position = vec4(0.0, 0.0, -2.0, 1.0); // dead: outside the clip volume
    gl_PointSize = 0.0;
    return;
  }
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  float dist = max(-mvPosition.z, 0.1);
  // Nudge big puffs towards the camera so their sprites don't slice into the ground.
  mvPosition.xyz += normalize(-mvPosition.xyz) * min(aDyn.x * 0.35, 1.5);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min(aDyn.x * uScale / dist, uMaxSize);
  vColor = vec4(aColor, aDyn.y);
  vMisc = aMisc;
  #include <fog_vertex>
}
`;

const FRAG = /* glsl */ `
uniform vec3 uSunView; // towards the sun, view space
uniform float uLit;
varying vec4 vColor;
varying vec2 vMisc;
#include <fog_pars_fragment>
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  p.y = -p.y;
  float r2 = dot(p, p);
  if (r2 >= 1.0) discard;
  float soft = (1.0 - r2) * (1.0 - r2);
  float hard = 1.0 - smoothstep(0.55, 1.0, r2);
  float a = mix(soft, hard, vMisc.x);
  // Lumpy, billowing edge; the per-particle seed varies the pattern.
  float s = vMisc.y;
  float lump = sin(p.x * 4.0 + s) * sin(p.y * 3.5 - s * 1.3) + 0.5 * sin((p.x - p.y) * 6.5 + s * 2.1);
  float soften = 1.0 - vMisc.x;
  a *= clamp(1.0 + lump * 0.55 * soften, 0.0, 1.0);
  // Fake sphere shading: bright on the sun side, cooler in its own shadow.
  vec3 n = vec3(p, sqrt(1.0 - r2));
  float sun = clamp(dot(n, uSunView) * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = vColor.rgb * mix(1.0, mix(0.6, 1.15, sun) * (1.0 + lump * 0.06 * soften), uLit);
  gl_FragColor = vec4(col, a * vColor.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

/**
 * Fixed-size ring of point sprites simulated on the CPU. New particles overwrite the oldest,
 * dead ones are clipped in the vertex shader, so nothing is ever allocated after construction.
 */
class ParticlePool {
  readonly points: THREE.Points;
  readonly uniforms: { [name: string]: THREE.IUniform };
  private next = 0;
  private alive = 0;
  // GPU data.
  private readonly pos: Float32Array;
  private readonly dyn: Float32Array;
  private readonly col: Float32Array;
  private readonly misc: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly dynAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly miscAttr: THREE.BufferAttribute;
  // Simulation data.
  private readonly vel: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly s0: Float32Array;
  private readonly s1: Float32Array;
  private readonly a0: Float32Array;
  private readonly grav: Float32Array;
  private readonly drag: Float32Array;
  private readonly kind: Uint8Array;
  /** Index span spawned since the last update (for partial colour uploads). */
  private spawnLo = -1;
  private spawnHi = -1;
  private readonly viewport = new THREE.Vector4();

  constructor(
    private readonly max: number,
    blending: THREE.Blending,
    lit: boolean,
    sunWorld: THREE.Vector3,
  ) {
    this.pos = new Float32Array(max * 3);
    this.dyn = new Float32Array(max * 2);
    this.col = new Float32Array(max * 3);
    this.misc = new Float32Array(max * 2);
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.life = new Float32Array(max);
    this.s0 = new Float32Array(max);
    this.s1 = new Float32Array(max);
    this.a0 = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.kind = new Uint8Array(max);

    const geo = new THREE.BufferGeometry();
    const attr = (arr: Float32Array, size: number) =>
      new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    this.posAttr = attr(this.pos, 3);
    this.dynAttr = attr(this.dyn, 2);
    this.colAttr = attr(this.col, 3);
    this.miscAttr = attr(this.misc, 2);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aDyn", this.dynAttr);
    geo.setAttribute("aColor", this.colAttr);
    geo.setAttribute("aMisc", this.miscAttr);

    this.uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uScale: { value: 800 },
        uMaxSize: { value: 256 },
        uSunView: { value: new THREE.Vector3(0, 0, 1) },
        uLit: { value: lit ? 1 : 0 },
      },
    ]);
    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending,
      // Additive glow fades to black, so haze would only brighten it.
      fog: lit,
    });

    this.points = new THREE.Points(geo, material);
    this.points.frustumCulled = false;
    this.points.visible = false;
    // Screen-space scale and view-space sun need the renderer and the actual render camera.
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      renderer.getCurrentViewport(this.viewport);
      const h = this.viewport.w;
      this.uniforms.uScale.value = h * 0.5 * camera.projectionMatrix.elements[5];
      this.uniforms.uMaxSize.value = h * 0.3;
      if (lit) {
        const sv = this.uniforms.uSunView.value as THREE.Vector3;
        sv.copy(sunWorld).transformDirection(camera.matrixWorldInverse);
      }
    };
  }

  /** Spawn one particle using the current settings in `P`. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number): void {
    const i = this.next;
    this.next = (i + 1) % this.max;
    if (this.age[i] >= this.life[i]) this.alive++;
    const i2 = i * 2;
    const i3 = i * 3;
    this.pos[i3] = x;
    this.pos[i3 + 1] = y;
    this.pos[i3 + 2] = z;
    this.vel[i3] = vx;
    this.vel[i3 + 1] = vy;
    this.vel[i3 + 2] = vz;
    this.col[i3] = P.color.r;
    this.col[i3 + 1] = P.color.g;
    this.col[i3 + 2] = P.color.b;
    this.misc[i2] = P.hard;
    this.misc[i2 + 1] = rand() * TAU;
    this.age[i] = 0;
    this.life[i] = P.life;
    this.s0[i] = P.s0;
    this.s1[i] = P.s1;
    this.a0[i] = P.alpha;
    this.grav[i] = P.grav;
    this.drag[i] = P.drag;
    this.kind[i] = P.kind;
    if (this.spawnLo < 0) this.spawnLo = this.spawnHi = i;
    else {
      this.spawnLo = Math.min(this.spawnLo, i);
      this.spawnHi = Math.max(this.spawnHi, i);
    }
  }

  update(dt: number, terrain: Terrain): void {
    let died = false;
    const { pos, vel, dyn } = this;
    for (let i = 0; i < this.max; i++) {
      const life = this.life[i];
      if (this.age[i] >= life) continue;
      const age = (this.age[i] += dt);
      const i3 = i * 3;
      if (age >= life) {
        dyn[i * 2] = 0;
        dyn[i * 2 + 1] = 0;
        this.alive--;
        died = true;
        continue;
      }
      const kind = this.kind[i];
      const k = (this.drag[i] * dt) / (1 + this.drag[i] * dt);
      if (kind === PUFF || kind === FOAM) {
        // Relax towards the wind; buoyancy is balanced by drag.
        vel[i3] += (WIND_X - vel[i3]) * k;
        vel[i3 + 1] += this.grav[i] * dt - vel[i3 + 1] * k;
        vel[i3 + 2] += (WIND_Z - vel[i3 + 2]) * k;
      } else {
        vel[i3] -= vel[i3] * k;
        vel[i3 + 1] += this.grav[i] * dt;
        vel[i3 + 2] -= vel[i3 + 2] * k;
      }
      const x = (pos[i3] += vel[i3] * dt);
      let y = (pos[i3 + 1] += vel[i3 + 1] * dt);
      const z = (pos[i3 + 2] += vel[i3 + 2] * dt);

      const t = age / life;
      const u = 1 - t;
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * (1 - u * u);
      const ground = terrain.surfaceHeightAt(x, z);
      if (kind === PUFF) {
        const minY = ground + size * 0.25;
        if (y < minY) {
          pos[i3 + 1] = y = minY;
          if (vel[i3 + 1] < 0) vel[i3 + 1] = 0;
        }
      } else if (kind === FOAM) {
        pos[i3 + 1] = Math.max(ground, SEA_LEVEL + 0.08);
      } else if (y < ground + 0.04 && vel[i3 + 1] < 0) {
        if (kind === DROP) {
          this.age[i] = life; // dies next frame
        } else {
          pos[i3 + 1] = ground + 0.04;
          vel[i3 + 1] *= -0.35;
          vel[i3] *= 0.6;
          vel[i3 + 2] *= 0.6;
        }
      }
      // Soft things fade from the start; solid bits stay opaque until the end.
      const fade = kind === PUFF || kind === FOAM ? u * Math.sqrt(u) : 1 - t * t * t;
      dyn[i * 2] = size;
      dyn[i * 2 + 1] = this.a0[i] * Math.min(1, t * 12) * fade;
    }

    if (this.alive > 0 || died) {
      this.posAttr.needsUpdate = true;
      this.dynAttr.needsUpdate = true;
    }
    if (this.spawnLo >= 0) {
      const n = this.spawnHi - this.spawnLo + 1;
      this.colAttr.addUpdateRange(this.spawnLo * 3, n * 3);
      this.miscAttr.addUpdateRange(this.spawnLo * 2, n * 2);
      this.colAttr.needsUpdate = true;
      this.miscAttr.needsUpdate = true;
      this.spawnLo = this.spawnHi = -1;
    }
    this.points.visible = this.alive > 0;
  }

  clear(): void {
    this.age.fill(0);
    this.life.fill(0);
    this.dyn.fill(0);
    this.alive = 0;
    this.dynAttr.needsUpdate = true;
    this.points.visible = false;
  }
}

/**
 * Pooled particle effects: wheel dust, landing bursts, impact debris, water splashes, boost puffs.
 * Two draw calls: soft sun-lit dust/smoke/spray (normal blending) and additive glow (flames).
 */
export class Effects {
  private readonly sunWorld = DEFAULT_SUN.clone();
  private readonly dustPool = new ParticlePool(1500, THREE.NormalBlending, true, this.sunWorld);
  private readonly glowPool = new ParticlePool(300, THREE.AdditiveBlending, false, this.sunWorld);
  private sun: THREE.DirectionalLight | null = null;
  private sunSearchIn = 0;
  private dt = 1 / 60;
  private now = 0;
  private readonly dustClock = new EmitClock();
  private readonly splashClock = new EmitClock();
  private readonly boostClock = new EmitClock();
  private readonly boostLast = new THREE.Vector3();

  private readonly dustA = new THREE.Color(0xe2c79a);
  private readonly dustB = new THREE.Color(0xc9a575);
  private readonly debrisCols = [0x5b4632, 0x3f342a, 0x6e5c44].map((c) => new THREE.Color(c));
  private readonly sprayCols = [0xffffff, 0xd8f7f1, 0x9fe5da].map((c) => new THREE.Color(c));
  private readonly foamCol = new THREE.Color(0xf2faf6);
  private readonly smokeCol = new THREE.Color(0x4f463d);
  private readonly flameCore = new THREE.Color(0x4f9dff);
  private readonly flameA = new THREE.Color(0xff8a2a);
  private readonly flameB = new THREE.Color(0xffc45c);
  private readonly sparkCol = new THREE.Color(0xffd27a);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: Terrain,
  ) {
    this.dustPool.points.renderOrder = 2;
    this.glowPool.points.renderOrder = 3;
    this.dustPool.points.name = "fx-dust";
    this.glowPool.points.name = "fx-glow";
    scene.add(this.dustPool.points, this.glowPool.points);
  }

  /** Sand puff colour with a little variation. */
  private sandColor(): void {
    P.color.copy(this.dustA).lerp(this.dustB, rand());
  }

  /** Dust kicked up at a wheel contact point. vel = car velocity; amount 0..1 (speed + slip). */
  dust(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    if (amount <= 0.02) return;
    const a = Math.min(amount, 1);
    const gap = this.dustClock.interval(this.now, this.dt);
    // Spread spawns back along the path driven since the last call, so the plume is continuous.
    const back = this.dustClock.continuous ? gap : 0;
    const n = emitCount(6 + 50 * a * a, gap);
    const spread = 0.4 + 1.1 * a;
    for (let i = 0; i < n; i++) {
      const u = rand() * back;
      this.sandColor();
      P.kind = PUFF;
      P.life = 1.2 + rand() * (0.5 + 0.8 * a);
      P.s0 = (0.5 + 1.1 * a) * range(0.8, 1.2);
      P.s1 = (1.6 + 4.6 * a) * range(0.7, 1.3);
      P.alpha = 0.2 + 0.4 * a;
      P.hard = 0;
      P.grav = 0.5;
      P.drag = range(1.3, 2.1);
      this.dustPool.emit(
        pos.x - vel.x * u + range(-0.25, 0.25),
        pos.y + 0.15,
        pos.z - vel.z * u + range(-0.25, 0.25),
        vel.x * 0.3 + range(-spread, spread),
        range(0.3, 0.5 + 1.2 * a),
        vel.z * 0.3 + range(-spread, spread),
      );
    }
  }

  /** Big ring of sand when the car lands. strength 0..1. */
  landing(pos: THREE.Vector3, strength: number): void {
    const s = Math.min(Math.max(strength, 0), 1);
    const n = Math.round(14 + 30 * s);
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU + rand() * 0.3;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      const speed = (3 + 6 * s) * range(0.7, 1.2);
      this.sandColor();
      P.kind = PUFF;
      P.life = range(1.4, 2.3);
      P.s0 = 1.0 + s;
      P.s1 = (3.5 + 4 * s) * range(0.8, 1.2);
      P.alpha = 0.3 + 0.3 * s;
      P.hard = 0;
      P.grav = 0.4;
      P.drag = 2.2;
      this.dustPool.emit(
        pos.x + dx * 0.9,
        pos.y + 0.2,
        pos.z + dz * 0.9,
        dx * speed,
        range(0.3, 1.5),
        dz * speed,
      );
    }
    // A few slow puffs in the middle so the ring isn't hollow.
    for (let i = 0; i < 6; i++) {
      this.sandColor();
      P.life = range(1.2, 1.8);
      P.s0 = 1.5;
      P.s1 = 4 + 2 * s;
      P.alpha = 0.25 + 0.2 * s;
      P.drag = 1.5;
      this.dustPool.emit(pos.x, pos.y + 0.3, pos.z, range(-1, 1), range(0.8, 2), range(-1, 1));
    }
  }

  /** Collision burst (sand + small debris). */
  impact(pos: THREE.Vector3, strength: number): void {
    const s = Math.min(Math.max(strength, 0), 1);
    const puffs = Math.round(8 + 20 * s);
    for (let i = 0; i < puffs; i++) {
      const ang = rand() * TAU;
      const speed = (1.5 + 4.5 * s) * rand();
      this.sandColor();
      P.kind = PUFF;
      P.life = range(1.0, 1.8);
      P.s0 = 0.8 + 0.6 * s;
      P.s1 = (2.5 + 3 * s) * range(0.8, 1.2);
      P.alpha = 0.3 + 0.3 * s;
      P.hard = 0;
      P.grav = 0.6;
      P.drag = 2.4;
      this.dustPool.emit(
        pos.x,
        pos.y + 0.3,
        pos.z,
        Math.sin(ang) * speed,
        range(0.5, 2.5),
        Math.cos(ang) * speed,
      );
    }
    const bits = Math.round(4 + 10 * s);
    for (let i = 0; i < bits; i++) {
      const ang = rand() * TAU;
      const speed = range(2, 4 + 4 * s);
      P.color.copy(this.debrisCols[i % this.debrisCols.length]);
      P.kind = BOUNCE;
      P.life = range(1.2, 2.0);
      P.s0 = P.s1 = range(0.1, 0.22);
      P.alpha = 1;
      P.hard = 1;
      P.grav = -14;
      P.drag = 0.3;
      this.dustPool.emit(
        pos.x,
        pos.y + 0.4,
        pos.z,
        Math.sin(ang) * speed,
        range(3, 6 + 3 * s),
        Math.cos(ang) * speed,
      );
    }
  }

  /** Water spray when driving through the shallows. */
  splash(pos: THREE.Vector3, vel: THREE.Vector3, amount: number): void {
    if (amount <= 0.02) return;
    const a = Math.min(amount, 1);
    const dt = this.splashClock.interval(this.now, this.dt);
    const back = this.splashClock.continuous ? dt : 0;
    const drops = emitCount(30 + 110 * a, dt);
    for (let i = 0; i < drops; i++) {
      const u = rand() * back;
      P.color.copy(this.sprayCols[i % this.sprayCols.length]);
      P.kind = DROP;
      P.life = 1.5;
      P.s0 = P.s1 = range(0.12, 0.3);
      P.alpha = 0.9;
      P.hard = 0.7;
      P.grav = -9.8;
      P.drag = 0.4;
      this.dustPool.emit(
        pos.x - vel.x * u + range(-0.3, 0.3),
        pos.y + 0.1,
        pos.z - vel.z * u + range(-0.3, 0.3),
        vel.x * 0.35 + range(-2.5, 2.5),
        range(1.5, 2 + 4 * a),
        vel.z * 0.35 + range(-2.5, 2.5),
      );
    }
    const foam = emitCount(6 + 18 * a, dt);
    for (let i = 0; i < foam; i++) {
      const u = rand() * back;
      P.color.copy(this.foamCol);
      P.kind = FOAM;
      P.life = range(1.0, 1.6);
      P.s0 = 0.6;
      P.s1 = (2 + 1.5 * a) * range(0.8, 1.2);
      P.alpha = 0.55;
      P.hard = 0.2;
      P.grav = 0;
      P.drag = 2.5;
      this.dustPool.emit(
        pos.x - vel.x * u + range(-0.4, 0.4),
        SEA_LEVEL + 0.08,
        pos.z - vel.z * u + range(-0.4, 0.4),
        vel.x * 0.15,
        0,
        vel.z * 0.15,
      );
    }
  }

  /** Exhaust flame/puff while boosting. dir = backwards unit vector. */
  boostPuff(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const dt = this.boostClock.interval(this.now, this.dt);
    const last = this.boostLast;
    if (!this.boostClock.continuous || last.distanceToSquared(pos) > 16) last.copy(pos);
    // Exhaust velocity from successive calls: flames ride along with the car as a short jet.
    const cvx = (pos.x - last.x) / dt;
    const cvy = (pos.y - last.y) / dt;
    const cvz = (pos.z - last.z) / dt;
    const flames = emitCount(120, dt);
    for (let i = 0; i < flames; i++) {
      const core = i % 3 === 0;
      const u = rand() * 0.4;
      P.color.copy(core ? this.flameCore : rand() < 0.5 ? this.flameA : this.flameB);
      P.kind = PUFF;
      P.life = core ? range(0.06, 0.1) : range(0.1, 0.2);
      P.s0 = core ? 0.35 : 0.6;
      P.s1 = 0.12;
      P.alpha = core ? 1 : 0.85;
      P.hard = 0.3;
      P.grav = 0;
      P.drag = 0.5;
      const speed = range(5, 8);
      this.glowPool.emit(
        pos.x + dir.x * u,
        pos.y + dir.y * u,
        pos.z + dir.z * u,
        cvx + dir.x * speed + range(-0.6, 0.6),
        cvy + dir.y * speed + range(-0.2, 0.5),
        cvz + dir.z * speed + range(-0.6, 0.6),
      );
    }
    // Smoke is left behind: spawned along the path driven since the previous call.
    const smoke = emitCount(30, dt);
    for (let i = 0; i < smoke; i++) {
      const u = rand();
      P.color.copy(this.smokeCol);
      P.kind = PUFF;
      P.life = range(0.6, 1.0);
      P.s0 = 0.4;
      P.s1 = range(1.4, 2.2);
      P.alpha = 0.2;
      P.hard = 0;
      P.grav = 0.6;
      P.drag = 1.8;
      this.dustPool.emit(
        pos.x + (last.x - pos.x) * u + dir.x * 0.5,
        pos.y + (last.y - pos.y) * u + dir.y * 0.5,
        pos.z + (last.z - pos.z) * u + dir.z * 0.5,
        dir.x * 3 + range(-0.5, 0.5),
        range(0.3, 0.9),
        dir.z * 3 + range(-0.5, 0.5),
      );
    }
    last.copy(pos);
  }

  /** Burst of golden sparkles (e.g. checkpoint or lap feedback). */
  sparkles(pos: THREE.Vector3, count = 24): void {
    for (let i = 0; i < count; i++) {
      const ang = rand() * TAU;
      const speed = range(2, 6);
      P.color.copy(this.sparkCol);
      P.kind = DROP;
      P.life = range(0.5, 0.9);
      P.s0 = 0.35;
      P.s1 = 0.1;
      P.alpha = 1;
      P.hard = 0.8;
      P.grav = -6;
      P.drag = 1.2;
      this.glowPool.emit(
        pos.x,
        pos.y,
        pos.z,
        Math.sin(ang) * speed,
        range(2, 6),
        Math.cos(ang) * speed,
      );
    }
  }

  update(dt: number, _camera: THREE.Camera): void {
    this.dt = Math.min(Math.max(dt, 0), 0.1);
    this.now += this.dt;
    this.trackSun();
    this.dustPool.update(this.dt, this.terrain);
    this.glowPool.update(this.dt, this.terrain);
  }

  clear(): void {
    this.dustPool.clear();
    this.glowPool.clear();
  }

  /** Follow the scene's sun so dust is lit from the same side as everything else. */
  private trackSun(): void {
    if (!this.sun && --this.sunSearchIn <= 0) {
      this.sunSearchIn = 60;
      this.scene.traverse((o) => {
        if (!this.sun && (o as THREE.DirectionalLight).isDirectionalLight) {
          this.sun = o as THREE.DirectionalLight;
        }
      });
    }
    if (this.sun) {
      this.sunWorld.subVectors(this.sun.position, this.sun.target.position);
      if (this.sunWorld.lengthSq() > 1e-6) this.sunWorld.normalize();
      else this.sunWorld.copy(DEFAULT_SUN);
    }
  }
}

const TRACK_SEGMENTS = 400; // per wheel
const TRACK_WIDTH = 0.32;
const TRACK_STEP = 0.35; // metres between committed points
const TRACK_FADE = 25; // seconds
const TRACK_LIFT = 0.03; // metres along the normal

const TRACK_VERT = /* glsl */ `
attribute vec4 aTrack; // across (-1..1), along (m), birth time, intensity
uniform float uTime;
uniform float uFade;
varying vec3 vTrack;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float age = uTime - aTrack.z;
  float fade = 1.0 - smoothstep(uFade * 0.3, uFade, age);
  vTrack = vec3(aTrack.x, aTrack.y, aTrack.w * fade);
  #include <fog_vertex>
}
`;

// Output is a display-space multiplier (multiply blending), so it darkens sun and shade alike.
const TRACK_FRAG = /* glsl */ `
uniform vec3 uTint;
varying vec3 vTrack;
#include <fog_pars_fragment>
void main() {
  float body = 1.0 - smoothstep(0.55, 1.0, abs(vTrack.x));
  float treadPhase = vTrack.y * 3.0 + step(0.0, vTrack.x) * 0.5;
  float tread = 0.8 + 0.2 * step(0.5, fract(treadPhase));
  tread = mix(tread, 0.9, smoothstep(0.15, 0.4, fwidth(treadPhase)));
  vec3 col = mix(vec3(1.0), uTint, clamp(vTrack.z, 0.0, 1.0) * body * tread);
  #ifdef USE_FOG
    #ifdef FOG_EXP2
      float fogFactor = 1.0 - exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);
    #else
      float fogFactor = smoothstep(fogNear, fogFar, vFogDepth);
    #endif
    col = mix(col, vec3(1.0), fogFactor);
  #endif
  gl_FragColor = vec4(col, 1.0);
}
`;

interface Trail {
  active: boolean;
  /** Ring index of the segment currently being stretched. */
  head: number;
  headWritten: boolean;
  // Last committed point.
  x: number;
  z: number;
  sx: number;
  sz: number;
  nx: number;
  ny: number;
  nz: number;
  along: number;
  intensity: number;
  birth: number;
}

/** Tyre tracks pressed into the sand (ring buffer of quads per wheel, fading over time). */
export class TireTracks {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly data: Float32Array;
  private readonly posAttr: THREE.BufferAttribute;
  private readonly dataAttr: THREE.BufferAttribute;
  private readonly trails: Trail[] = [];
  private readonly time = { value: 0 };

  constructor(
    scene: THREE.Scene,
    private readonly terrain: Terrain,
    wheels = 4,
  ) {
    const quads = wheels * TRACK_SEGMENTS;
    this.pos = new Float32Array(quads * 4 * 3);
    this.data = new Float32Array(quads * 4 * 4);
    const index = new Uint16Array(quads * 6);
    for (let q = 0; q < quads; q++) {
      const v = q * 4;
      index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], q * 6);
    }
    for (let w = 0; w < wheels; w++) {
      this.trails.push({
        active: false,
        head: 0,
        headWritten: false,
        x: 0,
        z: 0,
        sx: 1,
        sz: 0,
        nx: 0,
        ny: 1,
        nz: 0,
        along: 0,
        intensity: 0,
        birth: 0,
      });
    }

    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.dataAttr = new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("aTrack", this.dataAttr);
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.resetData();

    const material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        { uFade: { value: TRACK_FADE }, uTint: { value: new THREE.Vector3(0.8, 0.71, 0.6) } },
      ]),
      vertexShader: TRACK_VERT,
      fragmentShader: TRACK_FRAG,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.DstColorFactor,
      blendDst: THREE.ZeroFactor,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      fog: true,
    });
    material.uniforms.uTime = this.time;
    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -2; // before the sea and the dust
    this.mesh.name = "tire-tracks";
    scene.add(this.mesh);
  }

  /** Extend wheel `wheel`'s trail. side = unit lateral vector, intensity 0..1 (slip/load). */
  add(
    wheel: number,
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    side: THREE.Vector3,
    intensity: number,
  ): void {
    const tr = this.trails[wheel];
    if (!tr) return;
    const sl = Math.hypot(side.x, side.z) || 1;
    const sx = side.x / sl;
    const sz = side.z / sl;
    const k = Math.min(Math.max(intensity, 0), 1);
    const now = this.time.value;
    if (tr.active) {
      const d = Math.hypot(pos.x - tr.x, pos.z - tr.z);
      if (d > 4) this.cut(wheel); // teleported (respawn)
      else {
        if (d < 0.02) return;
        this.writeSegment(wheel, tr, pos.x, pos.z, sx, sz, normal, tr.along + d, k, now);
        tr.headWritten = true;
        if (d <= TRACK_STEP) return;
        tr.head = (tr.head + 1) % TRACK_SEGMENTS;
        tr.headWritten = false;
        tr.along += d;
      }
    }
    if (!tr.active) {
      tr.active = true;
      tr.along = 0;
    }
    tr.x = pos.x;
    tr.z = pos.z;
    tr.sx = sx;
    tr.sz = sz;
    tr.nx = normal.x;
    tr.ny = normal.y;
    tr.nz = normal.z;
    tr.intensity = k;
    tr.birth = now;
  }

  /** Break the trail (wheel left the ground). */
  cut(wheel: number): void {
    const tr = this.trails[wheel];
    if (!tr) return;
    if (tr.headWritten) tr.head = (tr.head + 1) % TRACK_SEGMENTS;
    tr.headWritten = false;
    tr.active = false;
  }

  update(dt: number): void {
    this.time.value += dt;
  }

  clear(): void {
    for (const tr of this.trails) {
      tr.active = false;
      tr.headWritten = false;
      tr.head = 0;
    }
    this.resetData();
  }

  private resetData(): void {
    this.pos.fill(0);
    // Intensity 0 and an ancient birth time: invisible until written.
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = 0;
      this.data[i + 1] = 0;
      this.data[i + 2] = -1e6;
      this.data[i + 3] = 0;
    }
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }

  /** Quad from the trail's committed point to (x, z); corners hug the terrain. */
  private writeSegment(
    wheel: number,
    tr: Trail,
    x: number,
    z: number,
    sx: number,
    sz: number,
    n: THREE.Vector3,
    along: number,
    intensity: number,
    now: number,
  ): void {
    const v0 = (wheel * TRACK_SEGMENTS + tr.head) * 4;
    const hw = TRACK_WIDTH * 0.5;
    this.corner(v0, tr.x - tr.sx * hw, tr.z - tr.sz * hw, tr.nx, tr.ny, tr.nz);
    this.corner(v0 + 1, tr.x + tr.sx * hw, tr.z + tr.sz * hw, tr.nx, tr.ny, tr.nz);
    this.corner(v0 + 2, x - sx * hw, z - sz * hw, n.x, n.y, n.z);
    this.corner(v0 + 3, x + sx * hw, z + sz * hw, n.x, n.y, n.z);
    this.vertexData(v0, -1, tr.along, tr.birth, tr.intensity);
    this.vertexData(v0 + 1, 1, tr.along, tr.birth, tr.intensity);
    this.vertexData(v0 + 2, -1, along, now, intensity);
    this.vertexData(v0 + 3, 1, along, now, intensity);
    this.posAttr.addUpdateRange(v0 * 3, 12);
    this.dataAttr.addUpdateRange(v0 * 4, 16);
    this.posAttr.needsUpdate = true;
    this.dataAttr.needsUpdate = true;
  }

  private vertexData(v: number, across: number, along: number, birth: number, k: number): void {
    const o = v * 4;
    this.data[o] = across;
    this.data[o + 1] = along;
    this.data[o + 2] = birth;
    this.data[o + 3] = k;
  }

  private corner(v: number, x: number, z: number, nx: number, ny: number, nz: number): void {
    const o = v * 3;
    this.pos[o] = x + nx * TRACK_LIFT;
    this.pos[o + 1] = this.terrain.heightAt(x, z) + ny * TRACK_LIFT;
    this.pos[o + 2] = z + nz * TRACK_LIFT;
  }
}
