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

interface Settings { model: string; voiceModel: string; mode: "browser" | "computer"; lofi: boolean }
const defaults: Settings = { model: "opencode/big-pickle", voiceModel: "opencode/deepseek-v4.1-flash-free", mode: "browser", lofi: false };
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

const uis = new Set<ServerWebSocket<{ kind: string }>>();
const broadcast = (msg: unknown) => { const s = JSON.stringify(msg); for (const ui of uis) ui.send(s); };
const state = () => ({ type: "state", model: settings.model, voiceModel: settings.voiceModel, mode: settings.mode,
                       lofi: settings.lofi, busy, browser: browser.connected, speech: speech.connected, voice, models });

// ---------- Sprache ----------
let voice: "off" | "live" | "dictate" | "muted" = "off";
let splitter: SentenceSplitter | undefined;
const speech = new Speech(e => {
  if (e.type === "connected") { speech.send({ type: "config", lofi: settings.lofi }); if (voice !== "off") speech.mode(voice); broadcast(state()); return; }
  if (e.type === "disconnected") { broadcast(state()); return; }
  broadcast({ type: "speech", event: e.type, ...e });
  if (e.type === "speech_start" && busy && voice === "live") stop(); // Barge-in: Nutzer unterbricht
  if (e.type === "final" && voice === "live" && String(e.text ?? "").trim()) chat(String(e.text), settings.voiceModel, true);
});
function setVoice(mode: typeof voice) {
  voice = mode;
  speech.mode(mode);
  if (mode === "off") speech.stopSpeaking();
  broadcast(state());
}

// ---------- Verlauf (OpenCode-Sitzungen) ----------
async function history() {
  try {
    const list = await (await fetch(`${brain.url}/session`)).json() as any[];
    return list.filter(s => !s.parentID).sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .map(s => ({ id: s.id, title: s.title, active: s.id === session }));
  } catch { return []; }
}
async function openSession(id: string) {
  session = id;
  const msgs = await (await fetch(`${brain.url}/session/${id}/message`)).json() as any[];
  return msgs.map(m => ({ role: m.info?.role, text: (m.parts ?? []).filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text).join("") }))
    .filter(m => m.text);
}

async function chat(text: string, model = settings.model, spoken = false) {
  if (busy && session) await brain.abort(session);
  session ??= await brain.createSession();
  busy = true; broadcast(state());
  const started = performance.now();
  let first = true;
  splitter = spoken ? new SentenceSplitter() : undefined;
  const system = spoken ? SYSTEM_PROMPT + "\n\nDu bist gerade im Sprachmodus: antworte in höchstens zwei kurzen Sätzen, ohne Listen." : SYSTEM_PROMPT;
  await brain.prompt(session, text, model, system, (e: BrainEvent) => {
    if (splitter && e.kind === "text") for (const s of splitter.push(e.delta)) speech.say(s);
    if (splitter && e.kind === "done") { for (const s of splitter.flush()) speech.say(s); splitter = undefined; }
    if (e.kind === "text" && first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started) }); }
    if (e.kind === "done" || e.kind === "error") { busy = false; broadcast(state()); }
    broadcast(e.kind === "text" ? { type: "delta", text: e.delta } : e.kind === "reasoning" ? { type: "reasoning", text: e.delta }
      : { type: e.kind, ...e });
  });
}

async function stop() {
  stoppedUntil = Date.now() + 1500;
  splitter = undefined;
  speech.stopSpeaking();
  if (session) await brain.abort(session);
  busy = false; broadcast({ type: "stopped" }); broadcast(state());
}

async function runTool(target: string, cmd: Record<string, any>) {
  if (Date.now() < stoppedUntil) return { ok: false, error: "vom Nutzer gestoppt" };
  broadcast({ type: "action", target, cmd: cmd.cmd, detail: cmd.url ?? cmd.id ?? cmd.name ?? "" });
  if (target === "browser") return browser.call(cmd);
  if (settings.mode !== "computer" && !["scan", "read", "shot"].includes(cmd.cmd))
    return { ok: false, error: "Computer-Steuerung ist aus (Modus: nur Browser). Nutzer bitten, sie einzuschalten." };
  if (cmd.cmd === "open_app") {
    const p = process.platform === "win32" ? Bun.spawn(["cmd", "/c", "start", "", cmd.name]) : Bun.spawn(["open", "-a", cmd.name]);
    return { ok: (await p.exited) === 0 };
  }
  return desktop.call(cmd);
}

Bun.serve<{ kind: string }, {}>({
  port: PORT, hostname: "127.0.0.1",
  async fetch(req, srv) {
    const u = new URL(req.url);
    if (u.pathname === "/browser" || u.pathname === "/ui")
      return srv.upgrade(req, { data: { kind: u.pathname.slice(1) } }) ? undefined : new Response("upgrade", { status: 400 });
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
      else { uis.add(ws); ws.send(JSON.stringify(state())); history().then(s => ws.send(JSON.stringify({ type: "history", sessions: s }))); }
    },
    close(ws) {
      if (ws.data.kind === "browser") { browser.detach(ws); broadcast(state()); } else uis.delete(ws);
    },
    async message(ws, raw) {
      if (ws.data.kind === "browser") return browser.receive(String(raw));
      const msg = JSON.parse(String(raw));
      if (msg.type === "chat") await chat(msg.text, msg.model);
      else if (msg.type === "stop") await stop();
      else if (msg.type === "settings") {
        settings = { ...settings, ...msg.settings }; save();
        if ("lofi" in msg.settings) speech.send({ type: "config", lofi: settings.lofi });
        broadcast(state());
      }
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
