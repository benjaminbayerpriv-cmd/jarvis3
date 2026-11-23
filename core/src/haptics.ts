// Haptisches Feedback am Trackpad (nur macOS mit Force-Touch-Trackpad), über `uimap haptic-serve` (tools/uimap-mac).
//  - click: Jarvis klickt (Webseite oder Computer)
//  - think: sanfter Takt, solange Jarvis nachdenkt
//  - tick:  winziger Impuls je Buchstabe im Antwort-Stream (nur Textmodus)
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Pulse = "click" | "think" | "tick";
type Sink = (pulse: Pulse) => void;

export interface HapticsOptions {
  enabled: () => boolean;
  /** Läuft gerade eine Antwort, die noch keinen Text liefert? */
  waiting: () => boolean;
  sink?: Sink;
  bin?: string;
  thinkEveryMs?: number;
}

export class Haptics {
  private proc?: ReturnType<typeof Bun.spawn>;
  private lastTick = 0;
  private lastText = 0;
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;

  constructor(private o: HapticsOptions) {}

  private get bin() { return this.o.bin ?? join(import.meta.dir, "../../tools/uimap-mac/bin/uimap"); }
  available() { return !!this.o.sink || (process.platform === "darwin" && !this.failed && existsSync(this.bin)); }

  private send: Sink = pulse => {
    if (this.o.sink) return this.o.sink(pulse);
    if (!this.proc || this.proc.exitCode !== null) {
      try { this.proc = Bun.spawn([this.bin, "haptic-serve"], { stdin: "pipe", stdout: "ignore", stderr: "ignore" }); }
      catch { this.failed = true; return; }
    }
    try { const sink = this.proc!.stdin as import("bun").FileSink; sink.write(pulse + "\n"); sink.flush(); } catch { this.proc = undefined; }
  };

  pulse(pulse: Pulse) {
    if (!this.o.enabled() || !this.available()) return;
    this.send(pulse);
  }

  /** Jarvis hat Text ausgegeben: je Buchstabe ein winziger Impuls (höchstens 4 je Textstück, mind. 20 ms Abstand). */
  text(chars: number) {
    this.lastText = Date.now();
    if (!this.o.enabled() || !this.available() || chars <= 0) return;
    const now = Date.now();
    if (now - this.lastTick < 20) return;
    this.lastTick = now;
    const n = Math.min(4, chars);
    for (let i = 0; i < n; i++) setTimeout(() => this.send("tick"), i * 22);
  }

  /** Denk-Takt: solange `waiting()` gilt und kein Text kommt. Mehrfaches Starten ist harmlos. */
  start() {
    if (this.timer) return;
    const every = this.o.thinkEveryMs ?? 900;
    this.timer = setInterval(() => {
      if (!this.o.enabled() || !this.available() || !this.o.waiting()) return;
      if (Date.now() - this.lastText < every) return; // Text kommt gerade: Buchstaben-Impulse genügen
      this.send("think");
    }, every);
  }

  stop() { clearInterval(this.timer); this.timer = undefined; this.proc?.kill(); this.proc = undefined; }
}
