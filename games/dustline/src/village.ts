import type * as THREE from "three";
import type { PropsResult } from "./props";
import type { Terrain } from "./terrain";
import type { Track } from "./track";
import type { Collider } from "./types";

/**
 * A small, lived-in desert settlement the road runs through: houses, a roadside gas station,
 * water tower, parked cars, yards, fences, poles. Levels building pads with terrain.flatten
 * (the game builds the terrain mesh afterwards). `avoid` = colliders already placed by props.
 * Not built yet: returns no props. Hook point for a future village.
 */
export function buildVillage(
  scene: THREE.Scene,
  terrain: Terrain,
  track: Track,
  avoid: Collider[],
): PropsResult {
  return { colliders: [], update() {}, hit() {} };
}
