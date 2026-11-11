import * as THREE from "three";
import { CarModel, WHEEL_POS, WHEEL_RADIUS } from "./carModel";
import { clamp, lerp } from "./noise";
import { HALF_WORLD, SEA_LEVEL, type Surface, type Terrain } from "./terrain";
import type { CarAudioState, Collider } from "./types";

export interface DriveInput {
  throttle: number; // 0..1
  brake: number; // 0..1 (reverse when stopped)
  steer: number; // -1 (left) .. 1 (right)
  handbrake: boolean;
  boost: boolean;
  jump: boolean; // edge
}

export interface CarEvents {
  onLand?(strength: number, pos: THREE.Vector3): void;
  onImpact?(strength: number, pos: THREE.Vector3, collider: Collider): void;
  onJump?(): void;
  onBoostStart?(): void;
  onSoftHit?(collider: Collider, strength: number): void;
}

const GRAVITY = 20; // arcade: snappier than 9.81
const WHEELBASE = 2.7;
const TRACK_WIDTH = 1.56;
const COLLIDE_R = 1.0;
const COLLIDE_OFFSET = 1.3;
const SUBSTEP = 1 / 120;

/** Grip, rolling resistance and top-speed multiplier per surface. */
const SURFACE: Record<Surface, { grip: number; roll: number; vmax: number; dust: number }> = {
  road: { grip: 8.5, roll: 0.5, vmax: 1, dust: 0.75 },
  sand: { grip: 6, roll: 1.7, vmax: 0.86, dust: 1 },
  beach: { grip: 5.2, roll: 1.1, vmax: 0.92, dust: 0.6 },
  water: { grip: 3, roll: 9, vmax: 0.35, dust: 0 },
};

const GEARS = [0, 9, 16, 23, 30, 38, 99];

const _n = new THREE.Vector3();
const _p = new THREE.Vector3();

/**
 * Arcade rally car on the heightfield: bicycle-model steering, surface-dependent grip, handbrake
 * drifts, slope gravity, crest launches and landings, boost, jump, and 2D collisions with props.
 */
export class Car {
  readonly model = new CarModel();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  yawRate = 0;
  grounded = true;
  airTime = 0;
  boost = 1; // 0..1 meter
  boosting = false;
  surface: Surface = "road";
  /** Lateral slip 0..1 (drift amount). */
  slip = 0;
  /** Signed forward speed (m/s). */
  forwardSpeed = 0;
  steerAngle = 0;
  /** Seconds spent in deep water (the game resets the car after a moment). */
  drowning = 0;
  readonly audio: CarAudioState = {
    speed: 0,
    rpm: 0,
    throttle: 0,
    slip: 0,
    grounded: true,
    boosting: false,
    surface: "road",
  };

  private steerSmooth = 0;
  private wheelSpin = 0;
  private groundPitch = 0;
  private groundRoll = 0;
  private bodyRoll = 0;
  private bodyPitch = 0;
  private squat = 0;
  private squatVel = 0;
  private lastForward = 0;
  private gear = 1;
  private braking = false;

  constructor(
    private readonly terrain: Terrain,
    private readonly events: CarEvents = {},
  ) {}

  reset(x: number, z: number, yaw: number): void {
    this.position.set(x, this.terrain.heightAt(x, z), z);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.yawRate = 0;
    this.grounded = true;
    this.airTime = 0;
    this.boost = 1;
    this.boosting = false;
    this.drowning = 0;
    this.squat = 0;
    this.squatVel = 0;
    this.steerSmooth = 0;
    this.pose(0);
  }

  get speed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  update(dt: number, input: DriveInput, colliders: Collider[]): void {
    // Smooth digital steering so keyboard input feels analogue.
    const steerRate = Math.abs(input.steer) > Math.abs(this.steerSmooth) ? 5 : 8;
    this.steerSmooth += (input.steer - this.steerSmooth) * (1 - Math.exp(-steerRate * dt));

    const wantBoost = input.boost && this.boost > 0.02;
    if (wantBoost && !this.boosting) this.events.onBoostStart?.();
    this.boosting = wantBoost;
    this.boost = clamp(this.boost + (this.boosting ? -0.32 : 0.1) * dt, 0, 1);

    if (input.jump && this.grounded) {
      this.velocity.y += 8.5;
      this.grounded = false;
      this.airTime = 0;
      this.events.onJump?.();
    }

    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(SUBSTEP, remaining);
      this.step(h, input);
      this.collide(colliders);
      remaining -= h;
    }

    // Deep water: let the game know so it can put the car back on the track.
    const depth = SEA_LEVEL - this.terrain.heightAt(this.position.x, this.position.z);
    this.drowning = depth > 1.1 ? this.drowning + dt : 0;

    this.pose(dt, input);
    this.updateAudioState(input);
  }

  private step(dt: number, input: DriveInput): void {
    const { terrain, position: p, velocity: v } = this;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const rx = -fz;
    const rz = fx;
    this.surface = terrain.surfaceAt(p.x, p.z);
    const surf = SURFACE[this.surface];

    if (this.grounded) {
      let vf = v.x * fx + v.z * fz;
      let vl = v.x * rx + v.z * rz;
      const vmax = 37 * surf.vmax * (this.boosting ? 1.3 : 1);

      // Engine, brakes, reverse.
      this.braking = false;
      if (input.throttle > 0) {
        if (vf < -0.5) {
          vf += 20 * input.throttle * dt; // braking out of reverse
        } else {
          const ratio = clamp(vf / vmax, 0, 1);
          vf += (15 * input.throttle * (1 - ratio * ratio) + (this.boosting ? 12 : 0)) * dt;
        }
      } else if (this.boosting) {
        vf += 12 * (1 - clamp(vf / vmax, 0, 1)) * dt;
      }
      if (input.brake > 0) {
        if (vf > 0.5) {
          vf = Math.max(0, vf - 24 * input.brake * dt);
          this.braking = true;
        } else {
          const r = clamp(-vf / 11, 0, 1);
          vf -= 9 * input.brake * (1 - r * r) * dt;
        }
      }
      if (input.handbrake) {
        vf -= Math.sign(vf) * Math.min(Math.abs(vf), 5 * dt);
        this.braking = true;
      }
      vf -= Math.sign(vf) * Math.min(Math.abs(vf), surf.roll * dt);
      vf -= vf * Math.abs(vf) * 0.0016 * dt;

      // Bicycle-model yaw, more rotation with the handbrake pulled.
      const speedT = clamp(Math.abs(vf) / 34, 0, 1);
      this.steerAngle = this.steerSmooth * lerp(0.6, 0.2, speedT);
      // Positive steer = right = decreasing yaw (forward = (sin, cos), right = (-cos, sin)).
      let targetYaw = -(vf / WHEELBASE) * Math.tan(this.steerAngle);
      if (input.handbrake && Math.abs(vf) > 4) targetYaw *= 1.8;
      const yawK = input.handbrake ? 3.5 : 9;
      this.yawRate += (targetYaw - this.yawRate) * (1 - Math.exp(-yawK * dt));

      // Lateral grip: handbrake and power-oversteer loosen the rear for drifts.
      const powerSlide =
        0.5 * input.throttle * Math.abs(this.steerSmooth) * clamp((Math.abs(vf) - 12) / 18, 0, 1);
      const grip = surf.grip * (input.handbrake ? 0.16 : 1) * (1 - powerSlide);
      vl *= Math.exp(-grip * dt);

      v.x = fx * vf + rx * vl;
      v.z = fz * vf + rz * vl;

      // Slope: gravity pulls downhill, and the car follows the ground's vertical motion.
      terrain.normalAt(p.x, p.z, _n);
      v.x += GRAVITY * _n.x * 0.55 * dt;
      v.z += GRAVITY * _n.z * 0.55 * dt;
      v.y = this.slopeRate(p.x, p.z, v.x, v.z);
      this.slip = clamp(Math.abs(vl) / Math.max(6, Math.abs(vf)), 0, 1);
      this.forwardSpeed = vf;
    } else {
      this.airTime += dt;
      v.y -= GRAVITY * dt;
      // A little air control so jumps can be lined up.
      this.yawRate += (-this.steerSmooth * 1.4 - this.yawRate) * (1 - Math.exp(-1.5 * dt));
      this.slip *= 0.98;
    }

    this.yaw += this.yawRate * dt;
    p.x += v.x * dt;
    p.y += v.y * dt;
    p.z += v.z * dt;

    // Keep inside the map.
    const lim = HALF_WORLD - 12;
    if (Math.abs(p.x) > lim) {
      p.x = Math.sign(p.x) * lim;
      v.x *= -0.3;
    }
    if (Math.abs(p.z) > lim) {
      p.z = Math.sign(p.z) * lim;
      v.z *= -0.3;
    }

    const ground = terrain.heightAt(p.x, p.z);
    const groundRate = this.slopeRate(p.x, p.z, v.x, v.z);
    if (this.grounded) {
      // Leave the ground over crests: moving up much faster than the ground below.
      if (p.y > ground + 0.05 && v.y > groundRate + 2.5) {
        this.grounded = false;
        this.airTime = 0;
      } else {
        p.y = ground;
      }
    } else if (p.y <= ground) {
      const impact = groundRate - v.y; // closing speed along Y
      p.y = ground;
      this.grounded = true;
      const strength = clamp(impact / 14, 0, 1);
      if (this.airTime > 0.12) {
        this.squatVel -= impact * 0.06;
        this.events.onLand?.(strength, p);
      }
      v.y = groundRate;
      this.airTime = 0;
    }
  }

  /** Vertical speed of the ground under a point moving with (vx, vz). */
  private slopeRate(x: number, z: number, vx: number, vz: number): number {
    const e = 0.8;
    const dhdx = (this.terrain.heightAt(x + e, z) - this.terrain.heightAt(x - e, z)) / (2 * e);
    const dhdz = (this.terrain.heightAt(x, z + e) - this.terrain.heightAt(x, z - e)) / (2 * e);
    return vx * dhdx + vz * dhdz;
  }

  private collide(colliders: Collider[]): void {
    const p = this.position;
    const v = this.velocity;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    for (let k = -1; k <= 1; k += 2) {
      const cx = p.x + fx * COLLIDE_OFFSET * k;
      const cz = p.z + fz * COLLIDE_OFFSET * k;
      for (const c of colliders) {
        let px: number;
        let pz: number;
        let r: number;
        if (c.kind === "circle") {
          if (Math.abs(c.x - cx) > c.r + 3 || Math.abs(c.z - cz) > c.r + 3) continue;
          px = c.x;
          pz = c.z;
          r = c.r;
        } else {
          const minX = Math.min(c.ax, c.bx) - c.r - 3;
          const maxX = Math.max(c.ax, c.bx) + c.r + 3;
          const minZ = Math.min(c.az, c.bz) - c.r - 3;
          const maxZ = Math.max(c.az, c.bz) + c.r + 3;
          if (cx < minX || cx > maxX || cz < minZ || cz > maxZ) continue;
          const abx = c.bx - c.ax;
          const abz = c.bz - c.az;
          const t = clamp(((cx - c.ax) * abx + (cz - c.az) * abz) / (abx * abx + abz * abz || 1), 0, 1);
          px = c.ax + abx * t;
          pz = c.az + abz * t;
          r = c.r;
        }
        const dx = cx - px;
        const dz = cz - pz;
        const minD = r + COLLIDE_R;
        const d2 = dx * dx + dz * dz;
        if (d2 >= minD * minD) continue;
        const d = Math.sqrt(d2) || 0.001;
        const nx = dx / d;
        const nz = dz / d;
        const vn = v.x * nx + v.z * nz;
        if (!c.solid) {
          if (vn < -1) {
            v.x *= 0.985;
            v.z *= 0.985;
            this.events.onSoftHit?.(c, clamp(-vn / 20, 0, 1));
          }
          continue;
        }
        const push = minD - d;
        p.x += nx * push;
        p.z += nz * push;
        if (vn < 0) {
          v.x -= nx * vn * 1.3;
          v.z -= nz * vn * 1.3;
          const loss = clamp(-vn / 30, 0, 0.5);
          v.x *= 1 - loss;
          v.z *= 1 - loss;
          // Off-centre hits spin the car a little.
          this.yawRate += k * (nx * fz - nz * fx) * vn * 0.12;
          if (vn < -2.5) {
            _p.set(px + nx * r, p.y + 0.6, pz + nz * r);
            this.events.onImpact?.(clamp(-vn / 16, 0, 1), _p, c);
          }
        }
      }
    }
  }

  private pose(dt: number, input?: DriveInput): void {
    const { terrain, position: p, model } = this;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const k = dt > 0 ? 1 - Math.exp(-14 * dt) : 1;

    if (this.grounded) {
      // Lean the chassis to the ground under the four wheels.
      let hFront = 0;
      let hRear = 0;
      let hLeft = 0;
      let hRight = 0;
      for (let i = 0; i < 4; i++) {
        const [lx, lz] = WHEEL_POS[i];
        const wx = p.x + fx * lz + fz * lx;
        const wz = p.z + fz * lz - fx * lx;
        const h = terrain.heightAt(wx, wz);
        if (i < 2) hFront += h;
        else hRear += h;
        if (lx > 0) hLeft += h;
        else hRight += h;
      }
      const pitch = -Math.atan2((hFront - hRear) / 2, WHEELBASE);
      const roll = Math.atan2((hLeft - hRight) / 2, TRACK_WIDTH);
      this.groundPitch += (pitch - this.groundPitch) * k;
      this.groundRoll += (roll - this.groundRoll) * k;
    } else {
      const air = dt > 0 ? 1 - Math.exp(-2 * dt) : 1;
      this.groundPitch += (clamp(-this.velocity.y * 0.025, -0.35, 0.35) - this.groundPitch) * air;
      this.groundRoll += (0 - this.groundRoll) * air;
    }

    model.root.position.copy(p);
    model.root.rotation.set(this.groundPitch, this.yaw, this.groundRoll, "YXZ");

    // Sprung body: lean out of corners, squat/dive with acceleration, bounce on landings.
    if (dt > 0) {
      const accel = (this.forwardSpeed - this.lastForward) / dt;
      this.lastForward = this.forwardSpeed;
      const lateralG = this.yawRate * this.forwardSpeed;
      const bk = 1 - Math.exp(-6 * dt);
      this.bodyRoll += (clamp(lateralG * 0.006, -0.09, 0.09) - this.bodyRoll) * bk;
      this.bodyPitch += (clamp(-accel * 0.004, -0.06, 0.06) - this.bodyPitch) * bk;
      this.squatVel += (-this.squat * 160 - this.squatVel * 12) * dt;
      this.squat = clamp(this.squat + this.squatVel * dt, -0.18, 0.12);
      this.wheelSpin += (this.forwardSpeed / WHEEL_RADIUS) * dt;
    }
    model.pose(
      -this.steerAngle * 1.2,
      this.wheelSpin,
      this.bodyRoll,
      this.bodyPitch,
      this.squat,
      this.braking || (input?.brake ?? 0) > 0,
    );
  }

  private updateAudioState(input: DriveInput): void {
    const a = this.audio;
    const s = Math.abs(this.forwardSpeed);
    while (this.gear < GEARS.length - 2 && s > GEARS[this.gear + 1]) this.gear++;
    while (this.gear > 1 && s < GEARS[this.gear] - 2) this.gear--;
    const lo = GEARS[this.gear];
    const hi = GEARS[this.gear + 1] === 99 ? 46 : GEARS[this.gear + 1];
    let rpm = 0.22 + clamp((s - lo) / (hi - lo), 0, 1) * 0.72;
    if (!this.grounded) rpm = Math.min(1, rpm + input.throttle * 0.25);
    a.speed = this.speed;
    a.rpm = rpm;
    a.throttle = input.throttle;
    a.slip = this.grounded ? this.slip : 0;
    a.grounded = this.grounded;
    a.boosting = this.boosting;
    a.surface = this.surface;
  }

  /** World position of wheel i's contact patch and the car's right vector. */
  wheelContact(i: number, out: THREE.Vector3): THREE.Vector3 {
    const [lx, lz] = WHEEL_POS[i];
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const x = this.position.x + fx * lz + fz * lx;
    const z = this.position.z + fz * lz - fx * lx;
    return out.set(x, this.terrain.heightAt(x, z), z);
  }

  rightVector(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
  }

  /** Dust/track intensity for the current frame (0..1). */
  dustAmount(): number {
    if (!this.grounded) return 0;
    const surf = SURFACE[this.surface];
    return clamp((this.speed / 32) * 0.55 + this.slip * 0.9 + (this.boosting ? 0.2 : 0), 0, 1) * surf.dust;
  }

  velocityCopy(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.velocity);
  }
}
