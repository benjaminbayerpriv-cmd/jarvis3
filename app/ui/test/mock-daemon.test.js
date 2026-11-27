import { test, expect } from "bun:test";
import { startMock } from "./mock-daemon.mjs";
import { msgConfig, msgGet, msgSecret, msgSet, msgTest } from "../backends.js";

const talk = async (port, sends, wait) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ui`);
  const got = [];
  ws.onmessage = e => got.push(JSON.parse(e.data));
  await new Promise(r => (ws.onopen = r));
  for (const m of sends) { ws.send(JSON.stringify(m)); await Bun.sleep(40); }
  await Bun.sleep(wait);
  ws.close();
  return got;
};

test("Schnittstelle: Zustand, Speichern, Schlüssel bleibt verborgen, Test, Wechsel", async () => {
  const lines = [];
  const mock = startMock({ log: (...a) => lines.push(JSON.stringify(a)) });
  try {
    const key = "sk-or-v1-SEHR-GEHEIM-0123456789abcdef";
    const got = await talk(mock.port, [
      msgGet(),
      msgConfig("hermes", { serverUrl: `http://127.0.0.1:${mock.port}`, provider: "custom", model: "hermes-3", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true }),
      msgSecret("hermes", key, "server"),
      msgSecret("hermes", key + "-anbieter", "provider"),
      msgTest("hermes"),
      msgSet("hermes"),
    ], 400);
    const state = got.filter(m => m.type === "backend").at(-1);
    expect(state.active).toBe("hermes");
    expect(state.backends.opencode.config.provider).toBe("opencode");            // OpenCode bleibt Standard, bis gewechselt wird
    expect(state.backends.hermes.keySet).toBe(true);
    expect(state.backends.hermes.config).toEqual({ serverUrl: `http://127.0.0.1:${mock.port}`, provider: "custom", model: "hermes-3", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true });
    expect(state.backends.hermes.providerKeySet).toBe(true);
    expect(JSON.stringify(got)).not.toContain("GEHEIM");                          // der Schlüssel kommt nie zurück
    expect(lines.join("\n")).not.toContain("GEHEIM");                             // und wird nie protokolliert
    expect(got.some(m => m.type === "backend_saved" && m.ok)).toBe(true);
    const t = got.find(m => m.type === "backend_test");
    expect(t).toMatchObject({ backend: "hermes", ok: true });
    const bad = await talk(mock.port, [msgConfig("hermes", { serverUrl: "ftp://x", provider: "default", model: "hermes-agent" }), msgConfig("opencode", { serverUrl: "", provider: "x", model: "y" }), msgSecret("opencode", "abc")], 200);
    expect(bad.filter(m => m.type === "backend_saved").map(m => m.ok)).toEqual([false, false, false]);   // nur Hermes, nur http(s)
    // fremdes Gateway im Heimnetz: Gateway-Adresse gültig, aber Modellserver-Adresse und Anbieter-Schlüssel werden dort abgelehnt
    const ext = await talk(mock.port, [
      msgConfig("hermes", { serverUrl: "http://192.168.1.30:8642", provider: "custom", model: "m", modelBaseUrl: "http://192.168.1.20:1234/v1" }),
      msgConfig("hermes", { serverUrl: "http://192.168.1.30:8642", provider: "default", model: "m", modelBaseUrl: "" }),
      msgSecret("hermes", "anbieter-geheim", "provider"),
      msgSecret("hermes", "x", "unbekannt"),
      msgGet()], 300);
    expect(ext.filter(m => m.type === "backend_saved").map(m => m.ok)).toEqual([false, true, false, false]);
    expect(ext.filter(m => m.type === "backend").at(-1).backends.hermes).toMatchObject({ externalGatewayManaged: false, config: { serverUrl: "http://192.168.1.30:8642", modelBaseUrl: "" } });
    const removed = await talk(mock.port, [msgConfig("hermes", { serverUrl: `http://127.0.0.1:${mock.port}`, provider: "default", model: "hermes-agent" }), msgSecret("hermes", null, "server"), msgSecret("hermes", null, "provider"), msgGet()], 200);
    expect(removed.filter(m => m.type === "backend").at(-1).backends.hermes).toMatchObject({ keySet: false, providerKeySet: false });
  } finally { mock.stop(); }
});

test("Wechsel zu einem nicht eingerichteten Hermes wird abgelehnt, legacy ignoriert alles", async () => {
  const mock = startMock();
  mock.store.backends.hermes.config.serverUrl = "";
  const legacy = startMock({ legacy: true });
  try {
    const got = await talk(mock.port, [msgGet(), msgSet("hermes")], 250);
    expect(got.some(m => m.type === "backend_saved" && m.ok === false)).toBe(true);
    expect(got.filter(m => m.type === "backend").at(-1).active).toBe("opencode");
    const old = await talk(legacy.port, [msgGet(), msgSet("hermes")], 250);
    expect(old.some(m => String(m.type).startsWith("backend"))).toBe(false);        // wie ein Daemon ohne die Schnittstelle
  } finally { mock.stop(); legacy.stop(); }
});

test("Claude Code und Codex: Einstellungen speichern, ungültig ablehnen, Schlüssel ablehnen, Anmeldung prüfen", async () => {
  const mock = startMock();
  try {
    const got = await talk(mock.port, [
      msgGet(),
      msgConfig("claude", { model: "sonnet", files: "read", effort: "high", adopt: true }),
      msgConfig("claude", { model: "a b", files: "read" }),
      msgSecret("claude", "geheim-123456789", "server"),
      msgTest("claude"), msgTest("codex"),
      msgSet("claude"), msgGet(),
    ], 600);
    const saved = got.filter(m => m.type === "backend_saved");
    expect(saved.map(m => m.ok)).toEqual([true, false, false]);
    expect(saved[2].error).toContain("meldet sich selbst an");
    const state = got.filter(m => m.type === "backend").at(-1);
    expect(state.active).toBe("claude");
    expect(state.backends.claude).toMatchObject({ status: "ready", loginManaged: true, keySet: false, config: { provider: "claude", model: "sonnet", files: "read", effort: "high", adopt: true }, installed: { skills: 124, plugins: 1 }, efforts: expect.arrayContaining(["high"]) });
    expect(state.backends.claude.models.map(x => x.id)).toContain("claude-opus-5-5");
    expect(state.backends.codex).toMatchObject({ status: "error", error: expect.stringContaining("codex login") });
    const tests = got.filter(m => m.type === "backend_test");
    expect(tests.find(m => m.backend === "claude").ok).toBe(true);
    expect(tests.find(m => m.backend === "codex").ok).toBe(false);
    expect(JSON.stringify(got)).not.toContain("geheim-123");
  } finally { mock.stop(); }
});

test("Limits: der Daemon liefert beide Programme, ohne Modellaufruf, alte Daemons schweigen", async () => {
  const mock = startMock(), legacy = startMock({ legacy: true });
  try {
    const got = await talk(mock.port, [{ type: "limits_get" }], 200);
    const l = got.find(m => m.type === "limits").limits;
    expect(l.claude.windows).toHaveLength(2); expect(l.codex.plan).toBe("plus");
    expect((await talk(legacy.port, [{ type: "limits_get" }], 200)).some(m => m.type === "limits")).toBe(false);
  } finally { mock.stop(); legacy.stop(); }
});

test("App-Name: der Daemon übernimmt den gültigen Namen und meldet ihn im Zustand", async () => {
  const mock = startMock();
  try {
    const got = await talk(mock.port, [{ type: "settings", settings: { appName: "  Hugo  " } }, { type: "settings", settings: { appName: "x".repeat(30) } }], 250);
    const states = got.filter(m => m.type === "state");
    expect(states[0].appName).toBe("Jarvis");                       // Standard
    expect(states.at(-1).appName).toBe("Hugo");                     // zu lange Namen werden abgelehnt
  } finally { mock.stop(); }
});

test("Logo: hochladen, Zustand zeigt es, entfernen; ungültige Daten werden abgelehnt", async () => {
  const mock = startMock();
  try {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
    expect((await fetch(`http://127.0.0.1:${mock.port}/logo`)).status).toBe(404);            // Standard: kein Logo
    const got = await talk(mock.port, [{ type: "logo_set", data: "R0lGODlh" }, { type: "logo_set", data: png }, { type: "logo_clear", none: true }, { type: "logo_clear" }], 300);
    expect(got.filter(m => m.type === "logo_saved").map(m => m.ok)).toEqual([false, true, true, true]);
    const states = got.filter(m => m.type === "state").map(m => m.logo);
    expect(states[0]).toBe(0); expect(states.at(-3)).toBeGreaterThan(0); expect(states.at(-2)).toBe(-1); expect(states.at(-1)).toBe(0);   // eigenes Logo, ausdrücklich keins, Standard
  } finally { mock.stop(); }
});
