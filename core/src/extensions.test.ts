import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImport, enabledSkills, expandTemplate, loadStore, parseMarkdown, readSkill, saveStore, scanImport, skillCatalog, writeWorkspace } from "./extensions";

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
  expect(config.mcp.web).toEqual({ type: "remote", url: "https://x.test/mcp", enabled: false }); // Import startet aus
  expect(config.plugin).toEqual(["mein-plugin"]);
  expect(readFileSync(join(ws, ".opencode", "command", "zusammenfassen.md"), "utf8")).toContain("description: Fasst zusammen");
});

test("Skills stehen nicht im Systemprompt, werden aber bei Bedarf gelesen", () => {
  const dir = setup();
  const skill = join(dir, "quelle", "mein-skill"); mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: mein-skill\ndescription: Testet\n---\nAnleitung");
  const store = loadStore();
  applyImport([{ id: "s", kind: "skill", name: "mein-skill", from: "claude", detail: "", status: "neu", data: { path: skill } }], store);
  expect(store.disabledSkills).toEqual(["mein-skill"]); // Import startet aus
  writeFileSync(join(skill, "referenz.md"), "mehr");
  expect(skillCatalog(store)[0]).toMatchObject({ name: "mein-skill", description: "Testet", enabled: false });
  expect(readSkill("mein-skill", store)).toMatchObject({ ok: false });             // importiert = aus
  store.disabledSkills = [];                                                         // aktiviert
  expect(enabledSkills(store).map(x => x.name)).toEqual(["mein-skill"]);
  const read = readSkill("Mein-Skill", store);
  expect(read.ok && read.text.includes("Anleitung") && read.files).toEqual(["referenz.md"]);
  expect(readSkill("gibtsnicht", store)).toMatchObject({ ok: false });
  const ws = join(dir, "ws"); mkdirSync(ws);
  writeWorkspace(ws, {}, store);
  expect(existsSync(join(ws, ".opencode", "skills", "mein-skill"))).toBe(false);   // nicht mehr in OpenCode geladen
  expect(JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8")).permission.skill).toEqual({ "*": "deny" });  // nie im Systemprompt
});

test("Importsuche liefert nur Bekanntes ohne Absturz", () => {
  setup();
  for (const from of ["claude", "codex", "opencode"] as const) expect(Array.isArray(scanImport(from))).toBe(true);
});

test("Altbestand: Importiertes wird einmalig abgeschaltet, eigene Einträge bleiben", () => {
  setup();
  const { writeFileSync: w } = require("node:fs");
  w(process.env.JARVIS_EXTENSIONS!, JSON.stringify({ mcp: {
    rea: { type: "local", command: ["rea"], enabled: true, source: "claude" },
    eigen: { type: "local", command: ["x"], enabled: true, source: "manual" } },
    skillDirs: { a: { path: "/tmp/a", source: "claude" } }, disabledSkills: [], commands: {}, plugins: [] }));
  const store = loadStore();
  expect(store.mcp.rea.enabled).toBe(false);
  expect(store.mcp.eigen.enabled).toBe(true);
  expect(store.disabledSkills).toEqual(["a"]);
  store.mcp.rea.enabled = true; // später bewusst eingeschaltet
  saveStore(store);
  expect(loadStore().mcp.rea.enabled).toBe(true);
});

test("Jarvis und extern konfigurierte MCP-Server lassen sich getrennt umschalten", () => {
  const ws = setup();
  const store = loadStore();
  const base = { mcp: { jarvis: { type: "local", command: ["jarvis-mcp"], enabled: true } } };
  for (const enabled of [false, true]) {
    store.mcpOverrides = { jarvis: enabled, external: enabled };
    writeWorkspace(ws, base, store);
    const { mcp } = JSON.parse(readFileSync(join(ws, "opencode.json"), "utf8"));
    expect(mcp.jarvis).toEqual({ type: "local", command: ["jarvis-mcp"], enabled });
    expect(mcp.external).toEqual({ enabled });
    expect(base.mcp.jarvis.enabled).toBe(true);
  }
});
