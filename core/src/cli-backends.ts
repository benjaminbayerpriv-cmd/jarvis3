// Verwaltung der Claude-Code- und Codex-Chats: Zuordnung, Verlauf und Einstellungen. Alles liegt in der geschützten Ablage (Dateirechte 0600
// in ~/.jarvis3/backend/, nicht verschlüsselt). Jarvis führt den Verlauf selbst; die Programme bekommen nur ihre eigene Sitzungs-ID.
import type { BackendStore } from "./backend-config";
import { CLI_KINDS, CliAgent, defaultCliConfig, parseCliConfig, type CliConfig, type CliKind } from "./cli-agents";

export type CliRow = { id: string; kind: CliKind; title: string; updated: number; native: string; started: boolean };
export type CliMessage = { id: string; role: "user" | "assistant"; text: string; files?: string[] };
const ID = /^(claude|codex)_[0-9a-f-]{36}$/;
export const cliKindOf = (id: unknown): CliKind | undefined => typeof id === "string" && ID.test(id) ? (id.split("_")[0] as CliKind) : undefined;
export const isCli = (id: unknown) => cliKindOf(id) !== undefined;

export class CliBackends {
  rows: CliRow[];
  readonly configs: Record<CliKind, CliConfig>;
  constructor(readonly store: BackendStore, readonly agent: CliAgent) {
    const raw = store.read("cli-sessions.json");
    const rows = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(rows) || rows.some(r => !r || !ID.test(r.id) || cliKindOf(r.id) !== r.kind || typeof r.title !== "string" || typeof r.updated !== "number" || typeof r.native !== "string" || typeof r.started !== "boolean"))
      throw new Error("Ungültige Chat-Zuordnung für Claude Code/Codex");
    this.rows = rows;
    this.configs = { claude: this.loadConfig("claude"), codex: this.loadConfig("codex") };
  }
  private loadConfig(kind: CliKind): CliConfig {
    const raw = this.store.read(`cli-${kind}.json`);
    return raw === undefined ? defaultCliConfig() : parseCliConfig(JSON.parse(raw));
  }
  configure(kind: CliKind, input: unknown) { const config = parseCliConfig(input); this.store.write(`cli-${kind}.json`, JSON.stringify(config)); this.configs[kind] = config; }
  private save() { this.store.write("cli-sessions.json", JSON.stringify(this.rows)); }
  private row(id: string) { const r = this.rows.find(x => x.id === id); if (!r) throw new Error("Chat nicht gefunden"); return r; }

  createSession(kind: CliKind, title: string) {
    const id = `${kind}_${crypto.randomUUID()}`;
    // Claude Code bekommt die Sitzungs-ID von uns, Codex vergibt seine beim ersten Lauf
    this.rows.push({ id, kind, title, updated: Date.now(), native: kind === "claude" ? crypto.randomUUID() : "", started: false });
    this.save();
    return id;
  }
  get(id: string) { return this.row(id); }
  /** Nach dem ersten erfolgreichen Lauf: Sitzung kann fortgesetzt werden. */
  markStarted(id: string, native?: string) { const r = this.row(id); if (native) r.native = native; r.started = !!r.native; r.updated = Date.now(); this.save(); }
  touch(id: string) { const r = this.rows.find(x => x.id === id); if (r) { r.updated = Date.now(); this.save(); } }
  rename(id: string, title: string) { const r = this.rows.find(x => x.id === id); if (r) { r.title = title; r.updated = Date.now(); this.save(); } }
  remove(id: string) { this.row(id); this.rows = this.rows.filter(x => x.id !== id); this.save(); this.store.remove(`cli-msg-${id}.json`); }

  messages(id: string): CliMessage[] {
    this.row(id);
    const raw = this.store.read(`cli-msg-${id}.json`);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  }
  append(id: string, message: Omit<CliMessage, "id">) {
    const list = this.messages(id);
    list.push({ id: `m${list.length + 1}`, ...message });
    this.store.write(`cli-msg-${id}.json`, JSON.stringify(list));
  }
}
export { CLI_KINDS };
