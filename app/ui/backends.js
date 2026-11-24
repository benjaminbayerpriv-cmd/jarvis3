// Backend-Wechsel (OpenCode / Hermes): reine Logik der Oberfläche, ohne DOM, damit sie sich testen lässt (backends.test.js).
//
// ANNAHME (noch nicht von core bestätigt): Die Nachrichtenformen unten sind ein Vorschlag der Oberfläche. Der andere Chat, der core
// umsetzt, dokumentiert die echte Schnittstelle in docs/protocol.md; weicht sie ab, ändert sich nur dieses Modul und der Abschnitt
// „Daemon-Nachrichten“ in app.js (Kennzeichnung: ANNAHME-BACKEND).
//
//   UI → jarvisd
//     {type:"backend_get"}                                              Zustand anfordern
//     {type:"backend_set", backend:"opencode"|"hermes"}                 aktives Backend wählen (gilt für neue Nachrichten/Chats)
//     {type:"backend_config", backend, config:{provider, model, baseUrl}}   Einstellungen speichern (nie ein Schlüssel!)
//     {type:"backend_secret", backend, apiKey:string|null}              Schlüssel speichern (null = entfernen); wird nie zurückgesendet
//     {type:"backend_test", backend}                                    gespeicherte Einstellungen prüfen
//   jarvisd → UI
//     {type:"backend", active, backends:{<id>:{label?, status, error?, config:{provider,model,baseUrl}, keySet, providers?, models?}}}
//         status: "ready" | "connecting" | "error" | "unsupported"
//         keySet: true/false – der Schlüssel selbst verlässt den Daemon nie (auch kein Teilstück)
//     {type:"backend_saved", backend, ok, error?}
//     {type:"backend_test", backend, ok, error?, latencyMs?, models?}
//
// API-Schlüssel: nur als Passwortfeld, nie in Attributen, localStorage, Protokollen oder Fehlermeldungen (redact()).

export const DEFAULT_BACKEND = "opencode";

/** Voreinstellungen je Backend (Anbieter-Auswahl). Der Daemon kann sie mit `providers` überschreiben. */
export const BACKENDS = {
  opencode: {
    id: "opencode", label: "OpenCode", tagline: "Standard. Eigener Agent mit vielen Anbietern und kostenlosen Modellen.",
    providers: [
      { id: "opencode", label: "OpenCode (kostenlose Modelle)", url: "", needsKey: false },
      { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", needsKey: true },
      { id: "nvidia", label: "NVIDIA", url: "https://integrate.api.nvidia.com/v1", needsKey: true },
      { id: "lmstudio", label: "LM Studio (lokal)", url: "http://127.0.0.1:1234/v1", needsKey: false, local: true },
      { id: "custom", label: "Eigener Anbieter (OpenAI-kompatibel)", url: "", needsKey: true },
    ],
  },
  hermes: {
    id: "hermes", label: "Hermes", tagline: "Hermes Agent. Läuft lokal, im Heimnetz oder bei einem Anbieter.",
    providers: [
      { id: "nous", label: "Nous Portal", url: "https://inference-api.nousresearch.com/v1", needsKey: true },
      { id: "openrouter", label: "OpenRouter", url: "https://openrouter.ai/api/v1", needsKey: true },
      { id: "local", label: "Lokal oder Heimnetz (Ollama, LM Studio, vLLM)", url: "http://127.0.0.1:11434/v1", needsKey: false, local: true },
      { id: "custom", label: "Eigener Anbieter (OpenAI-kompatibel)", url: "", needsKey: true },
    ],
  },
};
export const BACKEND_IDS = Object.keys(BACKENDS);
export const isBackend = id => Object.hasOwn(BACKENDS, id);

const STATUS = new Set(["ready", "connecting", "error", "unsupported"]);
const text = (v, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Zustand der Oberfläche aus der Nachricht `backend`; fehlt etwas, gelten sichere Standardwerte (OpenCode aktiv). */
export function normalizeBackendState(message) {
  const m = message && typeof message === "object" ? message : {};
  const active = isBackend(m.active) ? m.active : DEFAULT_BACKEND;
  const backends = {};
  for (const id of BACKEND_IDS) {
    const raw = m.backends && typeof m.backends === "object" ? m.backends[id] : undefined;
    const cfg = raw?.config && typeof raw.config === "object" ? raw.config : {};
    backends[id] = {
      id, label: text(raw?.label, 40) || BACKENDS[id].label,
      status: STATUS.has(raw?.status) ? raw.status : raw ? "ready" : "unsupported",
      error: text(raw?.error, 400),
      config: { provider: text(cfg.provider, 60), model: text(cfg.model, 200), baseUrl: text(cfg.baseUrl, 300) },
      keySet: raw?.keySet === true,                                   // nur ein Ja/Nein, nie ein Schlüssel oder Teil davon
      providers: Array.isArray(raw?.providers) && raw.providers.length
        ? raw.providers.filter(p => p && typeof p.id === "string").map(p => ({ id: p.id, label: text(p.label, 80) || p.id, url: text(p.url, 300), needsKey: p.needsKey !== false, local: p.local === true }))
        : BACKENDS[id].providers,
      models: Array.isArray(raw?.models) ? raw.models.map(x => (typeof x === "string" ? { id: x, label: x } : { id: text(x?.id, 200), label: text(x?.label, 120) || text(x?.id, 200) })).filter(x => x.id).slice(0, 500) : [],
    };
  }
  return { active, backends };
}

/** Wo steht der Dienst? lokal (dieser Rechner), heimnetz (privates Netz), extern (Internet) oder unbekannt. */
export function classifyHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return "unbekannt";
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h)) return "lokal";
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
    || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".fritz.box") || !h.includes(".")) return "heimnetz";
  return "extern";
}

/** Prüft die Eingaben eines Backends. Gibt Fehler je Feld (Text) und Hinweise (Text) zurück. */
export function validateConfig(backend, draft, { keySet = false, keyTyped = false } = {}) {
  const errors = {}, hints = {};
  const provider = BACKENDS[backend]?.providers.find(p => p.id === draft.provider);
  if (!draft.provider) errors.provider = "Anbieter wählen.";
  if (!text(draft.model)) errors.model = "Modell eintragen.";
  const url = text(draft.baseUrl);
  if (url) {
    let parsed;
    try { parsed = new URL(url); } catch { /* unten gemeldet */ }
    if (!parsed || !/^https?:$/.test(parsed.protocol) || !parsed.hostname) errors.baseUrl = "Gültige Adresse mit http:// oder https:// eintragen, z. B. http://192.168.1.20:11434/v1.";
    else {
      const where = classifyHost(parsed.hostname);
      hints.network = where;
      if (parsed.protocol === "http:" && where === "extern") hints.baseUrl = "Unverschlüsselt über das Internet: Schlüssel und Gespräche wären mitlesbar. https:// verwenden.";
      else if (where === "heimnetz") hints.baseUrl = "Rechner im Heimnetz.";
      else if (where === "lokal") hints.baseUrl = "Dieser Rechner.";
      if (parsed.username || parsed.password) errors.baseUrl = "Keine Zugangsdaten in die Adresse schreiben, dafür gibt es das Schlüsselfeld.";
    }
  } else if (provider?.local) errors.baseUrl = "Für einen lokalen Dienst die Adresse eintragen.";
  if (provider?.needsKey && !keySet && !keyTyped) hints.apiKey = "Dieser Anbieter braucht normalerweise einen API-Schlüssel.";
  return { errors, hints, valid: Object.keys(errors).length === 0 };
}

export const configOf = draft => ({ provider: text(draft.provider, 60), model: text(draft.model, 200), baseUrl: text(draft.baseUrl, 300).replace(/\/+$/, "") });
export const sameConfig = (a, b) => ["provider", "model", "baseUrl"].every(k => text(a?.[k]).replace(/\/+$/, "") === text(b?.[k]).replace(/\/+$/, ""));

// ----- Nachrichten an jarvisd (ANNAHME-BACKEND) -----
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
export const keyStatus = keySet => (keySet ? "Gespeichert (verborgen)" : "Nicht gesetzt");
