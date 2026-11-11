import * as THREE from "three";

/**
 * Procedural canvas textures and the shared materials built on them. Everything is cached, so
 * calling a factory twice returns the same texture/material (never dispose them per prop).
 * Random details use a seeded PRNG, so the art looks identical on every run.
 */

type Rand = () => number;
type Draw = (g: CanvasRenderingContext2D, w: number, h: number) => void;

export function makeCanvasTexture(
  width: number,
  height: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  draw(g, width, height);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Small deterministic PRNG (mulberry32). */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const textures = new Map<string, THREE.Texture>();
const materials = new Map<string, THREE.Material>();

function cachedTexture(key: string, create: () => THREE.Texture): THREE.Texture {
  let tex = textures.get(key);
  if (!tex) {
    tex = create();
    textures.set(key, tex);
  }
  return tex;
}

function cachedMaterial<T extends THREE.Material>(key: string, create: () => T): T {
  let mat = materials.get(key);
  if (!mat) {
    mat = create();
    materials.set(key, mat);
  }
  return mat as T;
}

/** Canvas texture that tiles (RepeatWrapping on both axes). */
function tiling(width: number, height: number, draw: Draw, anisotropy = 8): THREE.CanvasTexture {
  const tex = makeCanvasTexture(width, height, draw);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = anisotropy;
  return tex;
}

// ---------------------------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------------------------

/** Monochrome per-pixel grain. */
function addNoise(g: CanvasRenderingContext2D, w: number, h: number, amount: number, rand: Rand): void {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rand() - 0.5) * amount;
    d[i] += n;
    d[i + 1] += n;
    d[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

/**
 * Calls draw at (x, y) plus its wrapped copies so features cross tile edges seamlessly.
 * A tile size of 0 disables wrapping on that axis.
 */
function wrapped(
  x: number,
  y: number,
  reach: number,
  w: number,
  h: number,
  draw: (x: number, y: number) => void,
): void {
  const xs = [x];
  const ys = [y];
  if (w > 0 && x - reach < 0) xs.push(x + w);
  if (w > 0 && x + reach > w) xs.push(x - w);
  if (h > 0 && y - reach < 0) ys.push(y + h);
  if (h > 0 && y + reach > h) ys.push(y - h);
  for (const px of xs) for (const py of ys) draw(px, py);
}

/** Irregular patch made of overlapping circles. Wraps on both axes of a w×h tile. */
function blob(
  g: CanvasRenderingContext2D,
  rand: Rand,
  x: number,
  y: number,
  r: number,
  color: string,
  alpha: number,
  w: number,
  h: number,
  squashY = 1,
): void {
  g.fillStyle = color;
  g.globalAlpha = alpha;
  const lobes = 5 + Math.floor(rand() * 6);
  for (let i = 0; i < lobes; i++) {
    const a = rand() * Math.PI * 2;
    const d = rand() * r * 0.75;
    const cx = x + Math.cos(a) * d;
    const cy = y + Math.sin(a) * d * squashY;
    const rr = r * (0.3 + rand() * 0.45);
    wrapped(cx, cy, rr, w, h, (px, py) => {
      g.beginPath();
      g.ellipse(px, py, rr, rr * squashY, 0, 0, Math.PI * 2);
      g.fill();
    });
  }
  g.globalAlpha = 1;
}

function speckles(
  g: CanvasRenderingContext2D,
  rand: Rand,
  x: number,
  y: number,
  spread: number,
  count: number,
  colors: string[],
  w: number,
  h: number,
): void {
  for (let i = 0; i < count; i++) {
    g.fillStyle = colors[Math.floor(rand() * colors.length)];
    g.globalAlpha = 0.35 + rand() * 0.5;
    const a = rand() * Math.PI * 2;
    const d = Math.sqrt(rand()) * spread;
    const s = 0.6 + rand() * 1.8;
    wrapped(x + Math.cos(a) * d, y + Math.sin(a) * d, s, w, h, (px, py) => {
      g.fillRect(px, py, s, s);
    });
  }
  g.globalAlpha = 1;
}

/** Layered rust: halo, body, dark core, flakes. */
function rustPatch(
  g: CanvasRenderingContext2D,
  rand: Rand,
  x: number,
  y: number,
  r: number,
  w: number,
  h: number,
  squashY = 1,
): void {
  blob(g, rand, x, y, r * 1.25, "#6f4a2e", 0.28, w, h, squashY);
  blob(g, rand, x, y, r, "#9c5a2b", 0.72, w, h, squashY);
  blob(g, rand, x + r * 0.15, y, r * 0.55, "#b8692f", 0.55, w, h, squashY);
  blob(g, rand, x - r * 0.1, y, r * 0.45, "#5e2f17", 0.6, w, h, squashY);
  speckles(g, rand, x, y, r * 1.7, Math.floor(r * 2.2), ["#a9622c", "#5a2b14", "#7b4220"], w, h);
}

function withCircleClip(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  draw: () => void,
): void {
  g.save();
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.clip();
  draw();
  g.restore();
}

/** Diagonal yellow/black stripes filling a rect (period in px). */
function hazardStripes(
  g: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  period: number,
): void {
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  g.fillStyle = "#e9b51c";
  g.fillRect(x, y, w, h);
  g.fillStyle = "#1c1b1a";
  for (let sx = x - h - period; sx < x + w + period; sx += period) {
    g.beginPath();
    g.moveTo(sx, y + h);
    g.lineTo(sx + period / 2, y + h);
    g.lineTo(sx + period / 2 + h, y);
    g.lineTo(sx + h, y);
    g.closePath();
    g.fill();
  }
  g.restore();
}

/** White diamond with a black flame: the flammable warning label. */
function flammableLabel(g: CanvasRenderingContext2D, cx: number, cy: number, size: number): void {
  const s = size / 2;
  g.save();
  g.translate(cx, cy);
  g.fillStyle = "#f3efe6";
  g.strokeStyle = "#1c1b1a";
  g.lineWidth = Math.max(1.5, size * 0.05);
  g.beginPath();
  g.moveTo(0, -s);
  g.lineTo(s, 0);
  g.lineTo(0, s);
  g.lineTo(-s, 0);
  g.closePath();
  g.fill();
  g.stroke();
  const f = s * 0.5;
  g.fillStyle = "#1c1b1a";
  g.beginPath();
  g.moveTo(0, -f * 1.05);
  g.bezierCurveTo(f * 0.55, -f * 0.35, f * 0.75, f * 0.25, f * 0.4, f * 0.7);
  g.bezierCurveTo(f * 0.2, f * 0.85, -f * 0.2, f * 0.85, -f * 0.4, f * 0.7);
  g.bezierCurveTo(-f * 0.75, f * 0.25, -f * 0.3, -f * 0.2, -f * 0.1, -f * 0.25);
  g.bezierCurveTo(-f * 0.05, -f * 0.55, 0.05 * f, -f * 0.8, 0, -f * 1.05);
  g.fill();
  g.fillRect(-f * 0.55, f * 0.82, f * 1.1, f * 0.14);
  g.restore();
}

// ---------------------------------------------------------------------------------------------
// Floor
// ---------------------------------------------------------------------------------------------

/** Metres covered by one repeat of the grid texture (minor line every metre, major every 5). */
export const GRID_TILE_METRES = 5;

export function makeGridTexture(): THREE.Texture {
  return cachedTexture("grid", () =>
    tiling(
      1024,
      1024,
      (g, w, h) => {
        const rand = seededRandom(11);
        g.fillStyle = "#273142";
        g.fillRect(0, 0, w, h);
        // Very soft mottling so the floor doesn't look like flat CG.
        for (let i = 0; i < 40; i++) {
          blob(g, rand, rand() * w, rand() * h, 60 + rand() * 120, rand() > 0.5 ? "#2b3648" : "#232c3b", 0.18, w, h);
        }
        addNoise(g, w, h, 6, rand);
        const cell = w / GRID_TILE_METRES;
        const line = (pos: number, width: number, color: string): void => {
          g.fillStyle = color;
          g.fillRect(pos - width / 2, 0, width, h);
          g.fillRect(0, pos - width / 2, w, width);
        };
        for (let i = 1; i < GRID_TILE_METRES; i++) line(i * cell, 3, "#2e394c");
        // Major line sits on the tile edge: draw both halves so it tiles seamlessly.
        line(0, 7, "#35425a");
        line(w, 7, "#35425a");
      },
      16,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Barrels
// ---------------------------------------------------------------------------------------------

export type BarrelVariant = "blue" | "green" | "rust" | "explosive";

interface BarrelPaint {
  body: string;
  lid: string;
  rust: number; // 0..1 amount of rust patches
}

const BARREL_PAINT: Record<BarrelVariant, BarrelPaint> = {
  blue: { body: "#2e5d8a", lid: "#6c8aa3", rust: 0.6 },
  green: { body: "#3d5a3b", lid: "#73876f", rust: 0.6 },
  rust: { body: "#6b604f", lid: "#8a8072", rust: 1 },
  explosive: { body: "#b02a20", lid: "#b8352a", rust: 0.2 },
};

/**
 * Barrel atlas layout (UV space, v up): the side wraps u 0..1 over v SIDE_V0..1 (v = 1 is the top
 * rim), the top lid is the disc inscribed in TOP_LID, the bottom lid in BOTTOM_LID.
 */
export const BARREL_ATLAS = {
  SIDE_V0: 0.25,
  TOP_LID: { u0: 0, v0: 0, u1: 0.25, v1: 0.25 },
  BOTTOM_LID: { u0: 0.25, v0: 0, u1: 0.5, v1: 0.25 },
  /** Relative heights (0 = bottom, 1 = top) of the two rolling hoops, shared with the geometry. */
  RIBS: [1 / 3, 2 / 3] as const,
};

const ATLAS_SIZE = 512;
const SIDE_PX = ATLAS_SIZE * (1 - BARREL_ATLAS.SIDE_V0);
const LID_PX = ATLAS_SIZE * 0.25;

/** Canvas y of a relative barrel height (0 bottom .. 1 top) inside the side band. */
const sideY = (rel: number): number => (1 - rel) * SIDE_PX;

function drawBarrelSide(g: CanvasRenderingContext2D, rand: Rand, variant: BarrelVariant): void {
  const paint = BARREL_PAINT[variant];
  const w = ATLAS_SIZE;
  const h = SIDE_PX;
  g.save();
  g.beginPath();
  g.rect(0, 0, w, h);
  g.clip();

  g.fillStyle = paint.body;
  g.fillRect(0, 0, w, h);
  const shade = g.createLinearGradient(0, 0, 0, h);
  shade.addColorStop(0, "rgba(255,255,255,0.10)");
  shade.addColorStop(0.5, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.22)");
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);

  // Faded vertical paint streaks.
  for (let i = 0; i < 60; i++) {
    g.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.06)";
    g.fillRect(rand() * w, 0, 1 + rand() * 4, h);
  }

  if (variant === "explosive") {
    hazardStripes(g, 0, sideY(0.94), w, sideY(0.76) - sideY(0.94), 28);
    flammableLabel(g, w * 0.25, sideY(0.5), 92);
    flammableLabel(g, w * 0.75, sideY(0.5), 92);
  }

  // Rolling hoops and chime rims.
  for (const rib of BARREL_ATLAS.RIBS) {
    const y = sideY(rib);
    g.fillStyle = "rgba(0,0,0,0.35)";
    g.fillRect(0, y - 7, w, 3);
    g.fillStyle = "rgba(255,255,255,0.16)";
    g.fillRect(0, y - 3, w, 5);
    g.fillStyle = "rgba(0,0,0,0.28)";
    g.fillRect(0, y + 3, w, 3);
  }
  g.fillStyle = "rgba(20,14,10,0.45)";
  g.fillRect(0, 0, w, 12);
  g.fillRect(0, h - 14, w, 14);

  // Rust: patches concentrate near the rims and the bottom, drips run down from the top.
  const patches = Math.round(10 + 26 * paint.rust);
  for (let i = 0; i < patches; i++) {
    const nearRim = rand() < 0.55;
    const y = nearRim ? (rand() < 0.4 ? rand() * 30 : h - rand() * 45) : rand() * h;
    rustPatch(g, rand, rand() * w, y, 5 + rand() * 18 * (0.5 + paint.rust), w, 0, 0.8);
  }
  const drips = Math.round(6 + 18 * paint.rust);
  for (let i = 0; i < drips; i++) {
    const x = rand() * w;
    const len = 20 + rand() * 90;
    const grad = g.createLinearGradient(0, 8, 0, 8 + len);
    grad.addColorStop(0, "rgba(130,70,32,0.55)");
    grad.addColorStop(1, "rgba(130,70,32,0)");
    g.fillStyle = grad;
    g.fillRect(x, 8, 1.5 + rand() * 3, len);
  }

  // Scratches and dents.
  g.strokeStyle = "rgba(220,215,200,0.25)";
  g.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const x = rand() * w;
    const y = rand() * h;
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + (rand() - 0.5) * 40, y + (rand() - 0.5) * 12);
    g.stroke();
  }
  for (let i = 0; i < 5; i++) {
    const x = rand() * w;
    const y = 30 + rand() * (h - 60);
    const r = 10 + rand() * 18;
    const dent = g.createRadialGradient(x, y, 0, x, y, r);
    dent.addColorStop(0, "rgba(0,0,0,0.25)");
    dent.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = dent;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
}

function drawBarrelLid(
  g: CanvasRenderingContext2D,
  rand: Rand,
  variant: BarrelVariant,
  ox: number,
  oy: number,
  top: boolean,
): void {
  const paint = BARREL_PAINT[variant];
  const s = LID_PX;
  const c = s / 2;
  const cx = ox + c;
  const cy = oy + c;
  withCircleClip(g, cx, cy, c, () => {
    g.fillStyle = paint.lid;
    g.fillRect(ox, oy, s, s);
    const sheen = g.createRadialGradient(cx - c * 0.3, cy - c * 0.3, 0, cx, cy, c);
    sheen.addColorStop(0, "rgba(255,255,255,0.12)");
    sheen.addColorStop(1, "rgba(0,0,0,0.18)");
    g.fillStyle = sheen;
    g.fillRect(ox, oy, s, s);

    if (variant === "explosive") {
      g.save();
      g.beginPath();
      g.arc(cx, cy, c * 0.97, 0, Math.PI * 2);
      g.arc(cx, cy, c * 0.74, 0, Math.PI * 2, true);
      g.clip();
      hazardStripes(g, ox, oy, s, s, 14);
      g.restore();
      flammableLabel(g, cx, cy, c * 0.9);
    }

    // Pressed stiffening ring.
    g.lineWidth = 2;
    g.strokeStyle = "rgba(0,0,0,0.25)";
    g.beginPath();
    g.arc(cx, cy, c * 0.7, 0, Math.PI * 2);
    g.stroke();
    g.strokeStyle = "rgba(255,255,255,0.12)";
    g.beginPath();
    g.arc(cx, cy, c * 0.7 + 2, 0, Math.PI * 2);
    g.stroke();

    const patches = Math.round(3 + 9 * paint.rust);
    for (let i = 0; i < patches; i++) {
      const a = rand() * Math.PI * 2;
      const d = Math.sqrt(rand()) * c * 0.9;
      rustPatch(g, rand, cx + Math.cos(a) * d, cy + Math.sin(a) * d, 4 + rand() * 13 * (0.4 + paint.rust), 0, 0);
    }

    if (top) {
      // Bung caps: a large and a small one, like a real drum.
      const bung = (bx: number, by: number, r: number): void => {
        g.fillStyle = "rgba(0,0,0,0.35)";
        g.beginPath();
        g.arc(bx + 1, by + 1.5, r * 1.15, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#77706a";
        g.beginPath();
        g.arc(bx, by, r, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#4b4642";
        g.beginPath();
        g.arc(bx, by, r * 0.45, 0, Math.PI * 2);
        g.fill();
      };
      bung(cx + c * 0.48, cy - c * 0.22, c * 0.13);
      bung(cx - c * 0.5, cy + c * 0.18, c * 0.08);
    }

    // Dark chime edge.
    g.lineWidth = 5;
    g.strokeStyle = "rgba(30,22,16,0.55)";
    g.beginPath();
    g.arc(cx, cy, c - 2.5, 0, Math.PI * 2);
    g.stroke();
  });
}

/** Painted rusty barrel atlas (side + both lids, see BARREL_ATLAS). */
export function makeBarrelTexture(variant: BarrelVariant): THREE.Texture {
  return cachedTexture(`barrel-${variant}`, () => {
    const seed = { blue: 21, green: 22, rust: 23, explosive: 24 }[variant];
    const tex = makeCanvasTexture(ATLAS_SIZE, ATLAS_SIZE, (g, w, h) => {
      const rand = seededRandom(seed);
      g.fillStyle = "#2a2622";
      g.fillRect(0, 0, w, h);
      drawBarrelSide(g, rand, variant);
      drawBarrelLid(g, rand, variant, 0, SIDE_PX, true);
      drawBarrelLid(g, rand, variant, LID_PX, SIDE_PX, false);
      addNoise(g, w, h, 14, rand);
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = 8;
    return tex;
  });
}

/** Stand-alone rusty lid (for anything that wants just the top of a drum). */
export function makeRustyLidTexture(variant: BarrelVariant = "rust"): THREE.Texture {
  return cachedTexture(`lid-${variant}`, () =>
    makeCanvasTexture(LID_PX, LID_PX, (g, w, h) => {
      const rand = seededRandom(31);
      drawBarrelLid(g, rand, variant, 0, 0, true);
      addNoise(g, w, h, 14, rand);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Wood, crates, concrete, plastic, fabric
// ---------------------------------------------------------------------------------------------

/** Light weathered planks, 1 m per repeat, grain along U. Tint with vertex colours. */
export function makeWoodTexture(): THREE.Texture {
  return cachedTexture("wood", () =>
    tiling(256, 256, (g, w, h) => {
      const rand = seededRandom(41);
      g.fillStyle = "#c79f71";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        const y0 = rand() * h;
        const amp = 1 + rand() * 4;
        const periods = 1 + Math.floor(rand() * 3);
        const phase = rand() * Math.PI * 2;
        g.strokeStyle = rand() > 0.3 ? "#8f6a43" : "#e0bc8e";
        g.globalAlpha = 0.15 + rand() * 0.35;
        g.lineWidth = 0.6 + rand() * 1.8;
        for (const off of [0, h, -h]) {
          g.beginPath();
          for (let x = 0; x <= w; x += 8) {
            const y = y0 + off + Math.sin((x / w) * Math.PI * 2 * periods + phase) * amp;
            if (x === 0) g.moveTo(x, y);
            else g.lineTo(x, y);
          }
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      for (let i = 0; i < 4; i++) {
        const x = rand() * w;
        const y = rand() * h;
        wrapped(x, y, 10, w, h, (px, py) => {
          g.fillStyle = "rgba(90,60,35,0.55)";
          g.beginPath();
          g.ellipse(px, py, 6 + rand() * 4, 3 + rand() * 2, 0, 0, Math.PI * 2);
          g.fill();
          g.strokeStyle = "rgba(90,60,35,0.3)";
          g.beginPath();
          g.ellipse(px, py, 11, 5, 0, 0, Math.PI * 2);
          g.stroke();
        });
      }
      addNoise(g, w, h, 16, rand);
    }),
  );
}

/** Region of the crate texture that is plain frame board (for frame geometry UVs). */
export const CRATE_FRAME_UV = { u0: 0.02, v0: 0.2, u1: 0.1, v1: 0.8 };

/** One crate face (UV 0..1 per face): framed planks with a diagonal brace and nails. */
export function makeCrateTexture(): THREE.Texture {
  return cachedTexture("crate", () =>
    makeCanvasTexture(256, 256, (g, w, h) => {
      const rand = seededRandom(51);
      const planks = 5;
      const ph = h / planks;
      for (let i = 0; i < planks; i++) {
        const l = 0.88 + rand() * 0.16;
        g.fillStyle = `rgb(${Math.round(186 * l)},${Math.round(142 * l)},${Math.round(92 * l)})`;
        g.fillRect(0, i * ph, w, ph);
        g.strokeStyle = "rgba(110,75,40,0.35)";
        for (let k = 0; k < 7; k++) {
          const y = i * ph + 4 + rand() * (ph - 8);
          g.lineWidth = 0.6 + rand();
          g.beginPath();
          g.moveTo(0, y);
          g.bezierCurveTo(w * 0.3, y + rand() * 4 - 2, w * 0.7, y + rand() * 4 - 2, w, y);
          g.stroke();
        }
        g.fillStyle = "rgba(40,25,12,0.75)";
        g.fillRect(0, i * ph - 1.5, w, 3);
      }
      const frame = 30;
      const board = (x: number, y: number, bw: number, bh: number): void => {
        g.fillStyle = "#9a6d3e";
        g.fillRect(x, y, bw, bh);
        g.strokeStyle = "rgba(70,45,20,0.4)";
        g.lineWidth = 1;
        const vertical = bh > bw;
        for (let k = 0; k < 5; k++) {
          const t = 4 + rand() * ((vertical ? bw : bh) - 8);
          g.beginPath();
          if (vertical) {
            g.moveTo(x + t, y);
            g.lineTo(x + t + rand() * 2 - 1, y + bh);
          } else {
            g.moveTo(x, y + t);
            g.lineTo(x + bw, y + t + rand() * 2 - 1);
          }
          g.stroke();
        }
        g.strokeStyle = "rgba(35,22,10,0.8)";
        g.lineWidth = 2;
        g.strokeRect(x + 1, y + 1, bw - 2, bh - 2);
      };
      // Diagonal brace under the frame.
      g.save();
      g.translate(w / 2, h / 2);
      g.rotate(-Math.atan2(h - frame * 2, w - frame * 2));
      const len = Math.hypot(w, h);
      board(-len / 2, -15, len, 30);
      g.restore();
      board(0, 0, frame, h);
      board(w - frame, 0, frame, h);
      board(frame, 0, w - frame * 2, frame);
      board(frame, h - frame, w - frame * 2, frame);
      g.fillStyle = "#3b3632";
      for (const [x, y] of [
        [15, 15],
        [w - 15, 15],
        [15, h - 15],
        [w - 15, h - 15],
        [15, h / 2],
        [w - 15, h / 2],
        [w / 2, 15],
        [w / 2, h - 15],
      ]) {
        g.beginPath();
        g.arc(x, y, 2.4, 0, Math.PI * 2);
        g.fill();
      }
      addNoise(g, w, h, 18, rand);
    }),
  );
}

/** Off-white cast concrete, 1 m per repeat. */
export function makeConcreteTexture(): THREE.Texture {
  return cachedTexture("concrete", () =>
    tiling(256, 256, (g, w, h) => {
      const rand = seededRandom(61);
      g.fillStyle = "#d9d5cb";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 26; i++) {
        blob(g, rand, rand() * w, rand() * h, 20 + rand() * 50, rand() > 0.5 ? "#c9c4b8" : "#e6e2d8", 0.25, w, h);
      }
      for (let i = 0; i < 6; i++) {
        blob(g, rand, rand() * w, rand() * h, 8 + rand() * 18, "#a8a296", 0.2, w, h);
      }
      for (let i = 0; i < 160; i++) {
        g.fillStyle = `rgba(80,76,70,${0.2 + rand() * 0.4})`;
        const s = 0.8 + rand() * 1.8;
        g.beginPath();
        g.arc(rand() * w, rand() * h, s, 0, Math.PI * 2);
        g.fill();
      }
      addNoise(g, w, h, 22, rand);
    }),
  );
}

/** Near-white moulded plastic (tint with vertex colours), 1 m per repeat. */
export function makePlasticTexture(): THREE.Texture {
  return cachedTexture("plastic", () =>
    tiling(256, 256, (g, w, h) => {
      const rand = seededRandom(71);
      g.fillStyle = "#f4f4f4";
      g.fillRect(0, 0, w, h);
      for (let i = 0; i < 30; i++) {
        g.fillStyle = rand() > 0.5 ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.04)";
        g.fillRect(0, rand() * h, w, 1 + rand() * 3);
      }
      for (let i = 0; i < 14; i++) {
        blob(g, rand, rand() * w, rand() * h, 6 + rand() * 22, "#8a8580", 0.08, w, h);
      }
      g.strokeStyle = "rgba(60,55,50,0.18)";
      for (let i = 0; i < 30; i++) {
        const x = rand() * w;
        const y = rand() * h;
        g.lineWidth = 0.5 + rand();
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + (rand() - 0.5) * 30, y + (rand() - 0.5) * 8);
        g.stroke();
      }
      addNoise(g, w, h, 8, rand);
    }),
  );
}

/** Coarse woven sack cloth (tint with vertex colours). */
export function makeSandbagTexture(): THREE.Texture {
  return cachedTexture("sandbag", () => {
    const tex = tiling(128, 128, (g, w, h) => {
      const rand = seededRandom(81);
      g.fillStyle = "#ebe6dc";
      g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 4) {
        g.fillStyle = "rgba(90,80,60,0.16)";
        g.fillRect(0, y, w, 1.5);
      }
      for (let x = 0; x < w; x += 4) {
        g.fillStyle = "rgba(90,80,60,0.12)";
        g.fillRect(x, 0, 1.5, h);
      }
      for (let i = 0; i < 10; i++) {
        blob(g, rand, rand() * w, rand() * h, 8 + rand() * 16, "#8c7d62", 0.12, w, h);
      }
      addNoise(g, w, h, 20, rand);
    });
    tex.repeat.set(5, 3);
    return tex;
  });
}

/** Yellow/black diagonal hazard stripes. */
export function makeHazardTexture(): THREE.Texture {
  return cachedTexture("hazard", () =>
    tiling(128, 128, (g, w, h) => {
      const rand = seededRandom(91);
      hazardStripes(g, 0, 0, w, h, 64);
      addNoise(g, w, h, 12, rand);
    }),
  );
}

/** Light urban camo (white / greys) for uniforms. Tiles seamlessly. */
export function makeCamoTexture(): THREE.Texture {
  return cachedTexture("camo", () =>
    tiling(256, 256, (g, w, h) => {
      const rand = seededRandom(101);
      g.fillStyle = "#d8dbdf";
      g.fillRect(0, 0, w, h);
      const layers: Array<[string, number, number]> = [
        ["#b3b8be", 22, 26],
        ["#8a9098", 16, 18],
        ["#5c626a", 14, 9],
      ];
      for (const [color, count, size] of layers) {
        for (let i = 0; i < count; i++) {
          blob(g, rand, rand() * w, rand() * h, size * (0.6 + rand() * 0.8), color, 0.95, w, h, 0.7);
        }
      }
      addNoise(g, w, h, 10, rand);
    }),
  );
}

/** Traffic cone side: orange with two reflective white bands (v = 0 bottom .. 1 apex). */
export function makeConeTexture(): THREE.Texture {
  return cachedTexture("cone", () =>
    makeCanvasTexture(64, 256, (g, w, h) => {
      const rand = seededRandom(111);
      g.fillStyle = "#ff6a1c";
      g.fillRect(0, 0, w, h);
      g.fillStyle = "#f2f1ea";
      g.fillRect(0, h * 0.24, w, h * 0.12);
      g.fillRect(0, h * 0.48, w, h * 0.1);
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(0, h * 0.92, w, h * 0.08);
      addNoise(g, w, h, 10, rand);
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Shared materials
// ---------------------------------------------------------------------------------------------

export function floorMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial("floor", () => new THREE.MeshStandardMaterial({ map: makeGridTexture(), roughness: 0.94, metalness: 0 }));
}

/** Painted steel drum. All variants share the same atlas layout. */
export function barrelMaterial(variant: BarrelVariant): THREE.MeshStandardMaterial {
  return cachedMaterial(
    `barrel-${variant}`,
    () => new THREE.MeshStandardMaterial({ map: makeBarrelTexture(variant), roughness: 0.62, metalness: 0.22 }),
  );
}

/** Wood with vertex colours (planks/pickets get individual tints). */
export function woodMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "wood",
    () => new THREE.MeshStandardMaterial({ map: makeWoodTexture(), vertexColors: true, roughness: 0.88 }),
  );
}

export function crateMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial("crate", () => new THREE.MeshStandardMaterial({ map: makeCrateTexture(), roughness: 0.84 }));
}

/** Concrete with vertex colours (slots and seams are dark vertex-coloured parts). */
export function concreteMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "concrete",
    () => new THREE.MeshStandardMaterial({ map: makeConcreteTexture(), vertexColors: true, roughness: 0.95 }),
  );
}

/** Moulded plastic; colour comes from vertex colours (orange body, white strips, caps). */
export function plasticMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "plastic",
    () => new THREE.MeshStandardMaterial({ map: makePlasticTexture(), vertexColors: true, roughness: 0.5 }),
  );
}

export function sandbagMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "sandbag",
    () => new THREE.MeshStandardMaterial({ map: makeSandbagTexture(), vertexColors: true, roughness: 1 }),
  );
}

export function rubberMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "rubber",
    () => new THREE.MeshStandardMaterial({ color: 0x26282b, roughness: 0.9 }),
  );
}

export function coneMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "cone",
    () => new THREE.MeshStandardMaterial({ map: makeConeTexture(), vertexColors: true, roughness: 0.55 }),
  );
}

/** Dark structural steel (target stands, brackets). */
export function steelMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "steel",
    () => new THREE.MeshStandardMaterial({ color: 0x40454d, roughness: 0.5, metalness: 0.55 }),
  );
}

/** Painted steel target plate. */
export function targetPlateMaterial(): THREE.MeshStandardMaterial {
  return cachedMaterial(
    "target-plate",
    () => new THREE.MeshStandardMaterial({ color: 0xf0e8d2, roughness: 0.42, metalness: 0.2 }),
  );
}
