import type { Car } from "./car";
import type { Track, NearestResult } from "./track";

export type RaceState = "intro" | "countdown" | "racing" | "finished";

export interface RaceEvents {
  onCountdown?(n: number): void; // 3, 2, 1, 0 = GO
  onCheckpoint?(index: number, time: number): void;
  onLap?(lap: number, lapTime: number, best: boolean): void;
  onFinish?(total: number, bestLap: number): void;
}

const CHECKPOINT_RADIUS = 15;
const BEST_KEY = "dustline.bestLap.v1";

/** Countdown, checkpoints in order, laps, lap timing, best lap and wrong-way detection. */
export class Race {
  state: RaceState = "intro";
  readonly laps = 3;
  lap = 1;
  nextCheckpoint = 1;
  /** Index of the last checkpoint passed (where "back to track" prefers to put you). */
  lastCheckpoint = 0;
  raceTime = 0;
  lapTime = 0;
  readonly lapTimes: number[] = [];
  bestLap = loadBest();
  countdown = 0;
  wrongWay = false;
  private wrongTimer = 0;
  private lastCount = 4;
  private readonly near: NearestResult = { index: 0, distance: 0, lateral: 0 };

  constructor(
    private readonly track: Track,
    private readonly events: RaceEvents = {},
  ) {}

  get checkpointCount(): number {
    return this.track.checkpoints.length;
  }

  startCountdown(): void {
    this.state = "countdown";
    this.countdown = 3.2;
    this.lastCount = 4;
    this.lap = 1;
    this.nextCheckpoint = 1;
    this.lastCheckpoint = 0;
    this.raceTime = 0;
    this.lapTime = 0;
    this.lapTimes.length = 0;
    this.wrongWay = false;
  }

  update(dt: number, car: Car): void {
    if (this.state === "countdown") {
      this.countdown -= dt;
      const n = Math.max(0, Math.ceil(this.countdown - 0.2));
      if (n < this.lastCount) {
        this.lastCount = n;
        this.events.onCountdown?.(n);
      }
      if (this.countdown <= 0.2) this.state = "racing";
      return;
    }
    if (this.state !== "racing") return;

    this.raceTime += dt;
    this.lapTime += dt;

    const cp = this.track.checkpoints[this.nextCheckpoint];
    const dx = car.position.x - cp.x;
    const dz = car.position.z - cp.z;
    if (dx * dx + dz * dz < CHECKPOINT_RADIUS * CHECKPOINT_RADIUS) {
      this.lastCheckpoint = this.nextCheckpoint;
      if (this.nextCheckpoint === 0) {
        this.completeLap();
      } else {
        this.events.onCheckpoint?.(this.nextCheckpoint, this.lapTime);
        this.nextCheckpoint = (this.nextCheckpoint + 1) % this.checkpointCount;
      }
    }

    // Wrong way: driving against the track direction for a moment.
    this.track.nearest(car.position.x, car.position.z, this.near);
    const s = this.track.at(this.near.index);
    const speed = car.speed;
    const dot = speed > 6 ? (car.velocity.x * s.tx + car.velocity.z * s.tz) / speed : 0;
    this.wrongTimer = dot < -0.5 ? this.wrongTimer + dt : Math.max(0, this.wrongTimer - dt * 2);
    this.wrongWay = this.wrongTimer > 1.2;
  }

  private completeLap(): void {
    const t = this.lapTime;
    this.lapTimes.push(t);
    const isBest = this.bestLap === 0 || t < this.bestLap;
    if (isBest) {
      this.bestLap = t;
      saveBest(t);
    }
    if (this.lap >= this.laps) {
      this.state = "finished";
      this.events.onFinish?.(this.raceTime, Math.min(...this.lapTimes));
      return;
    }
    this.events.onLap?.(this.lap, t, isBest);
    this.lap++;
    this.lapTime = 0;
    this.nextCheckpoint = 1;
  }
}

function loadBest(): number {
  try {
    const v = Number(localStorage.getItem(BEST_KEY));
    return Number.isFinite(v) && v > 0 ? v : 0;
  } catch {
    return 0;
  }
}

function saveBest(t: number): void {
  try {
    localStorage.setItem(BEST_KEY, String(t));
  } catch {
    // storage unavailable: best lap just isn't remembered
  }
}

export function formatTime(t: number): string {
  if (!t) return "—";
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, "0")}`;
}
