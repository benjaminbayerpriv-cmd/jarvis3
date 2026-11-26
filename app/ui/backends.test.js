import { test, expect } from "bun:test";
import { BACKENDS, BACKEND_IDS, CLI_FILES, KEY_STORAGE_NOTE, PROVIDER_KEY_NOTE, classifyHost, isManagedGateway, keyStatus, parseNetworkUrl, cliConfigOf, isCliBackend, msgConfig, msgSecret, normalizeBackendState, redact, sameCliConfig, sameConfig, validateCliConfig, validateConfig } from "./backends.js";

test("Ohne Angaben ist OpenCode aktiv und Hermes als nicht unterstützt markiert", () => {
  const s = normalizeBackendState(undefined);
  expect(s.active).toBe("opencode");
  expect(s.backends.hermes.status).toBe("unsupported");
  expect(s.backends.hermes.keySet).toBe(false);
  expect(s.backends.hermes.providers).toEqual(BACKENDS.hermes.providers);
  expect(s.backends.opencode.configurable).toBe(false);
});

test("Echte Daemon-Nachricht (PR #63): Gateway, Modellserver und beide Schlüssel getrennt; baseUrl wird nie Serveradresse", () => {
  const s = normalizeBackendState({ type: "backend", active: "hermes", backends: {
    opencode: { label: "OpenCode", status: "ready", config: { provider: "opencode", model: "x", baseUrl: "" }, keySet: true },
    hermes: { label: "Hermes", status: "ready", keySet: true, providerKeySet: true, externalGatewayManaged: true,
      config: { provider: "custom", model: "qwen", serverUrl: "http://127.0.0.1:8642", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true, baseUrl: "https://openrouter.ai/api/v1" },
      providers: [{ id: "default", label: "Hermes-Standardanbieter", needsKey: false }, { id: "custom", label: "OpenAI-kompatibler Modellserver", needsKey: false }] } } });
  expect(s.backends.hermes.config).toEqual({ serverUrl: "http://127.0.0.1:8642", provider: "custom", model: "qwen", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true });
  expect(s.backends.hermes.keySet).toBe(true);
  expect(s.backends.hermes.providerKeySet).toBe(true);
  expect(s.backends.opencode.keySet).toBe(false);
  expect(s.backends.opencode.providerKeySet).toBe(false);
  const only = normalizeBackendState({ backends: { hermes: { status: "ready", config: { baseUrl: "http://10.0.0.5:11434/v1" } } } });
  expect(only.backends.hermes.config.serverUrl).toBe("");
  expect(only.backends.hermes.config.modelBaseUrl).toBe("");
  expect(normalizeBackendState({ backends: { hermes: { externalGatewayManaged: false } } }).backends.hermes.externalGatewayManaged).toBe(false);
  expect(normalizeBackendState({ active: "gibtsnicht" }).active).toBe("opencode");
  expect(normalizeBackendState({ backends: { hermes: { keySet: "ja", providerKeySet: 1 } } }).backends.hermes).toMatchObject({ keySet: false, providerKeySet: false });
});

test("Verwaltetes Gateway wie im Daemon: http auf 127.0.0.1, [::1] oder localhost, Pfad „/“", () => {
  for (const u of ["http://127.0.0.1:8642", "http://[::1]:8642", "http://localhost:8642", "http://127.0.0.1:8642/"]) expect(isManagedGateway(u)).toBe(true);
  for (const u of ["https://127.0.0.1:8642", "http://192.168.1.5:8642", "http://127.0.0.1:8642/v1", "kein url", "http://hermes.example.com"]) expect(isManagedGateway(u)).toBe(false);
});

test("Netzwerkadressen: lokal, Heimnetz, extern", () => {
  expect(classifyHost("localhost")).toBe("lokal");
  expect(classifyHost("[::1]")).toBe("lokal");
  expect(classifyHost("192.168.178.20")).toBe("heimnetz");
  expect(classifyHost("benjaminspc.fritz.box")).toBe("heimnetz");
  expect(classifyHost("172.40.1.5")).toBe("extern");
  expect(classifyHost("openrouter.ai")).toBe("extern");
});

test("Adressprüfung wie im Daemon: http(s), keine Zugangsdaten, keine Query, höchstens 300 Zeichen", () => {
  expect(parseNetworkUrl("http://192.168.1.20:1234/v1", "Modellserver-Adresse").url.hostname).toBe("192.168.1.20");
  for (const bad of ["ftp://x", "kein url", "http://u:p@h", "http://h/?a=1", "http://h/#x", "http://h/" + "a".repeat(300)]) expect(parseNetworkUrl(bad, "Serveradresse").error).toBeTruthy();
});

test("Prüfung: verwaltetes Gateway mit Modellserver im Heimnetz ist gültig", () => {
  const base = { serverUrl: "http://127.0.0.1:8642", provider: "custom", model: "qwen", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: false };
  const ok = validateConfig(base);
  expect(ok.valid).toBe(true);
  expect(ok.managed).toBe(true);
  expect(ok.hints.modelNetwork).toBe("heimnetz");
  expect(ok.hints.modelBaseUrl).toContain("Heimnetz");
  expect(validateConfig({ ...base, modelBaseUrl: "" }).valid).toBe(true);                       // Modellserver ist optional
  expect(validateConfig({ ...base, modelBaseUrl: "https://llm.example.com/v1" }).hints.modelBaseUrl).toContain("Internet");
  expect(validateConfig({ ...base, modelBaseUrl: "http://llm.example.com/v1" }).hints.modelBaseUrl).toContain("Unverschlüsselt");
});

test("Prüfung: fremdes Gateway im Netzwerk erlaubt, aber ohne Modellserver-Adresse", () => {
  const ext = { serverUrl: "http://192.168.1.30:8642", provider: "default", model: "hermes-agent", modelBaseUrl: "", modelSupportsVision: false };
  const ok = validateConfig(ext);
  expect(ok.valid).toBe(true);
  expect(ok.managed).toBe(false);
  expect(ok.hints.serverUrl).toContain("Fremdes Gateway");
  expect(validateConfig({ ...ext, serverUrl: "https://hermes.example.com" }).valid).toBe(true);
  expect(validateConfig({ ...ext, serverUrl: "http://hermes.example.com" }).hints.serverUrl).toContain("Unverschlüsselt");
  expect(validateConfig({ ...ext, modelBaseUrl: "http://192.168.1.20:1234/v1" }).errors.modelBaseUrl).toContain("fremden Gateway");
});

test("Prüfung: Pflichtfelder und ungültige Adressen", () => {
  const e = validateConfig({ provider: "", model: "", serverUrl: "", modelBaseUrl: "" }).errors;
  expect(e).toEqual({ provider: "Modellanbieter wählen.", model: expect.stringContaining("Modell"), serverUrl: expect.stringContaining("Serveradresse") });
  expect(validateConfig({ provider: "default", model: "m", serverUrl: "http://user:pw@127.0.0.1:8642" }).errors.serverUrl).toContain("Schlüsselfelder");
  expect(validateConfig({ provider: "default", model: "m", serverUrl: "http://127.0.0.1:8642", modelBaseUrl: "ftp://x" }).errors.modelBaseUrl).toBeTruthy();
  expect(validateConfig({ provider: "bad provider!", model: "m", serverUrl: "http://127.0.0.1:8642" }).errors.provider).toBeTruthy();
});

test("Nachrichten: Konfiguration trägt Gateway, Anbieter, Modell, Modellserver und Bildfähigkeit, nie einen Schlüssel; Schlüssel getrennt je target", () => {
  const m = msgConfig("hermes", { serverUrl: "http://127.0.0.1:8642/", provider: "custom", model: " qwen ", modelBaseUrl: "http://192.168.1.20:1234/v1/", modelSupportsVision: true, apiKey: "sk-geheim-1234567890abcd", baseUrl: "https://x" });
  expect(m).toEqual({ type: "backend_config", backend: "hermes", config: { serverUrl: "http://127.0.0.1:8642", provider: "custom", model: "qwen", modelBaseUrl: "http://192.168.1.20:1234/v1", modelSupportsVision: true } });
  expect(JSON.stringify(m)).not.toMatch(/geheim|baseUrl"/);
  expect(msgConfig("hermes", { serverUrl: "http://127.0.0.1:8642", provider: "default", model: "m" }).config).toMatchObject({ modelBaseUrl: "", modelSupportsVision: false });   // "" löscht die Adresse im Daemon
  expect(msgSecret("hermes", "abc")).toEqual({ type: "backend_secret", backend: "hermes", target: "server", apiKey: "abc" });
  expect(msgSecret("hermes", "abc", "provider")).toEqual({ type: "backend_secret", backend: "hermes", target: "provider", apiKey: "abc" });
  expect(msgSecret("hermes", null, "provider").apiKey).toBeNull();
  expect(sameConfig({ serverUrl: "http://127.0.0.1:8642/", provider: "a", model: "b", modelBaseUrl: "http://h/v1/", modelSupportsVision: false }, { serverUrl: "http://127.0.0.1:8642", provider: "a", model: "b", modelBaseUrl: "http://h/v1", modelSupportsVision: false })).toBe(true);
  expect(sameConfig({ provider: "a", model: "b", serverUrl: "", modelSupportsVision: true }, { provider: "a", model: "b", serverUrl: "" })).toBe(false);
});

test("Schlüsselhinweis nennt nur tatsächliche Eigenschaften: Dateirechte, nicht verschlüsselt, kein Windows", () => {
  expect(KEY_STORAGE_NOTE).toContain("Dateirechte");
  expect(KEY_STORAGE_NOTE).toContain("nicht verschlüsselt");
  expect(KEY_STORAGE_NOTE).toContain("Windows wird noch nicht unterstützt");
  expect(KEY_STORAGE_NOTE).not.toMatch(/(?<!nicht )verschlüsselt gespeichert|Schlüsselbund|Keychain/i);
  expect(PROVIDER_KEY_NOTE).toContain("nicht verschlüsselt");
  expect(PROVIDER_KEY_NOTE).toContain("Umgebungsvariable");
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

test("Vier Backends: OpenCode, Hermes, Claude Code, Codex; die beiden Programme sind keine Schlüssel-Backends", () => {
  expect(Object.keys(BACKENDS)).toEqual(["opencode", "hermes", "claude", "codex"]);
  expect(isCliBackend("claude")).toBe(true); expect(isCliBackend("codex")).toBe(true);
  expect(isCliBackend("hermes")).toBe(false); expect(isCliBackend("opencode")).toBe(false);
  expect(BACKENDS.claude.loginHint).toContain("claude"); expect(BACKENDS.codex.loginHint).toContain("codex login");
  for (const id of ["claude", "codex"]) expect(BACKENDS[id].tagline).toContain("Jarvis speichert dafür nichts");
});

test("Zustand von Claude Code und Codex: Anmeldung über das Programm, Fehlertext, kein Schlüsselstatus", () => {
  const s = normalizeBackendState({ active: "claude", backends: {
    claude: { label: "Claude Code", status: "ready", loginManaged: true, keySet: true, config: { provider: "claude", model: "sonnet", files: "read", serverUrl: "http://evil" } },
    codex: { label: "Codex", status: "error", error: "Nicht angemeldet: im Terminal `codex login` ausführen.", config: { provider: "codex", model: "", files: "bogus" } } } });
  expect(s.active).toBe("claude");
  expect(s.backends.claude.config).toEqual({ provider: "claude", model: "sonnet", files: "read" });
  expect(s.backends.claude.keySet).toBe(false);                       // diese Backends haben hier nie einen Schlüssel
  expect(s.backends.claude.loginManaged).toBe(true);
  expect(s.backends.codex.config.files).toBe("none");                 // unbekannte Werte fallen auf den sicheren Standard
  expect(s.backends.codex.status).toBe("error"); expect(s.backends.codex.error).toContain("codex login");
  expect(normalizeBackendState({ active: "codex" }).active).toBe("codex");
  expect(normalizeBackendState({}).backends.claude.status).toBe("unsupported");   // ältere Daemons kennen sie nicht
  expect(normalizeBackendState({}).backends.hermes.loginManaged).toBe(false);
});

test("Prüfung und Nachricht für Claude Code/Codex: Modellname, Dateizugriff, nur model und files", () => {
  expect(validateCliConfig({ model: "", files: "none" }).valid).toBe(true);
  expect(validateCliConfig({ model: "claude-sonnet-5-5", files: "read" }).valid).toBe(true);
  expect(validateCliConfig({ model: "gpt-5.5-codex", files: "none" }).valid).toBe(true);
  for (const model of ["a b", "--evil", "x".repeat(101), "modell;rm", "$(x)"]) expect(validateCliConfig({ model, files: "none" }).errors.model).toBeTruthy();
  expect(validateCliConfig({ model: "", files: "write" }).errors.files).toBeTruthy();
  expect(CLI_FILES.map(o => o.id)).toEqual(["none", "read"]);
  const m = msgConfig("claude", { model: " sonnet ", files: "read", serverUrl: "http://x", apiKey: "sk-geheim-1234567890abcd", provider: "claude" });
  expect(m).toEqual({ type: "backend_config", backend: "claude", config: { model: "sonnet", files: "read" } });
  expect(JSON.stringify(m)).not.toMatch(/geheim|serverUrl/);
  expect(cliConfigOf({ model: "m", files: "x" })).toEqual({ model: "m", files: "none" });
  expect(sameCliConfig({ model: "a", files: "read" }, { model: "a", files: "read" })).toBe(true);
  expect(sameCliConfig({ model: "a", files: "read" }, { model: "a", files: "none" })).toBe(false);
});
