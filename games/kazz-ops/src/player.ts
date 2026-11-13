import * as THREE from "three";
import * as CANNON from "cannon-es";
import { CharacterModel } from "./character";
import { GROUP } from "./physics";
import type { CharacterAnimState, GameContext, MoveState, OrientedBox, Prop } from "./types";

// Body: two stacked spheres, origin at the feet. Crouching lowers the head sphere.
const RADIUS = 0.35;
const FOOT_SPHERE_Y = 0.35;
const HEAD_SPHERE_Y = 1.05;
const HEAD_SPHERE_LOW_Y = 0.7;
const MASS = 80;

const MOVE_DEADZONE = 0.12;
const REVERSE_BOOST = 1.4;
const SLIDE_MIN_SPEED = 4;
const SLIDE_STEER_RATE = 2.2;
const SLIDE_DECAY_POWER = 1.5;

const AIM_HEIGHT = 1.0;
const AIM_RANGE = 9;
const AIM_RAY_LENGTH = 250;
const AIM_STICK_DEADZONE = 0.15;
const MIN_AIM_TURN_DIST = 0.6;

const VAULT_LANDING_GAP = 0.6;
/** Legs tuck up during the vault, so the feet (body origin) peak this much below the clearance. */
const VAULT_TUCK = 0.5;
/** Easing strength: fast take-off, a short hang over the top, quick landing. */
const VAULT_HANG = 0.35;
const VAULT_MIN_HOP = 0.15;
const VAULT_CLEARANCE = 0.35;
const VAULT_MAX_LANDING_Y = 0.3;
const VAULT_LOW_RAY_Y = 0.4;

const KNOCK_RANGE = 2.4; // × explosion radius
const KNOCK_SPEED = 11;
const KNOCK_LIFT = 2.6;
const KNOCK_MAX = 14;
const KNOCK_DECAY = 3.5;

const FALL_RESET_Y = -5;
const GROUNDED_MAX_VY = 1.5;
const STEP_PRECHARGE = 0.5;
const LANDING_STEP = 0.9;
const STEP_INTENSITY: Partial<Record<MoveState, number>> = {
  crouchWalk: 0.3,
  walk: 0.5,
  run: 0.8,
  tactical: 1,
};

const TWO_PI = Math.PI * 2;

const _desired = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _arcPos = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const _ray = new THREE.Ray();
const _aimPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -AIM_HEIGHT);

function wrapAngle(a: number): number {
  return a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
}

/** Result of the last footprint ray test. */
const _slab = { enter: 0, exit: 0, axis: 0, sign: 1 };

function clipSlab(origin: number, dir: number, half: number, axis: number): boolean {
  if (Math.abs(dir) < 1e-6) return Math.abs(origin) <= half;
  const a = (-half - origin) / dir;
  const b = (half - origin) / dir;
  const t0 = Math.min(a, b);
  if (t0 > _slab.enter) {
    _slab.enter = t0;
    _slab.axis = axis;
    _slab.sign = dir > 0 ? 1 : -1;
  }
  _slab.exit = Math.min(_slab.exit, Math.max(a, b));
  return _slab.enter <= _slab.exit;
}

/** 2D ray (XZ) against an oriented box footprint. Fills _slab; false on a miss. */
function rayFootprint(ox: number, oz: number, dx: number, dz: number, box: OrientedBox): boolean {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const rx = ox - box.center.x;
  const rz = oz - box.center.z;
  _slab.enter = -Infinity;
  _slab.exit = Infinity;
  return (
    clipSlab(rx * c - rz * s, dx * c - dz * s, box.halfExtents.x, 0) &&
    clipSlab(rx * s + rz * c, dx * s + dz * c, box.halfExtents.z, 1)
  );
}

function insideFootprint(p: THREE.Vector3, box: OrientedBox, inflate: number): boolean {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  const rx = p.x - box.center.x;
  const rz = p.z - box.center.z;
  return (
    Math.abs(rx * c - rz * s) <= box.halfExtents.x + inflate &&
    Math.abs(rx * s + rz * c) <= box.halfExtents.z + inflate
  );
}

/** World direction of the box face the last ray entered through, pointing into the box. */
function entryAxis(box: OrientedBox, out: THREE.Vector3): THREE.Vector3 {
  const c = Math.cos(box.yaw);
  const s = Math.sin(box.yaw);
  return _slab.axis === 0
    ? out.set(c * _slab.sign, 0, -s * _slab.sign)
    : out.set(s * _slab.sign, 0, c * _slab.sign);
}

interface VaultPlan {
  dir: THREE.Vector3;
  landing: THREE.Vector3;
  top: number;
}

/**
 * Find low cover within reach along `dir` and a free landing spot behind it.
 * On success fills `plan` (dir is snapped across the obstacle's face).
 */
function planVault(ctx: GameContext, origin: THREE.Vector3, dir: THREE.Vector3, plan: VaultPlan): boolean {
  const { tuning, world } = ctx;
  let best: OrientedBox | null = null;
  let bestProp: Prop | null = null;
  let bestEnter = Infinity;
  for (const prop of world.props) {
    const box = prop.bounds;
    if (!box || !prop.vaultable || !prop.alive) continue;
    if (box.halfExtents.y * 2 > tuning.vaultMaxHeight) continue;
    if (!rayFootprint(origin.x, origin.z, dir.x, dir.z, box)) continue;
    if (_slab.enter < -0.05 || _slab.enter > tuning.vaultReach || _slab.enter >= bestEnter) continue;
    best = box;
    bestProp = prop;
    bestEnter = _slab.enter;
  }
  if (!best || !bestProp) return false;

  // Vault straight across the face we approached, unless that line misses the box (near its end).
  rayFootprint(origin.x, origin.z, dir.x, dir.z, best);
  entryAxis(best, plan.dir);
  if (!rayFootprint(origin.x, origin.z, plan.dir.x, plan.dir.z, best) || _slab.enter < -0.05) {
    plan.dir.copy(dir);
    rayFootprint(origin.x, origin.z, dir.x, dir.z, best);
  }
  const exit = _slab.exit;
  plan.top = best.center.y + best.halfExtents.y;
  plan.landing.copy(origin).addScaledVector(plan.dir, exit + VAULT_LANDING_GAP);
  return landingClear(ctx, bestProp, origin, exit, plan);
}

function landingClear(ctx: GameContext, vaulted: Prop, origin: THREE.Vector3, exit: number, plan: VaultPlan): boolean {
  const { physics, world } = ctx;
  const { dir, landing, top } = plan;
  for (const prop of world.props) {
    if (prop !== vaulted && prop.alive && prop.bounds && insideFootprint(landing, prop.bounds, RADIUS)) {
      return false;
    }
  }
  // Nothing above the cover (a wall behind it, a barrel on top).
  _from.set(origin.x, top + VAULT_CLEARANCE, origin.z);
  _to.copy(landing).addScaledVector(dir, RADIUS);
  _to.y = _from.y;
  if (physics.raycast(_from, _to)) return false;
  // Nothing low right behind it.
  _from.copy(origin).addScaledVector(dir, exit + 0.02);
  _from.y = VAULT_LOW_RAY_Y;
  _to.y = VAULT_LOW_RAY_Y;
  if (physics.raycast(_from, _to)) return false;
  // Something to stand on at the landing spot.
  _from.set(landing.x, top + VAULT_CLEARANCE, landing.z);
  _to.set(landing.x, -0.5, landing.z);
  const floor = physics.raycast(_from, _to);
  if (floor && floor.point.y > VAULT_MAX_LANDING_Y) return false;
  landing.y = floor ? Math.max(0, floor.point.y) : 0;
  return true;
}

/** Kinematic hop from `from` to `to` peaking at `peakY`. */
class VaultArc {
  readonly from = new THREE.Vector3();
  readonly to = new THREE.Vector3();
  readonly dir = new THREE.Vector3();
  private duration = 0.5;
  private elapsed = 0;
  private bump = 0;

  begin(from: CANNON.Vec3, to: THREE.Vector3, dir: THREE.Vector3, peakY: number, duration: number): void {
    this.from.set(from.x, from.y, from.z);
    this.to.copy(to);
    this.dir.copy(dir);
    this.duration = Math.max(0.05, duration);
    this.elapsed = 0;
    const lowMid = (this.from.y + to.y) / 2;
    this.bump = Math.max(peakY, Math.max(this.from.y, to.y) + VAULT_MIN_HOP) - lowMid;
  }

  advance(dt: number): void {
    this.elapsed += dt;
  }

  get progress(): number {
    return Math.min(1, this.elapsed / this.duration);
  }

  get done(): boolean {
    return this.elapsed >= this.duration;
  }

  /** Average horizontal speed over the hop. */
  get speed(): number {
    return Math.hypot(this.to.x - this.from.x, this.to.z - this.from.z) / this.duration;
  }

  /** Horizontal speed at landing (the easing ends fast so the run carries on). */
  get exitSpeed(): number {
    return (1 + VAULT_HANG) * this.speed;
  }

  sample(out: THREE.Vector3): THREE.Vector3 {
    const p = this.progress;
    const s = p + (VAULT_HANG * Math.sin(TWO_PI * p)) / TWO_PI;
    out.lerpVectors(this.from, this.to, s);
    out.y += this.bump * 4 * p * (1 - p);
    return out;
  }
}

/**
 * Player controller: movement states (walk/run/tactical/crouch/slide/vault), stamina, aiming,
 * physics body that pushes props, and driving the CharacterModel.
 */
export class Player {
  readonly model = new CharacterModel();
  readonly body: CANNON.Body;
  /** Feet position (y = 0 on flat ground). Updated in postPhysics. */
  readonly position = new THREE.Vector3();
  /** Horizontal velocity (m/s). */
  readonly velocity = new THREE.Vector3();
  /** Where the player is aiming, in world space (what the crosshair points at). */
  readonly aimPoint = new THREE.Vector3(0, 1, -10);
  /** Facing yaw (radians), forward = (sin, 0, cos). */
  facing = Math.PI;
  state: MoveState = "idle";
  stamina = 100;
  readonly maxHealth = 100;
  health = 100;
  /** True after health reached 0 until the next reset (F9 / restart). */
  dead = false;
  /** True after stamina hit 0 until it recovers past tuning.staminaRecoverThreshold. */
  exhausted = false;
  crouched = false;
  aiming = false;
  /** 0..1 while sliding, else 0. */
  slideProgress = 0;
  /** 0..1 while vaulting, else 0. */
  vaultProgress = 0;

  private readonly spawn = new THREE.Vector3();
  private spawnYaw = Math.PI;
  /** Camera-relative move intent in world space (unit or zero) and its strength 0..1. */
  private readonly wishDir = new THREE.Vector3();
  private wishMag = 0;
  /** Velocity the controller drives (horizontal), without explosion knockback. */
  private readonly moveVel = new THREE.Vector3();
  private readonly knock = new THREE.Vector3();
  private tactical = false;
  /** Seconds since the weapon was last lowered (tactical sprint / vault). */
  private loweredTimer = Infinity;
  /** Seconds since stamina was last spent. */
  private staminaRest = 0;
  private lowProfile = false;
  private prevRunHeld = false;
  private stepDistance = STEP_PRECHARGE;
  private readonly slideDir = new THREE.Vector3();
  private slideTime = 0;
  private readonly arc = new VaultArc();
  private readonly plan: VaultPlan = {
    dir: new THREE.Vector3(),
    landing: new THREE.Vector3(),
    top: 0,
  };
  private readonly eventPos = new THREE.Vector3();
  private readonly anim: CharacterAnimState = {
    state: "idle",
    speed: 0,
    moveLocal: new THREE.Vector2(),
    aiming: false,
    crouched: false,
    reloading: false,
    reloadProgress: 0,
    weaponId: "carbine",
    shotsFired: 0,
    vaultProgress: 0,
    slideProgress: 0,
    weaponLowered: false,
  };
  private readonly offExplosion: () => void;

  constructor(private readonly ctx: GameContext) {
    const body = new CANNON.Body({
      mass: MASS,
      fixedRotation: true,
      linearDamping: 0,
      allowSleep: false,
      material: ctx.physics.materials.player,
      collisionFilterGroup: GROUP.PLAYER,
      collisionFilterMask: GROUP.GROUND | GROUP.STATIC | GROUP.DYNAMIC,
    });
    body.addShape(new CANNON.Sphere(RADIUS), new CANNON.Vec3(0, FOOT_SPHERE_Y, 0));
    body.addShape(new CANNON.Sphere(RADIUS), new CANNON.Vec3(0, HEAD_SPHERE_Y, 0));
    this.body = body;
    ctx.physics.addBody(body);
    ctx.scene.add(this.model.root);

    this.offExplosion = ctx.events.on("explosion", ({ position, radius }) =>
      this.onExplosion(position, radius),
    );
  }

  /** Can the weapon fire this frame? (false while sprinting, vaulting, or in sprint-to-fire delay) */
  canFire(): boolean {
    return (
      this.state !== "tactical" &&
      this.state !== "vault" &&
      this.loweredTimer >= this.ctx.tuning.sprintToFireDelay
    );
  }

  /** Read input, choose state, set body velocity, handle vault/slide/crouch. Before physics. */
  update(dt: number): void {
    if (dt <= 0) return;
    this.keepInWorld();
    this.readMoveIntent();

    if (this.state === "vault") {
      this.stepVault(dt);
    } else {
      this.syncMoveVelocity(dt);
      if (!this.handleActions()) {
        this.chooseState(dt);
        this.applyMovement(dt);
      }
    }

    const lowered = this.state === "tactical" || this.state === "vault";
    this.loweredTimer = lowered ? 0 : this.loweredTimer + dt;
    if (this.state === "vault") this.aiming = false;
    this.updateStamina(dt);
    this.setLowProfile(this.crouched && this.state !== "vault");
    this.updateAim();
    this.updateFacing(dt);
    this.prevRunHeld = this.ctx.input.runHeld;
  }

  /** After physics: copy body -> position, pose and animate the model. */
  postPhysics(dt: number): void {
    const body = this.body;
    if (this.state === "vault") {
      this.position.set(body.position.x, body.position.y, body.position.z);
      this.velocity.copy(this.arc.dir).multiplyScalar(this.arc.speed);
    } else {
      const p = body.interpolatedPosition;
      this.position.set(p.x, p.y, p.z);
      this.velocity.set(body.velocity.x, 0, body.velocity.z);
    }
    this.updateFootsteps(dt);

    this.model.root.position.copy(this.position);
    this.model.root.rotation.y = this.facing;
    this.model.update(dt, this.buildAnimState());
  }

  /** Take damage from something at `from` (zombie swipe, explosion). Emits playerHurt/playerDied. */
  damage(amount: number, from: THREE.Vector3): void {
    if (this.dead || amount <= 0) return;
    this.health = Math.max(0, this.health - amount);
    this.ctx.events.emit("playerHurt", { amount, health: this.health, from });
    if (this.health <= 0) {
      this.dead = true;
      this.ctx.events.emit("playerDied", {
        wave: this.ctx.zombies.wave,
        kills: this.ctx.stats.kills,
      });
    }
  }

  heal(amount: number): void {
    if (!this.dead) this.health = Math.min(this.maxHealth, this.health + amount);
  }

  reset(spawn: THREE.Vector3, yaw: number): void {
    this.health = this.maxHealth;
    this.dead = false;
    this.spawn.copy(spawn);
    this.spawnYaw = yaw;
    const body = this.body;
    body.type = CANNON.Body.DYNAMIC;
    body.collisionResponse = true;
    body.position.set(spawn.x, spawn.y, spawn.z);
    body.previousPosition.copy(body.position);
    body.interpolatedPosition.copy(body.position);
    body.velocity.setZero();
    body.force.setZero();

    this.position.copy(spawn);
    this.velocity.set(0, 0, 0);
    this.moveVel.set(0, 0, 0);
    this.knock.set(0, 0, 0);
    this.facing = yaw;
    this.state = "idle";
    this.stamina = this.ctx.tuning.staminaMax;
    this.staminaRest = Infinity;
    this.exhausted = false;
    this.crouched = false;
    this.aiming = false;
    this.tactical = false;
    this.loweredTimer = Infinity;
    this.slideTime = 0;
    this.slideProgress = 0;
    this.vaultProgress = 0;
    this.stepDistance = STEP_PRECHARGE;
    this.setLowProfile(false);
    this.aimAlong(_dir.set(Math.sin(yaw), 0, Math.cos(yaw)));

    this.model.root.position.copy(spawn);
    this.model.root.rotation.y = yaw;
  }

  dispose(): void {
    this.offExplosion();
    this.ctx.physics.removeBody(this.body);
    this.ctx.scene.remove(this.model.root);
    this.model.dispose();
  }

  private canSprint(): boolean {
    return !this.exhausted && this.stamina > 0;
  }

  /** Safety net: fell through the floor or the simulation blew up. */
  private keepInWorld(): void {
    const p = this.body.position;
    const v = this.body.velocity;
    if (p.y < FALL_RESET_Y || !Number.isFinite(p.x + p.y + p.z + v.x + v.y + v.z)) {
      this.reset(this.spawn, this.spawnYaw);
    }
  }

  private readMoveIntent(): void {
    const move = this.ctx.input.move;
    this.wishMag = Math.min(1, move.length());
    this.cameraRelative(move.x, move.y, this.wishDir);
  }

  /** Rotate a screen-space vector (x right, y up) by the camera yaw into a world unit vector. */
  private cameraRelative(x: number, y: number, out: THREE.Vector3): THREE.Vector3 {
    const yaw = this.ctx.cameraRig.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    // forward = (-sin, 0, -cos), right = (cos, 0, -sin)
    return out.set(x * cos - y * sin, 0, -x * sin - y * cos).normalize();
  }

  /** Contacts (walls, heavy props) change the body velocity; continue from what physics left. */
  private syncMoveVelocity(dt: number): void {
    const v = this.body.velocity;
    this.moveVel.set(v.x - this.knock.x, 0, v.z - this.knock.z);
    this.knock.multiplyScalar(Math.exp(-KNOCK_DECAY * dt));
    if (this.knock.lengthSq() < 1e-4) this.knock.set(0, 0, 0);
  }

  /** Edge-triggered actions. Returns true when a vault started (it owns the body from now). */
  private handleActions(): boolean {
    const input = this.ctx.input;
    if (input.vaultPressed && this.tryVault()) return true;
    if (input.crouchPressed) this.onCrouchPressed();
    if (
      input.tacticalPressed &&
      this.wishMag > MOVE_DEADZONE &&
      this.canSprint() &&
      !input.aimHeld &&
      this.state !== "slide"
    ) {
      this.setCrouched(false);
      this.tactical = true;
      this.ctx.events.emit("tacticalStart", {});
    }
    return false;
  }

  private onCrouchPressed(): void {
    if (this.state === "slide") {
      // Cancel the slide and stand up.
      this.slideTime = 0;
      this.slideProgress = 0;
      this.state = "walk";
      this.setCrouched(false);
      return;
    }
    const speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    const fast = this.state === "run" || this.state === "tactical";
    if (fast && speed > SLIDE_MIN_SPEED && this.stamina >= this.ctx.tuning.staminaSlideCost) {
      this.startSlide(speed);
      return;
    }
    this.tactical = false;
    this.setCrouched(!this.crouched);
  }

  private startSlide(speed: number): void {
    const v = this.body.velocity;
    this.slideDir.set(v.x / speed, 0, v.z / speed);
    this.tactical = false;
    this.spendStamina(this.ctx.tuning.staminaSlideCost);
    // Ends crouched; the slide event covers the sound, so no crouch event here.
    this.crouched = true;
    this.state = "slide";
    this.slideTime = 0;
    this.ctx.events.emit("slide", { position: this.eventPos.copy(this.position) });
  }

  private setCrouched(crouched: boolean): void {
    if (this.crouched === crouched) return;
    this.crouched = crouched;
    this.ctx.events.emit("crouch", { crouched });
  }

  private chooseState(dt: number): void {
    const input = this.ctx.input;
    const moving = this.wishMag > MOVE_DEADZONE;

    if (this.state === "slide") {
      this.slideTime += dt;
      if (this.slideTime < this.ctx.tuning.slideDuration) {
        this.aiming = input.aimHeld;
        return;
      }
      this.slideTime = 0;
      this.slideProgress = 0;
    }

    if (
      this.tactical &&
      (!moving || !this.canSprint() || input.aimHeld || input.fireHeld || input.firePressed)
    ) {
      this.tactical = false;
    }
    // A fresh Shift press stands up from a crouch.
    if (this.crouched && moving && input.runHeld && !this.prevRunHeld && this.canSprint()) {
      this.setCrouched(false);
    }

    this.aiming = input.aimHeld && !this.tactical;
    if (this.tactical) this.state = "tactical";
    else if (this.crouched) this.state = moving ? "crouchWalk" : "crouch";
    else if (!moving) this.state = "idle";
    else this.state = input.runHeld && !this.aiming && this.canSprint() ? "run" : "walk";
  }

  private targetSpeed(): number {
    const t = this.ctx.tuning;
    let speed = 0;
    if (this.state === "tactical") speed = t.tacticalSpeed;
    else if (this.state === "run") speed = t.runSpeed;
    else if (this.state === "walk") speed = t.walkSpeed * this.wishMag;
    else if (this.state === "crouchWalk") speed = t.crouchSpeed * this.wishMag;
    return this.aiming ? speed * t.aimSpeedMul : speed;
  }

  private applyMovement(dt: number): void {
    const t = this.ctx.tuning;
    if (this.state === "slide") {
      this.steerSlide(dt);
      const p = Math.min(1, this.slideTime / Math.max(0.05, t.slideDuration));
      const speed = t.crouchSpeed + (t.slideSpeed - t.crouchSpeed) * Math.pow(1 - p, SLIDE_DECAY_POWER);
      this.moveVel.copy(this.slideDir).multiplyScalar(speed);
      this.slideProgress = p;
    } else {
      const speed = this.targetSpeed();
      const desired = _desired.copy(this.wishDir).multiplyScalar(speed);
      let rate = speed >= this.moveVel.length() ? t.acceleration : t.deceleration;
      if (this.moveVel.dot(desired) < 0) rate *= REVERSE_BOOST;
      const delta = _delta.subVectors(desired, this.moveVel);
      const gap = delta.length();
      const step = rate * dt;
      if (gap <= step) this.moveVel.copy(desired);
      else this.moveVel.addScaledVector(delta, step / gap);
    }
    this.body.velocity.x = this.moveVel.x + this.knock.x;
    this.body.velocity.z = this.moveVel.z + this.knock.z;
  }

  /** Let the stick bend the slide a little (never reverse it). */
  private steerSlide(dt: number): void {
    if (this.wishMag <= MOVE_DEADZONE) return;
    const current = Math.atan2(this.slideDir.x, this.slideDir.z);
    const diff = wrapAngle(Math.atan2(this.wishDir.x, this.wishDir.z) - current);
    if (Math.abs(diff) > Math.PI / 2) return;
    const maxTurn = SLIDE_STEER_RATE * dt;
    const angle = current + Math.max(-maxTurn, Math.min(maxTurn, diff));
    this.slideDir.set(Math.sin(angle), 0, Math.cos(angle));
  }

  private tryVault(): boolean {
    const t = this.ctx.tuning;
    if (this.stamina < t.staminaVaultCost) return false;
    const dir =
      this.wishMag > MOVE_DEADZONE
        ? _dir.copy(this.wishDir)
        : _dir.set(Math.sin(this.facing), 0, Math.cos(this.facing));
    const body = this.body;
    _origin.set(body.position.x, body.position.y, body.position.z);
    if (!planVault(this.ctx, _origin, dir, this.plan)) return false;

    this.tactical = false;
    this.slideTime = 0;
    this.slideProgress = 0;
    this.setCrouched(false);
    this.spendStamina(t.staminaVaultCost);

    body.type = CANNON.Body.KINEMATIC;
    body.collisionResponse = false;
    body.velocity.setZero();
    this.knock.set(0, 0, 0);
    const peak = this.plan.top + t.vaultArc - VAULT_TUCK;
    this.arc.begin(body.position, this.plan.landing, this.plan.dir, peak, t.vaultDuration);
    this.state = "vault";
    this.vaultProgress = 0;
    this.ctx.events.emit("vault", { position: this.eventPos.copy(this.position) });
    return true;
  }

  private stepVault(dt: number): void {
    const arc = this.arc;
    arc.advance(dt);
    const p = arc.sample(_arcPos);
    const body = this.body;
    body.position.set(p.x, p.y, p.z);
    body.previousPosition.copy(body.position);
    body.interpolatedPosition.copy(body.position);
    this.vaultProgress = arc.progress;
    if (arc.done) this.finishVault();
  }

  private finishVault(): void {
    const t = this.ctx.tuning;
    const body = this.body;
    body.type = CANNON.Body.DYNAMIC;
    body.collisionResponse = true;
    const exit = Math.min(t.runSpeed, Math.max(t.walkSpeed, this.arc.exitSpeed));
    this.moveVel.copy(this.arc.dir).multiplyScalar(exit);
    body.velocity.set(this.moveVel.x, 0, this.moveVel.z);
    body.wakeUp();
    this.state = this.wishMag > MOVE_DEADZONE ? "walk" : "idle";
    this.vaultProgress = 0;
    this.stepDistance = STEP_PRECHARGE;
    this.ctx.events.emit("footstep", {
      position: this.eventPos.copy(this.arc.to),
      intensity: LANDING_STEP,
    });
  }

  private updateStamina(dt: number): void {
    const t = this.ctx.tuning;
    const drain =
      this.state === "run" ? t.staminaRunDrain : this.state === "tactical" ? t.staminaTacticalDrain : 0;
    if (drain > 0) {
      this.spendStamina(drain * dt);
    } else {
      this.staminaRest += dt;
      if (this.staminaRest >= t.staminaRegenDelay) this.stamina += t.staminaRegen * dt;
    }
    this.stamina = Math.min(this.stamina, t.staminaMax);
    if (this.exhausted && this.stamina >= Math.min(t.staminaRecoverThreshold, t.staminaMax)) {
      this.exhausted = false;
    }
  }

  private spendStamina(amount: number): void {
    this.stamina = Math.max(0, this.stamina - amount);
    this.staminaRest = 0;
    if (this.stamina <= 0 && !this.exhausted) {
      this.exhausted = true;
      this.tactical = false;
      this.ctx.events.emit("staminaExhausted", {});
    }
  }

  private setLowProfile(low: boolean): void {
    if (low === this.lowProfile) return;
    this.lowProfile = low;
    const body = this.body;
    body.shapeOffsets[1].y = low ? HEAD_SPHERE_LOW_Y : HEAD_SPHERE_Y;
    body.updateBoundingRadius();
    body.updateMassProperties();
    body.aabbNeedsUpdate = true;
  }

  private updateAim(): void {
    const input = this.ctx.input;
    if (input.usingTouch) {
      const stick = input.aimStick;
      if (stick && stick.lengthSq() > AIM_STICK_DEADZONE * AIM_STICK_DEADZONE) {
        this.aimAlong(this.cameraRelative(stick.x, stick.y, _dir));
      } else if (this.wishMag > MOVE_DEADZONE) {
        this.aimAlong(this.wishDir);
      } else {
        this.aimAlong(_dir.set(Math.sin(this.facing), 0, Math.cos(this.facing)));
      }
    } else if (input.pointerActive) {
      this.aimAtPointer();
    } else {
      this.aimAlong(_dir.set(Math.sin(this.facing), 0, Math.cos(this.facing)));
    }
  }

  private aimAlong(dir: THREE.Vector3): void {
    this.aimPoint.set(
      this.position.x + dir.x * AIM_RANGE,
      AIM_HEIGHT,
      this.position.z + dir.z * AIM_RANGE,
    );
  }

  /** Whatever prop is under the cursor, else the cursor's point on the plane y = AIM_HEIGHT. */
  private aimAtPointer(): void {
    const { cameraRig, input, physics } = this.ctx;
    const ray = cameraRig.getRay(input.pointerNdc, _ray);
    _to.copy(ray.direction).multiplyScalar(AIM_RAY_LENGTH).add(ray.origin);
    const hit = physics.raycast(ray.origin, _to);
    if (hit && hit.body !== physics.groundBody) {
      this.aimPoint.copy(hit.point);
    } else if (!ray.intersectPlane(_aimPlane, this.aimPoint)) {
      this.aimAlong(_dir.set(Math.sin(this.facing), 0, Math.cos(this.facing)));
    }
  }

  private updateFacing(dt: number): void {
    let target = this.facing;
    if (this.state === "slide") {
      target = Math.atan2(this.slideDir.x, this.slideDir.z);
    } else if (this.state === "vault") {
      target = Math.atan2(this.arc.dir.x, this.arc.dir.z);
    } else if (this.state === "tactical") {
      const v = this.moveVel.lengthSq() > 0.25 ? this.moveVel : this.wishDir;
      target = Math.atan2(v.x, v.z);
    } else {
      const dx = this.aimPoint.x - this.position.x;
      const dz = this.aimPoint.z - this.position.z;
      if (dx * dx + dz * dz > MIN_AIM_TURN_DIST * MIN_AIM_TURN_DIST) target = Math.atan2(dx, dz);
    }
    const k = 1 - Math.exp(-this.ctx.tuning.turnRate * dt);
    this.facing = wrapAngle(this.facing + wrapAngle(target - this.facing) * k);
  }

  private updateFootsteps(dt: number): void {
    const intensity = STEP_INTENSITY[this.state];
    const speed = this.velocity.length();
    const grounded = Math.abs(this.body.velocity.y) < GROUNDED_MAX_VY;
    if (!intensity || !grounded || speed < 0.3) {
      this.stepDistance = STEP_PRECHARGE;
      return;
    }
    const stride = 0.45 + 0.13 * speed;
    this.stepDistance += speed * dt;
    if (this.stepDistance < stride) return;
    this.stepDistance -= stride;
    this.ctx.events.emit("footstep", {
      position: this.eventPos.copy(this.position),
      intensity,
    });
  }

  private buildAnimState(): CharacterAnimState {
    const { tuning, weapons } = this.ctx;
    const anim = this.anim;
    const vx = this.velocity.x;
    const vz = this.velocity.z;
    const sin = Math.sin(this.facing);
    const cos = Math.cos(this.facing);
    const run = Math.max(0.1, tuning.runSpeed);
    // The model's right is (-cos, 0, sin) for forward (sin, 0, cos).
    anim.moveLocal.set((-vx * cos + vz * sin) / run, (vx * sin + vz * cos) / run);
    if (anim.moveLocal.lengthSq() > 1) anim.moveLocal.normalize();

    anim.state = this.state;
    anim.speed = Math.hypot(vx, vz);
    anim.aiming = this.aiming;
    anim.crouched = this.crouched;
    anim.reloading = weapons.reloading;
    anim.reloadProgress = weapons.reloadProgress;
    anim.weaponId = weapons.current.id;
    anim.shotsFired = weapons.consumeShotsFired();
    anim.vaultProgress = this.vaultProgress;
    anim.slideProgress = this.slideProgress;
    anim.weaponLowered = !this.canFire();
    return anim;
  }

  private onExplosion(position: THREE.Vector3, radius: number): void {
    if (this.state === "vault") return;
    const dx = this.position.x - position.x;
    const dz = this.position.z - position.z;
    const d = Math.hypot(dx, dz);
    const range = Math.max(0.5, radius * KNOCK_RANGE);
    if (d >= range) return;
    const force = (1 - d / range) * this.ctx.tuning.explosionForce;
    const push = KNOCK_SPEED * force;
    const kx = this.knock.x;
    const kz = this.knock.z;
    if (d > 1e-3) this.knock.set(kx + (dx / d) * push, 0, kz + (dz / d) * push);
    else this.knock.set(kx - Math.sin(this.facing) * push, 0, kz - Math.cos(this.facing) * push);
    this.knock.clampLength(0, KNOCK_MAX);
    // Apply the change to the body too, so the next velocity sync keeps the controller's part intact.
    const v = this.body.velocity;
    v.x += this.knock.x - kx;
    v.z += this.knock.z - kz;
    v.y = Math.max(v.y, KNOCK_LIFT * force);
  }
}
