import * as THREE from "three";
import { clamp, smoothstep } from "./noise";
import { HALF_WORLD, SEA_LEVEL, type Terrain } from "./terrain";

const SHALLOW = 0x5fd3c4;
const DEEP = 0x1f6f86;
const FOAM = 0xf4fbf8;
/** Depth (m) used for everything beyond the terrain; colour saturates well before this. */
const MAX_DEPTH = 14;
/** Beach slope used to continue the coastline outside the terrain. */
const OUTSIDE_SLOPE = 0.07;
const HORIZON = 4000;

/**
 * Grid line coordinates from `from`, then for each [to, step] pair up to `to` with roughly
 * `step` spacing. Lets the mesh be fine near the beach and very coarse towards the horizon.
 */
function axis(from: number, spans: [number, number][]): number[] {
  const out = [from];
  let at = from;
  for (const [to, step] of spans) {
    const n = Math.max(1, Math.round((to - at) / step));
    for (let i = 1; i <= n; i++) out.push(at + ((to - at) * i) / n);
    at = to;
  }
  return out;
}

/** Water depth at (x, z); outside the terrain the coast is extrapolated and falls off to deep. */
function depthAt(terrain: Terrain, x: number, z: number): number {
  const outside = clamp((terrain.shorelineZ(x) - z) * OUTSIDE_SLOPE, -3, MAX_DEPTH);
  const w = smoothstep(HALF_WORLD - 30, HALF_WORLD, Math.max(Math.abs(x), -z));
  if (w >= 1) return outside;
  const inside = clamp(SEA_LEVEL - terrain.heightAt(x, z), -3, MAX_DEPTH);
  return inside + (outside - inside) * w;
}

const VERT_PARS = /* glsl */ `
attribute float aDepth;
uniform float uTime;
varying float vDepth;
varying float vWave;
varying vec2 vXZ;
void addWave(inout vec3 w, vec2 p, vec2 dir, float k, float speed, float amp) {
  float ph = dot(p, dir) * k - uTime * speed;
  w += amp * vec3(sin(ph), k * dir.x * cos(ph), k * dir.y * cos(ph));
}
// Swells rolling towards the beach (+z). Returns height, d/dx, d/dz.
vec3 seaWave(vec2 p) {
  vec3 w = vec3(0.0);
  addWave(w, p, vec2(0.10, 0.995), 0.21, 1.25, 0.16);
  addWave(w, p, vec2(-0.35, 0.937), 0.33, 1.6, 0.09);
  addWave(w, p, vec2(0.55, 0.835), 0.57, 2.1, 0.05);
  return w;
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uDeep;
uniform vec3 uFoam;
varying float vDepth;
varying float vWave;
varying vec2 vXZ;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// Short-lived white wave crests scattered on a jittered grid (one per cell), stretched along x.
float crests(vec2 p, float cell, float speed, float px) {
  vec2 g = p / cell;
  vec2 id = floor(g);
  vec2 h = hash22(id);
  vec2 d = fract(g) - 0.5 - (h - 0.5) * 0.7;
  d.y *= 2.2;
  float life = fract(uTime * speed * (0.7 + 0.6 * h.x) + h.y * 7.0);
  float pulse = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.2, 0.45, life));
  float r = 0.07 + 0.07 * h.x;
  float aa = px / cell;
  float dotMask = 1.0 - smoothstep(r - aa, r + aa, length(d));
  // Fade out once a crest gets smaller than a couple of pixels (avoids shimmer far away).
  return dotMask * pulse * (1.0 - smoothstep(0.06, 0.16, aa));
}
`;

const FRAG_COLOR = /* glsl */ `
  float localDepth = vDepth + vWave;
  float px = length(fwidth(vXZ));
  // Body colour: turquoise shallows to deep teal-blue, with slow drifting patches.
  float patchN = vnoise(vXZ * 0.03 + vec2(uTime * 0.012, 0.0)) - 0.5;
  vec3 water = mix(uShallow, uDeep, smoothstep(0.3, 7.5, vDepth + patchN * 2.0));
  // Foam bands rolling in towards the beach, broken up into lace.
  float lace = vnoise(vXZ * vec2(0.09, 0.22) + vec2(uTime * 0.04, -uTime * 0.12));
  float lace2 = vnoise(vXZ * 0.35 + vec2(-uTime * 0.1, uTime * 0.2));
  float f = fract(vDepth * 2.4 + uTime * 0.3 + lace * 0.6);
  float band = smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.1, 0.4, f));
  float foam = band * (1.0 - smoothstep(0.25, 0.7, vDepth)) * smoothstep(0.3, 0.65, lace2 + lace * 0.3);
  // Patches of spent foam drifting in the shallows.
  foam = max(foam, smoothstep(0.62, 0.78, lace2 * 0.7 + lace * 0.45) * (1.0 - smoothstep(0.1, 0.45, vDepth)) * 0.8);
  // Swash line where the water meets the sand, sliding in and out with the swell.
  foam = max(foam, (1.0 - smoothstep(0.02, 0.1 + 0.08 * lace2, localDepth)) * 0.95);
  // Scattered crests in open water.
  float caps = crests(vXZ, 2.6, 0.18, px) + crests(vXZ + 17.3, 4.3, 0.12, px);
  caps *= smoothstep(1.0, 3.0, vDepth) * (1.0 + 0.8 * patchN);
  vec3 col = mix(water, uFoam, clamp(foam + caps, 0.0, 1.0));
  // See-through at the very edge so the wet sand shows; opaque out at sea.
  float alpha = mix(0.45, 1.0, smoothstep(0.0, 1.6, localDepth));
  alpha = max(alpha, foam) * smoothstep(-0.04, 0.02, localDepth);
  diffuseColor = vec4(col, alpha);
`;

/**
 * Animated sea along the -Z edge: turquoise shallows to deep teal, foam lines at the shore,
 * sparkles. Lambert-lit (sun, hemisphere, shadows, fog) with the look injected via onBeforeCompile.
 */
export class Sea {
  readonly mesh: THREE.Mesh;
  private readonly time = { value: 0 };

  constructor(scene: THREE.Scene, terrain: Terrain) {
    const near = HALF_WORLD + 200;
    const far = -HALF_WORLD - 300;
    const xs = axis(-HORIZON, [
      [-2000, 2000],
      [-1000, 1000],
      [-near, 540],
      [-HALF_WORLD - 20, 10],
      [HALF_WORLD + 20, 4],
      [near, 10],
      [1000, 540],
      [2000, 1000],
      [HORIZON, 2000],
    ]);
    // Inland edge just past the wavy coastline (shorelineZ ranges over about -168..-132).
    const zs = axis(-HORIZON, [
      [-2000, 2000],
      [-1000, 1000],
      [far, 440],
      [-300, 13],
      [-200, 8],
      [-105, 4],
    ]);

    const nx = xs.length;
    const nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    const depth = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const v = j * nx + i;
        pos[v * 3] = xs[i];
        pos[v * 3 + 1] = SEA_LEVEL;
        pos[v * 3 + 2] = zs[j];
        depth[v] = depthAt(terrain, xs[i], zs[j]);
      }
    }
    const index = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let o = 0;
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i;
        const b = a + 1;
        const c = a + nx;
        const d = c + 1;
        // Counter-clockwise seen from above (+Y).
        index[o++] = a;
        index[o++] = c;
        index[o++] = b;
        index[o++] = b;
        index[o++] = c;
        index[o++] = d;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aDepth", new THREE.BufferAttribute(depth, 1));
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    geo.computeBoundingSphere();

    const material = new THREE.MeshLambertMaterial({ transparent: true });
    const uniforms = {
      uTime: this.time,
      uShallow: { value: new THREE.Color(SHALLOW) },
      uDeep: { value: new THREE.Color(DEEP) },
      uFoam: { value: new THREE.Color(FOAM) },
    };
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = (VERT_PARS + shader.vertexShader)
        .replace(
          "#include <beginnormal_vertex>",
          /* glsl */ `
          float seaAmp = 0.45 + 0.55 * smoothstep(0.0, 4.0, aDepth);
          vec3 sw = seaWave(position.xz) * seaAmp;
          vec3 objectNormal = normalize(vec3(-sw.y, 1.0, -sw.z));`,
        )
        .replace(
          "#include <begin_vertex>",
          /* glsl */ `
          vec3 transformed = vec3(position.x, position.y + sw.x, position.z);
          vDepth = aDepth;
          vWave = sw.x;
          vXZ = position.xz;`,
        );
      shader.fragmentShader = (FRAG_PARS + shader.fragmentShader).replace(
        "#include <color_fragment>",
        FRAG_COLOR,
      );
    };

    this.mesh = new THREE.Mesh(geo, material);
    this.mesh.receiveShadow = true;
    // First among transparent things: tyre tracks underneath, dust and spray on top.
    this.mesh.renderOrder = -1;
    this.mesh.name = "sea";
    scene.add(this.mesh);
  }

  update(time: number): void {
    this.time.value = time;
  }
}
