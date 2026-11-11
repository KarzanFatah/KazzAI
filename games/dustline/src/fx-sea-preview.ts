import * as THREE from "three";
import { Effects, TireTracks } from "./fx";
import { Sea } from "./sea";
import { Terrain } from "./terrain";
import { Track } from "./track";

const view = new URLSearchParams(location.search).get("view") ?? "dust";
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const haze = new THREE.Color(0xe8cf9f);
scene.background = haze;
scene.fog = new THREE.Fog(haze, 140, 430);
scene.add(new THREE.HemisphereLight(0xfff3dc, 0xb88d58, 1.05));
const sun = new THREE.DirectionalLight(0xffe3b5, 2.7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 10, far: 320 });
sun.shadow.bias = -0.0006;
scene.add(sun, sun.target);

const track = new Track();
const terrain = new Terrain(track);
scene.add(terrain.buildMesh());
const sea = new Sea(scene, terrain);
const fx = new Effects(scene, terrain);
const tracks = new TireTracks(scene, terrain, 4);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, 900);

const car = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.3, 4.6), new THREE.MeshStandardMaterial({ color: 0xf2efe8 }));
car.castShadow = true;
scene.add(car);

// Drive a drifting arc: centre c, radius r, yaw offset from the velocity (slip angle).
const c = view === "sea" ? new THREE.Vector3(10, 0, -128) : new THREE.Vector3(-150, 0, 60);
const r = 22;
const pos = new THREE.Vector3();
const vel = new THREE.Vector3();
const side = new THREE.Vector3();
const n = new THREE.Vector3();
const wheel = new THREE.Vector3();
const dir = new THREE.Vector3();
let time = 0;
let clock = 0;
const frames = 170;
for (let f = 0; f < frames; f++) {
  const dt = 1 / 60;
  time += dt;
  const ang = time * 1.1;
  pos.set(c.x + Math.cos(ang) * r, 0, c.z + Math.sin(ang) * r);
  pos.y = terrain.heightAt(pos.x, pos.z);
  vel.set(-Math.sin(ang), 0, Math.cos(ang)).multiplyScalar(r * 1.1);
  const yaw = Math.atan2(vel.x, vel.z) + 0.55; // drift angle
  car.position.copy(pos).setY(pos.y + 0.8);
  car.rotation.y = yaw;
  side.set(-Math.cos(yaw), 0, Math.sin(yaw));
  terrain.normalAt(pos.x, pos.z, n);
  const fwdX = Math.sin(yaw), fwdZ = Math.cos(yaw);
  for (let i = 0; i < 4; i++) {
    const fz = i < 2 ? 1.4 : -1.4;
    const sx = i % 2 === 0 ? -0.8 : 0.8;
    wheel.set(pos.x + fwdX * fz + side.x * sx, 0, pos.z + fwdZ * fz + side.z * sx);
    wheel.y = terrain.heightAt(wheel.x, wheel.z);
    tracks.add(i, wheel, n, side, 0.9);
  }
  clock += dt;
  if (clock >= 1 / 30) {
    clock = 0;
    for (let i = 2; i < 4; i++) {
      const sx = i % 2 === 0 ? -0.8 : 0.8;
      wheel.set(pos.x - fwdX * 1.4 + side.x * sx, 0, pos.z - fwdZ * 1.4 + side.z * sx);
      wheel.y = terrain.heightAt(wheel.x, wheel.z);
      if (view === "sea" && wheel.z < terrain.shorelineZ(wheel.x) + 2) fx.splash(wheel, vel, 1);
      else if (view !== "boost") fx.dust(wheel, vel, 1);
    }
    if (f > frames - 20) {
      dir.set(-fwdX, 0, -fwdZ);
      wheel.set(pos.x - fwdX * 2.4, pos.y + 0.45, pos.z - fwdZ * 2.4);
      fx.boostPuff(wheel, dir);
    }
  }
  if (view !== "boost" && f === frames - 60) fx.landing(new THREE.Vector3(c.x - r, terrain.heightAt(c.x - r, c.z), c.z), 1);
  if (view !== "boost" && f === frames - 15) fx.impact(new THREE.Vector3(c.x + 4, terrain.heightAt(c.x + 4, c.z) + 0.5, c.z + 4), 1);
  fx.update(dt, camera);
  tracks.update(dt);
}
sea.update(time);
sun.target.position.copy(pos);
sun.position.set(pos.x + 90, pos.y + 70, pos.z - 100);

if (view === "sea") {
  camera.position.set(pos.x - 5, pos.y + 30, pos.z + 30);
  camera.lookAt(pos.x, pos.y, pos.z - 12);
} else if (view === "boost") {
  camera.position.set(pos.x + 6, pos.y + 7, pos.z + 6);
  camera.lookAt(pos);
} else {
  const back = Math.atan2(vel.x, vel.z);
  camera.position.set(pos.x - Math.sin(back) * 24, pos.y + 27, pos.z - Math.cos(back) * 24);
  camera.lookAt(pos);
}
renderer.render(scene, camera);
(window as unknown as { __ready: boolean }).__ready = true;
{
  const g = (fx as unknown as { glowPool: { pos: Float32Array; dyn: Float32Array } }).glowPool;
  const out: string[] = [];
  for (let i = 0; i < 300; i++) if (g.dyn[i * 2 + 1] > 0) out.push([g.pos[i * 3], g.pos[i * 3 + 2], g.dyn[i * 2], g.dyn[i * 2 + 1]].map((v) => v.toFixed(2)).join(","));
  console.log("glow:\n" + out.join("\n"));
}
