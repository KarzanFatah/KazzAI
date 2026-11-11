import * as THREE from "three";
import { clamp, fbm, hash2, lerp, smoothstep, valueNoise } from "./noise";
import { ROAD_HALF_WIDTH, type NearestResult, type Track } from "./track";

/** The terrain is a square of this size (metres) centred on the origin. */
export const WORLD_SIZE = 520;
export const HALF_WORLD = WORLD_SIZE / 2;
/** Water surface height. The sea lies along the -Z edge (top of the screen). */
export const SEA_LEVEL = 0;

const RES = 257; // grid vertices per side (~2 m spacing)
const ROAD_BLEND = 9; // metres over which the road blends into the dunes

export type Surface = "sand" | "road" | "beach" | "water";

/** Jump crests built into the road: fraction along the loop, height (m), half length (m). */
const ROAD_KICKERS: [number, number, number][] = [
  [0.28, 2.6, 14],
  [0.6, 3.2, 16],
  [0.86, 2.2, 12],
];

/**
 * Heightfield for the whole level: dunes, beach sloping into the sea, and the road carved in
 * with gentle undulations and a few jump crests. Physics and rendering both read the same grid.
 */
export class Terrain {
  readonly res = RES;
  readonly cell = WORLD_SIZE / (RES - 1);
  readonly heights = new Float32Array(RES * RES);
  /** 1 on the road, fading to 0 at the road edge blend. */
  readonly roadMask = new Float32Array(RES * RES);
  /** Signed lateral offset from the road centre (only meaningful where roadMask > 0). */
  readonly roadLateral = new Float32Array(RES * RES);

  private readonly near: NearestResult = { index: 0, distance: 0, lateral: 0 };

  constructor(readonly track: Track) {
    this.computeRoadHeights();
    this.computeGrid();
  }

  /** z of the waterline at a given x (wavy coast). */
  shorelineZ(x: number): number {
    return -150 + 12 * Math.sin(x * 0.013) + 6 * Math.sin(x * 0.031 + 1.3);
  }

  /** Natural ground (dunes + beach) before the road is carved in. */
  rawHeight(x: number, z: number): number {
    // Wind-shaped dunes: two families of ridges warped by noise, asymmetric profile.
    const warp = fbm(x * 0.004, z * 0.004, 3, 7) * 40;
    const r1 = Math.sin((x * 0.7 + z * 0.3 + warp) * 0.058);
    const r2 = Math.sin((x * -0.25 + z * 0.9 - warp * 0.6) * 0.041 + 1.7);
    const ridge = (v: number) => {
      const t = (v + 1) * 0.5;
      return t * t * (1.4 - 0.4 * t); // sharper crests, softer troughs
    };
    let h = ridge(r1) * 8 + ridge(r2) * 6;
    h += fbm(x * 0.018, z * 0.018, 4, 3) * 3.6;
    h += (valueNoise(x * 0.06, z * 0.06, 11) - 0.5) * 0.6;
    // Bigger dunes towards the far inland edge, calmer near the coast.
    const shore = this.shorelineZ(x);
    const inland = smoothstep(shore + 20, shore + 120, z);
    h = h * (0.35 + 0.65 * inland) + 1.5;
    // Beach: slopes gently down to the waterline and below.
    const beach = (z - shore) * 0.07;
    const toDunes = smoothstep(shore + 18, shore + 60, z);
    h = lerp(beach, Math.max(beach, h), toDunes);
    // Rim of tall dunes around the playable area.
    const edge = Math.max(Math.abs(x), z > 0 ? z : 0);
    h += smoothstep(HALF_WORLD - 70, HALF_WORLD - 10, edge) * 14;
    return h;
  }

  /** Road height per track sample: smoothed natural height plus the jump crests. */
  private computeRoadHeights(): void {
    const { samples, length } = this.track;
    const n = samples.length;
    const raw = samples.map((s) => this.rawHeight(s.x, s.z));
    const window = 18; // samples either side (~36 m)
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let k = -window; k <= window; k++) sum += raw[(i + k + n) % n];
      samples[i].y = Math.max(sum / (window * 2 + 1), SEA_LEVEL + 0.9);
    }
    for (const [frac, height, half] of ROAD_KICKERS) {
      const centre = frac * length;
      for (const s of samples) {
        let d = s.s - centre;
        if (d > length / 2) d -= length;
        if (d < -length / 2) d += length;
        // Long run-up, steeper drop: launches the car off the crest.
        const t = d < 0 ? clamp(1 + d / (half * 1.6), 0, 1) : clamp(1 - d / (half * 0.7), 0, 1);
        s.y += height * t * t * (3 - 2 * t);
      }
    }
  }

  private computeGrid(): void {
    const { res, cell, track } = this;
    const near = this.near;
    for (let j = 0; j < res; j++) {
      const z = -HALF_WORLD + j * cell;
      for (let i = 0; i < res; i++) {
        const x = -HALF_WORLD + i * cell;
        const idx = j * res + i;
        let h = this.rawHeight(x, z);
        track.nearest(x, z, near);
        if (near.distance < ROAD_HALF_WIDTH + ROAD_BLEND * 2) {
          const a = track.at(near.index);
          const b = track.at(near.index + 1);
          const roadY = (a.y + b.y) * 0.5;
          const w = smoothstep(ROAD_HALF_WIDTH, ROAD_HALF_WIDTH + ROAD_BLEND * 2, near.distance);
          h = lerp(roadY, h, w);
          this.roadMask[idx] = 1 - smoothstep(ROAD_HALF_WIDTH - 1, ROAD_HALF_WIDTH + 2.5, near.distance);
          this.roadLateral[idx] = near.lateral;
        }
        this.heights[idx] = h;
      }
    }
  }

  /**
   * Level a building pad: inside `radius` the ground becomes `height`, blending back to the
   * natural ground over `blend` metres. Call before buildMesh(). Leaves the road untouched.
   */
  flatten(x: number, z: number, radius: number, height: number, blend = 6): void {
    const { res, cell } = this;
    const r = radius + blend;
    const i0 = Math.max(0, Math.floor((x - r + HALF_WORLD) / cell));
    const i1 = Math.min(res - 1, Math.ceil((x + r + HALF_WORLD) / cell));
    const j0 = Math.max(0, Math.floor((z - r + HALF_WORLD) / cell));
    const j1 = Math.min(res - 1, Math.ceil((z + r + HALF_WORLD) / cell));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const idx = j * res + i;
        if (this.roadMask[idx] > 0.05) continue;
        const d = Math.hypot(-HALF_WORLD + i * cell - x, -HALF_WORLD + j * cell - z);
        const w = 1 - smoothstep(radius, r, d);
        this.heights[idx] = lerp(this.heights[idx], height, w);
      }
    }
  }

  private sampleGrid(arr: Float32Array, x: number, z: number): number {
    const res = this.res;
    const gx = clamp((x + HALF_WORLD) / this.cell, 0, res - 1.001);
    const gz = clamp((z + HALF_WORLD) / this.cell, 0, res - 1.001);
    const i = Math.floor(gx);
    const j = Math.floor(gz);
    const fx = gx - i;
    const fz = gz - j;
    const a = arr[j * res + i];
    const b = arr[j * res + i + 1];
    const c = arr[(j + 1) * res + i];
    const d = arr[(j + 1) * res + i + 1];
    // Match the mesh triangulation (diagonal from b to c) so wheels sit exactly on the surface.
    if (fx + fz <= 1) return a + (b - a) * fx + (c - a) * fz;
    return d + (c - d) * (1 - fx) + (b - d) * (1 - fz);
  }

  heightAt(x: number, z: number): number {
    return this.sampleGrid(this.heights, x, z);
  }

  /** Ground height, never below the water surface (what floating things rest on). */
  surfaceHeightAt(x: number, z: number): number {
    return Math.max(this.heightAt(x, z), SEA_LEVEL);
  }

  roadAt(x: number, z: number): number {
    return this.sampleGrid(this.roadMask, x, z);
  }

  normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const e = 1.2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  }

  surfaceAt(x: number, z: number): Surface {
    const h = this.heightAt(x, z);
    if (h < SEA_LEVEL - 0.15) return "water";
    if (this.roadAt(x, z) > 0.5) return "road";
    if (h < SEA_LEVEL + 1.6 && z < this.shorelineZ(x) + 45) return "beach";
    return "sand";
  }

  /**
   * Build the render mesh: vertex-coloured sand (pale crests, ochre troughs, reddish patches,
   * berms along the road), per-pixel road ruts and waterline in the shader, and tiling
   * wind-ripple albedo + normal maps that the low sun rakes across.
   */
  buildMesh(): THREE.Mesh {
    const { res, cell, heights, roadMask, roadLateral } = this;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    // Per vertex: road mask, signed lateral offset, wear (how strongly ruts show).
    const road = new Float32Array(pos.count * 3);
    const hAt = (i: number, j: number) =>
      heights[clamp(j, 0, res - 1) * res + clamp(i, 0, res - 1)];
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      // PlaneGeometry rows run from +z to -z after rotation; recover grid indices from position.
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const i = Math.round((x + HALF_WORLD) / cell);
      const j = Math.round((z + HALF_WORLD) / cell);
      const idx = j * res + i;
      const h = heights[idx];
      pos.setY(v, h);
      // Convex crests are wind-scoured and pale, troughs collect darker ochre sand.
      const curv = (4 * h - hAt(i - 1, j) - hAt(i + 1, j) - hAt(i, j - 1) - hAt(i, j + 1)) / (cell * cell);
      const slope = Math.hypot(hAt(i + 1, j) - hAt(i - 1, j), hAt(i, j + 1) - hAt(i, j - 1)) / (2 * cell);
      c.copy(SAND);
      c.lerp(curv > 0 ? CREST : TROUGH, clamp(Math.abs(curv) * 1.8, 0, 0.7));
      // Steep slip faces: slightly darker, more saturated.
      c.lerp(TROUGH, smoothstep(0.3, 0.9, slope) * 0.35);
      // Broad iron-stained reddish patches and paler flats, plus finer mottling.
      const broad = fbm(x * 0.011, z * 0.011, 3, 21);
      const fine = fbm(x * 0.05, z * 0.05, 2, 33);
      c.lerp(broad > 0 ? RUSTY : PALE, Math.abs(broad) * 0.55);
      c.lerp(fine > 0 ? CREST : TROUGH, Math.abs(fine) * 0.22);

      const m = roadMask[idx];
      const lat = Math.abs(roadLateral[idx]);
      // Loose sand thrown up into berms just outside the compacted strip.
      const berm =
        lat > 0
          ? smoothstep(ROAD_HALF_WIDTH - 0.8, ROAD_HALF_WIDTH + 1.5, lat) *
            (1 - smoothstep(ROAD_HALF_WIDTH + 2.5, ROAD_HALF_WIDTH + 6, lat))
          : 0;
      c.lerp(LOOSE, berm * (0.45 + 0.25 * fine));
      // Compacted, darker road; greyer where it is most worn.
      c.lerp(ROAD, m * 0.85);
      c.lerp(ROAD_WORN, m * clamp(0.5 + broad, 0, 1) * 0.35);
      if (h < SEA_LEVEL - 0.2) c.lerp(UNDER, smoothstep(SEA_LEVEL - 0.2, SEA_LEVEL - 3, h));
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
      road[v * 3] = m;
      road[v * 3 + 1] = roadLateral[idx];
      road[v * 3 + 2] = 0.55 + 0.45 * fbm(x * 0.06, z * 0.06, 2, 41);
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("aRoad", new THREE.BufferAttribute(road, 3));
    geo.computeVertexNormals();

    const { albedo, normal } = makeRippleTextures();
    // Lambert: sand is fully rough, and it keeps the full-screen terrain cheap on phones.
    const mat = new THREE.MeshLambertMaterial({
      vertexColors: true,
      map: albedo,
      normalMap: normal,
      normalScale: new THREE.Vector2(1, 1),
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\n${TERRAIN_VERT_PARS}`)
        .replace("#include <begin_vertex>", `#include <begin_vertex>\n${TERRAIN_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\n${TERRAIN_FRAG_PARS}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\n${TERRAIN_COLOR}`)
        .replace("#include <normal_fragment_maps>", TERRAIN_NORMAL);
    };
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    return mesh;
  }
}

const SAND = new THREE.Color(0xe8c693);
const CREST = new THREE.Color(0xf6e4c0);
const TROUGH = new THREE.Color(0xd6a86f);
const RUSTY = new THREE.Color(0xe0aa76);
const PALE = new THREE.Color(0xf0ddb6);
const LOOSE = new THREE.Color(0xf3dcb0);
const ROAD = new THREE.Color(0xc79f6e);
const ROAD_WORN = new THREE.Color(0xb39878);
const UNDER = new THREE.Color(0x7d6a4c);

/** Ripple tile size in metres (albedo and normal map share it). */
const RIPPLE_TILE = 6;

const TERRAIN_VERT_PARS = /* glsl */ `
attribute vec3 aRoad;
varying vec3 vRoad;
varying vec3 vWorld;
`;

const TERRAIN_VERT = /* glsl */ `
vRoad = aRoad;
vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
`;

const TERRAIN_FRAG_PARS = /* glsl */ `
varying vec3 vRoad;
varying vec3 vWorld;
`;

// Runs after the vertex colour and detail map are applied. The interpolated lateral offset
// gives crisp ruts at any grid size; fwidth fades them out before they alias in the distance.
const TERRAIN_COLOR = /* glsl */ `
float latAbs = abs(vRoad.y);
float rutAA = clamp(1.6 - fwidth(latAbs) * 3.0, 0.0, 1.0);
float rut = max(1.0 - abs(latAbs - 0.85) / 0.38, 0.0) + max(1.0 - abs(latAbs - 2.7) / 0.42, 0.0);
float hump = max(1.0 - abs(latAbs - 1.8) / 0.5, 0.0);
float wear = vRoad.x * vRoad.z * rutAA;
diffuseColor.rgb *= 1.0 - wear * (smoothstep(0.0, 1.0, rut) * 0.17 - hump * 0.06);
// Waterline: damp dark sand near the sea, edged by a thin wavy line of dried foam and salt.
float wet = 1.0 - smoothstep(0.08, 0.42, vWorld.y);
diffuseColor.rgb *= 1.0 - wet * 0.34;
float tide = vWorld.y - 0.45 - 0.06 * sin(vWorld.x * 0.21) - 0.035 * sin(vWorld.x * 0.87 + 1.7);
float foamLine = (1.0 - smoothstep(0.0, 0.035, abs(tide))) * smoothstep(0.2, 0.9, sin(vWorld.x * 1.3) * 0.5 + 0.7);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.84, 0.8, 0.72), foamLine * 0.5);
// Ripples are flattened on the compacted road and on wet sand.
float rippleAmt = (1.0 - vRoad.x * 0.8) * (1.0 - wet * 0.85);
`;

// Two reads of the ripple normal map at unrelated scales and angles break up the tiling.
// The second read is rotated, so its normal is rotated back into the first read's frame.
const TERRAIN_NORMAL = /* glsl */ `
const mat2 rippleRot = mat2(0.88, 0.47, -0.47, 0.88);
vec3 mapN = texture2D(normalMap, vNormalMapUv).xyz * 2.0 - 1.0;
vec2 mapN2 = texture2D(normalMap, rippleRot * vNormalMapUv * 1.73 + vec2(0.31, 0.17)).xy * 2.0 - 1.0;
mapN.xy = (mapN.xy + (mapN2 * rippleRot) * 0.5) * normalScale * rippleAmt;
normal = normalize(tbn * mapN);
`;

/** Value noise that wraps every `period` cells, so textures built from it tile seamlessly. */
function tileNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const tx = x - xi;
  const ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const w = (n: number) => ((n % period) + period) % period;
  const a = hash2(w(xi), w(yi), seed);
  const b = hash2(w(xi + 1), w(yi), seed);
  const c = hash2(w(xi), w(yi + 1), seed);
  const d = hash2(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/**
 * Tiling wind ripples: an asymmetric ripple height field (gentle windward slope, steep lee),
 * warped by noise, turned into a tangent-space normal map; the albedo adds grain and a faint
 * tint on the ripple crests. Both multiply / perturb the vertex-coloured sand.
 */
function makeRippleTextures(): { albedo: THREE.CanvasTexture; normal: THREE.CanvasTexture } {
  const size = 256;
  const ripples = 10; // per tile, 60 cm apart
  const texel = RIPPLE_TILE / size; // metres per pixel
  const height = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      const warp = (tileNoise(u * 4, v * 4, 4, 3) - 0.5) * 1.6 + (tileNoise(u * 8, v * 8, 8, 4) - 0.5) * 0.5;
      const f = v * ripples + warp + Math.sin(u * Math.PI * 2 * 2) * 0.3;
      const t = f - Math.floor(f);
      const ridge = t < 0.72 ? t / 0.72 : (1 - t) / 0.28;
      const grain = tileNoise(x * 0.5, y * 0.5, size / 2, 5);
      // Heights in metres: 1.5 cm ripples (slopes of a few degrees) plus fine grain.
      height[y * size + x] = (ridge * ridge * (3 - 2 * ridge)) * 0.015 + (grain - 0.5) * 0.003;
    }
  }
  const make = () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const g = canvas.getContext("2d")!;
    return { canvas, g, img: g.createImageData(size, size) };
  };
  const a = make();
  const n = make();
  const hAt = (x: number, y: number) => height[((y + size) % size) * size + ((x + size) % size)];
  const toSlope = 1 / (2 * texel);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4;
      // Canvas rows run downwards while texture v runs upwards (flipY), hence the sign of dy.
      const dx = (hAt(x + 1, y) - hAt(x - 1, y)) * toSlope;
      const dy = (hAt(x, y + 1) - hAt(x, y - 1)) * toSlope;
      const inv = 1 / Math.hypot(dx, dy, 1);
      n.img.data[o] = (-dx * inv * 0.5 + 0.5) * 255;
      n.img.data[o + 1] = (dy * inv * 0.5 + 0.5) * 255;
      n.img.data[o + 2] = (inv * 0.5 + 0.5) * 255;
      n.img.data[o + 3] = 255;
      const h = height[y * size + x];
      const speck = hash2(x, y, 9) > 0.985 ? -26 : 0; // the odd darker grain or shell fragment
      const val = 240 + h * 500 + (valueNoise(x * 0.7, y * 0.7, 6) - 0.5) * 14 + speck;
      a.img.data[o] = val + 3;
      a.img.data[o + 1] = val - 1;
      a.img.data[o + 2] = val - 7;
      a.img.data[o + 3] = 255;
    }
  }
  const finish = (t: typeof a, srgb: boolean) => {
    t.g.putImageData(t.img, 0, 0);
    const tex = new THREE.CanvasTexture(t.canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(WORLD_SIZE / RIPPLE_TILE, WORLD_SIZE / RIPPLE_TILE);
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.anisotropy = 4;
    return tex;
  };
  return { albedo: finish(a, true), normal: finish(n, false) };
}
