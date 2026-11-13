import type * as THREE from "three";
import type { GameContext, Surface, WeaponDef, WeaponSound } from "./types";
import type { ZombieKind } from "./zombies";

type Vec3 = THREE.Vector3Like;

/** Simultaneous voices; beyond this the least important, oldest voice is stolen. */
const MAX_VOICES = 24;
/** Fade applied to a stolen voice before its slot is reused (s). */
const STEAL_FADE = 0.012;
/** Scheduling lead so envelopes never start in the past (s). */
const LEAD = 0.004;
/** Envelope floor for exponential ramps (exponential ramps cannot reach 0). */
const SILENT = 0.0001;
/** Sounds closer than this (m) play at full level. */
const NEAR = 2;
const DEFAULT_RANGE = 40;
/** Lateral offset (m, along the screen's right axis) that reaches MAX_PAN. */
const PAN_WIDTH = 14;
const MAX_PAN = 0.7;
/** Air absorption: per-voice lowpass at AIR_MAX * exp(-distance / AIR_FALLOFF). */
const AIR_MAX = 20000;
const AIR_FALLOFF = 28;
/** Distant sounds get proportionally more room: send * (1 + DISTANT_SEND * k). */
const DISTANT_SEND = 1.5;
const MASTER_TRIM = 0.9;
/** Time constant (s) for master volume changes. */
const VOLUME_SMOOTH = 0.08;
/** Room: two cross-fed, darkened delay lines (outdoor slap off berms and walls). */
const ROOM_DELAYS = [0.083, 0.131];
const ROOM_FEEDBACK = 0.42;
const ROOM_TONE = 2400;
const ROOM_LEVEL = 0.35;
/** The pump action after a shotgun blast, and how long a duplicate "pump" event is ignored. */
const PUMP_DELAY = 0.4;
const PUMP_DEDUPE = 0.65;
/** Shotgun pellets each make a quieter impact. */
const PELLET_LEVEL = 0.55;
/** At most this many zombie groans overlap; the rest are skipped. */
const MAX_GROANS = 3;
/** Heartbeat below this health; its interval shrinks as health drops. */
const HEARTBEAT_HEALTH = 30;
const HEARTBEAT_SLOW = 0.95;
const HEARTBEAT_FAST = 0.55;

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
/** Uniform random number in [lo, hi). */
const rand = (lo: number, hi: number): number => lo + Math.random() * (hi - lo);
/** 1 ± amount, uniformly distributed. */
const jitter = (amount: number): number => 1 + (Math.random() * 2 - 1) * amount;

// ---------------------------------------------------------------------------------------------
// Noise buffers (generated once per context, looped from a random offset on every play)
// ---------------------------------------------------------------------------------------------

interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
  /** Sparse random pops: gravel, debris, fire. */
  crackle: AudioBuffer;
}

type Fill = (out: Float32Array, sampleRate: number) => void;

const fillWhite: Fill = (out) => {
  for (let i = 0; i < out.length; i++) out[i] = Math.random() * 2 - 1;
};

/**
 * Paul Kellet's economy pink-noise filter, then a ~60 Hz one-pole highpass: sub-bass that short
 * layers can't resolve would otherwise make their loudness vary wildly between plays.
 */
const fillPink: Fill = (out, sampleRate) => {
  const hp = Math.exp((-2 * Math.PI * 60) / sampleRate);
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let lastIn = 0;
  let lastOut = 0;
  for (let i = 0; i < out.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    const pink = b0 + b1 + b2 + w * 0.1848;
    lastOut = hp * (lastOut + pink - lastIn);
    lastIn = pink;
    out[i] = lastOut;
  }
};

/** Leaky integrated white noise. */
const fillBrown: Fill = (out) => {
  let last = 0;
  for (let i = 0; i < out.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    out[i] = last;
  }
};

const fillCrackle: Fill = (out, sampleRate) => {
  const decay = Math.exp(-1 / (sampleRate * 0.0018));
  const chance = 110 / sampleRate;
  let env = 0;
  for (let i = 0; i < out.length; i++) {
    if (Math.random() < chance) env = 0.15 + Math.random() ** 2 * 0.85;
    env *= decay;
    out[i] = env * (Math.random() * 2 - 1);
  }
};

/**
 * Mono buffer whose tail is crossfaded into its head so it loops without clicks. Normalised to
 * the given RMS, or to a 0.95 peak when rms is 0.
 */
function noiseBuffer(
  ac: BaseAudioContext,
  seconds: number,
  fill: Fill,
  rms: number,
): AudioBuffer {
  const sr = ac.sampleRate;
  const length = Math.floor(seconds * sr);
  const fade = Math.floor(0.05 * sr);
  const raw = new Float32Array(length + fade);
  fill(raw, sr);

  let mean = 0;
  for (let i = 0; i < raw.length; i++) mean += raw[i];
  mean /= raw.length;

  const buffer = ac.createBuffer(1, length, sr);
  const out = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) out[i] = raw[i] - mean;
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    out[i] = (raw[i] - mean) * a + (raw[length + i] - mean) * (1 - a);
  }

  let peak = 0;
  let sum = 0;
  for (let i = 0; i < length; i++) {
    peak = Math.max(peak, Math.abs(out[i]));
    sum += out[i] * out[i];
  }
  const gain = rms > 0 ? rms / Math.sqrt(sum / length) : 0.95 / peak;
  for (let i = 0; i < length; i++) out[i] = clamp(out[i] * gain, -1, 1);
  return buffer;
}

function buildNoiseBank(ac: BaseAudioContext): NoiseBank {
  return {
    white: noiseBuffer(ac, 1.5, fillWhite, 0.3),
    pink: noiseBuffer(ac, 2, fillPink, 0.3),
    brown: noiseBuffer(ac, 2.5, fillBrown, 0.3),
    crackle: noiseBuffer(ac, 2.5, fillCrackle, 0),
  };
}

// ---------------------------------------------------------------------------------------------
// Voices
// ---------------------------------------------------------------------------------------------

interface Envelope {
  /** Start offset within the voice (s). */
  at?: number;
  /** Total length: attack, hold, then exponential decay to silence (s). */
  dur: number;
  gain: number;
  attack?: number;
  hold?: number;
}

interface NoiseLayer extends Envelope {
  filter?: BiquadFilterType;
  freq?: number;
  /** Filter sweep target, reached at the end of the layer. */
  freqTo?: number;
  q?: number;
  /** Playback-rate multiplier on top of the voice pitch. */
  rate?: number;
}

interface ToneLayer extends Envelope {
  type?: OscillatorType;
  freq: number;
  freqTo?: number;
  /** Seconds to glide from freq to freqTo (default: the whole layer). */
  glide?: number;
  /** Optional filter on the oscillator (formants for voices, darkening for drones). */
  filter?: BiquadFilterType;
  cutoff?: number;
  cutoffTo?: number;
  q?: number;
}

/** One resonant mode of a struck object, relative to the base pitch, gain and decay. */
interface Mode {
  ratio: number;
  gain: number;
  decay: number;
  type?: OscillatorType;
}

interface VoiceOptions {
  gain: number;
  /** Audible range in metres (silent beyond). */
  range?: number;
  /** Room send 0..1 (grows with distance). */
  send?: number;
  /** Higher is harder to steal: steps 0, impacts 1, weapons/UI 2, explosions 3. */
  priority?: number;
  /** Base pitch multiplier. */
  pitch?: number;
  /** Random variation per play, as a fraction. */
  pitchVar?: number;
  gainVar?: number;
  /** Start this many seconds later. */
  delay?: number;
}

/**
 * A reusable voice slot: persistent bus → air lowpass → panner (+ room send). Each play schedules
 * short-lived source → [filter] → envelope layers into the bus; layers disconnect themselves when
 * they end.
 */
class Voice {
  /** Audio time the current sound starts (layers are scheduled relative to it). */
  startTime = 0;
  /** Audio time the last layer finishes; the slot is free after this. */
  endTime = 0;
  priority = 0;

  private readonly bus: GainNode;
  private readonly air: BiquadFilterNode;
  private readonly panner: StereoPannerNode | null;
  private readonly send: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly maxHz: number;
  private rate = 1;

  constructor(
    private readonly ac: BaseAudioContext,
    master: AudioNode,
    room: AudioNode,
  ) {
    this.maxHz = ac.sampleRate * 0.45;
    this.bus = ac.createGain();
    this.bus.gain.value = 0;
    this.air = ac.createBiquadFilter();
    this.air.type = "lowpass";
    this.air.frequency.value = this.maxHz;
    this.send = ac.createGain();
    this.send.gain.value = 0;
    this.panner =
      typeof ac.createStereoPanner === "function" ? ac.createStereoPanner() : null;

    this.bus.connect(this.air);
    const out = this.panner ? this.air.connect(this.panner) : this.air;
    out.connect(master);
    out.connect(this.send).connect(room);
  }

  /** Point the slot at a new sound. Call after silence() when stealing. */
  begin(
    t0: number,
    gain: number,
    cutoff: number,
    pan: number,
    send: number,
    rate: number,
    priority: number,
  ): void {
    this.sources.length = 0;
    this.startTime = t0;
    this.endTime = t0;
    this.rate = rate;
    this.priority = priority;
    this.bus.gain.setValueAtTime(gain, t0);
    this.air.frequency.setValueAtTime(Math.min(cutoff, this.maxHz), t0);
    this.panner?.pan.setValueAtTime(pan, t0);
    this.send.gain.setValueAtTime(send, t0);
  }

  /** Quickly fade out and stop whatever the slot is playing (voice stealing). */
  silence(now: number): void {
    const g = this.bus.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(0, now + STEAL_FADE);
    for (const source of this.sources) source.stop(now + STEAL_FADE);
    this.sources.length = 0;
  }

  /** Filtered noise burst from a looped buffer (random start offset for variety). */
  noise(buffer: AudioBuffer, layer: NoiseLayer): void {
    if (layer.gain <= SILENT) return;
    const start = this.startTime + (layer.at ?? 0);
    const source = this.ac.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = (layer.rate ?? 1) * this.rate;
    const env = this.envelope(start, layer);
    let filter: BiquadFilterNode | null = null;
    if (layer.filter) {
      filter = this.filter(layer.filter, start, layer);
      source.connect(filter).connect(env);
    } else {
      source.connect(env);
    }
    source.start(start, Math.random() * buffer.duration * 0.9);
    this.finish(source, start + layer.dur, env, filter);
  }

  /** Oscillator with an optional exponential pitch glide. */
  tone(layer: ToneLayer): void {
    if (layer.gain <= SILENT) return;
    const start = this.startTime + (layer.at ?? 0);
    const osc = this.ac.createOscillator();
    osc.type = layer.type ?? "sine";
    osc.frequency.setValueAtTime(this.hz(layer.freq), start);
    if (layer.freqTo) {
      osc.frequency.exponentialRampToValueAtTime(
        this.hz(layer.freqTo),
        start + (layer.glide ?? layer.dur),
      );
    }
    const env = this.envelope(start, layer);
    let filter: BiquadFilterNode | null = null;
    if (layer.filter) {
      filter = this.filterNode(layer.filter, start, layer.dur, layer.cutoff, layer.cutoffTo, layer.q);
      osc.connect(filter).connect(env);
    } else {
      osc.connect(env);
    }
    osc.start(start);
    this.finish(osc, start + layer.dur, env, filter);
  }

  /** Struck resonance: one exponentially decaying partial per mode. */
  ring(base: number, modes: readonly Mode[], gain: number, decay: number, at = 0): void {
    for (const mode of modes) {
      this.tone({
        at,
        type: mode.type,
        freq: base * mode.ratio * jitter(0.01),
        dur: decay * mode.decay,
        gain: gain * mode.gain,
      });
    }
  }

  private envelope(start: number, layer: Envelope): GainNode {
    const env = this.ac.createGain();
    const g = env.gain;
    const peak = start + Math.max(layer.attack ?? 0.001, 0.0005);
    const hold = peak + (layer.hold ?? 0);
    g.value = 0;
    g.setValueAtTime(0, start);
    g.linearRampToValueAtTime(layer.gain, peak);
    if (hold > peak) g.setValueAtTime(layer.gain, hold);
    g.exponentialRampToValueAtTime(SILENT, Math.max(start + layer.dur, hold + 0.005));
    env.connect(this.bus);
    return env;
  }

  private filter(type: BiquadFilterType, start: number, layer: NoiseLayer): BiquadFilterNode {
    return this.filterNode(type, start, layer.dur, layer.freq, layer.freqTo, layer.q);
  }

  private filterNode(
    type: BiquadFilterType,
    start: number,
    dur: number,
    freq = 1000,
    freqTo?: number,
    q?: number,
  ): BiquadFilterNode {
    const filter = this.ac.createBiquadFilter();
    filter.type = type;
    filter.frequency.setValueAtTime(this.hz(freq), start);
    if (freqTo) filter.frequency.exponentialRampToValueAtTime(this.hz(freqTo), start + dur);
    if (q !== undefined) filter.Q.value = q;
    return filter;
  }

  private hz(freq: number): number {
    return Math.min(freq * this.rate, this.maxHz);
  }

  /** Schedule the stop, extend the slot's busy time and self-disconnect on 'ended'. */
  private finish(
    source: AudioScheduledSourceNode,
    end: number,
    env: GainNode,
    filter: BiquadFilterNode | null,
  ): void {
    source.stop(end + 0.02);
    source.onended = () => {
      source.disconnect();
      filter?.disconnect();
      env.disconnect();
    };
    this.sources.push(source);
    this.endTime = Math.max(this.endTime, end + 0.03);
  }
}

/** Allows at most `max` plays per `period` seconds. */
class Throttle {
  private windowStart = -Infinity;
  private count = 0;

  constructor(
    private readonly period: number,
    private readonly max: number,
  ) {}

  allow(now: number): boolean {
    if (now - this.windowStart >= this.period) {
      this.windowStart = now;
      this.count = 0;
    }
    return this.count++ < this.max;
  }
}

// ---------------------------------------------------------------------------------------------
// Engine: graph, voice allocation, spatialisation
// ---------------------------------------------------------------------------------------------

/**
 * voices → master gain → compressor → destination, plus a shared room send. Works with any
 * BaseAudioContext (an OfflineAudioContext renders the same sounds for tests).
 */
export class SoundEngine {
  readonly noise: NoiseBank;

  private readonly master: GainNode;
  private readonly voices: Voice[] = [];
  private listenerX = 0;
  private listenerY = 0;
  private listenerZ = 0;
  private rightX = 1;
  private rightZ = 0;
  private volume = -1;

  constructor(readonly ac: BaseAudioContext) {
    const compressor = ac.createDynamicsCompressor();
    compressor.threshold.value = -16;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    compressor.connect(ac.destination);

    this.master = ac.createGain();
    this.master.gain.value = 0;
    this.master.connect(compressor);

    const room = this.buildRoom();
    for (let i = 0; i < MAX_VOICES; i++) {
      this.voices.push(new Voice(ac, this.master, room));
    }
    this.noise = buildNoiseBank(ac);
  }

  get now(): number {
    return this.ac.currentTime;
  }

  /** Master volume 0..1; changes glide at audio rate. */
  setVolume(volume: number): void {
    if (volume === this.volume) return;
    const gain = this.master.gain;
    if (this.volume < 0) gain.value = volume * MASTER_TRIM;
    else gain.setTargetAtTime(volume * MASTER_TRIM, this.ac.currentTime, VOLUME_SMOOTH);
    this.volume = volume;
  }

  /** Listener at `position`; panning follows the camera's screen-right axis. */
  setListener(position: Vec3, camera: THREE.Object3D): void {
    this.listenerX = position.x;
    this.listenerY = position.y;
    this.listenerZ = position.z;
    const m = camera.matrixWorld.elements;
    const len = Math.hypot(m[0], m[2]);
    if (len > 1e-3) {
      this.rightX = m[0] / len;
      this.rightZ = m[2] / len;
    }
  }

  /**
   * Claim a voice for a sound at `pos` (null = at the listener, unpanned and unfiltered).
   * Returns null when the sound is out of range or every voice is busy with something more
   * important.
   */
  voice(pos: Vec3 | null, o: VoiceOptions): Voice | null {
    let att = 1;
    let cutoff = AIR_MAX;
    let pan = 0;
    let k = 0;
    if (pos) {
      const dx = pos.x - this.listenerX;
      const dy = pos.y - this.listenerY;
      const dz = pos.z - this.listenerZ;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const range = o.range ?? DEFAULT_RANGE;
      k = clamp((d - NEAR) / (range - NEAR), 0, 1);
      att = (1 - k) * (1 - k);
      if (att < 0.003) return null;
      cutoff = AIR_MAX * Math.exp(-d / AIR_FALLOFF);
      pan = clamp((dx * this.rightX + dz * this.rightZ) / PAN_WIDTH, -MAX_PAN, MAX_PAN);
    }

    const now = this.ac.currentTime;
    const priority = o.priority ?? 1;
    const slot = this.claim(now, priority);
    if (!slot) return null;
    let t0 = now + LEAD + (o.delay ?? 0);
    if (slot.endTime > now) {
      slot.silence(now);
      t0 += STEAL_FADE;
    }
    slot.begin(
      t0,
      o.gain * att * jitter(o.gainVar ?? 0.1),
      cutoff,
      pan,
      (o.send ?? 0) * (1 + DISTANT_SEND * k),
      (o.pitch ?? 1) * jitter(o.pitchVar ?? 0.05),
      priority,
    );
    return slot;
  }

  /** A free voice, else the oldest of the least important ones (if not above `priority`). */
  private claim(now: number, priority: number): Voice | null {
    let victim: Voice | null = null;
    for (const v of this.voices) {
      if (v.endTime <= now) return v;
      if (
        !victim ||
        v.priority < victim.priority ||
        (v.priority === victim.priority && v.startTime < victim.startTime)
      ) {
        victim = v;
      }
    }
    return victim && victim.priority <= priority ? victim : null;
  }

  /** Two cross-fed lowpassed delay lines. Returns the send input. */
  private buildRoom(): AudioNode {
    const ac = this.ac;
    const input = ac.createBiquadFilter();
    input.type = "highpass"; // keep the low end dry and tight
    input.frequency.value = 220;
    const output = ac.createGain();
    output.gain.value = ROOM_LEVEL;
    output.connect(this.master);

    const lines = ROOM_DELAYS.map((seconds) => {
      const delay = ac.createDelay(0.5);
      delay.delayTime.value = seconds;
      const tone = ac.createBiquadFilter();
      tone.type = "lowpass";
      tone.frequency.value = ROOM_TONE;
      input.connect(delay).connect(tone).connect(output);
      return { delay, tone };
    });
    lines.forEach((line, i) => {
      const feedback = ac.createGain();
      feedback.gain.value = ROOM_FEEDBACK;
      line.tone.connect(feedback).connect(lines[(i + 1) % lines.length].delay);
    });
    return input;
  }
}

// ---------------------------------------------------------------------------------------------
// Sound recipes
// ---------------------------------------------------------------------------------------------

/** Oil drum shell modes (inharmonic → metallic). */
const BARREL_MODES: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.32, gain: 0.55, decay: 0.7 },
  { ratio: 3.86, gain: 0.35, decay: 0.5, type: "triangle" },
  { ratio: 5.41, gain: 0.2, decay: 0.32 },
];

/** Thick steel plate modes: bright, long ring. */
const PLATE_MODES: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2.76, gain: 0.5, decay: 0.75 },
  { ratio: 5.4, gain: 0.3, decay: 0.5 },
  { ratio: 8.93, gain: 0.14, decay: 0.3 },
];

/** Near-harmonic "reward" bell for a dropped target. */
const BELL_MODES: readonly Mode[] = [
  { ratio: 1, gain: 1, decay: 1 },
  { ratio: 2, gain: 0.3, decay: 0.6 },
  { ratio: 3.01, gain: 0.12, decay: 0.4 },
];

/** Bullet impact per surface: voice settings plus the layers to play. */
interface ImpactRecipe {
  gain: number;
  range: number;
  send: number;
  pitchVar: number;
  play(v: Voice, n: NoiseBank): void;
}

const IMPACTS: Record<Surface, ImpactRecipe> = {
  metal: {
    gain: 0.5,
    range: 45,
    send: 0.35,
    pitchVar: 0.08,
    play(v, n) {
      v.noise(n.white, { dur: 0.015, gain: 1, filter: "highpass", freq: 3000 }); // strike tick
      v.noise(n.white, { dur: 0.05, gain: 1.8, filter: "bandpass", freq: 900, q: 1.5 });
      v.ring(rand(380, 620), BARREL_MODES, 0.22, 0.55);
    },
  },
  steel: {
    gain: 0.52,
    range: 90,
    send: 0.45,
    pitchVar: 0.03,
    play(v, n) {
      v.noise(n.white, { dur: 0.012, gain: 1.2, filter: "highpass", freq: 3500 });
      v.ring(rand(880, 1040), PLATE_MODES, 0.25, 1.5);
    },
  },
  wood: {
    gain: 0.55,
    range: 40,
    send: 0.25,
    pitchVar: 0.08,
    play(v, n) {
      v.noise(n.white, { dur: 0.016, gain: 0.8, filter: "highpass", freq: 2500 }); // crack
      v.noise(n.white, { dur: 0.08, gain: 2.4, filter: "bandpass", freq: 680, q: 2.5 }); // hollow knock
      v.tone({ dur: 0.09, gain: 0.4, freq: 230, freqTo: 140 });
    },
  },
  concrete: {
    gain: 0.55,
    range: 40,
    send: 0.3,
    pitchVar: 0.08,
    play(v, n) {
      v.noise(n.white, { dur: 0.035, gain: 1.1, filter: "highpass", freq: 2400 }); // chip
      v.noise(n.white, { dur: 0.07, gain: 1.6, filter: "bandpass", freq: 1500, q: 1 });
      v.noise(n.crackle, { at: 0.008, dur: 0.2, gain: 0.5, filter: "highpass", freq: 2000 }); // grit
    },
  },
  plastic: {
    gain: 0.48,
    range: 35,
    send: 0.2,
    pitchVar: 0.08,
    play(v, n) {
      v.tone({ dur: 0.07, gain: 0.45, freq: 310, freqTo: 170 }); // thock
      v.noise(n.white, { dur: 0.06, gain: 2.2, filter: "bandpass", freq: 620, q: 3 });
      v.tone({ dur: 0.12, gain: 0.25, freq: 120, freqTo: 90 }); // water mass
    },
  },
  rubber: {
    gain: 0.46,
    range: 30,
    send: 0.15,
    pitchVar: 0.1,
    play(v, n) {
      v.tone({ dur: 0.11, gain: 0.55, freq: 125, freqTo: 70 });
      v.noise(n.pink, { dur: 0.08, gain: 0.8, filter: "lowpass", freq: 450 });
    },
  },
  fabric: {
    gain: 0.42,
    range: 30,
    send: 0.15,
    pitchVar: 0.1,
    play(v, n) {
      v.noise(n.pink, { dur: 0.09, gain: 1.2, filter: "lowpass", freq: 600 });
      v.tone({ dur: 0.08, gain: 0.35, freq: 150, freqTo: 90 });
      v.noise(n.crackle, { dur: 0.08, gain: 0.25, filter: "bandpass", freq: 2500, q: 0.8 }); // sand
    },
  },
  flesh: {
    gain: 0.5,
    range: 35,
    send: 0.1,
    pitchVar: 0.12,
    play(v, n) {
      v.tone({ dur: 0.1, gain: 0.5, freq: 140, freqTo: 65 }); // wet thud
      v.noise(n.pink, { dur: 0.09, gain: 1.4, filter: "lowpass", freq: 700, freqTo: 300 });
      v.noise(n.white, { dur: 0.05, gain: 1.2, filter: "bandpass", freq: 420, q: 2.5 }); // squelch
    },
  },
  ground: {
    gain: 0.55,
    range: 35,
    send: 0.15,
    pitchVar: 0.1,
    play(v, n) {
      v.noise(n.pink, { dur: 0.11, gain: 0.7, filter: "lowpass", freq: 1000, freqTo: 400 }); // puff
      v.tone({ dur: 0.08, gain: 0.25, freq: 120, freqTo: 60 }); // dull thump
      v.noise(n.white, { dur: 0.008, gain: 0.25, filter: "highpass", freq: 4000 });
    },
  },
};

/** Prop bump: body thump pitch, contact noise band, optional metal ring. */
interface Thud {
  freq: number;
  band: number;
  q: number;
  ring?: number;
}

const THUDS: Record<Surface, Thud> = {
  metal: { freq: 110, band: 650, q: 1, ring: 190 }, // oil drum bonk
  steel: { freq: 140, band: 900, q: 1.2, ring: 330 },
  wood: { freq: 170, band: 520, q: 2 },
  concrete: { freq: 120, band: 900, q: 1 },
  plastic: { freq: 210, band: 600, q: 2.5 },
  rubber: { freq: 85, band: 300, q: 1 },
  fabric: { freq: 100, band: 400, q: 0.8 },
  flesh: { freq: 80, band: 320, q: 0.8 },
  ground: { freq: 90, band: 350, q: 0.8 },
};

/** Zombie voice per kind: duration, saw pitch glide, formant bands, breath/rasp colour. */
interface GroanRecipe {
  gain: number;
  range: number;
  dur: [number, number];
  pitch: [number, number];
  formants: readonly [number, number];
  q: number;
  breath: { buffer: keyof NoiseBank; band: number; bandTo: number; q: number; gain: number };
}

const GROANS: Record<ZombieKind, GroanRecipe> = {
  // Long hollow "ooh" moan, drooping in pitch.
  walker: {
    gain: 0.4,
    range: 32,
    dur: [1.1, 1.8],
    pitch: [105, 72],
    formants: [460, 820],
    q: 5,
    breath: { buffer: "pink", band: 520, bandTo: 340, q: 3, gain: 0.9 },
  },
  // Short raspy shriek that rises then cracks.
  runner: {
    gain: 0.36,
    range: 38,
    dur: [0.45, 0.7],
    pitch: [240, 330],
    formants: [1250, 2300],
    q: 4,
    breath: { buffer: "white", band: 2400, bandTo: 1500, q: 1.6, gain: 1.6 },
  },
  // Deep chesty growl.
  brute: {
    gain: 0.55,
    range: 42,
    dur: [1.2, 1.7],
    pitch: [58, 44],
    formants: [300, 620],
    q: 3,
    breath: { buffer: "brown", band: 380, bandTo: 220, q: 1.2, gain: 1.4 },
  },
};

/** Handling sounds are pitched per weapon (small pistol parts click higher). */
const HANDLING_PITCH: Record<WeaponDef["id"], number> = {
  carbine: 1,
  pistol: 1.18,
  shotgun: 0.88,
};

export type BlipKind = "camera" | "toast" | "reset";
export type PickupKind = "ammo" | "health";

/** Every game sound, synthesized from layered noise and oscillators. */
export class Sfx {
  private stepLeft = false;
  private lastShotgunShot = -Infinity;
  private readonly impactGate = new Throttle(0.06, 5);
  private readonly collisionGate = new Throttle(0.08, 4);
  private readonly uiGate = new Throttle(0.12, 1);
  private readonly fleshGate = new Throttle(0.05, 3);
  private readonly deathGate = new Throttle(0.08, 3);
  private readonly swipeGate = new Throttle(0.1, 2);
  private readonly hurtGate = new Throttle(0.15, 1);
  /** End times of the groans currently playing (MAX_GROANS slots). */
  private readonly groanEnds = new Float64Array(MAX_GROANS);

  constructor(private readonly engine: SoundEngine) {}

  shot(sound: WeaponSound, pos: Vec3): void {
    if (sound === "suppressed") this.suppressedShot(pos);
    else if (sound === "pistol") this.pistolShot(pos);
    else this.shotgunShot(pos);
  }

  impact(surface: Surface, pos: Vec3, level = 1): void {
    if (!this.impactGate.allow(this.engine.now)) return;
    const recipe = IMPACTS[surface];
    const v = this.engine.voice(pos, {
      gain: recipe.gain * level,
      range: recipe.range,
      send: recipe.send,
      pitchVar: recipe.pitchVar,
    });
    if (v) recipe.play(v, this.engine.noise);
  }

  /** A dynamic prop bumped into something; strength 0..1. */
  collision(surface: Surface, pos: Vec3, strength: number): void {
    const s = clamp(strength, 0, 1);
    if (s < 0.03 || !this.collisionGate.allow(this.engine.now)) return;
    const thud = THUDS[surface];
    const v = this.engine.voice(pos, {
      gain: 0.1 + 0.6 * s,
      range: 40,
      send: 0.25,
      pitchVar: 0.1,
    });
    if (!v) return;
    const { pink } = this.engine.noise;
    v.tone({ dur: 0.08 + 0.1 * s, gain: 0.5, freq: thud.freq * 1.4, freqTo: thud.freq });
    v.noise(pink, {
      dur: 0.05 + 0.04 * s,
      gain: 1.6,
      filter: "bandpass",
      freq: thud.band,
      q: thud.q,
    });
    if (thud.ring) v.ring(thud.ring * rand(0.85, 1.15), BARREL_MODES, 0.16, 0.2 + 0.5 * s);
  }

  dryFire(): void {
    const v = this.engine.voice(null, { gain: 0.7 });
    if (!v) return;
    const { white } = this.engine.noise;
    v.noise(white, { dur: 0.018, gain: 1.4, filter: "bandpass", freq: 4200, q: 6 });
    v.tone({ dur: 0.012, gain: 0.12, type: "triangle", freq: 3100 });
    v.noise(white, { at: 0.045, dur: 0.014, gain: 0.7, filter: "bandpass", freq: 3300, q: 6 });
  }

  reloadStage(stage: "magOut" | "magIn" | "bolt" | "shell" | "pump", weapon: WeaponDef): void {
    const pitch = HANDLING_PITCH[weapon.id];
    switch (stage) {
      case "magOut":
        return this.magOut(pitch);
      case "magIn":
        return this.magIn(pitch);
      case "bolt":
        return this.bolt(pitch);
      case "shell":
        return this.shellInsert();
      case "pump":
        // The shot recipe already racks the pump; ignore a duplicate right after a blast.
        if (this.engine.now - this.lastShotgunShot > PUMP_DEDUPE) this.pump(0);
    }
  }

  weaponSwitch(weapon: WeaponDef): void {
    const v = this.engine.voice(null, { gain: 0.48, pitch: HANDLING_PITCH[weapon.id] });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(pink, { dur: 0.18, gain: 0.8, attack: 0.06, filter: "bandpass", freq: 1100, q: 0.7 });
    v.noise(white, { at: 0.13, dur: 0.03, gain: 1.6, filter: "bandpass", freq: 3000, q: 4 });
    v.tone({ at: 0.13, dur: 0.045, gain: 0.18, freq: 270, freqTo: 180 });
  }

  explosion(pos: Vec3, radius: number): void {
    const size = clamp(radius / 5, 0.75, 1.3);
    const v = this.engine.voice(pos, {
      gain: size,
      range: 160,
      send: 0.8,
      priority: 3,
      pitch: 1 / Math.sqrt(size),
      pitchVar: 0.06,
    });
    if (!v) return;
    const { white, pink, brown, crackle } = this.engine.noise;
    v.tone({ dur: 1.5, gain: 0.9, attack: 0.004, freq: 72, freqTo: 26, glide: 1 }); // sub drop
    v.tone({ dur: 0.3, gain: 0.6, freq: 150, freqTo: 45, glide: 0.2 }); // punch
    v.noise(white, { dur: 0.7, gain: 1.2, filter: "lowpass", freq: 6000, freqTo: 350 }); // blast
    v.noise(brown, {
      dur: 1.9,
      gain: 1.4,
      attack: 0.01,
      filter: "lowpass",
      freq: 900,
      freqTo: 140,
    });
    v.noise(crackle, {
      at: 0.06,
      dur: 2.1,
      gain: 0.8,
      attack: 0.15,
      hold: 0.3,
      filter: "bandpass",
      freq: 2200,
      q: 0.6,
    }); // debris + fire crackle
    v.noise(pink, { at: 0.1, dur: 2.3, gain: 0.6, attack: 0.25, filter: "lowpass", freq: 260 });
  }

  /** Reward ding on top of the steel impact, then the plate clanking onto its stand. */
  targetHit(pos: Vec3): void {
    const v = this.engine.voice(pos, {
      gain: 0.5,
      range: 100,
      send: 0.4,
      priority: 2,
      pitchVar: 0.02,
    });
    if (!v) return;
    v.ring(1568, BELL_MODES, 0.22, 1.1);
    v.ring(rand(240, 300), BARREL_MODES, 0.12, 0.3, 0.2);
    v.noise(this.engine.noise.pink, {
      at: 0.2,
      dur: 0.07,
      gain: 0.6,
      filter: "lowpass",
      freq: 900,
    });
  }

  /** intensity ~0.3 (walk) … 1 (run). Alternating feet get slightly different pitch. */
  footstep(pos: Vec3, intensity: number): void {
    const i = clamp(intensity, 0, 1.5);
    this.stepLeft = !this.stepLeft;
    const v = this.engine.voice(pos, {
      gain: 0.16 + 0.3 * i,
      range: 25,
      priority: 0,
      pitch: this.stepLeft ? 0.95 : 1.05,
      gainVar: 0.15,
    });
    if (!v) return;
    const { pink, crackle } = this.engine.noise;
    v.tone({ dur: 0.05, gain: 0.25, freq: 95, freqTo: 55 }); // heel
    v.noise(pink, { dur: 0.06, gain: 0.8, filter: "lowpass", freq: 500 });
    v.noise(pink, {
      at: 0.012,
      dur: 0.08,
      gain: 0.6,
      filter: "bandpass",
      freq: 950,
      freqTo: 600,
      q: 0.9,
    }); // scuff
    v.noise(crackle, { at: 0.01, dur: 0.06, gain: 0.15, filter: "highpass", freq: 3000 }); // grit
  }

  /** Cloth whoosh + hand slap, then the landing thud after `duration`. */
  vault(pos: Vec3, duration: number): void {
    const v = this.engine.voice(pos, { gain: 0.3, range: 30, send: 0.1 });
    if (!v) return;
    const { white, pink, crackle } = this.engine.noise;
    v.noise(pink, {
      dur: 0.28,
      gain: 0.8,
      attack: 0.08,
      filter: "bandpass",
      freq: 800,
      freqTo: 2000,
      q: 0.8,
    });
    v.noise(white, { at: 0.05, dur: 0.04, gain: 1.2, filter: "bandpass", freq: 1300, q: 1.2 });
    v.noise(crackle, { at: 0.02, dur: 0.18, gain: 0.3, filter: "highpass", freq: 2500 }); // gear
    const land = Math.max(0.2, duration * 0.95);
    v.noise(pink, { at: land, dur: 0.13, gain: 1.4, filter: "lowpass", freq: 450 });
    v.tone({ at: land, dur: 0.1, gain: 0.35, freq: 95, freqTo: 55 });
    v.noise(pink, {
      at: land + 0.01,
      dur: 0.09,
      gain: 0.5,
      filter: "bandpass",
      freq: 900,
      q: 0.9,
    });
  }

  /** Drop thud + a descending scrape that lasts about as long as the slide. */
  slide(pos: Vec3, duration: number): void {
    const d = clamp(duration * 0.9, 0.3, 1.2);
    const v = this.engine.voice(pos, { gain: 0.17, range: 30, send: 0.1 });
    if (!v) return;
    const { pink, brown, crackle } = this.engine.noise;
    v.tone({ dur: 0.09, gain: 0.3, freq: 110, freqTo: 60 });
    v.noise(pink, {
      dur: d,
      gain: 1,
      attack: 0.03,
      hold: d * 0.3,
      filter: "bandpass",
      freq: 2300,
      freqTo: 700,
      q: 1.1,
    });
    v.noise(brown, {
      dur: d * 0.85,
      gain: 0.8,
      attack: 0.02,
      hold: d * 0.25,
      filter: "lowpass",
      freq: 420,
    });
    v.noise(crackle, {
      dur: d,
      gain: 0.35,
      attack: 0.03,
      hold: d * 0.3,
      filter: "highpass",
      freq: 2200,
    });
  }

  crouch(crouched: boolean): void {
    const v = this.engine.voice(null, { gain: 0.35, pitch: crouched ? 0.9 : 1.1 });
    if (!v) return;
    const { pink, crackle } = this.engine.noise;
    v.noise(pink, { dur: 0.15, gain: 0.8, attack: 0.03, filter: "bandpass", freq: 900, q: 0.8 });
    v.noise(crackle, { dur: 0.09, gain: 0.2, filter: "highpass", freq: 3000 });
    if (crouched) {
      v.noise(pink, { at: 0.08, dur: 0.08, gain: 0.7, filter: "lowpass", freq: 400 }); // knee
    }
  }

  /** Gear rattle + cloth when breaking into a tactical sprint. */
  gearRush(): void {
    const v = this.engine.voice(null, { gain: 0.35 });
    if (!v) return;
    const { pink, crackle } = this.engine.noise;
    v.noise(pink, {
      dur: 0.22,
      gain: 0.8,
      attack: 0.05,
      filter: "bandpass",
      freq: 1200,
      freqTo: 1800,
      q: 0.9,
    });
    v.noise(crackle, { dur: 0.2, gain: 0.35, attack: 0.02, filter: "highpass", freq: 2600 });
  }

  /** Out of stamina: exhale, inhale, exhale. */
  breath(): void {
    const v = this.engine.voice(null, { gain: 0.36, pitchVar: 0.04 });
    if (!v) return;
    const { pink } = this.engine.noise;
    const exhale: NoiseLayer = {
      dur: 0.42,
      gain: 0.9,
      attack: 0.07,
      hold: 0.06,
      filter: "bandpass",
      freq: 1500,
      freqTo: 850,
      q: 0.8,
    };
    v.noise(pink, exhale);
    v.noise(pink, {
      at: 0.55,
      dur: 0.36,
      gain: 0.5,
      attack: 0.2,
      filter: "bandpass",
      freq: 1900,
      freqTo: 2400,
      q: 1.2,
    });
    v.noise(pink, { ...exhale, at: 1, gain: 0.7, freq: 1400, freqTo: 800 });
  }

  /** Tiny UI blip (rate limited so reset + its toast make one sound). */
  blip(kind: BlipKind): void {
    if (!this.uiGate.allow(this.engine.now)) return;
    const v = this.engine.voice(null, { gain: 0.18, priority: 2, pitchVar: 0, gainVar: 0 });
    if (!v) return;
    if (kind === "camera") {
      v.tone({ dur: 0.06, gain: 0.5, freq: 1320 });
      v.tone({ at: 0.05, dur: 0.07, gain: 0.4, freq: 1760 });
    } else if (kind === "reset") {
      v.tone({ dur: 0.08, gain: 0.5, type: "triangle", freq: 660 });
      v.tone({ at: 0.07, dur: 0.12, gain: 0.45, type: "triangle", freq: 990 });
    } else {
      v.tone({ dur: 0.07, gain: 0.4, freq: 1180 });
    }
  }

  /** Formant-filtered saw + breath noise; kind sets the character. Max MAX_GROANS at once. */
  groan(kind: ZombieKind, pos: Vec3): void {
    const now = this.engine.now;
    let slot = -1;
    for (let i = 0; i < MAX_GROANS; i++) if (this.groanEnds[i] <= now) slot = i;
    if (slot < 0) return;
    const r = GROANS[kind];
    const v = this.engine.voice(pos, {
      gain: r.gain,
      range: r.range,
      send: 0.35,
      priority: 0,
      pitchVar: 0.12,
    });
    if (!v) return;
    const dur = rand(r.dur[0], r.dur[1]);
    const attack = dur * 0.25;
    const hold = dur * 0.3;
    const [f1, f2] = r.formants;
    const voice = { type: "sawtooth" as const, dur, attack, hold, freq: r.pitch[0], freqTo: r.pitch[1] };
    v.tone({ ...voice, gain: 0.5, filter: "bandpass", cutoff: f1, cutoffTo: f1 * 0.85, q: r.q });
    v.tone({ ...voice, gain: 0.3, filter: "bandpass", cutoff: f2, cutoffTo: f2 * 0.9, q: r.q });
    v.tone({ ...voice, gain: 0.2, freq: r.pitch[0] * 1.012, filter: "lowpass", cutoff: 360 }); // chest
    const b = r.breath;
    v.noise(this.engine.noise[b.buffer], {
      dur,
      gain: b.gain,
      attack,
      hold,
      filter: "bandpass",
      freq: b.band,
      freqTo: b.bandTo,
      q: b.q,
    });
    this.groanEnds[slot] = v.endTime;
  }

  /** Bullet into a zombie: wet slap; a headshot adds a bony crack. */
  zombieHit(pos: Vec3, headshot: boolean): void {
    if (!this.fleshGate.allow(this.engine.now)) return;
    const v = this.engine.voice(pos, { gain: 0.42, range: 35, send: 0.1, pitchVar: 0.12 });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(white, { dur: 0.035, gain: 1.6, filter: "bandpass", freq: 950, q: 1.2 }); // slap
    v.noise(pink, { at: 0.008, dur: 0.12, gain: 1, filter: "lowpass", freq: 520, freqTo: 220 });
    v.tone({ dur: 0.08, gain: 0.35, freq: 170, freqTo: 80 });
    if (headshot) {
      v.noise(white, { dur: 0.02, gain: 1.4, filter: "highpass", freq: 2600 }); // crack
      v.tone({ dur: 0.04, gain: 0.12, type: "triangle", freq: 1900, freqTo: 1300 });
    }
  }

  /** Body collapsing onto the ground (brutes land heavier). */
  zombieKilled(pos: Vec3, kind: ZombieKind): void {
    if (!this.deathGate.allow(this.engine.now)) return;
    const heavy = kind === "brute";
    const v = this.engine.voice(pos, {
      gain: heavy ? 0.7 : 0.5,
      range: 40,
      send: 0.2,
      pitch: heavy ? 0.75 : 1,
      pitchVar: 0.1,
      delay: 0.22,
    });
    if (!v) return;
    const { pink, brown, crackle } = this.engine.noise;
    v.tone({ dur: 0.22, gain: 0.55, freq: 85, freqTo: 42 }); // thud
    v.noise(brown, { dur: 0.3, gain: 1.6, filter: "lowpass", freq: 320, freqTo: 140 });
    v.noise(pink, { dur: 0.14, gain: 0.7, filter: "bandpass", freq: 650, q: 0.9 }); // cloth
    v.noise(crackle, { at: 0.03, dur: 0.18, gain: 0.25, filter: "highpass", freq: 2200 }); // grit
    v.tone({ at: 0.16, dur: 0.12, gain: 0.25, freq: 70, freqTo: 45 }); // second bounce
  }

  /** Claw swipe whoosh. */
  zombieAttack(pos: Vec3): void {
    if (!this.swipeGate.allow(this.engine.now)) return;
    const v = this.engine.voice(pos, { gain: 0.4, range: 25, send: 0.1, pitchVar: 0.12 });
    if (!v) return;
    const { pink, white } = this.engine.noise;
    v.noise(pink, {
      dur: 0.22,
      gain: 1.2,
      attack: 0.09,
      filter: "bandpass",
      freq: 600,
      freqTo: 2100,
      q: 1.3,
    });
    v.noise(white, { at: 0.08, dur: 0.1, gain: 0.5, filter: "highpass", freq: 3000 });
  }

  /** The player gets hit: dull body blow + a short grunt. */
  playerHurt(amount: number): void {
    if (!this.hurtGate.allow(this.engine.now)) return;
    const level = clamp(0.5 + amount / 40, 0.5, 1.1);
    const v = this.engine.voice(null, { gain: 0.55 * level, priority: 2, pitchVar: 0.08 });
    if (!v) return;
    const { pink } = this.engine.noise;
    v.tone({ dur: 0.16, gain: 0.7, freq: 115, freqTo: 52 }); // blow
    v.noise(pink, { dur: 0.12, gain: 1.2, filter: "lowpass", freq: 650, freqTo: 250 });
    const grunt = { at: 0.03, dur: 0.2, attack: 0.02, type: "sawtooth" as const, freq: 150, freqTo: 112 };
    v.tone({ ...grunt, gain: 0.35, filter: "bandpass", cutoff: 640, q: 6 });
    v.tone({ ...grunt, gain: 0.18, filter: "bandpass", cutoff: 1150, q: 6 });
    v.noise(pink, { at: 0.03, dur: 0.18, gain: 0.5, filter: "bandpass", freq: 900, q: 3 });
  }

  /** Lub-dub at low health. */
  heartbeat(level: number): void {
    const v = this.engine.voice(null, {
      gain: 0.35 + 0.35 * level,
      priority: 2,
      pitchVar: 0,
      gainVar: 0,
    });
    if (!v) return;
    v.tone({ dur: 0.14, gain: 0.9, freq: 62, freqTo: 44, filter: "lowpass", cutoff: 180 });
    v.tone({ at: 0.17, dur: 0.12, gain: 0.65, freq: 56, freqTo: 40, filter: "lowpass", cutoff: 160 });
  }

  /** Low drone falling away. */
  playerDied(): void {
    const v = this.engine.voice(null, { gain: 0.6, priority: 3, pitchVar: 0, send: 0.6 });
    if (!v) return;
    const { brown } = this.engine.noise;
    v.tone({
      dur: 2.6,
      gain: 0.45,
      attack: 0.05,
      hold: 0.3,
      type: "sawtooth",
      freq: 110,
      freqTo: 34,
      filter: "lowpass",
      cutoff: 700,
      cutoffTo: 160,
    });
    v.tone({ dur: 2.8, gain: 0.6, attack: 0.05, hold: 0.4, freq: 73, freqTo: 28 });
    v.noise(brown, { dur: 3, gain: 1.2, attack: 0.6, hold: 0.8, filter: "lowpass", freq: 260 });
  }

  /** Ominous low horn swelling in: detuned saws a fifth apart under an opening filter. */
  waveStart(): void {
    const v = this.engine.voice(null, { gain: 0.5, priority: 3, pitchVar: 0, send: 0.7 });
    if (!v) return;
    const { pink } = this.engine.noise;
    const horn = {
      dur: 2.9,
      attack: 0.9,
      hold: 0.8,
      type: "sawtooth" as const,
      filter: "lowpass" as const,
      cutoff: 240,
      cutoffTo: 900,
      q: 2,
    };
    v.tone({ ...horn, gain: 0.4, freq: 55, freqTo: 52 });
    v.tone({ ...horn, gain: 0.3, freq: 55.6, freqTo: 52.4 });
    v.tone({ ...horn, gain: 0.25, freq: 82.4, freqTo: 78 });
    v.tone({ dur: 3, gain: 0.5, attack: 1, hold: 0.8, freq: 41, freqTo: 38 }); // sub
    v.noise(pink, { dur: 2.8, gain: 0.5, attack: 1.2, filter: "lowpass", freq: 220 });
  }

  /** Relief chime: a rising major arpeggio. */
  waveCleared(): void {
    const v = this.engine.voice(null, { gain: 0.32, priority: 2, pitchVar: 0, send: 0.5 });
    if (!v) return;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    for (let i = 0; i < notes.length; i++) {
      v.ring(notes[i], BELL_MODES, 0.22, 0.9 + i * 0.25, i * 0.11);
    }
  }

  /** Bright two-step blip (health a little lower). */
  pickup(kind: PickupKind): void {
    const v = this.engine.voice(null, {
      gain: 0.26,
      priority: 2,
      pitch: kind === "health" ? 0.8 : 1,
      pitchVar: 0,
      gainVar: 0,
    });
    if (!v) return;
    v.tone({ dur: 0.08, gain: 0.5, type: "triangle", freq: 880, freqTo: 1320, glide: 0.05 });
    v.tone({ at: 0.065, dur: 0.14, gain: 0.45, type: "triangle", freq: 1760 });
  }

  /** Soft "thup": filtered gas puff, low thump, bolt clack. Built to stay clean in rapid fire. */
  private suppressedShot(pos: Vec3): void {
    const v = this.engine.voice(pos, {
      gain: 0.8,
      range: 50,
      send: 0.25,
      priority: 2,
      pitchVar: 0.06,
    });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(white, {
      dur: 0.07,
      gain: 2.4,
      filter: "bandpass",
      freq: 1500,
      freqTo: 600,
      q: 0.8,
    }); // gas
    v.noise(pink, { dur: 0.12, gain: 0.9, attack: 0.003, filter: "lowpass", freq: 900 }); // body
    v.tone({ dur: 0.1, gain: 0.55, freq: 150, freqTo: 52, glide: 0.08 }); // thump
    v.noise(white, { at: 0.016, dur: 0.022, gain: 1.6, filter: "bandpass", freq: 3600, q: 3 }); // clack
    v.noise(white, { dur: 0.012, gain: 0.25, filter: "highpass", freq: 5000 }); // snap
  }

  /** Sharp crack: bright transient, body, short tail, slide clack. */
  private pistolShot(pos: Vec3): void {
    const v = this.engine.voice(pos, { gain: 1, range: 70, send: 0.5, priority: 2 });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(white, { dur: 0.028, gain: 1.1, filter: "highpass", freq: 1800 }); // crack
    v.noise(white, {
      dur: 0.09,
      gain: 2.2,
      filter: "bandpass",
      freq: 950,
      freqTo: 500,
      q: 0.9,
    }); // body
    v.tone({ dur: 0.13, gain: 0.6, freq: 190, freqTo: 58, glide: 0.1 }); // thump
    v.noise(pink, {
      at: 0.008,
      dur: 0.38,
      gain: 0.45,
      attack: 0.012,
      filter: "lowpass",
      freq: 2600,
      freqTo: 600,
    }); // tail
    v.noise(white, { at: 0.035, dur: 0.03, gain: 1.2, filter: "bandpass", freq: 2900, q: 4 }); // slide
  }

  /** Big boom: sub drop, broadband blast, long tail, then the pump. */
  private shotgunShot(pos: Vec3): void {
    this.lastShotgunShot = this.engine.now;
    const v = this.engine.voice(pos, {
      gain: 1,
      range: 90,
      send: 0.7,
      priority: 2,
      pitchVar: 0.04,
    });
    if (!v) return;
    const { white, brown } = this.engine.noise;
    v.tone({ dur: 0.4, gain: 0.85, freq: 115, freqTo: 36, glide: 0.28 }); // sub drop
    v.noise(white, { dur: 0.2, gain: 1, filter: "lowpass", freq: 7000, freqTo: 900 }); // blast
    v.noise(white, { dur: 0.025, gain: 0.9, filter: "highpass", freq: 1500 }); // crack
    v.noise(brown, {
      at: 0.015,
      dur: 0.95,
      gain: 0.7,
      attack: 0.02,
      filter: "lowpass",
      freq: 1400,
      freqTo: 250,
    }); // tail
    this.pump(PUMP_DELAY);
  }

  /** Slide + release click. */
  private magOut(pitch: number): void {
    const v = this.engine.voice(null, { gain: 1.05, pitch });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(pink, {
      dur: 0.13,
      gain: 0.7,
      attack: 0.04,
      filter: "bandpass",
      freq: 1900,
      freqTo: 1200,
      q: 1.4,
    });
    v.noise(white, { at: 0.09, dur: 0.03, gain: 1.6, filter: "bandpass", freq: 3400, q: 5 });
    v.tone({ at: 0.09, dur: 0.035, gain: 0.08, type: "triangle", freq: 1350 });
  }

  /** Firm seat + latch: click-clack. */
  private magIn(pitch: number): void {
    const v = this.engine.voice(null, { gain: 0.48, pitch });
    if (!v) return;
    const { white } = this.engine.noise;
    v.noise(white, { dur: 0.04, gain: 2, filter: "bandpass", freq: 2100, q: 3 });
    v.tone({ dur: 0.05, gain: 0.3, freq: 320, freqTo: 190 });
    v.noise(white, { at: 0.055, dur: 0.03, gain: 1.6, filter: "bandpass", freq: 3900, q: 5 });
  }

  /** Two-part rack: pull back, then slam home with a metallic ping. */
  private bolt(pitch: number): void {
    const v = this.engine.voice(null, { gain: 0.5, pitch });
    if (!v) return;
    const { white } = this.engine.noise;
    v.noise(white, {
      dur: 0.09,
      gain: 1.3,
      attack: 0.01,
      filter: "bandpass",
      freq: 2600,
      freqTo: 1700,
      q: 2,
    });
    v.tone({ dur: 0.06, gain: 0.05, type: "triangle", freq: 1240 });
    v.noise(white, { at: 0.14, dur: 0.06, gain: 2.2, filter: "bandpass", freq: 1800, q: 2.5 });
    v.tone({ at: 0.14, dur: 0.07, gain: 0.35, freq: 230, freqTo: 140 });
    v.tone({ at: 0.14, dur: 0.12, gain: 0.05, freq: 3150 });
  }

  private shellInsert(): void {
    const v = this.engine.voice(null, { gain: 0.5, pitchVar: 0.08 });
    if (!v) return;
    const { white, pink } = this.engine.noise;
    v.noise(pink, { dur: 0.05, gain: 0.5, attack: 0.02, filter: "bandpass", freq: 1500, q: 1.5 });
    v.noise(white, { at: 0.04, dur: 0.03, gain: 1.6, filter: "bandpass", freq: 2800, q: 4 });
    v.tone({ at: 0.04, dur: 0.045, gain: 0.25, freq: 420, freqTo: 260 });
  }

  /** Ka-chunk. */
  private pump(delay: number): void {
    const v = this.engine.voice(null, { gain: 0.36, delay, priority: 2 });
    if (!v) return;
    const { white } = this.engine.noise;
    v.noise(white, { dur: 0.07, gain: 1.8, filter: "bandpass", freq: 1400, q: 1.5 });
    v.tone({ dur: 0.06, gain: 0.35, freq: 190, freqTo: 120 });
    v.noise(white, { at: 0.15, dur: 0.09, gain: 2.4, filter: "bandpass", freq: 1000, q: 1.2 });
    v.tone({ at: 0.15, dur: 0.09, gain: 0.5, freq: 150, freqTo: 80 });
    v.noise(white, { at: 0.15, dur: 0.03, gain: 1.2, filter: "bandpass", freq: 3000, q: 4 });
  }
}

// ---------------------------------------------------------------------------------------------
// Game-facing system
// ---------------------------------------------------------------------------------------------

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

/**
 * Procedural WebAudio sound (no asset files). Subscribes to game events in the constructor and
 * ignores them until unlock() has created the AudioContext on a user gesture.
 */
export class AudioSystem {
  private context: AudioContext | null = null;
  private engine: SoundEngine | null = null;
  private sfx: Sfx | null = null;
  private unavailable = false;
  private heartTimer = 0;
  private readonly unsubscribe: (() => void)[];

  constructor(private readonly ctx: GameContext) {
    const { events, tuning } = ctx;
    this.unsubscribe = [
      events.on("shot", (e) => this.live()?.shot(e.weapon.sound, e.origin)),
      events.on("impact", (e) =>
        this.live()?.impact(e.hit.surface, e.hit.point, e.weapon.pellets > 1 ? PELLET_LEVEL : 1),
      ),
      events.on("dryFire", () => this.live()?.dryFire()),
      events.on("reloadStage", (e) => this.live()?.reloadStage(e.stage, e.weapon)),
      events.on("weaponSwitch", (e) => this.live()?.weaponSwitch(e.weapon)),
      events.on("explosion", (e) => this.live()?.explosion(e.position, e.radius)),
      events.on("propCollision", (e) => this.live()?.collision(e.surface, e.position, e.strength)),
      events.on("targetHit", (e) => this.live()?.targetHit(e.position)),
      events.on("footstep", (e) => this.live()?.footstep(e.position, e.intensity)),
      events.on("vault", (e) => this.live()?.vault(e.position, tuning.vaultDuration)),
      events.on("slide", (e) => this.live()?.slide(e.position, tuning.slideDuration)),
      events.on("crouch", (e) => this.live()?.crouch(e.crouched)),
      events.on("tacticalStart", () => this.live()?.gearRush()),
      events.on("staminaExhausted", () => this.live()?.breath()),
      events.on("cameraMode", () => this.live()?.blip("camera")),
      events.on("toast", () => this.live()?.blip("toast")),
      events.on("reset", () => this.live()?.blip("reset")),
      events.on("zombieGroan", (e) => this.live()?.groan(e.kind, e.position)),
      events.on("zombieHit", (e) => this.live()?.zombieHit(e.position, e.headshot)),
      events.on("zombieKilled", (e) => this.live()?.zombieKilled(e.position, e.kind)),
      events.on("zombieAttack", (e) => this.live()?.zombieAttack(e.position)),
      events.on("playerHurt", (e) => this.live()?.playerHurt(e.amount)),
      events.on("playerDied", () => this.live()?.playerDied()),
      events.on("waveStart", () => this.live()?.waveStart()),
      events.on("waveCleared", () => this.live()?.waveCleared()),
      events.on("pickup", (e) => this.live()?.pickup(e.kind)),
    ];
  }

  /** Create/resume the AudioContext. Safe to call on every user gesture. */
  unlock(): void {
    if (!this.context && !this.unavailable) this.create();
    const ac = this.context;
    if (ac && ac.state !== "running" && ac.state !== "closed") {
      ac.resume().catch(() => undefined);
    }
  }

  /** Per-frame: master volume from tuning, listener at the player, low-health heartbeat. */
  update(dt: number): void {
    if (!this.engine) return;
    const { player } = this.ctx;
    this.engine.setVolume(this.ctx.tuning.masterVolume);
    this.engine.setListener(player.position, this.ctx.cameraRig.camera);
    this.updateHeartbeat(dt, player.health, player.dead);
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    this.unsubscribe.length = 0;
    this.context?.close().catch(() => undefined);
    this.context = null;
    this.engine = null;
    this.sfx = null;
  }

  private updateHeartbeat(dt: number, health: number, dead: boolean): void {
    if (dead || health >= HEARTBEAT_HEALTH) {
      this.heartTimer = 0;
      return;
    }
    this.heartTimer -= dt;
    if (this.heartTimer > 0) return;
    const level = 1 - health / HEARTBEAT_HEALTH;
    this.heartTimer = HEARTBEAT_SLOW + (HEARTBEAT_FAST - HEARTBEAT_SLOW) * level;
    this.live()?.heartbeat(level);
  }

  /** Recipes, or null before unlock and while suspended (so sounds don't pile up). */
  private live(): Sfx | null {
    return this.context?.state === "running" ? this.sfx : null;
  }

  private create(): void {
    const Ctor = window.AudioContext ?? (window as WebkitWindow).webkitAudioContext;
    try {
      const ac = new Ctor({ latencyHint: "interactive" });
      this.engine = new SoundEngine(ac);
      this.engine.setVolume(this.ctx.tuning.masterVolume);
      this.sfx = new Sfx(this.engine);
      this.context = ac;
      // iOS Safari only unlocks output once something plays inside the gesture.
      const prime = ac.createBufferSource();
      prime.buffer = ac.createBuffer(1, 1, ac.sampleRate);
      prime.connect(ac.destination);
      prime.start();
    } catch (err) {
      this.unavailable = true;
      console.warn("[audio] WebAudio unavailable, running silent", err);
    }
  }
}
