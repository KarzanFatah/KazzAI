import * as THREE from "three";
import * as CANNON from "cannon-es";
import { CharacterModel } from "./character";
import type { GameContext, MoveState } from "./types";

/**
 * Player controller: movement states (walk/run/tactical/crouch/slide/vault), stamina, aiming,
 * physics body that pushes props, and driving the CharacterModel.
 * STUB: to be implemented (see SPEC.md).
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
  /** True after stamina hit 0 until it recovers past tuning.staminaRecoverThreshold. */
  exhausted = false;
  crouched = false;
  aiming = false;

  constructor(private readonly ctx: GameContext) {
    this.body = new CANNON.Body({ mass: 80, fixedRotation: true });
    ctx.scene.add(this.model.root);
  }

  /** Can the weapon fire this frame? (false while sprinting, vaulting, or in sprint-to-fire delay) */
  canFire(): boolean {
    return true;
  }

  /** Read input, choose state, set body velocity, handle vault/slide/crouch. Before physics. */
  update(dt: number): void {}

  /** After physics: copy body -> position, pose and animate the model. */
  postPhysics(dt: number): void {}

  reset(spawn: THREE.Vector3, yaw: number): void {
    this.position.copy(spawn);
    this.facing = yaw;
    this.model.root.position.copy(spawn);
    this.model.root.rotation.y = yaw;
  }
}
