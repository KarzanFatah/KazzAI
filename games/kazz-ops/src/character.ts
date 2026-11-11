import * as THREE from "three";
import type { CharacterAnimState, WeaponDef } from "./types";

/**
 * Low-poly soldier built from primitives, with procedural animation and three weapon meshes.
 * `root` sits at the feet and faces local +Z; Player sets root.position / root.rotation.y.
 * STUB: to be implemented (see SPEC.md).
 */
export class CharacterModel {
  readonly root = new THREE.Group();

  constructor() {
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.3, 1.1, 4, 8),
      new THREE.MeshStandardMaterial({ color: 0x444444 }),
    );
    body.position.y = 0.85;
    body.castShadow = true;
    this.root.add(body);
  }

  setWeapon(id: WeaponDef["id"]): void {}

  update(dt: number, anim: CharacterAnimState): void {}

  /** World position of the muzzle and the barrel's forward direction (normalised). */
  getMuzzle(outPos: THREE.Vector3, outDir: THREE.Vector3): void {
    this.root.updateWorldMatrix(true, false);
    outPos.set(0.2, 1.35, 0.9).applyMatrix4(this.root.matrixWorld);
    outDir.set(0, 0, 1).transformDirection(this.root.matrixWorld);
  }

  /** World position of the ejection port (for shell casings). */
  getEjectionPort(outPos: THREE.Vector3): void {
    this.root.updateWorldMatrix(true, false);
    outPos.set(0.25, 1.35, 0.4).applyMatrix4(this.root.matrixWorld);
  }

  dispose(): void {}
}
