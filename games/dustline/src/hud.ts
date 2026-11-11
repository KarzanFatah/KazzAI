import { formatTime, type Race } from "./race";
import { prefersTouch } from "./touch";

export interface HudHandlers {
  onBackToTrack(): void;
  onCamera(): void;
  onMute(): void;
  onStart(): void;
}

export interface HudFrame {
  speedKmh: number;
  fps: number;
  boost: number; // 0..1
  boosting: boolean;
  race: Race;
  muted: boolean;
}

/** DOM overlay: speed pill, race panel, top-right buttons, toasts, countdown, intro and results. */
export class Hud {
  private readonly speedEl: HTMLElement;
  private readonly boostEl: HTMLElement;
  private readonly lapEl: HTMLElement;
  private readonly timeEl: HTMLElement;
  private readonly bestEl: HTMLElement;
  private readonly cpEl: HTMLElement;
  private readonly toastEl: HTMLElement;
  private readonly centerEl: HTMLElement;
  private readonly wrongEl: HTMLElement;
  private readonly muteBtn: HTMLButtonElement;
  private readonly intro: HTMLElement;
  private readonly finish: HTMLElement;
  private toastTimer = 0;
  private centerTimer = 0;
  private last: Record<string, string> = {};

  constructor(
    private readonly root: HTMLElement,
    private readonly handlers: HudHandlers,
  ) {
    root.insertAdjacentHTML(
      "beforeend",
      `<div class="hud">
        <div class="pill speed"><span class="v">000</span> KM/H · <span class="fps">60</span> FPS
          <div class="boost"><i></i></div></div>
        <div class="race">
          <div class="row"><span class="lap">LAP 1/3</span><span class="cp">CP 0/8</span></div>
          <div class="time">0:00.00</div>
          <div class="best">BEST —</div>
        </div>
        <div class="buttons">
          <button class="btn track" type="button">BACK TO TRACK</button>
          <button class="btn icon cam" type="button" aria-label="Camera">${CAM_ICON}</button>
          <button class="btn icon mute" type="button" aria-label="Sound">${SOUND_ICON}</button>
        </div>
        <div class="toast"></div>
        <div class="center"></div>
        <div class="wrong">WRONG WAY</div>
        <div class="keys">W/↑ GAS · S/↓ BRAKE · A D STEER · SPACE HANDBRAKE · SHIFT BOOST · E JUMP · R BACK TO TRACK · C CAMERA · M SOUND</div>
      </div>`,
    );
    const q = (s: string) => root.querySelector(s) as HTMLElement;
    this.speedEl = q(".speed .v");
    this.boostEl = q(".boost i");
    this.lapEl = q(".race .lap");
    this.cpEl = q(".race .cp");
    this.timeEl = q(".race .time");
    this.bestEl = q(".race .best");
    this.toastEl = q(".toast");
    this.centerEl = q(".center");
    this.wrongEl = q(".wrong");
    this.muteBtn = q(".mute") as HTMLButtonElement;
    const tap = (el: HTMLElement, fn: () => void) =>
      el.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        e.preventDefault();
        fn();
      });
    tap(q(".track"), handlers.onBackToTrack);
    tap(q(".cam"), handlers.onCamera);
    tap(this.muteBtn, handlers.onMute);

    this.intro = document.createElement("div");
    this.intro.className = "overlay intro";
    const touch = prefersTouch();
    this.intro.innerHTML = `
      <div class="panel">
        <div class="kicker">DESERT RALLY · ONE LEVEL · THREE LAPS</div>
        <h1>DUSTLINE</h1>
        <p class="tag">Sand, jumps and a long sideways slide past the old pump station.</p>
        <ul class="ctl">${
          touch
            ? `<li><b>LEFT SLIDER</b>steer · swipe up to jump · drag down to boost</li>
               <li><b>GAS</b>hold to drive</li>
               <li><b>BRAKE</b>brake / reverse · drag down for the handbrake (drift)</li>`
            : `<li><b>W A S D</b>drive and steer</li>
               <li><b>SPACE</b>handbrake (drift)</li>
               <li><b>SHIFT · E</b>boost · jump</li>
               <li><b>R · C · M</b>back to track · camera · sound</li>`
        }</ul>
        <div class="go">${touch ? "TAP TO START" : "CLICK OR PRESS ENTER"}</div>
        ${touch ? `<div class="hint">Best played in landscape</div>` : ""}
      </div>`;
    root.appendChild(this.intro);
    this.intro.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handlers.onStart();
    });

    this.finish = document.createElement("div");
    this.finish.className = "overlay finish hidden";
    root.appendChild(this.finish);
  }

  hideIntro(): void {
    this.intro.classList.add("hidden");
  }

  showFinish(total: number, laps: number[], bestEver: number): void {
    const best = Math.min(...laps);
    this.finish.innerHTML = `
      <div class="panel">
        <div class="kicker">FINISH</div>
        <h1>${formatTime(total)}</h1>
        <ul class="laps">${laps
          .map((t, i) => `<li class="${t === best ? "best" : ""}"><b>LAP ${i + 1}</b>${formatTime(t)}</li>`)
          .join("")}</ul>
        <p class="tag">Best lap ever: ${formatTime(bestEver)}</p>
        <button class="btn again" type="button">DRIVE AGAIN</button>
      </div>`;
    this.finish.classList.remove("hidden");
    const again = this.finish.querySelector(".again") as HTMLElement;
    again.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.finish.classList.add("hidden");
      this.handlers.onStart();
    });
  }

  hideFinish(): void {
    this.finish.classList.add("hidden");
  }

  toast(text: string, seconds = 1.6): void {
    this.toastEl.textContent = text;
    this.toastEl.classList.add("show");
    this.toastTimer = seconds;
  }

  center(text: string, seconds = 0.9, cls = ""): void {
    this.centerEl.textContent = text;
    this.centerEl.className = `center show ${cls}`;
    this.centerTimer = seconds;
  }

  private set(key: string, el: HTMLElement, value: string): void {
    if (this.last[key] === value) return;
    this.last[key] = value;
    el.textContent = value;
  }

  update(dt: number, f: HudFrame): void {
    this.set("speed", this.speedEl, String(Math.round(f.speedKmh)).padStart(3, "0"));
    this.set("fps", this.root.querySelector(".fps") as HTMLElement, String(f.fps));
    const boostW = `${Math.round(f.boost * 100)}%`;
    if (this.last.boost !== boostW) {
      this.last.boost = boostW;
      this.boostEl.style.width = boostW;
    }
    this.boostEl.classList.toggle("on", f.boosting);
    const r = f.race;
    this.set("lap", this.lapEl, `LAP ${Math.min(r.lap, r.laps)}/${r.laps}`);
    const passed = r.nextCheckpoint === 0 ? r.checkpointCount - 1 : r.nextCheckpoint - 1;
    this.set("cp", this.cpEl, `CP ${passed}/${r.checkpointCount - 1}`);
    this.set("time", this.timeEl, formatTime(r.lapTime) === "—" ? "0:00.00" : formatTime(r.lapTime));
    this.set("best", this.bestEl, `BEST ${formatTime(r.bestLap)}`);
    this.wrongEl.classList.toggle("show", r.wrongWay);
    this.muteBtn.classList.toggle("off", f.muted);

    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove("show");
    }
    if (this.centerTimer > 0) {
      this.centerTimer -= dt;
      if (this.centerTimer <= 0) this.centerEl.classList.remove("show");
    }
  }
}

const CAM_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>`;
const SOUND_ICON = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10v4h4l5 4V6L8 10z"/><path class="w" d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11"/></svg>`;
