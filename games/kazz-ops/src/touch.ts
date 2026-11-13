import * as THREE from "three";
import type { ActionName } from "./input";
import type { GameContext } from "./types";

const BASE_SIZE = 124;
const KNOB_SIZE = 52;
/** How far the knob travels from the base centre (px). */
const KNOB_TRAVEL = 50;
const DEADZONE = 0.12;
const RUN_ON = 0.85;
const RUN_OFF = 0.78;
const FIRE_ON = 0.6;
const FIRE_OFF = 0.5;
const EDGE_MARGIN = 6;

const ICONS = {
  reload:
    '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.5H15"/>',
  crouch:
    '<path d="M12 4v10"/><path d="M7.5 9.5 12 14l4.5-4.5"/><path d="M5 19.5h14"/>',
  vault:
    '<path d="M8 20v-4.5h8V20"/><path d="M4.5 13C6 6.5 18 6.5 19.5 13"/><path d="m19.5 13-3.3-1M19.5 13l.9-3.3"/>',
  sprint: '<path d="m6 12.5 6-6 6 6"/><path d="m6 18.5 6-6 6 6"/>',
  aim: '<circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v5M12 16.5v5M2.5 12h5M16.5 12h5"/>',
  swap: '<path d="M4.5 8.5h14l-3.5-3.5"/><path d="M19.5 15.5h-14l3.5 3.5"/>',
  camera:
    '<rect x="3.5" y="7.5" width="17" height="11.5" rx="2"/><circle cx="12" cy="13.2" r="3"/><path d="m8.5 7.5 1.5-2.5h4l1.5 2.5"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4.5H9"/>',
  gear: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="6.5"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>',
} as const;

type ButtonId =
  | "vault"
  | "crouch"
  | "sprint"
  | "reload"
  | "aim"
  | "swap"
  | "camera"
  | "reset"
  | "tune";

interface ButtonDef {
  id: ButtonId;
  label: string;
  icon: keyof typeof ICONS;
  /** Omitted for the AIM toggle, which holds aim instead of firing an edge. */
  action?: ActionName;
}

const ACTION_BUTTONS: readonly ButtonDef[] = [
  { id: "vault", label: "VAULT", icon: "vault", action: "vault" },
  { id: "crouch", label: "CROUCH", icon: "crouch", action: "crouch" },
  { id: "sprint", label: "SPRINT", icon: "sprint", action: "tactical" },
  { id: "reload", label: "RELOAD", icon: "reload", action: "reload" },
  { id: "aim", label: "AIM", icon: "aim" },
  { id: "swap", label: "SWAP", icon: "swap", action: "nextWeapon" },
];

const UTILITY_BUTTONS: readonly ButtonDef[] = [
  { id: "camera", label: "CAM", icon: "camera", action: "camera" },
  { id: "reset", label: "RESET", icon: "reset", action: "reset" },
  { id: "tune", label: "TUNE", icon: "gear", action: "tune" },
];

/** True on phones/tablets (coarse primary pointer) or when forced with `?touch=1`. */
export function prefersTouch(): boolean {
  return forcedTouch() || window.matchMedia("(pointer: coarse)").matches;
}

function forcedTouch(): boolean {
  return new URLSearchParams(window.location.search).get("touch") === "1";
}

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const node = document.createElement("div");
  node.className = className;
  parent.appendChild(node);
  return node;
}

/**
 * Floating virtual stick: the base appears where the thumb lands inside its zone and trails the
 * thumb when dragged past the rim. `value` is screen space (x right, y up) after the deadzone.
 */
class Stick {
  readonly value = new THREE.Vector2();
  magnitude = 0;
  private readonly zone: HTMLDivElement;
  private readonly base: HTMLDivElement;
  private readonly knob: HTMLDivElement;
  private pointerId: number | null = null;
  private originX = 0;
  private originY = 0;

  constructor(
    layer: HTMLElement,
    side: "left" | "right",
    private readonly onChange: (stick: Stick) => void,
  ) {
    this.zone = div(`touch-zone touch-zone--${side}`, layer);
    this.base = div(`stick stick--${side}`, layer);
    this.knob = div("stick-knob", this.base);
    sizeStick(this.base, this.knob);
    this.zone.addEventListener("pointerdown", this.onDown);
    this.zone.addEventListener("pointermove", this.onMove);
    this.zone.addEventListener("pointerup", this.onUp);
    this.zone.addEventListener("pointercancel", this.onUp);
    this.zone.addEventListener("lostpointercapture", this.onUp);
  }

  get active(): boolean {
    return this.pointerId !== null;
  }

  release(): void {
    if (this.pointerId === null) return;
    this.pointerId = null;
    this.value.set(0, 0);
    this.magnitude = 0;
    this.base.classList.remove("is-active");
    this.onChange(this);
  }

  private readonly onDown = (e: PointerEvent): void => {
    if (this.pointerId !== null) return;
    e.preventDefault();
    this.pointerId = e.pointerId;
    this.zone.setPointerCapture(e.pointerId);
    const r = BASE_SIZE / 2 + EDGE_MARGIN;
    this.originX = THREE.MathUtils.clamp(e.clientX, r, window.innerWidth - r);
    this.originY = THREE.MathUtils.clamp(e.clientY, r, window.innerHeight - r);
    this.base.classList.add("is-active");
    this.track(e.clientX, e.clientY);
  };

  private readonly onMove = (e: PointerEvent): void => {
    if (e.pointerId === this.pointerId) this.track(e.clientX, e.clientY);
  };

  private readonly onUp = (e: PointerEvent): void => {
    if (e.pointerId === this.pointerId) this.release();
  };

  private track(x: number, y: number): void {
    let dx = x - this.originX;
    let dy = y - this.originY;
    let len = Math.hypot(dx, dy);
    if (len > KNOB_TRAVEL) {
      // Drag the base along so the stick never "runs out" under the thumb.
      const excess = len - KNOB_TRAVEL;
      this.originX += (dx / len) * excess;
      this.originY += (dy / len) * excess;
      dx = x - this.originX;
      dy = y - this.originY;
      len = KNOB_TRAVEL;
    }
    const raw = len / KNOB_TRAVEL;
    this.magnitude = raw < DEADZONE ? 0 : (raw - DEADZONE) / (1 - DEADZONE);
    if (this.magnitude > 0) {
      this.value.set((dx / len) * this.magnitude, (-dy / len) * this.magnitude);
    } else {
      this.value.set(0, 0);
    }
    const half = BASE_SIZE / 2;
    this.base.style.transform = `translate3d(${this.originX - half}px, ${this.originY - half}px, 0)`;
    this.knob.style.transform = `translate3d(${dx}px, ${dy}px, 0)`;
    this.onChange(this);
  }
}

function sizeStick(base: HTMLElement, knob: HTMLElement): void {
  base.style.width = base.style.height = `${BASE_SIZE}px`;
  knob.style.width = knob.style.height = `${KNOB_SIZE}px`;
  knob.style.left = knob.style.top = `${(BASE_SIZE - KNOB_SIZE) / 2}px`;
}

/**
 * On-screen twin-stick controls + action buttons for phones/tablets. Feeds ctx.input.
 * Left stick moves (past 85 % runs), right stick aims and fires past 60 %.
 */
export class TouchControls {
  enabled = false;

  private root: HTMLDivElement | null = null;
  private moveStick: Stick | null = null;
  private aimStick: Stick | null = null;
  private readonly buttons = new Map<ButtonId, HTMLButtonElement>();
  private aimToggled = false;
  private running = false;
  private firing = false;
  private shown = false;
  private dead = false;
  private readonly forced = forcedTouch();

  constructor(private readonly ctx: GameContext) {
    if (prefersTouch()) {
      this.enable();
    } else {
      window.addEventListener("pointerdown", this.onFirstTouch, true);
      window.addEventListener("touchstart", this.onFirstTouch, true);
    }
  }

  /** Build the controls (idempotent). Called on coarse pointers, ?touch=1 or the first touch. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.removeFirstTouchListeners();

    const root = div("touch", this.ctx.uiRoot);
    this.root = root;
    this.moveStick = new Stick(root, "left", this.onMoveStick);
    this.aimStick = new Stick(root, "right", this.onAimStick);
    // Idle hints where the sticks usually are; created after the sticks so CSS can hide them
    // with `.stick.is-active ~ .stick-ghost`.
    for (const side of ["left", "right"] as const) {
      const ghost = div(`stick-ghost stick-ghost--${side}`, root);
      sizeStick(ghost, div("stick-knob", ghost));
      div("stick-caption", ghost).textContent =
        side === "left" ? "MOVE" : "AIM · FIRE";
    }
    this.buildButtons(div("touch-actions", root), ACTION_BUTTONS);
    this.buildButtons(div("touch-utils", root), UTILITY_BUTTONS);

    root.addEventListener("contextmenu", preventDefault);
    document.addEventListener("gesturestart", preventDefault);
    window.addEventListener("blur", this.releaseAll);
  }

  update(dt: number): void {
    if (!this.root) return;
    const { input, player } = this.ctx;
    // Hide the controls again on hybrid devices once the mouse takes over.
    const shown = this.forced || input.usingTouch || !input.pointerActive;
    if (shown !== this.shown) {
      this.shown = shown;
      this.root.classList.toggle("is-hidden", !shown);
      this.ctx.uiRoot.classList.toggle("touch-on", shown);
      if (!shown) this.releaseAll();
    }
    if (!shown) return;
    // Dead: only the utility row stays (RESET restarts; the GAME OVER panel has TRY AGAIN).
    if (player.dead !== this.dead) {
      this.dead = player.dead;
      this.root.classList.toggle("is-dead", this.dead);
      if (this.dead) this.releaseAll();
    }
    this.setOn("crouch", player.crouched || player.state === "slide");
    this.setOn("sprint", player.state === "tactical");
    this.setOn("aim", this.aimToggled);
  }

  dispose(): void {
    this.removeFirstTouchListeners();
    this.releaseAll();
    document.removeEventListener("gesturestart", preventDefault);
    window.removeEventListener("blur", this.releaseAll);
    this.ctx.uiRoot.classList.remove("touch-on");
    this.root?.remove();
    this.root = null;
  }

  private buildButtons(parent: HTMLElement, defs: readonly ButtonDef[]): void {
    for (const def of defs) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `touch-btn touch-btn--${def.id}`;
      button.setAttribute("aria-label", def.label);
      button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[def.icon]}</svg><span>${def.label}</span>`;
      button.addEventListener("pointerdown", (e) => this.onButtonDown(e, def));
      button.addEventListener("pointerup", onButtonUp);
      button.addEventListener("pointercancel", onButtonUp);
      button.addEventListener("lostpointercapture", onButtonUp);
      parent.appendChild(button);
      this.buttons.set(def.id, button);
    }
  }

  private onButtonDown(e: PointerEvent, def: ButtonDef): void {
    e.preventDefault();
    e.stopPropagation();
    const button = e.currentTarget as HTMLButtonElement;
    button.setPointerCapture(e.pointerId);
    button.classList.add("is-down");
    navigator.vibrate?.(8);
    if (def.action) {
      this.ctx.input.trigger(def.action);
    } else {
      this.aimToggled = !this.aimToggled;
      this.ctx.input.setHeld("aim", this.aimToggled);
    }
  }

  private setOn(id: ButtonId, on: boolean): void {
    this.buttons.get(id)?.classList.toggle("is-on", on);
  }

  private readonly onMoveStick = (stick: Stick): void => {
    const { input } = this.ctx;
    input.setVirtualMove(stick.value.x, stick.value.y);
    const run = stick.magnitude > (this.running ? RUN_OFF : RUN_ON);
    if (run !== this.running) {
      this.running = run;
      input.setHeld("run", run);
    }
  };

  private readonly onAimStick = (stick: Stick): void => {
    const { input } = this.ctx;
    input.setVirtualAim(stick.magnitude > 0 ? stick.value : null);
    const fire = stick.magnitude > (this.firing ? FIRE_OFF : FIRE_ON);
    if (fire !== this.firing) {
      this.firing = fire;
      input.setHeld("fire", fire);
    }
  };

  private readonly releaseAll = (): void => {
    this.moveStick?.release();
    this.aimStick?.release();
  };

  private readonly onFirstTouch = (e: Event): void => {
    if (e instanceof PointerEvent && e.pointerType !== "touch") return;
    this.enable();
  };

  private removeFirstTouchListeners(): void {
    window.removeEventListener("pointerdown", this.onFirstTouch, true);
    window.removeEventListener("touchstart", this.onFirstTouch, true);
  }
}

function preventDefault(e: Event): void {
  e.preventDefault();
}

function onButtonUp(e: PointerEvent): void {
  (e.currentTarget as HTMLElement).classList.remove("is-down");
}
