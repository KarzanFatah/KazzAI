import * as THREE from "three";
import type { GameContext, HitInfo, Surface } from "./types";

/**
 * Pooled visual effects: muzzle flash, tracers, sparks, dust, splinters, smoke, shell casings,
 * bullet-hole decals, explosions.
 * STUB: to be implemented (see SPEC.md).
 */
export class Effects {
  constructor(private readonly ctx: GameContext) {}

  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, scale: number): void {}
  tracer(from: THREE.Vector3, to: THREE.Vector3): void {}
  /** Surface-appropriate impact burst + decal for a bullet hit. dir = bullet direction. */
  impact(hit: HitInfo, dir: THREE.Vector3): void {}
  sparks(pos: THREE.Vector3, normal: THREE.Vector3, count: number): void {}
  dust(pos: THREE.Vector3, normal: THREE.Vector3, count: number, color?: THREE.ColorRepresentation): void {}
  splinters(pos: THREE.Vector3, normal: THREE.Vector3, count: number): void {}
  smoke(pos: THREE.Vector3, dir: THREE.Vector3, amount: number): void {}
  shellCasing(pos: THREE.Vector3, velocity: THREE.Vector3, kind: "rifle" | "pistol" | "shell"): void {}
  /** Bullet hole. If `attachTo` is given (a dynamic prop's object) the decal follows it. */
  decal(point: THREE.Vector3, normal: THREE.Vector3, surface: Surface, attachTo?: THREE.Object3D): void {}
  explosion(pos: THREE.Vector3, radius: number): void {}
  /** Remove decals attached to an object that is about to be removed. */
  detachFrom(object: THREE.Object3D): void {}
  update(dt: number): void {}
  clear(): void {}
}
