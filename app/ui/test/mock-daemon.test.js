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
