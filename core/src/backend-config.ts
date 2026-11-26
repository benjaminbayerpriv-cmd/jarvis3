import { constants, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hermesUrl } from "./hermes";
export type BackendConfig = { provider: string; model: string; baseUrl: string; modelBaseUrl: string; modelSupportsVision: boolean };
export const defaultHermesConfig: BackendConfig = { provider: "default", model: "hermes-agent", baseUrl: "http://127.0.0.1:8642", modelBaseUrl: "", modelSupportsVision: false };
export function parseBackendConfig(input: unknown): BackendConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Ungültige Backend-Einstellungen");
  const v = input as Record<string, unknown>;
  if (typeof v.provider !== "string" || !/^[\w.-]{1,60}$/.test(v.provider) || typeof v.model !== "string" || !v.model.trim() || v.model.length > 200 || /[\x00-\x1f\x7f]/.test(v.model) || typeof v.baseUrl !== "string" || v.baseUrl.length > 300) throw new Error("Anbieter, Modell oder Adresse ungültig");
  let baseUrl: string;
  try { baseUrl = hermesUrl(v.baseUrl); } catch { throw new Error("Hermes-Gateway-Adresse ungültig"); }
  let modelBaseUrl = "";
  if (v.modelBaseUrl !== undefined && v.modelBaseUrl !== "") {
    if (typeof v.modelBaseUrl !== "string" || v.modelBaseUrl.length > 300) throw new Error("Modellanbieter-Adresse ungültig");
    try {
      const u = new URL(v.modelBaseUrl);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error();
      modelBaseUrl = u.toString().replace(/\/$/, "");
    } catch { throw new Error("Modellanbieter-Adresse ungültig"); }
  }
  if (v.modelSupportsVision !== undefined && typeof v.modelSupportsVision !== "boolean") throw new Error("Bildfähigkeit ungültig");
  return { provider: v.provider, model: v.model.trim(), baseUrl, modelBaseUrl, modelSupportsVision: v.modelSupportsVision === true };
}
// Geschützte Datei (0600), keine Verschlüsselung; Windows noch nicht unterstützt.
export class BackendStore {
  private dir: string;
  constructor(home: string) { this.dir = join(home, "backend"); }
  private prepare() {
    if (process.platform === "win32") throw new Error("Geschützte Schlüsseldateien werden unter Windows noch nicht unterstützt");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const s = lstatSync(this.dir);
    if (!s.isDirectory() || s.isSymbolicLink() || (s.mode & 0o077) || (typeof process.getuid === "function" && s.uid !== process.getuid())) throw new Error("Backend-Verzeichnis ist nicht geschützt");
  }
  read(name: string): string | undefined {
    this.prepare(); let fd: number;
    try { fd = openSync(join(this.dir, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
    try { const s = fstatSync(fd); if (!s.isFile() || (s.mode & 0o077) || (typeof process.getuid === "function" && s.uid !== process.getuid())) throw new Error("Backend-Datei ist nicht geschützt"); return readFileSync(fd, "utf8"); }
    finally { closeSync(fd); }
  }
  write(name: string, value: string) {
    this.prepare(); const temp = join(this.dir, `.${name}.${crypto.randomUUID()}`); let fd: number | undefined;
    try { fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); fchmodSync(fd, 0o600); writeFileSync(fd, value, "utf8"); closeSync(fd); fd = undefined; renameSync(temp, join(this.dir, name)); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch {} }
  }
  /** Löscht eine Datei der Ablage (fehlende Datei ist kein Fehler). */
  remove(name: string) { this.prepare(); try { unlinkSync(join(this.dir, name)); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
  loadConfig(): BackendConfig { const raw = this.read("hermes.json"); return raw === undefined ? { ...defaultHermesConfig } : parseBackendConfig(JSON.parse(raw)); }
  saveConfig(input: unknown): BackendConfig { const config = parseBackendConfig(input); this.write("hermes.json", JSON.stringify(config)); return config; }
  getKey(kind: "server" | "provider" = "server"): string | null { return this.read(kind === "server" ? "hermes.key" : "hermes-provider.key") ?? null; }
  setKey(key: string | null, kind: "server" | "provider" = "server") {
    const name = kind === "server" ? "hermes.key" : "hermes-provider.key";
    this.prepare();
    if (key === null) { try { unlinkSync(join(this.dir, name)); } catch (e: any) { if (e.code !== "ENOENT") throw e; } return; }
    if (typeof key !== "string" || !key.length || key.length > 4096 || /[\r\n\x00]/.test(key)) throw new Error("Ungültiger API-Schlüssel");
    this.write(name, key);
  }
}
