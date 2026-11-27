import { expect, test } from "bun:test";
import { CLAUDE_MODELS, loadCodexModels, parseCodexCatalog } from "./cli-models";

const catalog = JSON.stringify({ models: [
  { slug: "gpt-b", display_name: "B", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
  { slug: "gpt-a", display_name: "A", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }, { effort: "ultra" }] },
  { slug: "versteckt", display_name: "H", visibility: "hide", priority: 3 },
  { slug: "böse slug!", display_name: "X", visibility: "list", priority: 4 }, { nope: 1 }, null,
] });

test("Codex-Katalog: sichtbare Modelle nach Priorität, Stufen je Modell, Müll wird übersprungen", () => {
  expect(parseCodexCatalog(catalog)).toEqual([{ id: "gpt-a", label: "A", efforts: ["low", "ultra"] }, { id: "gpt-b", label: "B", efforts: ["low", "high"] }]);
  expect(parseCodexCatalog("kein json")).toEqual([]); expect(parseCodexCatalog("{}")).toEqual([]);
});
test("Claude-Liste: Kurznamen und IDs, alle mit gültigem Namen", () => {
  expect(CLAUDE_MODELS.map(m => m.id)).toEqual(expect.arrayContaining(["sonnet", "opus", "haiku", "claude-sonnet-5-5"]));
  for (const m of CLAUDE_MODELS) { expect(m.id).toMatch(/^[\w][\w.:/\-]*$/); expect(m.efforts).not.toContain("ultra"); }
});
test("fehlendes Programm liefert eine leere Liste", async () => { expect(await loadCodexModels("/gibt/es/nicht")).toEqual([]); });
