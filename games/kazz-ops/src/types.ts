/**
 * Shared contracts for every module. See SPEC.md for conventions.
 *
 * World conventions:
 *  - Y is up, the floor is the plane y = 0, units are metres.
 *  - Camera yaw 0 looks toward -Z, so "screen up" (W key) is world -Z and "screen right" (D key) is +X.
 *  - A facing/yaw angle θ means forward = (sin θ, 0, cos θ). Models are built facing local +Z,
 *    so `object.rotation.y = θ` points them along θ.
 */
import type * as THREE from "three";
import type * as CANNON from "cannon-es";
import type { EventBus } from "./events";
import type { Tuning } from "./config";
import type { Physics } from "./physics";
import type { Input } from "./input";
import type { CameraRig } from "./camera";
import type { Effects } from "./fx";
import type { AudioSystem } from "./audio";
import type { World } from "./world";
import type { Player } from "./player";
import type { WeaponSystem } from "./weapon";
import type { Hud } from "./hud";
import type { ZombieHorde } from "./zombies";

/** Material class of whatever a bullet hit. Drives impact FX + sounds. */
export type Surface =
  | "metal" // barrels, steel
  | "steel" // steel target plates (bright "ding")
  | "wood" // fences, crates, pallets
  | "concrete" // jersey barriers, walls
  | "plastic" // orange water-filled barriers, cones
  | "rubber" // tyres
  | "fabric" // sandbags
  | "flesh" // zombies
  | "ground"; // the floor

export type PropKind =
  | "barrel"
  | "explosiveBarrel"
  | "crate"
  | "fence"
  | "concreteBarrier"
  | "plasticBarrier"
  | "wall"
  | "target"
  | "sandbag"
  | "tire"
  | "pallet"
  | "cone";

/** Oriented box footprint (used for vault checks). yaw rotates the box around Y. */
export interface OrientedBox {
  center: THREE.Vector3; // centre of the box in world space (y = half height for floor props)
  halfExtents: THREE.Vector3; // half size along the box's local X/Y/Z
  yaw: number;
}

export interface Prop {
  id: number;
  kind: PropKind;
  /** Visual root. For dynamic props World copies the body transform onto it every frame. */
  object: THREE.Object3D;
  /** Physics body, if any. Static props have mass 0. */
  body: CANNON.Body | null;
  surface: Surface;
  dynamic: boolean;
  /** Low cover the player can vault over with SPACE (orange/concrete barriers, sandbags...). */
  vaultable: boolean;
  /** Footprint (static props only; dynamic props may leave it undefined). */
  bounds?: OrientedBox;
  health: number; // Infinity = indestructible
  maxHealth: number;
  alive: boolean;
}

export interface HitInfo {
  point: THREE.Vector3;
  normal: THREE.Vector3;
  distance: number;
  surface: Surface;
  body: CANNON.Body | null;
  prop: Prop | null;
}

export type WeaponSound = "suppressed" | "pistol" | "shotgun";

export interface WeaponDef {
  id: "carbine" | "pistol" | "shotgun";
  slot: number; // number key 1..3
  name: string; // shown in the HUD, e.g. "RK-9 CARBINE"
  magSize: number;
  reserveMax: number; // spare rounds carried at spawn / after reset
  fireRate: number; // rounds per minute
  auto: boolean; // hold to fire
  pellets: number; // rays per shot
  damage: number; // per pellet
  impulse: number; // physics impulse per pellet (N·s) before tuning.impulseMul
  spreadHip: number; // cone half-angle in degrees when hip firing, standing still
  spreadAim: number; // cone half-angle in degrees while aiming (RMB), standing still
  spreadMoveAdd: number; // extra degrees at full run speed (scaled by speed)
  crouchMul: number; // spread multiplier while crouched
  bloomPerShot: number; // degrees added per shot
  bloomMax: number; // cap on bloom degrees
  bloomRecovery: number; // degrees recovered per second
  recoilKick: number; // 0..1 camera/visual kick strength
  reloadTime: number; // seconds for a full mag reload (or per shell when reloadPerShell)
  reloadPerShell: boolean; // shotgun-style shell-by-shell, interruptible by firing
  range: number; // metres
  tracerEvery: number; // draw a tracer every N rounds (1 = every round)
  sound: WeaponSound;
  muzzleFlashScale: number;
}

export type MoveState =
  | "idle"
  | "walk"
  | "run"
  | "tactical" // double-shift sprint: fastest, weapon lowered, cannot fire
  | "crouch" // crouched, not moving
  | "crouchWalk"
  | "slide"
  | "vault";

/** Everything CharacterModel needs to pose itself for one frame. */
export interface CharacterAnimState {
  state: MoveState;
  speed: number; // horizontal speed in m/s
  /** Movement direction relative to facing: x = right, y = forward. Length 0..1. */
  moveLocal: THREE.Vector2;
  aiming: boolean; // RMB: rifle shouldered, tighter pose
  crouched: boolean;
  reloading: boolean;
  reloadProgress: number; // 0..1
  weaponId: WeaponDef["id"];
  /** Number of shots fired since the previous update (triggers recoil kicks). */
  shotsFired: number;
  vaultProgress: number; // 0..1 while vaulting, else 0
  slideProgress: number; // 0..1 while sliding, else 0
  /** True while the weapon must be lowered (tactical sprint, vault, sprint-to-fire delay). */
  weaponLowered: boolean;
}

export interface GameStats {
  shots: number;
  hits: number; // bullets that hit any prop (not the floor)
  targetsDropped: number;
  barrelsExploded: number;
  kills: number;
  headshots: number;
  fps: number;
}

export interface GameClock {
  time: number; // game seconds since start (scaled by tuning.timeScale)
  dt: number; // last frame's scaled delta
}

/**
 * Shared bag of systems. Built by Game in this order:
 * tuning, events, renderer, scene, canvas, uiRoot, clock, stats, physics, input, cameraRig, fx, audio,
 * world, player, weapons, zombies, hud. A constructor may only touch fields created before it;
 * anything else must be read later (in update/build/reset).
 */
export interface GameContext {
  tuning: Tuning;
  events: EventBus;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  canvas: HTMLCanvasElement;
  /** Absolutely positioned overlay above the canvas for all DOM UI (HUD, tune panel, touch). */
  uiRoot: HTMLElement;
  clock: GameClock;
  stats: GameStats;
  physics: Physics;
  input: Input;
  cameraRig: CameraRig;
  fx: Effects;
  audio: AudioSystem;
  world: World;
  player: Player;
  weapons: WeaponSystem;
  zombies: ZombieHorde;
  hud: Hud;
}
