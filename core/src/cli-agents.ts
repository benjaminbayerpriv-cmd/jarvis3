// Claude Code und Codex als Backends: Jarvis startet die schon installierten Programme (`claude`, `codex`) je Nachricht im Hintergrund
// (keine Downloads) und übersetzt deren JSON-Ausgabe in die bekannten Jarvis-Ereignisse (BrainEvent).
//
// Anmeldung: beide Programme melden sich selbst an (Abo bzw. ChatGPT-Konto). Jarvis liest, speichert und sendet dafür KEINE Schlüssel und
// Passwörter, öffnet keine Anmeldedateien und fragt nur den Status ab (`claude auth status`, `codex login status`).
// Werkzeuge: Der Jarvis-MCP-Server (mcp.ts) ist angebunden, damit gelten dieselben Regeln wie bei OpenCode und Hermes (Computer-Steuerung an/aus,
// Not-Aus, gesperrte Passwortfelder, Vorschau). Eingebaute Werkzeuge sind abgeschaltet, nur „Dateien lesen“ lässt sich zuschalten; schreiben
// und Befehle ausführen gibt es nicht.
import { join } from "node:path";
import type { BrainEvent } from "./opencode";
import { baseToolName } from "./hermes-tools";
import { codexUserMcpNames } from "./cli-adopt";

export type CliKind = "claude" | "codex";
export const CLI_KINDS: readonly CliKind[] = ["claude", "codex"];
export const CLI_LABEL: Record<CliKind, string> = { claude: "Claude Code", codex: "Codex" };
export const isCliKind = (v: unknown): v is CliKind => v === "claude" || v === "codex";

/** Einstellungen je Programm. `model` leer = Vorgabe des Programms. `files`: ob es Dateien lesen darf. */
export const EFFORTS = ["", "low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type CliConfig = { model: string; files: "none" | "read"; effort: string; adopt: boolean };
export const defaultCliConfig = (): CliConfig => ({ model: "", files: "none", effort: "", adopt: false });
export function parseCliConfig(input: unknown): CliConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Ungültige Einstellungen");
  const v = input as Record<string, unknown>;
  const model = v.model === undefined ? "" : v.model;
  if (typeof model !== "string" || model.length > 100 || (model && !/^[\w][\w.:/\-\[\]]*$/.test(model))) throw new Error("Modellname ungültig");
  if (v.files !== undefined && v.files !== "none" && v.files !== "read") throw new Error("Dateizugriff ungültig");
  if (v.effort !== undefined && !(EFFORTS as readonly unknown[]).includes(v.effort)) throw new Error("Denkaufwand ungültig");
  if (v.adopt !== undefined && typeof v.adopt !== "boolean") throw new Error("Übernahme ungültig");
  return { model, files: v.files === "read" ? "read" : "none", effort: typeof v.effort === "string" ? v.effort : "", adopt: v.adopt === true };
}

export const cliModelId = (kind: CliKind, config: CliConfig) => `${kind}/${config.model || "default"}`;

// ---------- Aufruf ----------
export interface CliEnv {
  /** Programme (Standard: `claude`, `codex` aus dem Suchpfad) */
  bin?: Partial<Record<CliKind, string>>;
  bun?: string;
  mcpPath?: string;
  daemonUrl: string;
  workspace: string;
  /** Namen der Codex-MCP-Server des Nutzers (bei der Übernahme abgeschaltet). Standard: aus ~/.codex/config.toml */
  userMcp?: () => string[];
}
export interface CliRun { kind: CliKind; config: CliConfig; input: string; instructions: string; native: string; resume: boolean; images?: string[] }

const jarvisMcp = (env: CliEnv) => ({ command: env.bun ?? process.execPath, args: [env.mcpPath ?? join(import.meta.dir, "mcp.ts")], env: { JARVISD_URL: env.daemonUrl } });
const toml = (v: unknown) => JSON.stringify(v);   // JSON-Zeichenketten und -Listen sind gültiges TOML

export function claudeArgs(run: CliRun, env: CliEnv): string[] {
  const read = run.config.files === "read";
  const args = ["-p", run.input, "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    // Nur Jarvis' Werkzeuge (und auf Wunsch Lesen); Einstellungen, Hooks und Plugins des Nutzers werden nicht geladen
    "--tools", [...(read ? ["Read", "Glob", "Grep"] : []), ...(run.config.adopt ? ["Skill"] : [])].join(","),
    "--allowedTools", ["mcp__jarvis__*", ...(read ? ["Read", "Glob", "Grep"] : []), ...(run.config.adopt ? ["Skill"] : [])].join(","),
    // --strict-mcp-config: MCP-Server von Plugins und Nutzer bleiben aus (sie würden Jarvis' Sperren und den Not-Aus umgehen)
    "--mcp-config", JSON.stringify({ mcpServers: { jarvis: jarvisMcp(env) } }), "--strict-mcp-config",
    // Übernahme: Skills und Plugins aus den Nutzereinstellungen, aber ohne deren Hooks (eigene Befehle des Nutzers laufen nicht mit)
    ...(run.config.adopt ? ["--setting-sources", "user", "--settings", JSON.stringify({ disableAllHooks: true })] : ["--setting-sources", ""]),
    "--permission-mode", "default", "--append-system-prompt", run.instructions];
  if (run.config.model) args.push("--model", run.config.model);
  if (run.config.effort && run.config.effort !== "ultra") args.push("--effort", run.config.effort);   // „ultra“ kennt nur Codex
  args.push(...(run.resume ? ["--resume", run.native] : ["--session-id", run.native]));
  return args;
}

export function codexArgs(run: CliRun, env: CliEnv): string[] {
  const mcp = jarvisMcp(env);
  const config = ["-c", `mcp_servers.jarvis.command=${toml(mcp.command)}`, "-c", `mcp_servers.jarvis.args=${toml(mcp.args)}`,
    "-c", `mcp_servers.jarvis.env={JARVISD_URL=${toml(mcp.env.JARVISD_URL)}}`, "-c", `sandbox_mode="read-only"`];
  // Übernahme: config.toml (Plugins, Skills) wird geladen, aber Hooks bleiben aus, Freigaben werden nie erfragt und jeder MCP-Server des Nutzers ist abgeschaltet
  const adopt = run.config.adopt ? ["--disable", "hooks", "-c", `approval_policy="never"`, ...(env.userMcp ?? codexUserMcpNames)().flatMap(n => ["-c", `mcp_servers.${n}.enabled=false`])] : ["--ignore-user-config"];
  const base = ["--json", "--skip-git-repo-check", ...adopt, ...(run.config.files === "read" || run.config.adopt ? [] : ["--disable", "shell_tool"]),   // Codex-Skills liest Codex über die (nur lesende) Shell
    
    ...(run.config.model ? ["-m", run.config.model] : []), ...(run.config.effort ? ["-c", `model_reasoning_effort=${toml(run.config.effort)}`] : []), ...(run.images ?? []).flatMap(path => ["-i", path]), ...config];
  // Codex kennt keine getrennte System-Anweisung: die Jarvis-Anweisungen stehen vor der ersten Nachricht der Unterhaltung.
  const text = run.resume ? run.input : `${run.instructions}\n\n---\n\n${run.input}`;
  return run.resume ? ["exec", "resume", ...base, run.native, text] : ["exec", ...base, text];
}

export const cliArgs = (run: CliRun, env: CliEnv) => run.kind === "claude" ? claudeArgs(run, env) : codexArgs(run, env);

// ---------- Ausgabe lesen ----------
/** Übersetzt die JSON-Zeilen eines Laufs in Jarvis-Ereignisse. Eine Instanz pro Lauf. */
export interface CliParser { feed(line: string): BrainEvent[]; end(exitCode: number | null, aborted: boolean): BrainEvent[]; readonly native?: string; readonly finished: boolean }

const truncate = (v: unknown, n = 300) => String(v ?? "").slice(0, n);
const toolTitle = (input: unknown) => {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const v = o.file_path ?? o.path ?? o.pattern ?? o.command ?? o.url ?? o.query;
  return typeof v === "string" ? truncate(v, 120) : undefined;
};

export class ClaudeParser implements CliParser {
  native?: string;
  finished = false;
  private streamed = new Set<string>();      // Nachrichten, deren Text schon als Deltas kam
  private tools = new Map<string, string>(); // tool_use-ID -> Name
  feed(line: string): BrainEvent[] {
    let o: any; try { o = JSON.parse(line); } catch { return []; }
    if (typeof o.session_id === "string" && !this.native) this.native = o.session_id;
    const out: BrainEvent[] = [];
    if (o.type === "stream_event" && !o.parent_tool_use_id) {
      const e = o.event, mid = String(o.api_message_id ?? "");
      if (e?.type === "content_block_delta") {
        if (e.delta?.type === "text_delta" && e.delta.text) { this.streamed.add(mid); out.push({ kind: "text", delta: e.delta.text }); }
        else if (e.delta?.type === "thinking_delta" && e.delta.thinking) out.push({ kind: "reasoning", delta: e.delta.thinking });
      }
    } else if (o.type === "assistant" && !o.parent_tool_use_id) {
      const mid = String(o.message?.id ?? "");
      for (const b of o.message?.content ?? []) {
        if (b.type === "tool_use") { this.tools.set(b.id, b.name); out.push({ kind: "tool", id: String(b.id), name: baseToolName(String(b.name)), status: "running", title: toolTitle(b.input), input: b.input }); }
        else if (b.type === "text" && b.text && !this.streamed.has(mid)) out.push({ kind: "text", delta: b.text });
      }
    } else if (o.type === "user" && !o.parent_tool_use_id) {
      for (const b of Array.isArray(o.message?.content) ? o.message.content : []) {
        if (b.type !== "tool_result") continue;
        const name = baseToolName(this.tools.get(b.tool_use_id) ?? "Werkzeug");
        out.push({ kind: "tool", id: String(b.tool_use_id), name, status: b.is_error ? "error" : "completed", ...(b.is_error ? { error: "Werkzeug fehlgeschlagen" } : {}) });
      }
    } else if (o.type === "result") {
      this.finished = true;
      if (o.is_error || (o.subtype && o.subtype !== "success")) out.push({ kind: "error", message: `Claude Code: ${truncate(o.result) || `Lauf fehlgeschlagen (${truncate(o.subtype, 60) || "unbekannt"})`}` });
      else out.push({ kind: "done" });
    }
    return out;
  }
  end(exitCode: number | null, aborted: boolean): BrainEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return aborted ? [{ kind: "done", aborted: true }] : [{ kind: "error", message: `Claude Code wurde ohne Ergebnis beendet${exitCode ? ` (Code ${exitCode})` : ""}.` }];
  }
}

export class CodexParser implements CliParser {
  native?: string;
  finished = false;
  private lastError = "";
  private wrote = false;
  feed(line: string): BrainEvent[] {
    let o: any; try { o = JSON.parse(line); } catch { return []; }
    const out: BrainEvent[] = [];
    if (o.type === "thread.started" && typeof o.thread_id === "string") this.native = o.thread_id;
    else if (o.type === "item.started" || o.type === "item.completed") {
      const item = o.item ?? {}, done = o.type === "item.completed", id = String(item.id ?? crypto.randomUUID());
      if (item.type === "agent_message" && done && item.text) { out.push({ kind: "text", delta: (this.wrote ? "\n\n" : "") + item.text }); this.wrote = true; }
      else if (item.type === "reasoning" && done && item.text) out.push({ kind: "reasoning", delta: String(item.text) });
      else if (item.type === "mcp_tool_call") {
        const failed = done && (item.status === "failed" || !!item.error);
        out.push({ kind: "tool", id, name: baseToolName(String(item.tool ?? "Werkzeug")), status: !done ? "running" : failed ? "error" : "completed", ...(failed ? { error: "Werkzeug fehlgeschlagen" } : {}), ...(!done ? { input: item.arguments } : {}) });
      } else if (item.type === "command_execution") {
        const failed = done && item.status === "failed";
        out.push({ kind: "tool", id, name: "Befehl", status: !done ? "running" : failed ? "error" : "completed", title: truncate(item.command, 120), ...(failed ? { error: "Befehl fehlgeschlagen" } : {}) });
      } else if (item.type === "web_search" || item.type === "file_change") {
        out.push({ kind: "tool", id, name: item.type === "web_search" ? "Websuche" : "Dateiänderung", status: done ? "completed" : "running", title: truncate(item.query ?? "", 120) || undefined });
      } else if (item.type === "error" && item.message) this.lastError = truncate(item.message);
    } else if (o.type === "error" && o.message) this.lastError = truncate(o.message);
    else if (o.type === "turn.failed") { this.finished = true; out.push({ kind: "error", message: `Codex: ${truncate(o.error?.message ?? this.lastError) || "Lauf fehlgeschlagen"}` }); }
    else if (o.type === "turn.completed") { this.finished = true; out.push({ kind: "done" }); }
    return out;
  }
  end(exitCode: number | null, aborted: boolean): BrainEvent[] {
    if (this.finished) return [];
    this.finished = true;
    return aborted ? [{ kind: "done", aborted: true }] : [{ kind: "error", message: `Codex wurde ohne Ergebnis beendet${exitCode ? ` (Code ${exitCode})` : ""}${this.lastError ? `: ${this.lastError}` : "."}` }];
  }
}
export const newParser = (kind: CliKind): CliParser => kind === "claude" ? new ClaudeParser() : new CodexParser();

// ---------- Ausführung ----------
type Active = { proc: ReturnType<typeof Bun.spawn>; aborted: boolean; finished: Promise<void> };

/** Beendet einen Prozess samt aller Unterprozesse (Werkzeug-Server, Shells), damit nichts Ausgabe oder Bildschirm weiter belegt. */
export function killTree(pid: number, signal: NodeJS.Signals = "SIGTERM") {
  try {
    const kids = Bun.spawnSync(["pgrep", "-P", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString().split("\n").map(Number).filter(n => n > 0);
    for (const kid of kids) killTree(kid, signal);
  } catch { /* pgrep fehlt: nur der Hauptprozess */ }
  try { process.kill(pid, signal); } catch { /* schon beendet */ }
}

export class CliAgent {
  private active = new Map<string, Active>();
  constructor(readonly env: CliEnv, private killWaitMs = 4000) {}
  private bin(kind: CliKind) { return this.env.bin?.[kind] ?? kind; }
  isRunning(session: string) { return this.active.has(session); }

  /** Anmeldung und Installation prüfen (nur Statusabfrage der Programme, keine Schlüssel). */
  async status(kind: CliKind): Promise<{ installed: boolean; loggedIn: boolean; detail: string }> {
    const cmd = kind === "claude" ? [this.bin(kind), "auth", "status"] : [this.bin(kind), "login", "status"];
    try {
      const p = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
      const timer = setTimeout(() => p.kill(), 15_000);
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited; clearTimeout(timer);
      const text = `${out}\n${err}`;
      if (kind === "claude") {
        let loggedIn = false; try { loggedIn = JSON.parse(out).loggedIn === true; } catch { loggedIn = /logged in/i.test(text) && !/not logged/i.test(text); }
        return { installed: true, loggedIn, detail: loggedIn ? "angemeldet" : "Nicht angemeldet: im Terminal `claude` starten und anmelden." };
      }
      const loggedIn = p.exitCode === 0 && /logged in/i.test(text);
      return { installed: true, loggedIn, detail: loggedIn ? "angemeldet" : "Nicht angemeldet: im Terminal `codex login` ausführen." };
    } catch {
      return { installed: false, loggedIn: false, detail: `${CLI_LABEL[kind]} ist nicht installiert oder nicht im Suchpfad.` };
    }
  }

  /** Stoppt den Lauf (SIGTERM, nach kurzer Frist SIGKILL) und wartet auf das Ende. */
  async abort(session: string) {
    const run = this.active.get(session);
    if (!run) return;
    run.aborted = true;
    killTree(run.proc.pid, "SIGTERM");
    const timer = setTimeout(() => killTree(run.proc.pid, "SIGKILL"), this.killWaitMs);
    try { await run.finished; } finally { clearTimeout(timer); }
  }

  /** Ein Lauf. Liefert die native Sitzungs-ID (bei Codex erst nach dem ersten Lauf bekannt). */
  async prompt(session: string, run: CliRun, onEvent: (event: BrainEvent) => void): Promise<{ native?: string }> {
    if (this.active.has(session)) throw new Error(`Für diese ${CLI_LABEL[run.kind]}-Sitzung läuft bereits eine Anfrage`);
    const parser = newParser(run.kind);
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn([this.bin(run.kind), ...cliArgs(run, this.env)], { cwd: this.env.workspace, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: process.env });
    } catch {
      onEvent({ kind: "error", message: `${CLI_LABEL[run.kind]} konnte nicht gestartet werden (installiert?).` });
      return {};
    }
    const entry: Active = { proc, aborted: false, finished };
    this.active.set(session, entry);
    let sent = false;
    const send = (events: BrainEvent[]) => { for (const e of events) { if (sent) return; if (e.kind === "done" || e.kind === "error") sent = true; onEvent(e); } };
    try {
      void new Response(proc.stderr).text().catch(() => "");   // leeren, Inhalt wird nicht weitergegeben (kann Pfade und Kennungen enthalten)
      const reader = (proc.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      // Ein Unterprozess kann die Ausgabe offen halten, obwohl das Programm schon beendet ist: kurz nach dem Ende nicht mehr warten
      void proc.exited.then(() => setTimeout(() => void reader.cancel().catch(() => {}), 300));
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += chunk.value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1); if (line) send(parser.feed(line)); }
      }
      if (buffer.trim()) send(parser.feed(buffer.trim()));
      await proc.exited;
      if (entry.aborted) killTree(proc.pid, "SIGKILL");
      send(parser.end(proc.exitCode, entry.aborted));
    } catch {
      send([{ kind: "error", message: `${CLI_LABEL[run.kind]}: Ausgabe konnte nicht gelesen werden.` }]);
    } finally {
      this.active.delete(session); finish();
    }
    return { native: parser.native };
  }
}
