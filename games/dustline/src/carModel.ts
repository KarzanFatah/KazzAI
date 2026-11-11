import * as THREE from "three";

/** Wheel layout shared with the physics: [x (right = -x), z (forward)] per wheel FL, FR, RL, RR. */
export const WHEEL_POS: [number, number][] = [
  [0.78, 1.38],
  [-0.78, 1.38],
  [0.78, -1.32],
  [-0.78, -1.32],
];
export const WHEEL_RADIUS = 0.36;

/**
 * A boxy old sedan with a roof rack and spare tyre, built from extruded profiles and boxes.
 * root sits on the ground between the wheels and faces +Z. `body` is the sprung part.
 */
export class CarModel {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly wheels: THREE.Group[] = [];
  private readonly steerPivots: THREE.Group[] = [];
  private readonly brakeLights: THREE.MeshStandardMaterial;

  constructor(paint = 0xeee8dc) {
    this.root.add(this.body);
    const paintMat = new THREE.MeshStandardMaterial({ color: paint, roughness: 0.45, metalness: 0.15 });
    const glass = new THREE.MeshStandardMaterial({ color: 0x1d2a33, roughness: 0.15, metalness: 0.6 });
    const chrome = new THREE.MeshStandardMaterial({ color: 0xd8dde2, roughness: 0.25, metalness: 0.9 });
    const black = new THREE.MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.7 });
    const rubber = new THREE.MeshStandardMaterial({ color: 0x202022, roughness: 0.95 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0xfff6d8, emissive: 0x6b6040, roughness: 0.2 });
    this.brakeLights = new THREE.MeshStandardMaterial({ color: 0xb3221c, emissive: 0x3a0505, roughness: 0.3 });
    const dirt = new THREE.MeshStandardMaterial({ color: 0xb79a72, roughness: 1 });

    const W = 1.76;
    // Lower body: side profile (z forward, y up) extruded across the width.
    const lower = new THREE.Shape();
    lower.moveTo(-2.3, 0.32);
    lower.lineTo(2.3, 0.32);
    lower.lineTo(2.34, 0.62);
    lower.lineTo(2.22, 0.86);
    lower.lineTo(0.95, 0.92); // hood
    lower.lineTo(-1.2, 0.92);
    lower.lineTo(-2.2, 0.9); // boot
    lower.lineTo(-2.34, 0.64);
    lower.closePath();
    const lowerGeo = new THREE.ExtrudeGeometry(lower, {
      depth: W,
      bevelEnabled: true,
      bevelThickness: 0.04,
      bevelSize: 0.04,
      bevelSegments: 1,
    });
    lowerGeo.translate(0, 0, -W / 2);
    lowerGeo.rotateY(-Math.PI / 2); // profile x -> world z
    this.addMesh(lowerGeo, paintMat, this.body);

    // Cabin glass (narrower trapezoid) with painted pillars and roof on top.
    const cab = new THREE.Shape();
    cab.moveTo(0.95, 0.9);
    cab.lineTo(0.25, 1.42);
    cab.lineTo(-0.95, 1.42);
    cab.lineTo(-1.45, 0.9);
    cab.closePath();
    const CW = 1.54;
    const cabGeo = new THREE.ExtrudeGeometry(cab, { depth: CW, bevelEnabled: false });
    cabGeo.translate(0, 0, -CW / 2);
    cabGeo.rotateY(-Math.PI / 2);
    this.addMesh(cabGeo, glass, this.body);
    const roof = this.addMesh(new THREE.BoxGeometry(CW + 0.04, 0.07, 1.3), paintMat, this.body);
    roof.position.set(0, 1.45, -0.35);
    for (const side of [-1, 1]) {
      // B pillar
      const b = this.addMesh(new THREE.BoxGeometry(0.05, 0.5, 0.12), paintMat, this.body);
      b.position.set(side * (CW / 2 + 0.005), 1.16, -0.3);
      // A and C pillars follow the glass slope.
      const a = this.addMesh(new THREE.BoxGeometry(0.06, 0.66, 0.1), paintMat, this.body);
      a.position.set(side * (CW / 2 - 0.02), 1.16, 0.6);
      a.rotation.x = -0.93;
      const c = this.addMesh(new THREE.BoxGeometry(0.06, 0.72, 0.12), paintMat, this.body);
      c.position.set(side * (CW / 2 - 0.02), 1.16, -1.2);
      c.rotation.x = 0.8;
    }

    // Roof rack with a spare tyre and a jerrycan.
    const rackMat = black;
    for (const z of [0.1, -0.85]) {
      const bar = this.addMesh(new THREE.BoxGeometry(CW + 0.1, 0.04, 0.05), rackMat, this.body);
      bar.position.set(0, 1.54, z);
    }
    for (const x of [-0.7, 0.7]) {
      const rail = this.addMesh(new THREE.BoxGeometry(0.04, 0.04, 1.1), rackMat, this.body);
      rail.position.set(x, 1.58, -0.37);
    }
    const spare = this.addMesh(new THREE.CylinderGeometry(0.33, 0.33, 0.2, 14), rubber, this.body);
    spare.position.set(-0.25, 1.68, -0.4);
    const can = this.addMesh(new THREE.BoxGeometry(0.3, 0.22, 0.42), new THREE.MeshStandardMaterial({ color: 0x5b6b3a, roughness: 0.8 }), this.body);
    can.position.set(0.42, 1.67, -0.45);

    // Bumpers, grille, lights.
    for (const z of [2.38, -2.38]) {
      const bumper = this.addMesh(new THREE.BoxGeometry(W + 0.12, 0.12, 0.1), chrome, this.body);
      bumper.position.set(0, 0.42, z);
    }
    const grille = this.addMesh(new THREE.BoxGeometry(1.1, 0.22, 0.04), black, this.body);
    grille.position.set(0, 0.7, 2.35);
    for (const x of [-0.68, 0.68]) {
      const hl = this.addMesh(new THREE.CylinderGeometry(0.11, 0.11, 0.05, 12), lamp, this.body);
      hl.rotation.x = Math.PI / 2;
      hl.position.set(x, 0.7, 2.35);
      const tl = this.addMesh(new THREE.BoxGeometry(0.32, 0.14, 0.04), this.brakeLights, this.body);
      tl.position.set(x, 0.72, -2.37);
    }
    // Dusty lower skirt so it reads as a rally car.
    const skirt = this.addMesh(new THREE.BoxGeometry(W + 0.1, 0.12, 4.5), dirt, this.body);
    skirt.position.set(0, 0.36, 0);

    // Wheels: steer pivot (front) → spin group → tyre + hub.
    const tyreGeo = new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.26, 16);
    tyreGeo.rotateZ(Math.PI / 2);
    const hubGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.27, 10);
    hubGeo.rotateZ(Math.PI / 2);
    WHEEL_POS.forEach(([x, z], i) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, WHEEL_RADIUS, z);
      const spin = new THREE.Group();
      const tyre = new THREE.Mesh(tyreGeo, rubber);
      tyre.castShadow = true;
      spin.add(tyre, new THREE.Mesh(hubGeo, chrome));
      pivot.add(spin);
      this.root.add(pivot);
      this.wheels.push(spin);
      if (i < 2) this.steerPivots.push(pivot);
    });
    // Wheel arches (dark) so the wheels sit inside the body.
    for (const [x, z] of WHEEL_POS) {
      const arch = this.addMesh(new THREE.BoxGeometry(0.06, 0.32, 0.86), black, this.body);
      arch.position.set(x > 0 ? W / 2 + 0.03 : -W / 2 - 0.03, 0.6, z);
    }
  }

  private addMesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /**
   * steer = front wheel angle (rad), spin = wheel rotation (rad), roll/pitch = body lean (rad),
   * squat = body vertical offset (m), wheelDrop = per-wheel suspension extension (m).
   */
  pose(steer: number, spin: number, roll: number, pitch: number, squat: number, braking: boolean): void {
    for (const p of this.steerPivots) p.rotation.y = steer;
    for (const w of this.wheels) w.rotation.x = spin;
    this.body.rotation.set(pitch, 0, roll, "YXZ");
    this.body.position.y = squat;
    this.brakeLights.emissive.setHex(braking ? 0xff2a1a : 0x3a0505);
  }
}
