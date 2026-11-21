// Ein Bildstrom für alle Oberflächen. Auswahl und Aufnahmestart laufen getrennt,
// damit ein verspäteter Start keinen neueren Wunsch überschreibt.
export type PreviewTarget = number | `win:${number}`;
type Hooks = {
  start: (target: PreviewTarget) => Promise<boolean>;
  stop: (target: PreviewTarget) => Promise<void>;
  idle: () => void;
};

export class Preview {
  active?: PreviewTarget;
  pinned?: PreviewTarget;
  private wanted?: PreviewTarget;
  private recent?: PreviewTarget;
  private lastWork = 0;
  private lastSwitch = 0;
  private candidate?: PreviewTarget;
  private switchTimer?: ReturnType<typeof setTimeout>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private updating = false;

  constructor(private hooks: Hooks, private timing = { settle: 450, hold: 1800, idle: 8000 }) {}

  shows(target: PreviewTarget) {
    return this.active === target && this.wanted === target;
  }

  work(target: PreviewTarget) {
    this.recent = target;
    this.lastWork = Date.now();
    if (this.pinned !== undefined) return;
    this.armIdle();
    if (target === this.wanted) { this.cancelSwitch(); return; }
    if (this.wanted === undefined) { this.select(target); return; }
    if (target === this.candidate) return;
    this.cancelSwitch();
    this.candidate = target;
    this.switchTimer = setTimeout(() => this.select(target),
      Math.max(this.timing.settle, this.lastSwitch + this.timing.hold - Date.now()));
  }

  setIdle(ms: number) {
    this.timing.idle = ms;
    if (this.pinned === undefined && this.recent !== undefined) this.armIdle();
  }

  pin(target?: PreviewTarget) {
    this.pinned = target;
    clearTimeout(this.idleTimer);
    if (target !== undefined) this.select(target);
    else if (this.recent !== undefined && Date.now() - this.lastWork < this.timing.idle) {
      this.select(this.recent);
      this.armIdle();
    } else this.clear();
  }

  clear() {
    this.pinned = undefined;
    this.recent = undefined;
    clearTimeout(this.idleTimer);
    this.select(undefined);
  }

  ended(target: PreviewTarget) {
    if (this.active !== target) return;
    this.active = undefined;
    if (this.pinned === target) this.pinned = undefined;
    if (this.wanted === target) this.select(undefined);
  }

  private cancelSwitch() {
    clearTimeout(this.switchTimer);
    this.candidate = undefined;
  }

  private armIdle() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.clear(), Math.max(0, this.lastWork + this.timing.idle - Date.now()));
  }

  private select(target?: PreviewTarget) {
    this.cancelSwitch();
    if (this.wanted !== target && target !== undefined) this.lastSwitch = Date.now();
    this.wanted = target;
    if (target === undefined) this.hooks.idle();
    void this.update();
  }

  private async update() {
    if (this.updating) return;
    this.updating = true;
    try {
      while (this.active !== this.wanted) {
        if (this.active !== undefined) {
          const previous = this.active;
          this.active = undefined;
          await this.hooks.stop(previous).catch(() => {});
        }
        const target = this.wanted;
        if (target === undefined) continue;
        this.active = target;
        if (!await this.hooks.start(target).catch(() => false)) this.ended(target);
      }
    } finally { this.updating = false; }
  }
}
