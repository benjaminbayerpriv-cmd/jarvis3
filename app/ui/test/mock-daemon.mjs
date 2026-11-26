// Mock-jarvisd nur für Tests der Backend-Einstellungen. Ersetzt core nicht: liefert die Oberfläche unter /app/ und spricht über /ui
// den Vertrag aus PR #63 (docs/protocol.md „Agenten-Backend“, geprüft gegen core/src/backend-config.ts und index.ts): Hermes-config
// {serverUrl, provider, model, modelBaseUrl, modelSupportsVision}, nur Hermes konfigurierbar, getrennte Schlüssel (target server|provider);
// bei fremdem Gateway werden Modellserver-Adresse und Anbieter-Schlüssel abgelehnt. Schlüssel werden nur im Speicher
// gehalten, nie zurückgesendet und nie protokolliert (redact). `legacy: true` verhält sich wie ein Daemon ohne Backend-Wechsel.
//   bun app/ui/test/mock-daemon.mjs [--port 7791] [--legacy]
import { join } from "node:path";
import { isManagedGateway, redact } from "../backends.js";

const UI = join(import.meta.dir, "..");

export function startMock({ port = 0, legacy = false, log = () => {} } = {}) {
  const store = {
    active: "opencode",
    backends: {
      opencode: { status: "ready", config: { provider: "opencode", model: "opencode/big-pickle", baseUrl: "" }, secret: null },
      claude: { status: "ready", config: { provider: "claude", model: "", files: "none" }, secret: null },
      codex: { status: "error", error: "Nicht angemeldet: im Terminal `codex login` ausführen.", config: { provider: "codex", model: "", files: "none" }, secret: null },
      hermes: { status: "ready", config: { provider: "default", model: "hermes-agent", serverUrl: "http://127.0.0.1:8642", modelBaseUrl: "", modelSupportsVision: false }, secret: null, providerSecret: null },
    },
  };
  const view = () => ({ type: "backend", active: store.active, backends: Object.fromEntries(Object.entries(store.backends).map(([id, b]) =>
    [id, { status: b.status, config: b.config, keySet: !!b.secret, ...(b.error ? { error: b.error } : {}), ...(id === "claude" || id === "codex" ? { loginManaged: true, providers: [] } : {}), ...(id === "hermes" ? { providerKeySet: !!b.providerSecret, externalGatewayManaged: isManagedGateway(b.config.serverUrl),
      providers: [{ id: "default", label: "Hermes-Standardanbieter", needsKey: false }, { id: "custom", label: "OpenAI-kompatibler Modellserver", needsKey: false }] } : {}) }])) });
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
            if (m.backend === "hermes" && !b.config.serverUrl) { ws.send(JSON.stringify({ type: "backend_saved", backend: "hermes", ok: false, error: "Hermes ist noch nicht eingerichtet" })); break; }
            store.active = m.backend; broadcast(view()); break;
          case "backend_config":
            if (!b || !m.config) return;
            if (m.backend === "claude" || m.backend === "codex") {
              const c = m.config ?? {};
              if (typeof c.model !== "string" || (c.model && !/^[\w][\w.:/\-\[\]]*$/.test(c.model)) || (c.files !== "none" && c.files !== "read")) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Modellname ungültig" })); break; }
              b.config = { provider: m.backend, model: c.model, files: c.files };
              ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: true })); broadcast(view()); break;
            }
            if (m.backend !== "hermes") { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Dieses Backend verwaltet seine Anbieter selbst" })); break; }
            const net = v => { try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) && !u.username && !u.password && !u.search && !u.hash; } catch { return false; } };
            if (!net(m.config.serverUrl)) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Hermes-Gateway-Adresse ungültig" })); break; }
            const mb = m.config.modelBaseUrl ?? b.config.modelBaseUrl;
            if (mb && !net(mb)) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Modellanbieter-Adresse ungültig" })); break; }
            if (mb && !isManagedGateway(m.config.serverUrl)) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Hermes: Bei externem Gateway muss der Modellanbieter dort konfiguriert werden; Modellserver-Adresse hier leer lassen." })); break; }
            b.config = { serverUrl: String(m.config.serverUrl).replace(/\/+$/, ""), provider: mb ? "custom" : String(m.config.provider ?? ""), model: String(m.config.model ?? ""), modelBaseUrl: String(mb ?? "").replace(/\/+$/, ""), modelSupportsVision: m.config.modelSupportsVision === true };
            b.status = "ready";
            ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: true })); broadcast(view()); break;
          case "backend_secret":
            if (!b) return;
            if (m.backend === "claude" || m.backend === "codex") { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: `${m.backend === "claude" ? "Claude Code" : "Codex"} meldet sich selbst an; Jarvis speichert dafür keine Schlüssel oder Passwörter` })); break; }
            if (m.backend !== "hermes") { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Dieses Backend hat hier keinen Server-Schlüssel" })); break; }
            if (m.target !== undefined && !["server", "provider"].includes(m.target)) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Ungültiger Schlüsseltyp" })); break; }
            if (m.target === "provider" && !isManagedGateway(b.config.serverUrl)) { ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: false, error: "Hermes: Der Modellanbieter-Schlüssel muss am externen Gateway eingerichtet werden." })); break; }
            { const v = m.apiKey === null ? null : String(m.apiKey || "") || null; if (m.target === "provider") b.providerSecret = v; else b.secret = v; }
            ws.send(JSON.stringify({ type: "backend_saved", backend: m.backend, ok: true })); broadcast(view()); break;
          case "backend_test": {
            if (!b) return;
            const ok = m.backend === "claude" || m.backend === "codex" ? b.status === "ready" : String(b.config.serverUrl ?? "").includes(`127.0.0.1:${server.port}`);
            setTimeout(() => ws.send(JSON.stringify({ type: "backend_test", backend: m.backend, ok, ...(ok ? { latencyMs: 42 } : { error: "Verbindung abgelehnt" }) })), 150);
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
