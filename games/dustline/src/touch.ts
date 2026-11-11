import type { Input } from "./input";

const SWIPE = 42; // px of vertical drag that counts as a swipe

/** Should touch controls show? Coarse pointer, ?touch=1, or the first real touch. */
export function prefersTouch(): boolean {
  return (
    matchMedia("(pointer: coarse)").matches || new URLSearchParams(location.search).has("touch")
  );
}

/**
 * On-screen controls for phones:
 *  - left: steering slider (drag sideways), swipe up = jump, drag down = boost;
 *  - right: BRAKE (drag down = handbrake) and a tall GAS pedal;
 *  - top-right buttons (back to track, camera, sound) are created by the HUD for both modes.
 */
export class TouchControls {
  readonly root: HTMLDivElement;
  enabled = false;
  private readonly knob: HTMLDivElement;
  private readonly slider: HTMLDivElement;
  private readonly gas: HTMLDivElement;
  private readonly brake: HTMLDivElement;

  constructor(
    uiRoot: HTMLElement,
    private readonly input: Input,
  ) {
    const root = document.createElement("div");
    root.className = "touch";
    root.innerHTML = `
      <div class="steer">
        <div class="steer-hint"><span>↑ JUMP</span> · <span>↓ BOOST</span></div>
        <div class="steer-track"><div class="steer-mid"></div><div class="steer-knob"></div></div>
        <div class="steer-hint small">← STEER →</div>
      </div>
      <div class="pedals">
        <div class="pedal brake"><b>BRAKE</b><small>↓ HANDBRAKE</small></div>
        <div class="pedal gas"><div class="gas-grip"></div><b>GAS</b></div>
      </div>`;
    uiRoot.appendChild(root);
    this.root = root;
    this.slider = root.querySelector(".steer") as HTMLDivElement;
    this.knob = root.querySelector(".steer-knob") as HTMLDivElement;
    this.gas = root.querySelector(".gas") as HTMLDivElement;
    this.brake = root.querySelector(".brake") as HTMLDivElement;

    this.bindSteer();
    this.bindHold(this.gas, (held) => {
      this.input.touch.throttle = held ? 1 : 0;
    });
    this.bindBrake();

    if (prefersTouch()) this.enable();
    window.addEventListener(
      "touchstart",
      () => {
        this.input.usingTouch = true;
        this.enable();
      },
      { passive: true },
    );
    // iOS: block pinch zoom / double-tap zoom inside the game.
    document.addEventListener("gesturestart", (e) => e.preventDefault());
  }

  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add("touch-on");
  }

  private bindSteer(): void {
    const t = this.input.touch;
    let id = -1;
    let startY = 0;
    let jumped = false;
    const track = this.slider.querySelector(".steer-track") as HTMLDivElement;
    const move = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const half = r.width / 2;
      const x = Math.max(-1, Math.min(1, (e.clientX - (r.left + half)) / (half * 0.85)));
      t.steer = x;
      this.knob.style.transform = `translateX(${x * half * 0.85}px)`;
      const dy = e.clientY - startY;
      if (dy < -SWIPE && !jumped) {
        jumped = true;
        this.input.trigger("jump");
      }
      t.boost = dy > SWIPE;
      this.slider.classList.toggle("boosting", t.boost);
    };
    this.slider.addEventListener("pointerdown", (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      startY = e.clientY;
      jumped = false;
      this.slider.setPointerCapture(e.pointerId);
      this.slider.classList.add("active");
      move(e);
    });
    this.slider.addEventListener("pointermove", (e) => {
      if (e.pointerId === id) move(e);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      t.steer = 0;
      t.boost = false;
      this.knob.style.transform = "";
      this.slider.classList.remove("active", "boosting");
    };
    this.slider.addEventListener("pointerup", end);
    this.slider.addEventListener("pointercancel", end);
  }

  private bindBrake(): void {
    const t = this.input.touch;
    let id = -1;
    let startY = 0;
    this.brake.addEventListener("pointerdown", (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      startY = e.clientY;
      this.brake.setPointerCapture(e.pointerId);
      this.brake.classList.add("active");
      t.brake = 1;
    });
    this.brake.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      const hand = e.clientY - startY > SWIPE * 0.7;
      t.handbrake = hand;
      t.brake = hand ? 0 : 1;
      this.brake.classList.toggle("hand", hand);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      t.brake = 0;
      t.handbrake = false;
      this.brake.classList.remove("active", "hand");
    };
    this.brake.addEventListener("pointerup", end);
    this.brake.addEventListener("pointercancel", end);
  }

  private bindHold(el: HTMLElement, set: (held: boolean) => void): void {
    let id = -1;
    el.addEventListener("pointerdown", (e) => {
      if (id !== -1) return;
      id = e.pointerId;
      el.setPointerCapture(e.pointerId);
      el.classList.add("active");
      set(true);
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== id) return;
      id = -1;
      el.classList.remove("active");
      set(false);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
  }
}
