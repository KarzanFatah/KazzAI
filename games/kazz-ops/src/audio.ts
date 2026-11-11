import type { GameContext } from "./types";

/**
 * Procedural WebAudio sound (no asset files). Subscribes to game events in the constructor.
 * STUB: to be implemented (see SPEC.md).
 */
export class AudioSystem {
  constructor(private readonly ctx: GameContext) {}

  /** Create/resume the AudioContext. Called on the first user gesture. */
  unlock(): void {}

  /** Per-frame: master volume from tuning, listener position. */
  update(dt: number): void {}
}
