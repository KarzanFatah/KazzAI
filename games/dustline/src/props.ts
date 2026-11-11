import * as THREE from "three";
import type { Terrain } from "./terrain";
import type { Track } from "./track";
import type { Collider } from "./types";

export interface PropsResult {
  /** Static obstacles for the car (rocks, poles, buildings, fences, flags...). */
  colliders: Collider[];
  /** Animate windmill, flags, birds, wobbling bushes... */
  update(dt: number, time: number, carPos: THREE.Vector3): void;
  /** The car hit collider `id` with strength 0..1 (wobble a sign, shake a bush...). */
  hit(id: number, strength: number): void;
}

/**
 * Every static/ambient object in the level: start/finish gantry, checkpoint flags, shack with
 * wire fence, windmill pump, trailer, water tank, telegraph poles with sagging wires, rocks,
 * dry bushes/grass, dead trees, birds.
 * STUB: to be implemented (see SPEC.md).
 */
export function buildProps(scene: THREE.Scene, terrain: Terrain, track: Track): PropsResult {
  return { colliders: [], update() {}, hit() {} };
}
