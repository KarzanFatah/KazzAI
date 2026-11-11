import type { DriveInput } from "./car";

/**
 * Keyboard + touch merged into one DriveInput, plus one-frame UI edges.
 * Keys: W/↑ gas, S/↓ brake & reverse, A/D or ←/→ steer, Space handbrake, Shift boost, E jump,
 * R back to track, C camera, M mute, Enter start/restart.
 */
export class Input {
  readonly drive: DriveInput = {
    throttle: 0,
    brake: 0,
    steer: 0,
    handbrake: false,
    boost: false,
    jump: false,
  };
  resetPressed = false;
  cameraPressed = false;
  mutePressed = false;
  startPressed = false;
  usingTouch = false;

  /** Written by the touch controls. */
  readonly touch = { throttle: 0, brake: 0, steer: 0, handbrake: false, boost: false };

  private readonly keys = new Set<string>();
  private edges = new Set<string>();

  constructor() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", () => this.keys.clear());
  }

  /** One-frame action from a touch button. */
  trigger(action: "jump" | "reset" | "camera" | "mute" | "start"): void {
    this.edges.add(action);
  }

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    const gameKey =
      /^(Key[WASDERCMJ]|Arrow\w+|Space|Shift\w+|Enter)$/.test(e.code) && !e.metaKey && !e.ctrlKey;
    if (!gameKey) return;
    e.preventDefault();
    this.usingTouch = false;
    if (!e.repeat) {
      if (e.code === "KeyE" || e.code === "KeyJ") this.edges.add("jump");
      if (e.code === "KeyR") this.edges.add("reset");
      if (e.code === "KeyC") this.edges.add("camera");
      if (e.code === "KeyM") this.edges.add("mute");
      if (e.code === "Enter" || e.code === "Space") this.edges.add("start");
    }
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  update(): void {
    const k = this.keys;
    const t = this.touch;
    const kThrottle = k.has("KeyW") || k.has("ArrowUp") ? 1 : 0;
    const kBrake = k.has("KeyS") || k.has("ArrowDown") ? 1 : 0;
    const kSteer =
      (k.has("KeyD") || k.has("ArrowRight") ? 1 : 0) - (k.has("KeyA") || k.has("ArrowLeft") ? 1 : 0);
    const d = this.drive;
    d.throttle = Math.max(kThrottle, t.throttle);
    d.brake = Math.max(kBrake, t.brake);
    d.steer = Math.abs(t.steer) > Math.abs(kSteer) ? t.steer : kSteer;
    d.handbrake = k.has("Space") || t.handbrake;
    d.boost = k.has("ShiftLeft") || k.has("ShiftRight") || t.boost;
    d.jump = this.edges.has("jump");
    this.resetPressed = this.edges.has("reset");
    this.cameraPressed = this.edges.has("camera");
    this.mutePressed = this.edges.has("mute");
    this.startPressed = this.edges.has("start");
    this.edges.clear();
  }
}
