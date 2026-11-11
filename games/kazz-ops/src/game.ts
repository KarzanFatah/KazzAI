import * as THREE from "three";
import { AudioSystem } from "./audio";
import { CameraRig } from "./camera";
import { createTuning } from "./config";
import { EventBus } from "./events";
import { Effects } from "./fx";
import { Hud } from "./hud";
import { Input } from "./input";
import { Physics } from "./physics";
import { Player } from "./player";
import { TouchControls } from "./touch";
import { TunePanel } from "./tune";
import type { GameContext } from "./types";
import { WeaponSystem } from "./weapon";
import { World } from "./world";

const MAX_FRAME_DT = 1 / 20;

/** Owns every system and runs the frame loop. */
export class Game {
  readonly ctx: GameContext;
  readonly tunePanel: TunePanel;
  readonly touch: TouchControls;

  private rafId = 0;
  private lastFrame = 0;
  private fpsFrames = 0;
  private fpsTime = 0;
  private gestureSeen = false;

  constructor(container: HTMLElement, uiRoot: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = "game-canvas";
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x222b38);

    // Systems are created in the order documented on GameContext.
    const ctx = {
      tuning: createTuning(),
      events: new EventBus(),
      renderer,
      scene,
      canvas: renderer.domElement,
      uiRoot,
      clock: { time: 0, dt: 0 },
      stats: {
        shots: 0,
        hits: 0,
        targetsDropped: 0,
        barrelsExploded: 0,
        fps: 0,
      },
    } as Partial<GameContext> as GameContext;
    this.ctx = ctx;

    ctx.physics = new Physics(ctx);
    ctx.input = new Input(renderer.domElement);
    ctx.cameraRig = new CameraRig(ctx);
    ctx.fx = new Effects(ctx);
    ctx.audio = new AudioSystem(ctx);
    ctx.world = new World(ctx);
    ctx.player = new Player(ctx);
    ctx.weapons = new WeaponSystem(ctx);
    ctx.hud = new Hud(ctx);
    this.tunePanel = new TunePanel(ctx);
    this.touch = new TouchControls(ctx);

    ctx.world.build();
    ctx.player.reset(ctx.world.spawnPoint, ctx.world.spawnYaw);
    ctx.weapons.reset();
    ctx.cameraRig.snapTo(ctx.player.position);

    window.addEventListener("resize", this.onResize);
    window.visualViewport?.addEventListener("resize", this.onResize);
    this.onResize();

    // Audio may only start after a user gesture.
    window.addEventListener("pointerdown", this.onGesture, true);
    window.addEventListener("keydown", this.onGesture, true);
    window.addEventListener("touchstart", this.onGesture, true);
  }

  start(): void {
    if (this.rafId) return;
    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  stop(): void {
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /** F9: put the whole sandbox back to its initial state. */
  reset(): void {
    const { ctx } = this;
    ctx.world.reset();
    ctx.fx.clear();
    ctx.player.reset(ctx.world.spawnPoint, ctx.world.spawnYaw);
    ctx.weapons.reset();
    ctx.cameraRig.snapTo(ctx.player.position);
    ctx.stats.shots = 0;
    ctx.stats.hits = 0;
    ctx.stats.targetsDropped = 0;
    ctx.stats.barrelsExploded = 0;
    ctx.events.emit("reset", {});
    ctx.events.emit("toast", { text: "SANDBOX RESET" });
  }

  /**
   * Advance the simulation by `seconds` in fixed steps without waiting for frames, then render.
   * Used by automated tests (window.__kazz.game.advance(2)).
   */
  advance(seconds: number, step = 1 / 60): void {
    const n = Math.max(1, Math.round(seconds / step));
    for (let i = 0; i < n; i++) this.tick(step);
    this.render();
  }

  private readonly frame = (now: number): void => {
    this.rafId = requestAnimationFrame(this.frame);
    const raw = Math.min((now - this.lastFrame) / 1000, MAX_FRAME_DT);
    this.lastFrame = now;

    this.fpsFrames++;
    this.fpsTime += raw;
    if (this.fpsTime >= 0.5) {
      this.ctx.stats.fps = Math.round(this.fpsFrames / this.fpsTime);
      this.fpsFrames = 0;
      this.fpsTime = 0;
    }

    this.tick(raw);
    this.render();
  };

  private tick(rawDt: number): void {
    const { ctx } = this;
    const dt = rawDt * ctx.tuning.timeScale;
    ctx.clock.dt = dt;
    ctx.clock.time += dt;

    ctx.input.update(rawDt);
    this.touch.update(rawDt);

    if (ctx.input.tunePressed) this.tunePanel.toggle();
    if (ctx.input.cameraPressed) ctx.cameraRig.cycleMode();
    if (ctx.input.resetPressed) this.reset();

    ctx.player.update(dt);
    ctx.physics.step(dt);
    ctx.world.update(dt);
    ctx.player.postPhysics(dt);
    ctx.weapons.update(dt);
    ctx.cameraRig.update(
      rawDt,
      ctx.player.position,
      ctx.player.aimPoint,
      ctx.player.aiming,
    );
    ctx.world.updateShadowFocus(ctx.player.position);
    ctx.fx.update(dt);
    ctx.audio.update(rawDt);
    ctx.hud.update(rawDt);

    ctx.input.endFrame();
  }

  private render(): void {
    this.ctx.renderer.render(this.ctx.scene, this.ctx.cameraRig.camera);
  }

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.ctx.renderer.setSize(w, h, false);
    this.ctx.cameraRig.setViewport(w, h);
  };

  private readonly onGesture = (): void => {
    this.ctx.audio.unlock();
    if (!this.gestureSeen) {
      this.gestureSeen = true;
      this.ctx.hud.dismissIntro();
    }
  };
}
