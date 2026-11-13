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
  ["F9", "restart"],
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
  [["TAB", "F9", "F1"], "Camera · restart · tune"],
];

const INTRO_TOUCH: readonly (readonly [string[], string])[] = [
  [["LEFT STICK"], "Move · push to the edge to run"],
  [["RIGHT STICK"], "Aim · push further to fire"],
  [["SPRINT", "VAULT"], "Tactical sprint · vault low cover"],
  [["CROUCH"], "Slide while running · crouch"],
  [["AIM", "SWAP"], "Steady aim toggle · next weapon"],
  [["CAM", "RESET", "⚙"], "Camera · restart · tune"],
];

const TOAST_HOLD = 1.6;
const STAT_HOT_TIME = 0.9;
const HIT_DECAY = 5;
const LOW_AMMO_FRACTION = 0.25;
const GAP_MIN = 3;
const GAP_MAX = 90;
const GAP_SMOOTHING = 22;
const DEG2RAD = Math.PI / 180;

const LOW_HEALTH = 30;
const HEALTH_FLASH_TIME = 0.18;
const VIGNETTE_DECAY = 1.6;
const BANNER_HOLD = 2.4;
const PICKUP_HOLD = 1.1;
const KILL_DECAY = 2.2;
const BEST_WAVE_KEY = "kazz-ops.bestWave";

/** Small original skull glyph for the kill tick. */
const SKULL_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6C4.6 1.6 2.3 3.9 2.3 7c0 1.9.9 3.2 2.2 3.9v2.6h7V10.9c1.3-.7 2.2-2 2.2-3.9 0-3.1-2.3-5.4-5.7-5.4Z"/><path class="hole" d="M4.4 7.3a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0Zm4 0a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0ZM7.2 10.6 8 9.2l.8 1.4Z"/><path class="hole" d="M6.4 12.1h.7v1.4h-.7Zm2.5 0h.7v1.4h-.7Z"/></svg>';

function readBestWave(): number {
  try {
    return Number(window.localStorage.getItem(BEST_WAVE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeBestWave(wave: number): void {
  try {
    window.localStorage.setItem(BEST_WAVE_KEY, String(wave));
  } catch {
    // Storage blocked (private mode): the best wave just isn't remembered.
  }
}

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
  private hitClass = "";
  private readonly kill: HTMLDivElement;
  private killLevel = 0;
  private shownKill = -1;

  constructor(parent: HTMLElement) {
    this.root = el("div", "xh", parent);
    for (const side of ["t", "b", "l", "r"])
      el("div", `xh-tick xh-${side}`, this.root);
    el("div", "xh-dot", this.root);
    this.hit = el("div", "xh-hit", this.root);
    for (const side of ["t", "b", "l", "r"])
      el("div", `xh-tick xh-${side}`, this.hit);
    this.kill = el("div", "xh-kill", this.root);
    this.kill.innerHTML = SKULL_SVG;
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

  /** Hit marker; `tone` = "is-strong" (target) or "is-head" (headshot) recolours it. */
  flash(strength: number, tone = ""): void {
    this.hitLevel = Math.max(this.hitLevel, strength);
    if (!tone || tone === this.hitClass) return;
    if (this.hitClass) this.hit.classList.remove(this.hitClass);
    this.hitClass = tone;
    this.hit.classList.add(tone);
  }

  /** Skull tick next to the crosshair (red for a headshot kill). */
  flashKill(headshot: boolean): void {
    this.killLevel = 1;
    this.shownKill = -1;
    this.kill.classList.toggle("is-head", headshot);
  }

  update(dt: number): void {
    this.updateKill(dt);
    if (this.hitLevel <= 0 && this.shownHit === 0) return;
    this.hitLevel = Math.max(0, this.hitLevel - HIT_DECAY * dt);
    const level = Math.round(this.hitLevel * 50) / 50;
    if (level === this.shownHit) return;
    this.shownHit = level;
    const scale = 0.85 + level * 0.45;
    this.hit.style.opacity = String(Math.min(1, level * 1.4));
    this.hit.style.transform = `rotate(45deg) scale(${scale})`;
    if (level === 0 && this.hitClass) {
      this.hit.classList.remove(this.hitClass);
      this.hitClass = "";
    }
  }

  private updateKill(dt: number): void {
    if (this.killLevel <= 0 && this.shownKill === 0) return;
    this.killLevel = Math.max(0, this.killLevel - KILL_DECAY * dt);
    const level = Math.round(this.killLevel * 40) / 40;
    if (level === this.shownKill) return;
    this.shownKill = level;
    // Pops in big, settles, then fades and drifts up.
    const pop = 1 + Math.max(0, level - 0.8) * 2.5;
    this.kill.style.opacity = String(Math.min(1, level * 2.5));
    this.kill.style.transform = `translate(14px, ${-22 - (1 - level) * 10}px) scale(${pop})`;
  }
}

/** YOU DIED panel with the run summary and a TRY AGAIN button. */
class GameOver {
  readonly root: HTMLDivElement;
  private readonly wave: TextField;
  private readonly kills: TextField;
  private readonly headshots: TextField;
  private readonly best: TextField;
  private readonly bestTag: HTMLDivElement;

  constructor(parent: HTMLElement, onRetry: () => void) {
    this.root = el("div", "gameover", parent);
    const panel = el("div", "gameover-panel", this.root);
    el("div", "gameover-kicker", panel, "SURVIVAL · RUN OVER");
    el("h2", "gameover-title", panel, "YOU DIED");
    this.bestTag = el("div", "gameover-best-tag", panel, "NEW BEST");
    const rows = el("dl", "gameover-stats", panel);
    this.wave = this.row(rows, "WAVE REACHED");
    this.kills = this.row(rows, "KILLS");
    this.headshots = this.row(rows, "HEADSHOTS");
    this.best = this.row(rows, "BEST WAVE");
    const button = el("button", "gameover-btn", panel, "TRY AGAIN");
    button.type = "button";
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      onRetry();
    });
    el("div", "gameover-hint", panel).innerHTML = "<kbd>F9</kbd> to restart";
  }

  show(wave: number, kills: number, headshots: number): void {
    const previous = readBestWave();
    const best = Math.max(previous, wave);
    if (best > previous) writeBestWave(best);
    this.wave.setNumber(wave);
    this.kills.setNumber(kills);
    this.headshots.setNumber(headshots);
    this.best.setNumber(best);
    this.bestTag.classList.toggle("is-shown", wave > previous && wave > 0);
    this.root.classList.add("is-shown");
  }

  hide(): void {
    this.root.classList.remove("is-shown");
  }

  private row(parent: HTMLElement, key: string): TextField {
    el("dt", "", parent, key);
    return new TextField(el("dd", "", parent));
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

  private readonly healthBox: HTMLDivElement;
  private readonly healthValue: TextField;
  private readonly healthBar: FillBar;
  private healthFlash = 0;
  private readonly vignette: HTMLDivElement;
  private vignetteLevel = 0;
  private shownVignette = -1;

  private readonly wave: TextField;
  private waveKey = NaN;
  private readonly banner: HTMLDivElement;
  private readonly bannerTitle: TextField;
  private readonly bannerSub: TextField;
  private bannerTimer = 0;
  private readonly pickup: TextField;
  private pickupTimer = 0;
  private readonly gameOver: GameOver;

  private readonly camMode: TextField;
  private readonly kills: TextField;
  private readonly headshots: TextField;
  private killsHot = 0;
  private headshotsHot = 0;
  private lastKills = 0;
  private lastHeadshots = 0;
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
    this.vignette = el("div", "hud-vignette", root);
    el("div", "hud-vignette hud-vignette--low", root);

    const tl = el("div", "hud-tl", root);
    el("div", "hud-title", tl, "KAZZ OPS");
    const stats = el("div", "hud-stats", tl);
    this.camMode = this.statRow(stats, "CAM");
    this.kills = this.statRow(stats, "KILLS");
    this.headshots = this.statRow(stats, "HEADSHOTS");
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

    this.wave = new TextField(el("div", "hud-wave", root));
    this.toast = new TextField(el("div", "hud-toast", root));
    this.banner = el("div", "hud-banner", root);
    this.bannerTitle = new TextField(el("div", "hud-banner-title", this.banner));
    this.bannerSub = new TextField(el("div", "hud-banner-sub", this.banner));

    const bottom = el("div", "hud-bottom", root);
    this.pickup = new TextField(el("div", "hud-pickup", bottom));
    this.stateTag = new TextField(el("div", "hud-state", bottom));
    this.healthBox = el("div", "hud-health", bottom);
    const healthLabel = el("div", "hud-bar-label", this.healthBox, "HEALTH ");
    this.healthValue = new TextField(el("span", "", healthLabel));
    const healthTrack = el("div", "hud-bar-track", this.healthBox);
    this.healthBar = new FillBar(el("div", "hud-health-fill", healthTrack));
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
    this.gameOver = new GameOver(ctx.uiRoot, () => ctx.input.trigger("reset"));
    this.intro = this.buildIntro(prefersTouch());

    const { events } = ctx;
    this.unsubscribe.push(
      events.on("toast", ({ text }) => this.showToast(text)),
      events.on("cameraMode", ({ name }) => this.showToast(`CAMERA · ${name}`)),
      events.on("weaponSwitch", ({ weapon }) => this.showToast(weapon.name)),
      events.on("impact", ({ hit }) => {
        if (hit.prop) this.crosshair.flash(0.7);
      }),
      events.on("targetHit", () => this.crosshair.flash(1.25, "is-strong")),
      events.on("zombieHit", ({ headshot }) =>
        this.crosshair.flash(headshot ? 1.6 : 0.8, headshot ? "is-head" : ""),
      ),
      events.on("zombieKilled", ({ headshot }) =>
        this.crosshair.flashKill(headshot),
      ),
      events.on("playerHurt", ({ amount }) => {
        this.healthFlash = HEALTH_FLASH_TIME;
        this.vignetteLevel = Math.min(
          1,
          this.vignetteLevel + THREE.MathUtils.clamp(amount / 30, 0.25, 0.85),
        );
      }),
      events.on("playerDied", ({ wave, kills }) =>
        this.gameOver.show(wave, kills, ctx.stats.headshots),
      ),
      events.on("waveStart", ({ wave, count }) =>
        this.showBanner(`WAVE ${wave}`, `${count} INCOMING`, false),
      ),
      events.on("waveCleared", () =>
        this.showBanner("WAVE CLEARED", "AMMO REFILLED", true),
      ),
      events.on("pickup", ({ kind }) => this.showPickup(kind)),
      events.on("reset", () => {
        this.gameOver.hide();
        this.vignetteLevel = 0;
        this.bannerTimer = 0;
        this.banner.classList.remove("is-shown");
      }),
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
    this.updateHealth(dt);
    this.updateWave();
    this.updateStats(dt);

    this.toastTimer = this.fade(this.toast.node, this.toastTimer, dt);
    this.bannerTimer = this.fade(this.banner, this.bannerTimer, dt);
    this.pickupTimer = this.fade(this.pickup.node, this.pickupTimer, dt);
  }

  showToast(text: string): void {
    if (this.intro) return;
    this.toast.set(text);
    this.toast.node.classList.add("is-shown");
    this.toastTimer = TOAST_HOLD;
  }

  /** Big centre banner for wave start / wave cleared. */
  showBanner(title: string, sub: string, good: boolean): void {
    this.bannerTitle.set(title);
    this.bannerSub.set(sub);
    this.banner.classList.toggle("is-good", good);
    this.banner.classList.add("is-shown");
    this.bannerTimer = BANNER_HOLD;
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
    this.gameOver.root.remove();
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
    el("div", "intro-kicker", panel, "ZOMBIE SURVIVAL");
    el("h1", "intro-title", panel, "KAZZ OPS");
    el("p", "intro-tagline", panel, "Survive the waves. Barrels go boom.");
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

  private updateHealth(dt: number): void {
    const { player } = this.ctx;
    const hp = Math.ceil(player.health);
    this.healthValue.setNumber(hp);
    this.healthBar.set(player.health / player.maxHealth);
    const low = hp < LOW_HEALTH && !player.dead;
    this.healthFlash = this.tickHot(this.healthBox, this.healthFlash, dt);
    this.healthBox.classList.toggle("is-low", low);
    this.root.classList.toggle("hud--low-health", low);
    this.root.classList.toggle("hud--dead", player.dead);

    if (this.vignetteLevel <= 0 && this.shownVignette === 0) return;
    this.vignetteLevel = Math.max(0, this.vignetteLevel - VIGNETTE_DECAY * dt);
    const level = Math.round(this.vignetteLevel * 50) / 50;
    if (level === this.shownVignette) return;
    this.shownVignette = level;
    this.vignette.style.opacity = String(level);
  }

  /** Top-centre wave status; the string is only rebuilt when a shown number changes. */
  private updateWave(): void {
    const { wave, phase, intermissionLeft, remaining } = this.ctx.zombies;
    const active = phase === "active";
    const seconds = Math.ceil(intermissionLeft);
    let key: number;
    if (active) key = wave * 100000 + remaining;
    else if (intermissionLeft > 0) key = -(wave * 1000 + seconds) - 1;
    else key = 0;
    if (key === this.waveKey) return;
    this.waveKey = key;
    if (active) this.wave.set(`WAVE ${wave} · ${remaining} LEFT`);
    else if (intermissionLeft > 0)
      this.wave.set(`${wave === 0 ? "FIRST" : "NEXT"} WAVE IN ${seconds}`);
    else this.wave.set("GET READY");
    this.wave.node.classList.toggle("is-active", active);
  }

  private showPickup(kind: "ammo" | "health"): void {
    this.pickup.set(kind === "ammo" ? "+AMMO" : "+HEALTH");
    this.pickup.node.classList.toggle("is-health", kind === "health");
    this.pickup.node.classList.add("is-shown");
    this.pickupTimer = PICKUP_HOLD;
  }

  /** Counts a shown element's timer down and fades it out at 0; returns the remaining time. */
  private fade(node: HTMLElement, time: number, dt: number): number {
    if (time <= 0) return 0;
    const left = time - dt;
    if (left <= 0) node.classList.remove("is-shown");
    return Math.max(0, left);
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
    this.kills.setNumber(stats.kills);
    this.headshots.setNumber(stats.headshots);
    this.targets.setNumber(stats.targetsDropped);
    this.barrels.setNumber(stats.barrelsExploded);
    this.fps.setNumber(stats.fps);

    if (stats.targetsDropped > this.lastTargets)
      this.targetsHot = STAT_HOT_TIME;
    if (stats.barrelsExploded > this.lastBarrels)
      this.barrelsHot = STAT_HOT_TIME;
    if (stats.kills > this.lastKills) this.killsHot = STAT_HOT_TIME;
    if (stats.headshots > this.lastHeadshots) this.headshotsHot = STAT_HOT_TIME;
    this.lastKills = stats.kills;
    this.lastHeadshots = stats.headshots;
    this.killsHot = this.tickHot(this.kills.node, this.killsHot, dt);
    this.headshotsHot = this.tickHot(this.headshots.node, this.headshotsHot, dt);
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
