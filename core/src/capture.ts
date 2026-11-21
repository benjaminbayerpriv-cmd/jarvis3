// Verbindung zum Aufnahme-Dienst "Jarvis Bildschirm.app" (macOS, tools/uimap-mac/build.sh).
// ScreenCaptureKit liefert nur einer App mit eigener Bildschirmaufnahme-Freigabe Bilder – nicht dem Kommandozeilen-uimap.
// Der Dienst nimmt einzelne Fenster auf (auch verdeckt) und streamt sie für die Vorschau; jarvisd startet ihn bei Bedarf.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Socket } from "node:net";

type Reply = Record<string, any> & { ok?: boolean };

export class Capture {
  private sock?: Socket;
  private pending = new Map<number, (r: Reply) => void>();
  private rid = 0;
  private buf = "";
  private connecting?: Promise<boolean>;
  onEvent?: (m: Reply) => void;

  constructor(readonly app = join(import.meta.dir, "../../tools/uimap-mac/bin/Jarvis Bildschirm.app"), private port = 7779) {}

  available() { return process.platform === "darwin" && existsSync(this.app); }

  private tryConnect(): Promise<boolean> {
    return new Promise(resolve => {
      const sock = new Socket();
      const fail = () => { sock.destroy(); resolve(false); };
      sock.once("error", fail);
      sock.setTimeout(1500, fail);
      sock.connect(this.port, "127.0.0.1", () => {
        sock.setTimeout(0);
        sock.removeListener("error", fail);
        sock.on("error", () => {});
        sock.on("close", () => { if (this.sock === sock) this.sock = undefined; for (const [, r] of this.pending) r({ ok: false, error: "Aufnahme-Dienst beendet" }); this.pending.clear(); });
        sock.on("data", chunk => this.read(String(chunk)));
        this.sock = sock;
        resolve(true);
      });
    });
  }

  private read(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
      let m: Reply;
      try { m = JSON.parse(line); } catch { continue; }
      if (m.event) { this.onEvent?.(m); continue; }
      const id = Number(m.rid);
      this.pending.get(id)?.(m); this.pending.delete(id);
    }
  }

  private ensure(): Promise<boolean> {
    if (this.sock && !this.sock.destroyed) return Promise.resolve(true);
    if (!this.available()) return Promise.resolve(false);
    return this.connecting ??= (async () => {
      try {
        if (await this.tryConnect()) return true;
        Bun.spawn(["open", "-g", "-n", "-a", this.app, "--args", "capture-serve", "--port", String(this.port)], { stdout: "ignore", stderr: "ignore" });
        for (let n = 0; n < 30; n++) { await Bun.sleep(300); if (await this.tryConnect()) return true; }
        return false;
      } finally { this.connecting = undefined; }
    })();
  }

  private lastRestart = 0;
  /** Nach dem Erteilen der Bildschirmaufnahme-Freigabe muss der Dienst neu starten, sonst gilt die alte Ablehnung weiter. */
  private async restartIfDenied(r: Reply) {
    if (r.ok || !/TCC|abgelehnt|denied|declined|Freigabe/i.test(String(r.error ?? "")) || Date.now() - this.lastRestart < 30_000) return false;
    this.lastRestart = Date.now();
    try {
      const pids = Bun.spawnSync(["lsof", "-ti", `tcp:${this.port}`, "-sTCP:LISTEN"]).stdout.toString().trim().split(/\s+/).filter(Boolean);
      for (const pid of pids) { try { process.kill(Number(pid), "SIGTERM"); } catch {} }
    } catch {}
    this.sock?.destroy(); this.sock = undefined;
    await Bun.sleep(500);
    return true;
  }

  async call(cmd: Record<string, unknown>, timeoutMs = 10_000): Promise<Reply> {
    const r = await this.callOnce(cmd, timeoutMs);
    if (await this.restartIfDenied(r)) return this.callOnce(cmd, timeoutMs);
    return r;
  }

  private async callOnce(cmd: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    if (!(await this.ensure())) return { ok: false, error: "Aufnahme-Dienst nicht verfügbar (tools/uimap-mac/build.sh ausführen)" };
    const rid = ++this.rid;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, error: "Aufnahme-Dienst: Zeitüberschreitung" }); }, timeoutMs);
      this.pending.set(rid, r => { clearTimeout(timer); resolve(r); });
      this.sock!.write(JSON.stringify({ ...cmd, rid }) + "\n");
    });
  }
}
