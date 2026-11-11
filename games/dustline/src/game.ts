import * as THREE from "three";
import { AudioSystem } from "./audio";
import { ChaseCamera } from "./camera";
import { Car, type DriveInput } from "./car";
import { Effects, TireTracks } from "./fx";
import { Hud } from "./hud";
import { Input } from "./input";
import { buildProps, type PropsResult } from "./props";
import { formatTime, Race } from "./race";
import { Sea } from "./sea";
import { Terrain } from "./terrain";
import { TouchControls } from "./touch";
import { Track, type NearestResult } from "./track";

const IDLE_INPUT: DriveInput = {
  throttle: 0,
  brake: 0,
  steer: 0,
  handbrake: false,
  boost: false,
  jump: false,
};

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _side = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _normal = new THREE.Vector3();

/** Owns the scene and all systems; runs the frame loop. */
export class Game {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly track = new Track();
  readonly terrain: Terrain;
  readonly props: PropsResult;
  readonly sea: Sea;
  readonly fx: Effects;
  readonly tracks: TireTracks;
  readonly car: Car;
  readonly race: Race;
  readonly cam = new ChaseCamera();
  readonly input = new Input();
  readonly touch: TouchControls;
  readonly hud: Hud;
  readonly audio = new AudioSystem();

  private readonly sun: THREE.DirectionalLight;
  private readonly near: NearestResult = { index: 0, distance: 0, lateral: 0 };
  private raf = 0;
  private last = 0;
  private time = 0;
  private fps = 60;
  private fpsAcc = 0;
  private fpsFrames = 0;
  private dustClock = 0;
  private started = false;

  constructor(container: HTMLElement, ui: HTMLElement) {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const haze = new THREE.Color(0xe8cf9f);
    this.scene.background = haze;
    this.scene.fog = new THREE.Fog(haze, 140, 430);

    this.scene.add(new THREE.HemisphereLight(0xfff3dc, 0xa07a4a, 0.7));
    // Low warm sun for long shadows.
    const sun = new THREE.DirectionalLight(0xffe3b5, 3.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -60;
    sc.right = 60;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 10;
    sc.far = 320;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.terrain = new Terrain(this.track);
    this.scene.add(this.terrain.buildMesh());
    this.sea = new Sea(this.scene, this.terrain);
    this.props = buildProps(this.scene, this.terrain, this.track);
    this.fx = new Effects(this.scene, this.terrain);
    this.tracks = new TireTracks(this.scene, this.terrain, 4);

    this.car = new Car(this.terrain, {
      onLand: (s, p) => {
        this.fx.landing(p, s);
        this.audio.landing(s);
        this.cam.shake(s * 0.6);
      },
      onImpact: (s, p, c) => {
        this.fx.impact(p, s);
        this.audio.impact(s);
        this.cam.shake(s * 0.8);
        if (c.id !== undefined) this.props.hit(c.id, s);
      },
      onSoftHit: (c, s) => {
        if (c.id !== undefined) this.props.hit(c.id, s);
      },
      onJump: () => this.audio.jump(),
      onBoostStart: () => this.audio.boost(),
    });
    this.scene.add(this.car.model.root);

    this.race = new Race(this.track, {
      onCountdown: (n) => {
        this.hud.center(n > 0 ? String(n) : "GO!", n > 0 ? 0.8 : 0.9);
        this.audio.countdown(n === 0);
      },
      onCheckpoint: (i, t) => {
        this.hud.toast(`CHECKPOINT ${i}/${this.track.checkpoints.length - 1} · ${formatTime(t)}`);
        this.audio.checkpoint();
      },
      onLap: (lap, t, best) => {
        this.hud.center(`LAP ${lap + 1}`, 1.2, "small");
        this.hud.toast(`LAP ${lap} · ${formatTime(t)}${best ? " · BEST!" : ""}`, 2.4);
        this.audio.lap();
      },
      onFinish: (total) => {
        this.audio.finish();
        this.hud.center("FINISH", 1.6, "small");
        window.setTimeout(() => this.hud.showFinish(total, this.race.lapTimes, this.race.bestLap), 1400);
      },
    });

    this.touch = new TouchControls(ui, this.input);
    this.hud = new Hud(ui, {
      onBackToTrack: () => this.backToTrack(),
      onCamera: () => this.hud.toast(`CAMERA · ${this.cam.cycle()}`),
      onMute: () => this.audio.setMuted(!this.audio.muted),
      onStart: () => this.startRace(),
    });

    this.placeAtStart();
    window.addEventListener("resize", this.onResize);
    this.onResize();
    const unlock = () => this.audio.unlock();
    window.addEventListener("pointerdown", unlock, true);
    window.addEventListener("keydown", unlock, true);
    window.addEventListener("touchend", unlock, true);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  start(): void {
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /** Begin (or restart) the race from the start line. */
  startRace(): void {
    this.audio.unlock();
    this.hud.hideIntro();
    this.hud.hideFinish();
    this.placeAtStart();
    this.tracks.clear();
    this.fx.clear();
    this.race.startCountdown();
    this.started = true;
  }

  private placeAtStart(): void {
    const start = this.track.checkpoints[0];
    const behind = this.track.at(start.sample - 6);
    this.car.reset(behind.x, behind.z, Math.atan2(behind.tx, behind.tz));
    this.cam.snap(this.car);
  }

  /** Put the car back on the road centre, facing the right way. */
  backToTrack(): void {
    const p = this.car.position;
    this.track.nearest(p.x, p.z, this.near);
    const s = this.track.at(this.near.index);
    this.car.reset(s.x, s.z, Math.atan2(s.tx, s.tz));
    this.tracks.cut(0);
    this.tracks.cut(1);
    this.tracks.cut(2);
    this.tracks.cut(3);
    this.hud.toast("BACK ON TRACK");
  }

  /** Step the simulation without waiting for frames (used by automated tests). */
  advance(seconds: number, step = 1 / 60): void {
    for (let t = 0; t < seconds; t += step) this.tick(step);
    this.renderer.render(this.scene, this.cam.camera);
  }

  private readonly frame = (now: number): void => {
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min((now - this.last) / 1000, 1 / 20);
    this.last = now;
    this.fpsAcc += dt;
    this.fpsFrames++;
    if (this.fpsAcc > 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsAcc);
      this.fpsAcc = 0;
      this.fpsFrames = 0;
    }
    this.tick(dt);
    this.renderer.render(this.scene, this.cam.camera);
  };

  private tick(dt: number): void {
    this.time += dt;
    const { input, car, race } = this;
    input.update();
    if (input.startPressed && (!this.started || race.state === "finished")) this.startRace();
    if (input.cameraPressed) this.hud.toast(`CAMERA · ${this.cam.cycle()}`);
    if (input.mutePressed) this.audio.setMuted(!this.audio.muted);
    if (input.resetPressed) this.backToTrack();

    const drive = race.state === "racing" ? input.drive : IDLE_INPUT;
    car.update(dt, drive, this.props.colliders);
    if (car.drowning > 1.3) this.backToTrack();
    race.update(dt, car);

    this.props.update(dt, this.time, car.position);
    this.emitWheelEffects(dt);
    this.fx.update(dt, this.cam.camera);
    this.tracks.update(dt);
    this.sea.update(this.time);
    this.cam.update(dt, car);
    this.followSun();

    car.audio.throttle = race.state === "countdown" ? input.drive.throttle : car.audio.throttle;
    this.audio.update(dt, car.audio);
    this.hud.update(dt, {
      speedKmh: car.speed * 3.6,
      fps: this.fps,
      boost: car.boost,
      boosting: car.boosting,
      race,
      muted: this.audio.muted,
    });
  }

  private emitWheelEffects(dt: number): void {
    const car = this.car;
    car.rightVector(_side);
    if (!car.grounded) {
      for (let i = 0; i < 4; i++) this.tracks.cut(i);
      return;
    }
    const amount = car.dustAmount();
    const intensity = Math.min(1, 0.35 + car.slip * 0.8);
    for (let i = 0; i < 4; i++) {
      car.wheelContact(i, _a);
      this.terrain.normalAt(_a.x, _a.z, _normal);
      if (car.speed > 1) this.tracks.add(i, _a, _normal, _side, intensity);
    }
    // Dust and splashes at ~30 Hz from the rear wheels.
    this.dustClock += dt;
    if (this.dustClock < 1 / 30) return;
    this.dustClock = 0;
    car.velocityCopy(_vel);
    for (let i = 2; i < 4; i++) {
      car.wheelContact(i, _b);
      if (car.surface === "water") this.fx.splash(_b, _vel, Math.min(1, car.speed / 20));
      else if (amount > 0.04) this.fx.dust(_b, _vel, amount);
    }
    if (car.boosting) {
      _a.set(Math.sin(car.yaw), 0, Math.cos(car.yaw)).multiplyScalar(-1);
      _b.copy(car.position).addScaledVector(_a, 2.4);
      _b.y += 0.45;
      this.fx.boostPuff(_b, _a);
    }
  }

  private followSun(): void {
    // Keep the shadow frustum centred on the car, snapped to shadow texels to avoid shimmer.
    const p = this.car.position;
    const texel = 120 / 2048;
    const x = Math.round(p.x / texel) * texel;
    const z = Math.round(p.z / texel) * texel;
    this.sun.target.position.set(x, p.y, z);
    this.sun.position.set(x + 100, p.y + 58, z - 95);
  }

  /** Pause rendering and sound while the tab/app is in the background. */
  private readonly onVisibility = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.raf);
      this.audio.setPaused(true);
    } else {
      this.audio.setPaused(false);
      this.start();
    }
  };

  private readonly onResize = (): void => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.cam.setViewport(w, h);
  };
}
