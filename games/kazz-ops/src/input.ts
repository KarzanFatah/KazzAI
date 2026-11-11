import * as THREE from "three";

/** Actions a touch button (or any virtual source) can trigger. */
export type ActionName =
  | "tactical"
  | "vault"
  | "crouch"
  | "reload"
  | "reset"
  | "camera"
  | "tune"
  | "weapon1"
  | "weapon2"
  | "weapon3"
  | "nextWeapon";

export type HeldAction = "fire" | "aim" | "run";

/**
 * Keyboard + mouse state, merged with virtual (touch) input. Read the public fields during the
 * frame; edge flags (`*Pressed`) are true for exactly one frame and cleared by endFrame().
 *
 * Bindings: WASD/arrows move, Shift run (hold), double-tap Shift tactical sprint, Space vault,
 * Ctrl or C slide/crouch, RMB aim, LMB fire, R reload, F9 reset, Tab camera, F1 tune, 1/2/3 or
 * mouse wheel switch weapon.
 *
 * STUB: to be implemented (see SPEC.md).
 */
export class Input {
  /** Move intent in screen space: x = right, y = up/forward (W). Length <= 1. */
  readonly move = new THREE.Vector2();
  /** Pointer in normalised device coords (-1..1, y up). */
  readonly pointerNdc = new THREE.Vector2();
  /** Pointer in CSS pixels relative to the viewport. */
  readonly pointerClient = new THREE.Vector2();
  /** True once the mouse has moved over the canvas (until then aim straight ahead). */
  pointerActive = false;
  /** Touch aim stick direction in screen space (x right, y up), length 0..1; null when unused. */
  aimStick: THREE.Vector2 | null = null;
  /** True when the last input came from touch. */
  usingTouch = false;

  fireHeld = false;
  aimHeld = false;
  runHeld = false;

  firePressed = false;
  tacticalPressed = false;
  vaultPressed = false;
  crouchPressed = false;
  reloadPressed = false;
  resetPressed = false;
  cameraPressed = false;
  tunePressed = false;
  /** 1..3 when a weapon slot key was pressed this frame. */
  weaponSlotPressed: number | null = null;
  /** +1 / -1 when the wheel (or a touch button) asks for the next/previous weapon. */
  weaponCycle = 0;

  constructor(readonly target: HTMLElement) {}

  /** Touch: set the virtual move stick (screen space, length 0..1). */
  setVirtualMove(x: number, y: number): void {}
  /** Touch: set the virtual aim stick, or null when released. */
  setVirtualAim(dir: THREE.Vector2 | null): void {}
  /** Touch: hold/release fire, aim or run. */
  setHeld(action: HeldAction, held: boolean): void {}
  /** Touch: fire a one-frame action edge. */
  trigger(action: ActionName): void {}

  /** Merge keyboard/mouse and virtual sources into the public fields. Call once per frame first. */
  update(dt: number): void {}
  /** Clear one-frame edges. Call once per frame last. */
  endFrame(): void {}
  dispose(): void {}
}
