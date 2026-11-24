// Jarvis-Werkzeuge für Hermes: erzeugt die Hermes-Konfiguration, mit der Hermes den Jarvis-MCP-Server (mcp.ts) als Client nutzt.
// Quellen: Hermes-Doku „MCP Config Reference“ und „MCP (Model Context Protocol)“ (website/docs im Repository NousResearch/hermes-agent).
// Getrennt von hermes.ts (Runs-Adapter des Backend-Wechsels): diese Datei kennt weder Läufe noch Schlüssel.
//
// Aufbau: Hermes ist ein MCP-Client. `mcp_servers.jarvis` startet `bun core/src/mcp.ts` (stdio); die Werkzeuge heißen in Hermes
// `mcp__jarvis__<werkzeug>` (z. B. mcp__jarvis__browser_scan). Jede Aktion geht über jarvisd (POST /tool) und damit durch dieselben
// Regeln wie bei OpenCode: Computer-Steuerung an/aus, Not-Aus, gesperrte Passwortfelder, Vorschau, Fehler-Log.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const SERVER = "jarvis";
export const MARKER = "# jarvis-managed: von core/src/hermes-tools.ts erzeugt";
/** Hermes' eigene Bedienung wird abgeschaltet: sie umginge Jarvis' Regeln (Passwortsperre, Computer-Steuerung an/aus, Not-Aus, Vorschau). `browser` enthält browser_vault. */
export const DISABLED_TOOLSETS = ["browser", "computer_use"] as const;

export interface HermesToolsOptions {
  /** Pfad zu bun (Standard: das laufende bun) */
  bun?: string;
  /** Pfad zu core/src/mcp.ts */
  mcpPath?: string;
  /** Adresse von jarvisd */
  daemonUrl?: string;
  /** Ein vom Client abgebrochener Aufruf löst den gemeinsamen Not-Aus aus (POST /stop) */
  stopOnCancel?: boolean;
  timeoutSec?: number;
}

const q = (s: string) => JSON.stringify(s);   // JSON-Strings sind gültiges YAML

function resolve(o: HermesToolsOptions) {
  return { bun: o.bun ?? process.execPath, mcpPath: o.mcpPath ?? join(import.meta.dir, "mcp.ts"), daemonUrl: (o.daemonUrl ?? "http://127.0.0.1:7777").replace(/\/+$/, ""),
    stopOnCancel: o.stopOnCancel === true, timeoutSec: o.timeoutSec ?? 120 };
}

/** Eintrag `mcp_servers.jarvis` als Objekt (für Tests und `hermes mcp add`) */
export function mcpEntry(o: HermesToolsOptions = {}) {
  const r = resolve(o);
  return {
    command: r.bun, args: [r.mcpPath],
    env: {
      JARVISD_URL: r.daemonUrl,
      // Hermes sperrt einen MCP-Server nach 3 Fehlerergebnissen in Folge für 60 s (Circuit Breaker). Absagen sind bei Jarvis normal
      // (Computer-Steuerung aus, Not-Aus, Passwortfeld, veraltete ID), darum kommen sie als normaler Text an.
      JARVIS_MCP_ERRORS: "text",
      ...(r.stopOnCancel ? { JARVIS_STOP_ON_CANCEL: "1" } : {}),
    },
    timeout: r.timeoutSec, connect_timeout: 60,
    supports_parallel_tool_calls: false,    // Bildschirm- und Seitenaktionen nacheinander, nie gleichzeitig
    trust: "full",                           // Jarvis' Werkzeuge halten ihre Regeln selbst ein; Rückfrage bei jedem Klick wäre unbrauchbar
  };
}

/** Vollständige config.yaml für ein von Jarvis verwaltetes Hermes-Verzeichnis (HERMES_HOME). */
export function managedConfig(o: HermesToolsOptions = {}): string {
  const e = mcpEntry(o);
  const env = Object.entries(e.env).map(([k, v]) => `      ${k}: ${q(v)}`).join("\n");
  return `${MARKER}
mcp_servers:
  ${SERVER}:
    command: ${q(e.command)}
    args: [${e.args.map(q).join(", ")}]
    env:
${env}
    timeout: ${e.timeout}
    connect_timeout: ${e.connect_timeout}
    supports_parallel_tool_calls: false
    trust: full
agent:
  disabled_toolsets:
${DISABLED_TOOLSETS.map(t => `    - ${t}`).join("\n")}
`;
}

/** Argumente für `hermes mcp add` (bestehende Hermes-Installation, statt eines eigenen Verzeichnisses) */
export function addArgs(o: HermesToolsOptions = {}): string[] {
  const e = mcpEntry(o);
  return ["mcp", "add", SERVER, "--command", e.command, "--env", ...Object.entries(e.env).map(([k, v]) => `${k}=${v}`), "--args", ...e.args];
}

/** Name, unter dem Hermes ein Jarvis-Werkzeug registriert (Zeichen außer Buchstaben, Ziffern und _ werden zu _) */
export const hermesToolName = (tool: string) => `mcp__${SERVER}__${tool.replace(/[^A-Za-z0-9_]/g, "_")}`;
/** Umkehrung für die Anzeige: mcp__jarvis__browser_scan, mcp_jarvis_browser_scan und jarvis_browser_scan (OpenCode) werden zu browser_scan */
export const baseToolName = (name: string) => name.replace(/^(mcp__?jarvis__?|jarvis_)/, "");

/** Standardverzeichnis für das von Jarvis verwaltete Hermes (nicht das ~/.hermes des Nutzers) */
export const defaultHome = () => process.env.JARVIS_HERMES_HOME ?? join(homedir(), ".jarvis3", "hermes");

export type SetupResult = { ok: true; path: string; created: boolean } | { ok: false; error: string };
/** Schreibt die Konfiguration. Eine fremde config.yaml (ohne Jarvis-Markierung) wird nicht überschrieben, außer mit force. Schlüssel schreibt diese Funktion nie. */
export function setupHome(home: string, o: HermesToolsOptions = {}, { force = false } = {}): SetupResult {
  const path = join(home, "config.yaml");
  const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (existing !== undefined && !existing.includes(MARKER) && !force)
    return { ok: false, error: `${path} gehört nicht zu Jarvis und wird nicht überschrieben (mit --force ersetzen oder \`hermes mcp add\` benutzen).` };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, managedConfig(o));
  return { ok: true, path, created: existing === undefined };
}

/** Prüft mit Hermes' eigenem MCP-Client, ob der Jarvis-Server erreichbar ist und wie viele Werkzeuge er liefert. */
export function verify(home: string, hermes = "hermes"): { ok: boolean; tools: number; output: string } {
  const run = Bun.spawnSync([hermes, "mcp", "test", SERVER], { env: { ...process.env, HERMES_HOME: home }, stdout: "pipe", stderr: "pipe", timeout: 120_000 });
  const output = run.stdout.toString() + run.stderr.toString();
  const tools = Number(/Tools discovered:\s*(\d+)/.exec(output)?.[1] ?? 0);
  return { ok: run.exitCode === 0 && /Connected/.test(output) && tools > 0, tools, output };
}
