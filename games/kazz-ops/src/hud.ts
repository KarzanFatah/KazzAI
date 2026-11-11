import * as THREE from "three";
import { prefersTouch } from "./touch";
import type { GameContext, MoveState } from "./types";

const KEY_HINTS: readonly (readonly [string, string])[] = [
  ["WASD", "move"],
  ["SHIFT", "run"],
  ["DOUBLE SHIFT", "tactical"],
  ["SPACE", "vault"],
  ["CTRL/C", "slide/crouch"],
  ["RMB", "aim"],
  ["LMB", "fire"],
  ["R", "reload"],
  ["1-3", "weapons"],
  ["F9", "reset"],
  ["TAB", "camera"],
  ["F1", "tune"],
];

const INTRO_DESKTOP: readonly (readonly [string[], string])[] = [
  [["W", "A", "S", "D"], "Move"],
  [["SHIFT"], "Run · double-tap for tactical sprint"],
  [["SPACE"], "Vault low cover"],
  [["C", "CTRL"], "Slide while running · crouch"],
  [["RMB", "LMB"], "Aim · fire"],
  [["R", "1-3", "WHEEL"], "Reload · switch weapon"],
  [["TAB", "F9", "F1"], "Camera · reset · tune"],
];

const INTRO_TOUCH: readonly (readonly [string[], string])[] = [
  [["LEFT STICK"], "Move · push to the edge to run"],
  [["RIGHT STICK"], "Aim · push further to fire"],
  [["SPRINT", "VAULT"], "Tactical sprint · vault low cover"],
  [["CROUCH"], "Slide while running · crouch"],
  [["AIM", "SWAP"], "Steady aim toggle · next weapon"],
  [["CAM", "RESET", "⚙"], "Camera · reset · tune"],
];

const TOAST_HOLD = 1.6;
const STAT_HOT_TIME = 0.9;
const HIT_DECAY = 5;
const LOW_AMMO_FRACTION = 0.25;
const GAP_MIN = 3;
const GAP_MAX = 90;
const GAP_SMOOTHING = 22;
const DEG2RAD = Math.PI / 180;

/** Movement tag per state (index into MOVE_TAG_TEXT); crouching uses the last entry. */
const MOVE_TAG_INDEX: Partial<Record<MoveState, number>> = {
  vault: 1,
  slide: 2,
  tactical: 3,
};
const MOVE_TAG_TEXT = ["", "VAULT", "SLIDE", "TACTICAL", "CROUCH"];
const CROUCH_TAG = 4;

const tmpProject = new THREE.Vector3();
const tmpRight = new THREE.Vector3();
const tmpEdge = new THREE.Vector3();
const tmpScreenA = new THREE.Vector2();
const tmpScreenB = new THREE.Vector2();

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

/** A text node that only touches the DOM when its value changes. */
class TextField {
  private text: string | null = null;
  private num = NaN;

  constructor(readonly node: HTMLElement) {}

  set(text: string): void {
    if (text === this.text) return;
    this.text = text;
    this.num = NaN;
    this.node.textContent = text;
  }

  setNumber(n: number): void {
    if (n === this.num) return;
    this.num = n;
    this.text = null;
    this.node.textContent = String(n);
  }
}

/** Horizontal fill bar driven by scaleX (compositor only, quantised to avoid redundant writes). */
class FillBar {
  private value = -1;

  constructor(readonly fill: HTMLElement) {}

  set(fraction: number): void {
    const v = Math.round(THREE.MathUtils.clamp(fraction, 0, 1) * 400) / 400;
    if (v === this.value) return;
    this.value = v;
    this.fill.style.transform = `scaleX(${v})`;
  }
}

/** Four ticks + centre dot whose gap follows weapon spread, plus an X-shaped hit marker. */
class Crosshair {
  readonly root: HTMLDivElement;
  private readonly hit: HTMLDivElement;
  private x = NaN;
  private y = NaN;
  private gap = GAP_MIN;
  private shownGap = NaN;
  private hitLevel = 0;
  private shownHit = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "xh", parent);
    for (const side of ["t", "b", "l", "r"])
      el("div", `xh-tick xh-${side}`, this.root);
    el("div", "xh-dot", this.root);
    this.hit = el("div", "xh-hit", this.root);
    for (const side of ["t", "b", "l", "r"])
      el("div", `xh-tick xh-${side}`, this.hit);
  }

  moveTo(x: number, y: number): void {
    const rx = Math.round(x);
    const ry = Math.round(y);
    if (rx === this.x && ry === this.y) return;
    this.x = rx;
    this.y = ry;
    this.root.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
  }

  /** Ease the tick gap toward `target` px. */
  setGap(target: number, dt: number): void {
    const t = THREE.MathUtils.clamp(target, GAP_MIN, GAP_MAX);
    this.gap += (t - this.gap) * (1 - Math.exp(-GAP_SMOOTHING * dt));
    const g = Math.round(this.gap * 4) / 4;
    if (g === this.shownGap) return;
    this.shownGap = g;
    this.root.style.setProperty("--gap", `${g}px`);
  }

  flash(strength: number, strong: boolean): void {
    this.hitLevel = Math.max(this.hitLevel, strength);
    if (strong) this.hit.classList.add("is-strong");
  }

  update(dt: number): void {
    if (this.hitLevel <= 0 && this.shownHit === 0) return;
    this.hitLevel = Math.max(0, this.hitLevel - HIT_DECAY * dt);
    const level = Math.round(this.hitLevel * 50) / 50;
    if (level === this.shownHit) return;
    this.shownHit = level;
    const scale = 0.85 + level * 0.45;
    this.hit.style.opacity = String(Math.min(1, level * 1.4));
    this.hit.style.transform = `rotate(45deg) scale(${scale})`;
    if (level === 0) this.hit.classList.remove("is-strong");
  }
}

/**
 * DOM HUD: weapon + ammo, stamina bar, controls hint bar, crosshair, state tags, toasts,
 * hit markers, start overlay. Every DOM write is cached so steady frames touch nothing.
 */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly crosshair: Crosshair;
  private readonly unsubscribe: (() => void)[] = [];

  private readonly weaponName: TextField;
  private readonly mag: TextField;
  private readonly reserve: TextField;
  private readonly ammoStatus: TextField;
  private readonly ammoBox: HTMLDivElement;
  private readonly reloadBar: FillBar;

  private readonly staminaBox: HTMLDivElement;
  private readonly staminaValue: TextField;
  private readonly staminaBar: FillBar;
  private readonly stateTag: TextField;
  private stateCode = -1;
  private readonly stateTexts = new Map<number, string>();

  private readonly camMode: TextField;
  private readonly targets: TextField;
  private readonly barrels: TextField;
  private readonly fps: TextField;
  private targetsHot = 0;
  private barrelsHot = 0;
  private lastTargets = 0;
  private lastBarrels = 0;

  private readonly toast: TextField;
  private toastTimer = 0;

  private intro: HTMLDivElement | null;
  private introTimer = 0;
  private viewW = window.innerWidth;
  private viewH = window.innerHeight;

  constructor(private readonly ctx: GameContext) {
    const root = el("div", "hud hud--intro", ctx.uiRoot);
    this.root = root;

    const tl = el("div", "hud-tl", root);
    el("div", "hud-title", tl, "KAZZ OPS");
    const stats = el("div", "hud-stats", tl);
    this.camMode = this.statRow(stats, "CAM");
    this.targets = this.statRow(stats, "TARGETS");
    this.barrels = this.statRow(stats, "BARRELS");
    this.fps = this.statRow(stats, "FPS");

    const tr = el("div", "hud-tr", root);
    this.ammoBox = el("div", "hud-ammo", tr);
    this.weaponName = new TextField(el("span", "hud-weapon", this.ammoBox));
    this.mag = new TextField(el("span", "hud-mag", this.ammoBox));
    el("span", "hud-sep", this.ammoBox, "/");
    this.reserve = new TextField(el("span", "hud-reserve", this.ammoBox));
    this.ammoStatus = new TextField(el("div", "hud-ammo-status", tr));
    const reload = el("div", "hud-reload", tr);
    this.reloadBar = new FillBar(el("div", "hud-reload-fill", reload));

    this.toast = new TextField(el("div", "hud-toast", root));

    const bottom = el("div", "hud-bottom", root);
    this.stateTag = new TextField(el("div", "hud-state", bottom));
    this.staminaBox = el("div", "hud-stamina", bottom);
    const label = el("div", "hud-stamina-label", this.staminaBox, "STAMINA ");
    this.staminaValue = new TextField(el("span", "", label));
    const track = el("div", "hud-stamina-track", this.staminaBox);
    this.staminaBar = new FillBar(el("div", "hud-stamina-fill", track));
    const hints = el("div", "hud-hints", bottom);
    for (const [key, action] of KEY_HINTS) {
      const item = el("span", "hud-hint", hints);
      el("b", "", item, key);
      item.append(` ${action}`);
    }

    this.crosshair = new Crosshair(root);
    this.intro = this.buildIntro(prefersTouch());

    const { events } = ctx;
    this.unsubscribe.push(
      events.on("toast", ({ text }) => this.showToast(text)),
      events.on("cameraMode", ({ name }) => this.showToast(`CAMERA · ${name}`)),
      events.on("weaponSwitch", ({ weapon }) => this.showToast(weapon.name)),
      events.on("impact", ({ hit }) => {
        if (hit.prop) this.crosshair.flash(0.7, false);
      }),
      events.on("targetHit", () => this.crosshair.flash(1.25, true)),
    );
    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
  }

  update(dt: number): void {
    const touch = this.ctx.input.usingTouch;
    this.root.classList.toggle("hud--touch", touch);
    this.updateCrosshair(dt, touch);
    this.updateAmmo();
    this.updateStamina();
    this.updateStats(dt);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toast.node.classList.remove("is-shown");
    }
  }

  showToast(text: string): void {
    if (this.intro) return;
    this.toast.set(text);
    this.toast.node.classList.add("is-shown");
    this.toastTimer = TOAST_HOLD;
  }

  /** Hide the start overlay (first click / tap / key). */
  dismissIntro(): void {
    const intro = this.intro;
    if (!intro) return;
    this.intro = null;
    intro.classList.add("is-hidden");
    this.root.classList.remove("hud--intro");
    this.introTimer = window.setTimeout(() => intro.remove(), 600);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    window.removeEventListener("resize", this.onResize);
    window.visualViewport?.removeEventListener("resize", this.onResize);
    window.clearTimeout(this.introTimer);
    this.intro?.remove();
    this.root.remove();
  }

  private statRow(parent: HTMLElement, key: string): TextField {
    const row = el("div", "hud-stat", parent);
    el("span", "hud-stat-key", row, key);
    return new TextField(el("span", "hud-stat-value", row));
  }

  private buildIntro(touch: boolean): HTMLDivElement {
    const intro = el("div", "intro", this.ctx.uiRoot);
    const panel = el("div", "intro-panel", intro);
    el("div", "intro-kicker", panel, "FIRING RANGE · SANDBOX");
    el("h1", "intro-title", panel, "KAZZ OPS");
    el(
      "p",
      "intro-tagline",
      panel,
      "Tactical sandbox. Shoot stuff. Watch it fall over.",
    );
    const list = el("dl", "intro-controls", panel);
    for (const [keys, action] of touch ? INTRO_TOUCH : INTRO_DESKTOP) {
      const term = el("dt", "", list);
      for (const key of keys) el("kbd", "", term, key);
      el("dd", "", list, action);
    }
    el("div", "intro-start", panel, touch ? "TAP TO START" : "CLICK TO START");
    return intro;
  }

  private updateCrosshair(dt: number, touch: boolean): void {
    const { input, player, weapons, cameraRig } = this.ctx;
    const camera = cameraRig.camera;
    camera.updateMatrixWorld();

    const aim = player.aimPoint;
    const aimOnScreen = this.project(aim, tmpScreenA);

    // Spread cone radius at the aim point, measured on screen along the camera's right axis.
    tmpProject.set(player.position.x, aim.y, player.position.z);
    const dist = Math.max(1.5, tmpProject.distanceTo(aim));
    const radius = Math.tan(Math.max(0, weapons.spread) * DEG2RAD) * dist;
    tmpRight.setFromMatrixColumn(camera.matrixWorld, 0);
    tmpEdge.copy(aim).addScaledVector(tmpRight, radius);
    const edgeOnScreen = this.project(tmpEdge, tmpScreenB);
    const spreadPx =
      aimOnScreen && edgeOnScreen ? aimOnScreen.distanceTo(edgeOnScreen) : 0;
    this.crosshair.setGap(GAP_MIN + spreadPx, dt);

    const followAim = touch || !input.pointerActive;
    if (followAim && aimOnScreen) {
      this.crosshair.moveTo(aimOnScreen.x, aimOnScreen.y);
    } else if (!followAim) {
      this.crosshair.moveTo(input.pointerClient.x, input.pointerClient.y);
    }
    const xh = this.crosshair.root.classList;
    xh.toggle("is-idle", touch && !input.aimStick);
    xh.toggle("is-blocked", !player.canFire());
    this.crosshair.update(dt);
  }

  /** World point -> CSS px (viewport), or null when behind the camera. */
  private project(p: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 | null {
    tmpProject.copy(p).project(this.ctx.cameraRig.camera);
    if (tmpProject.z > 1) return null;
    return out.set(
      (tmpProject.x * 0.5 + 0.5) * this.viewW,
      (-tmpProject.y * 0.5 + 0.5) * this.viewH,
    );
  }

  private updateAmmo(): void {
    const { weapons, tuning } = this.ctx;
    const w = weapons.current;
    const infinite = tuning.infiniteAmmo >= 0.5;
    this.weaponName.set(w.name);
    this.mag.setNumber(weapons.ammo);
    if (infinite) this.reserve.set("∞");
    else this.reserve.setNumber(weapons.reserve);

    const empty = weapons.ammo === 0;
    const dry = empty && weapons.reserve === 0 && !infinite;
    let status = "";
    if (weapons.reloading) status = "RELOADING";
    else if (dry) status = "NO AMMO";
    else if (empty) status = "RELOAD";
    this.ammoStatus.set(status);

    const box = this.ammoBox.classList;
    box.toggle(
      "is-low",
      weapons.ammo <= Math.ceil(w.magSize * LOW_AMMO_FRACTION),
    );
    box.toggle("is-empty", empty);
    this.ammoStatus.node.classList.toggle(
      "is-warn",
      !weapons.reloading && empty,
    );
    this.root.classList.toggle("hud--reloading", weapons.reloading);
    this.reloadBar.set(weapons.reloading ? weapons.reloadProgress : 0);
  }

  private updateStamina(): void {
    const { player, tuning } = this.ctx;
    this.staminaValue.setNumber(Math.round(player.stamina));
    this.staminaBar.set(player.stamina / Math.max(1, tuning.staminaMax));
    this.staminaBox.classList.toggle("is-exhausted", player.exhausted);

    // Encode the tag combination as a number so the label string is built once per combo.
    const moveIndex =
      MOVE_TAG_INDEX[player.state] ?? (player.crouched ? CROUCH_TAG : 0);
    const code =
      moveIndex * 4 + (player.aiming ? 2 : 0) + (player.exhausted ? 1 : 0);
    if (code === this.stateCode) return;
    this.stateCode = code;
    let text = this.stateTexts.get(code);
    if (text === undefined) {
      const parts: string[] = [];
      if (moveIndex) parts.push(MOVE_TAG_TEXT[moveIndex]);
      if (player.aiming) parts.push("AIM");
      if (player.exhausted) parts.push("EXHAUSTED");
      text = parts.join(" · ");
      this.stateTexts.set(code, text);
    }
    // Keep the old text while the tag fades out.
    if (text) this.stateTag.set(text);
    this.stateTag.node.classList.toggle("is-shown", text !== "");
    this.stateTag.node.classList.toggle("is-warn", player.exhausted);
  }

  private updateStats(dt: number): void {
    const { stats, cameraRig } = this.ctx;
    this.camMode.set(cameraRig.modeName);
    this.targets.setNumber(stats.targetsDropped);
    this.barrels.setNumber(stats.barrelsExploded);
    this.fps.setNumber(stats.fps);

    if (stats.targetsDropped > this.lastTargets)
      this.targetsHot = STAT_HOT_TIME;
    if (stats.barrelsExploded > this.lastBarrels)
      this.barrelsHot = STAT_HOT_TIME;
    this.lastTargets = stats.targetsDropped;
    this.lastBarrels = stats.barrelsExploded;
    this.targetsHot = this.tickHot(this.targets.node, this.targetsHot, dt);
    this.barrelsHot = this.tickHot(this.barrels.node, this.barrelsHot, dt);
  }

  /** Highlight a stat that just went up; returns the remaining highlight time. */
  private tickHot(node: HTMLElement, time: number, dt: number): number {
    node.classList.toggle("is-hot", time > 0);
    return Math.max(0, time - dt);
  }

  private readonly onResize = (): void => {
    this.viewW = window.innerWidth;
    this.viewH = window.innerHeight;
  };
}
