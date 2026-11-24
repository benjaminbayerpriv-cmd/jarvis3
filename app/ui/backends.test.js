import { test, expect } from "bun:test";
import { BACKENDS, KEY_STORAGE_NOTE, configOf, isLoopbackIp, keyStatus, msgConfig, msgSecret, normalizeBackendState, redact, sameConfig, validateConfig } from "./backends.js";

test("Ohne Angaben ist OpenCode aktiv und Hermes als nicht unterstützt markiert", () => {
  const s = normalizeBackendState(undefined);
  expect(s.active).toBe("opencode");
  expect(s.backends.hermes.status).toBe("unsupported");
  expect(s.backends.hermes.keySet).toBe(false);
  expect(s.backends.hermes.providers).toEqual(BACKENDS.hermes.providers);
  expect(s.backends.opencode.configurable).toBe(false);
});

test("Echte Daemon-Nachricht (PR #63): serverUrl, provider, model getrennt; baseUrl wird nie Serveradresse", () => {
  const s = normalizeBackendState({ type: "backend", active: "hermes", backends: {
    opencode: { label: "OpenCode", status: "ready", config: { provider: "opencode", model: "x", baseUrl: "" }, keySet: true },
    hermes: { label: "Hermes", status: "ready", keySet: true, config: { provider: "default", model: "hermes-agent", serverUrl: "http://127.0.0.1:8642", baseUrl: "https://openrouter.ai/api/v1" },
      providers: [{ id: "default", label: "Hermes-Standardanbieter", needsKey: false }] } } });
  expect(s.backends.hermes.config).toEqual({ serverUrl: "http://127.0.0.1:8642", provider: "default", model: "hermes-agent" });
  expect(s.backends.hermes.keySet).toBe(true);
  expect(s.backends.opencode.keySet).toBe(false);                  // OpenCode hat hier keinen Schlüssel
  expect(s.backends.opencode.config.serverUrl).toBe("");
  const only = normalizeBackendState({ backends: { hermes: { status: "ready", config: { baseUrl: "http://10.0.0.5:11434/v1" } } } });
  expect(only.backends.hermes.config.serverUrl).toBe("");
  expect(normalizeBackendState({ active: "gibtsnicht" }).active).toBe("opencode");
  expect(normalizeBackendState({ backends: { hermes: { keySet: "ja" } } }).backends.hermes.keySet).toBe(false);
});

test("Loopback-IP: nur 127.x und ::1, keine Hostnamen", () => {
  expect(isLoopbackIp("127.0.0.1")).toBe(true);
  expect(isLoopbackIp("127.1.2.3")).toBe(true);
  expect(isLoopbackIp("[::1]")).toBe(true);
  for (const h of ["localhost", "192.168.1.5", "10.0.0.1", "127.0.0.300", "example.com", ""]) expect(isLoopbackIp(h)).toBe(false);
});

test("Prüfung: Serveradresse muss HTTP-Loopback-IP ohne Zugangsdaten sein", () => {
  const ok = { provider: "default", model: "hermes-agent", serverUrl: "http://127.0.0.1:8642" };
  expect(validateConfig(ok).valid).toBe(true);
  expect(validateConfig({ ...ok, serverUrl: "http://[::1]:8642" }).valid).toBe(true);
  expect(validateConfig({ provider: "", model: "", serverUrl: "" }).errors).toEqual({
    provider: "Modellanbieter wählen.", model: expect.stringContaining("Modell"), serverUrl: expect.stringContaining("Serveradresse") });
  for (const serverUrl of ["https://127.0.0.1:8642", "http://localhost:8642", "http://192.168.1.20:8642", "http://hermes.example.com", "ftp://127.0.0.1", "kein url"])
    expect(validateConfig({ ...ok, serverUrl }).valid).toBe(false);
  expect(validateConfig({ ...ok, serverUrl: "http://user:pw@127.0.0.1:8642" }).errors.serverUrl).toContain("Schlüsselfeld");
});

test("Nachrichten: Konfiguration trägt serverUrl/provider/model, nie einen Schlüssel; Schlüssel geht separat", () => {
  const m = msgConfig("hermes", { serverUrl: "http://127.0.0.1:8642/", provider: "default", model: " hermes-agent ", apiKey: "sk-geheim-1234567890abcd", baseUrl: "https://x" });
  expect(m).toEqual({ type: "backend_config", backend: "hermes", config: { serverUrl: "http://127.0.0.1:8642", provider: "default", model: "hermes-agent" } });
  expect(JSON.stringify(m)).not.toMatch(/geheim|baseUrl/);
  expect(msgSecret("hermes", "abc")).toEqual({ type: "backend_secret", backend: "hermes", apiKey: "abc" });
  expect(msgSecret("hermes", null).apiKey).toBeNull();
  expect(sameConfig({ serverUrl: "http://127.0.0.1:8642/", provider: "a", model: "b" }, { serverUrl: "http://127.0.0.1:8642", provider: "a", model: "b" })).toBe(true);
  expect(configOf({ serverUrl: "", provider: "a", model: "b", extra: 1 })).toEqual({ serverUrl: "", provider: "a", model: "b" });
});

test("Schlüsselhinweis nennt nur tatsächliche Eigenschaften: Dateirechte, nicht verschlüsselt, kein Windows", () => {
  expect(KEY_STORAGE_NOTE).toContain("Dateirechte");
  expect(KEY_STORAGE_NOTE).toContain("nicht verschlüsselt");
  expect(KEY_STORAGE_NOTE).toContain("Windows wird noch nicht unterstützt");
  expect(KEY_STORAGE_NOTE).not.toMatch(/(?<!nicht )verschlüsselt gespeichert|Schlüsselbund|Keychain/i);
  expect(keyStatus(true)).not.toMatch(/sk-|\d{4}/);
});

test("redact entfernt Schlüssel aus Objekten und Texten", () => {
  const out = redact({ type: "backend_secret", apiKey: "sk-or-v1-abcdefghijklmnop", nested: { token: "x", note: "Bearer abc.def.ghi und nvapi-abcdefghijklmnopqr" }, list: [{ authorization: "Basic xyz" }] });
  const json = JSON.stringify(out);
  expect(json).not.toContain("abcdefghijklmnop");
  expect(json).not.toContain("abc.def.ghi");
  expect(json).not.toContain("Basic xyz");
  expect(out.type).toBe("backend_secret");
});
