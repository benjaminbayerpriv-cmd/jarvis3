// Jarvis-Werkzeuge in Hermes einrichten und prüfen.
//   bun core/scripts/hermes-jarvis.ts setup [--home DIR] [--daemon URL] [--stop-on-cancel] [--force]   config.yaml für ein eigenes Hermes-Verzeichnis schreiben
//   bun core/scripts/hermes-jarvis.ts test  [--home DIR]                                               mit `hermes mcp test jarvis` prüfen
//   bun core/scripts/hermes-jarvis.ts print [--daemon URL]                                             Konfiguration ausgeben
//   bun core/scripts/hermes-jarvis.ts add-command                                                      Befehl für eine bestehende Hermes-Installation ausgeben
import { addArgs, defaultHome, managedConfig, setupHome, verify } from "../src/hermes-tools";

const [cmd = "help", ...rest] = process.argv.slice(2);
const flag = (n: string) => rest.includes(n);
const value = (n: string) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
const opts = { daemonUrl: value("--daemon"), stopOnCancel: flag("--stop-on-cancel") };
const home = value("--home") ?? defaultHome();

if (cmd === "setup") {
  const r = setupHome(home, opts, { force: flag("--force") });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  console.log(`${r.created ? "geschrieben" : "aktualisiert"}: ${r.path}\nprüfen: bun core/scripts/hermes-jarvis.ts test --home ${home}\nstarten: HERMES_HOME=${home} hermes ...`);
} else if (cmd === "test") {
  const r = verify(home);
  console.log(r.output.trim());
  if (!r.ok) process.exit(1);
  console.log(`\nOK: ${r.tools} Jarvis-Werkzeuge in Hermes sichtbar.`);
} else if (cmd === "print") console.log(managedConfig(opts));
else if (cmd === "add-command") console.log(`hermes ${addArgs(opts).map(a => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\nDanach in Hermes die Werkzeugsätze browser und computer_use abschalten: hermes tools disable browser computer_use`);
else console.log("setup | test | print | add-command (siehe Kopf der Datei)");
