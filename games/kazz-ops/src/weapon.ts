import { WEAPONS } from "./weapons-data";
import type { GameContext, WeaponDef } from "./types";

/**
 * Firing (hitscan with spread/bloom/recoil), ammo, reloads, weapon switching, tracers, casings,
 * applying bullet hits to props through World.
 * STUB: to be implemented (see SPEC.md).
 */
export class WeaponSystem {
  current: WeaponDef = WEAPONS[0];
  /** Rounds in the current magazine. */
  ammo = WEAPONS[0].magSize;
  /** Spare rounds for the current weapon. */
  reserve = WEAPONS[0].reserveMax;
  reloading = false;
  /** 0..1 progress of the current reload (per shell for the shotgun). */
  reloadProgress = 0;
  /** Current total spread half-angle in degrees (for the HUD crosshair). */
  spread = 0;
  /** Shots fired since the last call to consumeShotsFired() (Player feeds the model's recoil). */
  private shotsSinceRead = 0;

  constructor(private readonly ctx: GameContext) {}

  update(dt: number): void {}

  switchTo(slot: number): void {}

  consumeShotsFired(): number {
    const n = this.shotsSinceRead;
    this.shotsSinceRead = 0;
    return n;
  }

  /** Refill everything and select slot 1. */
  reset(): void {}
}
