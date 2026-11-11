import * as THREE from "three";
import type { GameContext } from "./types";

/**
 * Follow camera with three modes cycled by TAB, aim look-ahead, screen shake and recoil kick.
 * STUB: to be implemented (see SPEC.md).
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Current mode name, e.g. "TOP-DOWN". */
  modeName = "TOP-DOWN";
  /** Camera yaw around Y (0 = looking toward -Z). Movement input is rotated by this. */
  yaw = 0;

  constructor(private readonly ctx: GameContext) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
    this.camera.position.set(0, 24, 9);
    this.camera.lookAt(0, 0, 0);
  }

  setViewport(width: number, height: number): void {
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  cycleMode(): void {}

  /** Jump straight to the target with no smoothing (spawn/reset). */
  snapTo(target: THREE.Vector3): void {}

  /** target = player feet position, aimPoint = where the player aims (world). */
  update(dt: number, target: THREE.Vector3, aimPoint: THREE.Vector3, aiming: boolean): void {}

  /** Add screen-shake trauma (0..1, accumulates, decays). */
  addShake(amount: number): void {}

  /** Nudge the camera opposite to `dir` (world, horizontal) by `amount` (0..1). */
  addKick(dir: THREE.Vector3, amount: number): void {}

  /** World-space ray through a point in NDC. */
  getRay(ndc: THREE.Vector2, out: THREE.Ray): THREE.Ray {
    out.origin.setFromMatrixPosition(this.camera.matrixWorld);
    out.direction.set(ndc.x, ndc.y, 0.5).unproject(this.camera).sub(out.origin).normalize();
    return out;
  }

  /** Intersect the NDC ray with the horizontal plane y = height. */
  screenToPlane(ndc: THREE.Vector2, height: number, out: THREE.Vector3): THREE.Vector3 | null {
    return null;
  }

  /** Project a world point to CSS pixel coords relative to the canvas. */
  worldToScreen(p: THREE.Vector3, out: THREE.Vector2): THREE.Vector2 {
    return out;
  }
}
