import { TUNE_PARAMS, resetTuning, saveTuning, type TuneParam } from "./config";
import type { GameContext } from "./types";

const SAVE_DELAY_MS = 400;

interface ParamRow {
  param: TuneParam;
  input: HTMLInputElement;
  readout: HTMLOutputElement | null;
  decimals: number;
}

function decimalsFor(step: number): number {
  return step >= 1 ? 0 : Math.min(3, Math.ceil(-Math.log10(step) - 1e-9));
}

function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent: HTMLElement,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

/**
 * F1 tune panel: sliders for every TUNE_PARAMS entry, live edits, save, reset to defaults.
 * Slides in from the right; groups collapse; edits write ctx.tuning immediately.
 */
export class TunePanel {
  visible = false;

  private readonly root: HTMLElement;
  private readonly rows: ParamRow[] = [];
  private saveTimer = 0;

  constructor(private readonly ctx: GameContext) {
    const root = make("aside", "tune", ctx.uiRoot);
    root.setAttribute("aria-label", "Tuning");
    root.setAttribute("aria-hidden", "true");
    root.inert = true;
    this.root = root;

    const header = make("header", "tune-header", root);
    make("span", "tune-title", header, "TUNE");
    make("kbd", "tune-key", header, "F1");
    const closeX = make("button", "tune-x", header, "✕");
    closeX.type = "button";
    closeX.setAttribute("aria-label", "Close tuning panel");
    closeX.addEventListener("click", () => this.hide());

    const body = make("div", "tune-body", root);
    this.buildGroups(body);

    const footer = make("footer", "tune-footer", root);
    const reset = make(
      "button",
      "tune-btn tune-btn--ghost",
      footer,
      "Reset defaults",
    );
    reset.type = "button";
    reset.addEventListener("click", this.onReset);
    const close = make("button", "tune-btn", footer, "Close");
    close.type = "button";
    close.addEventListener("click", () => this.hide());

    // Keep panel interaction away from the game (and the crosshair off the panel).
    root.addEventListener("pointerdown", stopPropagation);
    root.addEventListener("wheel", stopPropagation, { passive: true });
    root.addEventListener("pointerenter", this.onPointerEnter);
    root.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("keydown", this.onKeyDown);
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.refresh();
    this.root.inert = false;
    this.root.setAttribute("aria-hidden", "false");
    this.root.classList.add("is-open");
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    if (this.root.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
    this.root.inert = true;
    this.root.setAttribute("aria-hidden", "true");
    this.root.classList.remove("is-open");
    this.onPointerLeave();
    this.flushSave();
  }

  dispose(): void {
    this.flushSave();
    window.removeEventListener("keydown", this.onKeyDown);
    this.ctx.uiRoot.classList.remove("ui-hover");
    this.root.remove();
  }

  /** Re-read every value from ctx.tuning (after a reset or external change). */
  refresh(): void {
    for (const row of this.rows)
      this.showValue(row, this.ctx.tuning[row.param.key]);
  }

  private buildGroups(body: HTMLElement): void {
    const groups = new Map<TuneParam["group"], HTMLElement>();
    for (const param of TUNE_PARAMS) {
      let list = groups.get(param.group);
      if (!list) {
        list = this.buildGroup(body, param.group, groups.size === 0);
        groups.set(param.group, list);
      }
      this.rows.push(this.buildRow(list, param));
    }
  }

  private buildGroup(
    body: HTMLElement,
    name: string,
    open: boolean,
  ): HTMLElement {
    const section = make("section", "tune-group", body);
    section.classList.toggle("is-open", open);
    const head = make("button", "tune-group-head", section, name);
    head.type = "button";
    head.setAttribute("aria-expanded", String(open));
    head.addEventListener("click", () => {
      const isOpen = section.classList.toggle("is-open");
      head.setAttribute("aria-expanded", String(isOpen));
    });
    return make("div", "tune-group-body", section);
  }

  private buildRow(list: HTMLElement, param: TuneParam): ParamRow {
    const label = make("label", "tune-row", list);
    make("span", "tune-label", label, param.label);
    const input = document.createElement("input");
    let readout: HTMLOutputElement | null = null;
    if (param.toggle) {
      label.classList.add("tune-row--toggle");
      input.type = "checkbox";
      input.className = "tune-switch";
      label.appendChild(input);
    } else {
      readout = make("output", "tune-value", label);
      input.type = "range";
      input.className = "tune-slider";
      input.min = String(param.min);
      input.max = String(param.max);
      input.step = String(param.step);
      label.appendChild(input);
    }
    const row: ParamRow = {
      param,
      input,
      readout,
      decimals: decimalsFor(param.step),
    };
    input.addEventListener("input", () => this.onEdit(row));
    input.addEventListener("change", () => this.onEdit(row));
    // Drop focus after a drag so WASD drives the soldier again instead of the slider.
    input.addEventListener("pointerup", () => input.blur());
    return row;
  }

  private onEdit(row: ParamRow): void {
    const { param, input } = row;
    const value = param.toggle ? (input.checked ? 1 : 0) : Number(input.value);
    if (!Number.isFinite(value)) return;
    this.ctx.tuning[param.key] = value;
    this.showReadout(row, value);
    this.scheduleSave();
  }

  private showValue(row: ParamRow, value: number): void {
    if (row.param.toggle) {
      row.input.checked = value >= 0.5;
    } else {
      row.input.value = String(value);
      this.showReadout(row, value);
    }
  }

  /** Numeric readout + the filled part of the slider track (--fill). */
  private showReadout(row: ParamRow, value: number): void {
    if (!row.readout) return;
    const { min, max } = row.param;
    const fill = ((value - min) / (max - min)) * 100;
    row.readout.textContent = value.toFixed(row.decimals);
    row.input.style.setProperty(
      "--fill",
      `${Math.min(100, Math.max(0, fill))}%`,
    );
  }

  private scheduleSave(): void {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = 0;
      saveTuning(this.ctx.tuning);
    }, SAVE_DELAY_MS);
  }

  private flushSave(): void {
    if (!this.saveTimer) return;
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    saveTuning(this.ctx.tuning);
  }

  private readonly onReset = (): void => {
    window.clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    resetTuning(this.ctx.tuning);
    this.refresh();
    this.ctx.events.emit("toast", { text: "TUNING RESET" });
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.code !== "Escape" || !this.visible) return;
    e.preventDefault();
    this.hide();
  };

  private readonly onPointerEnter = (e: PointerEvent): void => {
    if (e.pointerType === "mouse") this.ctx.uiRoot.classList.add("ui-hover");
  };

  private readonly onPointerLeave = (): void => {
    this.ctx.uiRoot.classList.remove("ui-hover");
  };
}

function stopPropagation(e: Event): void {
  e.stopPropagation();
}
