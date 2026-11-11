import * as THREE from "three";
import type { GameContext } from "./types";

interface CameraMode {
  name: string;
  /** Angle below the horizon (radians). */
  pitch: number;
  /** Distance from the focus point (metres, before camDistanceMul). */
  distance: number;
  /** Focus shift ahead of the player as a fraction of distance (keeps the soldier below centre). */
  lead: number;
  /** CLOSE mode: yaw slowly follows the player's facing. */
  followYaw: boolean;
}

const DEG = Math.PI / 180;

const MODES: readonly CameraMode[] = [
  { name: "TOP-DOWN", pitch: 72 * DEG, distance: 24, lead: 0.065, followYaw: false },
  { name: "TACTICAL", pitch: 56 * DEG, distance: 17, lead: 0.075, followYaw: false },
  { name: "CLOSE", pitch: 42 * DEG, distance: 10, lead: 0.08, followYaw: true },
];

/** Mode blend rate: ~95 % of the way in 0.4 s. */
const BLEND_RATE = 7.5;
/** The camera looks at the soldier's waist, not his feet. */
const FOCUS_HEIGHT = 0.9;
const LOOK_RATE = 5;
const LOOK_MAX = 8;
const AIM_LOOK_MUL = 2.2;
/** Portrait screens keep at least this much floor visible across, scaled per mode. */
const PORTRAIT_MIN_WIDTH = 14;
const REFERENCE_DISTANCE = 24;
const TRAUMA_DECAY = 1.6;
const SHAKE_OFFSET = 0.03; // × camera distance, at full trauma
const SHAKE_ROLL = 3.5 * DEG;
const SHOT_TRAUMA = 0.32;
const EXPLOSION_TRAUMA = 0.95;
const KICK_STIFFNESS = 260;
const KICK_DAMPING = 24;
const KICK_IMPULSE = 12;
const FOV_PUNCH = 1.2; // degrees per unit of kick
const FOV_PUNCH_MAX = 3;
const FOV_PUNCH_DECAY = 10;
const CLOSE_YAW_DEADZONE = 35 * DEG;
const CLOSE_YAW_RATE = 0.9;

const _offset = new THREE.Vector3();
const _focus = new THREE.Vector3();
const _look = new THREE.Vector3();
const _ray = new THREE.Ray();
const _proj = new THREE.Vector3();

function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
}

/** Smooth, cheap pseudo-noise in about -1..1 from a few incommensurate sines. */
function shakeNoise(t: number, seed: number): number {
  return (
    (Math.sin(t * 31 + seed) +
      0.6 * Math.sin(t * 47.3 + seed * 2.1) +
      0.3 * Math.sin(t * 73.7 + seed * 3.7)) /
    1.9
  );
}

/**
 * Follow camera with three modes cycled by TAB, aim look-ahead, screen shake and recoil kick.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Current mode name, e.g. "TOP-DOWN". */
  modeName = MODES[0].name;
  /** Camera yaw around Y (0 = looking toward -Z). Movement input is rotated by this. */
  yaw = 0;

  private modeIndex = 0;
  /** Smoothed player position. */
  private readonly follow = new THREE.Vector3();
  /** Smoothed aim look-ahead offset (horizontal). */
  private readonly look = new THREE.Vector3();
  private pitch = MODES[0].pitch;
  private distance = MODES[0].distance;
  private lead = MODES[0].lead;
  private fov: number;
  private trauma = 0;
  private shakeTime = 0;
  private readonly kickPos = new THREE.Vector3();
  private readonly kickVel = new THREE.Vector3();
  private fovPunch = 0;
  private viewWidth = 1;
  private viewHeight = 1;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly ctx: GameContext) {
    this.fov = ctx.tuning.camFov;
    this.camera = new THREE.PerspectiveCamera(this.fov, 1, 0.3, 300);
    this.distance = this.targetDistance(MODES[0]);
    this.applyPose();

    this.unsubscribe = [
      ctx.events.on("shot", ({ weapon }) => {
        this.addShake(SHOT_TRAUMA * weapon.recoilKick * ctx.tuning.recoilMul);
      }),
      ctx.events.on("explosion", ({ position, radius }) => {
        const d = Math.hypot(position.x - this.follow.x, position.z - this.follow.z);
        const r = d / Math.max(0.5, radius * 1.6);
        this.addShake(EXPLOSION_TRAUMA / (1 + r * r));
      }),
    ];
  }

  setViewport(width: number, height: number): void {
    this.viewWidth = Math.max(1, width);
    this.viewHeight = Math.max(1, height);
    this.camera.aspect = this.viewWidth / this.viewHeight;
    this.camera.updateProjectionMatrix();
  }

  cycleMode(): void {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    this.modeName = MODES[this.modeIndex].name;
    this.ctx.events.emit("cameraMode", { name: this.modeName });
  }

  /** Jump straight to the target with no smoothing (spawn/reset). */
  snapTo(target: THREE.Vector3): void {
    const mode = MODES[this.modeIndex];
    this.follow.copy(target);
    this.look.set(0, 0, 0);
    this.pitch = mode.pitch;
    this.distance = this.targetDistance(mode);
    this.lead = mode.lead;
    this.fov = this.ctx.tuning.camFov;
    this.yaw = mode.followYaw ? wrapAngle(this.ctx.player.facing + Math.PI) : 0;
    this.trauma = 0;
    this.kickPos.set(0, 0, 0);
    this.kickVel.set(0, 0, 0);
    this.fovPunch = 0;
    this.applyPose();
  }

  /** target = player feet position, aimPoint = where the player aims (world). */
  update(dt: number, target: THREE.Vector3, aimPoint: THREE.Vector3, aiming: boolean): void {
    if (dt <= 0) return;
    const tuning = this.ctx.tuning;
    const mode = MODES[this.modeIndex];
    const blend = 1 - Math.exp(-BLEND_RATE * dt);

    this.pitch += (mode.pitch - this.pitch) * blend;
    this.distance += (this.targetDistance(mode) - this.distance) * blend;
    this.lead += (mode.lead - this.lead) * blend;
    this.fov += (tuning.camFov - this.fov) * blend;
    this.updateYaw(dt, mode, blend);

    // Look-ahead uses last frame's follow point (the camera the aim was picked through).
    this.updateLook(dt, target, aimPoint, aiming);
    this.follow.lerp(target, 1 - Math.exp(-tuning.camFollow * dt));

    this.trauma = Math.max(0, this.trauma - TRAUMA_DECAY * dt);
    this.shakeTime += dt;
    this.stepKick(dt);
    this.applyPose();
  }

  /** Add screen-shake trauma (0..1, accumulates, decays). */
  addShake(amount: number): void {
    if (amount > 0) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Nudge the camera opposite to `dir` (world, horizontal) by `amount` (0..1). */
  addKick(dir: THREE.Vector3, amount: number): void {
    const len = Math.hypot(dir.x, dir.z);
    if (len < 1e-5 || amount <= 0) return;
    const v = (amount * KICK_IMPULSE * this.distance) / REFERENCE_DISTANCE / len;
    this.kickVel.x -= dir.x * v;
    this.kickVel.z -= dir.z * v;
    this.fovPunch = Math.min(FOV_PUNCH_MAX, this.fovPunch + amount * FOV_PUNCH);
  }

  /** World-space ray through a point in NDC. */
  getRay(ndc: THREE.Vector2, out: THREE.Ray): THREE.Ray {
    out.origin.setFromMatrixPosition(this.camera.matrixWorld);
    out.direction.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(out.origin).normalize();
    return out;
  }

  /** Intersect the NDC ray with the horizontal plane y = height. */
  screenToPlane(ndc: THREE.Vector2, height: number, out: THREE.Vector3): THREE.Vector3 | null {
    const ray = this.getRay(ndc, _ray);
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (height - ray.origin.y) / dy;
    if (t < 0) return null;
    return out.copy(ray.direction).multiplyScalar(t).add(ray.origin);
  }

  /** Project a world point to CSS pixel coords relative to the canvas. */
  worldToScreen(p: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    _proj.copy(p).project(this.camera);
    return out.set(
      (_proj.x * 0.5 + 0.5) * this.viewWidth,
      (0.5 - _proj.y * 0.5) * this.viewHeight,
    );
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
  }

  /** Mode distance × tuning, pushed back on portrait screens so enough floor stays visible. */
  private targetDistance(mode: CameraMode): number {
    const aspect = this.camera.aspect;
    let mul = this.ctx.tuning.camDistanceMul;
    if (aspect < 1) {
      const halfTan = Math.tan((this.ctx.tuning.camFov * DEG) / 2);
      const needed = PORTRAIT_MIN_WIDTH / REFERENCE_DISTANCE / (2 * halfTan * aspect);
      mul *= Math.max(1, needed);
    }
    return mode.distance * mul;
  }

  private updateYaw(dt: number, mode: CameraMode, blend: number): void {
    if (!mode.followYaw) {
      this.yaw = wrapAngle(this.yaw + wrapAngle(-this.yaw) * blend);
      return;
    }
    // Sit behind the player's facing, ignoring small aim changes so the view stays calm.
    const diff = wrapAngle(this.ctx.player.facing + Math.PI - this.yaw);
    const excess = Math.sign(diff) * Math.max(0, Math.abs(diff) - CLOSE_YAW_DEADZONE);
    this.yaw = wrapAngle(this.yaw + excess * (1 - Math.exp(-CLOSE_YAW_RATE * dt)));
  }

  private updateLook(dt: number, target: THREE.Vector3, aimPoint: THREE.Vector3, aiming: boolean): void {
    const input = this.ctx.input;
    const desired = _look;
    if (input.pointerActive && !input.usingTouch) {
      // The pointer's world point already includes the current look offset; remove it so the
      // offset follows the cursor's screen position instead of feeding back on itself.
      desired.subVectors(aimPoint, this.follow).sub(this.look);
    } else {
      desired.subVectors(aimPoint, target);
    }
    desired.y = 0;
    const gain = this.ctx.tuning.camAimLookAhead * (aiming ? AIM_LOOK_MUL : 1);
    desired.multiplyScalar(gain).clampLength(0, LOOK_MAX);
    this.look.lerp(desired, 1 - Math.exp(-LOOK_RATE * dt));
  }

  /** Damped spring pulling the recoil kick back to rest. */
  private stepKick(dt: number): void {
    const k = this.kickPos;
    const v = this.kickVel;
    v.x += (-KICK_STIFFNESS * k.x - KICK_DAMPING * v.x) * dt;
    v.z += (-KICK_STIFFNESS * k.z - KICK_DAMPING * v.z) * dt;
    k.x += v.x * dt;
    k.z += v.z * dt;
    this.fovPunch *= Math.exp(-FOV_PUNCH_DECAY * dt);
  }

  private applyPose(): void {
    const cam = this.camera;
    const sinY = Math.sin(this.yaw);
    const cosY = Math.cos(this.yaw);
    // Portrait screens already show plenty of floor ahead, so lead less there.
    const lead = this.lead * this.distance * Math.min(1, this.camera.aspect);

    _focus.set(
      this.follow.x + this.look.x - sinY * lead,
      this.follow.y + FOCUS_HEIGHT,
      this.follow.z + this.look.z - cosY * lead,
    );

    // Shake and kick translate the whole view (position and look target together).
    const shake = this.trauma * this.trauma * this.ctx.tuning.camShakeMul;
    const amp = shake * SHAKE_OFFSET * this.distance;
    const sideways = shakeNoise(this.shakeTime, 1.3) * amp;
    const forward = shakeNoise(this.shakeTime, 7.9) * amp;
    _offset.set(
      cosY * sideways - sinY * forward + this.kickPos.x,
      0,
      -sinY * sideways - cosY * forward + this.kickPos.z,
    );
    _focus.add(_offset);

    const horizontal = this.distance * Math.cos(this.pitch);
    cam.position.set(
      _focus.x + sinY * horizontal,
      _focus.y + this.distance * Math.sin(this.pitch),
      _focus.z + cosY * horizontal,
    );
    cam.lookAt(_focus);
    cam.rotateZ(shakeNoise(this.shakeTime, 4.2) * shake * SHAKE_ROLL);

    const fov = this.fov + this.fovPunch;
    if (Math.abs(cam.fov - fov) > 1e-4) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    cam.updateMatrixWorld();
  }
}
