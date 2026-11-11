import * as CANNON from "cannon-es";
import * as THREE from "three";
import type { GameContext } from "./types";

/** Collision groups (bit flags) for collisionFilterGroup / collisionFilterMask. */
export const GROUP = {
  GROUND: 1,
  STATIC: 2,
  DYNAMIC: 4,
  PLAYER: 8,
  DEBRIS: 16,
} as const;

/** What bullets can hit: everything except the player and cosmetic debris. */
export const BULLET_MASK = GROUP.GROUND | GROUP.STATIC | GROUP.DYNAMIC;

export interface RayHit {
  body: CANNON.Body;
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
}

/**
 * Thin wrapper around a cannon-es world: shared materials, the floor, fixed-step stepping and a
 * three.js-friendly raycast. Render dynamic props from body.interpolatedPosition/Quaternion.
 */
export class Physics {
  readonly world: CANNON.World;
  readonly fixedStep = 1 / 60;
  readonly materials: {
    ground: CANNON.Material;
    prop: CANNON.Material;
    player: CANNON.Material;
  };
  readonly groundBody: CANNON.Body;

  private readonly rayResult = new CANNON.RaycastResult();
  private readonly rayFrom = new CANNON.Vec3();
  private readonly rayTo = new CANNON.Vec3();

  constructor(private readonly ctx: GameContext) {
    const world = new CANNON.World({
      gravity: new CANNON.Vec3(0, -ctx.tuning.gravity, 0),
    });
    world.broadphase = new CANNON.SAPBroadphase(world);
    world.allowSleep = true;
    (world.solver as CANNON.GSSolver).iterations = 12;
    world.defaultContactMaterial.friction = 0.4;
    world.defaultContactMaterial.restitution = 0.1;
    this.world = world;

    const ground = new CANNON.Material("ground");
    const prop = new CANNON.Material("prop");
    const player = new CANNON.Material("player");
    this.materials = { ground, prop, player };

    world.addContactMaterial(
      new CANNON.ContactMaterial(ground, prop, {
        friction: 0.5,
        restitution: 0.15,
      }),
    );
    world.addContactMaterial(
      new CANNON.ContactMaterial(prop, prop, {
        friction: 0.35,
        restitution: 0.12,
      }),
    );
    // The player's velocity is driven directly, so frictionless contacts avoid sticking to walls.
    world.addContactMaterial(
      new CANNON.ContactMaterial(player, ground, {
        friction: 0,
        restitution: 0,
      }),
    );
    world.addContactMaterial(
      new CANNON.ContactMaterial(player, prop, {
        friction: 0,
        restitution: 0,
      }),
    );

    this.groundBody = new CANNON.Body({
      mass: 0,
      material: ground,
      shape: new CANNON.Plane(),
      collisionFilterGroup: GROUP.GROUND,
    });
    this.groundBody.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    world.addBody(this.groundBody);
  }

  step(dt: number): void {
    this.world.gravity.set(0, -this.ctx.tuning.gravity, 0);
    this.world.step(this.fixedStep, dt, 5);
  }

  addBody(body: CANNON.Body): void {
    this.world.addBody(body);
  }

  removeBody(body: CANNON.Body): void {
    this.world.removeBody(body);
  }

  /**
   * Closest hit along the segment from -> to, or null. Default mask = BULLET_MASK (ignores the
   * player and debris). Returned vectors are new objects owned by the caller.
   */
  raycast(
    from: THREE.Vector3,
    to: THREE.Vector3,
    mask: number = BULLET_MASK,
  ): RayHit | null {
    this.rayFrom.set(from.x, from.y, from.z);
    this.rayTo.set(to.x, to.y, to.z);
    const r = this.rayResult;
    r.reset();
    const hit = this.world.raycastClosest(
      this.rayFrom,
      this.rayTo,
      { collisionFilterMask: mask, skipBackfaces: true },
      r,
    );
    if (!hit || !r.body) return null;
    return {
      body: r.body,
      point: new THREE.Vector3(
        r.hitPointWorld.x,
        r.hitPointWorld.y,
        r.hitPointWorld.z,
      ),
      normal: new THREE.Vector3(
        r.hitNormalWorld.x,
        r.hitNormalWorld.y,
        r.hitNormalWorld.z,
      ).normalize(),
      distance: r.distance,
    };
  }
}
