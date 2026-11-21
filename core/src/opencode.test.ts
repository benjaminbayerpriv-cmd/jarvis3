import { test, expect } from "bun:test";
import { OpenCode, parseModels } from "./opencode";
test("gruppiert Modelle", () => {
  const m = parseModels("opencode/big-pickle\nlmstudio/qwen/qwen3.5-9b\nopencode/nemotron-3.5-super-vl-free\nnoise");
  expect(m.map(x => x.group)).toEqual(["free", "lmstudio", "free"]);
  expect(m[2].vision).toBe(true);
});

test("Verbrauch: echte Zahlen werden einmal gezählt, ohne Zahlen wird am Laufende geschätzt", async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const f = join(mkdtempSync(join(tmpdir(), "jarvis-usage-oc-")), "u.jsonl");
  process.env.JARVIS_USAGE_FILE = f;
  const oc: any = new OpenCode(1);
  const lines = () => existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  // Lauf 1: API liefert Zahlen (zweimal dieselbe Nachricht)
  oc.runs.set("s1", { model: "opencode/m", inChars: 400, outChars: 0, real: false });
  oc.listeners.set("s1", () => {}); oc.started.add("s1");
  const info = { id: "m1", role: "assistant", sessionID: "s1", providerID: "opencode", modelID: "m", time: { completed: 1 }, tokens: { input: 10, output: 5 } };
  oc.dispatch({ type: "message.updated", properties: { info } });
  oc.dispatch({ type: "message.updated", properties: { info } });
  oc.dispatch({ type: "session.idle", properties: { sessionID: "s1" } });
  expect(lines()).toEqual([expect.objectContaining({ model: "opencode/m", input: 10, output: 5, estimated: false })]);
  // Lauf 2: keine Zahlen -> Schätzung
  oc.runs.set("s2", { model: "lmstudio/q", inChars: 400, outChars: 40, real: false });
  oc.listeners.set("s2", () => {}); oc.started.add("s2");
  oc.dispatch({ type: "session.idle", properties: { sessionID: "s2" } });
  expect(lines()[1]).toEqual(expect.objectContaining({ model: "lmstudio/q", input: 100, output: 10, estimated: true }));
});
