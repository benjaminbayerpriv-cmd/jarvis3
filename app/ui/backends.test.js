import { test, expect } from "bun:test";
import { BACKENDS, classifyHost, configOf, keyStatus, msgConfig, msgSecret, normalizeBackendState, redact, sameConfig, validateConfig } from "./backends.js";

test("Ohne Angaben ist OpenCode aktiv (Standard) und Hermes als nicht unterstützt markiert", () => {
  const s = normalizeBackendState(undefined);
  expect(s.active).toBe("opencode");
  expect(s.backends.opencode.status).toBe("unsupported");
  expect(s.backends.hermes.keySet).toBe(false);
  expect(s.backends.hermes.providers).toEqual(BACKENDS.hermes.providers);
});

test("Zustand wird tolerant gelesen, unbekannte Werte fallen auf sichere Standards", () => {
  const s = normalizeBackendState({ active: "hermes", backends: {
    hermes: { status: "ready", config: { provider: "local", model: " hermes-3 ", baseUrl: "http://192.168.1.20:11434/v1" }, keySet: true, models: ["a", { id: "b", label: "B" }, { nope: 1 }] },
    opencode: { status: "kaputt", config: null } } });
  expect(s.active).toBe("hermes");
  expect(s.backends.hermes.config.model).toBe("hermes-3");
  expect(s.backends.hermes.keySet).toBe(true);
  expect(s.backends.hermes.models).toEqual([{ id: "a", label: "a" }, { id: "b", label: "B" }]);
  expect(s.backends.opencode.status).toBe("ready");
  expect(normalizeBackendState({ active: "gibtsnicht" }).active).toBe("opencode");
  expect(normalizeBackendState({ backends: { hermes: { keySet: "ja" } } }).backends.hermes.keySet).toBe(false);   // nur echtes true zählt
});

test("Adressen: lokal, Heimnetz oder extern", () => {
  expect(classifyHost("localhost")).toBe("lokal");
  expect(classifyHost("127.0.0.1")).toBe("lokal");
  expect(classifyHost("[::1]")).toBe("lokal");
  expect(classifyHost("192.168.178.20")).toBe("heimnetz");
  expect(classifyHost("172.20.1.5")).toBe("heimnetz");
  expect(classifyHost("172.40.1.5")).toBe("extern");
  expect(classifyHost("benjaminspc.fritz.box")).toBe("heimnetz");
  expect(classifyHost("mac-mini")).toBe("heimnetz");
  expect(classifyHost("openrouter.ai")).toBe("extern");
});

test("Prüfung: Pflichtfelder, Adresse, Warnung bei unverschlüsseltem Internet, keine Zugangsdaten in der Adresse", () => {
  expect(validateConfig("hermes", { provider: "", model: "", baseUrl: "" }).errors).toEqual({ provider: "Anbieter wählen.", model: "Modell eintragen." });
  const ok = validateConfig("hermes", { provider: "local", model: "hermes-3", baseUrl: "http://192.168.1.20:11434/v1" });
  expect(ok.valid).toBe(true);
  expect(ok.hints.network).toBe("heimnetz");
  expect(validateConfig("hermes", { provider: "custom", model: "m", baseUrl: "ftp://x" }).errors.baseUrl).toContain("http");
  expect(validateConfig("hermes", { provider: "custom", model: "m", baseUrl: "kein url" }).valid).toBe(false);
  expect(validateConfig("hermes", { provider: "custom", model: "m", baseUrl: "http://api.example.com/v1" }).hints.baseUrl).toContain("Unverschlüsselt");
  expect(validateConfig("hermes", { provider: "custom", model: "m", baseUrl: "https://user:pw@api.example.com" }).errors.baseUrl).toContain("Schlüsselfeld");
  expect(validateConfig("hermes", { provider: "local", model: "m", baseUrl: "" }).errors.baseUrl).toContain("lokalen");   // lokaler Anbieter braucht eine Adresse
  expect(validateConfig("hermes", { provider: "nous", model: "m", baseUrl: "" }).hints.apiKey).toContain("Schlüssel");
  expect(validateConfig("hermes", { provider: "nous", model: "m", baseUrl: "" }, { keySet: true }).hints.apiKey).toBeUndefined();
});

test("Nachrichten: Einstellungen tragen nie einen Schlüssel, der Schlüssel geht separat und wird nie angezeigt", () => {
  const m = msgConfig("hermes", { provider: "nous", model: " m ", baseUrl: "https://x.test/v1/", apiKey: "sk-geheim-1234567890abcd" });
  expect(m).toEqual({ type: "backend_config", backend: "hermes", config: { provider: "nous", model: "m", baseUrl: "https://x.test/v1" } });
  expect(JSON.stringify(m)).not.toContain("geheim");
  expect(msgSecret("hermes", "abc")).toEqual({ type: "backend_secret", backend: "hermes", apiKey: "abc" });
  expect(msgSecret("hermes", null).apiKey).toBeNull();
  expect(keyStatus(true)).not.toMatch(/sk-|\d{4}/);
  expect(sameConfig({ provider: "a", model: "b", baseUrl: "http://x/" }, { provider: "a", model: "b", baseUrl: "http://x" })).toBe(true);
  expect(configOf({ provider: "a", model: "b", baseUrl: "", extra: 1 })).toEqual({ provider: "a", model: "b", baseUrl: "" });
});

test("redact entfernt Schlüssel aus Objekten und Texten", () => {
  const out = redact({ type: "backend_secret", apiKey: "sk-or-v1-abcdefghijklmnop", nested: { token: "x", note: "Bearer abc.def.ghi und nvapi-abcdefghijklmnopqr" }, list: [{ authorization: "Basic xyz" }] });
  const json = JSON.stringify(out);
  expect(json).not.toContain("abcdefghijklmnop");
  expect(json).not.toContain("abc.def.ghi");
  expect(json).not.toContain("Basic xyz");
  expect(out.type).toBe("backend_secret");
});
