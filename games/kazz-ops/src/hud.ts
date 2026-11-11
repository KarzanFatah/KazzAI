import type { GameContext } from "./types";

/**
 * DOM HUD: weapon + ammo, stamina bar, controls hint bar, crosshair, state tags, toasts,
 * hit markers, start overlay.
 * STUB: to be implemented (see SPEC.md).
 */
export class Hud {
  constructor(private readonly ctx: GameContext) {}

  update(dt: number): void {}

  showToast(text: string): void {}

  /** Hide the start overlay (first click / tap / key). */
  dismissIntro(): void {}
}
