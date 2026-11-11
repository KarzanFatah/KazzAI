import * as THREE from "three";
import type * as CANNON from "cannon-es";
import type { GameContext, HitInfo, Prop } from "./types";

/**
 * The level: floor + grid, lighting/shadows, and every prop (static cover, physics barrels/crates,
 * explosive barrels, steel targets). Owns prop damage, explosions and collision sound events.
 * STUB: to be implemented (see SPEC.md).
 */
export class World {
  readonly props: Prop[] = [];
  readonly spawnPoint = new THREE.Vector3(0, 0, 8);
  /** Spawn facing: PI = facing -Z (toward the top of the screen). */
  readonly spawnYaw = Math.PI;

  constructor(private readonly ctx: GameContext) {}

  /** Create floor, lights and all props. Called once after every system exists. */
  build(): void {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(200, 200),
      new THREE.MeshStandardMaterial({ color: 0x2b3546 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.ctx.scene.add(floor);
    this.ctx.scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x1a2230, 1.4));
  }

  /** F9: restore every prop to its initial state (rebuild dynamic ones). */
  reset(): void {}

  /** Sync dynamic meshes from bodies, run fuses/target timers. After physics each frame. */
  update(dt: number): void {}

  propFromBody(body: CANNON.Body | null): Prop | null {
    return null;
  }

  /** Bullet hit: impulse at the hit point, damage, explosive fuse, target knock-down. */
  applyBulletHit(prop: Prop, hit: HitInfo, dir: THREE.Vector3, damage: number, impulse: number): void {}

  /** Radial impulse + damage. Emits "explosion" and spawns FX. */
  explode(position: THREE.Vector3, radius: number, force: number): void {}

  /** Move the shadow-casting light's frustum to follow the player. */
  updateShadowFocus(center: THREE.Vector3): void {}
}
