import * as THREE from "three";
import { clamp, fbm, hash2, rng, smoothstep } from "./noise";
import { HALF_WORLD, SEA_LEVEL, type Terrain } from "./terrain";
import { ROAD_HALF_WIDTH, type NearestResult, type Track } from "./track";
import type { Collider } from "./types";

export interface PropsResult {
  /** Static obstacles for the car (rocks, poles, buildings, fences, flags...). */
  colliders: Collider[];
  /** Animate windmill, flags, birds, wobbling bushes... */
  update(dt: number, time: number, carPos: THREE.Vector3): void;
  /** The car hit collider `id` with strength 0..1 (wobble a sign, shake a bush...). */
  hit(id: number, strength: number): void;
}

/**
 * Every static/ambient object in the level: start/finish gantry, checkpoint flags, shack with
 * wire fence, windmill pump, trailer, water tank, telegraph poles with sagging wires, rocks,
 * dry bushes/grass, dead trees, birds. Seeded, so the level is identical on every load.
 */
export function buildProps(scene: THREE.Scene, terrain: Terrain, track: Track): PropsResult {
  return new LevelProps(scene, terrain, track);
}

/** Nothing solid may come closer than this to the road centre line (SPEC). */
const SOLID_CLEAR = ROAD_HALF_WIDTH + 2.5;
/** Yaw the wind blows towards (a sea breeze, inland): flags, windmill and grass follow it. */
const WIND_YAW = 0.35;
/** Checkpoint flag poles stand just off the road edge (soft colliders). */
const FLAG_LATERAL = ROAD_HALF_WIDTH + 1.3;
/** Shack footprint in the homestead's local frame (+z faces the road). */
const SHACK = { x: -4, z: -1, w: 6.4, d: 4.6, h: 3, roof: 1.5, porch: 1.9 };
/** Homestead outline (local) that must stay clear of the road: fence corners, front, windmill. */
const SITE_OUTLINE: [number, number][] = [
  [-14, -12], [12, -12], [12, 8], [-14, 8], [-6, 8], [0, 8], [6, 8], [-14, -2], [12, -2], [1, -20],
];

const COL = {
  wood: 0x8d6c49,
  woodDark: 0x6b5038,
  weathered: 0x6f5f4e,
  trim: 0x5a4838,
  steel: 0x5d5953,
  metal: 0x3d3a36,
  glass: 0x262a2e,
  frame: 0xd9d1c1,
};

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();

interface Disc {
  x: number;
  z: number;
  r: number;
  /** Grass may still grow inside (areas only kept free of rocks/trees). */
  grassOk: boolean;
}

interface Site {
  x: number;
  z: number;
  yaw: number;
}

interface Bird {
  cx: number;
  cz: number;
  y: number;
  radius: number;
  speed: number; // rad/s, sign = circling direction
  phase: number;
  wander: number;
  scale: number;
}

class LevelProps implements PropsResult {
  readonly colliders: Collider[] = [];
  private readonly rand = rng(0xd057);
  private readonly near: NearestResult = { index: 0, distance: 0, lateral: 0 };
  private readonly reserved: Disc[] = [];
  private readonly wirePts: number[] = [];
  /** Shared shader clock for flags, grass and birds. */
  private readonly uTime = { value: 0 };
  private readonly wobbles = new Wobbles();
  private readonly mats: ReturnType<LevelProps["makeMaterials"]>;
  private readonly birds: Bird[] = [];
  private birdMesh!: THREE.InstancedMesh;
  private head!: THREE.Group;
  private rotor!: THREE.Mesh;
  private rotorAngle = 0;
  private carX = 0;
  private carZ = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly terrain: Terrain,
    private readonly track: Track,
  ) {
    this.mats = this.makeMaterials();
    this.buildGantry();
    this.buildCheckpoints();
    const site = this.findHomestead();
    this.buildHomestead(site);
    this.buildTelegraphLine();
    this.buildRocks();
    this.buildDeadTrees();
    this.buildVegetation();
    this.buildBirds(site);

    const wires = new THREE.BufferGeometry();
    wires.setAttribute("position", new THREE.Float32BufferAttribute(this.wirePts, 3));
    scene.add(new THREE.LineSegments(wires, new THREE.LineBasicMaterial({ color: 0x2e2620 })));
  }

  update = (dt: number, time: number, carPos: THREE.Vector3): void => {
    this.uTime.value = time;
    this.rotorAngle += dt * (2.3 + Math.sin(time * 0.37) * 0.9);
    this.rotor.rotation.z = this.rotorAngle;
    this.head.rotation.y = WIND_YAW + Math.PI + Math.sin(time * 0.11) * 0.25;
    this.updateBirds(time);
    this.wobbles.update(dt);
    this.carX = carPos.x;
    this.carZ = carPos.z;
  };

  hit = (id: number, strength: number): void => {
    this.wobbles.hit(id, strength, this.carX, this.carZ);
  };

  // ---------------------------------------------------------------- helpers

  private roadDist(x: number, z: number): number {
    return this.track.nearest(x, z, this.near).distance;
  }

  private reserve(x: number, z: number, r: number, grassOk: boolean): void {
    this.reserved.push({ x, z, r, grassOk });
  }

  private isFree(x: number, z: number, r: number, grass: boolean): boolean {
    for (const d of this.reserved) {
      if (grass && d.grassOk) continue;
      const rr = d.r + r;
      if ((d.x - x) ** 2 + (d.z - z) ** 2 < rr * rr) return false;
    }
    return true;
  }

  private nearCheckpoint(x: number, z: number, r: number): boolean {
    return this.track.checkpoints.some((cp) => (cp.x - x) ** 2 + (cp.z - z) ** 2 < r * r);
  }

  private solidCircle(x: number, z: number, r: number): void {
    this.colliders.push({ kind: "circle", x, z, r, solid: true });
  }

  private solidSegment(a: [number, number], b: [number, number], r: number): void {
    this.colliders.push({ kind: "segment", ax: a[0], az: a[1], bx: b[0], bz: b[1], r, solid: true });
  }

  /** Sagging wire from a to b (parabolic catenary) as line segments. */
  private wire(a: THREE.Vector3, b: THREE.Vector3, sag: number, segs: number): void {
    const p = this.wirePts;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t - sag * 4 * t * (1 - t);
      const z = a.z + (b.z - a.z) * t;
      if (i > 0) p.push(x, y, z);
      if (i < segs) p.push(x, y, z);
    }
  }

  private add<T extends THREE.Object3D>(obj: T): T {
    this.scene.add(obj);
    return obj;
  }

  private makeMaterials() {
    const env = skyEnvTexture();
    return {
      /** Flat-shaded vertex colours: wood, steel, rocks, trees. */
      struct: new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 }),
      plank: new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: plankTexture(rng(41)),
        roughness: 0.95,
      }),
      tin: new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: corrugatedTexture(8, 0.55),
        roughness: 0.55,
        metalness: 0.45,
        envMap: env,
        envMapIntensity: 0.8,
      }),
      chrome: new THREE.MeshStandardMaterial({
        vertexColors: true,
        map: corrugatedTexture(4, 0),
        roughness: 0.28,
        metalness: 0.9,
        envMap: env,
      }),
      grass: this.animated(
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }),
        "dustline-grass",
        "",
        `vec3 transformed = vec3(position);
        float gph = instanceMatrix[3].x * 0.21 + instanceMatrix[3].z * 0.17;
        float gw = position.y * position.y;
        transformed.x += (sin(uTime * 1.9 + gph) * 0.07 + 0.04) * gw;
        transformed.z += cos(uTime * 1.3 + gph * 1.7) * 0.05 * gw;`,
        true,
      ),
      bird: this.animated(
        new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }),
        "dustline-bird",
        "attribute vec3 aBird; // phase, flap rate, glides (0/1)",
        `vec3 transformed = vec3(position);
        float glide = mix(1.0, 0.1 + 0.9 * smoothstep(0.2, 0.7, sin(uTime * 0.5 + aBird.x * 2.0)), aBird.z);
        transformed.y += (sin(uTime * aBird.y + aBird.x) * 0.75 * glide + 0.12) * abs(position.x);`,
        true,
      ),
    };
  }

  /**
   * Patches a material's vertex stage with the shared clock. `upNormals` keeps the faked "up"
   * normals of thin double-sided foliage from flipping (and darkening) on back faces.
   */
  private animated(
    mat: THREE.MeshStandardMaterial,
    key: string,
    decl: string,
    beginVertex: string,
    upNormals = false,
    beginNormal?: string,
  ): THREE.MeshStandardMaterial {
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = this.uTime;
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", `#include <common>\nuniform float uTime;\n${decl}`)
        .replace("#include <begin_vertex>", beginVertex);
      if (beginNormal) {
        shader.vertexShader = shader.vertexShader.replace("#include <beginnormal_vertex>", beginNormal);
      }
      if (upNormals) {
        shader.fragmentShader = shader.fragmentShader.replace(
          "#include <normal_fragment_begin>",
          THREE.ShaderChunk.normal_fragment_begin.replace("normal *= faceDirection;", ""),
        );
      }
    };
    mat.customProgramCacheKey = () => key;
    return mat;
  }

  // ---------------------------------------------------------------- start / finish

  /** Wooden truss gantry over the start line with a chequered DUSTLINE banner. */
  private buildGantry(): void {
    const { track, terrain } = this;
    const cp = track.checkpoints[0];
    const roadY = track.at(cp.sample).y;
    const b = new Builder();
    b.frame.makeRotationY(cp.yaw).setPosition(cp.x, roadY, cp.z);
    const cos = Math.cos(cp.yaw);
    const sin = Math.sin(cp.yaw);
    const HALF = 10.2; // tower centres either side of the centre line
    const T = 0.55; // half the tower / beam depth
    const TOP = 7.3;
    const LOW = 6.15;
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

    for (const side of [-1, 1]) {
      const cx = side * HALF;
      const wx = cp.x + cx * cos;
      const wz = cp.z - cx * sin;
      const foot = terrain.heightAt(wx, wz) - roadY - 0.3;
      for (const [dx, dz] of corner) {
        b.strut(cx + dx * T, foot, dz * T, cx + dx * T, TOP + 0.07, dz * T, 0.15, COL.woodDark);
      }
      // Rungs on every face with zig-zag diagonals between them.
      const levels = Math.max(4, Math.round((TOP - foot) / 1.0));
      const levelY = (l: number) => foot + 0.35 + ((TOP - foot - 0.35) * l) / levels;
      for (let l = 0; l <= levels; l++) {
        for (let f = 0; f < 4; f++) {
          const [ax, az] = corner[f];
          const [bx, bz] = corner[(f + 1) % 4];
          b.strut(cx + ax * T, levelY(l), az * T, cx + bx * T, levelY(l), bz * T, 0.08, COL.wood);
          if (l === 0) continue;
          const flip = l % 2 === 1;
          b.strut(
            cx + (flip ? ax : bx) * T, levelY(l - 1), (flip ? az : bz) * T,
            cx + (flip ? bx : ax) * T, levelY(l), (flip ? bz : az) * T,
            0.07, COL.wood,
          );
        }
      }
      this.solidCircle(wx, wz, 0.95);
      this.reserve(wx, wz, 2.2, false);
    }

    // Beam: four chords with verticals, diagonals and cross members every metre.
    const span = HALF + T;
    for (const z of [-T, T]) for (const y of [LOW, TOP]) b.strut(-span, y, z, span, y, z, 0.15, COL.woodDark);
    const n = 20;
    for (let i = 0; i <= n; i++) {
      const x = -HALF + (2 * HALF * i) / n;
      const x2 = x + (2 * HALF) / n;
      for (const z of [-T, T]) {
        b.strut(x, LOW, z, x, TOP, z, 0.08, COL.wood);
        if (i < n) b.strut(x, i % 2 ? LOW : TOP, z, x2, i % 2 ? TOP : LOW, z, 0.07, COL.wood);
      }
      b.strut(x, LOW, -T, x, LOW, T, 0.08, COL.wood);
      b.strut(x, TOP, -T, x, TOP, T, 0.08, COL.wood);
      if (i < n) b.strut(x, TOP, -T, x2, TOP, T, 0.06, COL.wood);
    }

    // Banner on a batten, readable from both directions.
    const BW = 10.4;
    const BH = 1.62;
    const by = LOW - 0.35 - BH / 2;
    b.box(BW + 0.3, 0.12, 0.12, 0, by + BH / 2 + 0.06, 0, COL.woodDark);
    for (const x of [-BW / 2 + 0.3, 0, BW / 2 - 0.3]) b.strut(x, by + BH / 2 + 0.1, 0, x, LOW, 0, 0.04, 0x3a2f26);
    const banner = new Builder();
    banner.frame.copy(b.frame);
    const plane = new THREE.PlaneGeometry(BW, BH);
    banner.add(plane, _m.makeTranslation(0, by, 0.03), 0xffffff, 1, 1);
    banner.add(plane, _m.makeRotationY(Math.PI).setPosition(0, by, -0.03), 0xffffff, 1, 1);

    this.add(b.mesh(this.mats.struct));
    const bannerMat = new THREE.MeshStandardMaterial({ map: bannerTexture(), roughness: 0.85 });
    this.add(banner.mesh(bannerMat));
    this.reserve(cp.x, cp.z, 16, true);
  }

  // ---------------------------------------------------------------- checkpoints

  /** Checkpoints 1..7: a striped pole with a waving flag either side + a number board. */
  private buildCheckpoints(): void {
    const { track, terrain } = this;
    const cps = track.checkpoints.slice(1);
    const count = cps.length * 2;

    const pole = new Builder();
    for (let i = 0; i < 6; i++) {
      pole.rod(0, i * 0.9, 0, 0, (i + 1) * 0.9, 0, 0.065, 0.06, i % 2 ? 0xf2efe8 : 0xc8452a, 6);
    }
    pole.rod(0, 5.4, 0, 0, 5.56, 0, 0.09, 0.05, 0x2a2622, 6);
    const poles = this.add(new THREE.InstancedMesh(pole.geometry(), this.mats.struct, count));
    const flagGeo = new THREE.PlaneGeometry(1.5, 0.95, 10, 2).translate(0.82, 4.85, 0);
    const flagMat = this.animated(
      new THREE.MeshStandardMaterial({ color: 0xe5542a, roughness: 0.8, side: THREE.DoubleSide }),
      "dustline-flag",
      "",
      `vec3 transformed = vec3(position);
      transformed.z += sin(fph) * famp;
      transformed.y -= fx * fx * 0.05;`,
      false,
      // Travelling wave, stronger towards the free edge; the normal follows the wave slope.
      `float fx = max(position.x - 0.07, 0.0);
      float fph = uTime * 7.0 - fx * 3.4 + instanceMatrix[3].x * 0.37 + instanceMatrix[3].z * 0.23;
      float famp = 0.12 * fx;
      vec3 objectNormal = normalize(vec3(3.4 * famp * cos(fph) - 0.12 * sin(fph), 0.0, 1.0));`,
    );
    const flags = this.add(new THREE.InstancedMesh(flagGeo, flagMat, count));
    poles.castShadow = flags.castShadow = true;

    const posts = new Builder();
    const boards = new Builder();
    const qWind = new THREE.Quaternion().setFromAxisAngle(UP, WIND_YAW - Math.PI / 2);
    let k = 0;
    for (const cp of cps) {
      const s = track.at(cp.sample);
      for (const side of [-1, 1]) {
        const x = cp.x - s.tz * FLAG_LATERAL * side;
        const z = cp.z + s.tx * FLAG_LATERAL * side;
        _m.compose(_v.set(x, terrain.heightAt(x, z) - 0.1, z), qWind, ONE);
        const id = this.wobbles.add([poles, flags], k++, _m);
        this.colliders.push({ kind: "circle", x, z, r: 0.45, solid: false, id });
        this.reserve(x, z, 1.5, false);
      }
      // Number board on the right, facing the oncoming car.
      const lat = FLAG_LATERAL + 2.4;
      const bx = cp.x - s.tz * lat;
      const bz = cp.z + s.tx * lat;
      posts.frame.makeRotationY(cp.yaw + Math.PI).setPosition(bx, terrain.heightAt(bx, bz), bz);
      boards.frame.copy(posts.frame);
      posts.box(0.12, 2.3, 0.12, 0, 1.0, -0.08, COL.woodDark);
      posts.box(1.25, 1.08, 0.06, 0, 1.75, -0.02, COL.wood);
      const face = new THREE.PlaneGeometry(1.1, 0.95);
      const uv = face.getAttribute("uv");
      for (let i = 0; i < uv.count; i++) uv.setX(i, (cp.index + uv.getX(i)) / 8);
      boards.add(face, _m.makeTranslation(0, 1.75, 0.015), 0xffffff, 1, 1);
      this.solidCircle(bx, bz, 0.25);
      this.reserve(bx, bz, 1.2, false);
    }
    this.add(posts.mesh(this.mats.struct));
    const boardMat = new THREE.MeshStandardMaterial({ map: numberAtlas(), roughness: 0.85 });
    this.add(boards.mesh(boardMat));
  }

  // ---------------------------------------------------------------- homestead

  /** Flattest spot ~20-35 m off the road on the inside of a bend, with the outline clear of it. */
  private findHomestead(): Site {
    const { track, terrain } = this;
    const n = track.samples.length;
    let best: Site = { x: 0, z: 30, yaw: 0 };
    let bestScore = Infinity;
    for (let i = 0; i < n; i += 3) {
      const a = track.at(i - 10);
      const b = track.at(i + 10);
      const s = track.at(i);
      const turn = a.tx * b.tz - a.tz * b.tx; // > 0: the road turns to its right
      if (Math.abs(turn) < 0.12) continue;
      const side = Math.sign(turn);
      for (let d = 19; d <= 34; d += 3) {
        const x = s.x - s.tz * d * side;
        const z = s.z + s.tx * d * side;
        if (z < terrain.shorelineZ(x) + 45 || Math.abs(x) > HALF_WORLD - 75 || z > HALF_WORLD - 75) continue;
        if (this.nearCheckpoint(x, z, 45)) continue;
        const yaw = Math.atan2(s.x - x, s.z - z); // the porch faces the road
        const c = Math.cos(yaw);
        const sn = Math.sin(yaw);
        let lo = Infinity;
        let hi = -Infinity;
        let clear = true;
        for (const [lx, lz] of SITE_OUTLINE) {
          const wx = x + lx * c + lz * sn;
          const wz = z - lx * sn + lz * c;
          if (this.roadDist(wx, wz) < SOLID_CLEAR + 2) {
            clear = false;
            break;
          }
          const h = terrain.heightAt(wx, wz);
          lo = Math.min(lo, h);
          hi = Math.max(hi, h);
        }
        if (!clear) continue;
        for (let gx = -12; gx <= 12; gx += 6) {
          for (let gz = -12; gz <= 6; gz += 6) {
            const h = terrain.heightAt(x + gx * c + gz * sn, z - gx * sn + gz * c);
            lo = Math.min(lo, h);
            hi = Math.max(hi, h);
          }
        }
        const score = hi - lo + Math.abs(d - 24) * 0.05 - Math.abs(turn) * 2;
        if (score < bestScore) {
          bestScore = score;
          best = { x, z, yaw };
        }
      }
    }
    return best;
  }

  /** Shack + fenced yard, trailer, water tank, windmill pump, crates and barrels. */
  private buildHomestead(site: Site): void {
    const { terrain, mats } = this;
    const c = Math.cos(site.yaw);
    const s = Math.sin(site.yaw);
    const toWorld = (lx: number, lz: number): [number, number] => [
      site.x + lx * c + lz * s,
      site.z - lx * s + lz * c,
    ];
    const ground = (lx: number, lz: number) => terrain.heightAt(...toWorld(lx, lz));
    const siteM = new THREE.Matrix4().makeRotationY(site.yaw).setPosition(site.x, 0, site.z);
    /** Frame standing on the ground at local (lx, lz), turned by ry. */
    const frameAt = (lx: number, lz: number, ry: number, y = ground(lx, lz)) =>
      siteM.clone().multiply(_m.makeTranslation(lx, y, lz)).multiply(_m2.makeRotationY(ry));

    const st = new Builder();
    const pl = new Builder(1.6);
    const tin = new Builder(1.2);
    const chrome = new Builder();
    const rand = this.rand;

    // --- shack on a raised floor
    const { w: W, d: D, porch: PD } = SHACK;
    let lo = Infinity;
    let hi = -Infinity;
    for (const [cx, cz] of [[-W / 2, -D / 2], [W / 2, -D / 2], [W / 2, D / 2 + PD], [-W / 2, D / 2 + PD], [0, 0]]) {
      const h = ground(SHACK.x + cx, SHACK.z + cz);
      lo = Math.min(lo, h);
      hi = Math.max(hi, h);
    }
    const floorY = hi + 0.35;
    const shackM = frameAt(SHACK.x, SHACK.z, 0, floorY);
    for (const b of [st, pl, tin]) b.frame.copy(shackM);
    this.buildShack(st, pl, tin, lo - floorY - 0.3);
    const [sx0, sz0] = [SHACK.x - W / 2, SHACK.z - D / 2];
    const [sx1, sz1] = [SHACK.x + W / 2, SHACK.z + D / 2];
    this.solidSegment(toWorld(sx0, sz0), toWorld(sx1, sz0), 0.3);
    this.solidSegment(toWorld(sx1, sz0), toWorld(sx1, sz1), 0.3);
    this.solidSegment(toWorld(sx1, sz1), toWorld(sx0, sz1), 0.3);
    this.solidSegment(toWorld(sx0, sz1), toWorld(sx0, sz0), 0.3);
    this.solidSegment(toWorld(sx0 + D / 2, SHACK.z), toWorld(sx1 - D / 2, SHACK.z), D / 2 - 0.1);
    this.solidSegment(toWorld(sx0, sz1 + PD / 2), toWorld(sx1, sz1 + PD / 2), PD / 2);
    this.reserve(...toWorld(SHACK.x, SHACK.z + 0.6), 5.4, false);

    // --- silver trailer (rounded, ribbed) inside the yard
    const TX = 6.6;
    const TZ = -3;
    const TYAW = 0.25;
    chrome.frame.copy(frameAt(TX, TZ, TYAW));
    st.frame.copy(chrome.frame);
    const body = new THREE.CapsuleGeometry(1.25, 4.4, 6, 16);
    body.rotateX(Math.PI / 2);
    body.scale(1, 1.08, 1);
    chrome.add(body, _m.makeTranslation(0, 1.95, 0), 0xffffff, 6, 1);
    st.box(2.0, 0.22, 5.6, 0, 0.62, 0, 0x2f2c29);
    for (const sx of [-1, 1]) {
      for (const wz of [-0.5, 0.5]) st.rod(sx - 0.13, 0.38, wz, sx + 0.13, 0.38, wz, 0.38, 0.38, 0x24221f, 10);
      for (const wz of [-1.7, 0.1, 1.9]) st.box(0.1, 0.5, 0.95, sx * 1.2, 2.35, wz, COL.glass);
    }
    st.box(1.5, 0.42, 0.14, 0, 2.4, 3.18, COL.glass, 0, -0.55);
    st.strut(-0.55, 0.7, 2.9, 0, 0.58, 4.5, 0.09, COL.metal);
    st.strut(0.55, 0.7, 2.9, 0, 0.58, 4.5, 0.09, COL.metal);
    st.rod(0, 0.6, 4.3, 0, -0.2, 4.3, 0.05, 0.05, COL.metal, 6);
    for (const x of [-0.18, 0.18]) st.rod(x, 0.7, 3.75, x, 1.25, 3.75, 0.16, 0.16, 0xe8e2d6, 8);
    const ta = toWorld(TX - Math.sin(TYAW) * 2.2, TZ - Math.cos(TYAW) * 2.2);
    const tb = toWorld(TX + Math.sin(TYAW) * 2.2, TZ + Math.cos(TYAW) * 2.2);
    this.solidSegment(ta, tb, 1.35);
    this.reserve(...toWorld(TX, TZ), 4.2, false);

    // --- water tank on legs
    const KX = 1.5;
    const KZ = -8.5;
    st.frame.copy(frameAt(KX, KZ, 0.4));
    tin.frame.copy(st.frame);
    const corner = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corner[f];
      const [bx, bz] = corner[(f + 1) % 4];
      st.strut(ax * 1.15, -0.3, az * 1.15, ax * 0.85, 3.0, az * 0.85, 0.12, COL.weathered);
      st.strut(ax * 1.12, 0.2, az * 1.12, bx * 0.88, 2.7, bz * 0.88, 0.06, COL.weathered);
      st.strut(bx * 1.12, 0.2, bz * 1.12, ax * 0.88, 2.7, az * 0.88, 0.06, COL.weathered);
    }
    st.box(2.2, 0.14, 2.2, 0, 3.05, 0, COL.weathered);
    tin.add(new THREE.CylinderGeometry(1.3, 1.3, 2.1, 16), _m.makeTranslation(0, 4.17, 0), 0xc9c3b8, 7, 1.8);
    tin.add(new THREE.CylinderGeometry(0.06, 1.42, 0.6, 16), _m.makeTranslation(0, 5.52, 0), 0xb5afa3, 7, 1);
    st.rod(0.6, 3.1, 0.6, 0.6, -0.2, 0.6, 0.06, 0.06, COL.metal, 6);
    this.solidCircle(...toWorld(KX, KZ), 1.6);
    this.reserve(...toWorld(KX, KZ), 2.2, false);

    // --- windmill water pump behind the yard
    const WX = 1;
    const WZ = -17.5;
    const wy = ground(WX, WZ);
    st.frame.copy(frameAt(WX, WZ, 0.3, wy));
    tin.frame.copy(st.frame);
    const B = 1.6;
    const TOPY = 11.4;
    const leg = (sx: number, sz: number, y: number): [number, number, number] => {
      const half = B + ((0.3 - B) * y) / TOPY;
      return [sx * half, y, sz * half];
    };
    const levels = [0.2, 2.6, 4.9, 7.0, 9.0, 10.6];
    for (let f = 0; f < 4; f++) {
      const [ax, az] = corner[f];
      const [bx, bz] = corner[(f + 1) % 4];
      st.strut(...leg(ax, az, -0.3), ...leg(ax, az, TOPY + 0.1), 0.11, COL.steel);
      for (let l = 0; l < levels.length; l++) {
        st.strut(...leg(ax, az, levels[l]), ...leg(bx, bz, levels[l]), 0.07, COL.steel);
        if (l === 0) continue;
        st.strut(...leg(ax, az, levels[l - 1]), ...leg(bx, bz, levels[l]), 0.05, COL.steel);
        st.strut(...leg(bx, bz, levels[l - 1]), ...leg(ax, az, levels[l]), 0.05, COL.steel);
      }
    }
    st.box(1.5, 0.08, 1.5, 0, TOPY + 0.1, 0, COL.steel);
    st.rod(0, 0.3, 0, 0, TOPY + 0.4, 0, 0.035, 0.035, COL.steel, 5);
    st.box(0.35, 0.8, 0.35, 0, 0.4, 0, COL.metal);
    st.rod(0.15, 0.55, 0, 1.6, 0.55, 0, 0.05, 0.05, COL.metal, 6);
    tin.box(2.4, 0.5, 0.8, 2.6, 0.25, 0, 0x9d978c);
    const [mx, mz] = toWorld(WX, WZ);
    this.buildWindmillHead(mx, wy + TOPY + 0.35, mz);
    this.solidCircle(mx, mz, 2.1);
    this.reserve(mx, mz, 2.6, false);

    // --- crates and barrels
    for (const b of [st, pl]) b.frame.copy(siteM);
    const crate = (lx: number, lz: number, size: number, ry: number, stack = 0) =>
      pl.box(size, size, size, lx, ground(lx, lz) + size / 2 + stack - 0.03, lz, 0x9a7f60, ry);
    crate(0.4, 1.8, 1.0, 0.2);
    crate(0.45, 1.75, 0.75, 0.75, 1.0);
    crate(1.6, 2.3, 0.85, -0.3);
    this.solidCircle(...toWorld(0.9, 2.0), 1.1);
    for (const [lx, lz, color] of [[-8.6, -3.1, 0x8a3b26], [-8.5, -2.2, 0x35566e], [9.6, 5.2, 0x8a3b26]]) {
      const gy = ground(lx, lz);
      st.rod(lx, gy - 0.05, lz, lx, gy + 0.9, lz, 0.32, 0.32, color, 10);
      for (const y of [0.25, 0.65]) st.rod(lx, gy + y, lz, lx, gy + y + 0.05, lz, 0.335, 0.335, 0x2c2622, 10);
      this.solidCircle(...toWorld(lx, lz), 0.45);
      this.reserve(...toWorld(lx, lz), 0.8, false);
    }
    this.reserve(...toWorld(0.9, 2.0), 1.4, false);

    // --- wire fence around the yard, open towards the road
    const fence: [number, number][] = [[0.5, 8], [-14, 8], [-14, -12], [12, -12], [12, 8], [6, 8]];
    let prev: THREE.Vector3[] | null = null;
    for (let i = 0; i < fence.length - 1; i++) {
      const [ax, az] = fence[i];
      const [bx, bz] = fence[i + 1];
      const posts = Math.ceil(Math.hypot(bx - ax, bz - az) / 2.6);
      for (let p = i === 0 ? 0 : 1; p <= posts; p++) {
        const lx = ax + ((bx - ax) * p) / posts;
        const lz = az + ((bz - az) * p) / posts;
        const gy = ground(lx, lz);
        const tx = lx + (rand() - 0.5) * 0.14;
        const tz = lz + (rand() - 0.5) * 0.14;
        const top = gy + 1.3 + rand() * 0.1;
        st.rod(lx, gy - 0.3, lz, tx, top, tz, 0.07, 0.06, COL.weathered, 5);
        const attach = [0.45, 0.8, 1.15].map((h) => {
          const t = (h + 0.3) / (top - gy + 0.3);
          const [wx, wz] = toWorld(lx + (tx - lx) * t, lz + (tz - lz) * t);
          return new THREE.Vector3(wx, gy + h, wz);
        });
        if (prev) for (let w = 0; w < 3; w++) this.wire(prev[w], attach[w], 0.05 + rand() * 0.04, 4);
        prev = attach;
      }
      this.solidSegment(toWorld(ax, az), toWorld(bx, bz), 0.2);
    }

    this.add(st.mesh(mats.struct));
    this.add(pl.mesh(mats.plank));
    this.add(tin.mesh(mats.tin));
    this.add(chrome.mesh(mats.chrome));
    // Rocks and trees keep out of the whole homestead; grass may grow in the yard.
    this.reserve(...toWorld(-1, -5), 20, true);
  }

  /** Weathered plank shack (floor at y = 0 of the builders' frame), porch, tin roof, stove pipe. */
  private buildShack(st: Builder, pl: Builder, tin: Builder, foot: number): void {
    const { w: W, d: D, h: H, roof: RH, porch: PD } = SHACK;
    const wall = 0xa48e76;
    const wallDark = 0x7a6552;
    const roofC = 0xc4beb2;
    const base = st.frame.clone();

    st.box(W + 0.1, -foot, D + 0.1, 0, foot / 2, 0, 0x5c4b3c);
    pl.box(W, H, D, 0, H / 2, 0, wall);
    pl.add(prismGeometry(D, RH, W), _m.makeTranslation(0, H, 0), wall);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) st.box(0.16, H, 0.16, (sx * W) / 2, H / 2, (sz * D) / 2, COL.trim);
    st.box(W + 0.12, 0.14, D + 0.12, 0, H - 0.05, 0, COL.trim);

    // Gable roof: two corrugated panels with overhang and a ridge cap.
    const ang = Math.atan2(RH, D / 2);
    const len = Math.hypot(RH, D / 2) + 0.55;
    const off = len / 2 - 0.12;
    for (const side of [-1, 1]) {
      tin.box(W + 0.9, 0.07, len, 0, H + RH + 0.06 - Math.sin(ang) * off, side * Math.cos(ang) * off, roofC, 0, side * ang);
    }
    tin.box(W + 0.95, 0.1, 0.34, 0, H + RH + 0.1, 0, 0x8f8a80);

    // Porch: deck on stilts, posts, beam, lean-to roof, rail and steps.
    const postZ = D / 2 + PD - 0.15;
    pl.box(W + 0.4, 0.16, PD, 0, -0.08, D / 2 + PD / 2, wallDark);
    for (const sx of [-1, 0, 1]) {
      const x = sx * (W / 2 + 0.05);
      st.box(0.16, 2.55, 0.16, x, 1.27, postZ, COL.trim);
      st.box(0.14, -foot, 0.14, x, foot / 2 - 0.1, postZ, COL.trim);
    }
    st.box(W + 0.5, 0.16, 0.18, 0, 2.55, postZ, COL.trim);
    const pAng = Math.atan2(0.5, PD + 0.4);
    tin.box(W + 0.7, 0.06, Math.hypot(0.5, PD + 0.4), 0, 2.78, D / 2 + (PD + 0.4) / 2, roofC, 0, pAng);
    for (const y of [0.5, 0.95]) st.box(0.08, 0.08, PD - 0.2, -W / 2 - 0.05, y, D / 2 + PD / 2, COL.trim);
    pl.box(1.3, 0.5, 0.4, -1.3, -0.42, D / 2 + PD + 0.2, wallDark);
    pl.box(1.3, 0.5, 0.4, -1.3, -0.59, D / 2 + PD + 0.6, wallDark);
    pl.box(1.5, 0.08, 0.4, 1.5, 0.45, D / 2 + 0.3, wallDark);
    st.box(1.4, 0.42, 0.06, 1.5, 0.21, D / 2 + 0.3, COL.trim);

    // Door with frame.
    pl.box(0.95, 2.05, 0.08, -1.3, 1.03, D / 2 + 0.03, 0x6b5442);
    st.box(1.17, 0.1, 0.1, -1.3, 2.1, D / 2 + 0.04, COL.trim);
    for (const dx of [-0.53, 0.53]) st.box(0.1, 2.1, 0.1, -1.3 + dx, 1.05, D / 2 + 0.04, COL.trim);

    // Windows (one boarded up).
    const windowAt = (x: number, y: number, z: number, ry: number, boarded: boolean) => {
      _m3.makeRotationY(ry).setPosition(x, y, z);
      st.frame.multiplyMatrices(base, _m3);
      pl.frame.copy(st.frame);
      st.box(0.9, 0.8, 0.06, 0, 0, 0, COL.glass);
      for (const sy of [-1, 1]) st.box(1.06, 0.09, 0.1, 0, sy * 0.45, 0.02, COL.frame);
      for (const sx of [-1, 1]) st.box(0.09, 0.9, 0.1, sx * 0.49, 0, 0.02, COL.frame);
      st.box(0.05, 0.8, 0.07, 0, 0, 0.02, COL.frame);
      st.box(0.9, 0.05, 0.07, 0, 0, 0.02, COL.frame);
      if (boarded) for (const rz of [-0.35, 0.3]) pl.box(1.25, 0.18, 0.05, 0, rz * 0.3, 0.08, wallDark, 0, 0, rz);
    };
    windowAt(1.4, 1.75, D / 2 + 0.02, 0, false);
    windowAt(W / 2 + 0.02, 1.75, 0, Math.PI / 2, false);
    windowAt(-W / 2 - 0.02, 1.75, 0.3, -Math.PI / 2, true);
    windowAt(0.8, 1.75, -D / 2 - 0.02, Math.PI, false);
    st.frame.copy(base);
    pl.frame.copy(base);

    // Stove pipe through the back slope.
    st.rod(1.7, H + 0.5, -1.0, 1.7, H + RH + 1.5, -1.0, 0.11, 0.11, COL.metal, 8);
    st.rod(1.7, H + RH + 1.5, -1.0, 1.7, H + RH + 1.7, -1.0, 0.2, 0.2, COL.metal, 8);
  }

  /** Rotor (16 pitched blades between two rings) and tail vane, both animated in update(). */
  private buildWindmillHead(x: number, y: number, z: number): void {
    const head = new THREE.Group();
    head.position.set(x, y, z);
    head.rotation.y = WIND_YAW + Math.PI; // rotor into the wind, vane downwind
    const hb = new Builder();
    hb.box(0.45, 0.42, 1.0, 0, 0, 0, COL.metal);
    hb.rod(0, 0, 0.45, 0, 0, 0.75, 0.09, 0.09, COL.metal, 8);
    hb.strut(0, 0.05, -0.4, 0, 0.14, -3.0, 0.08, COL.steel);
    hb.strut(0, -0.18, -0.3, 0, 0.1, -2.0, 0.05, COL.steel);
    hb.box(0.03, 1.1, 1.7, 0, 0.32, -3.6, 0xb9b3a8);
    const headMesh = hb.mesh(this.mats.struct);

    const rb = new Builder();
    const blades = 16;
    for (let k = 0; k < blades; k++) {
      const a = (k / blades) * Math.PI * 2;
      _m.makeRotationZ(a).multiply(_m2.makeTranslation(0, 1.35, 0)).multiply(_m3.makeRotationY(0.45));
      rb.add(new THREE.BoxGeometry(0.46, 1.45, 0.025), _m, 0xc9c6bf);
      const a2 = ((k + 1) / blades) * Math.PI * 2;
      for (const r of [0.62, 2.08]) {
        rb.strut(-Math.sin(a) * r, Math.cos(a) * r, 0, -Math.sin(a2) * r, Math.cos(a2) * r, 0, 0.045, COL.steel);
      }
      if (k % 2 === 0) rb.strut(0, 0, 0, -Math.sin(a) * 0.62, Math.cos(a) * 0.62, 0, 0.05, COL.steel);
    }
    rb.rod(0, 0, -0.1, 0, 0, 0.2, 0.16, 0.16, COL.metal, 8);
    const rotor = rb.mesh(this.mats.struct);
    rotor.position.z = 0.8;
    head.add(headMesh, rotor);
    this.add(head);
    this.head = head;
    this.rotor = rotor;
  }

  // ---------------------------------------------------------------- telegraph line

  /** Wooden poles with cross-arms ~10 m off the road edge, three sagging wires between them. */
  private buildTelegraphLine(): void {
    const { track, terrain, rand } = this;
    const n = track.samples.length;
    const b = new Builder();
    let prev: THREE.Vector3[] | null = null;
    const spots: [number, number][] = [];
    for (let i = Math.round(n * 0.56); i <= Math.round(n * 0.87); i += 15) {
      const s = track.at(i);
      // Outside of the loop (left of the driving direction); step further out on tight bends.
      let lat = 16;
      let x = s.x + s.tz * lat;
      let z = s.z - s.tx * lat;
      while (this.roadDist(x, z) < 13 && lat < 30) {
        lat += 2;
        x = s.x + s.tz * lat;
        z = s.z - s.tx * lat;
      }
      if (this.roadDist(x, z) < SOLID_CLEAR + 1 || !this.isFree(x, z, 1.5, false)) continue;
      if (terrain.heightAt(x, z) < SEA_LEVEL + 0.4) continue;
      spots.push([x, z]);
    }
    for (let k = 0; k < spots.length; k++) {
      const [x, z] = spots[k];
      const [px, pz] = spots[Math.max(0, k - 1)];
      const [nx, nz] = spots[Math.min(spots.length - 1, k + 1)];
      const yaw = Math.atan2(nx - px, nz - pz); // cross-arm square to the line
      _e.set((rand() - 0.5) * 0.06, yaw, (rand() - 0.5) * 0.06, "YXZ");
      b.frame.makeRotationFromEuler(_e).setPosition(x, terrain.heightAt(x, z), z);
      b.rod(0, -0.5, 0, 0, 8.1, 0, 0.17, 0.13, 0x5c4a3a, 7);
      b.box(2.5, 0.14, 0.14, 0, 7.4, 0, 0x6a5440);
      for (const sx of [-1, 1]) {
        b.strut(sx * 0.75, 7.34, 0, 0, 6.75, 0, 0.06, 0x6a5440);
        b.rod(sx * 1.05, 7.47, 0, sx * 1.05, 7.67, 0, 0.05, 0.05, 0xd8d4c8, 6);
      }
      b.rod(0, 8.1, 0, 0, 8.28, 0, 0.05, 0.05, 0xd8d4c8, 6);
      const attach = [
        new THREE.Vector3(-1.05, 7.67, 0),
        new THREE.Vector3(1.05, 7.67, 0),
        new THREE.Vector3(0, 8.28, 0),
      ].map((p) => p.applyMatrix4(b.frame));
      if (prev) {
        const span = prev[0].distanceTo(attach[0]);
        for (let w = 0; w < 3; w++) this.wire(prev[w], attach[w], 0.03 * span, 10);
      }
      prev = attach;
      this.solidCircle(x, z, 0.4);
      this.reserve(x, z, 1.2, false);
    }
    this.add(b.mesh(this.mats.struct));
  }

  // ---------------------------------------------------------------- rocks & trees

  /** Faceted sandstone boulders, some in clusters, never near the road. 4 instanced variants. */
  private buildRocks(): void {
    const { track, terrain, rand } = this;
    const n = track.samples.length;
    const variants = [
      rockGeometry(11, 0, 1.2, 0.75, 1.0, 0.25, 1),
      rockGeometry(12, 0, 1.0, 0.95, 0.9, 0.3, 1),
      rockGeometry(13, 1, 1.3, 0.6, 1.1, 0.18, 1),
      rockGeometry(14, -1, 1.0, 0.85, 1.05, 0.2, 0.6),
    ];
    const placed: THREE.Matrix4[][] = variants.map(() => []);
    const tints: THREE.Color[][] = variants.map(() => []);
    const nrm = new THREE.Vector3();

    const place = (x: number, z: number, size: number): boolean => {
      if (Math.abs(x) > HALF_WORLD - 20 || z > HALF_WORLD - 20) return false;
      if (z < terrain.shorelineZ(x) + 24 || terrain.heightAt(x, z) < 1) return false;
      const sx = size * (0.85 + rand() * 0.35);
      const sz = size * (0.85 + rand() * 0.35);
      const r = Math.max(sx, sz) * 0.95;
      const solid = size >= 0.5;
      if (this.roadDist(x, z) < (solid ? SOLID_CLEAR + r : ROAD_HALF_WIDTH + 2 + r)) return false;
      if (!this.isFree(x, z, r, false)) return false;
      terrain.normalAt(x, z, nrm).lerp(UP, 0.4).normalize();
      _q.setFromUnitVectors(UP, nrm).multiply(_q2.setFromAxisAngle(UP, rand() * Math.PI * 2));
      const v = Math.floor(rand() * variants.length);
      _v.set(x, terrain.heightAt(x, z) - size * 0.25, z);
      placed[v].push(new THREE.Matrix4().compose(_v, _q, _v2.set(sx, size * (0.75 + rand() * 0.4), sz)));
      const tone = 0.86 + rand() * 0.2;
      tints[v].push(new THREE.Color(tone, tone * (0.97 + rand() * 0.04), tone * (0.93 + rand() * 0.06)));
      if (solid) this.solidCircle(x, z, r);
      this.reserve(x, z, r, false);
      return true;
    };

    let count = 0;
    for (let tries = 0; count < 80 && tries < 3000; tries++) {
      const s = track.at(Math.floor(rand() * n));
      const side = rand() < 0.5 ? -1 : 1;
      const lat = 12 + Math.pow(rand(), 1.3) * 58;
      const cx = s.x - s.tz * lat * side;
      const cz = s.z + s.tx * lat * side;
      const big = 0.45 + Math.pow(rand(), 1.4) * 1.55;
      if (!place(cx, cz, big)) continue;
      count++;
      // Some boulders come with a few smaller companions.
      const extra = rand() < 0.4 ? 1 + Math.floor(rand() * 3) : 0;
      for (let k = 0; k < extra; k++) {
        const a = rand() * Math.PI * 2;
        const d = big * (1.4 + rand() * 1.6);
        if (place(cx + Math.cos(a) * d, cz + Math.sin(a) * d, big * (0.25 + rand() * 0.4) + 0.15)) count++;
      }
    }

    variants.forEach((geo, v) => {
      const mesh = new THREE.InstancedMesh(geo, this.mats.struct, placed[v].length);
      placed[v].forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        mesh.setColorAt(i, tints[v][i]);
      });
      mesh.castShadow = mesh.receiveShadow = true;
      this.add(mesh);
    });
  }

  /** ~10 bare, branching dead trees (one merged mesh). */
  private buildDeadTrees(): void {
    const { track, terrain, rand } = this;
    const n = track.samples.length;
    const b = new Builder();
    const color = 0x5a4a3c;
    const dir = new THREE.Vector3();

    const branch = (from: THREE.Vector3, d: THREE.Vector3, len: number, r: number, depth: number) => {
      const to = from.clone().addScaledVector(d, len);
      b.rod(from.x, from.y, from.z, to.x, to.y, to.z, r, r * 0.65, color, depth < 2 ? 6 : 4);
      if (depth >= 3 || len < 0.35) return;
      const kids = depth === 0 ? 3 : 2 + (rand() < 0.4 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        // Bend away from the parent around a random horizontal axis, keep a slight upward pull.
        const axis = new THREE.Vector3(rand() - 0.5, 0, rand() - 0.5).normalize();
        const nd = d.clone().applyAxisAngle(axis, 0.35 + rand() * 0.55);
        nd.y += 0.25;
        branch(to, nd.normalize(), len * (0.55 + rand() * 0.25), r * 0.62, depth + 1);
      }
    };

    let placed = 0;
    for (let tries = 0; placed < 10 && tries < 800; tries++) {
      const s = track.at(Math.floor(rand() * n));
      const side = rand() < 0.5 ? -1 : 1;
      const lat = 13 + rand() * 35;
      const x = s.x - s.tz * lat * side;
      const z = s.z + s.tx * lat * side;
      if (z < terrain.shorelineZ(x) + 50 || Math.abs(x) > HALF_WORLD - 25 || z > HALF_WORLD - 25) continue;
      if (this.roadDist(x, z) < SOLID_CLEAR + 1 || !this.isFree(x, z, 3, false)) continue;
      const h = 2.6 + rand() * 1.8;
      dir.set((rand() - 0.5) * 0.25, 1, (rand() - 0.5) * 0.25).normalize();
      branch(new THREE.Vector3(x, terrain.heightAt(x, z) - 0.2, z), dir, h * 0.5, 0.17 + rand() * 0.06, 0);
      this.solidCircle(x, z, 0.4);
      this.reserve(x, z, 1, false);
      this.reserve(x, z, 3, true);
      placed++;
    }
    this.add(b.mesh(this.mats.struct));
  }

  // ---------------------------------------------------------------- vegetation

  /** Spiky dry tufts and dune grass in clumps: densest on the beach dunes and at the road edges. */
  private buildVegetation(): void {
    const { track, terrain, rand } = this;
    const n = track.samples.length;
    const kinds = [
      { geo: tuftGeometry(rng(5), 11, false), list: [] as THREE.Matrix4[], max: 520 },
      { geo: tuftGeometry(rng(9), 13, true), list: [] as THREE.Matrix4[], max: 380 },
    ];
    const nearRoad: [number, number][] = []; // [kind, index] of tufts that wobble when hit
    const nrm = new THREE.Vector3();

    const plant = (x: number, z: number, kind: number): void => {
      const k = kinds[kind];
      if (k.list.length >= k.max) return;
      const h = terrain.heightAt(x, z);
      const dist = this.roadDist(x, z);
      if (h < SEA_LEVEL + 0.5 || dist < ROAD_HALF_WIDTH + 1.4 || !this.isFree(x, z, 0.4, true)) return;
      terrain.normalAt(x, z, nrm).lerp(UP, 0.4).normalize();
      _q.setFromUnitVectors(UP, nrm).multiply(_q2.setFromAxisAngle(UP, rand() * Math.PI * 2));
      const sc = 1.0 + rand() * 0.9;
      _v2.set(sc, sc * (0.8 + rand() * 0.4), sc);
      if (dist < 11.5 && nearRoad.length < 130) nearRoad.push([kind, k.list.length]);
      k.list.push(new THREE.Matrix4().compose(_v.set(x, h - 0.05, z), _q, _v2));
    };

    for (let tries = 0; tries < 20000; tries++) {
      if (kinds[0].list.length >= kinds[0].max && kinds[1].list.length >= kinds[1].max) break;
      let x: number;
      let z: number;
      if (rand() < 0.65) {
        const s = track.at(Math.floor(rand() * n));
        const lat = (7.6 + Math.pow(rand(), 2) * 32) * (rand() < 0.5 ? -1 : 1);
        x = s.x - s.tz * lat;
        z = s.z + s.tx * lat;
      } else {
        x = -150 + rand() * 240; // the dunes above the beach stretch of the road
        z = terrain.shorelineZ(x) + 16 + rand() * 80;
      }
      if (Math.abs(x) > HALF_WORLD - 12 || Math.abs(z) > HALF_WORLD - 12) continue;
      const dz = z - terrain.shorelineZ(x);
      const beach = smoothstep(16, 30, dz) * (1 - smoothstep(65, 100, dz));
      const edge = 1 - smoothstep(9, 18, this.roadDist(x, z));
      const patch = smoothstep(-0.3, 0.3, fbm(x * 0.035, z * 0.035, 3, 77));
      const density = (0.12 + 0.8 * edge + 0.9 * beach) * (0.3 + 0.7 * patch);
      if (rand() > density) continue;
      // A clump: bigger where the ground is lush.
      const kind = rand() < 0.25 + beach * 0.55 ? 1 : 0;
      const size = 1 + Math.floor(rand() * (1 + 3.5 * Math.min(1, density)));
      for (let k = 0; k < size; k++) {
        const a = rand() * Math.PI * 2;
        const d = k === 0 ? 0 : 0.6 + rand() * 1.4;
        plant(x + Math.cos(a) * d, z + Math.sin(a) * d, rand() < 0.8 ? kind : 1 - kind);
      }
    }

    const meshes = kinds.map((k) => {
      const mesh = new THREE.InstancedMesh(k.geo, this.mats.grass, k.list.length);
      k.list.forEach((m, i) => {
        mesh.setMatrixAt(i, m);
        const tone = 0.8 + rand() * 0.35;
        mesh.setColorAt(i, _c.setRGB(tone, tone, tone * 0.95));
      });
      mesh.castShadow = mesh.receiveShadow = true;
      return this.add(mesh);
    });
    for (const [kind, index] of nearRoad) {
      const m = kinds[kind].list[index];
      const id = this.wobbles.add([meshes[kind]], index, m);
      _v.setFromMatrixPosition(m);
      this.colliders.push({ kind: "circle", x: _v.x, z: _v.z, r: 0.45, solid: false, id });
    }
  }

  // ---------------------------------------------------------------- birds

  /** Gulls circling over the beach and a few crows around the homestead. */
  private buildBirds(site: Site): void {
    const { terrain, rand } = this;
    const gulls = 7;
    const crows = 3;
    const count = gulls + crows;
    const geo = birdGeometry();
    const params = new Float32Array(count * 3);
    const mesh = new THREE.InstancedMesh(geo, this.mats.bird, count);
    for (let i = 0; i < count; i++) {
      const gull = i < gulls;
      const dirSign = rand() < 0.5 ? -1 : 1;
      if (gull) {
        const cx = (rand() * 2 - 1) * 170;
        this.birds.push({
          cx,
          cz: terrain.shorelineZ(cx) - 30 + rand() * 40,
          y: SEA_LEVEL + 9 + rand() * 7,
          radius: 10 + rand() * 16,
          speed: dirSign * (0.25 + rand() * 0.2),
          phase: rand() * Math.PI * 2,
          wander: 20,
          scale: 1.3,
        });
      } else {
        const cx = site.x + (rand() - 0.5) * 16;
        const cz = site.z - 6 + (rand() - 0.5) * 16;
        this.birds.push({
          cx,
          cz,
          y: terrain.heightAt(cx, cz) + 6 + rand() * 4,
          radius: 6 + rand() * 4,
          speed: dirSign * (0.55 + rand() * 0.2),
          phase: rand() * Math.PI * 2,
          wander: 4,
          scale: 1.0,
        });
      }
      params.set([rand() * Math.PI * 2, gull ? 5.5 : 9, gull ? 1 : 0], i * 3);
      mesh.setColorAt(i, _c.set(gull ? 0xf4f2ee : 0x262321));
    }
    geo.setAttribute("aBird", new THREE.InstancedBufferAttribute(params, 3));
    mesh.frustumCulled = false; // instances move every frame
    mesh.castShadow = true;
    this.birdMesh = this.add(mesh);
    this.updateBirds(0);
  }

  private updateBirds(time: number): void {
    const mesh = this.birdMesh;
    for (let i = 0; i < this.birds.length; i++) {
      const b = this.birds[i];
      const a = b.phase + time * b.speed;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const turn = Math.sign(b.speed);
      const cx = b.cx + Math.sin(time * 0.05 + b.phase) * b.wander;
      const cz = b.cz + Math.cos(time * 0.037 + b.phase * 1.3) * b.wander * 0.6;
      // Heading along the circle, banked towards its centre.
      _e.set(0, Math.atan2(-sa * turn, ca * turn), 0.3 * turn, "YXZ");
      _v.set(cx + ca * b.radius, b.y + Math.sin(time * 0.4 + b.phase) * 1.2, cz + sa * b.radius);
      _m.compose(_v, _q.setFromEuler(_e), _v2.setScalar(b.scale));
      mesh.setMatrixAt(i, _m);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------ wobble springs

const _wq = new THREE.Quaternion();
const _wa = new THREE.Vector3();
const _wm = new THREE.Matrix4();

interface WobbleTarget {
  meshes: THREE.InstancedMesh[];
  index: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  scale: THREE.Vector3;
  angle: number;
  vel: number;
  ax: number;
  az: number;
}

/** Spring-damped tilt (about the base) of instanced props the car brushes: flags, tufts. */
class Wobbles {
  private readonly targets: WobbleTarget[] = [];

  /** Registers instance `index` of `meshes` (all sharing `matrix`); returns its collider id. */
  add(meshes: THREE.InstancedMesh[], index: number, matrix: THREE.Matrix4): number {
    const t: WobbleTarget = {
      meshes,
      index,
      pos: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      scale: new THREE.Vector3(),
      angle: 0,
      vel: 0,
      ax: 1,
      az: 0,
    };
    matrix.decompose(t.pos, t.quat, t.scale);
    for (const m of meshes) m.setMatrixAt(index, matrix);
    this.targets.push(t);
    return this.targets.length - 1;
  }

  hit(id: number, strength: number, fromX: number, fromZ: number): void {
    const t = this.targets[id];
    if (!t) return;
    const dx = t.pos.x - fromX;
    const dz = t.pos.z - fromZ;
    const l = Math.hypot(dx, dz) || 1;
    // Axis square to the push: a positive angle tips the top away from the car.
    t.ax = dz / l;
    t.az = -dx / l;
    t.vel = Math.min(t.vel + 1.5 + strength * 4, 6);
  }

  update(dt: number): void {
    const h = Math.min(dt, 1 / 30);
    for (const t of this.targets) {
      if (t.angle === 0 && t.vel === 0) continue;
      t.vel += (-70 * t.angle - 6 * t.vel) * h;
      t.angle = clamp(t.angle + t.vel * h, -0.7, 0.7);
      if (Math.abs(t.angle) < 0.002 && Math.abs(t.vel) < 0.02) t.angle = t.vel = 0;
      _wq.setFromAxisAngle(_wa.set(t.ax, 0, t.az), t.angle).multiply(t.quat);
      _wm.compose(t.pos, _wq, t.scale);
      for (const m of t.meshes) {
        m.setMatrixAt(t.index, _wm);
        m.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

// ------------------------------------------------------------------ geometry

const _bm = new THREE.Matrix4();
const _bn = new THREE.Matrix3();
const _bp = new THREE.Vector3();
const _bv = new THREE.Vector3();
const _bd = new THREE.Vector3();
const _bq = new THREE.Quaternion();
const _bc = new THREE.Color();
const _pm = new THREE.Matrix4();
const _pe = new THREE.Euler();

/**
 * Merges many transformed, vertex-coloured parts into one geometry so a whole cluster (gantry,
 * homestead, a pole line...) costs one draw call. Parts are given in `frame` coordinates.
 * With `tile` > 0 UVs are box-projected at `tile` metres per texture repeat.
 */
class Builder {
  readonly frame = new THREE.Matrix4();
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] = [];

  constructor(private readonly tile = 0) {}

  /** Adds `geo` transformed by `local`; uvU/uvV > 0 keep the geometry's own UVs, scaled. */
  add(geo: THREE.BufferGeometry, local: THREE.Matrix4, color: THREE.ColorRepresentation, uvU = 0, uvV = 0): void {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    const uv = g.getAttribute("uv");
    _bm.multiplyMatrices(this.frame, local);
    _bn.getNormalMatrix(_bm);
    _bc.set(color);
    const t = this.tile;
    for (let i = 0; i < p.count; i++) {
      _bp.fromBufferAttribute(p, i);
      _bv.fromBufferAttribute(n, i);
      if (uvU > 0) {
        this.uv.push(uv.getX(i) * uvU, uv.getY(i) * uvV);
      } else if (t > 0) {
        const ax = Math.abs(_bv.x);
        const ay = Math.abs(_bv.y);
        const az = Math.abs(_bv.z);
        if (ax >= ay && ax >= az) this.uv.push(_bp.z / t, _bp.y / t);
        else if (ay >= az) this.uv.push(_bp.x / t, _bp.z / t);
        else this.uv.push(_bp.x / t, _bp.y / t);
      } else {
        this.uv.push(0, 0);
      }
      _bp.applyMatrix4(_bm);
      _bv.applyMatrix3(_bn).normalize();
      this.pos.push(_bp.x, _bp.y, _bp.z);
      this.nor.push(_bv.x, _bv.y, _bv.z);
      this.col.push(_bc.r, _bc.g, _bc.b);
    }
  }

  /** Box w×h×d centred at (x, y, z), rotated (order YXZ). */
  box(
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    color: THREE.ColorRepresentation,
    ry = 0, rx = 0, rz = 0,
  ): void {
    _pm.makeRotationFromEuler(_pe.set(rx, ry, rz, "YXZ")).setPosition(x, y, z);
    this.add(new THREE.BoxGeometry(w, h, d), _pm, color);
  }

  /** Square beam of thickness t from a to b. */
  strut(ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number, color: THREE.ColorRepresentation): void {
    const len = this.orient(ax, ay, az, bx, by, bz);
    this.add(new THREE.BoxGeometry(t, len, t), _pm, color);
  }

  /** Cylinder from a (radius r0) to b (radius r1). */
  rod(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    r0: number, r1: number,
    color: THREE.ColorRepresentation,
    seg = 6,
  ): void {
    const len = this.orient(ax, ay, az, bx, by, bz);
    this.add(new THREE.CylinderGeometry(r1, r0, len, seg), _pm, color);
  }

  /** Sets _pm to a transform taking the unit +Y axis onto a→b (centred); returns the length. */
  private orient(ax: number, ay: number, az: number, bx: number, by: number, bz: number): number {
    _bd.set(bx - ax, by - ay, bz - az);
    const len = _bd.length() || 1e-4;
    _bq.setFromUnitVectors(UP, _bd.divideScalar(len));
    _pm.compose(_bp.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _bq, ONE);
    return len;
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.computeBoundingSphere();
    return g;
  }

  mesh(material: THREE.Material, castShadow = true): THREE.Mesh {
    const mesh = new THREE.Mesh(this.geometry(), material);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    return mesh;
  }
}

/** Gable prism: base width w (along z), height h, length l (along x), base at y = 0. */
function prismGeometry(w: number, h: number, l: number): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(1, 1, 1, 3);
  g.rotateX(-Math.PI / 2); // axis along z, apex up
  g.scale(w / Math.sqrt(3), h / 1.5, l);
  g.translate(0, h / 3, 0);
  g.rotateY(Math.PI / 2);
  return g;
}

/**
 * Jittered low-poly boulder with flat facets (lighter on top). detail < 0 = dodecahedron.
 * Vertices shared between faces move together so the shell stays closed.
 */
function rockGeometry(
  seed: number, detail: number,
  sx: number, sy: number, sz: number,
  jitter: number, flatTop: number,
): THREE.BufferGeometry {
  const r = rng(seed);
  const g = detail < 0 ? new THREE.DodecahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute("position");
  const offsets = new Map<string, number>();
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const key = `${Math.round(x * 1e3)},${Math.round(y * 1e3)},${Math.round(z * 1e3)}`;
    let f = offsets.get(key);
    if (f === undefined) offsets.set(key, (f = 1 + (r() * 2 - 1) * jitter));
    p.setXYZ(i, x * f * sx, clamp(y * f, -0.4, flatTop) * sy, z * f * sz);
  }
  g.computeVertexNormals(); // non-indexed: one normal per facet
  const n = g.getAttribute("normal");
  const colors = new Float32Array(p.count * 3);
  const side = new THREE.Color(0xc9a982);
  const top = new THREE.Color(0xe6d0aa);
  for (let i = 0; i < p.count; i += 3) {
    const ny = (n.getY(i) + n.getY(i + 1) + n.getY(i + 2)) / 3;
    _c.copy(side).lerp(top, smoothstep(0.2, 0.85, ny)).multiplyScalar(0.92 + r() * 0.14);
    for (let k = 0; k < 3; k++) colors.set([_c.r, _c.g, _c.b], (i + k) * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return g;
}

/**
 * Tuft of narrow blades radiating from the base: straight spikes (dry bush) or arched two-segment
 * blades (dune grass). Normals point up so the thin blades light like the ground around them.
 */
function tuftGeometry(r: () => number, blades: number, arched: boolean): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color(arched ? 0x6e5c38 : 0x3d3f22);
  const tip = new THREE.Color(arched ? 0xbca36c : 0x7a7444);
  const mid = base.clone().lerp(tip, 0.55);
  const vert = (x: number, y: number, z: number, c: THREE.Color) => {
    pos.push(x, y, z);
    col.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < blades; i++) {
    const a = (i / blades) * Math.PI * 2 + r() * 0.9;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const lean = 0.2 + r() * 0.8;
    const h = arched ? 0.7 + r() * 0.6 : 0.45 + r() * 0.5;
    const w = 0.05 + r() * 0.04;
    const px = -sa * w;
    const pz = ca * w;
    const bx = ca * 0.06 * r();
    const bz = sa * 0.06 * r();
    if (arched) {
      const mx = bx + ca * lean * h * 0.4;
      const my = h * 0.65;
      const mz = bz + sa * lean * h * 0.4;
      vert(bx - px, 0, bz - pz, base);
      vert(bx + px, 0, bz + pz, base);
      vert(mx + px * 0.6, my, mz + pz * 0.6, mid);
      vert(bx - px, 0, bz - pz, base);
      vert(mx + px * 0.6, my, mz + pz * 0.6, mid);
      vert(mx - px * 0.6, my, mz - pz * 0.6, mid);
      vert(mx - px * 0.6, my, mz - pz * 0.6, mid);
      vert(mx + px * 0.6, my, mz + pz * 0.6, mid);
      vert(bx + ca * lean * h * 1.05, h * (0.9 - lean * 0.5), bz + sa * lean * h * 1.05, tip);
    } else {
      vert(bx - px, 0, bz - pz, base);
      vert(bx + px, 0, bz + pz, base);
      vert(bx + ca * lean * h * 0.75, h * (1 - lean * 0.3), bz + sa * lean * h * 0.75, tip);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return g;
}

/** Flat bird: small body plus swept wings (x = span) that the shader flaps by |x|. */
function birdGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const white = new THREE.Color(0xffffff);
  const dark = new THREE.Color(0x4a4744);
  const tri = (a: number[], b: number[], c: number[], cc = white) => {
    pos.push(...a, ...b, ...c);
    col.push(white.r, white.g, white.b, white.r, white.g, white.b, cc.r, cc.g, cc.b);
  };
  tri([0, 0, 0.34], [0.07, 0, 0], [-0.07, 0, 0]);
  tri([0.07, 0, 0], [0, 0, -0.32], [-0.07, 0, 0]);
  for (const s of [-1, 1]) {
    tri([0.05 * s, 0, 0.12], [0.4 * s, 0, 0.08], [0.4 * s, 0, -0.12]);
    tri([0.05 * s, 0, 0.12], [0.4 * s, 0, -0.12], [0.05 * s, 0, -0.1]);
    tri([0.4 * s, 0, 0.08], [0.4 * s, 0, -0.12], [0.78 * s, 0, -0.2], dark);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
  const nor = new Float32Array(pos.length);
  for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  return g;
}

// ------------------------------------------------------------------ canvas textures

function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat = true): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  draw(canvas.getContext("2d")!);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  if (repeat) tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

/** Value noise that tiles with periods (px, py). */
function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (i: number, j: number) => hash2(((i % px) + px) % px, ((j % py) + py) % py, seed);
  const a = h(xi, yi);
  const b = h(xi + 1, yi);
  const c = h(xi, yi + 1);
  const d = h(xi + 1, yi + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

/** Corrugated sheet: `ribs` ribs per tile (varying along u), rust streaks running along v. */
function corrugatedTexture(ribs: number, rust: number): THREE.CanvasTexture {
  const size = 128;
  return canvasTexture(size, size, (g) => {
    const img = g.createImageData(size, size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size;
        const v = y / size;
        const val = 0.8 + Math.sin(u * ribs * Math.PI * 2) * 0.15 + (hash2(x, y, 3) - 0.5) * 0.05;
        const n = tileNoise(u * 8, v * 3, 8, 3, 11) * 0.65 + tileNoise(u * 16, v * 6, 16, 6, 12) * 0.35;
        const r = rust * smoothstep(0.55, 0.85, n);
        const o = (y * size + x) * 4;
        img.data[o] = 255 * (val * (1 - r) + 0.58 * val * r);
        img.data[o + 1] = 255 * (val * (1 - r) + 0.42 * val * r);
        img.data[o + 2] = 255 * (val * (1 - r) + 0.3 * val * r);
        img.data[o + 3] = 255;
      }
    }
    g.putImageData(img, 0, 0);
  });
}

/** Weathered vertical boards with grain, end joints and dark gaps (tinted by vertex colour). */
function plankTexture(r: () => number): THREE.CanvasTexture {
  return canvasTexture(256, 256, (g) => {
    for (let i = 0; i < 8; i++) {
      const x = i * 32;
      const tone = 165 + r() * 70;
      g.fillStyle = `rgb(${tone}, ${tone * 0.94}, ${tone * 0.86})`;
      g.fillRect(x, 0, 32, 256);
      g.strokeStyle = "rgba(60, 45, 30, 0.22)";
      g.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        const gx = x + 3 + r() * 26;
        g.beginPath();
        g.moveTo(gx, 0);
        g.bezierCurveTo(gx + (r() - 0.5) * 6, 85, gx + (r() - 0.5) * 6, 170, gx, 256);
        g.stroke();
      }
      g.fillStyle = "rgba(40, 28, 18, 0.55)";
      g.fillRect(x, r() * 250, 32, 2);
      g.beginPath();
      g.ellipse(x + 8 + r() * 16, r() * 256, 2.5, 4, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(35, 25, 18, 0.9)";
      g.fillRect(x, 0, 2, 256);
    }
  });
}

/** Start banner: checker strips top and bottom, the game name in the middle. */
function bannerTexture(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    160,
    (g) => {
      g.fillStyle = "#f1e9d8";
      g.fillRect(0, 0, 1024, 160);
      const sq = 20;
      for (let i = 0; i < 1024 / sq; i++) {
        for (let row = 0; row < 2; row++) {
          g.fillStyle = (i + row) % 2 ? "#1e1c1a" : "#f6f2ea";
          g.fillRect(i * sq, row * sq, sq, sq);
          g.fillRect(i * sq, 160 - (2 - row) * sq, sq, sq);
        }
      }
      g.fillStyle = "#d9542b";
      g.fillRect(0, 2 * sq, 1024, 5);
      g.fillRect(0, 160 - 2 * sq - 5, 1024, 5);
      g.fillStyle = "#24201c";
      g.font = "900 76px Impact, 'Arial Black', sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.letterSpacing = "14px";
      g.fillText("DUSTLINE", 519, 82);
    },
    false,
  );
}

/** Number boards atlas: 8 cells of 128 px, cell i shows the digit i. */
function numberAtlas(): THREE.CanvasTexture {
  return canvasTexture(
    1024,
    128,
    (g) => {
      for (let i = 0; i < 8; i++) {
        const x = i * 128;
        g.fillStyle = "#efe6d2";
        g.fillRect(x, 0, 128, 128);
        g.strokeStyle = "#d9542b";
        g.lineWidth = 10;
        g.strokeRect(x + 9, 9, 110, 110);
        g.fillStyle = "#24201c";
        g.font = "900 84px Impact, 'Arial Black', sans-serif";
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.fillText(String(i), x + 64, 68);
      }
    },
    false,
  );
}

/** Tiny sky-over-sand gradient used as a reflection map for the tin and the silver trailer. */
function skyEnvTexture(): THREE.CanvasTexture {
  const tex = canvasTexture(
    64,
    32,
    (g) => {
      const grad = g.createLinearGradient(0, 0, 0, 32);
      grad.addColorStop(0, "#9fc3dc");
      grad.addColorStop(0.46, "#efe2c8");
      grad.addColorStop(0.54, "#d8b27a");
      grad.addColorStop(1, "#b48a58");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 32);
    },
    false,
  );
  tex.mapping = THREE.EquirectangularReflectionMapping;
  return tex;
}
