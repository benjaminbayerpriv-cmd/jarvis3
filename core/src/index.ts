// jarvisd – Kern-Daemon. UI (Tauri) und Chrome-Erweiterung verbinden sich hierher.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { OpenCode, listModels, type ModelInfo, type BrainEvent } from "./opencode";
import { Desktop } from "./desktop";
import { Browser } from "./browser";
import { SYSTEM_PROMPT } from "./prompt";
import { Speech, SentenceSplitter } from "./speech";

const PORT = Number(process.env.JARVIS_PORT ?? 7777);
const HOME = join(homedir(), ".jarvis3");
const SETTINGS = join(HOME, "settings.json");
const ROOT = join(import.meta.dir, "../..");
mkdirSync(HOME, { recursive: true });

interface Settings { model: string; voiceModel: string; mode: "browser" | "computer"; lofi: boolean; liveView: boolean }
const defaults: Settings = { model: "opencode/deepseek-v4.1-flash-free", voiceModel: "opencode/deepseek-v4.1-flash-free", mode: "browser", lofi: false, liveView: true };
let settings: Settings = existsSync(SETTINGS) ? { ...defaults, ...JSON.parse(readFileSync(SETTINGS, "utf8")) } : defaults;
const save = () => writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

// OpenCode-Arbeitsordner mit Jarvis-MCP und voller Autonomie (Nutzerentscheidung).
const workspace = join(ROOT, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  mcp: { jarvis: { type: "local", command: [process.execPath, join(ROOT, "core/src/mcp.ts")], enabled: true,
                   environment: { JARVISD_URL: `http://127.0.0.1:${PORT}` } } },
  permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" },
}, null, 2));

const brain = new OpenCode(4096, workspace);
const desktop = new Desktop();
const browser = new Browser();
let models: ModelInfo[] = [];
let session: string | undefined;
let busy = false;
let stoppedUntil = 0; // Not-Aus: Werkzeuge kurz sperren

const uis = new Set<ServerWebSocket<{ kind: string; fresh?: boolean }>>();
const broadcast = (msg: unknown) => { const s = JSON.stringify(msg); for (const ui of uis) ui.send(s); };
const state = () => ({ type: "state", model: settings.model, voiceModel: settings.voiceModel, mode: settings.mode,
                       lofi: settings.lofi, liveView: settings.liveView, extStale: extensionStale, busy, browser: browser.connected, speech: speech.connected, voice, models });

// ---------- Sprache ----------
let voice: "off" | "live" | "dictate" | "muted" = "off";
let splitter: SentenceSplitter | undefined;
const holds = new Set<ReturnType<typeof setTimeout>>(); // zurückgehaltene Sätze nach dem ersten Werkzeug (siehe chat)
const clearHolds = () => { for (const t of holds) clearTimeout(t); holds.clear(); };
import { appendFileSync } from "node:fs";
const vlog = (line: string) => { try { appendFileSync(join(HOME, "voice.log"), `${new Date().toISOString()} ${line}\n`); } catch {} };
const speech = new Speech(e => {
  if (e.type !== "level" && e.type !== "partial") vlog(`speech ${e.type} ${JSON.stringify({ ...e, type: undefined }).slice(0, 300)} voice=${voice}`);
  if (e.type === "connected") { speech.send({ type: "config", lofi: settings.lofi }); speech.mode(voice); if (voice === "off") speech.stopSpeaking(); broadcast(state()); return; }
  if (e.type === "disconnected") { broadcast(state()); return; }
  broadcast({ ...e, type: "speech", event: e.type });
  // Der Nutzer redet: Ausgabe verstummen lassen, die laufende Antwort aber nicht abbrechen (Husten/Pausen mitten im Satz).
  if (e.type === "speech_start" && voice === "live") { clearHolds(); splitter = undefined; }
  if (e.type === "final" && voice === "live") hear(String(e.text ?? ""));
});

// Satzfetzen zu einer Äußerung zusammenfassen: erst nach UTTER_WAIT_MS ohne neue Sprache wird an das Modell gesendet.
// Die Spracherkennung beendet einen Satz schon nach ~0,3 s Pause; ohne diese Wartezeit würde jeder Fetzen ("Äh, du kannst." –
// "Für mich mal." – …) als eigene Nachricht die vorige abbrechen.
const UTTER_WAIT_MS = 1000;
let pendingUtterance = "";
let utterTimer: ReturnType<typeof setTimeout> | undefined;
let lastRun: { text: string; toolSeen: boolean; startedAt: number } | undefined;
const STOP_WORDS = /^(stopp?|halt|abbrechen|hör auf|hoer auf|lass das|stop it)[.!?\s]*$/i;
function hear(text: string) {
  if (STOP_WORDS.test(text.trim())) { pendingUtterance = ""; clearTimeout(utterTimer); void stop(); return; }
  if (!worthAnswering(text) && !pendingUtterance) return;
  pendingUtterance = `${pendingUtterance} ${text}`.trim();
  clearTimeout(utterTimer);
  utterTimer = setTimeout(sendUtterance, UTTER_WAIT_MS);
}
function sendUtterance() {
  const text = pendingUtterance.trim(); pendingUtterance = "";
  if (!worthAnswering(text) || voice !== "live") return;
  let full = text, replace = false;
  // Antwort läuft noch, hat aber keine Werkzeuge benutzt und der Nutzer spricht weiter: zu EINER Äußerung zusammenführen
  if (busy && lastRun && !lastRun.toolSeen && Date.now() - lastRun.startedAt < 20_000) { full = `${lastRun.text} ${text}`; replace = true; }
  lastRun = { text: full, toolSeen: false, startedAt: Date.now() };
  vlog(`Äußerung: ${full.slice(0, 160)}${replace ? " (zusammengeführt)" : ""}`);
  broadcast({ type: "user", text: full, replace });
  void chat(full, settings.voiceModel, true);
}
// Rauschen, Füllwörter und Fehlerkennungen ("Untertitel…", "Äh", "Mm-hmm") nicht beantworten.
const FILLERS = new Set(["äh", "ähm", "äm", "öh", "öhm", "hm", "hmm", "mhm", "mm", "mmhmm", "mm-hmm", "um", "uh", "ah", "oh", "eh", "also", "ja", "nein", "okay", "ok", "ne", "na", "so", "genau"]);
function worthAnswering(text: string) {
  const words = text.toLowerCase().replace(/[.!?…,;:]+/g, " ").split(/\s+/).filter(Boolean);
  const content = words.filter(w => !FILLERS.has(w));
  if (!content.length || content.join("").length < 3) return false;
  return !/untertitel|copyright|vielen dank fürs zuschauen/i.test(text);
}
function setVoice(mode: typeof voice) {
  vlog(`setVoice ${voice} -> ${mode}`);
  voice = mode;
  speech.mode(mode);
  // "muted" schließt nur das Mikrofon; eine laufende Antwort wird weiter gesprochen.
  if (mode === "off") { splitter = undefined; clearHolds(); speech.stopSpeaking(); }
  broadcast(state());
}

// ---------- Verlauf (OpenCode-Sitzungen) ----------
async function history() {
  try {
    const list = await (await fetch(`${brain.url}/session`)).json() as any[];
    // Nur echte Unterhaltungen: Testläufe ("Test") und leere Sitzungen ohne eigenen Titel ausblenden
    const isEmpty = (t: string) => !t || t === "Jarvis" || /^New session/i.test(t) || /^Child session/i.test(t);
    return list.filter(s => !s.parentID && s.title !== "Test" && (!isEmpty(s.title) || s.id === session))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .map(s => ({ id: s.id, title: isEmpty(s.title) ? "Neuer Chat" : s.title, active: s.id === session }));
  } catch { return []; }
}
async function openSession(id: string) {
  session = id;
  const msgs = await (await fetch(`${brain.url}/session/${id}/message`)).json() as any[];
  return msgs.map(m => ({ role: m.info?.role, text: (m.parts ?? []).filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text).join("") }))
    .filter(m => m.text);
}

// Reihenfolge, in der ersatzweise andere Modelle probiert werden (Stand der Messung 2026-11-20).
const FALLBACKS = ["opencode/nemotron-3.5-lightning-free", "nvidia/minimaxai/minimax-m3.1-flash", "opencode/big-pickle",
  "opencode/longcat-2.5-free", "opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"];
const limited = new Map<string, number>(); // Modell -> gesperrt bis (ms)
const isLimit = (msg: string) => /free usage exceeded|rate.?limit|quota|too many requests|subscribe/i.test(msg);
function nextModel(tried: string[]) {
  const now = Date.now();
  return FALLBACKS.find(m => !tried.includes(m) && (limited.get(m) ?? 0) < now);
}

function announcement(e: Extract<BrainEvent, { kind: "tool" }>) {
  const name = e.name.replace(/^jarvis_/, "");
  const input = e.input ?? {};
  let host = "";
  try { host = input.url ? new URL(String(input.url)).host.replace(/^www\./, "") : ""; } catch {}
  if (name === "browser_tab_open" || name === "browser_navigate") return `Ich öffne ${host || "die Seite"}, einen Moment.`;
  if (name === "webfetch") return `Ich rufe ${host || "die Seite"} ab, einen Moment.`;
  if (name === "desktop_open_app") return `Ich öffne ${input.name ?? "das Programm"}, einen Moment.`;
  if (name.startsWith("browser_")) return "Ich schaue mir die Seite an, einen Moment.";
  if (name.startsWith("desktop_")) return "Ich sehe mir den Bildschirm an, einen Moment.";
  return "Ich kümmere mich darum, einen Moment.";
}

async function chat(text: string, model = settings.model, spoken = false, tried: string[] = [], fresh = false) {
  if (busy && session && !fresh) await brain.abort(session);
  // Ein Modell, das gerade am Limit ist, gar nicht erst anfragen
  if ((limited.get(model) ?? 0) > Date.now()) {
    const alt = nextModel([...tried, model]);
    if (alt) { broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` }); return chat(text, alt, spoken, [...tried, model], fresh); }
  }
  const isNew = !fresh && !session;
  const sid = fresh ? await brain.createSession("Test") : (session ??= await brain.createSession());
  // Titel aus dem Anfang der ersten Nachricht (statt 20 Mal "Jarvis" im Verlauf)
  if (isNew) {
    const title = text.replace(/\s+/g, " ").trim().slice(0, 48) + (text.trim().length > 48 ? "…" : "");
    void fetch(`${brain.url}/session/${sid}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) })
      .then(() => { for (const ui of uis) history().then(h => ui.send(JSON.stringify({ type: "history", sessions: h }))); }).catch(() => {});
  }
  busy = true; broadcast(state());
  const started = performance.now();
  let first = true, switching = false, textSeen = false, announced = false;
  splitter = spoken ? new SentenceSplitter() : undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Nach dem ersten Werkzeugaufruf werden Sätze 1 s zurückgehalten: Folgt direkt ein weiteres Werkzeug, war es ein Zwischentext
  // über etwas, das ohnehin gerade passiert, und wird verworfen (sonst kündigt Jarvis Erledigtes erst nachträglich an).
  let toolSeen = false;
  const speakAll = (parts: string[]) => {
    for (const p of parts) {
      vlog(`say: ${toolSeen ? "(gehalten) " : ""}${p.slice(0, 120)}`);
      if (!toolSeen) { speech.say(p); continue; }
      const t = setTimeout(() => { holds.delete(t); speech.say(p); }, 1000);
      holds.add(t);
    }
  };
  const system = spoken ? SYSTEM_PROMPT + "\n\nDu bist gerade im Sprachmodus: antworte in höchstens zwei kurzen Sätzen, ohne Listen." : SYSTEM_PROMPT;
  await brain.prompt(sid, text, model, system, (e: BrainEvent) => {
    if (switching) return;
    if (e.kind === "error" && isLimit(e.message)) {
      limited.set(model, Date.now() + 30 * 60_000);
      const alt = nextModel([...tried, model]);
      if (alt) {
        switching = true;
        broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` });
        brain.abort(sid).then(() => { busy = false; return chat(text, alt, spoken, [...tried, model], fresh); });
        return;
      }
      e = { kind: "error", message: "Alle Gratis-Modelle sind am Limit. Wähle ein lokales Modell (LM Studio) oder warte etwas." };
    }
    if (e.kind === "text") textSeen = true;
    // Modelle, die wortlos loslegen: eine passende Ankündigung ergänzen (wie bei einem guten Assistenten)
    if (e.kind === "tool" && !textSeen && !announced && e.status !== "pending") {
      announced = true;
      const line = announcement(e) + "\n\n";
      if (splitter) { speakAll(splitter.push(line)); speakAll(splitter.flush()); } // Ankündigung sofort sprechen
      if (first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started), model }); }
      broadcast({ type: "delta", text: line });
    }
    if (splitter && e.kind === "text") {
      speakAll(splitter.push(e.delta));
      // Satz ohne folgendes Leerzeichen (Strom pausiert, z. B. vor einem Werkzeug): nach kurzer Pause trotzdem sprechen
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { if (splitter) speakAll(splitter.flushIfSentence()); }, 600);
    }
    if (e.kind === "tool" && lastRun) lastRun.toolSeen = true;
    if (splitter && e.kind === "tool") {
      clearTimeout(flushTimer);
      if (toolSeen) { clearHolds(); splitter.flush(); vlog("Zwischentext vor Werkzeug verworfen"); } // Ankündigung gab es schon
      else speakAll(splitter.flush());
      toolSeen = true;
    }
    if (splitter && (e.kind === "done" || e.kind === "error")) { clearTimeout(flushTimer); speakAll(splitter.flush()); splitter = undefined; }
    if (e.kind === "text" && first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started), model }); }
    if (e.kind === "done" || e.kind === "error") { busy = false; broadcast(state()); }
    broadcast(e.kind === "text" ? { type: "delta", text: e.delta } : e.kind === "reasoning" ? { type: "reasoning", text: e.delta }
      : { type: e.kind, ...e });
  });
}

// ---------- Live-Ansicht des Tabs, in dem Jarvis gerade arbeitet ----------
let streamTab: number | undefined;
let streamTimer: ReturnType<typeof setTimeout> | undefined;
async function stopStream() {
  clearTimeout(streamTimer);
  const t = streamTab; streamTab = undefined;
  if (t !== undefined) await browser.call({ cmd: "stream_stop", tab: t }, 5000).catch(() => {});
}
async function ensureStream(tab: number) {
  if (!settings.liveView || uis.size === 0 || !browser.connected) return;
  clearTimeout(streamTimer);
  streamTimer = setTimeout(stopStream, 12_000); // 12 s nach der letzten Aktion endet die Übertragung
  if (streamTab === tab) return;
  if (streamTab !== undefined) await browser.call({ cmd: "stream_stop", tab: streamTab }, 5000).catch(() => {});
  const r = await browser.call({ cmd: "stream_start", tab }, 8000);
  streamTab = r.ok ? tab : undefined;
}
// Erweiterung veraltet? Neue Versionen lädt sie auf Anweisung selbst; sehr alte (vor 1.2.0) muss der Nutzer einmal neu laden.
const wantedExtension = () => { try { return JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")).version as string; } catch { return ""; } };
const versionNum = (v: string) => v.split(".").reduce((n, x) => n * 1000 + Number(x || 0), 0);
let extensionStale = false;
browser.onHello = version => {
  const want = wantedExtension();
  extensionStale = !!want && version !== want;
  if (extensionStale && versionNum(version) >= versionNum("1.2.0")) {
    vlog(`Erweiterung ${version} -> ${want}: lade neu`);
    setTimeout(() => void browser.call({ cmd: "reload" }, 3000).catch(() => {}), 300);
  } else if (extensionStale) {
    broadcast({ type: "notice", text: `Die Chrome-Erweiterung ist veraltet (${version}, aktuell ${want}). Bitte einmal unter chrome://extensions bei „Jarvis“ neu laden – danach aktualisiert sie sich selbst.` });
  }
  broadcast(state());
};
browser.onEvent = m => {
  if (m.type === "stream_ended" && m.tab === streamTab) streamTab = undefined;
  broadcast(m);
};

async function stop() {
  stoppedUntil = Date.now() + 1500;
  splitter = undefined;
  clearHolds();
  speech.stopSpeaking();
  if (session) await brain.abort(session);
  busy = false; broadcast({ type: "stopped" }); broadcast(state());
}

async function runTool(target: string, cmd: Record<string, any>) {
  if (Date.now() < stoppedUntil) return { ok: false, error: "vom Nutzer gestoppt" };
  broadcast({ type: "action", target, cmd: cmd.cmd, detail: cmd.url ?? cmd.id ?? cmd.name ?? "" });
  if (target === "browser") {
    if (Number.isInteger(cmd.tab)) void ensureStream(cmd.tab);
    const r = await browser.call(cmd);
    if (cmd.cmd === "tab_open" && r.ok && Number.isInteger(r.tab)) void ensureStream(r.tab as number);
    return r;
  }
  if (settings.mode !== "computer" && !["scan", "read", "shot"].includes(cmd.cmd))
    return { ok: false, error: "Computer-Steuerung ist aus (Modus: nur Browser). Nutzer bitten, sie einzuschalten." };
  if (cmd.cmd === "open_app") {
    const p = process.platform === "win32" ? Bun.spawn(["cmd", "/c", "start", "", cmd.name]) : Bun.spawn(["open", "-a", cmd.name]);
    return { ok: (await p.exited) === 0 };
  }
  return desktop.call(cmd);
}

Bun.serve<{ kind: string; fresh?: boolean }, {}>({
  port: PORT, hostname: "127.0.0.1",
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/browser" || u.pathname === "/ui")
      return srv.upgrade(req, { data: { kind: u.pathname.slice(1), fresh: u.searchParams.has("fresh") } }) ? undefined : new Response("upgrade", { status: 400 });
    if (u.pathname === "/" || u.pathname.startsWith("/app")) { // Oberfläche zum Testen im Browser
      const rel = u.pathname.replace(/^\/app\/?/, "").replace(/^\/$/, "") || "index.html";
      const file = Bun.file(join(ROOT, "app/ui", rel.replace(/\.\.+/g, "")));
      if (u.pathname === "/") return Response.redirect("/app/", 302);
      return (await file.exists()) ? new Response(file) : new Response("nicht gefunden", { status: 404 });
    }
    if (u.pathname === "/health") return Response.json({ ok: true, opencode: await brain.healthy(), browser: browser.connected });
    if (u.pathname === "/models") return Response.json(models = await listModels());
    if (u.pathname === "/tool" && req.method === "POST") {
      const { target, cmd } = await req.json();
      return Response.json(await runTool(target, cmd));
    }
    if (u.pathname === "/stop" && req.method === "POST") { await stop(); return Response.json({ ok: true }); }
    if (u.pathname === "/chat" && req.method === "POST") { // für Tests ohne UI
      const { text, model } = await req.json(); await chat(text, model); return Response.json({ ok: true });
    }
    return new Response("jarvisd", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "browser") { browser.attach(ws); broadcast(state()); }
      else {
        // Erste Oberfläche nach Start/Neuladen: neuer Chat (die Oberfläche zeigt ohnehin einen leeren Chat)
        if (uis.size === 0 && !ws.data.fresh) session = undefined;
        uis.add(ws); ws.send(JSON.stringify(state())); history().then(s => ws.send(JSON.stringify({ type: "history", sessions: s })));
      }
    },
    close(ws) {
      if (ws.data.kind === "browser") { browser.detach(ws); broadcast(state()); }
      else {
        uis.delete(ws);
        if (uis.size === 0) void stopStream();
        // Keine Oberfläche mehr offen: Mikrofon zu, nichts mehr sprechen.
        if (uis.size === 0 && voice !== "off") setVoice("off");
      }
    },
    async message(ws, raw) {
      if (ws.data.kind === "browser") return browser.receive(String(raw));
      const msg = JSON.parse(String(raw));
      if (msg.type === "chat") await chat(msg.text, msg.model, false, [], ws.data.fresh);
      else if (msg.type === "stop") await stop();
      else if (msg.type === "settings") {
        settings = { ...settings, ...msg.settings }; save();
        if ("lofi" in msg.settings) speech.send({ type: "config", lofi: settings.lofi });
        broadcast(state());
      }
      else if (msg.type === "liveview") { settings.liveView = !!msg.on; save(); if (!settings.liveView) await stopStream(); broadcast(state()); }
      else if (msg.type === "voice") setVoice(msg.mode);
      else if (msg.type === "history") ws.send(JSON.stringify({ type: "history", sessions: await history() }));
      else if (msg.type === "open") ws.send(JSON.stringify({ type: "messages", messages: await openSession(msg.id) }));
      else if (msg.type === "new") { session = undefined; broadcast(state()); }
    },
  },
});

await brain.start();
models = await listModels();
console.log(`jarvisd bereit: http://127.0.0.1:${PORT} · ${models.length} Modelle · Standard ${settings.model}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { brain.stop(); desktop.stop(); process.exit(0); });
