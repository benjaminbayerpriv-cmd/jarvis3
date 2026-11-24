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
      msgConfig("hermes", { provider: "local", model: "hermes-3", baseUrl: `http://127.0.0.1:${mock.port}/v1` }),
      msgSecret("hermes", key),
      msgTest("hermes"),
      msgSet("hermes"),
    ], 400);
    const state = got.filter(m => m.type === "backend").at(-1);
    expect(state.active).toBe("hermes");
    expect(state.backends.opencode.config.provider).toBe("opencode");            // OpenCode bleibt Standard, bis gewechselt wird
    expect(state.backends.hermes.keySet).toBe(true);
    expect(JSON.stringify(got)).not.toContain("GEHEIM");                          // der Schlüssel kommt nie zurück
    expect(lines.join("\n")).not.toContain("GEHEIM");                             // und wird nie protokolliert
    expect(got.some(m => m.type === "backend_saved" && m.ok)).toBe(true);
    const t = got.find(m => m.type === "backend_test");
    expect(t).toMatchObject({ backend: "hermes", ok: true });
    const removed = await talk(mock.port, [msgSecret("hermes", null), msgGet()], 200);
    expect(removed.filter(m => m.type === "backend").at(-1).backends.hermes.keySet).toBe(false);
  } finally { mock.stop(); }
});

test("Wechsel zu einem nicht eingerichteten Hermes wird abgelehnt, legacy ignoriert alles", async () => {
  const mock = startMock();
  const legacy = startMock({ legacy: true });
  try {
    const got = await talk(mock.port, [msgGet(), msgSet("hermes")], 250);
    expect(got.some(m => m.type === "backend_saved" && m.ok === false)).toBe(true);
    expect(got.filter(m => m.type === "backend").at(-1).active).toBe("opencode");
    const old = await talk(legacy.port, [msgGet(), msgSet("hermes")], 250);
    expect(old.some(m => String(m.type).startsWith("backend"))).toBe(false);        // wie ein Daemon ohne die Schnittstelle
  } finally { mock.stop(); legacy.stop(); }
});
