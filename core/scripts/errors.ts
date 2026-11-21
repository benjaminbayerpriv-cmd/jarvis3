// Fehler-Log für Agenten (docs/errors.md). Arbeitet direkt auf ~/.jarvis3/errors/, jarvisd muss nicht laufen.
//   bun core/scripts/errors.ts                 offene Fehler kurz auflisten
//   bun core/scripts/errors.ts list [kategorie] [--json]
//   bun core/scripts/errors.ts show <id>       ganzer Eintrag (Kontext, Stack, Screenshot-Pfad)
//   bun core/scripts/errors.ts resolve <id>…   nach dem Beheben: Eintrag + Screenshot löschen
//   bun core/scripts/errors.ts path            Ordner des Logs
import { join } from "node:path";
import { listErrors, resolveError, errorDir } from "../src/errorlog";

const [cmd = "list", ...args] = process.argv.slice(2);
const dir = errorDir();

if (cmd === "list") {
  const entries = listErrors(args.find(a => !a.startsWith("--")));
  if (args.includes("--json")) console.log(JSON.stringify(entries, null, 2));
  else if (!entries.length) console.log("Keine offenen Fehler.");
  else for (const e of entries)
    console.log(`${e.id}  ${e.category.padEnd(9)} ${String(e.count).padStart(4)}×  ${e.lastSeen.slice(0, 19)}  ${e.source}: ${e.message.split("\n")[0].slice(0, 120)}${e.screenshot ? "  [Screenshot]" : ""}`);
} else if (cmd === "show") {
  const e = listErrors().find(x => x.id === args[0]);
  if (!e) { console.error(`Unbekannte Fehler-ID: ${args[0]}`); process.exit(1); }
  console.log(JSON.stringify({ ...e, screenshot: e.screenshot ? join(dir, e.screenshot) : undefined }, null, 2));
} else if (cmd === "resolve") {
  if (!args.length) { console.error("Fehler-ID angeben"); process.exit(1); }
  let failed = 0;
  for (const id of args) {
    if (resolveError(id)) console.log(`${id} behoben, Eintrag gelöscht`);
    else { console.error(`${id}: unbekannte Fehler-ID`); failed++; }
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "path") {
  console.log(dir);
} else {
  console.error("Befehle: list [kategorie] [--json] | show <id> | resolve <id>… | path");
  process.exit(1);
}
