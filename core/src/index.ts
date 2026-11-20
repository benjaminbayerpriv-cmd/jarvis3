// jarvisd – Kern-Daemon. UI (Tauri) und Chrome-Erweiterung verbinden sich hierher.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { OpenCode, listModels, type ModelInfo, type BrainEvent } from "./opencode";
import { Desktop } from "./desktop";
import { Browser } from "./browser";
import { SYSTEM_PROMPT } from "./prompt";

const PORT = Number(process.env.JARVIS_PORT ?? 7777);
const HOME = join(homedir(), ".jarvis3");
const SETTINGS = join(HOME, "settings.json");
const ROOT = join(import.meta.dir, "../..");
mkdirSync(HOME, { recursive: true });

interface Settings { model: string; voiceModel?: string; mode: "browser" | "computer" }
const defaults: Settings = { model: "opencode/big-pickle", mode: "browser" };
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
const state = () => ({ type: "state", model: settings.model, mode: settings.mode, busy, browser: browser.connected,
                       models });

async function chat(text: string, model = settings.model) {
  if (busy && session) await brain.abort(session);
  session ??= await brain.createSession();
  busy = true; broadcast(state());
  const started = performance.now();
  let first = true;
  await brain.prompt(session, text, model, SYSTEM_PROMPT, (e: BrainEvent) => {
    if (e.kind === "text" && first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started) }); }
    if (e.kind === "done" || e.kind === "error") { busy = false; broadcast(state()); }
    broadcast(e.kind === "text" ? { type: "delta", text: e.delta } : e.kind === "reasoning" ? { type: "reasoning", text: e.delta }
      : { type: e.kind, ...e });
  });
}

async function stop() {
  stoppedUntil = Date.now() + 1500;
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
    if (u.pathname === "/health") return Response.json({ ok: true, opencode: await brain.healthy(), browser: browser.connected });
    if (u.pathname === "/models") return Response.json(models = await listModels());
    if (u.pathname === "/tool" && req.method === "POST") {
      const { target, cmd } = await req.json();
      return Response.json(await runTool(target, cmd));
    }
    if (u.pathname === "/chat" && req.method === "POST") { // für Tests ohne UI
      const { text, model } = await req.json(); await chat(text, model); return Response.json({ ok: true });
    }
    return new Response("jarvisd", { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind === "browser") { browser.attach(ws); broadcast(state()); }
      else { uis.add(ws); ws.send(JSON.stringify(state())); }
    },
    close(ws) {
      if (ws.data.kind === "browser") { browser.detach(ws); broadcast(state()); } else uis.delete(ws);
    },
    async message(ws, raw) {
      if (ws.data.kind === "browser") return browser.receive(String(raw));
      const msg = JSON.parse(String(raw));
      if (msg.type === "chat") await chat(msg.text, msg.model);
      else if (msg.type === "stop") await stop();
      else if (msg.type === "settings") { settings = { ...settings, ...msg.settings }; save(); broadcast(state()); }
      else if (msg.type === "new") { session = undefined; broadcast(state()); }
    },
  },
});

await brain.start();
models = await listModels();
console.log(`jarvisd bereit: http://127.0.0.1:${PORT} · ${models.length} Modelle · Standard ${settings.model}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { brain.stop(); desktop.stop(); process.exit(0); });
