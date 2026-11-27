import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexUserMcpNames, scanInstalled } from "./cli-adopt";

const home = () => mkdtempSync(join(tmpdir(), "adopt-"));

test("Codex: nur die Namen der MCP-Server aus config.toml, keine Werte; kaputte Dateien sind leer", () => {
  const h = home(); mkdirSync(join(h, ".codex"));
  writeFileSync(join(h, ".codex", "config.toml"), '[mcp_servers.computer-use]\ncommand = "x"\nenv = { TOKEN = "geheim" }\n[mcp_servers.higgsfield]\nurl = "https://x"\n[mcp_servers."böse name"]\ncommand="y"\n[mcp_servers.jarvis]\ncommand="z"\n');
  expect(codexUserMcpNames(h).sort()).toEqual(["computer-use", "higgsfield"]);   // „jarvis“ und ungültige Namen fallen weg
  writeFileSync(join(h, ".codex", "config.toml"), "kaputt = [");
  expect(codexUserMcpNames(h)).toEqual([]);
  expect(codexUserMcpNames(home())).toEqual([]);
});

test("Anzahl Skills und Plugins je Programm", () => {
  const h = home();
  for (const d of [".claude/skills/a", ".claude/skills/b", ".claude/plugins", ".codex/skills/x", ".agents/skills/y", ".agents/skills/z", ".codex/plugins/cache/m1/p1", ".codex/plugins/cache/m1/p2", ".codex/plugins/cache/m2/p3"]) mkdirSync(join(h, d), { recursive: true });
  writeFileSync(join(h, ".claude/skills/datei.md"), "keine Skill-Ordner zählen nur Ordner");
  writeFileSync(join(h, ".claude/plugins/installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "p@m": [], "q@m": [] } }));
  expect(scanInstalled("claude", h)).toEqual({ skills: 2, plugins: 2 });
  expect(scanInstalled("codex", h)).toEqual({ skills: 3, plugins: 3 });
  expect(scanInstalled("claude", home())).toEqual({ skills: 0, plugins: 0 });
});
