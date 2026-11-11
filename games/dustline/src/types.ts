/**
 * Shared contracts. Conventions:
 *  - Y up, metres. Terrain: see terrain.ts (square WORLD_SIZE centred on origin, sea along -Z).
 *  - Yaw θ: forward = (sin θ, 0, cos θ); models are built facing local +Z, so rotation.y = θ.
 *  - Right of a heading (tx, tz) is (-tz, tx).
 */

/** Static obstacles the car collides with (2D, in the XZ plane). */
export type Collider =
  | {
      kind: "circle";
      x: number;
      z: number;
      r: number;
      /** false = soft (bushes, flags): slows the car a little and wobbles, no bounce. */
      solid: boolean;
      /** Optional id so the prop can react (e.g. wobble) when hit. */
      id?: number;
    }
  | {
      kind: "segment"; // capsule from a to b with radius r (fences, walls)
      ax: number;
      az: number;
      bx: number;
      bz: number;
      r: number;
      solid: boolean;
      id?: number;
    };

/** What the car tells the audio system every frame. */
export interface CarAudioState {
  speed: number; // m/s, absolute
  rpm: number; // 0..1 engine revs (drops on gear changes)
  throttle: number; // 0..1
  slip: number; // 0..1 drift / wheelspin amount
  grounded: boolean;
  boosting: boolean;
  surface: "sand" | "road" | "beach" | "water";
}
