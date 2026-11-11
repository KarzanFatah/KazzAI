import type { CarAudioState } from "./types";

/**
 * Synthesized WebAudio for DUSTLINE: engine, sand/tyre noise, wind, boost and one-shots.
 * No sample files: three noise buffers are generated once on unlock and looped/reused.
 *
 * Graph: layers → master (mute, smoothed) → DynamicsCompressor → destination.
 * Every public method is a no-op until `unlock()` has created the AudioContext.
 * `update()` only sets AudioParam targets (no allocations, no node creation).
 */

type Surface = CarAudioState["surface"];

const MASTER_VOL = 0.85;

/** Per-surface colour of the slip (drift) hiss, indexed by surfIndex(). */
const SLIP_F = [1050, 2300, 820, 1800];
const SLIP_Q = [0.8, 1.2, 1.5, 0.7];
const SLIP_MUL = [0.9, 1.0, 0.75, 0.85];
/** Low "roar" under a drift (sand being shovelled), per surface. */
const ROAR_MUL = [1.0, 0.4, 0.8, 0.35];
/** Overall rolling-noise level per surface chain. */
const SURF_MUL = [1.0, 0.95, 0.9, 1.1];
/** Inharmonic plate modes for the metallic clank. */
const CLANK_RATIOS = [1, 2.76, 5.4, 8.93];

function surfIndex(s: Surface): number {
  switch (s) {
    case "road":
      return 1;
    case "beach":
      return 2;
    case "water":
      return 3;
    default:
      return 0;
  }
}

/** Clamp to 0..1; NaN → 0. */
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

function normalize(d: Float32Array, peak: number): void {
  let mean = 0;
  for (let i = 0; i < d.length; i++) mean += d[i];
  mean /= d.length;
  let max = 1e-9;
  for (let i = 0; i < d.length; i++) {
    d[i] -= mean;
    const a = Math.abs(d[i]);
    if (a > max) max = a;
  }
  const k = peak / max;
  for (let i = 0; i < d.length; i++) d[i] *= k;
}

/** Looping noise buffer; the generator's continuation is cross-faded into the head (seamless). */
function makeLoop(ctx: BaseAudioContext, seconds: number, gen: () => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const fade = Math.floor(0.05 * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = gen();
  for (let i = 0; i < fade; i++) {
    const a = i / fade;
    d[i] = d[i] * a + gen() * (1 - a);
  }
  normalize(d, 0.9);
  return buf;
}

const whiteGen = (): number => Math.random() * 2 - 1;

function brownGen(): () => number {
  let last = 0;
  return () => {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    return last * 3.5;
  };
}

/** Sparse short noise grains (gravel crunch / sand grit / droplets). Wraps, so it loops cleanly. */
function makeGrain(ctx: BaseAudioContext, seconds: number, perSecond: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(seconds * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const count = Math.floor(seconds * perSecond);
  for (let k = 0; k < count; k++) {
    const start = Math.floor(Math.random() * n);
    const len = Math.max(8, Math.floor((0.0015 + Math.random() * 0.009) * sr));
    const r = Math.random();
    const amp = r * r;
    const decay = 5 / len;
    for (let i = 0; i < len; i++) {
      d[(start + i) % n] += amp * (Math.random() * 2 - 1) * Math.exp(-i * decay);
    }
  }
  normalize(d, 0.9);
  return buf;
}

interface Graph {
  master: GainNode;
  fx: GainNode;
  /** Gentle lowpass bus for tonal one-shots (chimes, beeps). */
  tonal: GainNode;
  white: AudioBuffer;
  brown: AudioBuffer;
  grain: AudioBuffer;
  // engine
  saw: OscillatorNode;
  sq: OscillatorNode;
  sub: OscillatorNode;
  engFilter: BiquadFilterNode;
  engAmp: GainNode;
  lope: OscillatorNode;
  lopeDepth: GainNode;
  burble: OscillatorNode;
  burbleDepth: GainNode;
  gritFilter: BiquadFilterNode;
  gritGain: GainNode;
  // tyres / surface
  brownSrc: AudioBufferSourceNode;
  grainSrc: AudioBufferSourceNode;
  tyreBus: GainNode;
  surf: GainNode[];
  sandLP: BiquadFilterNode;
  roadRumble: BiquadFilterNode;
  waterBP: BiquadFilterNode;
  waterLfo: OscillatorNode;
  slipBP: BiquadFilterNode;
  slipG: GainNode;
  roarG: GainNode;
  // wind
  windBP: BiquadFilterNode;
  windG: GainNode;
  // boost
  boostG: GainNode;
  whistle: OscillatorNode;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export class AudioSystem {
  muted = false;
  private ctx: AudioContext | null = null;
  private g: Graph | null = null;
  private prevThr = 0;
  private liftT = 0;
  private lastImpactT = -1;
  private lastImpactS = 0;
  private lastLandT = -1;

  /** True once the AudioContext exists (it may still be suspended until a gesture resumes it). */
  get unlocked(): boolean {
    return this.ctx !== null;
  }

  /** Create/resume the AudioContext (call on every user gesture; idempotent). */
  unlock(): void {
    if (!this.ctx) {
      const w = window as WebkitWindow;
      const AC = window.AudioContext ?? w.webkitAudioContext;
      if (!AC) return;
      let ctx: AudioContext;
      try {
        ctx = new AC({ latencyHint: "interactive" });
      } catch {
        try {
          ctx = new AC();
        } catch {
          return;
        }
      }
      this.ctx = ctx;
      try {
        this.g = this.build(ctx);
      } catch {
        this.g = null;
      }
    }
    const ctx = this.ctx;
    if (ctx.state !== "running") {
      ctx.resume().catch(() => {});
      // Old iOS: playing a buffer inside the gesture is what actually unlocks output.
      try {
        const b = ctx.createBufferSource();
        b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        b.connect(ctx.destination);
        b.onended = () => b.disconnect();
        b.start(0);
      } catch {
        /* ignore */
      }
    }
  }

  /** Suspend/resume the whole context (e.g. on visibilitychange / pause menu) to save battery. */
  setPaused(paused: boolean): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (paused) ctx.suspend().catch(() => {});
    else ctx.resume().catch(() => {});
  }

  update(dt: number, s: CarAudioState): void {
    const ctx = this.ctx;
    const g = this.g;
    // Don't queue automation while suspended (currentTime is frozen → events would pile up).
    if (!ctx || !g || ctx.state !== "running") return;
    const t = ctx.currentTime;
    const rpm = clamp01(s.rpm);
    const thr = clamp01(s.throttle);
    const slip = clamp01(s.slip);
    const speed = s.speed > 0 ? s.speed : 0;
    const spN = clamp01(speed / 40);
    const air = !s.grounded;
    const si = surfIndex(s.surface);

    // ---------------- engine ----------------
    const f = 38 + 152 * rpm; // firing frequency: ~38 Hz idle → ~190 Hz at redline
    g.saw.frequency.setTargetAtTime(f, t, 0.035);
    g.sq.frequency.setTargetAtTime(f, t, 0.035);
    g.sub.frequency.setTargetAtTime(f * 0.5, t, 0.035);
    g.lope.frequency.setTargetAtTime(f / 6, t, 0.05); // cam-rate lope of a lumpy carb six
    g.burble.frequency.setTargetAtTime(f / 3.3, t, 0.05);
    const boostOn = s.boosting ? 1 : 0;
    const cutoff = 170 + 900 * rpm + 1500 * thr * (0.35 + 0.65 * rpm) + 700 * boostOn;
    g.engFilter.frequency.setTargetAtTime(cutoff, t, 0.06);
    g.engFilter.Q.setTargetAtTime(2.2 - 1.0 * thr, t, 0.1);
    const lvl = 0.12 + 0.09 * rpm + 0.16 * thr;
    g.engAmp.gain.setTargetAtTime(lvl, t, 0.06);
    // idle lope fades with revs; off-throttle at high revs → burble wobble
    const off = 1 - thr;
    const hi = clamp01((rpm - 0.2) / 0.6);
    g.lopeDepth.gain.setTargetAtTime(lvl * (0.05 + 0.22 * (1 - rpm)), t, 0.08);
    g.burbleDepth.gain.setTargetAtTime(lvl * 0.5 * off * off * hi, t, 0.08);
    g.gritFilter.frequency.setTargetAtTime(f * 7, t, 0.05);
    g.gritGain.gain.setTargetAtTime(0.25 + 0.9 * thr * (0.3 + rpm), t, 0.08);

    // backfire pops after a sharp throttle lift at high revs
    if (this.prevThr > 0.6 && thr < 0.15 && rpm > 0.5) this.liftT = 0.9;
    this.prevThr = thr;
    if (this.liftT > 0) {
      this.liftT -= dt;
      if (thr > 0.3) this.liftT = 0;
      else if (Math.random() < dt * 6) this.pop(t);
    }

    // ---------------- tyres / surface ----------------
    g.tyreBus.gain.setTargetAtTime(air ? 0 : 1, t, air ? 0.03 : 0.05);
    const roll = speed < 0.3 ? 0 : Math.pow(spN, 0.7);
    for (let i = 0; i < 4; i++) {
      g.surf[i].gain.setTargetAtTime(i === si ? roll * SURF_MUL[i] : 0, t, 0.09);
    }
    g.grainSrc.playbackRate.setTargetAtTime(0.5 + 1.0 * spN, t, 0.1);
    g.brownSrc.playbackRate.setTargetAtTime(0.75 + 0.6 * spN, t, 0.1);
    g.sandLP.frequency.setTargetAtTime(380 + 520 * spN, t, 0.1);
    g.roadRumble.frequency.setTargetAtTime(240 + 320 * spN, t, 0.1);
    g.waterBP.frequency.setTargetAtTime(900 + 700 * spN, t, 0.1);
    g.waterLfo.frequency.setTargetAtTime(9 + 12 * spN, t, 0.1);
    const slipAmt = Math.pow(slip, 1.2) * (0.2 + 0.8 * clamp01(speed / 12));
    g.slipBP.frequency.setTargetAtTime(SLIP_F[si] * (1 + 0.35 * slip), t, 0.08);
    g.slipBP.Q.setTargetAtTime(SLIP_Q[si], t, 0.1);
    g.slipG.gain.setTargetAtTime(slipAmt * SLIP_MUL[si], t, 0.06);
    g.roarG.gain.setTargetAtTime(slipAmt * (0.3 + 0.7 * spN) * ROAR_MUL[si], t, 0.08);

    // ---------------- wind ----------------
    g.windBP.frequency.setTargetAtTime(320 + 900 * spN + (air ? 450 : 0), t, 0.15);
    g.windG.gain.setTargetAtTime(0.02 + 0.22 * spN * spN + (air ? 0.08 + 0.12 * spN : 0), t, 0.2);

    // ---------------- boost ----------------
    g.boostG.gain.setTargetAtTime(boostOn * (0.5 + 0.5 * spN), t, s.boosting ? 0.06 : 0.3);
    g.whistle.frequency.setTargetAtTime(2200 + 1600 * rpm + 500 * spN, t, 0.1);
  }

  /** Collision. strength 0..1 (clamped): ~0.15 bush/scrape, 1 = full-speed wall hit. */
  impact(strength: number): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    const s = clamp01(strength);
    if (s < 0.02) return;
    if (t - this.lastImpactT < 0.08 && s < this.lastImpactS * 1.5) return;
    this.lastImpactT = t;
    this.lastImpactS = s;
    // body thud
    this.tone("sine", 90 + 50 * s, 36, t, 0.004, 0.16 + 0.22 * s, 0.12 + 0.5 * s, g.fx);
    this.burst(g.brown, t, 0.002, 0.08 + 0.14 * s, 0.1 + 0.45 * s, "lowpass", 1500, 180, 0.8, g.fx);
    // metallic clank (only for real hits)
    const clank = s > 0.12 ? (s - 0.08) * 0.32 : 0;
    if (clank > 0) {
      const base = 240 + Math.random() * 180;
      for (const r of CLANK_RATIOS) {
        const sq = Math.sqrt(r);
        this.tone("sine", base * r, base * r * 0.99, t + 0.002, 0.001, 0.05 + 0.3 / sq, clank / sq, g.fx);
      }
      this.burst(g.white, t, 0.001, 0.05, 0.25 * s, "bandpass", 3400, 2200, 1.4, g.fx);
    }
  }

  /** Touch-down after air. strength 0..1 (clamped): 1 = hard landing from ~3 m. */
  landing(strength: number): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    if (t - this.lastLandT < 0.15) return;
    this.lastLandT = t;
    const s = clamp01(strength);
    // suspension thump + spring
    this.tone("sine", 78, 32, t, 0.005, 0.22 + 0.2 * s, 0.18 + 0.45 * s, g.fx);
    this.tone("triangle", 160, 96, t + 0.01, 0.01, 0.2, 0.04 + 0.07 * s, g.fx);
    // sand whump + grit spray
    this.burst(g.brown, t, 0.006, 0.28 + 0.25 * s, 0.15 + 0.5 * s, "lowpass", 900, 150, 0.7, g.fx, 0.7);
    this.burst(g.grain, t + 0.01, 0.01, 0.25 + 0.15 * s, 0.08 + 0.25 * s, "highpass", 1800, 1200, 0.7, g.fx);
  }

  /** Take-off: small spring creak. */
  jump(): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    const ctx = this.ctx as AudioContext;
    // creak = resonant pulse train (square at 35→60 Hz into a narrow bandpass)
    const o = ctx.createOscillator();
    o.type = "square";
    o.frequency.setValueAtTime(34 + Math.random() * 6, t);
    o.frequency.exponentialRampToValueAtTime(60, t + 0.17);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 1150 + Math.random() * 300;
    bp.Q.value = 9;
    const a = ctx.createGain();
    this.env(a.gain, t, 0.02, 0.16, 0.9);
    o.connect(bp).connect(a).connect(g.fx);
    o.onended = () => {
      o.disconnect();
      bp.disconnect();
      a.disconnect();
    };
    o.start(t);
    o.stop(t + 0.22);
    this.burst(g.white, t, 0.04, 0.18, 0.04, "bandpass", 600, 1500, 1, g.fx);
  }

  /** Boost activation "whoomp" (the continuous whoosh follows `s.boosting`). */
  boost(): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    this.tone("sine", 150, 40, t, 0.01, 0.45, 0.4, g.fx);
    this.burst(g.white, t, 0.02, 0.45, 0.22, "lowpass", 3000, 250, 0.8, g.fx);
    this.burst(g.white, t, 0.08, 0.35, 0.1, "bandpass", 700, 2600, 1.2, g.fx);
  }

  checkpoint(): void {
    const t = this.now();
    if (t < 0) return;
    this.chime(987.8, t, 0.22, 0.45);
    this.chime(1318.5, t + 0.085, 0.24, 0.6);
  }

  lap(): void {
    const t = this.now();
    if (t < 0) return;
    this.chime(1046.5, t, 0.2, 0.4);
    this.chime(1318.5, t + 0.1, 0.22, 0.45);
    this.chime(1568, t + 0.2, 0.26, 0.9);
  }

  finish(): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093];
    for (let i = 0; i < notes.length; i++) {
      const tt = t + i * 0.07;
      this.chime(notes[i], tt, 0.13, 0.3);
      this.tone("square", notes[i], notes[i], tt, 0.004, 0.18, 0.035, g.tonal);
    }
    const tc = t + notes.length * 0.07 + 0.05;
    this.chime(1046.5, tc, 0.16, 1.4);
    this.chime(1318.5, tc, 0.13, 1.4);
    this.chime(1568, tc, 0.13, 1.4);
    this.tone("sawtooth", 261.6, 261.6, tc, 0.03, 1.2, 0.05, g.tonal);
    this.tone("sawtooth", 392, 392, tc, 0.03, 1.2, 0.04, g.tonal);
    this.burst(g.white, tc, 0.002, 0.9, 0.05, "highpass", 6500, 6500, 0.7, g.fx);
  }

  /** Countdown beep; final = the "GO" beep. */
  countdown(final: boolean): void {
    const t = this.now();
    const g = this.g;
    if (t < 0 || !g) return;
    const f = final ? 1046.5 : 523.25;
    const d = final ? 0.55 : 0.15;
    this.tone("square", f, f, t, 0.004, d, 0.08, g.tonal);
    this.tone("sine", f, f, t, 0.004, d + 0.05, 0.2, g.tonal);
  }

  setMuted(m: boolean): void {
    this.muted = m;
    const ctx = this.ctx;
    const g = this.g;
    if (!ctx || !g) return;
    const t = ctx.currentTime;
    g.master.gain.cancelScheduledValues(t);
    g.master.gain.setValueAtTime(g.master.gain.value, t);
    g.master.gain.setTargetAtTime(m ? 0 : MASTER_VOL, t, 0.06);
  }

  // ------------------------------------------------------------------ internals

  /** currentTime, or -1 when audio isn't available yet. */
  private now(): number {
    return this.ctx && this.g ? this.ctx.currentTime : -1;
  }

  private build(ctx: AudioContext): Graph {
    const gain = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      return n;
    };
    const filter = (type: BiquadFilterType, f: number, q: number): BiquadFilterNode => {
      const n = ctx.createBiquadFilter();
      n.type = type;
      n.frequency.value = f;
      n.Q.value = q;
      return n;
    };
    const osc = (type: OscillatorType, f: number): OscillatorNode => {
      const n = ctx.createOscillator();
      n.type = type;
      n.frequency.value = f;
      return n;
    };
    const loopSrc = (buf: AudioBuffer, offset: number): AudioBufferSourceNode => {
      const n = ctx.createBufferSource();
      n.buffer = buf;
      n.loop = true;
      n.start(0, offset % buf.duration);
      return n;
    };

    // master chain
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 10;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.2;
    comp.connect(ctx.destination);
    const master = gain(0);
    master.connect(comp);
    master.gain.setTargetAtTime(this.muted ? 0 : MASTER_VOL, ctx.currentTime, 0.1);
    const fx = gain(0.9);
    fx.connect(master);
    const tonalLP = filter("lowpass", 4800, 0.5);
    tonalLP.connect(fx);
    const tonal = gain(1);
    tonal.connect(tonalLP);

    // noise buffers (generated once)
    const white = makeLoop(ctx, 2.3, whiteGen);
    const brown = makeLoop(ctx, 3.1, brownGen());
    const grain = makeGrain(ctx, 1.7, 380);
    const whiteA = loopSrc(white, 0);
    const whiteB = loopSrc(white, 1.13);
    const brownSrc = loopSrc(brown, 0);
    const grainSrc = loopSrc(grain, 0);

    // ---------------- engine ----------------
    const saw = osc("sawtooth", 38);
    const sq = osc("square", 38);
    sq.detune.value = -14;
    const sub = osc("sine", 19);
    const shaperCurve = new Float32Array(1024);
    for (let i = 0; i < shaperCurve.length; i++) {
      const x = (i / (shaperCurve.length - 1)) * 2 - 1;
      shaperCurve[i] = Math.tanh(1.8 * x) / Math.tanh(1.8);
    }
    const shaper = ctx.createWaveShaper();
    shaper.curve = shaperCurve;
    saw.connect(gain(0.34)).connect(shaper);
    sq.connect(gain(0.17)).connect(shaper);
    sub.connect(gain(0.4)).connect(shaper);
    const engFilter = filter("lowpass", 300, 2);
    const engAmp = gain(0);
    shaper.connect(engFilter).connect(engAmp).connect(master);
    // lumpy idle lope + off-throttle burble modulate the engine amplitude
    const lope = osc("sine", 6);
    const lopeDepth = gain(0);
    lope.connect(lopeDepth).connect(engAmp.gain);
    const burble = osc("sine", 11);
    const real = new Float32Array([0, 1, 0.6, 0.45, 0.3, 0.2]);
    const imag = new Float32Array([0, 0, 0.5, -0.4, 0.25, -0.3]);
    burble.setPeriodicWave(ctx.createPeriodicWave(real, imag, { disableNormalization: false }));
    const burbleDepth = gain(0);
    burble.connect(burbleDepth).connect(engAmp.gain);
    // carb/exhaust grit
    const gritFilter = filter("bandpass", 300, 1.6);
    const gritGain = gain(0);
    whiteB.connect(gritFilter).connect(gritGain).connect(engAmp);

    // ---------------- tyres / surface ----------------
    const tyreBus = gain(0);
    tyreBus.connect(master);
    const surf: GainNode[] = [];
    for (let i = 0; i < 4; i++) {
      const sg = gain(0);
      sg.connect(tyreBus);
      surf.push(sg);
    }
    // sand: soft low shush + fine grit
    const sandLP = filter("lowpass", 500, 0.7);
    brownSrc.connect(sandLP).connect(gain(0.55)).connect(surf[0]);
    grainSrc.connect(filter("lowpass", 1300, 0.6)).connect(gain(0.3)).connect(surf[0]);
    // road (gravel): crunchy grains + low rumble
    grainSrc.connect(filter("bandpass", 2400, 0.9)).connect(gain(0.9)).connect(surf[1]);
    const roadRumble = filter("bandpass", 300, 1.0);
    brownSrc.connect(roadRumble).connect(gain(0.7)).connect(surf[1]);
    // beach (wet sand): darker, squishy resonance + wet slaps
    brownSrc.connect(filter("lowpass", 650, 3.5)).connect(gain(0.45)).connect(surf[2]);
    grainSrc.connect(filter("bandpass", 900, 2.5)).connect(gain(0.5)).connect(surf[2]);
    // water: splashy filtered noise with fast tremolo + droplets
    const waterBP = filter("bandpass", 1000, 0.6);
    const waterTrem = gain(0.5);
    whiteA.connect(waterBP).connect(waterTrem).connect(gain(0.35)).connect(surf[3]);
    const waterLfo = osc("sine", 12);
    waterLfo.connect(gain(0.45)).connect(waterTrem.gain);
    grainSrc.connect(filter("highpass", 2800, 0.7)).connect(gain(0.45)).connect(surf[3]);
    // slip hiss + drift roar
    const slipBP = filter("bandpass", 1100, 0.8);
    const slipG = gain(0);
    whiteA.connect(slipBP).connect(slipG).connect(gain(0.22)).connect(tyreBus);
    const roarG = gain(0);
    brownSrc.connect(filter("lowpass", 280, 0.7)).connect(roarG).connect(gain(0.6)).connect(tyreBus);

    // ---------------- wind ----------------
    const windBP = filter("bandpass", 400, 0.6);
    const windG = gain(0);
    whiteB.connect(windBP).connect(windG).connect(gain(0.5)).connect(master);
    const windLfo = osc("sine", 0.21);
    windLfo.connect(gain(160)).connect(windBP.frequency);

    // ---------------- boost ----------------
    const boostG = gain(0);
    boostG.connect(master);
    whiteB.connect(filter("bandpass", 1600, 0.8)).connect(gain(0.3)).connect(boostG);
    const whistle = osc("sine", 2600);
    whistle.connect(gain(0.035)).connect(boostG);

    const t0 = ctx.currentTime;
    for (const o of [saw, sq, sub, lope, burble, waterLfo, windLfo, whistle]) o.start(t0);

    return {
      master,
      fx,
      tonal,
      white,
      brown,
      grain,
      saw,
      sq,
      sub,
      engFilter,
      engAmp,
      lope,
      lopeDepth,
      burble,
      burbleDepth,
      gritFilter,
      gritGain,
      brownSrc,
      grainSrc,
      tyreBus,
      surf,
      sandLP,
      roadRumble,
      waterBP,
      waterLfo,
      slipBP,
      slipG,
      roarG,
      windBP,
      windG,
      boostG,
      whistle,
    };
  }

  /** Attack/decay envelope on a gain param. */
  private env(p: AudioParam, t0: number, attack: number, decay: number, peak: number): void {
    const pk = Math.max(peak, 0.0002);
    p.setValueAtTime(0, t0);
    p.linearRampToValueAtTime(pk, t0 + attack);
    p.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  /** Short-lived oscillator voice; nodes disconnect themselves when done. */
  private tone(
    type: OscillatorType,
    f0: number,
    f1: number,
    t0: number,
    attack: number,
    decay: number,
    peak: number,
    dest: AudioNode,
  ): void {
    const ctx = this.ctx as AudioContext;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + attack + decay);
    const a = ctx.createGain();
    this.env(a.gain, t0, attack, decay, peak);
    o.connect(a).connect(dest);
    o.onended = () => {
      o.disconnect();
      a.disconnect();
    };
    o.start(t0);
    o.stop(t0 + attack + decay + 0.03);
  }

  /** Short filtered noise burst from one of the shared buffers. */
  private burst(
    buf: AudioBuffer,
    t0: number,
    attack: number,
    decay: number,
    peak: number,
    type: BiquadFilterType,
    f0: number,
    f1: number,
    q: number,
    dest: AudioNode,
    rate = 1,
  ): void {
    const ctx = this.ctx as AudioContext;
    const dur = attack + decay;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const fl = ctx.createBiquadFilter();
    fl.type = type;
    fl.Q.value = q;
    fl.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    const a = ctx.createGain();
    this.env(a.gain, t0, attack, decay, peak);
    src.connect(fl).connect(a).connect(dest);
    src.onended = () => {
      src.disconnect();
      fl.disconnect();
      a.disconnect();
    };
    const span = Math.max(0, buf.duration - dur * rate - 0.02);
    src.start(t0, Math.random() * span);
    src.stop(t0 + dur + 0.03);
  }

  private chime(f: number, t0: number, peak: number, len: number): void {
    const g = this.g;
    if (!g) return;
    this.tone("sine", f, f, t0, 0.004, len, peak, g.tonal);
    this.tone("sine", f * 2, f * 2, t0, 0.003, len * 0.5, peak * 0.35, g.tonal);
    this.tone("triangle", f * 3, f * 3, t0, 0.002, len * 0.25, peak * 0.12, g.tonal);
  }

  /** Exhaust backfire pop (only a few, after a throttle lift). */
  private pop(t: number): void {
    const g = this.g;
    if (!g) return;
    const tt = t + Math.random() * 0.02;
    this.burst(g.brown, tt, 0.001, 0.05, 0.16, "bandpass", 520, 380, 0.9, g.fx);
    this.tone("sine", 110, 55, tt, 0.002, 0.06, 0.12, g.fx);
  }
}
