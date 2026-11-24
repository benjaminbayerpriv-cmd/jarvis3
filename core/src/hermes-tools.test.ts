import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DISABLED_TOOLSETS, MARKER, addArgs, baseToolName, hermesToolName, managedConfig, mcpEntry, setupHome, verify } from "./hermes-tools";

const opts = { bun: "/usr/local/bin/bun", mcpPath: "/x/core/src/mcp.ts", daemonUrl: "http://127.0.0.1:7777/" };

describe("Konfiguration", () => {
  test("YAML entspricht dem Eintrag und schaltet Hermes' eigene Bedienung ab", () => {
    const cfg: any = Bun.YAML.parse(managedConfig(opts));
    expect(cfg.mcp_servers.jarvis.command).toBe(opts.bun);
    expect(cfg.mcp_servers.jarvis.args).toEqual([opts.mcpPath]);
    expect(cfg.mcp_servers.jarvis.env).toEqual({ JARVISD_URL: "http://127.0.0.1:7777", JARVIS_MCP_ERRORS: "text" });
    expect(cfg.mcp_servers.jarvis.supports_parallel_tool_calls).toBe(false);
    expect(cfg.agent.disabled_toolsets).toEqual([...DISABLED_TOOLSETS]);
    expect(DISABLED_TOOLSETS).toContain("browser");
    expect(DISABLED_TOOLSETS).toContain("computer_use");
  });
  test("Not-Aus bei Abbruch ist nur auf Wunsch an", () => {
    expect(mcpEntry(opts).env).not.toHaveProperty("JARVIS_STOP_ON_CANCEL");
    expect(mcpEntry({ ...opts, stopOnCancel: true }).env.JARVIS_STOP_ON_CANCEL).toBe("1");
  });
  test("Pfade mit Leerzeichen und Anführungszeichen bleiben gültiges YAML", () => {
    const cfg: any = Bun.YAML.parse(managedConfig({ ...opts, mcpPath: '/Users/a b/"c"/mcp.ts' }));
    expect(cfg.mcp_servers.jarvis.args).toEqual(['/Users/a b/"c"/mcp.ts']);
  });
  test("enthält nie einen Schlüssel", () => {
    expect(managedConfig(opts)).not.toMatch(/api[_-]?key|token|secret|passw/i);
  });
  test("hermes mcp add Argumente", () => {
    const a = addArgs(opts);
    expect(a.slice(0, 3)).toEqual(["mcp", "add", "jarvis"]);
    expect(a).toContain("JARVIS_MCP_ERRORS=text");
  });
});

describe("Werkzeugnamen", () => {
  test("Hermes-Name und Rückweg", () => {
    expect(hermesToolName("browser_scan")).toBe("mcp__jarvis__browser_scan");
    for (const n of ["mcp__jarvis__browser_scan", "mcp_jarvis_browser_scan", "jarvis_browser_scan", "browser_scan"]) expect(baseToolName(n)).toBe("browser_scan");
  });
});

describe("Einrichten", () => {
  test("schreibt, aktualisiert, überschreibt Fremdes nicht", () => {
    const home = mkdtempSync(join(tmpdir(), "hh-"));
    const a = setupHome(home, opts); expect(a).toMatchObject({ ok: true, created: true });
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toContain(MARKER);
    expect(setupHome(home, opts)).toMatchObject({ ok: true, created: false });
    writeFileSync(join(home, "config.yaml"), "model: x\n");
    const r = setupHome(home, opts); expect(r.ok).toBe(false);
    expect(readFileSync(join(home, "config.yaml"), "utf8")).toBe("model: x\n");
    expect(setupHome(home, opts, { force: true }).ok).toBe(true);
  });
});

const hermes = Bun.which("hermes");
describe.skipIf(!hermes)("echtes Hermes (hermes mcp test)", () => {
  test("Hermes' MCP-Client verbindet sich mit dem Jarvis-Server und findet die Werkzeuge", () => {
    const home = mkdtempSync(join(tmpdir(), "hh-real-"));
    // Eine echte jarvisd-Antwort ist nicht nötig: mcp.ts liefert die Werkzeugliste selbst.
    expect(setupHome(home, { daemonUrl: "http://127.0.0.1:9" }).ok).toBe(true);
    const r = verify(home);
    expect(r.output).toMatch(/Connected/);
    expect(r.tools).toBeGreaterThan(20);
    expect(r.ok).toBe(true);
  }, 150_000);
});
