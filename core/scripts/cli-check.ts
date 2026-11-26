// Prüft Claude Code oder Codex mit den installierten Programmen und dem Konto des Nutzers (kurze Testfragen, kein Download):
//   bun core/scripts/cli-check.ts claude|codex
// Ein Ersatz-jarvisd beantwortet den Jarvis-MCP-Aufruf; es wird nichts am Rechner bedient. Zwei Läufe: Werkzeug aufrufen, dann dieselbe
// Sitzung fortsetzen. Kostet zwei sehr kurze Anfragen am Abo bzw. ChatGPT-Konto.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliAgent, CLI_LABEL, defaultCliConfig, isCliKind } from "../src/cli-agents";

const kind = process.argv[2];
if (!isCliKind(kind)) { console.error("Aufruf: bun core/scripts/cli-check.ts claude|codex"); process.exit(2); }
const calls: unknown[] = [];
const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) { calls.push(await req.json().catch(() => ({}))); return Response.json({ ok: true, text: "Monitor 1: Hauptbildschirm 1920x1080" }); } });
const work = mkdtempSync(join(tmpdir(), "cli-check-"));
const agent = new CliAgent({ daemonUrl: `http://127.0.0.1:${stub.port}`, workspace: work });
let fail = 0;
const check = (name: string, ok: boolean, extra = "") => { console.log(`${ok ? "OK  " : "FEHL"} ${name}${ok ? "" : " " + extra}`); if (!ok) fail++; };
try {
  const status = await agent.status(kind);
  check(`${CLI_LABEL[kind]} installiert und angemeldet`, status.installed && status.loggedIn, status.detail);
  if (!status.loggedIn) process.exit(1);
  const id = "s1", native = crypto.randomUUID();
  const turn = async (input: string, resume: boolean, nativeId: string) => {
    const events: any[] = []; const r = await agent.prompt(id, { kind, config: defaultCliConfig(), input, instructions: "Antworte kurz auf Deutsch.", native: nativeId, resume }, e => events.push(e));
    return { events, native: r.native };
  };
  const first = await turn("Rufe das Werkzeug desktop_displays auf und nenne den Namen des Monitors in einem Satz.", false, native);
  const tools = first.events.filter(e => e.kind === "tool");
  check("Jarvis-Werkzeug aufgerufen (laufend, dann fertig)", tools.some(t => t.name === "desktop_displays" && t.status === "running") && tools.some(t => t.name === "desktop_displays" && t.status === "completed"), JSON.stringify(first.events).slice(0, 400));
  check("Stub-Daemon hat den Aufruf erhalten", calls.some((c: any) => c.target === "desktop" && c.cmd?.cmd === "displays"));
  check("Antwort enthält den Monitornamen", /Hauptbildschirm/i.test(first.events.filter(e => e.kind === "text").map(e => e.delta).join("")));
  check("Lauf endet ohne Fehler", first.events.at(-1)?.kind === "done", JSON.stringify(first.events.at(-1)));
  check("Sitzungs-ID vorhanden", !!first.native);
  const second = await turn("Wie hieß der Monitor noch einmal? Antworte mit einem Wort.", true, first.native ?? native);
  check("Fortsetzen: Sitzung kennt die frühere Antwort", /Hauptbildschirm/i.test(second.events.filter(e => e.kind === "text").map(e => e.delta).join("")), JSON.stringify(second.events).slice(0, 300));
  check("Fortsetzen endet ohne Fehler", second.events.at(-1)?.kind === "done");
  // Abbrechen: lange Anfrage starten und nach kurzer Zeit stoppen
  const events: any[] = []; const t0 = performance.now();
  const running = agent.prompt("s2", { kind, config: defaultCliConfig(), input: "Zähle langsam von 1 bis 500 und schreibe jede Zahl in eine eigene Zeile.", instructions: "", native: crypto.randomUUID(), resume: false }, e => events.push(e));
  await Bun.sleep(4000); await agent.abort("s2"); await running;
  check("Abbrechen beendet den Lauf schnell", events.at(-1)?.kind === "done" && events.at(-1)?.aborted === true && performance.now() - t0 < 15000, JSON.stringify(events.at(-1)));
  check("Danach läuft nichts mehr", !agent.isRunning("s2"));
} finally { stub.stop(true); rmSync(work, { recursive: true, force: true }); }
console.log(fail ? `${fail} FEHLER` : "ALLES OK");
process.exit(fail ? 1 : 0);
