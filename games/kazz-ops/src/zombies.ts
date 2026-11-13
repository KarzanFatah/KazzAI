import * as THREE from "three";
import type { GameContext } from "./types";

export type ZombieKind = "walker" | "runner" | "brute";

export interface ZombieHit {
  index: number;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  headshot: boolean;
}

export type WavePhase = "intermission" | "active";

/**
 * Waves of zombies: instanced low-poly bodies with procedural animation, steering toward the
 * player around cover, attacks, deaths/corpses, explosions, ammo/health pickups.
 * STUB: to be implemented (see ZOMBIES.md).
 */
export class ZombieHorde {
  /** Current wave number (0 before the first wave starts). */
  wave = 0;
  phase: WavePhase = "intermission";
  /** Seconds left in the break before the next wave. */
  intermissionLeft = 0;
  /** Zombies alive right now. */
  alive = 0;
  /** Zombies of this wave not yet killed (alive + still to spawn). */
  remaining = 0;

  constructor(private readonly ctx: GameContext) {}

  /** Begin the countdown to wave 1 (called once the player dismisses the intro). */
  start(): void {}

  /** Closest living zombie along a ray (dir normalised) within maxDist; writes into out. */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, out: ZombieHit): ZombieHit | null {
    return null;
  }

  /** Apply bullet damage. dir = bullet direction, point = hit point. */
  damage(index: number, amount: number, dir: THREE.Vector3, point: THREE.Vector3, headshot: boolean): void {}

  update(dt: number): void {}

  /** Back to wave 0 with an empty arena (F9 / restart). */
  reset(): void {}
}
