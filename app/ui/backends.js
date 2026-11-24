// Backend-Wechsel (OpenCode / Hermes): reine Logik der Oberfläche, ohne DOM, damit sie sich testen lässt (backends.test.js).
//
// Vertrag: docs/protocol.md im Zweig von PR #63 („Agenten-Backend: OpenCode und Hermes“), Stand der Abstimmung siehe docs/backend-ui.md.
//
//   UI → jarvisd
//     {type:"backend_get"}                                                        Zustand anfordern
//     {type:"backend_set", backend:"opencode"|"hermes"}                           Backend für NEUE Chats wählen
//     {type:"backend_config", backend:"hermes", config:{serverUrl, provider, model}}   nur Hermes; nie ein Schlüssel
//     {type:"backend_secret", backend:"hermes", apiKey:string|null}               Schlüssel des Hermes-SERVERS (null = entfernen)
//     {type:"backend_test", backend:"hermes"}                                     gespeicherten Zugang prüfen
//   jarvisd → UI
//     {type:"backend", active, backends:{<id>:{label?, status, error?, config, keySet, providers?}}}
//         Hermes-config: {serverUrl, provider, model}; OpenCode-config: {provider, model, baseUrl} nur zur Anzeige
//         keySet: nur Ja/Nein, der Schlüssel verlässt den Daemon nie
//     {type:"backend_saved", backend, ok, error?}
//     {type:"backend_test", backend, ok, error?, latencyMs?}
//
// Begriffe: `serverUrl` und der Server-Schlüssel gehören zum Hermes-Gateway. `provider`/`model` wählen einen in HERMES eingerichteten
// Modellanbieter; dessen Adresse und Schlüssel werden hier nicht gespeichert. OpenCode verwaltet seine Anbieter selbst.
// Schlüsselablage (tatsächlicher Stand): ~/.jarvis3/backend/, Verzeichnis 0700, Datei 0600; keine Verschlüsselung, kein Schlüsselbund,
// Windows noch nicht unterstützt. Die Oberfläche behauptet nichts darüber hinaus.
//
// API-Schlüssel: nur als Passwortfeld, nie in Attributen, localStorage, Protokollen oder Fehlermeldungen (redact()).

export const DEFAULT_BACKEND = "opencode";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8642";
export const DEFAULT_PROVIDER = "default", DEFAULT_MODEL = "hermes-agent";

/** Je Backend: was die Oberfläche einstellen darf. OpenCode verwaltet Anbieter, Modell und Schlüssel selbst (nur Anzeige). */
export const BACKENDS = {
  opencode: {
    id: "opencode", label: "OpenCode", configurable: false,
    tagline: "Standard. Verwaltet seine Modellanbieter und Zugänge selbst; hier gibt es nichts einzustellen.",
    providers: [],
  },
  hermes: {
    id: "hermes", label: "Hermes", configurable: true,
    tagline: "Hermes Agent. Jarvis verbindet sich mit dem Hermes-Gateway auf diesem Rechner.",
    providers: [{ id: DEFAULT_PROVIDER, label: "Hermes-Standardanbieter", needsKey: false }],
  },
};
export const BACKEND_IDS = Object.keys(BACKENDS);
export const isBackend = id => Object.hasOwn(BACKENDS, id);

const STATUS = new Set(["ready", "connecting", "error", "unsupported"]);
const text = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const trimUrl = u => text(u).replace(/\/+$/, "");

/** Zustand der Oberfläche aus der Nachricht `backend`; fehlt etwas, gelten sichere Standardwerte (OpenCode aktiv). */
export function normalizeBackendState(message) {
  const m = message && typeof message === "object" ? message : {};
  const active = isBackend(m.active) ? m.active : DEFAULT_BACKEND;
  const backends = {};
  for (const id of BACKEND_IDS) {
    const raw = m.backends && typeof m.backends === "object" ? m.backends[id] : undefined;
    const cfg = raw?.config && typeof raw.config === "object" ? raw.config : {};
    const hermes = id === "hermes";
    backends[id] = {
      id, label: text(raw?.label, 40) || BACKENDS[id].label, configurable: BACKENDS[id].configurable,
      status: STATUS.has(raw?.status) ? raw.status : raw ? "ready" : "unsupported",
      error: text(raw?.error, 400),
      // `baseUrl` (OpenCode) ist KEINE Hermes-Serveradresse und wird nie als solche gelesen.
      config: hermes ? { serverUrl: text(cfg.serverUrl, 300), provider: text(cfg.provider, 60) || DEFAULT_PROVIDER, model: text(cfg.model, 200) || DEFAULT_MODEL }
        : { provider: text(cfg.provider, 60), model: text(cfg.model, 200), serverUrl: "" },
      keySet: hermes && raw?.keySet === true,                         // nur ein Ja/Nein, nie ein Schlüssel oder Teil davon
      providers: Array.isArray(raw?.providers) && raw.providers.length
        ? raw.providers.filter(p => p && typeof p.id === "string").map(p => ({ id: p.id, label: text(p.label, 80) || p.id }))
        : BACKENDS[id].providers,
    };
  }
  return { active, backends };
}

/** Ist das eine feste Loopback-IP (127.x.x.x oder [::1])? Hostnamen wie localhost zählen nicht: der Daemon verlangt eine IP. */
export function isLoopbackIp(host) {
  const h = String(host || "").replace(/^\[|\]$/g, "");
  const v4 = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) return v4.slice(1).every(n => Number(n) <= 255);
  return h === "::1";
}

/** Prüft die Eingaben für Hermes. Fehler je Feld (Text). Die Serveradresse muss HTTP auf einer festen Loopback-IP sein. */
export function validateConfig(draft) {
  const errors = {};
  if (!text(draft.provider)) errors.provider = "Modellanbieter wählen.";
  if (!text(draft.model)) errors.model = "Modell eintragen (hermes-agent verwendet die Hermes-Vorgabe).";
  const url = text(draft.serverUrl);
  if (!url) errors.serverUrl = "Serveradresse eintragen, z. B. " + DEFAULT_SERVER_URL + ".";
  else {
    let parsed;
    try { parsed = new URL(url); } catch { /* unten gemeldet */ }
    if (!parsed || !parsed.hostname) errors.serverUrl = "Gültige Adresse eintragen, z. B. " + DEFAULT_SERVER_URL + ".";
    else if (parsed.username || parsed.password) errors.serverUrl = "Keine Zugangsdaten in die Adresse schreiben, dafür gibt es das Schlüsselfeld.";
    else if (parsed.protocol !== "http:" || !isLoopbackIp(parsed.hostname)) errors.serverUrl = "Erlaubt ist nur http:// mit fester Loopback-IP (127.0.0.1 oder [::1]), z. B. " + DEFAULT_SERVER_URL + ".";
  }
  return { errors, valid: Object.keys(errors).length === 0 };
}

export const configOf = draft => ({ serverUrl: trimUrl(draft.serverUrl), provider: text(draft.provider, 60), model: text(draft.model, 200) });
export const sameConfig = (a, b) => ["serverUrl", "provider", "model"].every(k => trimUrl(a?.[k]) === trimUrl(b?.[k]));

// ----- Nachrichten an jarvisd -----
export const msgGet = () => ({ type: "backend_get" });
export const msgSet = backend => ({ type: "backend_set", backend });
export const msgConfig = (backend, draft) => ({ type: "backend_config", backend, config: configOf(draft) });
export const msgSecret = (backend, apiKey) => ({ type: "backend_secret", backend, apiKey: apiKey === null ? null : String(apiKey) });
export const msgTest = backend => ({ type: "backend_test", backend });

/** Entfernt Schlüssel aus beliebigen Objekten, bevor etwas protokolliert oder gemeldet wird. */
export function redact(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, /key|secret|token|passw|authorization/i.test(k) && v ? "[verborgen]" : redact(v, depth + 1)]));
  if (typeof value === "string") return value.replace(/\b(sk|nvapi|hf|gsk|xai)[-_][A-Za-z0-9_-]{12,}\b/g, "[verborgen]").replace(/Bearer\s+\S+/gi, "Bearer [verborgen]");
  return value;
}

/** Anzeige für den Schlüsselstatus: immer verborgen, nie Teile des Schlüssels. */
export const keyStatus = keySet => (keySet ? "Gespeichert (wird nie angezeigt)" : "Nicht gesetzt");

/** Wahrheitsgemäßer Hinweis zur Ablage des Server-Schlüssels (Stand PR #63): Dateirechte, keine Verschlüsselung, kein Windows. */
export const KEY_STORAGE_NOTE = "Liegt als Datei in ~/.jarvis3/backend/ und ist durch Dateirechte (nur dein Benutzer) geschützt, nicht verschlüsselt. Windows wird noch nicht unterstützt. Der Schlüssel wird nie wieder angezeigt.";
