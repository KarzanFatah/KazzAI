import * as THREE from "three";

/** Road half width in metres (the drivable compacted strip). */
export const ROAD_HALF_WIDTH = 6;

/** Control points of the closed rally loop (x, z). Driving direction follows this order. */
const CONTROL: [number, number][] = [
  [0, 150],
  [-70, 170],
  [-140, 150],
  [-185, 95],
  [-175, 30],
  [-125, -25],
  [-60, -92],
  [5, -118],
  [75, -105],
  [135, -45],
  [175, 25],
  [160, 95],
  [110, 122],
  [70, 95],
  [40, 132],
];

export interface TrackSample {
  x: number;
  z: number;
  /** Road surface height (filled in by Terrain). */
  y: number;
  /** Unit tangent in the driving direction. */
  tx: number;
  tz: number;
  /** Distance along the loop from the start line. */
  s: number;
}

export interface NearestResult {
  index: number;
  /** Unsigned distance from the road centre line. */
  distance: number;
  /** Signed lateral offset: + = right of the driving direction. */
  lateral: number;
}

export interface Checkpoint {
  index: number;
  x: number;
  z: number;
  /** Heading (yaw) of the road at the checkpoint: forward = (sin, 0, cos). */
  yaw: number;
  /** Sample index on the track. */
  sample: number;
}

const SAMPLE_SPACING = 2;
const GRID_CELL = 24;

/**
 * The closed road loop: evenly spaced samples, a spatial grid for fast nearest queries,
 * and the checkpoints (checkpoint 0 is the start/finish line).
 */
export class Track {
  readonly samples: TrackSample[] = [];
  readonly length: number;
  readonly checkpoints: Checkpoint[] = [];
  private readonly grid = new Map<number, number[]>();

  constructor(checkpointCount = 8) {
    const curve = new THREE.CatmullRomCurve3(
      CONTROL.map(([x, z]) => new THREE.Vector3(x, 0, z)),
      true,
      "centripetal",
    );
    const approx = curve.getLength();
    const n = Math.round(approx / SAMPLE_SPACING);
    const pts = curve.getSpacedPoints(n);
    pts.pop(); // closed curve repeats the first point
    let s = 0;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const next = pts[(i + 1) % pts.length];
      const prev = pts[(i - 1 + pts.length) % pts.length];
      let tx = next.x - prev.x;
      let tz = next.z - prev.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      if (i > 0) s += Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z);
      this.samples.push({ x: p.x, z: p.z, y: 0, tx, tz, s });
    }
    const last = this.samples[this.samples.length - 1];
    this.length = last.s + Math.hypot(this.samples[0].x - last.x, this.samples[0].z - last.z);

    this.samples.forEach((sm, i) => {
      const key = this.cellKey(sm.x, sm.z);
      let list = this.grid.get(key);
      if (!list) this.grid.set(key, (list = []));
      list.push(i);
    });

    for (let c = 0; c < checkpointCount; c++) {
      const sample = Math.round((c / checkpointCount) * this.samples.length) % this.samples.length;
      const sm = this.samples[sample];
      this.checkpoints.push({
        index: c,
        x: sm.x,
        z: sm.z,
        yaw: Math.atan2(sm.tx, sm.tz),
        sample,
      });
    }
  }

  private cellKey(x: number, z: number): number {
    const cx = Math.floor(x / GRID_CELL) + 512;
    const cz = Math.floor(z / GRID_CELL) + 512;
    return cx * 4096 + cz;
  }

  /**
   * Nearest point on the centre line. Searches the surrounding grid cells; falls back to a
   * full scan when the point is far from the road. Writes into `out` (no allocation).
   */
  nearest(x: number, z: number, out: NearestResult): NearestResult {
    let best = -1;
    let bestD2 = Infinity;
    const cx = Math.floor(x / GRID_CELL) + 512;
    const cz = Math.floor(z / GRID_CELL) + 512;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const list = this.grid.get((cx + dx) * 4096 + (cz + dz));
        if (!list) continue;
        for (const i of list) {
          const sm = this.samples[i];
          const d2 = (sm.x - x) ** 2 + (sm.z - z) ** 2;
          if (d2 < bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
    if (best < 0) {
      for (let i = 0; i < this.samples.length; i += 2) {
        const sm = this.samples[i];
        const d2 = (sm.x - x) ** 2 + (sm.z - z) ** 2;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = i;
        }
      }
    }
    // Refine against the segments either side of the closest sample.
    const n = this.samples.length;
    let bestDist = Math.sqrt(bestD2);
    let lateral = 0;
    for (const j of [best, (best - 1 + n) % n]) {
      const a = this.samples[j];
      const b = this.samples[(j + 1) % n];
      const abx = b.x - a.x;
      const abz = b.z - a.z;
      const len2 = abx * abx + abz * abz || 1;
      const t = Math.max(0, Math.min(1, ((x - a.x) * abx + (z - a.z) * abz) / len2));
      const px = a.x + abx * t;
      const pz = a.z + abz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d <= bestDist + 1e-6) {
        bestDist = d;
        // right of tangent (tx, tz) is (-tz, tx) in this yaw convention (forward = +Z, right = -X)
        lateral = (x - px) * -a.tz + (z - pz) * a.tx;
      }
    }
    out.index = best;
    out.distance = bestDist;
    out.lateral = lateral;
    return out;
  }

  /** Sample at a (wrapped) index. */
  at(index: number): TrackSample {
    const n = this.samples.length;
    return this.samples[((index % n) + n) % n];
  }
}
