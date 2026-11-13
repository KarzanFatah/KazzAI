import type * as THREE from "three";
import type { HitInfo, PropKind, Surface, WeaponDef } from "./types";
import type { ZombieKind } from "./zombies";

/**
 * Every gameplay event. Producers emit, any system may listen (audio, HUD, camera shake...).
 * Payload vectors may be reused by the producer after emit returns: clone them if you keep them.
 */
export interface GameEventMap {
  /** One trigger pull (a shotgun shot is one event). origin = muzzle, dir = aim direction. */
  shot: { weapon: WeaponDef; origin: THREE.Vector3; dir: THREE.Vector3 };
  /** One bullet/pellet hit something (floor included). */
  impact: { hit: HitInfo; dir: THREE.Vector3; weapon: WeaponDef };
  dryFire: { weapon: WeaponDef };
  reloadStart: { weapon: WeaponDef; duration: number };
  reloadStage: {
    weapon: WeaponDef;
    stage: "magOut" | "magIn" | "bolt" | "shell" | "pump";
  };
  reloadEnd: { weapon: WeaponDef };
  weaponSwitch: { weapon: WeaponDef };
  explosion: { position: THREE.Vector3; radius: number };
  /** A dynamic prop bumped into something. strength 0..1 (from impact velocity). */
  propCollision: {
    position: THREE.Vector3;
    surface: Surface;
    strength: number;
  };
  propDestroyed: { position: THREE.Vector3; kind: PropKind };
  /** A steel target plate was knocked down. total = targets dropped this session. */
  targetHit: { position: THREE.Vector3; total: number };
  footstep: { position: THREE.Vector3; intensity: number };
  vault: { position: THREE.Vector3 };
  slide: { position: THREE.Vector3 };
  crouch: { crouched: boolean };
  tacticalStart: Record<string, never>;
  staminaExhausted: Record<string, never>;
  cameraMode: { name: string };
  /** A bullet hit a zombie (not necessarily fatal). */
  zombieHit: { position: THREE.Vector3; headshot: boolean };
  zombieKilled: {
    position: THREE.Vector3;
    headshot: boolean;
    kind: ZombieKind;
    /** Kills this session. */
    total: number;
  };
  /** Ambient moan from a zombie (audio picks a few, by distance). */
  zombieGroan: { position: THREE.Vector3; kind: ZombieKind };
  /** A zombie swings at the player (the hit itself is playerHurt). */
  zombieAttack: { position: THREE.Vector3 };
  playerHurt: { amount: number; health: number; from: THREE.Vector3 };
  playerDied: { wave: number; kills: number };
  waveStart: { wave: number; count: number };
  waveCleared: { wave: number };
  pickup: { kind: "ammo" | "health"; position: THREE.Vector3 };
  /** Short message for the HUD toast line. */
  toast: { text: string };
  reset: Record<string, never>;
}

export type GameEventName = keyof GameEventMap;
type Handler<K extends GameEventName> = (payload: GameEventMap[K]) => void;

export class EventBus {
  private handlers: { [K in GameEventName]?: Handler<K>[] } = {};

  on<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    const list = (this.handlers[name] ??= []) as Handler<K>[];
    list.push(fn);
    return () => this.off(name, fn);
  }

  off<K extends GameEventName>(name: K, fn: Handler<K>): void {
    const list = this.handlers[name] as Handler<K>[] | undefined;
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit<K extends GameEventName>(name: K, payload: GameEventMap[K]): void {
    const list = this.handlers[name] as Handler<K>[] | undefined;
    if (!list) return;
    for (const fn of list.slice()) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${name}" failed`, err);
      }
    }
  }
}
