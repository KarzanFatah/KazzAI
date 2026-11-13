import * as THREE from "three";
import { WEAPONS, weaponBySlot } from "./weapons-data";
import type { GameContext, HitInfo, WeaponDef, WeaponSound } from "./types";

/** Seconds a trigger press stays buffered while the weapon is not ready yet. */
const FIRE_BUFFER = 0.12;
/** Raise time after switching weapons. */
const SWITCH_TIME = 0.25;
const DRY_FIRE_INTERVAL = 0.35;
/** An empty mag starts reloading on its own after this long (if there is reserve). */
const AUTO_RELOAD_DELAY = 0.3;
/** Seconds (at reloadSpeedMul 1) for the pump that ends a shell-by-shell reload. */
const PUMP_TIME = 0.3;
/** Fraction of the pump-action's shot interval at which the slide is racked. */
const PUMP_AT = 0.4;
const MAG_STAGES = [
  [0.2, "magOut"],
  [0.65, "magIn"],
  [0.85, "bolt"],
] as const;
/** Safety cap for very high fire rates on very long frames. */
const MAX_SHOTS_PER_FRAME = 8;
/** Aim points closer than this (horizontally) are ignored in favour of the facing direction. */
const MIN_AIM_DIST = 1.5;
/** Max |slope| of the shot direction (rise per metre). */
const MAX_PITCH = 0.35;
/** Vertical spread is squashed: from above only sideways spread reads, and it keeps low props hittable. */
const VERTICAL_SPREAD = 0.35;
/** How far behind the muzzle the hitscan ray may start (the muzzle-to-chest distance). */
const MAX_RAY_BACKSET = 1.2;
const BLOOM_RECOVERY_DELAY = 0.12;
/** Movement spread stops growing past this fraction of run speed. */
const MAX_MOVE_SPREAD = 1.3;
/** Rate (1/s) at which aim/crouch spread transitions settle. */
const STANCE_BLEND = 12;
const MAX_PELLET_TRACERS = 5;

const SMOKE_AMOUNT: Record<WeaponSound, number> = {
  suppressed: 1.3,
  pistol: 0.6,
  shotgun: 1.6,
};

const CASING: Record<WeaponDef["id"], "rifle" | "pistol" | "shell"> = {
  carbine: "rifle",
  pistol: "pistol",
  shotgun: "shell",
};

interface AmmoState {
  mag: number;
  reserve: number;
}

const muzzle = new THREE.Vector3();
const barrelDir = new THREE.Vector3();
const aimDir = new THREE.Vector3();
const rayOrigin = new THREE.Vector3();
const rayEnd = new THREE.Vector3();
const pelletDir = new THREE.Vector3();
const tracerEnd = new THREE.Vector3();
const basisU = new THREE.Vector3();
const basisV = new THREE.Vector3();
const ejectPos = new THREE.Vector3();
const ejectVel = new THREE.Vector3();
const kickDir = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const WORLD_X = new THREE.Vector3(1, 0, 0);

const rand = (min: number, max: number): number =>
  min + Math.random() * (max - min);

/** Random direction inside an (elliptical) cone around `axis`. */
function scatter(
  out: THREE.Vector3,
  axis: THREE.Vector3,
  halfAngle: number,
  uniform: boolean,
): THREE.Vector3 {
  basisU
    .crossVectors(Math.abs(axis.y) < 0.99 ? WORLD_UP : WORLD_X, axis)
    .normalize();
  basisV.crossVectors(axis, basisU).normalize();
  // Uniform disc for pellet patterns, centre-weighted for single bullets.
  const r =
    Math.tan(halfAngle) * (uniform ? Math.sqrt(Math.random()) : Math.random());
  const a = Math.random() * Math.PI * 2;
  return out
    .copy(axis)
    .addScaledVector(basisU, Math.cos(a) * r)
    .addScaledVector(basisV, Math.sin(a) * r * VERTICAL_SPREAD)
    .normalize();
}

/**
 * Firing (hitscan with spread/bloom/recoil), ammo, reloads, weapon switching, tracers, casings,
 * applying bullet hits to props through World.
 */
export class WeaponSystem {
  current: WeaponDef = WEAPONS[0];
  /** Rounds in the current magazine. */
  ammo = WEAPONS[0].magSize;
  /** Spare rounds for the current weapon. */
  reserve = WEAPONS[0].reserveMax;
  reloading = false;
  /** 0..1 progress of the current reload (per shell for the shotgun). */
  reloadProgress = 0;
  /** Current total spread half-angle in degrees (for the HUD crosshair). */
  spread = 0;
  /** Shots fired since the last call to consumeShotsFired() (Player feeds the model's recoil). */
  private shotsSinceRead = 0;

  /** Per-weapon ammo, parallel to WEAPONS; kept when switching. */
  private readonly ammoStates: AmmoState[] = WEAPONS.map((w) => ({
    mag: w.magSize,
    reserve: w.reserveMax,
  }));
  private state = this.ammoStates[0];
  /** Seconds until the next round may fire; negative remainders carry over while firing. */
  private cooldown = 0;
  /** True while rounds keep coming back to back (the cooldown remainder is valid credit). */
  private firingStreak = false;
  private fireBuffer = 0;
  private switchTimer = 0;
  private dryFireTimer = 0;
  private emptyTimer = 0;
  private pumpTimer = 0;
  private sinceShot = 0;
  private bloom = 0;
  private aimBlend = 0;
  private crouchBlend = 0;
  private tracerCount = 0;
  private reloadStage = 0;
  /** Shell-by-shell reload is in its closing pump. */
  private pumping = false;
  /** Distance from the hitscan origin forward to the muzzle for the current shot. */
  private rayBackset = 0;
  private readonly hit: HitInfo = {
    point: new THREE.Vector3(),
    normal: new THREE.Vector3(),
    distance: 0,
    surface: "ground",
    body: null,
    prop: null,
  };

  constructor(private readonly ctx: GameContext) {}

  /** True during the raise delay after a weapon switch. */
  get switching(): boolean {
    return this.switchTimer > 0;
  }

  update(dt: number): void {
    const { input, tuning } = this.ctx;
    if (tuning.infiniteAmmo >= 0.5) this.refillReserves();

    if (input.weaponSlotPressed !== null)
      this.switchTo(input.weaponSlotPressed);
    else if (input.weaponCycle !== 0) this.cycle(Math.sign(input.weaponCycle));

    this.tickTimers(dt);
    if (input.reloadPressed) this.startReload();
    if (this.reloading) this.updateReload(dt);
    this.updateFiring();
    this.updateAutoReload(dt);

    this.spread = this.computeSpread();
    this.syncPublic();
  }

  switchTo(slot: number): void {
    const next = weaponBySlot(slot);
    if (!next || next === this.current) return;
    if (this.reloading) this.endReload();
    this.select(next);
    this.switchTimer = SWITCH_TIME;
    this.ctx.events.emit("weaponSwitch", { weapon: next });
  }

  consumeShotsFired(): number {
    const n = this.shotsSinceRead;
    this.shotsSinceRead = 0;
    return n;
  }

  /**
   * Add spare ammo to every weapon: `fraction` of each weapon's reserveMax (pickups, wave bonus).
   * STUB: to be implemented by the game-mode engineer.
   */
  addAmmo(fraction: number): void {
    void fraction;
  }

  /** Refill everything and select slot 1. */
  reset(): void {
    WEAPONS.forEach((w, i) => {
      this.ammoStates[i].mag = w.magSize;
      this.ammoStates[i].reserve = w.reserveMax;
    });
    const changed = this.current !== WEAPONS[0];
    this.reloading = false;
    this.reloadProgress = 0;
    this.pumping = false;
    this.switchTimer = 0;
    this.dryFireTimer = 0;
    this.bloom = 0;
    this.tracerCount = 0;
    this.shotsSinceRead = 0;
    this.select(WEAPONS[0]);
    this.spread = this.computeSpread();
    if (changed) this.ctx.events.emit("weaponSwitch", { weapon: this.current });
  }

  private select(weapon: WeaponDef): void {
    this.current = weapon;
    this.state = this.ammoStates[WEAPONS.indexOf(weapon)];
    this.cooldown = 0;
    this.firingStreak = false;
    this.fireBuffer = 0;
    this.pumpTimer = 0;
    this.emptyTimer = 0;
    this.bloom = 0;
    this.syncPublic();
    this.ctx.player.model.setWeapon(weapon.id);
  }

  private cycle(step: number): void {
    const n = WEAPONS.length;
    const i = WEAPONS.indexOf(this.current);
    this.switchTo(WEAPONS[(((i + step) % n) + n) % n].slot);
  }

  private refillReserves(): void {
    WEAPONS.forEach((w, i) => (this.ammoStates[i].reserve = w.reserveMax));
  }

  private syncPublic(): void {
    this.ammo = this.state.mag;
    this.reserve = this.state.reserve;
  }

  private tickTimers(dt: number): void {
    const { player } = this.ctx;
    const w = this.current;
    this.switchTimer = Math.max(0, this.switchTimer - dt);
    this.dryFireTimer -= dt;
    this.fireBuffer -= dt;
    this.cooldown -= dt;
    this.sinceShot += dt;
    if (this.pumpTimer > 0) {
      this.pumpTimer -= dt;
      if (this.pumpTimer <= 0) this.pumpSlide();
    }
    const k = 1 - Math.exp(-STANCE_BLEND * dt);
    this.aimBlend += ((player.aiming ? 1 : 0) - this.aimBlend) * k;
    this.crouchBlend += ((player.crouched ? 1 : 0) - this.crouchBlend) * k;
    if (this.sinceShot > BLOOM_RECOVERY_DELAY) {
      this.bloom = Math.max(0, this.bloom - w.bloomRecovery * dt);
    }
  }

  private computeSpread(): number {
    const { player, tuning } = this.ctx;
    const w = this.current;
    const base = w.spreadHip + (w.spreadAim - w.spreadHip) * this.aimBlend;
    const speed = Math.hypot(player.velocity.x, player.velocity.z);
    const move =
      w.spreadMoveAdd *
      Math.min(speed / Math.max(0.1, tuning.runSpeed), MAX_MOVE_SPREAD);
    const crouch = 1 + (w.crouchMul - 1) * this.crouchBlend;
    return (base + move + this.bloom) * crouch * tuning.spreadMul;
  }

  private interval(w: WeaponDef): number {
    return 60 / (w.fireRate * Math.max(0.05, this.ctx.tuning.fireRateMul));
  }

  // --- Firing ---------------------------------------------------------------------------------

  private updateFiring(): void {
    const { input, player, tuning } = this.ctx;
    const w = this.current;
    if (input.firePressed) {
      // A press during sprint-to-fire still lands once the weapon comes up.
      this.fireBuffer =
        FIRE_BUFFER + (player.canFire() ? 0 : tuning.sprintToFireDelay);
    }
    const wants = this.fireBuffer > 0 || (w.auto && input.fireHeld);
    const fired = wants && this.tryFire(w);
    // A ready weapon that did not fire ends the streak: idle time never becomes burst credit.
    if (!fired && this.cooldown <= 0) {
      this.cooldown = 0;
      this.firingStreak = false;
    }
  }

  /** Fires as many rounds as the cooldown allows this frame. Returns true if any fired. */
  private tryFire(w: WeaponDef): boolean {
    if (this.switchTimer > 0 || this.cooldown > 0 || !this.ctx.player.canFire())
      return false;
    if (this.reloading) {
      // Shell-by-shell reloads can be interrupted as soon as there is a round to fire.
      if (!w.reloadPerShell || this.state.mag === 0) return false;
      this.endReload();
    }
    if (this.state.mag === 0) {
      this.onEmptyTrigger();
      return false;
    }
    const interval = this.interval(w);
    // The first round of a burst starts the clock fresh (no credit for the frame it was pressed in).
    if (!this.firingStreak) this.cooldown = 0;
    this.firingStreak = true;
    let shots = 0;
    while (
      this.cooldown <= 0 &&
      this.state.mag > 0 &&
      shots < MAX_SHOTS_PER_FRAME
    ) {
      this.fireRound(w);
      this.cooldown += interval;
      shots++;
      if (!w.auto) break;
    }
    this.fireBuffer = 0;
    return true;
  }

  private onEmptyTrigger(): void {
    this.fireBuffer = 0;
    if (this.dryFireTimer <= 0) {
      this.dryFireTimer = DRY_FIRE_INTERVAL;
      this.ctx.events.emit("dryFire", { weapon: this.current });
    }
    this.startReload();
  }

  private fireRound(w: WeaponDef): void {
    const { player, fx, events, stats, tuning, cameraRig } = this.ctx;
    player.model.getMuzzle(muzzle, barrelDir);
    this.computeAim();
    this.state.mag--;
    this.shotsSinceRead++;
    events.emit("shot", { weapon: w, origin: muzzle, dir: aimDir });

    const halfAngle = THREE.MathUtils.degToRad(this.computeSpread());
    const tracerRound = ++this.tracerCount % Math.max(1, w.tracerEvery) === 0;
    const tracers = tracerRound ? Math.min(w.pellets, MAX_PELLET_TRACERS) : 0;
    for (let i = 0; i < w.pellets; i++) {
      scatter(pelletDir, aimDir, halfAngle, w.pellets > 1);
      const distance = this.firePellet(w, pelletDir);
      // Skip the tracer when the muzzle is already inside whatever was hit.
      if (i < tracers && distance > this.rayBackset + 0.1) {
        tracerEnd.copy(rayOrigin).addScaledVector(pelletDir, distance);
        fx.tracer(muzzle, tracerEnd);
      }
    }
    stats.shots += w.pellets;

    this.bloom = Math.min(w.bloomMax, this.bloom + w.bloomPerShot);
    this.sinceShot = 0;
    fx.muzzleFlash(muzzle, aimDir, w.muzzleFlashScale);
    fx.smoke(muzzle, aimDir, SMOKE_AMOUNT[w.sound]);
    // Tube-fed pump action: the empty hull comes out when the slide is racked.
    if (w.reloadPerShell) this.pumpTimer = this.interval(w) * PUMP_AT;
    else this.ejectCasing(w);

    kickDir.set(aimDir.x, 0, aimDir.z).normalize();
    cameraRig.addKick(kickDir, w.recoilKick * tuning.recoilMul);
  }

  /**
   * Shot direction from the muzzle toward the aim point (facing when the aim point is too close),
   * and the hitscan origin: the point on that line level with the chest, so a muzzle poking
   * through cover can't shoot through it while hits still land under the crosshair.
   */
  private computeAim(): void {
    const { player } = this.ctx;
    const aim = player.aimPoint;
    const ax = aim.x - player.position.x;
    const az = aim.z - player.position.z;
    aimDir.subVectors(aim, muzzle);
    const flat = Math.hypot(aimDir.x, aimDir.z);
    if (ax * ax + az * az < MIN_AIM_DIST * MIN_AIM_DIST || flat < 1e-3) {
      aimDir.set(Math.sin(player.facing), 0, Math.cos(player.facing));
    } else {
      aimDir.y = THREE.MathUtils.clamp(
        aimDir.y,
        -MAX_PITCH * flat,
        MAX_PITCH * flat,
      );
      aimDir.normalize();
    }
    const chestToMuzzle =
      (muzzle.x - player.position.x) * aimDir.x +
      (muzzle.z - player.position.z) * aimDir.z;
    this.rayBackset = THREE.MathUtils.clamp(chestToMuzzle, 0, MAX_RAY_BACKSET);
    rayOrigin.copy(muzzle).addScaledVector(aimDir, -this.rayBackset);
  }

  /** Hitscan one pellet. Returns the distance travelled from rayOrigin. */
  private firePellet(w: WeaponDef, dir: THREE.Vector3): number {
    const { physics, world, fx, events, stats, tuning } = this.ctx;
    rayEnd.copy(rayOrigin).addScaledVector(dir, w.range);
    const ray = physics.raycast(rayOrigin, rayEnd);
    if (!ray) return w.range;

    const prop = world.propFromBody(ray.body);
    const hit = this.hit;
    hit.point.copy(ray.point);
    hit.normal.copy(ray.normal);
    hit.distance = ray.distance;
    hit.surface = prop?.surface ?? "ground";
    hit.body = ray.body;
    hit.prop = prop;

    fx.impact(hit, dir);
    if (prop) {
      world.applyBulletHit(
        prop,
        hit,
        dir,
        w.damage * tuning.damageMul,
        w.impulse * tuning.impulseMul,
      );
      stats.hits++;
    }
    events.emit("impact", { hit, dir, weapon: w });
    return ray.distance;
  }

  private ejectCasing(w: WeaponDef): void {
    const { player, fx } = this.ctx;
    player.model.getEjectionPort(ejectPos);
    // Out to the right of the shot direction, up, slightly back, plus the player's own motion.
    const flat = Math.hypot(aimDir.x, aimDir.z) || 1;
    const hx = aimDir.x / flat;
    const hz = aimDir.z / flat;
    const side = rand(1.4, 2.3);
    const back = rand(-0.5, 0.15);
    ejectVel
      .set(-hz * side + hx * back, rand(1.8, 2.8), hx * side + hz * back)
      .add(player.velocity);
    fx.shellCasing(ejectPos, ejectVel, CASING[w.id]);
  }

  private pumpSlide(): void {
    this.ctx.events.emit("reloadStage", {
      weapon: this.current,
      stage: "pump",
    });
    this.ejectCasing(this.current);
  }

  // --- Reloading ------------------------------------------------------------------------------

  private startReload(): void {
    const w = this.current;
    const s = this.state;
    if (this.reloading || this.switchTimer > 0) return;
    if (s.mag >= w.magSize || s.reserve <= 0) return;
    this.reloading = true;
    this.reloadProgress = 0;
    this.reloadStage = 0;
    this.pumping = false;
    const mul = Math.max(0.05, this.ctx.tuning.reloadSpeedMul);
    const duration = w.reloadPerShell
      ? (w.reloadTime * Math.min(w.magSize - s.mag, s.reserve) + PUMP_TIME) /
        mul
      : w.reloadTime / mul;
    this.ctx.events.emit("reloadStart", { weapon: w, duration });
  }

  private updateReload(dt: number): void {
    const w = this.current;
    const s = this.state;
    const mul = Math.max(0.05, this.ctx.tuning.reloadSpeedMul);
    if (w.reloadPerShell) {
      this.updateShellReload(dt * mul, w, s);
      return;
    }
    this.reloadProgress += (dt * mul) / w.reloadTime;
    while (
      this.reloadStage < MAG_STAGES.length &&
      this.reloadProgress >= MAG_STAGES[this.reloadStage][0]
    ) {
      this.ctx.events.emit("reloadStage", {
        weapon: w,
        stage: MAG_STAGES[this.reloadStage][1],
      });
      this.reloadStage++;
    }
    if (this.reloadProgress < 1) return;
    const take = Math.min(w.magSize - s.mag, s.reserve);
    s.mag += take;
    s.reserve -= take;
    this.endReload();
  }

  /** One shell per `reloadTime`, then a closing pump. `work` = scaled seconds this frame. */
  private updateShellReload(work: number, w: WeaponDef, s: AmmoState): void {
    this.reloadProgress += work / (this.pumping ? PUMP_TIME : w.reloadTime);
    if (this.reloadProgress < 1) return;
    if (this.pumping) {
      this.endReload();
      return;
    }
    s.mag++;
    s.reserve--;
    this.ctx.events.emit("reloadStage", { weapon: w, stage: "shell" });
    if (s.mag < w.magSize && s.reserve > 0) {
      this.reloadProgress -= 1;
      return;
    }
    this.pumping = true;
    this.reloadProgress = 0;
    this.ctx.events.emit("reloadStage", { weapon: w, stage: "pump" });
  }

  /** Ends the reload, finished or interrupted (switch / shotgun fire); always emits reloadEnd. */
  private endReload(): void {
    this.reloading = false;
    this.reloadProgress = 0;
    this.pumping = false;
    this.ctx.events.emit("reloadEnd", { weapon: this.current });
  }

  private updateAutoReload(dt: number): void {
    if (this.state.mag > 0 || this.reloading || this.switchTimer > 0) {
      this.emptyTimer = 0;
      return;
    }
    this.emptyTimer += dt;
    if (this.emptyTimer >= AUTO_RELOAD_DELAY) this.startReload();
  }
}
