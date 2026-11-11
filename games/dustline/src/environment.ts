import * as THREE from "three";

/**
 * Sky, sun, ambient light, image-based reflections and atmospheric haze.
 * Basic setup (haze, hemisphere fill, warm low sun with a car-following shadow frustum).
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    const haze = new THREE.Color(0xe8cf9f);
    scene.background = haze;
    scene.fog = new THREE.Fog(haze, 140, 430);
    scene.add(new THREE.HemisphereLight(0xfff3dc, 0xa07a4a, 0.7));
    const sun = new THREE.DirectionalLight(0xffe3b5, 3.3);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -60;
    sc.right = 60;
    sc.top = 60;
    sc.bottom = -60;
    sc.near = 10;
    sc.far = 320;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.04;
    scene.add(sun, sun.target);
    this.sun = sun;
    void renderer;
  }

  /** Keep the shadow frustum centred on the car (snapped to texels to avoid shimmer). */
  update(center: THREE.Vector3): void {
    const texel = 120 / 2048;
    const x = Math.round(center.x / texel) * texel;
    const z = Math.round(center.z / texel) * texel;
    this.sun.target.position.set(x, center.y, z);
    this.sun.position.set(x + 100, center.y + 58, z - 95);
  }
}
