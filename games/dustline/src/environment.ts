import * as THREE from "three";

/** Sun position relative to the point it lights: low (~22°) late-afternoon sun, long shadows. */
const SUN_OFFSET = new THREE.Vector3(100, 58, -95);
const SHADOW_EXTENT = 60; // half size (m) of the shadow frustum around the car
const SHADOW_MAP = 2048;

const ZENITH = new THREE.Color(0x7fa6cf); // hazy pale blue overhead
const HORIZON = new THREE.Color(0xe6cfa8); // warm dust haze; also the fog colour
const SUN_GLOW = new THREE.Color(0xffd29a);
const SAND_BOUNCE = new THREE.Color(0xc99a62); // sunlit sand seen in reflections

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  // Centred on the camera so the dome is never approached or clipped.
  gl_Position = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
}
`;

const SKY_FRAG = /* glsl */ `
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uBelow;
uniform vec3 uSun;
uniform vec3 uSunDir;
uniform float uDisk;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  // Dense dusty haze at the horizon thinning to blue overhead; haze colour below the horizon.
  vec3 col = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.55));
  col = mix(col, uBelow, smoothstep(0.0, -0.1, up));
  // Forward scattering around the sun, faded out at the horizon so fogged terrain meets it cleanly.
  float s = max(dot(d, uSunDir), 0.0);
  float glow = pow(s, 6.0) * 0.3 + pow(s, 40.0) * 0.6;
  col += uSun * glow * smoothstep(-0.02, 0.25, up);
  col += uSun * smoothstep(0.9991, 0.9995, s) * uDisk;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function skyMaterial(below: THREE.Color, disk: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: ZENITH },
      uHorizon: { value: HORIZON },
      uBelow: { value: below },
      uSun: { value: SUN_GLOW },
      uSunDir: { value: SUN_OFFSET.clone().normalize() },
      uDisk: { value: disk },
    },
    vertexShader: SKY_VERT,
    fragmentShader: SKY_FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
  });
}

/**
 * Sky, sun, ambient light, image-based reflections and atmospheric haze.
 * The game calls update(carPos) every frame so the shadow map follows the car.
 */
export class Environment {
  readonly sun: THREE.DirectionalLight;

  constructor(scene: THREE.Scene, renderer: THREE.WebGLRenderer) {
    renderer.toneMappingExposure = 1.12;
    scene.background = HORIZON;
    // Linear haze: nearly clear around the car, distant dunes melt into the horizon.
    scene.fog = new THREE.Fog(HORIZON, 45, 640);

    // Sky dome: drawn first, never writes depth, so everything else simply paints over it.
    const sky = new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), skyMaterial(HORIZON, 4));
    sky.frustumCulled = false;
    sky.renderOrder = -1;
    sky.name = "sky";
    scene.add(sky);

    // Image-based lighting: a blurred copy of the sky over sunlit sand, baked once.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), skyMaterial(SAND_BOUNCE, 0));
    envScene.add(envSky);
    scene.environment = pmrem.fromScene(envScene, 0.03).texture;
    scene.environmentIntensity = 0.45;
    envSky.geometry.dispose();
    envSky.material.dispose();
    pmrem.dispose();

    // Cool fill from the sky, warm bounce from the sand.
    scene.add(new THREE.HemisphereLight(0xa8c2e0, 0xc4925a, 0.85));

    const sun = new THREE.DirectionalLight(0xffdcb0, 3.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const sc = sun.shadow.camera;
    sc.left = -SHADOW_EXTENT;
    sc.right = SHADOW_EXTENT;
    sc.top = SHADOW_EXTENT;
    sc.bottom = -SHADOW_EXTENT;
    sc.near = 20;
    sc.far = 300;
    sc.updateProjectionMatrix();
    // Small constant bias plus a normal offset of about one texel: no acne on the grazing-lit
    // dunes, and shadows still touch the tyres.
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.05;
    scene.add(sun, sun.target);
    this.sun = sun;
  }

  /** Keep the shadow frustum centred on the car (snapped to texels to avoid shimmer). */
  update(center: THREE.Vector3): void {
    const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP;
    const x = Math.round(center.x / texel) * texel;
    const z = Math.round(center.z / texel) * texel;
    this.sun.target.position.set(x, center.y, z);
    this.sun.position.set(x + SUN_OFFSET.x, center.y + SUN_OFFSET.y, z + SUN_OFFSET.z);
  }
}
