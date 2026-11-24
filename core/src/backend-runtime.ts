import { BackendStore, type BackendConfig } from "./backend-config";
import { Hermes } from "./hermes";
export type BackendId = "opencode" | "hermes";
type Row = { id: string; title: string; updated: number; serverUrl: string };
export class BackendRuntime {
  readonly store: BackendStore;
  active: BackendId = "opencode";
  config: BackendConfig;
  rows: Row[];
  private clients = new Map<string, Hermes>();
  constructor(home: string) {
    this.store = new BackendStore(home);
    this.config = this.store.loadConfig();
    const raw = this.store.read("sessions.json");
    const rows = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows) || rows.some(r => !r || typeof r.id !== "string" || !r.id.startsWith("hermes_") || typeof r.serverUrl !== "string" || typeof r.title !== "string" || typeof r.updated !== "number")) throw new Error("Ungültige Hermes-Sitzungszuordnung");
    this.rows = rows;
    const active = this.store.read("active.json");
    if (active && JSON.parse(active) === "hermes") this.active = "hermes";
  }
  setActive(id: BackendId) { this.store.write("active.json", JSON.stringify(id)); this.active = id; }
  configure(value: unknown) { this.config = this.store.saveConfig(value); }
  resetClients() { this.clients.clear(); }
  private save() { this.store.write("sessions.json", JSON.stringify(this.rows)); }
  client(id?: string) {
    const row = id ? this.rows.find(r => r.id === id) : undefined;
    if (id && (!row || row.serverUrl !== this.config.baseUrl)) throw new Error("Hermes-Chat gehört zu einem anderen Server");
    const existing = id && this.clients.get(id); if (existing) return existing;
    const client = new Hermes({ url: this.config.baseUrl, apiKey: this.store.getKey() ?? "", ...(this.config.modelBaseUrl ? { provider: "custom" } : this.config.provider !== "default" ? { provider: this.config.provider } : {}), ...(this.config.model !== "hermes-agent" ? { model: this.config.model } : {}) });
    if (id) this.clients.set(id, client);
    return client;
  }
  async createSession(title: string) {
    const client = this.client();
    const rawId = await client.createSession(title);
    const id = `hermes_${Buffer.from(rawId).toString("base64url")}`;
    this.rows.push({ id, title, updated: Date.now(), serverUrl: this.config.baseUrl }); this.save(); this.clients.set(id, client);
    return id;
  }
  raw(id: string) {
    if (!this.rows.some(r => r.id === id)) throw new Error("Hermes-Chat nicht gefunden");
    return Buffer.from(id.slice(7), "base64url").toString();
  }
  rename(id: string, title: string) { const r = this.rows.find(x => x.id === id); if (r) { r.title = title; r.updated = Date.now(); this.save(); } }
  remove(id: string) { this.rows = this.rows.filter(x => x.id !== id); this.clients.delete(id); this.save(); }
}
export const isHermes = (id: string) => id.startsWith("hermes_");
