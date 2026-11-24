// Vertragsprüfung gegen den ECHTEN jarvisd (core/src/index.ts) mit isoliertem HOME, Fake-OpenCode und Fake-Hermes; Nachrichten kommen aus
// der UI-Logik (backends.js). Braucht core mit der Backend-Schnittstelle aus PR #63; ohne Downloads, alles lokal.
//   JARVIS_CORE=/pfad/zu/core bun app/ui/test/real-daemon-check.ts
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configOf, msgConfig, msgGet, msgSecret, msgTest, normalizeBackendState, validateConfig } from "../backends.js";
const freePort = () => { const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() }); const p = s.port!; s.stop(); return p; };
const root = mkdtempSync(join(tmpdir(), "jarvis-ui-"));
const bin = join(root, "bin"); mkdirSync(bin);
const oc = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { const p = new URL(req.url).pathname;
  if (p === "/global/health") return Response.json({ healthy: true });
  if (p === "/event") return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": connected\n\n")); } }));
  if (p === "/session") return Response.json([]); return Response.json({}); } });
writeFileSync(join(bin, "opencode"), '#!/bin/sh\n[ "$1" = models ] && echo opencode/test\n', { mode: 0o755 });
const fake = join(root, "fake-hermes.ts");
writeFileSync(fake, `Bun.serve({ hostname:'127.0.0.1', port:Number(process.env.API_SERVER_PORT), fetch(req){ const p=new URL(req.url).pathname;
 if (req.headers.get('authorization')!=='Bearer server-geheim-1234567890') return new Response('',{status:401});
 if (p==='/v1/capabilities') return Response.json({features:{run_submission:true,run_events_sse:true,run_stop:true}});
 if (p==='/api/sessions') return Response.json({data:[]}); return new Response('',{status:404}); }});`);
writeFileSync(join(bin, "hermes"), `#!/bin/sh\nexec '${process.execPath}' '${fake}'\n`, { mode: 0o755 });
const hermesPort = freePort(), daemonPort = freePort();
const proc = Bun.spawn([process.execPath, "run", "src/index.ts"], { cwd: process.env.JARVIS_CORE ?? join(import.meta.dir, "../../../core"), stdout: "pipe", stderr: "pipe",
  env: { ...process.env, HOME: root, PATH: `${bin}:${process.env.PATH}`, JARVIS_NO_SIDECAR: "1", JARVIS_PORT: String(daemonPort), JARVIS_OPENCODE_PORT: String(oc.port), JARVIS_HERMES_HOME: join(root, "hermes") } });
const results: string[] = []; let fail = 0;
const check = (name: string, ok: boolean, extra = "") => { results.push(`${ok ? "OK  " : "FEHL"} ${name}${ok ? "" : " " + extra}`); if (!ok) fail++; };
try {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${daemonPort}/health`)).ok) break; } catch {} await Bun.sleep(50); }
  const ws = new WebSocket(`ws://127.0.0.1:${daemonPort}/ui`);
  const all: any[] = []; ws.onmessage = e => { try { all.push(JSON.parse(String(e.data))); } catch {} };
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error("WS")); });
  const seen: any[] = [];
  const ask = async (m: object, type: string, ms = 8000) => { const before = all.length; ws.send(JSON.stringify(m)); for (let t = 0; t < ms / 40; t++) { const i = all.slice(before).findIndex(x => x.type === type); if (i >= 0) { const x = all.slice(before)[i]; seen.push(x); return x; } await Bun.sleep(40); } throw new Error("keine Antwort " + type); };
  const state = async () => normalizeBackendState(await ask(msgGet(), "backend"));
  let s = await state();
  check("Zustand: Hermes bereit, providers inkl. custom", s.backends.hermes.status === "ready" && s.backends.hermes.providers.some((p: any) => p.id === "custom"));
  check("Zustand: Hermes-Vorgaben", JSON.stringify(s.backends.hermes.config) === JSON.stringify({ serverUrl: "http://127.0.0.1:8642", provider: "default", model: "hermes-agent", modelBaseUrl: "", modelSupportsVision: false }), JSON.stringify(s.backends.hermes.config));
  const managed = `http://127.0.0.1:${hermesPort}`;
  const draft = { serverUrl: managed, provider: "custom", model: "qwen2.5-vl", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true };
  check("UI-Prüfung gültig (verwaltet + Heimnetz-Modellserver)", validateConfig(draft).valid);
  let r = await ask(msgConfig("hermes", draft), "backend_saved"); check("Konfig mit modelBaseUrl/Bildfähigkeit gespeichert", r.ok === true, JSON.stringify(r));
  r = await ask(msgSecret("hermes", "server-geheim-1234567890", "server"), "backend_saved"); check("Server-Schlüssel (target server)", r.ok === true, JSON.stringify(r));
  r = await ask(msgSecret("hermes", "anbieter-geheim-1234567890", "provider"), "backend_saved"); check("Anbieter-Schlüssel (target provider)", r.ok === true, JSON.stringify(r));
  s = await state();
  check("Zustand: Konfig zurückgelesen", JSON.stringify(configOf(s.backends.hermes.config)) === JSON.stringify(configOf(draft)), JSON.stringify(s.backends.hermes.config));
  check("Zustand: keySet und providerKeySet", s.backends.hermes.keySet && s.backends.hermes.providerKeySet);
  r = await ask(msgTest("hermes"), "backend_test"); check("backend_test (Gateway startet)", r.ok === true, JSON.stringify(r));
  // fremdes Gateway im Netzwerk
  const ext = { serverUrl: "http://192.168.1.30:8642", provider: "custom", model: "m", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: false };
  check("UI-Prüfung: fremdes Gateway + Modellserver ungültig", !validateConfig(ext).valid);
  r = await ask(msgConfig("hermes", ext), "backend_saved"); check("Daemon lehnt fremdes Gateway + modelBaseUrl ab", r.ok === false && /externem Gateway/.test(r.error), JSON.stringify(r));
  r = await ask(msgConfig("hermes", { ...ext, provider: "default", modelBaseUrl: "" }), "backend_saved"); check("Daemon nimmt fremdes Gateway ohne modelBaseUrl an", r.ok === true, JSON.stringify(r));
  s = await state(); check("Zustand: externalGatewayManaged=false", s.backends.hermes.externalGatewayManaged === false && s.backends.hermes.config.modelBaseUrl === "");
  r = await ask(msgSecret("hermes", "x-anbieter", "provider"), "backend_saved"); check("Daemon lehnt Anbieter-Schlüssel bei fremdem Gateway ab", r.ok === false && /externen Gateway/.test(r.error), JSON.stringify(r));
  r = await ask(msgSecret("hermes", "x", "unbekannt"), "backend_saved"); check("Daemon lehnt unbekanntes target ab", r.ok === false, JSON.stringify(r));
  r = await ask(msgConfig("opencode", { serverUrl: "", provider: "x", model: "y" }), "backend_saved"); check("Daemon: OpenCode nicht konfigurierbar", r.ok === false, JSON.stringify(r));
  r = await ask(msgConfig("hermes", { ...draft, serverUrl: "http://u:p@127.0.0.1:1" }), "backend_saved"); check("Daemon lehnt Zugangsdaten in Adresse ab", r.ok === false, JSON.stringify(r));
  // zurück auf verwaltet, Schlüssel entfernen
  await ask(msgConfig("hermes", { ...draft, modelBaseUrl: "" }), "backend_saved");
  r = await ask(msgSecret("hermes", null, "provider"), "backend_saved"); check("Anbieter-Schlüssel entfernen", r.ok === true, JSON.stringify(r));
  s = await state(); check("providerKeySet false, keySet true", !s.backends.hermes.providerKeySet && s.backends.hermes.keySet);
  // Geheimnisse
  const wire = JSON.stringify(all); check("Kein Schlüssel in Daemon-Nachrichten", !/geheim-1234567890/.test(wire));
  const files: string[] = []; const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); const st = statSync(p); st.isDirectory() ? walk(p) : files.push(p); } }; walk(root);
  const yaml = files.filter(f => /hermes\/.*\.ya?ml$/.test(f)).map(f => readFileSync(f, "utf8")).join("\n");
  check("Hermes-YAML ohne Schlüsselwert", !/geheim-1234567890/.test(yaml), yaml.slice(0, 300));
  const keyFiles = files.filter(f => /backend\/hermes.*\.key$/.test(f)).map(f => `${f.split("/").slice(-2).join("/")} ${(statSync(f).mode & 0o777).toString(8)}`);
  check("Schlüsseldateien mit Rechten 600", keyFiles.length >= 1 && keyFiles.every(k => k.endsWith(" 600")), keyFiles.join(", "));
  ws.close();
} catch (e) { results.push("ABBRUCH " + e); fail++; }
finally { proc.kill(); await proc.exited; oc.stop(true); rmSync(root, { recursive: true, force: true }); }
console.log(results.join("\n")); console.log(fail ? `${fail} FEHLER` : "ALLES OK"); process.exit(fail ? 1 : 0);
