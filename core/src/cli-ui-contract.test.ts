import { expect, test } from "bun:test";
// @ts-ignore reines JS der Oberfläche
import { cliConfigOf, msgConfig, validateCliConfig } from "../../app/ui/backends.js";
import { parseCliConfig } from "./cli-agents";

// Die Prüfung der Oberfläche (app/ui/backends.js) und die des Daemons (cli-agents.ts) müssen dieselben Einstellungen zulassen.
test("Oberfläche und Daemon prüfen Modellname und Dateizugriff gleich", () => {
  const models = ["", "sonnet", "claude-sonnet-5-5", "gpt-5.5-codex", "o3", "a b", "--evil", "-x", "x".repeat(100), "x".repeat(101), "a;b", "$(x)", "mo/del:1", "m[1m]", "ä"];
  const files = ["none", "read", "write", "", undefined];
  let n = 0;
  for (const model of models) for (const f of files) {
    const ui = validateCliConfig({ model, files: f }).valid;
    let accepted = true; try { parseCliConfig(cliConfigOf({ model, files: f })); } catch { accepted = false; }     // was wirklich gesendet würde
    let raw = true; try { parseCliConfig({ model, files: f }); } catch { raw = false; }                              // was der Nutzer eingegeben hat
    n++;
    if (ui) expect({ model, files: f, accepted }).toEqual({ model, files: f, accepted: true });   // gültig in der Oberfläche => der Daemon nimmt es an
    else if (f !== undefined) expect({ model, files: f, raw }).toEqual({ model, files: f, raw: false });                // ungültig in der Oberfläche => der Daemon hätte es auch abgelehnt (fehlender Dateizugriff ist nur für ihn „Standard“)
  }
  expect(n).toBe(models.length * files.length);
});

test("Die Nachricht der Oberfläche wird vom Daemon unverändert angenommen", () => {
  const msg = msgConfig("codex", { model: " gpt-5.5 ", files: "read" });
  expect(msg).toEqual({ type: "backend_config", backend: "codex", config: { model: "gpt-5.5", files: "read" } });
  expect(parseCliConfig(msg.config)).toEqual({ model: "gpt-5.5", files: "read" });
});
