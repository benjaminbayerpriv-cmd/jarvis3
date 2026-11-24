import { connect } from "node:net";
import { defaultHome, setupHome } from "./hermes-tools";
import { Hermes, hermesUrl } from "./hermes";

// Startet ausschließlich einen eigenen Prozess und verbindet sich nie mit einem fremd belegten Port.
export class HermesSupervisor {
  private proc?: ReturnType<typeof Bun.spawn>;
  private startedUrl = "";
  private starting?: Promise<void>;
  get isStarting() { return !!this.starting; }
  get running() { return !!this.proc && this.proc.exitCode === null; }
  constructor(private daemonPort: number, private home = defaultHome()) {}
  private portBusy(port: number, host: string) {
    return new Promise<boolean>(resolve => {
      const socket = connect({ port, host }); socket.setTimeout(500);
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); });
    });
  }
  async ensure(url: string, key: string) {
    if (this.starting) { await this.starting; return this.ensure(url, key); }
    this.starting = this.start(url, key);
    try { await this.starting; } finally { this.starting = undefined; }
  }
  private async start(url: string, key: string) {
    const endpoint = new URL(hermesUrl(url));
    if (endpoint.pathname !== "/") throw new Error("Der verwaltete Hermes-Server benötigt eine Adresse ohne Pfad");
    if (key.trim().length < 16) throw new Error("Hermes-Server-Schlüssel muss mindestens 16 Zeichen lang sein");
    if (this.proc && this.proc.exitCode === null) {
      if (this.startedUrl !== url) throw new Error("Hermes läuft bereits mit einer anderen Adresse");
      await new Hermes({ url, apiKey: key }).testConnection(); return;
    }
    const host = endpoint.hostname.replace(/^\[|\]$/g, ""), port = Number(endpoint.port || 80);
    if (await this.portBusy(port, host)) throw new Error("Hermes-Port ist bereits belegt; fremde Dienste werden nicht übernommen");
    const result = setupHome(this.home, { daemonUrl: `http://127.0.0.1:${this.daemonPort}`, stopOnCancel: true });
    if (!result.ok) throw new Error("Hermes-Arbeitsverzeichnis ist nicht von Jarvis verwaltet");
    this.startedUrl = url;
    this.proc = Bun.spawn(["hermes", "gateway"], { stdout: "ignore", stderr: "ignore", env: { ...process.env,
      HERMES_HOME: this.home, API_SERVER_ENABLED: "true", API_SERVER_HOST: host, API_SERVER_PORT: String(port), API_SERVER_KEY: key } });
    const client = new Hermes({ url, apiKey: key });
    for (let i = 0; i < 80; i++) {
      if (this.proc.exitCode !== null) throw new Error("Verwalteter Hermes-Server konnte nicht gestartet werden");
      try { await client.testConnection(); return; } catch { await Bun.sleep(250); }
    }
    this.stop(); throw new Error("Verwalteter Hermes-Server antwortet nicht");
  }
  stop() { this.proc?.kill(); this.proc = undefined; this.startedUrl = ""; }
}
