import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { rng } from "./noise";
import type { PropsResult } from "./props";
import { HALF_WORLD, type Terrain } from "./terrain";
import { ROAD_HALF_WIDTH, type NearestResult, type Track } from "./track";
import type { Collider } from "./types";

/** Length of road (m) the village lines; signs sit a little outside it. */
const STRETCH = 190;
const SOLID_CLEAR = ROAD_HALF_WIDTH + 2.5;
/** Keep this far from colliders placed by props.ts. */
const AVOID_CLEAR = 6;

type V3 = [number, number, number];
type MatKey = "stucco" | "wood" | "metal" | "paint" | "glass" | "sign";
type Rect = readonly [number, number, number, number];

/** Placement of one building: local +Z faces the road, y = levelled pad height. */
interface Frame {
  x: number;
  z: number;
  y: number;
  yaw: number;
}

type Kind = "adobe" | "adobeL" | "clap" | "store" | "gas";

interface Plot {
  kind: Kind;
  extras: string[];
  w: number;
  d: number;
  h: number;
  /** Depth of the porch / canopy zone in front of the footprint. */
  front: number;
  frame: Frame;
  seed: number;
}

/** Hamlet layout along the stretch: kind, distance along the road, side, yard dressing. */
const SCHEDULE: [Kind, number, 1 | -1, string[]][] = [
  ["gas", 22, 1, ["palm"]],
  ["adobe", 54, 1, ["wall", "laundry", "sedan", "dish", "cacti"]],
  ["clap", 82, 1, ["picket", "pickup", "dog", "wood"]],
  ["store", 110, 1, ["palm"]],
  ["adobeL", 142, 1, ["wall", "propane", "tamarisk", "wood", "solar"]],
  ["adobe", 172, 1, ["cacti", "barrel", "laundry"]],
  ["adobe", 12, -1, ["wall", "cacti", "propane", "solar"]],
  ["clap", 42, -1, ["picket", "laundry", "barrel", "tires"]],
  ["adobe", 70, -1, ["wall", "dish", "tamarisk"]],
  ["adobeL", 98, -1, ["dog", "barrel", "cacti"]],
  ["clap", 140, -1, ["wire", "pickup", "wood"]],
  ["adobe", 168, -1, ["wall", "palm", "cacti", "solar"]],
];
const TOWER_AT: [number, number] = [119, 24]; // u, distance from the road (left side)

// Palette (sRGB hex). Weathered, sun-faded tones.
const STUCCO = [0xe9d6b4, 0xd9a46f, 0xc98463, 0xf0ebe1, 0xdcb98f, 0xe5c9a2];
const DOORS = [0x5f8f8b, 0x5b7c9c, 0x8b5d3e, 0x9c4c3b, 0x71905f, 0x4f6f7f];
const ROOF_DECK = [0xb7ad9c, 0x938a7c, 0xcfc7b6];
const WOOD_GREY = 0xb9ab98;
const WOOD_BROWN = 0x9c7b5a;
const WOOD_DARK = 0x6c5240;
const GLASS = 0x2a3740;
const CONCRETE = 0xb9ad98;
const STEEL = 0x8e8d88;
const RUST = 0x8c4f2e;
const RUBBER = 0x262524;
const LEAF = 0x76844a;

const _m = new THREE.Matrix4();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _c = new THREE.Color();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _axis = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);

/** Shared unit shapes (non-indexed so every part merges with every other). */
const UNIT = {
  box: flat(new THREE.BoxGeometry(1, 1, 1)),
  cyl: flat(new THREE.CylinderGeometry(1, 1, 1, 8)),
  cyl16: flat(new THREE.CylinderGeometry(1, 1, 1, 16)),
  taper: flat(new THREE.CylinderGeometry(0.72, 1, 1, 7)),
  cone: flat(new THREE.ConeGeometry(1, 1, 8)),
  ball: flat(new THREE.IcosahedronGeometry(1, 1)),
};

/** Texture tile size in metres (u, v) for the box-mapped materials. */
const TILE: Partial<Record<MatKey, [number, number]>> = {
  stucco: [4, 4],
  wood: [2.4, 2.4],
  metal: [1, 2],
};

/** Planar box mapping in the current space, so textures keep a real-world scale. */
function boxUV(g: THREE.BufferGeometry, [tu, tv]: [number, number]): void {
  const p = g.attributes.position;
  const n = g.attributes.normal;
  const uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i));
    const ay = Math.abs(n.getY(i));
    const az = Math.abs(n.getZ(i));
    let u: number;
    let v: number;
    if (ay >= ax && ay >= az) [u, v] = [p.getX(i), p.getZ(i)];
    else if (ax >= az) [u, v] = [p.getZ(i), p.getY(i)];
    else [u, v] = [p.getX(i), p.getY(i)];
    uv.setXY(i, u / tu, v / tv);
  }
}

const ATLAS = 512;
const RECT = {
  store: [0, 0, 512, 128],
  brand: [0, 128, 256, 256],
  fascia: [256, 128, 256, 64],
  pump: [256, 192, 128, 192],
  drinks: [384, 192, 128, 64],
  open: [384, 256, 128, 64],
  solid: [488, 488, 24, 24],
} satisfies Record<string, Rect>;

/** Map a part of the sign atlas onto a plane. */
function signPlane(w: number, h: number, rect: Rect): THREE.BufferGeometry {
  const g = flat(new THREE.PlaneGeometry(w, h));
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    uv.setXY(i, (rect[0] + u * rect[2]) / ATLAS, 1 - (rect[1] + (1 - v) * rect[3]) / ATLAS);
  }
  return g;
}

interface PartOpts {
  s?: V3;
  ry?: number;
  rx?: number;
  rz?: number;
  /** Box-map UVs before rotation (roof sheets keep their ridges running down the slope). */
  uvLocal?: boolean;
}

/** Collects parts per material in world space and merges them into one mesh per material. */
class Batch {
  private readonly parts = new Map<MatKey, THREE.BufferGeometry[]>();
  private readonly frame = new THREE.Matrix4();

  at(f: Frame | null): void {
    if (f) this.frame.makeRotationY(f.yaw).setPosition(f.x, f.y, f.z);
    else this.frame.identity();
  }

  add(key: MatKey, src: THREE.BufferGeometry, color: number, x: number, y: number, z: number, o: PartOpts = {}): void {
    const g = src.clone();
    if (o.s) g.scale(o.s[0], o.s[1], o.s[2]);
    const tile = TILE[key];
    if (tile && o.uvLocal) boxUV(g, tile);
    _e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0, "YXZ");
    g.applyMatrix4(_m.makeRotationFromEuler(_e).setPosition(x, y, z));
    if (tile && !o.uvLocal) boxUV(g, tile);
    if (key === "sign" && src === UNIT.box) {
      // Sign frames sample a plain patch of the atlas.
      const uv = g.attributes.uv;
      const [sx, sy, sw, sh] = RECT.solid;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, (sx + sw / 2) / ATLAS, 1 - (sy + sh / 2) / ATLAS);
    }
    g.applyMatrix4(this.frame);
    _c.setHex(color);
    const col = new Float32Array(g.attributes.position.count * 3);
    for (let i = 0; i < col.length; i += 3) {
      col[i] = _c.r;
      col[i + 1] = _c.g;
      col[i + 2] = _c.b;
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    let list = this.parts.get(key);
    if (!list) this.parts.set(key, (list = []));
    list.push(g);
  }

  /** Box of size (w, h, d) centred at (x, y, z). */
  box(key: MatKey, color: number, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0, uvLocal = false): void {
    this.add(key, UNIT.box, color, x, y, z, { s: [w, h, d], ry, rx, rz, uvLocal });
  }

  /** Cylinder (axis along y before rotation) centred at (x, y, z). */
  cyl(key: MatKey, color: number, r: number, h: number, x: number, y: number, z: number, rx = 0, rz = 0, ry = 0): void {
    this.add(key, UNIT.cyl, color, x, y, z, { s: [r, h, r], rx, rz, ry });
  }

  merged(key: MatKey): THREE.BufferGeometry {
    const list = this.parts.get(key) ?? [];
    const g = mergeGeometries(list);
    for (const p of list) p.dispose();
    this.parts.delete(key);
    return g;
  }

  keys(): MatKey[] {
    return [...this.parts.keys()];
  }
}

function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function toTexture(c: HTMLCanvasElement, repeat: boolean): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Fine per-pixel grain so flat colours don't look plastic. */
function grain(g: CanvasRenderingContext2D, w: number, h: number, amount: number, r: () => number): void {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (r() - 0.5) * amount;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/** Lime/mud plaster, 4 x 4 m: mottling, rain streaks, cracks, bare adobe bricks, dirt at the base. */
function stuccoTexture(): THREE.CanvasTexture {
  const S = 256;
  const [c, g] = makeCanvas(S, S);
  const r = rng(11);
  g.fillStyle = "#ece6da";
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 260; i++) {
    const x = r() * S;
    const y = r() * S;
    const rad = 3 + r() * 22;
    const sq = 0.5 + r() * 0.6;
    const rot = r() * 3;
    g.fillStyle = r() < 0.55 ? `rgba(120,95,70,${0.03 + r() * 0.05})` : `rgba(255,252,245,${0.05 + r() * 0.08})`;
    for (const ox of [-S, 0, S]) {
      g.beginPath();
      g.ellipse(x + ox, y, rad, rad * sq, rot, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Patches where the plaster fell off and the mud bricks show.
  for (let i = 0; i < 3; i++) {
    const px = 50 + r() * (S - 100);
    const py = 70 + r() * 120;
    const pw = 16 + r() * 22;
    const ph = 10 + r() * 14;
    g.save();
    g.beginPath();
    g.ellipse(px, py, pw, ph, (r() - 0.5) * 0.6, 0, Math.PI * 2);
    g.clip();
    g.fillStyle = "#b98a62";
    g.fillRect(px - pw, py - ph, pw * 2, ph * 2);
    g.strokeStyle = "rgba(95,65,45,0.6)";
    g.lineWidth = 1;
    for (let y = py - ph, row = 0; y < py + ph; y += 8, row++) {
      g.beginPath();
      g.moveTo(px - pw, y);
      g.lineTo(px + pw, y);
      for (let x = px - pw + (row % 2) * 9; x < px + pw; x += 18) {
        g.moveTo(x, y);
        g.lineTo(x, y + 8);
      }
      g.stroke();
    }
    g.restore();
  }
  // Rain streaks running down from the parapet.
  for (let i = 0; i < 70; i++) {
    const x = r() * S;
    const len = 30 + r() * 120;
    const grad = g.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, `rgba(105,85,60,${0.1 + r() * 0.12})`);
    grad.addColorStop(1, "rgba(105,85,60,0)");
    g.fillStyle = grad;
    g.fillRect(x, 0, 1 + r() * 3, len);
  }
  g.strokeStyle = "rgba(70,55,40,0.5)";
  g.lineWidth = 1;
  for (let i = 0; i < 9; i++) {
    let x = 20 + r() * (S - 40);
    let y = r() * S;
    let a = r() * Math.PI * 2;
    g.beginPath();
    g.moveTo(x, y);
    for (let k = 0; k < 14; k++) {
      a += (r() - 0.5) * 1.2;
      x += Math.cos(a) * 4;
      y += Math.sin(a) * 4;
      g.lineTo(x, y);
    }
    g.stroke();
  }
  // Splash-back dirt along the ground (bottom of the tile = ground level).
  const dirt = g.createLinearGradient(0, S, 0, S - 50);
  dirt.addColorStop(0, "rgba(125,92,60,0.6)");
  dirt.addColorStop(1, "rgba(125,92,60,0)");
  g.fillStyle = dirt;
  g.fillRect(0, S - 50, S, 50);
  g.fillStyle = "rgba(115,85,55,0.35)";
  for (let i = 0; i < 160; i++) g.fillRect(r() * S, S - r() * r() * 46, 1 + r() * 2, 1 + r() * 2);
  grain(g, S, S, 14, r);
  return toTexture(c, true);
}

/** Weathered horizontal boards, 2.4 m tile: grain, knots, gaps, nails with rust bleed. */
function woodTexture(): THREE.CanvasTexture {
  const S = 256;
  const bh = S / 8;
  const [c, g] = makeCanvas(S, S);
  const r = rng(23);
  for (let b = 0; b < 8; b++) {
    const t = 200 + r() * 45;
    g.fillStyle = `rgb(${t},${t * 0.94},${t * 0.86})`;
    g.fillRect(0, b * bh, S, bh);
    for (let i = 0; i < 28; i++) {
      const y = b * bh + 3 + r() * (bh - 5);
      const x = r() * S;
      const len = 30 + r() * 160;
      g.strokeStyle = r() < 0.7 ? `rgba(80,60,40,${0.1 + r() * 0.18})` : "rgba(255,250,240,0.15)";
      g.lineWidth = 1;
      for (const ox of [-S, 0]) {
        g.beginPath();
        g.moveTo(x + ox, y);
        g.lineTo(x + ox + len, y + (r() - 0.5) * 2);
        g.stroke();
      }
    }
    if (r() < 0.6) {
      g.fillStyle = "rgba(70,50,35,0.55)";
      g.beginPath();
      g.ellipse(20 + r() * (S - 40), b * bh + bh / 2, 4 + r() * 4, 2 + r() * 2, 0, 0, Math.PI * 2);
      g.fill();
    }
    // Butt joint, gap shadow, edge highlight, nails on the studs.
    g.fillStyle = "rgba(45,32,24,0.6)";
    g.fillRect(r() * S, b * bh, 2, bh);
    g.fillStyle = "rgba(40,30,22,0.8)";
    g.fillRect(0, b * bh, S, 2);
    g.fillStyle = "rgba(255,255,255,0.2)";
    g.fillRect(0, b * bh + 2, S, 1);
    for (const nx of [40, 168]) {
      const ny = b * bh + bh * 0.5;
      const grad = g.createLinearGradient(0, ny, 0, ny + 14);
      grad.addColorStop(0, "rgba(120,60,30,0.4)");
      grad.addColorStop(1, "rgba(120,60,30,0)");
      g.fillStyle = grad;
      g.fillRect(nx - 1, ny, 3, 14);
      g.fillStyle = "rgba(40,30,25,0.85)";
      g.fillRect(nx - 1, ny - 1, 3, 3);
    }
  }
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(250,245,235,${0.04 + r() * 0.06})`;
    g.fillRect(r() * S, r() * S, 10 + r() * 50, 4 + r() * 20);
  }
  grain(g, S, S, 16, r);
  return toTexture(c, true);
}

/** Corrugated sheet, 1 m across x 2 m: ridges, screw rows, rust blooms and streaks. */
function metalTexture(): THREE.CanvasTexture {
  const W = 128;
  const H = 256;
  const [c, g] = makeCanvas(W, H);
  const r = rng(31);
  for (let x = 0; x < W; x++) {
    const s = Math.sin((x / W) * Math.PI * 2 * 8);
    const v = 175 + s * 50 + Math.max(0, s) ** 8 * 30;
    g.fillStyle = `rgb(${v},${v},${v * 0.98})`;
    g.fillRect(x, 0, 1, H);
  }
  g.fillStyle = "rgba(40,35,30,0.5)";
  g.fillRect(0, 0, W, 2);
  for (const y of [8, 128]) for (let x = 4; x < W; x += 16) g.fillRect(x, y, 2, 2);
  for (let i = 0; i < 45; i++) {
    const x = r() * W;
    const y = r() < 0.5 ? r() * 40 : r() * H;
    const rad = 3 + r() * 14;
    g.fillStyle = `rgba(${140 + r() * 30},${70 + r() * 20},35,${0.15 + r() * 0.3})`;
    for (const ox of [-W, 0, W]) {
      g.beginPath();
      g.ellipse(x + ox, y, rad, rad * 0.7, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  for (let i = 0; i < 30; i++) {
    const x = r() * W;
    const y = r() * H;
    const grad = g.createLinearGradient(0, y, 0, y + 60);
    grad.addColorStop(0, "rgba(130,65,30,0.35)");
    grad.addColorStop(1, "rgba(130,65,30,0)");
    g.fillStyle = grad;
    g.fillRect(x, y, 2, 60);
  }
  grain(g, W, H, 12, r);
  return toTexture(c, true);
}

/** Hand-painted signs (all names made up), sun-faded and chipped. */
function signTexture(): THREE.CanvasTexture {
  const [c, g] = makeCanvas(ATLAS, ATLAS);
  const r = rng(5);
  const text = (s: string, x: number, y: number, font: string, color: string) => {
    g.font = font;
    g.fillStyle = color;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(s, x, y);
  };
  const fill = (rect: Rect, color: string) => {
    g.fillStyle = color;
    g.fillRect(rect[0], rect[1], rect[2], rect[3]);
  };
  g.fillStyle = "#cdbb98";
  g.fillRect(0, 0, ATLAS, ATLAS);

  fill(RECT.store, "#e3d5b3");
  g.strokeStyle = "#8e3b2b";
  g.lineWidth = 6;
  g.strokeRect(8, 8, 496, 112);
  text("PRICKLY PEAR", 256, 56, "bold 60px Georgia, 'Times New Roman', serif", "#8e3b2b");
  text("GENERAL STORE · FEED · SUPPLIES", 256, 100, "bold 21px Georgia, serif", "#3e4f5a");

  // Round brand sign with a stylised bird.
  fill(RECT.brand, "#efe6d2");
  g.fillStyle = "#b8392b";
  g.beginPath();
  g.arc(128, 256, 116, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#efe6d2";
  g.beginPath();
  g.arc(128, 256, 96, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "#b8392b";
  g.beginPath();
  g.moveTo(70, 222);
  g.quadraticCurveTo(128, 170, 186, 222);
  g.quadraticCurveTo(128, 196, 70, 222);
  g.moveTo(128, 205);
  g.lineTo(150, 186);
  g.lineTo(122, 196);
  g.fill();
  g.fillStyle = "#1f4e79";
  g.fillRect(8, 232, 240, 52);
  text("KESTREL", 128, 259, "bold 42px Arial, Helvetica, sans-serif", "#f4ecd8");
  text("MOTOR FUEL", 128, 308, "bold 20px Arial, sans-serif", "#1f4e79");

  fill(RECT.fascia, "#b8392b");
  g.fillStyle = "#efe6d2";
  g.fillRect(256, 180, 256, 6);
  text("KESTREL GASOLINE", 384, 158, "bold 30px Arial, Helvetica, sans-serif", "#f4ecd8");

  // Vintage pump face: brand, price window, big dial.
  fill(RECT.pump, "#e8dcc0");
  text("KESTREL", 320, 212, "bold 20px Arial, sans-serif", "#b8392b");
  g.fillStyle = "#222";
  g.fillRect(272, 226, 96, 26);
  text("0.31", 320, 240, "bold 20px monospace", "#e8e0c8");
  g.strokeStyle = "#333";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(320, 310, 42, 0, Math.PI * 2);
  g.stroke();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    g.beginPath();
    g.moveTo(320 + Math.cos(a) * 34, 310 + Math.sin(a) * 34);
    g.lineTo(320 + Math.cos(a) * 41, 310 + Math.sin(a) * 41);
    g.stroke();
  }
  g.beginPath();
  g.moveTo(320, 310);
  g.lineTo(344, 292);
  g.stroke();

  fill(RECT.drinks, "#4f7891");
  text("COLD DRINKS", 448, 224, "bold 19px Arial, sans-serif", "#f2ece0");
  fill(RECT.open, "#efe9dc");
  text("OPEN", 448, 288, "bold 34px Georgia, serif", "#b23a2c");
  fill(RECT.solid, "#6d2a22");

  // Sun fade, chipped paint, grime.
  g.fillStyle = "rgba(245,235,215,0.16)";
  g.fillRect(0, 0, ATLAS, 488);
  for (let i = 0; i < 900; i++) {
    g.fillStyle = r() < 0.6 ? "rgba(225,210,180,0.55)" : "rgba(120,90,60,0.35)";
    g.fillRect(r() * ATLAS, r() * 488, 1 + r() * 4, 1 + r() * 2);
  }
  for (let i = 0; i < 40; i++) {
    g.strokeStyle = "rgba(90,70,50,0.25)";
    g.beginPath();
    const x = r() * ATLAS;
    const y = r() * 488;
    g.moveTo(x, y);
    g.lineTo(x + (r() - 0.5) * 40, y + r() * 10);
    g.stroke();
  }
  grain(g, ATLAS, ATLAS, 10, r);
  return toTexture(c, false);
}

/** Triangular gable prism: base `depth` (local z), height `rise`, long `length` (local x). */
function gablePrism(depth: number, rise: number, length: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-depth / 2, 0);
  s.lineTo(depth / 2, 0);
  s.lineTo(0, rise);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: length, bevelEnabled: false });
  g.translate(0, 0, -length / 2);
  g.rotateY(Math.PI / 2);
  return flat(g);
}

/** Distance from a point to the edge of a collider. */
function colliderDist(c: Collider, x: number, z: number): number {
  if (c.kind === "circle") return Math.hypot(x - c.x, z - c.z) - c.r;
  const abx = c.bx - c.ax;
  const abz = c.bz - c.az;
  const t = Math.max(0, Math.min(1, ((x - c.ax) * abx + (z - c.az) * abz) / (abx * abx + abz * abz || 1)));
  return Math.hypot(x - c.ax - abx * t, z - c.az - abz * t) - c.r;
}

/**
 * Pick the road stretch for the village: straight-ish, gentle slope (no jump crests), away from
 * the start line, the beach and the world edge, with calm ground and few props on both sides.
 * Returns the sample index where the stretch begins.
 */
function pickStretch(terrain: Terrain, track: Track, avoid: Collider[], spacing: number): number {
  const n = track.samples.length;
  const run = Math.round((STRETCH + 40) / spacing);
  const startLine = track.checkpoints[0].sample;
  const near: NearestResult = { index: 0, distance: 0, lateral: 0 };
  let best = 0;
  let bestScore = Infinity;
  for (let i = 0; i < n; i += 2) {
    const a = track.at(i);
    const b = track.at(i + run);
    if (a.tx * b.tx + a.tz * b.tz < Math.cos(0.8)) continue;
    let score = 0;
    let ok = true;
    for (let k = 0; k <= run && ok; k += 3) {
      const idx = i + k;
      const s = track.at(idx);
      const fromStart = (((idx - startLine) % n) + n) % n;
      if (Math.min(fromStart, n - fromStart) * spacing < 80) ok = false;
      if (s.z - terrain.shorelineZ(s.x) < 70) ok = false;
      if (Math.abs(s.x) > HALF_WORLD - 85 || s.z > HALF_WORLD - 85) ok = false;
      const p = track.at(idx - 4);
      const q = track.at(idx + 4);
      const slope = Math.abs(q.y - p.y) / (8 * spacing);
      if (slope > 0.08) ok = false;
      score += slope * 30 + (1 - (p.tx * q.tx + p.tz * q.tz)) * 400;
      for (const side of [-1, 1]) {
        for (const lat of [16, 28]) {
          const x = s.x - s.tz * side * lat;
          const z = s.z + s.tx * side * lat;
          score += Math.abs(terrain.heightAt(x, z) - s.y) * 0.08;
          // Another part of the loop running through the plots.
          if (track.nearest(x, z, near).distance < lat - 3) score += 4;
        }
      }
      if (k % 6 === 0) for (const c of avoid) if (colliderDist(c, s.x, s.z) < 30) score += 1.2;
    }
    if (ok && score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best + Math.round(20 / spacing);
}

interface Wobbler {
  mesh: THREE.InstancedMesh;
  index: number;
  pos: THREE.Vector3;
  yaw: number;
  angle: number;
  vel: number;
  ax: number;
  az: number;
}

interface Cloth {
  pos: THREE.Vector3;
  yaw: number;
  w: number;
  h: number;
  phase: number;
}

/**
 * A small, lived-in desert settlement the road runs through: houses, a roadside gas station,
 * water tower, parked cars, yards, fences, poles. Levels building pads with terrain.flatten
 * (the game builds the terrain mesh afterwards). `avoid` = colliders already placed by props.
 */
export function buildVillage(
  scene: THREE.Scene,
  terrain: Terrain,
  track: Track,
  avoid: Collider[],
): PropsResult {
  const colliders: Collider[] = [];
  const near: NearestResult = { index: 0, distance: 0, lateral: 0 };
  const spacing = track.length / track.samples.length;
  const base = pickStretch(terrain, track, avoid, spacing);
  const sampleAt = (u: number) => track.at(base + Math.round(u / spacing));
  const roadDist = (x: number, z: number) => track.nearest(x, z, near).distance;
  const avoidDist = (x: number, z: number) => {
    let d = Infinity;
    for (const c of avoid) d = Math.min(d, colliderDist(c, x, z));
    return d;
  };
  const toW = (f: Frame, lx: number, ly: number, lz: number): V3 => {
    const c = Math.cos(f.yaw);
    const s = Math.sin(f.yaw);
    return [f.x + lx * c + lz * s, f.y + ly, f.z - lx * s + lz * c];
  };
  /** Frame `dist` metres out from the road centre at `u`, facing the road. */
  const roadside = (u: number, side: number, dist: number, jitter = 0): Frame => {
    const s = sampleAt(u);
    const ox = -s.tz * side;
    const oz = s.tx * side;
    return { x: s.x + ox * dist, z: s.z + oz * dist, y: 0, yaw: Math.atan2(-ox, -oz) + jitter };
  };
  /** Can a thing of radius r stand here? Solid things keep clear of the road. */
  const free = (x: number, z: number, r: number, solid: boolean) =>
    roadDist(x, z) >= (solid ? SOLID_CLEAR : ROAD_HALF_WIDTH + 1) + r && avoidDist(x, z) >= r + 3;
  const freeAt = (f: Frame, lx: number, lz: number, r: number, solid = true) => {
    const [x, , z] = toW(f, lx, 0, lz);
    return free(x, z, r, solid);
  };
  const circle = (x: number, z: number, r: number, solid = true, id?: number) =>
    colliders.push({ kind: "circle", x, z, r, solid, id });
  const circleAt = (f: Frame, lx: number, lz: number, r: number) => {
    const [x, , z] = toW(f, lx, 0, lz);
    circle(x, z, r);
  };
  const segmentAt = (f: Frame, ax: number, az: number, bx: number, bz: number, r: number) => {
    const a = toW(f, ax, 0, az);
    const b = toW(f, bx, 0, bz);
    colliders.push({ kind: "segment", ax: a[0], az: a[2], bx: b[0], bz: b[2], r, solid: true });
  };
  /** Rows of capsules covering a rectangle (corners stick out < 0.5 m). */
  const rectCollider = (f: Frame, cx: number, cz: number, w: number, d: number) => {
    const long = Math.max(w, d);
    const short = Math.min(w, d);
    const rows = Math.max(1, Math.ceil(short / 2.6));
    const r = short / (2 * rows);
    for (let k = 0; k < rows; k++) {
      const off = -short / 2 + r * (2 * k + 1);
      const e = long / 2 - r;
      if (w >= d) segmentAt(f, cx - e, cz + off, cx + e, cz + off, r);
      else segmentAt(f, cx + off, cz - e, cx + off, cz + e, r);
    }
  };
  const ground = (f: Frame, lx: number, lz: number) => {
    const [x, , z] = toW(f, lx, 0, lz);
    return terrain.heightAt(x, z) - f.y;
  };

  // ---------------------------------------------------------------- plots and pads
  const plots: Plot[] = [];
  SCHEDULE.forEach(([kind, u, side, extras], i) => {
    const r = rng(101 + i * 17);
    let w = 8.5 + r() * 2.5;
    let d = 7 + r() * 1.5;
    let h = 3 + r() * 0.4;
    let front = r() < 0.5 ? 2.6 : 0.6;
    let setback = 12 + (front > 1 ? 1.5 : 0) + r() * 5;
    if (kind === "adobeL") [w, d, front] = [13 + r(), 7.5 + r(), 0.6];
    if (kind === "clap") [w, d, h, front, setback] = [8 + r() * 1.2, 6.2 + r() * 0.8, 2.7, 2.4, 14.5 + r() * 3];
    if (kind === "store") [w, d, h, front, setback] = [12, 10, 3.8, 3, 15];
    if (kind === "gas") [w, d, h, front, setback] = [12, 16, 3.2, 0, 10.6];
    for (let attempt = 0; attempt < 3; attempt++, setback += 4) {
      const frame = roadside(u, side, setback + d / 2, (r() - 0.5) * 0.12);
      let ok = true;
      for (const lx of [-w / 2 - 1, 0, w / 2 + 1]) {
        for (const lz of [d / 2 + front, 0, -d / 2 - 2]) {
          const [x, , z] = toW(frame, lx, 0, lz);
          const need = lz >= d / 2 ? SOLID_CLEAR + 0.6 : SOLID_CLEAR + 3;
          if (roadDist(x, z) < need || avoidDist(x, z) < AVOID_CLEAR) ok = false;
        }
      }
      if (ok) {
        plots.push({ kind, extras, w, d, h, front, frame, seed: 500 + i * 31 });
        break;
      }
    }
  });
  const tower = roadside(TOWER_AT[0], -1, TOWER_AT[1], 0.3);
  const towerOk = [-3, 3].every((lx) => [-3, 3].every((lz) => freeAt(tower, lx, lz, AVOID_CLEAR - 3)));

  // Level every pad first (pads may overlap), then sit each building on the final ground.
  const pads: [Frame, number, number][] = plots.map((p) => [p.frame, p.w, p.d + p.front]);
  if (towerOk) pads.push([tower, 5, 5]);
  for (const [f, w, d] of pads) {
    let sum = 0;
    for (const lx of [-w / 2, 0, w / 2]) for (const lz of [-d / 2, 0, d / 2]) sum += ground(f, lx, lz) + f.y;
    terrain.flatten(f.x, f.z, Math.hypot(w, d) / 2 + 1, sum / 9, 6);
  }
  for (const [f, w, d] of pads) {
    let sum = 0;
    for (const lx of [-w / 2, 0, w / 2]) {
      for (const lz of [-d / 2, 0, d / 2]) {
        const [x, , z] = toW(f, lx, 0, lz);
        sum += terrain.heightAt(x, z);
      }
    }
    f.y = sum / 9;
  }

  // ---------------------------------------------------------------- shared helpers
  const B = new Batch();
  const wires: number[] = [];
  const cloths: Cloth[] = [];
  const wobbleSpots: { type: "mailbox" | "drum" | "sign"; pos: V3; yaw: number; tint: number }[] = [];

  /** Sagging wire between two world points. */
  const wire = (a: V3, b: V3, sag: number, seg = 8) => {
    for (let k = 0; k < seg; k++) {
      for (const t of [k / seg, (k + 1) / seg]) {
        wires.push(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t - sag * 4 * t * (1 - t), a[2] + (b[2] - a[2]) * t);
      }
    }
  };
  /** Box on a wall: wall plane through (px, pz) facing yaw ry; t along the wall, o outwards. */
  const onWall = (px: number, pz: number, ry: number) => (key: MatKey, color: number, w: number, h: number, d: number, t: number, y: number, o: number) => {
    B.box(key, color, w, h, d, px + Math.cos(ry) * t + Math.sin(ry) * o, y, pz - Math.sin(ry) * t + Math.cos(ry) * o, ry);
  };

  /** Window with frame, mullions and sill; adobe ones are deep-set with a wooden lintel. */
  const windowAt = (px: number, pz: number, ry: number, sill: number, ww: number, wh: number, trim: number, reveal: number | null, shutter: number | null) => {
    const put = onWall(px, pz, ry);
    put("glass", GLASS, ww, wh, 0.05, 0, sill + wh / 2, 0);
    put("wood", trim, 0.06, wh, 0.06, 0, sill + wh / 2, 0.04);
    put("wood", trim, ww, 0.06, 0.06, 0, sill + wh * 0.55, 0.04);
    let edge = ww / 2 + 0.08;
    if (reveal !== null) {
      for (const s of [-1, 1]) put("stucco", reveal, 0.2, wh + 0.1, 0.3, s * (ww / 2 + 0.1), sill + wh / 2, 0.14);
      put("stucco", reveal, ww + 0.4, 0.16, 0.3, 0, sill + wh + 0.08, 0.14);
      put("wood", WOOD_DARK, ww + 0.8, 0.17, 0.34, 0, sill + wh + 0.24, 0.17);
      put("wood", WOOD_GREY, ww + 0.4, 0.08, 0.42, 0, sill - 0.04, 0.2);
      edge = ww / 2 + 0.2;
    } else {
      for (const s of [-1, 1]) put("wood", trim, 0.12, wh + 0.24, 0.06, s * (ww / 2 + 0.06), sill + wh / 2, 0.03);
      put("wood", trim, ww + 0.36, 0.14, 0.08, 0, sill + wh + 0.07, 0.04);
      put("wood", trim, ww + 0.3, 0.07, 0.2, 0, sill - 0.03, 0.08);
    }
    if (shutter !== null) for (const s of [-1, 1]) put("wood", shutter, ww / 2, wh, 0.05, s * (edge + ww / 4), sill + wh / 2, 0.05);
  };

  const doorAt = (px: number, pz: number, ry: number, y0: number, color: number, trim: number, adobe: boolean) => {
    const put = onWall(px, pz, ry);
    put("wood", color, 1, 2.1, 0.08, 0, y0 + 1.05, 0.02);
    put("paint", 0xc8a052, 0.06, 0.06, 0.06, 0.38, y0 + 1, 0.08);
    for (const s of [-1, 1]) put("wood", trim, 0.12, 2.2, 0.1, s * 0.56, y0 + 1.1, 0.04);
    if (adobe) {
      put("wood", WOOD_DARK, 1.8, 0.2, 0.34, 0, y0 + 2.3, 0.17);
      put("paint", CONCRETE, 1.5, 0.18, 0.7, 0, y0 + 0.09, 0.35);
    } else put("wood", trim, 1.36, 0.14, 0.1, 0, y0 + 2.17, 0.04);
  };

  const swampCooler = (x: number, y: number, z: number, ry: number) => {
    B.box("paint", 0xaeb0aa, 1, 0.9, 1, x, y + 0.45, z, ry);
    const put = onWall(x, z, ry);
    put("paint", 0x7f817c, 0.8, 0.6, 0.04, 0, y + 0.45, 0.5);
    put("paint", 0x7f817c, 0.8, 0.6, 0.04, 0, y + 0.45, -0.5);
    B.box("paint", 0x9ea09a, 0.5, 0.35, 0.5, x, y + 0.08, z, ry);
  };
  const stovepipe = (x: number, y: number, z: number, len: number) => {
    B.cyl("paint", 0x3c3936, 0.09, len, x, y + len / 2, z);
    B.add("paint", UNIT.cone, 0x34312e, x, y + len + 0.12, z, { s: [0.22, 0.22, 0.22] });
  };
  const dish = (x: number, y: number, z: number, ry: number) => {
    B.cyl("paint", STEEL, 0.04, 0.9, x, y + 0.45, z);
    B.add("paint", UNIT.ball, 0xdedbd2, x, y + 1, z, { s: [0.45, 0.12, 0.45], ry, rx: -0.9 });
    const put = onWall(x, z, ry);
    put("paint", STEEL, 0.03, 0.03, 0.6, 0, y + 1.1, 0.3);
    put("paint", 0x55524d, 0.08, 0.08, 0.12, 0, y + 1.2, 0.58);
  };
  const solarHeater = (x: number, y: number, z: number, ry: number) => {
    B.add("paint", UNIT.cyl, 0xe2dfd6, x, y + 1.15, z, { s: [0.28, 1.6, 0.28], ry, rz: Math.PI / 2 });
    const put = onWall(x, z, ry);
    put("glass", 0x31465a, 1.7, 0.05, 1.3, 0, y + 0.65, 0.65);
    B.box("paint", STEEL, 1.6, 0.9, 0.05, x, y + 0.45, z, ry);
  };
  const barrel = (x: number, y: number, z: number, color: number) => {
    B.cyl("paint", color, 0.3, 0.9, x, y + 0.45, z);
    B.cyl("paint", color, 0.32, 0.05, x, y + 0.3, z);
    B.cyl("paint", color, 0.32, 0.05, x, y + 0.65, z);
  };
  const potPlant = (x: number, y: number, z: number, r: () => number) => {
    B.add("paint", UNIT.taper, 0xa65a3d, x, y + 0.2, z, { s: [0.24, 0.4, 0.24], rx: Math.PI });
    if (r() < 0.5) {
      // Agave: a rosette of stiff spikes.
      for (let k = 0; k < 9; k++) {
        const a = (k / 9) * Math.PI * 2 + r();
        const tilt = 0.5 + r() * 0.5;
        B.add("paint", UNIT.cone, 0x7f9d82, x + Math.sin(a) * 0.12, y + 0.65, z + Math.cos(a) * 0.12, { s: [0.06, 0.65, 0.03], ry: a, rx: tilt });
      }
    } else {
      // Prickly pear pads.
      for (let k = 0; k < 4; k++) {
        B.add("paint", UNIT.ball, 0x6a8a48, x + (r() - 0.5) * 0.3, y + 0.55 + k * 0.12, z + (r() - 0.5) * 0.2, { s: [0.18, 0.22, 0.05], ry: r() * 3, rz: (r() - 0.5) * 0.8 });
      }
    }
  };
  const cactus = (x: number, y: number, z: number, h: number) => {
    B.cyl("paint", 0x5f7b45, 0.2, h, x, y + h / 2, z);
    B.add("paint", UNIT.ball, 0x5f7b45, x, y + h, z, { s: [0.2, 0.2, 0.2] });
    for (const s of [-1, 1]) {
      const ay = y + h * (s > 0 ? 0.45 : 0.6);
      B.cyl("paint", 0x5f7b45, 0.13, 0.5, x + s * 0.4, ay, z, 0, Math.PI / 2);
      B.cyl("paint", 0x5f7b45, 0.13, 0.8, x + s * 0.62, ay + 0.4, z);
      B.add("paint", UNIT.ball, 0x5f7b45, x + s * 0.62, ay + 0.8, z, { s: [0.13, 0.13, 0.13] });
    }
  };
  const palm = (f: Frame, lx: number, lz: number, r: () => number) => {
    if (!freeAt(f, lx, lz, 0.4)) return;
    const y = ground(f, lx, lz);
    const lean = r() * Math.PI * 2;
    let x = lx;
    let z = lz;
    let cy = y;
    for (let k = 0; k < 4; k++) {
      const seg = 1.9;
      const tilt = 0.06 + k * 0.05;
      B.add("wood", UNIT.taper, 0x8d7a64, x + Math.sin(lean) * Math.sin(tilt) * seg * 0.5, cy + seg / 2, z + Math.cos(lean) * Math.sin(tilt) * seg * 0.5, {
        s: [0.3 - k * 0.03, seg, 0.3 - k * 0.03],
        ry: lean,
        rx: tilt,
      });
      x += Math.sin(lean) * Math.sin(tilt) * seg;
      z += Math.cos(lean) * Math.sin(tilt) * seg;
      cy += Math.cos(tilt) * seg;
    }
    B.add("paint", UNIT.cone, 0x7a6448, x, cy - 0.4, z, { s: [0.6, 1.3, 0.6], rx: Math.PI });
    for (let k = 0; k < 11; k++) {
      const a = (k / 11) * Math.PI * 2 + r() * 0.4;
      const droop = 0.25 + r() * 0.55;
      const len = 3 + r() * 0.6;
      const fx = x + Math.sin(a) * Math.cos(droop) * len * 0.5;
      const fz = z + Math.cos(a) * Math.cos(droop) * len * 0.5;
      const fy = cy - Math.sin(droop) * len * 0.5 + 0.1;
      for (const s of [-1, 1]) {
        B.add("paint", UNIT.box, k % 3 ? LEAF : 0x8f8a52, fx, fy, fz, { s: [0.42, 0.03, len], ry: a, rx: droop, rz: s * 0.5 });
      }
    }
    circleAt(f, lx, lz, 0.4);
  };
  const tamarisk = (f: Frame, lx: number, lz: number, r: () => number) => {
    if (!freeAt(f, lx, lz, 0.5)) return;
    const y = ground(f, lx, lz);
    for (const s of [-1, 1]) B.add("wood", UNIT.cyl, WOOD_DARK, lx + s * 0.25, y + 1.2, lz, { s: [0.16, 2.6, 0.16], rz: s * 0.25 });
    for (let k = 0; k < 6; k++) {
      const a = r() * Math.PI * 2;
      const rad = 1.2 + r() * 1.2;
      B.add("paint", UNIT.ball, k % 2 ? 0x8b9670 : 0x7c8862, lx + Math.sin(a) * rad, y + 2.6 + r() * 1.4, lz + Math.cos(a) * rad, {
        s: [1.4 + r() * 0.6, 0.9 + r() * 0.5, 1.4 + r() * 0.6],
        ry: r() * 3,
      });
    }
    circleAt(f, lx, lz, 0.5);
  };
  const tyres = (x: number, y: number, z: number, n: number) => {
    for (let k = 0; k < n; k++) B.cyl("paint", RUBBER, 0.38, 0.24, x + (k % 2) * 0.05, y + 0.12 + k * 0.25, z);
  };
  const crate = (x: number, y: number, z: number, s: number, ry: number) => B.box("wood", WOOD_BROWN, s, s * 0.8, s, x, y + s * 0.4, z, ry);
  const firewood = (x: number, y: number, z: number, ry: number) => {
    for (let row = 0; row < 3; row++) {
      for (let k = 0; k < 7 - row; k++) {
        const t = (k - (6 - row) / 2) * 0.24;
        const [ox, oz] = [Math.cos(ry) * t, -Math.sin(ry) * t];
        B.add("wood", UNIT.cyl, k % 2 ? 0x8a6a4c : 0xa0805c, x + ox, y + 0.12 + row * 0.21, z + oz, { s: [0.11, 0.55, 0.11], ry, rx: Math.PI / 2 });
      }
    }
  };
  const dogHouse = (x: number, y: number, z: number, ry: number) => {
    B.box("wood", 0xa98a68, 0.9, 0.7, 1.1, x, y + 0.35, z, ry);
    B.add("wood", gablePrism(0.9, 0.4, 1.1), 0xa98a68, x, y + 0.7, z, { ry: ry + Math.PI / 2 });
    for (const s of [-1, 1]) B.box("metal", 0x9a7a62, 0.62, 0.04, 1.3, x + Math.cos(ry) * s * 0.23, y + 0.92, z - Math.sin(ry) * s * 0.23, ry, 0, -s * 0.73, true);
    onWall(x, z, ry)("paint", 0x2a2420, 0.36, 0.45, 0.04, 0, y + 0.25, 0.56);
  };
  const propane = (x: number, y: number, z: number, ry: number) => {
    B.add("paint", UNIT.cyl16, 0xe4e1d8, x, y + 0.7, z, { s: [0.45, 1.6, 0.45], ry, rx: Math.PI / 2 });
    for (const s of [-1, 1]) {
      B.add("paint", UNIT.ball, 0xe4e1d8, x + Math.sin(ry) * s * 0.8, y + 0.7, z + Math.cos(ry) * s * 0.8, { s: [0.45, 0.45, 0.22], ry });
      onWall(x, z, ry)("paint", STEEL, 0.6, 0.3, 0.12, 0, y + 0.15, s * 0.5);
    }
    B.box("paint", 0x6f6d68, 0.12, 0.25, 0.12, x, y + 1.25, z);
  };

  /** Rusty pickup or old sedan (local +Z = nose), at local point of frame f. */
  const vehicle = (f: Frame, lx: number, lz: number, ry: number, pickup: boolean, color: number) => {
    if (!freeAt(f, lx, lz, 2.6)) return;
    B.at(f);
    const y = ground(f, lx, lz) - 0.04;
    const P = (x: number, z: number): [number, number] => [lx + x * Math.cos(ry) + z * Math.sin(ry), lz - x * Math.sin(ry) + z * Math.cos(ry)];
    const box = (key: MatKey, c: number, w: number, h: number, d: number, x: number, yy: number, z: number, rx = 0) => {
      const [px, pz] = P(x, z);
      B.box(key, c, w, h, d, px, y + yy, pz, ry, rx);
    };
    for (const [wx, wz] of [[0.8, 1.55], [-0.8, 1.55], [0.8, -1.5], [-0.8, -1.5]]) {
      const [px, pz] = P(wx, wz);
      B.add("paint", UNIT.cyl, RUBBER, px, y + 0.37, pz, { s: [0.37, 0.24, 0.37], ry, rz: Math.PI / 2 });
      const [hx, hz] = P(wx * 1.08, wz);
      B.add("paint", UNIT.cyl, 0x8f8a80, hx, y + 0.37, hz, { s: [0.17, 0.05, 0.17], ry, rz: Math.PI / 2 });
    }
    box("paint", color, 1.86, 0.6, 4.9, 0, 0.78, 0);
    box("paint", 0xb9b6ae, 1.9, 0.18, 0.18, 0, 0.62, 2.5);
    box("paint", 0xb9b6ae, 1.9, 0.18, 0.18, 0, 0.62, -2.5);
    for (const s of [-1, 1]) box("paint", 0xf1e9cc, 0.3, 0.16, 0.05, s * 0.62, 0.9, 2.46);
    box("paint", RUST, 1.88, 0.18, 1.2, 0, 0.55, -1.3);
    if (pickup) {
      box("paint", color, 1.8, 0.85, 1.55, 0, 1.5, 0.35);
      box("glass", GLASS, 1.6, 0.55, 0.05, 0, 1.55, 1.15, -0.25);
      box("glass", GLASS, 1.82, 0.42, 1.1, 0, 1.6, 0.35);
      box("glass", GLASS, 1.5, 0.4, 0.05, 0, 1.6, -0.43);
      for (const s of [-1, 1]) box("paint", color, 0.08, 0.45, 2.1, s * 0.89, 1.3, -1.4);
      box("paint", color, 1.8, 0.45, 0.08, 0, 1.3, -2.42);
      box("paint", 0x4a3a2c, 1.7, 0.05, 2.1, 0, 1.1, -1.4);
      box("wood", WOOD_BROWN, 1.0, 0.5, 0.7, 0.2, 1.38, -1.7);
    } else {
      box("glass", GLASS, 1.6, 0.55, 2.3, 0, 1.33, -0.2);
      box("paint", color, 1.66, 0.08, 1.8, 0, 1.64, -0.25);
      for (const s of [-1, 1]) {
        box("paint", color, 0.06, 0.55, 0.12, s * 0.8, 1.33, 0.95, -0.5);
        box("paint", color, 0.06, 0.55, 0.14, s * 0.8, 1.33, -1.3, 0.5);
      }
    }
    const [ax, az] = P(0, -1.6);
    const [bx, bz] = P(0, 1.6);
    segmentAt(f, ax, az, bx, bz, 1.05);
  };

  // ---------------------------------------------------------------- buildings
  /** Flat-roofed adobe block; `sides` lists the end walls (-1 / +1) that get a window. */
  const adobe = (p: Plot, r: () => number, cx: number, w: number, d: number, h: number, wall: number, isMain: boolean, sides: number[]) => {
    const door = DOORS[Math.floor(r() * DOORS.length)];
    const shutter = r() < 0.6 ? DOORS[Math.floor(r() * DOORS.length)] : null;
    B.box("stucco", wall, w, h + 1, d, cx, (h - 1) / 2, 0);
    const t = 0.28;
    const ph = 0.4 + r() * 0.25;
    B.box("stucco", wall, w, ph, t, cx, h + ph / 2, d / 2 - t / 2);
    B.box("stucco", wall, w, ph, t, cx, h + ph / 2, -d / 2 + t / 2);
    for (const s of [-1, 1]) B.box("stucco", wall, t, ph, d - 2 * t, cx + s * (w / 2 - t / 2), h + ph / 2, 0);
    B.box("paint", ROOF_DECK[Math.floor(r() * 3)], w - 2 * t, 0.06, d - 2 * t, cx, h + 0.06, 0);
    // Protruding roof beams (vigas) and drain spouts (canales).
    const n = Math.floor(w / 0.9);
    for (let i = 0; i < n; i++) B.cyl("wood", WOOD_DARK, 0.1, 0.75, cx - w / 2 + (i + 0.5) * (w / n), h - 0.3, d / 2 + 0.2, Math.PI / 2, 0, (r() - 0.5) * 0.08);
    for (const s of [-1, 1]) B.box("wood", WOOD_GREY, 0.22, 0.14, 0.9, cx + s * (w / 2 - 1), h + 0.12, -d / 2 - 0.3);
    if (isMain) {
      const dx = cx - w * 0.15;
      doorAt(dx, d / 2, 0, 0, door, WOOD_DARK, true);
      windowAt(cx + w * 0.25, d / 2, 0, 0.95, 0.9, 1.05, WOOD_DARK, wall, shutter);
      if (w > 9.5) windowAt(cx - w * 0.4, d / 2, 0, 0.95, 0.7, 0.9, WOOD_DARK, wall, shutter);
      windowAt(cx, -d / 2, Math.PI, 1.1, 0.8, 0.8, WOOD_DARK, wall, null);
      potPlant(dx + 1, 0, d / 2 + 0.5, r);
      if (r() < 0.6) potPlant(dx - 1, 0, d / 2 + 0.6, r);
    } else {
      windowAt(cx, d / 2, 0, 1, 0.8, 0.9, WOOD_DARK, wall, shutter);
    }
    for (const s of sides) windowAt(cx + (s * w) / 2, 0, (s * Math.PI) / 2, 1, 0.8, 0.9, WOOD_DARK, wall, null);
    if (isMain && p.front > 1) {
      // Covered porch: posts, beam, latilla roof with a tin sheet on top.
      const pz = d / 2 + p.front - 0.2;
      const posts = w > 9.5 ? 4 : 3;
      for (let i = 0; i < posts; i++) {
        const x = cx - w / 2 + 0.5 + (i * (w - 1)) / (posts - 1);
        B.box("wood", WOOD_BROWN, 0.2, 2.6, 0.2, x, 1.3, pz);
        circleAt(p.frame, x, pz, 0.22);
      }
      B.box("wood", WOOD_DARK, w, 0.22, 0.24, cx, 2.68, pz);
      B.box("wood", WOOD_GREY, w + 0.2, 0.1, p.front + 0.3, cx, 2.84, d / 2 + p.front / 2, 0, 0.05);
      B.box("metal", 0xa69a8c, w + 0.3, 0.04, p.front + 0.4, cx, 2.92, d / 2 + p.front / 2, 0, 0.05, 0, true);
      B.box("paint", CONCRETE, w, 0.14, p.front, cx, 0.07, d / 2 + p.front / 2);
    }
    // Roof clutter.
    if (r() < 0.8) swampCooler(cx + (r() - 0.5) * (w - 3), h, -d * 0.15, r() * 0.3);
    if (r() < 0.7) stovepipe(cx + w * 0.3, h, -d * 0.3, 1.2 + r() * 0.6);
  };

  const adobeHouse = (p: Plot, r: () => number) => {
    const wall = STUCCO[Math.floor(r() * STUCCO.length)];
    if (p.kind === "adobeL") {
      const annex = 4.5;
      adobe(p, r, -annex / 2, p.w - annex, p.d, p.h, wall, true, [-1]);
      adobe(p, r, (p.w - annex) / 2, annex, p.d - 1.6, p.h - 0.7, r() < 0.5 ? wall : STUCCO[Math.floor(r() * STUCCO.length)], false, [1]);
    } else adobe(p, r, 0, p.w, p.d, p.h, wall, true, [-1, 1]);
    if (p.extras.includes("dish")) dish(p.w * 0.25, p.h, p.d * 0.2, 0.6);
    if (p.extras.includes("solar")) solarHeater(-p.w * 0.2, p.h, -p.d * 0.1, Math.PI);
  };

  const clapHouse = (p: Plot, r: () => number) => {
    const { w, d, h } = p;
    const walls = [0xbfb3a1, 0xa9b9b8, 0xc9a78a, 0xd8d2c4, 0x9fb0c2];
    const wall = walls[Math.floor(r() * walls.length)];
    const trim = r() < 0.5 ? 0xe5e0d4 : 0x8a6f58;
    const roof = r() < 0.5 ? 0xb88a66 : 0xc4c4bd;
    B.box("wood", wall, w, h + 0.6, d, 0, (h - 0.6) / 2 + 0.2, 0);
    B.box("paint", 0x8d8070, w + 0.1, 0.6, d + 0.1, 0, -0.1, 0);
    const rise = d * 0.32;
    B.add("wood", gablePrism(d, rise, w), wall, 0, h + 0.2, 0);
    const a = Math.atan2(rise, d / 2);
    const len = Math.hypot(d / 2, rise) + 0.45;
    for (const s of [-1, 1]) {
      const cz = s * Math.cos(a) * len * 0.5 + s * Math.sin(a) * 0.04;
      const cy = h + 0.2 + rise - Math.sin(a) * len * 0.5 + Math.cos(a) * 0.04;
      B.box("metal", roof, w + 0.6, 0.05, len, 0, cy, cz, 0, s * a, 0, true);
    }
    B.box("metal", roof, w + 0.6, 0.1, 0.4, 0, h + 0.25 + rise, 0);
    // Porch: deck on piers, steps, posts, rails, lean-to tin roof.
    const pd = p.front;
    B.box("wood", WOOD_GREY, w - 0.4, 0.3, pd, 0, 0.25, d / 2 + pd / 2);
    B.box("wood", WOOD_GREY, 1.4, 0.15, 0.4, -w * 0.15, 0.08, d / 2 + pd + 0.2);
    const postZ = d / 2 + pd - 0.15;
    for (let i = 0; i < 4; i++) {
      const x = -w / 2 + 0.4 + (i * (w - 0.8)) / 3;
      B.box("wood", trim, 0.15, 2.2, 0.15, x, 1.5, postZ);
      circleAt(p.frame, x, postZ, 0.2);
    }
    for (const s of [-1, 1]) B.box("wood", trim, w * 0.3, 0.08, 0.06, s * w * 0.3, 1.25, postZ);
    B.box("wood", trim, w - 0.4, 0.16, 0.18, 0, 2.6, postZ);
    const drop = h + 0.1 - 2.65;
    const pa = Math.atan2(drop, pd + 0.3);
    B.box("metal", roof, w - 0.1, 0.05, Math.hypot(pd + 0.3, drop), 0, 2.65 + drop / 2 + 0.06, d / 2 + (pd + 0.3) / 2, 0, pa, 0, true);
    doorAt(-w * 0.15, d / 2, 0, 0.4, DOORS[Math.floor(r() * DOORS.length)], trim, false);
    windowAt(w * 0.22, d / 2, 0, 1.2, 1, 1.1, trim, null, null);
    for (const s of [-1, 1]) windowAt((s * w) / 2, -d * 0.1, (s * Math.PI) / 2, 1.2, 0.8, 1, trim, null, null);
    windowAt(w * 0.2, -d / 2, Math.PI, 1.3, 0.7, 0.8, trim, null, null);
    stovepipe(-w * 0.3, h + 0.2 + rise * 0.5, -d * 0.2, 1.4);
  };

  const store = (p: Plot, r: () => number) => {
    const { w, d, h } = p;
    const wall = 0xe0c9a2;
    B.box("stucco", wall, w, h + 1, d, 0, (h - 1) / 2, 0);
    B.box("paint", ROOF_DECK[0], w - 0.5, 0.06, d - 0.5, 0, h + 0.05, 0);
    for (const s of [-1, 1]) B.box("stucco", wall, 0.3, 0.5, d, s * (w / 2 - 0.15), h + 0.25, 0);
    B.box("stucco", wall, w, 0.5, 0.3, 0, h + 0.25, -d / 2 + 0.15);
    // Stepped false front carrying the painted sign.
    B.box("stucco", wall, w, 1.6, 0.35, 0, h + 0.8, d / 2 - 0.17);
    B.box("stucco", wall, w * 0.55, 0.5, 0.35, 0, h + 1.85, d / 2 - 0.17);
    B.box("wood", WOOD_DARK, w + 0.2, 0.14, 0.45, 0, h + 1.62, d / 2 - 0.1);
    B.box("sign", 0xffffff, 6.6, 1.75, 0.1, 0, h + 0.75, d / 2 + 0.03);
    B.add("sign", signPlane(6.4, 1.6, RECT.store), 0xffffff, 0, h + 0.75, d / 2 + 0.09);
    for (const s of [-1, 1]) {
      windowAt(s * 3.3, d / 2, 0, 0.75, 2.6, 1.7, 0x7d5a40, null, null);
    }
    const put = onWall(0, d / 2, 0);
    put("wood", 0x5b7c9c, 0.8, 2.3, 0.08, -0.42, 0.25 + 1.15, 0.02);
    put("wood", 0x5b7c9c, 0.8, 2.3, 0.08, 0.42, 0.25 + 1.15, 0.02);
    put("glass", GLASS, 0.5, 1.1, 0.04, -0.42, 1.7, 0.07);
    put("glass", GLASS, 0.5, 1.1, 0.04, 0.42, 1.7, 0.07);
    put("wood", 0x7d5a40, 2, 0.16, 0.12, 0, 2.62, 0.05);
    B.add("sign", signPlane(1.2, 0.6, RECT.drinks), 0xffffff, -1.6, 2.2, d / 2 + 0.03);
    B.add("sign", signPlane(0.6, 0.3, RECT.open), 0xffffff, 3.3, 1.9, d / 2 + 0.06);
    // Boardwalk porch with tin roof.
    const pz = d / 2 + p.front;
    B.box("wood", WOOD_GREY, w, 0.25, p.front + 0.2, 0, 0.12, d / 2 + p.front / 2);
    for (let i = 0; i < 5; i++) {
      const x = -w / 2 + 0.3 + (i * (w - 0.6)) / 4;
      B.box("wood", WOOD_BROWN, 0.2, 3.1, 0.2, x, 1.55, pz - 0.2);
      circleAt(p.frame, x, pz - 0.2, 0.22);
    }
    B.box("wood", WOOD_DARK, w, 0.2, 0.22, 0, 3.15, pz - 0.2);
    B.box("metal", 0xb3a493, w + 0.3, 0.05, p.front + 0.5, 0, 3.32, d / 2 + p.front / 2, 0, 0.08, 0, true);
    // Bench, crates, barrels, ice chest, soda cooler.
    B.box("wood", WOOD_BROWN, 2, 0.07, 0.45, -3.4, 0.7, d / 2 + 0.5);
    B.box("wood", WOOD_BROWN, 2, 0.4, 0.06, -3.4, 0.98, d / 2 + 0.3);
    for (const s of [-1, 1]) B.box("wood", WOOD_DARK, 0.07, 0.45, 0.4, -3.4 + s * 0.9, 0.47, d / 2 + 0.5);
    B.box("paint", 0xe8e6e0, 1.2, 0.9, 0.7, 2, 0.7, d / 2 + 0.5);
    B.box("paint", 0x2f5f86, 1.24, 0.08, 0.74, 2, 1.12, d / 2 + 0.5);
    B.box("paint", 0xa8382b, 0.9, 1.8, 0.7, 5.3, 1.15, d / 2 + 0.45);
    B.box("glass", GLASS, 0.6, 1.1, 0.04, 5.3, 1.35, d / 2 + 0.81);
    crate(-5.4, 0.25, d / 2 + 0.6, 0.6, 0.2);
    crate(-5.3, 0.73, d / 2 + 0.6, 0.5, -0.3);
    crate(w / 2 + 0.8, ground(p.frame, w / 2 + 0.8, 0), 0.5, 0.7, 0.4);
    barrel(w / 2 + 0.8, ground(p.frame, w / 2 + 0.8, -1.5), -1.5, 0x7b5a3c);
    swampCooler(-3, h, -1, 0);
    swampCooler(2.5, h, -2.5, 0.2);
    stovepipe(4, h, 2, 1);
    wobbleSpots.push({ type: "drum", pos: toW(p.frame, -w / 2 - 0.9, ground(p.frame, -w / 2 - 0.9, 3.5), 3.5), yaw: r(), tint: 0x3f6079 });
  };

  const gasStation = (p: Plot, r: () => number) => {
    const f = p.frame;
    const cz = p.d / 2 - 3.8; // canopy centre
    B.box("paint", 0xc9bfae, p.w + 2, 0.08, 9.5, 0, 0.04, cz + 0.5);
    for (const sx of [-4, 4]) {
      for (const sz of [-3, 3]) {
        B.box("paint", 0xe7e1d2, 0.3, 4.4, 0.3, sx, 2.2, cz + sz);
        circleAt(f, sx, cz + sz, 0.3);
      }
    }
    B.box("paint", 0xeee8da, 10.4, 0.55, 7.6, 0, 4.6, cz);
    B.box("paint", 0x9a3125, 10.5, 0.12, 7.7, 0, 4.3, cz);
    for (const s of [-1, 1]) B.add("sign", signPlane(6, 0.5, RECT.fascia), 0xffffff, 0, 4.62, cz + s * 3.82, { ry: s > 0 ? 0 : Math.PI });
    // Pump island with two vintage pumps.
    B.box("paint", CONCRETE, 5, 0.22, 1.2, 0, 0.11, cz);
    for (const s of [-1, 1]) {
      const x = s * 1.4;
      B.box("paint", 0xb03a2c, 0.62, 1.55, 0.45, x, 1, cz);
      B.box("paint", 0xe8e2d2, 0.66, 0.1, 0.49, x, 1.8, cz);
      B.add("paint", UNIT.ball, 0xf3efe4, x, 2.08, cz, { s: [0.22, 0.24, 0.22] });
      for (const fz of [-1, 1]) B.add("sign", signPlane(0.46, 0.7, RECT.pump), 0xffffff, x, 1.25, cz + fz * 0.235, { ry: fz > 0 ? 0 : Math.PI });
      B.cyl("paint", RUBBER, 0.025, 1.1, x + s * 0.34, 1.05, cz, 0, 0.15);
      B.box("paint", 0x4a4743, 0.08, 0.25, 0.12, x + s * 0.34, 1.2, cz + 0.1);
    }
    // Kiosk at the back with a big window and an awning.
    const kz = -p.d / 2 + 2.6;
    const kw = 7;
    B.box("stucco", 0xf0ebe1, kw, 4.2, 5, 0, 1.1, kz);
    B.box("stucco", 0xf0ebe1, kw, 0.45, 0.25, 0, 3.4, kz + 2.4);
    B.box("paint", ROOF_DECK[1], kw - 0.4, 0.06, 4.6, 0, 3.24, kz);
    B.box("paint", 0x9a3125, kw, 0.3, 0.06, 0, 3.0, kz + 2.53);
    windowAt(1.4, kz + 2.5, 0, 0.8, 2.6, 1.5, 0xe7e1d2, null, null);
    doorAt(-1.7, kz + 2.5, 0, 0, 0xe7e1d2, 0x9a3125, false);
    B.box("metal", 0xa8a49b, kw, 0.04, 1.4, 0, 2.7, kz + 3.2, 0, 0.18, 0, true);
    B.add("sign", signPlane(0.6, 0.3, RECT.open), 0xffffff, 1.4, 1.9, kz + 2.56);
    swampCooler(1.5, 3.3, kz - 0.8, 0);
    // Oil-can rack, tyre stacks, air pump, crates.
    const rx = -kw / 2 - 1;
    B.box("paint", 0x5a5853, 0.08, 1.5, 0.08, rx - 0.75, 0.75, kz + 1.8);
    B.box("paint", 0x5a5853, 0.08, 1.5, 0.08, rx + 0.75, 0.75, kz + 1.8);
    const canColors = [0xc8372b, 0xe0b23a, 0x2f5f9a, 0x3d7a4a, 0xd8d2c0];
    for (let shelf = 0; shelf < 3; shelf++) {
      const sy = 0.3 + shelf * 0.45;
      B.box("wood", WOOD_GREY, 1.6, 0.04, 0.45, rx, sy, kz + 1.8);
      for (let k = 0; k < 7; k++) B.box("paint", canColors[(k + shelf * 2) % 5], 0.16, 0.24, 0.12, rx - 0.6 + k * 0.2, sy + 0.14, kz + 1.8);
    }
    tyres(kw / 2 + 1, 0, kz + 1, 5);
    tyres(kw / 2 + 1.9, 0, kz + 1.4, 3);
    tyres(kw / 2 + 1.4, 0, kz + 0.2, 4);
    B.box("paint", 0xb03a2c, 0.3, 1.3, 0.25, -5.3, 0.65, cz + 2.5);
    B.box("paint", 0xe8e2d2, 0.34, 0.3, 0.3, -5.3, 1.3, cz + 2.5);
    crate(kw / 2 + 0.8, 0, kz - 1.5, 0.7, 0.3);
    crate(kw / 2 + 0.9, 0.56, kz - 1.5, 0.6, -0.2);
    rectCollider(f, 0, kz, kw, 5);
    circleAt(f, kw / 2 + 1.4, kz + 0.8, 0.9);
    for (const [x, z] of [[-6.2, 2.5], [6.2, -5.5]]) {
      wobbleSpots.push({ type: "drum", pos: toW(f, x, 0, z), yaw: r(), tint: [0x8a5a3a, 0x9a4535][wobbleSpots.length % 2] });
    }
  };

  /** Low adobe wall around the back yard with a gap for a gate. */
  const yardWall = (p: Plot, wall: number) => {
    const f = p.frame;
    const x = p.w / 2 + 2.5;
    const z0 = -p.d / 2 + 1.5;
    const z1 = -p.d / 2 - 7;
    const runs: [number, number, number, number][] = [
      [-x, z0, -x, z1],
      [-x, z1, x, z1],
      [x, z1, x, z0 - 2.5],
    ];
    for (const [ax, az, bx, bz] of runs) {
      if (!freeAt(f, ax, az, 0.3) || !freeAt(f, bx, bz, 0.3)) continue;
      const len = Math.hypot(bx - ax, bz - az);
      const ry = Math.atan2(bx - ax, bz - az);
      const yy = Math.min(ground(f, ax, az), ground(f, bx, bz));
      B.box("stucco", wall, 0.35, 1.5, len + 0.35, (ax + bx) / 2, yy + 0.35, (az + bz) / 2, ry);
      B.box("stucco", wall, 0.45, 0.1, len + 0.45, (ax + bx) / 2, yy + 1.12, (az + bz) / 2, ry);
      segmentAt(f, ax, az, bx, bz, 0.3);
    }
    // Wooden gate in the gap.
    if (freeAt(f, x, z0 - 1.2, 0.3)) B.box("wood", WOOD_GREY, 0.08, 1.0, 2.2, x, ground(f, x, z0 - 1.2) + 0.6, z0 - 1.25);
  };

  /** Picket fence across the front yard with a gate gap at the path. */
  const picketFence = (p: Plot, color: number) => {
    const f = p.frame;
    const z = p.d / 2 + p.front + 1.4;
    const x0 = -p.w / 2 - 1.5;
    const x1 = p.w / 2 + 1.5;
    const gate = -p.w * 0.15;
    for (const [a, b] of [[x0, gate - 0.7], [gate + 0.7, x1]]) {
      if (!freeAt(f, a, z, 0.25) || !freeAt(f, b, z, 0.25)) continue;
      const y = ground(f, (a + b) / 2, z);
      for (const ry of [0.35, 0.75]) B.box("wood", color, b - a, 0.07, 0.04, (a + b) / 2, y + ry, z - 0.03);
      for (let x = a; x <= b; x += 0.16) B.box("wood", color, 0.08, 0.95, 0.03, x, ground(f, x, z) + 0.45, z);
      for (let x = a; x <= b + 0.01; x += (b - a) / Math.max(1, Math.round((b - a) / 2.4))) B.box("wood", color, 0.1, 1.1, 0.1, x, ground(f, x, z) + 0.5, z - 0.05);
      segmentAt(f, a, z, b, z, 0.25);
    }
    // Side fences in wire and posts back to the house.
    for (const s of [-1, 1]) wireFence(f, [[s * (p.w / 2 + 1.5), z], [s * (p.w / 2 + 1.5), -p.d / 2 - 5], [0, -p.d / 2 - 5]]);
  };

  /** Posts with three strands of wire along a local polyline. */
  const wireFence = (f: Frame, pts: [number, number][]) => {
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      if (!freeAt(f, ax, az, 0.25) || !freeAt(f, bx, bz, 0.25)) continue;
      const len = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.round(len / 2.8));
      let prev: V3[] | null = null;
      for (let k = 0; k <= n; k++) {
        const x = ax + ((bx - ax) * k) / n;
        const z = az + ((bz - az) * k) / n;
        const y = ground(f, x, z);
        B.add("wood", UNIT.cyl, WOOD_DARK, x, y + 0.6, z, { s: [0.06, 1.3, 0.06], rz: (k % 3) * 0.04 - 0.04 });
        const strands = [0.4, 0.75, 1.1].map((h) => toW(f, x, y + h, z));
        if (prev) strands.forEach((s, j) => wire(prev![j], s, 0.04, 2));
        prev = strands;
      }
      segmentAt(f, ax, az, bx, bz, 0.2);
    }
  };

  const laundry = (f: Frame, lz: number, r: () => number) => {
    const ends: V3[] = [];
    for (const lx of [-2.8, 2.8]) {
      const y = ground(f, lx, lz);
      B.cyl("paint", STEEL, 0.05, 2, lx, y + 1, lz);
      B.box("paint", STEEL, 0.06, 0.06, 1.2, lx, y + 1.95, lz);
      ends.push(toW(f, lx, y + 1.95, lz - 0.4), toW(f, lx, y + 1.95, lz + 0.4));
    }
    wire(ends[0], ends[2], 0.12, 4);
    wire(ends[1], ends[3], 0.12, 4);
    for (const off of [-0.4, 0.4]) {
      for (let x = -2.2; x < 2.2; x += 0.9 + r() * 0.5) {
        const lzz = lz + off;
        cloths.push({ pos: new THREE.Vector3(...toW(f, x, ground(f, -2.8, lz) + 1.92 - 0.12 * (1 - (x / 2.8) ** 2), lzz)), yaw: f.yaw, w: 0.5 + r() * 0.5, h: 0.5 + r() * 0.5, phase: r() * 6 });
      }
    }
    circleAt(f, -2.8, lz, 0.15);
    circleAt(f, 2.8, lz, 0.15);
  };

  // ---------------------------------------------------------------- place the plots
  for (const p of plots) {
    const f = p.frame;
    const r = rng(p.seed);
    B.at(f);
    if (p.kind === "adobe" || p.kind === "adobeL") adobeHouse(p, r);
    else if (p.kind === "clap") clapHouse(p, r);
    else if (p.kind === "store") store(p, r);
    else gasStation(p, r);
    if (p.kind !== "gas") rectCollider(f, 0, 0, p.w, p.d);

    const { w, d } = p;
    const has = (e: string) => p.extras.includes(e);
    if (has("wall")) yardWall(p, STUCCO[Math.floor(r() * STUCCO.length)]);
    if (has("picket")) picketFence(p, r() < 0.5 ? 0xe2dccf : 0xb8a58c);
    if (has("wire")) wireFence(f, [[-w / 2 - 2, d / 2 - 1], [-w / 2 - 2, -d / 2 - 6], [w / 2 + 2, -d / 2 - 6], [w / 2 + 2, d / 2 - 1]]);
    if (has("laundry")) laundry(f, -d / 2 - 3.5, r);
    B.at(f);
    if (has("barrel") && freeAt(f, w / 2 + 0.5, -d / 2 + 0.6, 0.35)) barrel(w / 2 + 0.5, ground(f, w / 2 + 0.5, -d / 2 + 0.6), -d / 2 + 0.6, r() < 0.5 ? 0x2d4a5c : 0x7b4a2e);
    if (has("propane") && freeAt(f, -w / 2 - 1.4, -d / 2 + 2, 0.8)) {
      propane(-w / 2 - 1.4, ground(f, -w / 2 - 1.4, -d / 2 + 2), -d / 2 + 2, 0);
      circleAt(f, -w / 2 - 1.4, -d / 2 + 2, 0.8);
    }
    if (has("wood")) firewood(-w / 2 - 0.45, ground(f, -w / 2 - 0.45, -d / 2 + 1.8), -d / 2 + 1.8, Math.PI / 2);
    if (has("dog") && freeAt(f, w / 2 + 1.6, -d / 2 - 1.5, 0.7)) {
      dogHouse(w / 2 + 1.6, ground(f, w / 2 + 1.6, -d / 2 - 1.5), -d / 2 - 1.5, Math.PI / 2);
      circleAt(f, w / 2 + 1.6, -d / 2 - 1.5, 0.7);
    }
    if (has("tires")) tyres(w / 2 + 1, ground(f, w / 2 + 1, -d / 2 - 1), -d / 2 - 1, 4);
    if (has("cacti")) {
      for (const s of [-1, 1]) {
        const lx = s * (w / 2 + 1.4);
        const lz = d / 2 + 1.2;
        if (!freeAt(f, lx, lz, 0.5)) continue;
        if (s > 0) cactus(lx, ground(f, lx, lz), lz, 2.2 + r() * 1.2);
        else potPlant(lx, ground(f, lx, lz), lz, r);
        circleAt(f, lx, lz, 0.35);
      }
    }
    if (has("palm")) palm(f, -w / 2 - 2.2, d / 2 - 1, r);
    if (has("tamarisk")) tamarisk(f, w / 2 + 3, -d / 2 - 3, r);
    if (has("sedan")) vehicle(f, w / 2 + 3.4, d / 2 - 1.2, 0.15, false, 0x8fa3a8);
    if (has("pickup")) vehicle(f, -w / 2 - 3.4, d / 2 - 1.8, -0.2, true, r() < 0.5 ? 0x9a5a3a : 0x6f7f6a);

    // Mailbox at the road edge for every house.
    if (p.kind !== "gas" && p.kind !== "store") {
      const toRoad = toW(f, -w * 0.15 + 1.2, 0, d / 2);
      track.nearest(toRoad[0], toRoad[2], near);
      const s = track.at(near.index);
      const side = Math.sign(near.lateral) || 1;
      const mx = s.x - s.tz * side * (SOLID_CLEAR + 0.6);
      const mz = s.z + s.tx * side * (SOLID_CLEAR + 0.6);
      if (avoidDist(mx, mz) > 2) wobbleSpots.push({ type: "mailbox", pos: [mx, terrain.heightAt(mx, mz), mz], yaw: f.yaw, tint: [0xffffff, 0xd8e4ff, 0xffe0c8][Math.floor(r() * 3)] });
    }
  }

  // ---------------------------------------------------------------- water tower
  let vane: THREE.Mesh | null = null;
  if (towerOk) {
    const f = tower;
    B.at(f);
    const legH = 9;
    for (const [x, z] of [[-1.9, -1.9], [1.9, -1.9], [1.9, 1.9], [-1.9, 1.9]]) {
      B.add("paint", UNIT.box, 0x6e5e50, x * 1.08, legH / 2 - 0.5, z * 1.08, { s: [0.22, legH + 1, 0.22], rx: -Math.sign(z) * 0.04, rz: Math.sign(x) * 0.04 });
      circleAt(f, x * 1.08, z * 1.08, 0.35);
    }
    for (const lvl of [2.5, 6]) {
      for (const [ry, ox, oz] of [[0, 0, 2], [0, 0, -2], [Math.PI / 2, 2, 0], [Math.PI / 2, -2, 0]]) {
        for (const s of [-1, 1]) B.box("paint", 0x6e5e50, 0.07, Math.hypot(4, 3.4), 0.07, ox, lvl, oz, ry, 0, s * Math.atan2(4, 3.4));
        B.box("paint", 0x6e5e50, 4, 0.1, 0.1, ox, lvl + 1.7, oz, ry);
      }
    }
    B.box("wood", WOOD_GREY, 5.2, 0.15, 5.2, 0, legH, 0);
    B.add("metal", UNIT.cyl16, 0xbab4a6, 0, legH + 1.9, 0, { s: [2.3, 3.6, 2.3] });
    for (const yy of [legH + 0.6, legH + 1.9, legH + 3.2]) B.add("paint", UNIT.cyl16, 0x5d544a, 0, yy, 0, { s: [2.33, 0.08, 2.33] });
    B.add("paint", UNIT.cone, 0x76705f, 0, legH + 4.3, 0, { s: [2.5, 1.2, 2.5] });
    B.cyl("paint", 0x5d544a, 0.18, legH, 0, legH / 2, 0);
    circleAt(f, 0, 0, 0.3);
    // Ladder up one side.
    for (const s of [-1, 1]) B.box("paint", 0x5d544a, 0.05, legH + 3.6, 0.05, s * 0.25, (legH + 3.6) / 2, 2.4);
    for (let y = 0.4; y < legH + 3.4; y += 0.35) B.box("paint", 0x5d544a, 0.5, 0.03, 0.03, 0, y, 2.4);
    B.cyl("paint", 0x5d544a, 0.025, 1.2, 0, legH + 5.3, 0);
    B.box("paint", 0x5d544a, 1, 0.02, 0.02, 0, legH + 5.1, 0);
    B.box("paint", 0x5d544a, 0.02, 0.02, 1, 0, legH + 5.1, 0);

    const vb = new Batch();
    vb.box("paint", 0x3e3833, 0.04, 0.04, 1.1, 0, 0, 0);
    vb.add("paint", UNIT.cone, 0x3e3833, 0, 0, 0.6, { s: [0.08, 0.2, 0.08], rx: Math.PI / 2 });
    vb.box("paint", 0x3e3833, 0.02, 0.3, 0.32, 0, 0, -0.5);
    vb.add("paint", UNIT.ball, 0x3e3833, 0, -0.1, 0.1, { s: [0.1, 0.06, 0.25] });
    vane = new THREE.Mesh(vb.merged("paint"));
    const [vx, vy, vz] = toW(f, 0, legH + 5.6, 0);
    vane.position.set(vx, vy, vz);
    vane.castShadow = true;
  }

  // ---------------------------------------------------------------- poles, wires, lamps, signs
  B.at(null);
  const poleTops: { u: number; arm: V3[] }[] = [];
  for (let u = 6; u <= STRETCH; u += 31) {
    const f = roadside(u, -1, 9.8);
    if (!free(f.x, f.z, 0.25, true)) continue;
    f.y = terrain.heightAt(f.x, f.z);
    B.at(f);
    B.add("wood", UNIT.taper, 0x6a5544, 0, 4.2, 0, { s: [0.15, 8.8, 0.15] });
    B.box("wood", 0x6a5544, 0.12, 0.14, 2.3, 0, 8.2, 0);
    const arm: V3[] = [];
    for (const z of [-0.95, 0, 0.95]) {
      B.cyl("paint", 0x8fa0a0, 0.05, 0.16, 0, 8.36, z);
      arm.push(toW(f, 0, 8.42, z));
    }
    if (poleTops.length === 2) B.add("paint", UNIT.cyl, 0x8e908a, 0.35, 7.2, 0, { s: [0.28, 0.9, 0.28] });
    circle(f.x, f.z, 0.25);
    poleTops.push({ u, arm });
  }
  for (let i = 0; i + 1 < poleTops.length; i++) for (let k = 0; k < 3; k++) wire(poleTops[i].arm[k], poleTops[i + 1].arm[k], 0.55, 10);
  // Service drops from the nearest pole to each house.
  for (const p of plots) {
    if (p.kind === "gas" || !poleTops.length) continue;
    const at = toW(p.frame, p.w * 0.3, p.h - 0.3, p.d / 2 + 0.05);
    let best = poleTops[0];
    for (const t of poleTops) if (Math.hypot(t.arm[1][0] - at[0], t.arm[1][2] - at[2]) < Math.hypot(best.arm[1][0] - at[0], best.arm[1][2] - at[2])) best = t;
    wire(best.arm[1], at, 0.35, 8);
  }
  for (const u of [48, 96, 152]) {
    const f = roadside(u, 1, 9.6);
    if (!free(f.x, f.z, 0.2, true)) continue;
    f.y = terrain.heightAt(f.x, f.z);
    B.at(f);
    B.cyl("paint", 0x5e5c57, 0.09, 6.6, 0, 3.3, 0);
    B.box("paint", 0x5e5c57, 0.06, 0.06, 1.7, 0, 6.5, 0.8);
    B.box("paint", 0x4a4844, 0.35, 0.16, 0.6, 0, 6.42, 1.6);
    B.box("paint", 0xfff2c8, 0.28, 0.03, 0.5, 0, 6.33, 1.6);
    circle(f.x, f.z, 0.2);
  }
  // Warning signs either side of the entry, facing the oncoming driver.
  for (const side of [1, -1]) {
    const f = roadside(-14, side, SOLID_CLEAR + 0.3);
    const s = sampleAt(-14);
    if (avoidDist(f.x, f.z) > 2) wobbleSpots.push({ type: "sign", pos: [f.x, terrain.heightAt(f.x, f.z), f.z], yaw: Math.atan2(-s.tx, -s.tz), tint: 0xffffff });
  }

  // Rotating pole sign at the gas station.
  let gasSign: THREE.Mesh | null = null;
  const gas = plots.find((p) => p.kind === "gas");
  if (gas) {
    const f = gas.frame;
    const lx = gas.w / 2 + 0.6;
    const lz = gas.d / 2 - 0.4;
    B.at(f);
    B.cyl("paint", 0x6b6a66, 0.16, 8, lx, 4, lz);
    circleAt(f, lx, lz, 0.25);
    const sb = new Batch();
    sb.box("sign", 0xffffff, 2.7, 2.7, 0.25, 0, 0, 0);
    for (const s of [-1, 1]) sb.add("sign", signPlane(2.5, 2.5, RECT.brand), 0xffffff, 0, 0, s * 0.13, { ry: s > 0 ? 0 : Math.PI });
    gasSign = new THREE.Mesh(sb.merged("sign"));
    const [sx, sy, sz] = toW(f, lx, 9.2, lz);
    gasSign.position.set(sx, sy, sz);
    gasSign.castShadow = true;
  }

  // ---------------------------------------------------------------- meshes
  const signTex = signTexture();
  const mats: Record<MatKey, THREE.MeshStandardMaterial> = {
    stucco: new THREE.MeshStandardMaterial({ map: stuccoTexture(), vertexColors: true, roughness: 0.95 }),
    wood: new THREE.MeshStandardMaterial({ map: woodTexture(), vertexColors: true, roughness: 0.92 }),
    metal: new THREE.MeshStandardMaterial({ map: metalTexture(), vertexColors: true, roughness: 0.6, metalness: 0.25 }),
    paint: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    glass: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.5 }),
    sign: new THREE.MeshStandardMaterial({ map: signTex, vertexColors: true, roughness: 0.85 }),
  };
  const group = new THREE.Group();
  group.name = "village";
  for (const key of B.keys()) {
    const mesh = new THREE.Mesh(B.merged(key), mats[key]);
    mesh.castShadow = key !== "glass";
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  if (vane) {
    vane.material = mats.paint;
    group.add(vane);
  }
  if (gasSign) {
    gasSign.material = mats.sign;
    group.add(gasSign);
  }
  if (wires.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(wires, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x2b2420 })));
  }

  // Laundry: one instanced mesh, each cloth swings about its line.
  let laundryMesh: THREE.InstancedMesh | null = null;
  if (cloths.length) {
    const cb = new Batch();
    cb.box("paint", 0xffffff, 1, 1, 0.02, 0, -0.5, 0);
    laundryMesh = new THREE.InstancedMesh(cb.merged("paint"), mats.paint, cloths.length);
    const colors = [0xe9e4d8, 0x5b7fa6, 0xc4553f, 0xd9c27a, 0x7a9a6e, 0xf2f0ea];
    cloths.forEach((c, i) => laundryMesh!.setColorAt(i, _c.setHex(colors[i % colors.length])));
    laundryMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    laundryMesh.castShadow = true;
    group.add(laundryMesh);
  }

  // Wobbly things: mailboxes, drums, warning signs (instanced, soft colliders with ids).
  const wobblers: Wobbler[] = [];
  const shapes = {
    mailbox: (b: Batch) => {
      b.box("paint", 0x6b5440, 0.1, 1.1, 0.1, 0, 0.55, 0);
      b.box("paint", 0xa7aaa6, 0.26, 0.14, 0.5, 0, 1.15, 0);
      b.add("paint", UNIT.cyl, 0xa7aaa6, 0, 1.22, 0, { s: [0.13, 0.5, 0.13], rx: Math.PI / 2 });
      b.box("paint", 0xb8372a, 0.02, 0.18, 0.05, 0.14, 1.3, -0.12);
    },
    drum: (b: Batch) => {
      b.cyl("paint", 0xffffff, 0.3, 0.9, 0, 0.45, 0);
      for (const y of [0.3, 0.6]) b.cyl("paint", 0xe0e0e0, 0.315, 0.04, 0, y, 0);
      b.cyl("paint", 0x777777, 0.28, 0.02, 0, 0.91, 0);
    },
    sign: (b: Batch) => {
      b.cyl("paint", 0x9a9c98, 0.04, 2.2, 0, 1.1, 0);
      b.box("paint", 0x26231f, 0.8, 0.8, 0.03, 0, 2, 0.04, 0, 0, Math.PI / 4);
      b.box("paint", 0xdcb33c, 0.7, 0.7, 0.03, 0, 2, 0.06, 0, 0, Math.PI / 4);
      b.box("paint", 0x26231f, 0.08, 0.36, 0.01, 0, 2, 0.08);
    },
  };
  for (const type of ["mailbox", "drum", "sign"] as const) {
    const spots = wobbleSpots.filter((s) => s.type === type);
    if (!spots.length) continue;
    const b = new Batch();
    shapes[type](b);
    const mesh = new THREE.InstancedMesh(b.merged("paint"), mats.paint, spots.length);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.castShadow = true;
    spots.forEach((s, i) => {
      const w: Wobbler = { mesh, index: i, pos: new THREE.Vector3(...s.pos), yaw: s.yaw, angle: 0, vel: 0, ax: 1, az: 0 };
      wobblers.push(w);
      mesh.setColorAt(i, _c.setHex(s.tint));
      writeWobble(w);
      circle(s.pos[0], s.pos[2], type === "drum" ? 0.4 : 0.3, false, wobblers.length);
    });
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  scene.add(group);

  // Centre of the village (to skip animation when the car is far away).
  const mid = sampleAt(STRETCH / 2);
  const lastCar = new THREE.Vector3();
  const active = new Set<Wobbler>();

  /** Cloths flap about their line in gusts. */
  function swingLaundry(time: number): void {
    if (!laundryMesh) return;
    for (let i = 0; i < cloths.length; i++) {
      const c = cloths[i];
      const swing = 0.22 + Math.sin(time * 2.1 + c.phase) * 0.2 + Math.sin(time * 5.3 + c.phase * 2) * 0.06;
      _q.setFromAxisAngle(_axis.set(Math.cos(c.yaw), 0, -Math.sin(c.yaw)), swing);
      _q2.setFromAxisAngle(UP, c.yaw);
      _q.multiply(_q2);
      laundryMesh.setMatrixAt(i, _m.compose(c.pos, _q, _s.set(c.w, c.h, 1)));
    }
    laundryMesh.instanceMatrix.needsUpdate = true;
  }
  swingLaundry(0);

  function writeWobble(w: Wobbler): void {
    _q.setFromAxisAngle(_axis.set(w.ax, 0, w.az), w.angle);
    _q2.setFromAxisAngle(UP, w.yaw);
    _q.multiply(_q2);
    w.mesh.setMatrixAt(w.index, _m.compose(w.pos, _q, _s.set(1, 1, 1)));
    w.mesh.instanceMatrix.needsUpdate = true;
  }

  return {
    colliders,
    update(dt, time, carPos) {
      lastCar.copy(carPos);
      if (vane) vane.rotation.y = 1.2 + Math.sin(time * 0.23) * 0.5 + Math.sin(time * 0.061) * 1.3;
      if (gasSign) gasSign.rotation.y = time * 0.5;
      if ((carPos.x - mid.x) ** 2 + (carPos.z - mid.z) ** 2 > 200 * 200) return;
      swingLaundry(time);
      // Damped spring back to upright.
      for (const w of active) {
        w.vel += (-w.angle * 60 - w.vel * 5) * dt;
        w.angle = Math.max(-1.1, Math.min(1.1, w.angle + w.vel * dt));
        if (Math.abs(w.angle) < 1e-3 && Math.abs(w.vel) < 1e-2) {
          w.angle = 0;
          w.vel = 0;
          active.delete(w);
        }
        writeWobble(w);
      }
    },
    hit(id, strength) {
      const w = wobblers[id - 1];
      if (!w) return;
      // Tip away from the car: rotate about up × (direction from car).
      _v.set(w.pos.x - lastCar.x, 0, w.pos.z - lastCar.z).normalize();
      w.ax = _v.z;
      w.az = -_v.x;
      w.vel += 3 + strength * 9;
      active.add(w);
    },
  };
}

