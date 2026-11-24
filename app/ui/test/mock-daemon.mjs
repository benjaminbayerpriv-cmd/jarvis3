// Mock-jarvisd nur für Tests der Backend-Einstellungen (ANNAHME-BACKEND, Formen siehe ../backends.js). Ersetzt core nicht:
// liefert die Oberfläche unter /app/ und spricht über /ui die vorgeschlagene Backend-Schnittstelle. Schlüssel werden nur im Speicher
// gehalten, nie zurückgesendet und nie protokolliert (redact). `legacy: true` verhält sich wie ein Daemon ohne Backend-Wechsel.
//   bun app/ui/test/mock-daemon.mjs [--port 7791] [--legacy]
import { join } from "node:path";
import { redact } from "../backends.js";

const UI = join(import.meta.dir, "..");

export function startMock({ port = 0, legacy = false, log = () => {} } = {}) {
  const store = {
    active: "opencode",
    backends: {
      opencode: { status: "ready", config: { provider: "opencode", model: "opencode/big-pickle", baseUrl: "" }, secret: null },
      hermes: { status: "unsupported", config: { provider: "", model: "", baseUrl: "" }, secret: null },
    },
  };
  const view = () => ({ type: "backend", active: store.active, backends: Object.fromEntries(Object.entries(store.backends).map(([id, b]) =>
    [id, { status: b.status, config: b.config, keySet: !!b.secret, ...(id === "hermes" ? { models: ["hermes-3-llama-3.1-70b", "hermes-4-405b"] } : {}) }])) });
  const sockets = new Set();
  const broadcast = m => { for (const s of sockets) s.send(JSON.stringify(m)); };

  const server = Bun.serve({
    port, hostname: "127.0.0.1",
    async fetch(req, srv) {
      const u = new URL(req.url);
      if (u.pathname === "/ui") return srv.upgrade(req, { data: {} }) ? undefined : new Response("upgrade", { status: 400 });
      if (u.pathname === "/health") return Response.json({ ok: true, opencode: true, browser: false });
      if (u.pathname === "/" || u.pathname === "/app") return Response.redirect(new URL("/app/", u), 302);
      if (u.pathname.startsWith("/app/")) {
        const file = Bun.file(join(UI, u.pathname.replace(/^\/app\/?/, "").replace(/\.\.+/g, "") || "index.html"));
        return (await file.exists()) ? new Response(file) : new Response("nicht gefunden", { status: 404 });
      }
      return new Response("mock", { status: 404 });
    },
    websocket: {
      open(ws) {
        sockets.add(ws);
        ws.send(JSON.stringify({ type: "state", model: "opencode/big-pickle", voiceModel: "opencode/big-pickle", mode: "browser", busy: false, busySessions: [], models: [], speech: false, voice: "off" }));
        ws.send(JSON.stringify({ type: "projects", projects: [], chats: [], root: "" })); ws.send(JSON.stringify({ type: "history", sessions: [], folders: [] }));
      },
      close(ws) { sockets.delete(ws); },
      message(ws, raw) {
        let m; try { m = JSON.parse(String(raw)); } catch { return; }
        if (!String(m.type).startsWith("backend") || legacy) { if (m.type !== "client_error") log("ignoriert", redact({ type: m.type })); return; }
        log("empfangen", redact(m));
        const b = store.backends[m.backend];
        switch (m.type) {
          case "backend_get": ws.send(JSON.stringify(view())); break;
          case "backend_set":
            if (!b) return;
            if (!b.config.provider && m.backend === "hermes") { ws.send(JSON.stringify({ type: "backend_saved", backend: "hermes", ok: false, error: "Hermes ist noch nicht eingerichtet" })); break; }
            store.active = m.backend; broadcast(view()); break;
          case "backend_config":
            if (!b || !m.config) return;
            b.config = { provider: String(m.config.provider ?? ""), model: String(m.config.model ?? ""), baseUrl: String(m.config.baseUrl ?? "") };
            b.status = "ready";
            ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: true })); broadcast(view()); break;
          case "backend_secret":
            if (!b) return;
            b.secret = m.apiKey === null ? null : String(m.apiKey || "") || null;
            ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: true })); broadcast(view()); break;
          case "backend_test": {
            if (!b) return;
            const url = b.config.baseUrl;
            const ok = url.includes(`127.0.0.1:${server.port}`) || b.config.provider === "opencode";
            setTimeout(() => ws.send(JSON.stringify({ type: "backend_test", backend: m.backend, ok, latencyMs: 42, ...(ok ? { models: ["modell-a", "modell-b"] } : { error: "Verbindung abgelehnt" }) })), 150);
            break;
          }
        }
      },
    },
  });
  return { server, port: server.port, stop: () => server.stop(true), store };
}

if (import.meta.main) {
  const arg = n => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const m = startMock({ port: Number(arg("--port") ?? 7791), legacy: process.argv.includes("--legacy"), log: (...a) => console.log("[mock]", ...a.map(x => (typeof x === "string" ? x : JSON.stringify(x)))) });
  console.log(`mock-jarvisd: http://127.0.0.1:${m.port}/app/${process.argv.includes("--legacy") ? " (legacy: ohne Backend-Wechsel)" : ""}`);
}
