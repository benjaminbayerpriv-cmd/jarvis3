// Überwacht den Sprach-Sidecar: startet ihn, wenn er nicht läuft, und kann ihn neu starten.
// Vorher startete ihn nur die Tauri-Hülle (oder ein Mensch im Terminal); fiel er aus oder hing er, blieb Jarvis stumm und taub,
// ohne dass es jemand merkte. Der Sidecar läuft abgekoppelt (detached) weiter, wenn jarvisd neu startet.
import { connect } from "node:net";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const PORT = 7778;
const portOpen = (port: number) => new Promise<boolean>(resolve => {
  const socket = connect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
  setTimeout(() => { socket.destroy(); resolve(false); }, 800);
});

export class SidecarSupervisor {
  private busy = false;
  private retryAfter = 0;

  constructor(private connected: () => boolean, private log: (line: string) => void, private root: string, private home: string) {}

  start(initialGraceMs = 0) {
    this.retryAfter = Date.now() + initialGraceMs;
    setInterval(() => void this.tick(), 3000);
    void this.tick();
  }

  private async tick() {
    if (this.busy || this.connected()) return;
    if (await portOpen(PORT)) return;                       // läuft schon (verbindet sich gleich)
    if (Date.now() < this.retryAfter) return;       // nicht dauernd neu starten, falls der Start scheitert
    await this.spawn();
  }

  private async spawn() {
    this.busy = true; this.retryAfter = Date.now() + 20_000;
    try {
      mkdirSync(this.home, { recursive: true });
      const fd = openSync(join(this.home, "sidecar.log"), "a");
      this.log("Sprach-Sidecar nicht erreichbar -> starte ihn");
      const proc = Bun.spawn(["uv", "run", "--project", "speech", "python", "-m", "jarvis_speech"],
        { cwd: this.root, stdin: "ignore", stdout: fd, stderr: fd, detached: true } as any);
      proc.unref?.();
      closeSync(fd);
      const until = Date.now() + 120_000;                    // Modelle laden dauert etwa 20–40 s
      while (Date.now() < until && !(await portOpen(PORT))) await Bun.sleep(1000);
    } catch (error) {
      this.log(`Sprach-Sidecar konnte nicht gestartet werden: ${error instanceof Error ? error.message : error}`);
    } finally { this.busy = false; }
  }

  /** Beendet den laufenden Sidecar; tick() startet ihn danach neu (liest dabei auch die Audiogeräte frisch ein). */
  async restart() {
    try {
      const out = Bun.spawnSync(["lsof", "-ti", `tcp:${PORT}`, "-sTCP:LISTEN"]).stdout.toString().trim();
      for (const pid of out.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid), "SIGTERM"); } catch {} }
    } catch {}
    this.retryAfter = 0;
  }
}
