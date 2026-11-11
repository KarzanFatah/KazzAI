import * as THREE from "three";
import { clamp, fbm, lerp, smoothstep, valueNoise } from "./noise";
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

  /** Build the render mesh (vertex-coloured sand, road ruts, wet beach) with a ripple detail map. */
  buildMesh(): THREE.Mesh {
    const { res, cell } = this;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, res - 1, res - 1);
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const colors = new Float32Array(pos.count * 3);
    const sand = new THREE.Color(0xe6c48f);
    const sandDark = new THREE.Color(0xd2a96f);
    const sandLight = new THREE.Color(0xf3dcae);
    const road = new THREE.Color(0xb48c5a);
    const rut = new THREE.Color(0x957249);
    const wet = new THREE.Color(0xa98c62);
    const under = new THREE.Color(0x7d6a4c);
    const c = new THREE.Color();
    for (let v = 0; v < pos.count; v++) {
      // PlaneGeometry rows run from +z to -z after rotation; recover grid indices from position.
      const x = pos.getX(v);
      const z = pos.getZ(v);
      const i = Math.round((x + HALF_WORLD) / cell);
      const j = Math.round((z + HALF_WORLD) / cell);
      const idx = j * res + i;
      const h = this.heights[idx];
      pos.setY(v, h);
      // Crests light, troughs darker, plus large soft patches.
      const curv =
        (this.heights[idx] * 4 -
          (this.heights[Math.max(0, idx - 1)] +
            this.heights[Math.min(idx + 1, this.heights.length - 1)] +
            this.heights[Math.max(0, idx - res)] +
            this.heights[Math.min(idx + res, this.heights.length - 1)])) /
        (cell * cell);
      const patch = fbm(x * 0.02, z * 0.02, 3, 21);
      c.copy(sand);
      c.lerp(curv > 0 ? sandLight : sandDark, clamp(Math.abs(curv) * 1.6, 0, 0.6));
      c.lerp(patch > 0 ? sandLight : sandDark, Math.abs(patch) * 0.35);
      // Road: compacted strip with two wheel ruts either side of the centre.
      const m = this.roadMask[idx];
      if (m > 0) {
        const lat = Math.abs(this.roadLateral[idx]);
        const rutT = Math.max(
          1 - Math.abs(lat - 1.3) / 0.7,
          1 - Math.abs(lat - 3.6) / 0.6,
          0,
        );
        c.lerp(road, m * 0.85);
        c.lerp(rut, m * rutT * 0.6);
      }
      // Wet sand at the waterline, darker below water.
      if (h < SEA_LEVEL + 0.7) c.lerp(wet, smoothstep(SEA_LEVEL + 0.7, SEA_LEVEL - 0.1, h));
      if (h < SEA_LEVEL - 0.2) c.lerp(under, smoothstep(SEA_LEVEL - 0.2, SEA_LEVEL - 3, h));
      colors[v * 3] = c.r;
      colors[v * 3 + 1] = c.g;
      colors[v * 3 + 2] = c.b;
    }
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      map: makeRippleTexture(),
      roughness: 0.97,
      metalness: 0,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = "terrain";
    return mesh;
  }
}

/** Tileable wind-ripple detail (multiplied with the vertex colours). */
function makeRippleTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  const img = g.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const v = y / size;
      // Ripples tile because all frequencies are integers over the tile.
      const ripple =
        Math.sin((v * 22 + Math.sin(u * Math.PI * 4) * 0.35) * Math.PI * 2) * 0.5 + 0.5;
      const grain = valueNoise(x * 0.9, y * 0.9, 5);
      const val = 236 + ripple * 14 + (grain - 0.5) * 18;
      const o = (y * size + x) * 4;
      img.data[o] = val;
      img.data[o + 1] = val - 2;
      img.data[o + 2] = val - 6;
      img.data[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(WORLD_SIZE / 7, WORLD_SIZE / 7);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
