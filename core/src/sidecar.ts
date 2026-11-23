// Überwacht den Sprach-Sidecar: startet ihn, wenn er nicht läuft, und kann ihn neu starten.
// Vorher startete ihn nur die Tauri-Hülle (oder ein Mensch im Terminal); fiel er aus oder hing er, blieb Jarvis stumm und taub,
// ohne dass es jemand merkte. Der Sidecar läuft abgekoppelt (detached) weiter, wenn jarvisd neu startet.
import { connect } from "node:net";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";

const PORT = 7778;
const LABEL = "local.jarvis3.speech";

/** PIDs, die auf dem Port lauschen: lsof (macOS/Linux) bzw. netstat (Windows, dort gibt es kein lsof). */
export function listeningPids(port: number): number[] {
  if (process.platform === "win32") {
    const out = Bun.spawnSync(["netstat", "-ano", "-p", "TCP"]).stdout.toString();
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+:0\s+\S+\s+(\d+)$/i);   // lauschend = Gegenstelle :0 (Statuswort ist je nach Windows-Sprache anders)
      if (m && Number(m[1]) === port) pids.add(Number(m[2]));
    }
    return [...pids];
  }
  const out = Bun.spawnSync(["lsof", "-ti", `tcp:${port}`, "-sTCP:LISTEN"]).stdout.toString().trim();
  return out.split(/\s+/).filter(Boolean).map(Number);
}
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
      this.log("Sprach-Sidecar nicht erreichbar -> starte ihn");
      if (!this.spawnViaLaunchd()) {
        const fd = openSync(join(this.home, "sidecar.log"), "a");
        const proc = Bun.spawn(["uv", "run", "--project", "speech", "python", "-m", "jarvis_speech"],
          { cwd: this.root, stdin: "ignore", stdout: fd, stderr: fd, detached: true } as any);
        proc.unref?.();
        closeSync(fd);
      }
      const until = Date.now() + 120_000;                    // Modelle laden dauert etwa 20–40 s
      while (Date.now() < until && !(await portOpen(PORT))) await Bun.sleep(1000);
    } catch (error) {
      this.log(`Sprach-Sidecar konnte nicht gestartet werden: ${error instanceof Error ? error.message : error}`);
    } finally { this.busy = false; }
  }

  /**
   * macOS: Das Mikrofon gehört dem "verantwortlichen Prozess" der Kette. Hängt der Sidecar unter jarvisd (bun), das von einem
   * Hintergrunddienst (launchd) gestartet wurde, gilt bun als verantwortlich, hat keine Mikrofon-Freigabe und bekommt von macOS
   * lautlos nur Nullen: Jarvis "hört" nichts, obwohl alles läuft. Gemessen: dasselbe Python direkt unter launchd = Pegel 0,05, als
   * Kind von bun = exakt 0,0. Darum startet der Sidecar hier als eigener launchd-Auftrag direkt mit dem Python der Umgebung.
   */
  private spawnViaLaunchd(): boolean {
    if (process.platform !== "darwin") return false;
    const python = join(process.env.UV_PROJECT_ENVIRONMENT || join(this.root, "speech", ".venv"), "bin", "python"); // die Umgebung kann außerhalb des Checkouts liegen
    if (!existsSync(python)) return false;
    try {
      Bun.spawnSync(["launchctl", "remove", LABEL]);
      const r = Bun.spawnSync(["launchctl", "submit", "-l", LABEL, "-o", join(this.home, "sidecar.log"), "-e", join(this.home, "sidecar.log"), "--",
        "/bin/sh", "-c", 'cd "$1" && exec "$2" -m jarvis_speech', "sh", join(this.root, "speech"), python]);
      return r.exitCode === 0;
    } catch { return false; }
  }

  /** Beendet den laufenden Sidecar; tick() startet ihn danach neu (liest dabei auch die Audiogeräte frisch ein). */
  async restart() {
    try {
      if (process.platform === "darwin") Bun.spawnSync(["launchctl", "remove", LABEL]); // beendet den Auftrag samt Prozess
      for (const pid of listeningPids(PORT)) { try { process.kill(pid, "SIGTERM"); } catch {} }
    } catch {}
    this.retryAfter = 0;
  }
}
