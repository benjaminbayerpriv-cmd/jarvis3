import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImport, expandTemplate, loadStore, parseMarkdown, scanImport, writeWorkspace } from "./extensions";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jarvis-ext-"));
  process.env.JARVIS_EXTENSIONS = join(dir, "extensions.json");
  return dir;
}

test("Markdown mit Frontmatter und Vorlage", () => {
  const m = parseMarkdown("---\ndescription: Fasst zusammen\nmodel: x\n---\nFasse $ARGUMENTS zusammen.");
  expect(m.meta.description).toBe("Fasst zusammen");
  expect(expandTemplate(m.body, "den Text")).toBe("Fasse den Text zusammen.");
  expect(expandTemplate("Mach etwas.", "schnell")).toContain("Aufgabe des Nutzers: schnell");
  expect(expandTemplate("A $1 und $2", "x y")).toBe("A x und y");
});

test("Claude/Codex-MCP-Formate werden zu OpenCode-Einträgen", () => {
  const dir = setup();
  const store = loadStore();
  // Speicher direkt füllen wie ein Import es täte
  const counts = applyImport([
    { id: "a", kind: "mcp", name: "dateien", from: "claude", detail: "", status: "neu", data: { type: "local", command: ["npx", "-y", "srv"], environment: { K: "v" }, enabled: true, source: "claude" } },
    { id: "b", kind: "mcp", name: "web", from: "codex", detail: "", status: "neu", data: { type: "remote", url: "https://x.test/mcp", enabled: true, source: "codex" } },
    { id: "c", kind: "command", name: "zusammenfassen", from: "claude", detail: "", status: "neu", data: { description: "Fasst zusammen", template: "Fasse $ARGUMENTS zusammen." } },
    { id: "d", kind: "plugin", name: "mein-plugin", from: "opencode", detail: "", status: "neu", data: { name: "mein-plugin" } },
  ], store);
  expect(counts).toEqual({ mcp: 2, skill: 0, command: 1, plugin: 1 });
  const ws = join(dir, "ws"); mkdirSync(ws);
  writeWorkspace(ws, { mcp: { jarvis: { type: "local", command: ["x"] } } }, loadStore());
  const config = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8"));
  expect(Object.keys(config.mcp)).toEqual(["jarvis", "dateien", "web"]);
  expect(config.mcp.web).toEqual({ type: "remote", url: "https://x.test/mcp", enabled: true });
  expect(config.plugin).toEqual(["mein-plugin"]);
  expect(readFileSync(join(ws, ".opencode", "command", "zusammenfassen.md"), "utf8")).toContain("description: Fasst zusammen");
});

test("Skills werden verknüpft, gesperrte Skills in der Konfiguration verweigert", () => {
  const dir = setup();
  const skill = join(dir, "quelle", "mein-skill"); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: mein-skill\ndescription: Testet\n---\nAnleitung");
  const store = loadStore();
  applyImport([{ id: "s", kind: "skill", name: "mein-skill", from: "claude", detail: "", status: "neu", data: { path: skill } }], store);
  store.disabledSkills = ["alt-skill"];
  const ws = join(dir, "ws"); mkdirSync(ws);
  writeWorkspace(ws, {}, store);
  expect(lstatSync(join(ws, ".opencode", "skills", "mein-skill")).isSymbolicLink()).toBe(true);
  expect(JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")).permission.skill).toEqual({ "alt-skill": "deny" });
});

test("Importsuche liefert nur Bekanntes ohne Absturz", () => {
  setup();
  for (const from of ["claude", "codex", "opencode"] as const) expect(Array.isArray(scanImport(from))).toBe(true);
});
