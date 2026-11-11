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

const DOUBLE_TAP_MS = 300;
const WHEEL_COOLDOWN_MS = 140;

/** Screen-space direction per movement key (x right, y up). */
const MOVE_KEYS: Readonly<Record<string, readonly [number, number]>> = {
  KeyW: [0, 1],
  ArrowUp: [0, 1],
  KeyS: [0, -1],
  ArrowDown: [0, -1],
  KeyA: [-1, 0],
  ArrowLeft: [-1, 0],
  KeyD: [1, 0],
  ArrowRight: [1, 0],
};

const RUN_KEYS = new Set(["ShiftLeft", "ShiftRight"]);

/** One-frame actions per key (Ctrl+W closes the tab in most browsers, so C is the safe crouch key). */
const EDGE_KEYS: Readonly<Record<string, ActionName>> = {
  Space: "vault",
  ControlLeft: "crouch",
  ControlRight: "crouch",
  KeyC: "crouch",
  KeyR: "reload",
  F9: "reset",
  Tab: "camera",
  F1: "tune",
  Digit1: "weapon1",
  Digit2: "weapon2",
  Digit3: "weapon3",
  Numpad1: "weapon1",
  Numpad2: "weapon2",
  Numpad3: "weapon3",
};

/** Keys that keep working while a tune-panel slider has focus. */
const FORM_SAFE_KEYS = new Set(["F1"]);

const ACTIONS: readonly ActionName[] = [
  "tactical",
  "vault",
  "crouch",
  "reload",
  "reset",
  "camera",
  "tune",
  "weapon1",
  "weapon2",
  "weapon3",
  "nextWeapon",
];
const BIT = Object.fromEntries(ACTIONS.map((a, i) => [a, 1 << i])) as Record<
  ActionName,
  number
>;
const FIRE_BIT = 1 << ACTIONS.length;

const MOUSE_LEFT = 1;
const MOUSE_RIGHT = 2;

function isFormTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function isGameKey(code: string): boolean {
  return code in MOVE_KEYS || code in EDGE_KEYS || RUN_KEYS.has(code);
}

/**
 * Keyboard + mouse state, merged with virtual (touch) input. Read the public fields during the
 * frame; edge flags (`*Pressed`) are true for exactly one frame and cleared by endFrame().
 *
 * Bindings: WASD/arrows move, Shift run (hold), double-tap Shift tactical sprint, Space vault,
 * Ctrl or C slide/crouch, RMB aim, LMB fire, R reload, F9 reset, Tab camera, F1 tune, 1/2/3 or
 * mouse wheel switch weapon.
 *
 * Events only queue edges; update() publishes them, so an edge that arrives between frames is
 * never lost.
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

  private readonly heldKeys = new Set<string>();
  private mouseButtons = 0;
  private pendingEdges = 0;
  private pendingCycle = 0;
  private lastShiftDown = -Infinity;
  private lastWheel = -Infinity;

  private readonly keyMove = new THREE.Vector2();
  private readonly virtualMove = new THREE.Vector2();
  private readonly virtualAim = new THREE.Vector2();
  private virtualAimActive = false;
  private readonly virtualHeld: Record<HeldAction, boolean> = {
    fire: false,
    aim: false,
    run: false,
  };

  private rect: DOMRect | null = null;

  constructor(readonly target: HTMLElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    document.addEventListener("visibilitychange", this.onVisibility);
    window.addEventListener("pointermove", this.onWindowPointerMove, true);
    window.addEventListener("pointerdown", this.onWindowPointerDown, true);
    target.addEventListener("pointerdown", this.onCanvasPointerDown);
    target.addEventListener("pointermove", this.onCanvasPointerMove);
    target.addEventListener("pointerup", this.onCanvasPointerUp);
    target.addEventListener("pointercancel", this.onCanvasPointerCancel);
    target.addEventListener("lostpointercapture", this.onCanvasPointerCancel);
    target.addEventListener("wheel", this.onWheel, { passive: true });
    target.addEventListener("contextmenu", this.onContextMenu);
  }

  /** Touch: set the virtual move stick (screen space, length 0..1). */
  setVirtualMove(x: number, y: number): void {
    this.virtualMove.set(x, y);
    if (this.virtualMove.lengthSq() > 1) this.virtualMove.normalize();
  }

  /** Touch: set the virtual aim stick, or null when released. */
  setVirtualAim(dir: THREE.Vector2 | null): void {
    this.virtualAimActive = dir !== null;
    if (dir) this.virtualAim.copy(dir);
  }

  /** Touch: hold/release fire, aim or run. */
  setHeld(action: HeldAction, held: boolean): void {
    if (action === "fire" && held && !this.virtualHeld.fire) {
      this.pendingEdges |= FIRE_BIT;
    }
    this.virtualHeld[action] = held;
  }

  /** Touch: fire a one-frame action edge. */
  trigger(action: ActionName): void {
    this.queue(action);
  }

  /** Merge keyboard/mouse and virtual sources into the public fields. Call once per frame first. */
  update(dt: number): void {
    this.updateMove();

    this.fireHeld =
      (this.mouseButtons & MOUSE_LEFT) !== 0 || this.virtualHeld.fire;
    this.aimHeld =
      (this.mouseButtons & MOUSE_RIGHT) !== 0 || this.virtualHeld.aim;
    this.runHeld =
      this.heldKeys.has("ShiftLeft") ||
      this.heldKeys.has("ShiftRight") ||
      this.virtualHeld.run;
    this.aimStick = this.virtualAimActive ? this.virtualAim : null;

    const edges = this.pendingEdges;
    this.pendingEdges = 0;
    this.firePressed ||= (edges & FIRE_BIT) !== 0;
    this.tacticalPressed ||= (edges & BIT.tactical) !== 0;
    this.vaultPressed ||= (edges & BIT.vault) !== 0;
    this.crouchPressed ||= (edges & BIT.crouch) !== 0;
    this.reloadPressed ||= (edges & BIT.reload) !== 0;
    this.resetPressed ||= (edges & BIT.reset) !== 0;
    this.cameraPressed ||= (edges & BIT.camera) !== 0;
    this.tunePressed ||= (edges & BIT.tune) !== 0;
    if (edges & BIT.weapon1) this.weaponSlotPressed = 1;
    if (edges & BIT.weapon2) this.weaponSlotPressed = 2;
    if (edges & BIT.weapon3) this.weaponSlotPressed = 3;
    if (edges & BIT.nextWeapon) this.pendingCycle += 1;
    if (this.pendingCycle !== 0) {
      this.weaponCycle = Math.sign(this.pendingCycle);
      this.pendingCycle = 0;
    }
  }

  /** Clear one-frame edges. Call once per frame last. */
  endFrame(): void {
    this.firePressed = false;
    this.tacticalPressed = false;
    this.vaultPressed = false;
    this.crouchPressed = false;
    this.reloadPressed = false;
    this.resetPressed = false;
    this.cameraPressed = false;
    this.tunePressed = false;
    this.weaponSlotPressed = null;
    this.weaponCycle = 0;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    document.removeEventListener("visibilitychange", this.onVisibility);
    window.removeEventListener("pointermove", this.onWindowPointerMove, true);
    window.removeEventListener("pointerdown", this.onWindowPointerDown, true);
    const t = this.target;
    t.removeEventListener("pointerdown", this.onCanvasPointerDown);
    t.removeEventListener("pointermove", this.onCanvasPointerMove);
    t.removeEventListener("pointerup", this.onCanvasPointerUp);
    t.removeEventListener("pointercancel", this.onCanvasPointerCancel);
    t.removeEventListener("lostpointercapture", this.onCanvasPointerCancel);
    t.removeEventListener("wheel", this.onWheel);
    t.removeEventListener("contextmenu", this.onContextMenu);
  }

  private queue(action: ActionName): void {
    this.pendingEdges |= BIT[action];
  }

  /** Rebuilt on key changes only (opposite keys cancel, diagonals are normalised). */
  private updateKeyMove(): void {
    let x = 0;
    let y = 0;
    for (const code of this.heldKeys) {
      const dir = MOVE_KEYS[code];
      if (!dir) continue;
      x += dir[0];
      y += dir[1];
    }
    this.keyMove.set(Math.sign(x), Math.sign(y));
    if (this.keyMove.lengthSq() > 1) this.keyMove.normalize();
  }

  /** Keyboard and virtual stick merged: whichever is pushed further wins. */
  private updateMove(): void {
    const source =
      this.virtualMove.lengthSq() > this.keyMove.lengthSq()
        ? this.virtualMove
        : this.keyMove;
    this.move.copy(source);
  }

  private releaseAll(): void {
    this.heldKeys.clear();
    this.keyMove.set(0, 0);
    this.mouseButtons = 0;
    this.virtualMove.set(0, 0);
    this.virtualAimActive = false;
    this.virtualHeld.fire = false;
    this.virtualHeld.aim = false;
    this.virtualHeld.run = false;
    this.lastShiftDown = -Infinity;
  }

  private setPointer(e: PointerEvent): void {
    this.rect ??= this.target.getBoundingClientRect();
    const r = this.rect;
    this.pointerClient.set(e.clientX, e.clientY);
    this.pointerNdc.set(
      ((e.clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
      -((e.clientY - r.top) / Math.max(1, r.height)) * 2 + 1,
    );
  }

  /** Mouse buttons are tracked from the `buttons` bitmask so chorded LMB+RMB presses work. */
  private applyButtons(buttons: number): void {
    const next = buttons & (MOUSE_LEFT | MOUSE_RIGHT);
    if (next & MOUSE_LEFT && !(this.mouseButtons & MOUSE_LEFT)) {
      this.pendingEdges |= FIRE_BIT;
    }
    this.mouseButtons = next;
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const code = e.code;
    if (isFormTarget(e.target) && !FORM_SAFE_KEYS.has(code)) return;
    if ((isGameKey(code) || e.ctrlKey) && !e.metaKey) e.preventDefault();
    if (e.repeat) return;

    this.heldKeys.add(code);
    if (code in MOVE_KEYS) this.updateKeyMove();
    if (RUN_KEYS.has(code)) {
      if (e.timeStamp - this.lastShiftDown <= DOUBLE_TAP_MS) {
        this.queue("tactical");
        this.lastShiftDown = -Infinity;
      } else {
        this.lastShiftDown = e.timeStamp;
      }
    }
    const action = EDGE_KEYS[code];
    if (action) this.queue(action);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.heldKeys.delete(e.code) && e.code in MOVE_KEYS)
      this.updateKeyMove();
  };

  private readonly onBlur = (): void => {
    this.releaseAll();
  };

  private readonly onVisibility = (): void => {
    if (document.hidden) this.releaseAll();
  };

  private readonly onResize = (): void => {
    this.rect = null;
  };

  private readonly onWindowPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") this.usingTouch = true;
  };

  /** Tracked on window so the crosshair keeps following the mouse over UI elements. */
  private readonly onWindowPointerMove = (e: PointerEvent): void => {
    if (e.pointerType === "touch") {
      this.usingTouch = true;
      return;
    }
    if (e.movementX !== 0 || e.movementY !== 0) {
      this.usingTouch = false;
      this.pointerActive = true;
    }
    this.setPointer(e);
  };

  private readonly onCanvasPointerDown = (e: PointerEvent): void => {
    if (e.pointerType === "touch") return;
    this.rect = null;
    this.setPointer(e);
    this.pointerActive = true;
    this.usingTouch = false;
    this.target.setPointerCapture(e.pointerId);
    this.applyButtons(e.buttons);
  };

  /** A second mouse button pressed while another is held arrives as a pointermove. */
  private readonly onCanvasPointerMove = (e: PointerEvent): void => {
    if (e.pointerType !== "touch" && e.button !== -1)
      this.applyButtons(e.buttons);
  };

  private readonly onCanvasPointerUp = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") this.applyButtons(e.buttons);
  };

  private readonly onCanvasPointerCancel = (e: PointerEvent): void => {
    if (e.pointerType !== "touch") this.mouseButtons = 0;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaY) < 1) return;
    if (e.timeStamp - this.lastWheel < WHEEL_COOLDOWN_MS) return;
    this.lastWheel = e.timeStamp;
    this.pendingCycle = Math.sign(e.deltaY);
  };

  private readonly onContextMenu = (e: Event): void => {
    e.preventDefault();
  };
}
