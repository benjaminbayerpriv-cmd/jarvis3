// Erweiterungen: MCP-Server, Skills, eigene Befehle und Plugins.
// Gespeichert in ~/.jarvis3/extensions.json und beim Start in die OpenCode-Konfiguration des Arbeitsordners geschrieben:
//   workspace/opencode.json            -> "mcp", "plugin", Skill-Sperren
//   workspace/.opencode/command/*.md   -> eigene Befehle (Schrägstrich-Befehle im Chat)
//   workspace/.opencode/skills/<name>  -> Verknüpfungen zu importierten Skill-Ordnern
// Import liest die Dateien von Claude (~/.claude, ~/.claude.json), Codex (~/.codex) und OpenCode (~/.config/opencode).
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, lstatSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type Source = "manual" | "claude" | "codex" | "opencode";
export interface McpEntry {
  type: "local" | "remote";
  command?: string[]; environment?: Record<string, string>;
  url?: string; headers?: Record<string, string>;
  enabled: boolean; source: Source;
}
export interface CommandEntry { description: string; template: string; source: Source }
export interface Store {
  mcp: Record<string, McpEntry>;
  commands: Record<string, CommandEntry>;
  skillDirs: Record<string, { path: string; source: Source }>;   // Name -> Ordner mit SKILL.md
  disabledSkills: string[];
  mcpOverrides?: Record<string, boolean>;
  plugins: string[];                                            // npm-Pakete oder Dateien für OpenCode
}
export type ImportKind = "mcp" | "skill" | "command" | "plugin";
export interface Candidate {
  id: string; kind: ImportKind; name: string; from: Source; detail: string;
  status: "neu" | "vorhanden";
  data: any;
}

const HOME = homedir();
export const STORE_FILE = () => process.env.JARVIS_EXTENSIONS ?? join(HOME, ".jarvis3", "extensions.json");
const empty = (): Store => ({ mcp: {}, commands: {}, skillDirs: {}, disabledSkills: [], plugins: [] });

export function loadStore(): Store {
  try {
    const raw = JSON.parse(readFileSync(STORE_FILE(), "utf8"));
    return { ...empty(), ...raw, mcp: raw.mcp ?? {}, commands: raw.commands ?? {}, skillDirs: raw.skillDirs ?? {},
      disabledSkills: raw.disabledSkills ?? [], plugins: raw.plugins ?? [] };
  } catch { return empty(); }
}
export function saveStore(store: Store) {
  mkdirSync(dirname(STORE_FILE()), { recursive: true });
  writeFileSync(STORE_FILE(), JSON.stringify(store, null, 2));
}

// ---------- kleine Hilfen ----------
const readText = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const dirs = (p: string) => { try { return readdirSync(p).filter(n => !n.startsWith(".") && isDir(join(p, n))); } catch { return []; } };
const files = (p: string, ext: string) => { try { return readdirSync(p).filter(n => n.endsWith(ext) && !n.startsWith(".")); } catch { return []; } };
/** JSON mit Kommentaren (opencode.jsonc) */
function parseJsonc(text: string): any {
  try { return JSON.parse(text); } catch {}
  try {
    const cleaned = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "").replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(cleaned);
  } catch { return {}; }
}
/** Frontmatter (--- description: … ---) und Rumpf einer Markdown-Datei */
export function parseMarkdown(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) { const kv = /^([\w-]+):\s*(.*)$/.exec(line); if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, ""); }
  return { meta, body: m[2].trim() };
}
const safeName = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "eintrag";

// ---------- MCP-Formate umrechnen ----------
/** Claude/Codex (stdio: command + args + env; http/sse: url + headers) -> OpenCode ("local"/"remote") */
function toOpenCodeMcp(raw: any, source: Source): McpEntry | undefined {
  if (!raw || typeof raw !== "object") return;
  const url = raw.url ?? raw.httpUrl;
  if (typeof url === "string" && url) {
    const headers: Record<string, string> = { ...(raw.headers ?? raw.http_headers ?? {}) };
    return { type: "remote", url, headers: Object.keys(headers).length ? headers : undefined, enabled: raw.enabled !== false && raw.disabled !== true, source };
  }
  const cmd = raw.command;
  if (Array.isArray(cmd) && cmd.length) return { type: "local", command: cmd.map(String), environment: raw.environment ?? raw.env, enabled: raw.enabled !== false, source };
  if (typeof cmd === "string" && cmd) {
    return { type: "local", command: [cmd, ...(Array.isArray(raw.args) ? raw.args.map(String) : [])],
      environment: raw.environment ?? raw.env ?? undefined, enabled: raw.enabled !== false && raw.disabled !== true, source };
  }
  return;
}
export function mcpSummary(e: McpEntry): string {
  return e.type === "remote" ? String(e.url) : (e.command ?? []).join(" ").slice(0, 140);
}

// ---------- Suche nach Importierbarem ----------
function skillsIn(dir: string, from: Source, out: Candidate[], store: Store, label = "Skill") {
  for (const name of dirs(dir)) {
    const skill = join(dir, name, "SKILL.md");
    if (!existsSync(skill)) continue;
    const { meta } = parseMarkdown(readText(skill));
    const skillName = meta.name || name;
    out.push({ id: `${from}:skill:${skillName}`, kind: "skill", name: skillName, from, detail: (meta.description || label).slice(0, 140),
      status: store.skillDirs[skillName] ? "vorhanden" : "neu", data: { path: join(dir, name) } });
  }
}
function commandsIn(dir: string, from: Source, out: Candidate[], store: Store, prefix = "") {
  for (const file of files(dir, ".md")) {
    const { meta, body } = parseMarkdown(readText(join(dir, file)));
    const name = safeName(prefix + basename(file, ".md"));
    out.push({ id: `${from}:command:${name}`, kind: "command", name, from, detail: (meta.description || body.split("\n")[0] || "Befehl").slice(0, 140),
      status: store.commands[name] ? "vorhanden" : "neu", data: { description: meta.description || "", template: body } });
  }
}
function mcpIn(servers: Record<string, any> | undefined, from: Source, out: Candidate[], store: Store) {
  for (const [name, raw] of Object.entries(servers ?? {})) {
    const entry = toOpenCodeMcp(raw, from);
    if (!entry) continue;
    out.push({ id: `${from}:mcp:${name}`, kind: "mcp", name: safeName(name), from, detail: mcpSummary(entry),
      status: store.mcp[safeName(name)] ? "vorhanden" : "neu", data: entry });
  }
}

export function scanImport(from: Source, store = loadStore()): Candidate[] {
  const out: Candidate[] = [];
  if (from === "claude") {
    const config = (() => { try { return JSON.parse(readText(join(HOME, ".claude.json"))); } catch { return {}; } })();
    mcpIn(config.mcpServers, "claude", out, store);
    skillsIn(join(HOME, ".claude", "skills"), "claude", out, store);
    commandsIn(join(HOME, ".claude", "commands"), "claude", out, store);
    // Plugins (Bündel aus Skills, Befehlen und MCP-Servern)
    try {
      const installed = JSON.parse(readText(join(HOME, ".claude", "plugins", "installed_plugins.json")));
      for (const [id, versions] of Object.entries<any>(installed.plugins ?? {})) {
        const path = versions?.[0]?.installPath;
        if (!path || !isDir(path)) continue;
        const plugin = id.split("@")[0];
        skillsIn(join(path, "skills"), "claude", out, store, `Plugin ${plugin}`);
        commandsIn(join(path, "commands"), "claude", out, store, `${plugin}-`);
        const mcp = parseJsonc(readText(join(path, ".mcp.json")));
        mcpIn(mcp.mcpServers ?? mcp, "claude", out, store);
      }
    } catch { /* keine Plugins */ }
  } else if (from === "codex") {
    try {
      const toml: any = (Bun as any).TOML.parse(readText(join(HOME, ".codex", "config.toml")));
      mcpIn(toml.mcp_servers, "codex", out, store);
    } catch { /* keine config.toml */ }
    skillsIn(join(HOME, ".codex", "skills"), "codex", out, store);
    commandsIn(join(HOME, ".codex", "prompts"), "codex", out, store);
  } else if (from === "opencode") {
    const dir = join(HOME, ".config", "opencode");
    const config = parseJsonc(readText(join(dir, existsSync(join(dir, "opencode.json")) ? "opencode.json" : "opencode.jsonc")));
    mcpIn(config.mcp, "opencode", out, store);
    for (const [name, c] of Object.entries<any>(config.command ?? {})) {
      const n = safeName(name);
      out.push({ id: `opencode:command:${n}`, kind: "command", name: n, from: "opencode", detail: String(c.description ?? "Befehl").slice(0, 140),
        status: store.commands[n] ? "vorhanden" : "neu", data: { description: c.description ?? "", template: String(c.template ?? "") } });
    }
    for (const sub of ["command", "commands"]) commandsIn(join(dir, sub), "opencode", out, store);
    skillsIn(join(dir, "skills"), "opencode", out, store);
    skillsIn(join(dir, "skill"), "opencode", out, store);
    for (const plugin of Array.isArray(config.plugin) ? config.plugin : [])
      out.push({ id: `opencode:plugin:${plugin}`, kind: "plugin", name: String(plugin), from: "opencode", detail: "OpenCode-Plugin",
        status: store.plugins.includes(String(plugin)) ? "vorhanden" : "neu", data: { name: String(plugin) } });
    for (const file of files(join(dir, "plugin"), ".js").concat(files(join(dir, "plugins"), ".js"), files(join(dir, "plugin"), ".ts")))
      out.push({ id: `opencode:plugin:${file}`, kind: "plugin", name: file, from: "opencode", detail: "lokale Plugin-Datei",
        status: "neu", data: { file: join(dir, existsSync(join(dir, "plugin", file)) ? "plugin" : "plugins", file) } });
  }
  // doppelte IDs (gleicher Skill in zwei Plugins) entfernen
  const seen = new Set<string>();
  return out.filter(c => !seen.has(c.id) && seen.add(c.id));
}

/** Ausgewählte Kandidaten in den Speicher übernehmen. Gibt die Anzahl je Art zurück. */
export function applyImport(candidates: Candidate[], store = loadStore()): Record<string, number> {
  const counts: Record<string, number> = { mcp: 0, skill: 0, command: 0, plugin: 0 };
  for (const c of candidates) {
    if (c.kind === "mcp") store.mcp[c.name] = c.data as McpEntry;
    else if (c.kind === "skill") store.skillDirs[c.name] = { path: c.data.path, source: c.from };
    else if (c.kind === "command") store.commands[c.name] = { description: c.data.description, template: c.data.template, source: c.from };
    else if (c.kind === "plugin") { const v = c.data.file ?? c.data.name; if (!store.plugins.includes(v)) store.plugins.push(v); }
    else continue;
    counts[c.kind]++;
  }
  saveStore(store);
  return counts;
}

// ---------- in den OpenCode-Arbeitsordner schreiben ----------
export function writeWorkspace(workspace: string, base: Record<string, any>, store = loadStore()) {
  const config: Record<string, any> = { ...base };
  config.mcp = { ...(base.mcp ?? {}) };
  for (const [name, e] of Object.entries(store.mcp)) {
    if (config.mcp[name]) continue; // das eingebaute "jarvis" nicht überschreiben
    config.mcp[name] = e.type === "remote"
      ? { type: "remote", url: e.url, ...(e.headers ? { headers: e.headers } : {}), enabled: e.enabled }
      : { type: "local", command: e.command, ...(e.environment ? { environment: e.environment } : {}), enabled: e.enabled };
  }
  for (const [name, enabled] of Object.entries(store.mcpOverrides ?? {})) {
    if (Object.hasOwn(store.mcp, name) && !Object.hasOwn(base.mcp ?? {}, name)) continue;
    config.mcp[name] = { ...(Object.hasOwn(config.mcp, name) ? config.mcp[name] : {}), enabled };
  }
  config.plugin = store.plugins;
  if (store.disabledSkills.length)
    config.permission = { ...(base.permission ?? {}), skill: Object.fromEntries(store.disabledSkills.map(n => [n, "deny"])) };
  writeFileSync(join(workspace, "opencode.json"), JSON.stringify(config, null, 2));

  // eigene Befehle als Markdown-Dateien
  const commandDir = join(workspace, ".opencode", "command");
  mkdirSync(commandDir, { recursive: true });
  for (const f of files(commandDir, ".md")) if (readText(join(commandDir, f)).includes("<!-- jarvis-extension -->")) rmSync(join(commandDir, f), { force: true });
  for (const [name, c] of Object.entries(store.commands))
    writeFileSync(join(commandDir, `${name}.md`), `---\ndescription: ${(c.description || name).replace(/\n/g, " ")}\n---\n<!-- jarvis-extension -->\n${c.template}\n`);

  // importierte Skills als Verknüpfungen
  const skillRoot = join(workspace, ".opencode", "skills");
  mkdirSync(skillRoot, { recursive: true });
  for (const name of readdirSync(skillRoot)) {
    const p = join(skillRoot, name);
    try { if (lstatSync(p).isSymbolicLink()) unlinkSync(p); } catch {}
  }
  for (const [name, s] of Object.entries(store.skillDirs)) {
    if (!isDir(s.path)) continue;
    try { symlinkSync(s.path, join(skillRoot, safeName(name))); } catch { /* existiert schon */ }
  }
}

// ---------- Befehle ----------
/** Vorlage mit $ARGUMENTS, $1, $2 … füllen (wie bei OpenCode und Claude) */
export function expandTemplate(template: string, args: string): string {
  const parts = args.trim() ? args.trim().split(/\s+/) : [];
  let out = template.replace(/\$ARGUMENTS/g, args.trim()).replace(/\$(\d)/g, (_, n) => parts[Number(n) - 1] ?? "");
  if (args.trim() && !/\$ARGUMENTS|\$\d/.test(template)) out += `\n\nAufgabe des Nutzers: ${args.trim()}`;
  return out;
}
