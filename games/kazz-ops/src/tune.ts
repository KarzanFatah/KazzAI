import type { GameContext } from "./types";

/**
 * F1 tune panel: sliders for every TUNE_PARAMS entry, live edits, save, reset to defaults.
 * STUB: to be implemented (see SPEC.md).
 */
export class TunePanel {
  visible = false;

  constructor(private readonly ctx: GameContext) {}

  toggle(): void {
    this.visible = !this.visible;
  }
}
