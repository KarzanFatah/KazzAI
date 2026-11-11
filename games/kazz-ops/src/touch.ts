import type { GameContext } from "./types";

/**
 * On-screen twin-stick controls + action buttons for phones/tablets. Feeds ctx.input.
 * STUB: to be implemented (see SPEC.md).
 */
export class TouchControls {
  enabled = false;

  constructor(private readonly ctx: GameContext) {}

  update(dt: number): void {}
}
