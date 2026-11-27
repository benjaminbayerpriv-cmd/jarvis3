// „Installierte Skills und Plugins übernehmen“: was Claude Code und Codex von sich aus mitbringen, und was Jarvis dabei bewusst NICHT übernimmt.
// Gelesen werden nur Namen und Anzahl, keine Inhalte; Anmeldedateien werden nie angefasst.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliKind } from "./cli-agents";

const names = (dir: string) => { try { return readdirSync(dir).filter(n => !n.startsWith(".") && statSync(join(dir, n)).isDirectory()); } catch { return []; } };

/** Namen der vom Nutzer in Codex eingerichteten MCP-Server (config.toml). Sie werden bei der Übernahme abgeschaltet: eigene Werkzeuge
 *  wie Computer-Steuerung würden Jarvis' Sperren und den Not-Aus umgehen. Nur die Namen werden gelesen. */
export function codexUserMcpNames(home = homedir()): string[] {
  try {
    const file = join(home, ".codex", "config.toml");
    if (!existsSync(file)) return [];
    const servers = (Bun.TOML.parse(readFileSync(file, "utf8")) as any)?.mcp_servers;
    return servers && typeof servers === "object" ? Object.keys(servers).filter(n => /^[\w-]{1,60}$/.test(n) && n !== "jarvis") : [];
  } catch { return []; }
}

/** Wie viele Skills und Plugins das Programm auf diesem Rechner hat (nur Anzahl, damit die Oberfläche zeigen kann, was übernommen würde). */
export function scanInstalled(kind: CliKind, home = homedir()): { skills: number; plugins: number } {
  try {
    if (kind === "claude") {
      const skills = names(join(home, ".claude", "skills")).length;
      let plugins = 0;
      try { const d = JSON.parse(readFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8")); plugins = Object.keys(d?.plugins ?? d ?? {}).length; } catch { /* keine Plugins */ }
      return { skills, plugins };
    }
    const skills = names(join(home, ".codex", "skills")).length + names(join(home, ".agents", "skills")).length;
    const cache = join(home, ".codex", "plugins", "cache");
    const plugins = names(cache).reduce((n, market) => n + names(join(cache, market)).length, 0);
    return { skills, plugins };
  } catch { return { skills: 0, plugins: 0 }; }
}
