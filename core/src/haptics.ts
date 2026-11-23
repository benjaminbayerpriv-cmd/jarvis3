// Haptisches Feedback am Trackpad (nur macOS mit Force-Touch-Trackpad), über `uimap haptic-serve` (tools/uimap-mac).
//  - click: Jarvis klickt (Webseite oder Computer)
//  - think: sanfter Takt, solange Jarvis nachdenkt und kein Werkzeug läuft
//  - tool:  ein Impuls, wenn ein Werkzeugaufruf beginnt und einer, wenn er endet
//  - tick:  schnelles, gleichmäßiges Flirren, solange Text im Antwort-Stream hereinkommt (nur Textmodus)
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Pulse = "click" | "think" | "tick" | "tool";
export type Strength = "soft" | "normal" | "strong";
/** Stärke-Nummern des Aktors (1–6 schwach bis stark, 15/16 kräftiger Klick) je Impuls und Stufe */
export const ACTUATION: Record<Strength, Record<Pulse, number>> = {
  soft:   { tick: 1, think: 1, tool: 2, click: 3 },
  normal: { tick: 1, think: 3, tool: 4, click: 6 },
  strong: { tick: 2, think: 4, tool: 6, click: 15 },
};
type Sink = (pulse: Pulse, strength: number) => void;

export interface HapticsOptions {
  /** Hauptschalter und Fokus: nur vibrieren, wenn Jarvis (App oder Webseite) im Vordergrund ist */
  enabled: () => boolean;
  /** Einzelne Arten (Klick, Werkzeug, Nachdenken, Schreiben) ein-/ausschalten */
  allow?: (pulse: Pulse) => boolean;
  strength?: () => Strength;
  /** Läuft gerade eine Antwort, die noch keinen Text liefert? */
  waiting: () => boolean;
  sink?: Sink;
  bin?: string;
  thinkEveryMs?: number;
  streamEveryMs?: number;
  streamQuietMs?: number;
}

export class Haptics {
  private proc?: ReturnType<typeof Bun.spawn>;
  private stream?: ReturnType<typeof setInterval>;
  private lastText = 0;
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;

  constructor(private o: HapticsOptions) {}

  private get bin() { return this.o.bin ?? join(import.meta.dir, "../../tools/uimap-mac/bin/uimap"); }
  available() { return !!this.o.sink || (process.platform === "darwin" && !this.failed && existsSync(this.bin)); }

  private send: Sink = (pulse, strength) => {
    if (this.o.sink) return this.o.sink(pulse, strength);
    if (!this.proc || this.proc.exitCode !== null) {
      try { this.proc = Bun.spawn([this.bin, "haptic-serve"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" }); }
      catch { this.failed = true; return; }
    }
    try { const sink = this.proc!.stdin as import("bun").FileSink; sink.write(`${pulse} ${strength}\n`); sink.flush(); } catch { this.proc = undefined; }
  };

  pulse(pulse: Pulse) {
    if (!this.on(pulse) || !this.available()) return;
    this.deliver(pulse);
  }

  private on(pulse: Pulse) { return this.o.enabled() && (this.o.allow?.(pulse) ?? true); }
  private deliver(pulse: Pulse) { this.send(pulse, ACTUATION[this.o.strength?.() ?? "normal"][pulse]); }

  /**
   * Jarvis schreibt: ein gleichmäßiges, schnelles Flirren (alle 45 ms), solange Text hereinkommt. Die Menge spielt keine Rolle
   * (große Textstücke ergeben nicht mehr Impulse) und es endet innerhalb von ~120 ms nach dem letzten Text, also nie nachlaufend.
   */
  text(_chars = 1) {
    this.lastText = Date.now();
    if (!this.on("tick") || !this.available() || this.stream) return;
    const every = this.o.streamEveryMs ?? 45, quiet = this.o.streamQuietMs ?? 120;
    this.deliver("tick");
    this.stream = setInterval(() => {
      if (!this.on("tick") || Date.now() - this.lastText > quiet) return this.finish();
      this.deliver("tick");
    }, every);
  }

  /** Antwort fertig, gestoppt oder abgebrochen: sofort Ruhe. */
  finish() { clearInterval(this.stream); this.stream = undefined; }

  /** Denk-Takt: solange `waiting()` gilt (läuft, ohne Text und ohne laufendes Werkzeug). Mehrfaches Starten ist harmlos. */
  start() {
    if (this.timer) return;
    const every = this.o.thinkEveryMs ?? 900;
    this.timer = setInterval(() => {
      if (!this.on("think") || !this.available() || !this.o.waiting()) return;
      if (Date.now() - this.lastText < every) return; // Text kommt gerade: Buchstaben-Impulse genügen
      this.deliver("think");
    }, every);
  }

  stop() { this.finish(); clearInterval(this.timer); this.timer = undefined; this.proc?.kill(); this.proc = undefined; }
}
