/**
 * Live-tunable gameplay values. The F1 tune panel edits this object in place, so systems must read
 * `ctx.tuning.x` every frame instead of caching values.
 */
export const DEFAULT_TUNING = {
  // Movement
  walkSpeed: 3.4,
  runSpeed: 5.8,
  tacticalSpeed: 7.6,
  crouchSpeed: 1.8,
  aimSpeedMul: 0.55,
  acceleration: 38,
  deceleration: 30,
  turnRate: 18,
  // Slide
  slideSpeed: 9.0,
  slideDuration: 0.7,
  // Vault
  vaultDuration: 0.5,
  vaultMaxHeight: 1.2,
  vaultReach: 1.4,
  vaultArc: 0.45,
  // Stamina
  staminaMax: 100,
  staminaRunDrain: 10,
  staminaTacticalDrain: 26,
  staminaRegen: 24,
  staminaRegenDelay: 0.9,
  staminaSlideCost: 14,
  staminaVaultCost: 8,
  staminaRecoverThreshold: 30,
  sprintToFireDelay: 0.15,
  // Weapons
  fireRateMul: 1,
  spreadMul: 1,
  recoilMul: 1,
  damageMul: 1,
  impulseMul: 1,
  reloadSpeedMul: 1,
  infiniteAmmo: 0,
  // Camera
  camDistanceMul: 1,
  camFov: 40,
  camFollow: 8,
  camAimLookAhead: 0.35,
  camShakeMul: 1,
  // World / physics
  gravity: 9.82,
  barrelMass: 18,
  explosionForce: 1,
  timeScale: 1,
  // Audio
  masterVolume: 0.7,
};

export type TuningKey = keyof typeof DEFAULT_TUNING;
export type Tuning = { [K in TuningKey]: number };

export interface TuneParam {
  key: TuningKey;
  label: string;
  group: "Movement" | "Stamina" | "Weapons" | "Camera" | "World" | "Audio";
  min: number;
  max: number;
  step: number;
  /** Render as an on/off switch (values 0/1). */
  toggle?: boolean;
}

export const TUNE_PARAMS: TuneParam[] = [
  { key: "walkSpeed", label: "Walk speed", group: "Movement", min: 1, max: 8, step: 0.1 },
  { key: "runSpeed", label: "Run speed", group: "Movement", min: 2, max: 12, step: 0.1 },
  { key: "tacticalSpeed", label: "Tactical sprint speed", group: "Movement", min: 3, max: 15, step: 0.1 },
  { key: "crouchSpeed", label: "Crouch speed", group: "Movement", min: 0.5, max: 5, step: 0.1 },
  { key: "aimSpeedMul", label: "Aim move multiplier", group: "Movement", min: 0.1, max: 1, step: 0.05 },
  { key: "acceleration", label: "Acceleration", group: "Movement", min: 5, max: 100, step: 1 },
  { key: "deceleration", label: "Deceleration", group: "Movement", min: 5, max: 100, step: 1 },
  { key: "turnRate", label: "Turn rate", group: "Movement", min: 2, max: 40, step: 0.5 },
  { key: "slideSpeed", label: "Slide speed", group: "Movement", min: 3, max: 16, step: 0.1 },
  { key: "slideDuration", label: "Slide duration", group: "Movement", min: 0.2, max: 1.5, step: 0.05 },
  { key: "vaultDuration", label: "Vault duration", group: "Movement", min: 0.2, max: 1.2, step: 0.02 },
  { key: "vaultMaxHeight", label: "Vault max height", group: "Movement", min: 0.5, max: 2, step: 0.05 },
  { key: "vaultReach", label: "Vault reach", group: "Movement", min: 0.6, max: 3, step: 0.05 },
  { key: "vaultArc", label: "Vault arc height", group: "Movement", min: 0, max: 1.5, step: 0.05 },
  { key: "staminaMax", label: "Max stamina", group: "Stamina", min: 20, max: 300, step: 5 },
  { key: "staminaRunDrain", label: "Run drain /s", group: "Stamina", min: 0, max: 60, step: 1 },
  { key: "staminaTacticalDrain", label: "Tactical drain /s", group: "Stamina", min: 0, max: 80, step: 1 },
  { key: "staminaRegen", label: "Regen /s", group: "Stamina", min: 1, max: 100, step: 1 },
  { key: "staminaRegenDelay", label: "Regen delay (s)", group: "Stamina", min: 0, max: 4, step: 0.1 },
  { key: "staminaSlideCost", label: "Slide cost", group: "Stamina", min: 0, max: 60, step: 1 },
  { key: "staminaVaultCost", label: "Vault cost", group: "Stamina", min: 0, max: 60, step: 1 },
  { key: "staminaRecoverThreshold", label: "Exhausted until", group: "Stamina", min: 0, max: 100, step: 1 },
  { key: "sprintToFireDelay", label: "Sprint-to-fire delay", group: "Stamina", min: 0, max: 1, step: 0.01 },
  { key: "fireRateMul", label: "Fire rate x", group: "Weapons", min: 0.2, max: 4, step: 0.05 },
  { key: "spreadMul", label: "Spread x", group: "Weapons", min: 0, max: 4, step: 0.05 },
  { key: "recoilMul", label: "Recoil x", group: "Weapons", min: 0, max: 4, step: 0.05 },
  { key: "damageMul", label: "Damage x", group: "Weapons", min: 0.1, max: 10, step: 0.1 },
  { key: "impulseMul", label: "Bullet impulse x", group: "Weapons", min: 0, max: 10, step: 0.1 },
  { key: "reloadSpeedMul", label: "Reload speed x", group: "Weapons", min: 0.25, max: 4, step: 0.05 },
  { key: "infiniteAmmo", label: "Infinite ammo", group: "Weapons", min: 0, max: 1, step: 1, toggle: true },
  { key: "camDistanceMul", label: "Camera distance x", group: "Camera", min: 0.4, max: 2.5, step: 0.05 },
  { key: "camFov", label: "Field of view", group: "Camera", min: 20, max: 80, step: 1 },
  { key: "camFollow", label: "Follow stiffness", group: "Camera", min: 1, max: 30, step: 0.5 },
  { key: "camAimLookAhead", label: "Aim look-ahead", group: "Camera", min: 0, max: 1, step: 0.01 },
  { key: "camShakeMul", label: "Screen shake x", group: "Camera", min: 0, max: 3, step: 0.05 },
  { key: "gravity", label: "Gravity", group: "World", min: 1, max: 30, step: 0.1 },
  { key: "barrelMass", label: "Barrel mass (kg)", group: "World", min: 2, max: 120, step: 1 },
  { key: "explosionForce", label: "Explosion force x", group: "World", min: 0, max: 5, step: 0.05 },
  { key: "timeScale", label: "Time scale", group: "World", min: 0.1, max: 2, step: 0.05 },
  { key: "masterVolume", label: "Master volume", group: "Audio", min: 0, max: 1, step: 0.01 },
];

const STORAGE_KEY = "kazz-ops.tuning.v1";

/** Defaults merged with any values saved by the tune panel. */
export function createTuning(): Tuning {
  const tuning: Tuning = { ...DEFAULT_TUNING };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Record<string, unknown>>;
      for (const key of Object.keys(DEFAULT_TUNING) as TuningKey[]) {
        const v = saved[key];
        if (typeof v === "number" && Number.isFinite(v)) tuning[key] = v;
      }
    }
  } catch {
    // Storage blocked (private mode, sandboxed iframe): defaults are fine.
  }
  return tuning;
}

export function saveTuning(tuning: Tuning): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tuning));
  } catch {
    // ignore
  }
}

export function resetTuning(tuning: Tuning): void {
  Object.assign(tuning, DEFAULT_TUNING);
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
