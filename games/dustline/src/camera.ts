import * as THREE from "three";
import type { Car } from "./car";
import { clamp } from "./noise";

interface CamMode {
  name: string;
  distance: number;
  pitch: number; // radians below horizontal
  followYaw: boolean;
  fov: number;
}

const MODES: CamMode[] = [
  { name: "CHASE", distance: 36, pitch: 0.86, followYaw: true, fov: 45 },
  { name: "TOP", distance: 56, pitch: 1.12, followYaw: false, fov: 40 },
  { name: "CLOSE", distance: 15, pitch: 0.42, followYaw: true, fov: 55 },
];

const _target = new THREE.Vector3();
const _look = new THREE.Vector3();

/** High rally camera: follows behind the direction of travel with look-ahead, zoom and shake. */
export class ChaseCamera {
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.5, 900);
  modeIndex = 0;
  private yaw = Math.PI;
  private readonly focus = new THREE.Vector3();
  private distance = MODES[0].distance;
  private pitch = MODES[0].pitch;
  private trauma = 0;
  private time = 0;
  private aspect = 1;

  get mode(): CamMode {
    return MODES[this.modeIndex];
  }

  setViewport(w: number, h: number): void {
    this.aspect = w / Math.max(1, h);
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  cycle(): string {
    this.modeIndex = (this.modeIndex + 1) % MODES.length;
    return this.mode.name;
  }

  shake(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount);
  }

  snap(car: Car): void {
    this.focus.copy(car.position);
    this.yaw = this.mode.followYaw ? car.yaw : Math.PI;
    this.distance = this.mode.distance;
    this.pitch = this.mode.pitch;
    this.update(0, car);
  }

  update(dt: number, car: Car): void {
    this.time += dt;
    const m = this.mode;
    const speed = car.speed;

    // Look ahead along the velocity so you can see what is coming.
    const ahead = clamp(speed * 0.42, 0, 13);
    const vx = speed > 0.5 ? car.velocity.x / speed : Math.sin(car.yaw);
    const vz = speed > 0.5 ? car.velocity.z / speed : Math.cos(car.yaw);
    _target.set(car.position.x + vx * ahead, car.position.y, car.position.z + vz * ahead);
    const fk = dt > 0 ? 1 - Math.exp(-5 * dt) : 1;
    this.focus.lerp(_target, fk);

    if (m.followYaw) {
      const travel = speed > 4 ? Math.atan2(vx, vz) : car.yaw;
      let d = travel - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (dt > 0 ? 1 - Math.exp(-1.6 * dt) : 1);
    } else {
      let d = Math.PI - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (dt > 0 ? 1 - Math.exp(-3 * dt) : 1);
    }

    // Pull out with speed; more distance in portrait so the road ahead stays visible.
    const portrait = this.aspect < 1 ? 1 + (1 - this.aspect) * 0.6 : 1;
    const wantDist = m.distance * (1 + clamp(speed / 40, 0, 1) * 0.22) * portrait;
    const mk = dt > 0 ? 1 - Math.exp(-2.5 * dt) : 1;
    this.distance += (wantDist - this.distance) * mk;
    this.pitch += (m.pitch - this.pitch) * mk;
    this.camera.fov += (m.fov - this.camera.fov) * mk;
    this.camera.updateProjectionMatrix();

    const horiz = Math.cos(this.pitch) * this.distance;
    const cam = this.camera;
    cam.position.set(
      this.focus.x - Math.sin(this.yaw) * horiz,
      this.focus.y + Math.sin(this.pitch) * this.distance,
      this.focus.z - Math.cos(this.yaw) * horiz,
    );
    _look.copy(this.focus);

    // Trauma-based shake.
    if (this.trauma > 0) {
      const s = this.trauma * this.trauma * 0.9;
      const t = this.time * 31;
      cam.position.x += (Math.sin(t) + Math.sin(t * 2.3)) * 0.5 * s;
      cam.position.y += (Math.sin(t * 1.7 + 1) + Math.sin(t * 3.1)) * 0.5 * s;
      _look.x += Math.sin(t * 1.3 + 2) * 0.3 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.8);
    }
    cam.lookAt(_look);
  }
}
