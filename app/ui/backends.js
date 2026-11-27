// Backend-Wechsel (OpenCode / Hermes): reine Logik der Oberfläche, ohne DOM, damit sie sich testen lässt (backends.test.js).
//
// Vertrag: docs/protocol.md im Zweig von PR #63 („Agenten-Backend: OpenCode und Hermes“), geprüft gegen core/src/backend-config.ts,
// hermes.ts (hermesUrl, managedGateway) und die Handler in index.ts. Abgleich siehe docs/backend-ui.md.
//
// Vier Backends: OpenCode (Standard), Hermes, Claude Code und Codex. Claude Code und Codex sind die schon installierten Programme; sie melden sich
// selbst an (Abo bzw. ChatGPT-Konto). Jarvis speichert, liest und sendet dafür KEINE Schlüssel oder Passwörter; `backend_secret` wird für sie
// abgelehnt. Einstellungen je Programm: `model` (leer = Vorgabe des Programms) und `files` ("none" | "read").
//
//   UI → jarvisd
//     {type:"backend_get"}                                                        Zustand anfordern
//     {type:"backend_set", backend:"opencode"|"hermes"|"claude"|"codex"}                           Backend für NEUE Chats wählen
//     {type:"backend_config", backend:"hermes", config:{serverUrl, provider, model, modelBaseUrl, modelSupportsVision}}   nie ein Schlüssel
//     {type:"backend_secret", backend:"hermes", target:"server"|"provider", apiKey:string|null}   getrennte Schlüssel (null = entfernen)
//     {type:"backend_config", backend:"claude"|"codex", config:{model, files, effort, adopt}}   Modell, Dateizugriff, Denkaufwand ("" = Vorgabe), installierte Skills/Plugins übernehmen
//     {type:"settings", settings:{model:"claude/<modell>"}}                       Modellwahl im Chat (setzt model des aktiven Programms)
//     {type:"backend_test", backend}                                              Hermes: Gateway prüfen; Claude Code/Codex: installiert und angemeldet?
//   jarvisd → UI
//     {type:"backend", active, backends:{<id>:{label?, status, error?, config, keySet, providerKeySet?, externalGatewayManaged?, providers?}}}
//         Hermes-config: {serverUrl, provider, model, modelBaseUrl, modelSupportsVision}; OpenCode-config: {provider, model, baseUrl} nur Anzeige;
//         Claude Code/Codex-config: {provider, model, files, effort, adopt}, models:[{id,label}], efforts:[…], installed:{skills,plugins}; loginManaged:true,
//         error = Hinweis zur Anmeldung
//     {type:"limits", limits:{claude?, codex?}}   Rest-Kontingent: {kind, ok, windows:[{id,label,usedPercent,resetsAt?,resetText?}], plan?, note?, error?, at}
//   UI → jarvisd: {type:"limits_get", force?} (kein Modellaufruf; Claude Code: /usage, Codex: App-Server)
//         keySet/providerKeySet: nur Ja/Nein, Schlüssel verlassen den Daemon nie
//     {type:"backend_saved", backend, ok, error?}
//     {type:"backend_test", backend, ok, error?, latencyMs?}
//
// Begriffe: `serverUrl` und der Server-Schlüssel gehören zum Hermes-GATEWAY (HTTP oder HTTPS, auch im Netzwerk). `modelBaseUrl` ist die davon
// getrennte Adresse eines OpenAI-kompatiblen Modellservers (z. B. LM Studio/Ollama im Heimnetz) mit eigenem Modellanbieter-Schlüssel.
// Verwaltet Jarvis das Gateway (http auf 127.0.0.1, [::1] oder localhost, Pfad „/“), startet es Hermes mit diesen Einstellungen. Bei einem
// externen Gateway lehnt der Daemon Modellserver-Adresse und Anbieter-Schlüssel ab: sie müssen dort eingerichtet sein; dort müssen auch
// Werkzeugregeln und Not-Aus separat eingerichtet werden.
// Schlüsselablage (tatsächlicher Stand): ~/.jarvis3/backend/, Verzeichnis 0700, Datei 0600; keine Verschlüsselung, kein Schlüsselbund,
// Windows noch nicht unterstützt. Der Anbieter-Schlüssel wird beim Start per Umgebungsvariable an Hermes übergeben (im YAML nur ein Verweis).
//
// API-Schlüssel: nur als Passwortfeld, nie in Attributen, localStorage, Protokollen oder Fehlermeldungen (redact()).

export const DEFAULT_BACKEND = "opencode";
export const DEFAULT_SERVER_URL = "http://127.0.0.1:8642";
export const DEFAULT_PROVIDER = "default", DEFAULT_MODEL = "hermes-agent";
export const MODEL_URL_EXAMPLE = "http://192.168.1.20:1234/v1";

/** Je Backend: was die Oberfläche einstellen darf. OpenCode verwaltet Anbieter, Modell und Schlüssel selbst (nur Anzeige). */
export const BACKENDS = {
  opencode: {
    id: "opencode", label: "OpenCode", kind: "opencode", configurable: false,
    tagline: "Standard. Verwaltet seine Modellanbieter und Zugänge selbst; hier gibt es nichts einzustellen.",
    providers: [],
  },
  hermes: {
    id: "hermes", label: "Hermes", kind: "hermes", configurable: true,
    tagline: "Hermes Agent. Jarvis verbindet sich mit dem Hermes-Gateway auf diesem Rechner.",
    providers: [{ id: DEFAULT_PROVIDER, label: "Hermes-Standardanbieter", needsKey: false }, { id: "custom", label: "OpenAI-kompatibler Modellserver", needsKey: false }],
  },
  claude: {
    id: "claude", label: "Claude Code", kind: "cli", configurable: true, program: "claude",
    tagline: "Das installierte Claude Code. Meldet sich selbst an (Claude-Abo); Jarvis speichert dafür nichts.", providers: [],
    loginHint: "Nicht angemeldet? Im Terminal `claude` starten und anmelden.",
  },
  codex: {
    id: "codex", label: "Codex", kind: "cli", configurable: true, program: "codex",
    tagline: "Das installierte Codex. Meldet sich selbst an (ChatGPT-Konto); Jarvis speichert dafür nichts.", providers: [],
    loginHint: "Nicht angemeldet? Im Terminal `codex login` ausführen.",
  },
};
export const isCliBackend = id => BACKENDS[id]?.kind === "cli";
export const CLI_FILES = [{ id: "none", label: "Keine Dateien" }, { id: "read", label: "Dateien lesen" }];
export const CLI_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"];
export const EFFORT_LABEL = { "": "Vorgabe", low: "Niedrig", medium: "Mittel", high: "Hoch", xhigh: "Sehr hoch", max: "Maximal", ultra: "Ultra (nur Codex)" };
export const CLI_MODEL_RE = /^[\w][\w.:/\-\[\]]*$/;
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
    const hermes = id === "hermes", cli = isCliBackend(id);
    backends[id] = {
      id, label: text(raw?.label, 40) || BACKENDS[id].label, configurable: BACKENDS[id].configurable,
      status: STATUS.has(raw?.status) ? raw.status : raw ? "ready" : "unsupported",
      error: text(raw?.error, 400),
      // `baseUrl` (OpenCode) ist KEINE Hermes-Serveradresse und wird nie als solche gelesen.
      config: cli ? { provider: id, model: text(cfg.model, 100), files: cfg.files === "read" ? "read" : "none", effort: CLI_EFFORTS.includes(cfg.effort) ? cfg.effort : "", adopt: cfg.adopt === true } : hermes ? { serverUrl: text(cfg.serverUrl, 300), provider: text(cfg.provider, 60) || DEFAULT_PROVIDER, model: text(cfg.model, 200) || DEFAULT_MODEL,
          modelBaseUrl: text(cfg.modelBaseUrl, 300), modelSupportsVision: cfg.modelSupportsVision === true }
        : { provider: text(cfg.provider, 60), model: text(cfg.model, 200), serverUrl: "", modelBaseUrl: "", modelSupportsVision: false },
      keySet: hermes && raw?.keySet === true, loginManaged: cli,                        // nur ein Ja/Nein, nie ein Schlüssel oder Teil davon
      providerKeySet: hermes && raw?.providerKeySet === true,
      externalGatewayManaged: hermes && raw?.externalGatewayManaged === false ? false : true,
      models: cli && Array.isArray(raw?.models) ? raw.models.map(x => (typeof x === "string" ? { id: x, label: x } : { id: text(x?.id, 100), label: text(x?.label, 80) || text(x?.id, 100) })).filter(x => x.id && CLI_MODEL_RE.test(x.id)).slice(0, 200) : [],
      installed: cli ? { skills: Math.max(0, Number(raw?.installed?.skills) || 0), plugins: Math.max(0, Number(raw?.installed?.plugins) || 0) } : { skills: 0, plugins: 0 },
      efforts: cli ? (Array.isArray(raw?.efforts) ? raw.efforts.filter(e => CLI_EFFORTS.includes(e)) : CLI_EFFORTS.filter(e => e !== "ultra")) : [],
      providers: Array.isArray(raw?.providers) && raw.providers.length
        ? raw.providers.filter(p => p && typeof p.id === "string").map(p => ({ id: p.id, label: text(p.label, 80) || p.id }))
        : BACKENDS[id].providers,
    };
  }
  return { active, backends };
}

/** Wo steht der Dienst? lokal (dieser Rechner), heimnetz (privates Netz), extern (Internet). */
export function classifyHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h) return "unbekannt";
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || /^127\./.test(h)) return "lokal";
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)
    || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h) || h.endsWith(".local") || h.endsWith(".lan") || h.endsWith(".fritz.box") || !h.includes(".")) return "heimnetz";
  return "extern";
}

/** Wie der Daemon (hermesUrl): http(s) ohne Zugangsdaten, Query und Fragment, höchstens 300 Zeichen. Gibt {url} oder {error} zurück. */
export function parseNetworkUrl(value, what) {
  const raw = text(value, 400);
  if (raw.length > 300) return { error: `${what} ist zu lang.` };
  let u;
  try { u = new URL(raw); } catch { return { error: `Gültige Adresse mit http:// oder https:// eintragen, z. B. ${what === "Modellserver-Adresse" ? MODEL_URL_EXAMPLE : DEFAULT_SERVER_URL}.` }; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return { error: `${what}: nur http:// oder https:// erlaubt.` };
  if (u.username || u.password) return { error: "Keine Zugangsdaten in die Adresse schreiben, dafür gibt es die Schlüsselfelder." };
  if (u.search || u.hash) return { error: `${what} darf keine Parameter (?…) oder # enthalten.` };
  return { url: u };
}

/** Verwaltet Jarvis dieses Gateway selbst (wie managedGateway im Daemon: http, 127.0.0.1/[::1]/localhost, Pfad „/“)? */
export function isManagedGateway(value) {
  try { const u = new URL(String(value)); return u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) && u.pathname === "/"; } catch { return false; }
}

/** Prüft die Eingaben für Hermes. Fehler je Feld und Hinweise (Text). Spiegelt die Prüfung im Daemon (backend-config.ts, index.ts). */
export function validateConfig(draft) {
  const errors = {}, hints = {};
  if (!/^[\w.-]{1,60}$/.test(text(draft.provider, 80))) errors.provider = "Modellanbieter wählen.";
  if (!text(draft.model)) errors.model = "Modell eintragen (hermes-agent verwendet die Hermes-Vorgabe).";
  const server = text(draft.serverUrl);
  let managed = false;
  if (!server) errors.serverUrl = `Serveradresse eintragen, z. B. ${DEFAULT_SERVER_URL}.`;
  else {
    const p = parseNetworkUrl(server, "Serveradresse");
    if (p.error) errors.serverUrl = p.error;
    else {
      managed = isManagedGateway(p.url.href);
      hints.serverNetwork = classifyHost(p.url.hostname);
      if (managed) hints.serverUrl = "Gateway auf diesem Rechner: Jarvis startet und verwaltet es.";
      else {
        hints.serverUrl = "Fremdes Gateway: Jarvis verwaltet es nicht. Werkzeugfreigaben, Not-Aus, Modellanbieter und dessen Schlüssel müssen dort eingerichtet sein.";
        if (p.url.protocol === "http:" && hints.serverNetwork === "extern") hints.serverUrl += " Unverschlüsselt über das Internet: Server-Schlüssel und Gespräche wären mitlesbar. https:// verwenden.";
      }
    }
  }
  const model = text(draft.modelBaseUrl);
  if (model) {
    const p = parseNetworkUrl(model, "Modellserver-Adresse");
    if (p.error) errors.modelBaseUrl = p.error;
    else {
      hints.modelNetwork = classifyHost(p.url.hostname);
      if (!errors.serverUrl && !managed) errors.modelBaseUrl = "Bei einem fremden Gateway muss der Modellserver dort eingerichtet werden. Hier leer lassen.";
      else if (p.url.protocol === "http:" && hints.modelNetwork === "extern") hints.modelBaseUrl = "Unverschlüsselt über das Internet: Anbieter-Schlüssel und Gespräche wären mitlesbar. https:// verwenden.";
      else hints.modelBaseUrl = { lokal: "Modellserver auf diesem Rechner.", heimnetz: "Modellserver im Heimnetz.", extern: "Modellserver im Internet." }[hints.modelNetwork] ?? "";
    }
  }
  return { errors, hints, managed, valid: Object.keys(errors).length === 0 };
}

/** Prüft Claude Code/Codex: Modellname (leer = Vorgabe des Programms) und Dateizugriff. */
export function validateCliConfig(draft) {
  const errors = {}, model = text(draft.model, 120);
  if (model && (model.length > 100 || !CLI_MODEL_RE.test(model))) errors.model = "Modellname ungültig (Buchstaben, Ziffern und . : / - _ [ ]); leer lassen für die Vorgabe.";
  if (draft.files !== "none" && draft.files !== "read") errors.files = "Dateizugriff wählen.";
  if (draft.effort && !CLI_EFFORTS.includes(draft.effort)) errors.effort = "Denkaufwand wählen.";
  return { errors, valid: Object.keys(errors).length === 0 };
}
export const cliConfigOf = draft => ({ model: text(draft.model, 100), files: draft.files === "read" ? "read" : "none", effort: CLI_EFFORTS.includes(draft.effort) ? draft.effort : "", adopt: draft.adopt === true });
export const sameCliConfig = (a, b) => text(a?.model) === text(b?.model) && (a?.files === "read") === (b?.files === "read") && text(a?.effort) === text(b?.effort) && (a?.adopt === true) === (b?.adopt === true);

export const configOf = draft => ({ serverUrl: trimUrl(draft.serverUrl), provider: text(draft.provider, 60), model: text(draft.model, 200),
  modelBaseUrl: trimUrl(draft.modelBaseUrl), modelSupportsVision: draft.modelSupportsVision === true });
export const sameConfig = (a, b) => ["serverUrl", "provider", "model", "modelBaseUrl"].every(k => trimUrl(a?.[k]) === trimUrl(b?.[k])) && (a?.modelSupportsVision === true) === (b?.modelSupportsVision === true);

// ----- Nachrichten an jarvisd -----
export const msgGet = () => ({ type: "backend_get" });
export const msgSet = backend => ({ type: "backend_set", backend });
export const msgConfig = (backend, draft) => ({ type: "backend_config", backend, config: isCliBackend(backend) ? cliConfigOf(draft) : configOf(draft) });
/** target: "server" (Hermes-Gateway) oder "provider" (Modellserver/Anbieter). */
export const msgSecret = (backend, apiKey, target = "server") => ({ type: "backend_secret", backend, target, apiKey: apiKey === null ? null : String(apiKey) });
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
export const PROVIDER_KEY_NOTE = KEY_STORAGE_NOTE + " Hermes bekommt ihn beim Start über eine Umgebungsvariable.";

// ----- Limit-Anzeige (Rest-Kontingent) -----
/** Zustand aus der Nachricht `limits`; unbrauchbare Einträge fallen weg. */
export function normalizeLimits(message) {
  const out = {};
  const raw = message && typeof message === "object" && message.limits && typeof message.limits === "object" ? message.limits : {};
  for (const kind of ["claude", "codex"]) {
    const l = raw[kind];
    if (!l || typeof l !== "object") continue;
    const windows = Array.isArray(l.windows) ? l.windows.filter(w => w && Number.isFinite(Number(w.usedPercent))).map(w => ({
      id: text(w.id, 60), label: text(w.label, 60) || "Fenster", usedPercent: Math.max(0, Math.min(100, Math.round(Number(w.usedPercent)))),
      resetsAt: Number.isFinite(Number(w.resetsAt)) ? Number(w.resetsAt) : undefined, resetText: text(w.resetText, 60) })).slice(0, 8) : [];
    out[kind] = { kind, ok: l.ok === true && windows.length > 0, windows, plan: text(l.plan, 30), note: text(l.note, 80), error: text(l.error, 200), at: Number(l.at) || 0 };
  }
  return out;
}
/** ok (unter 70 %), warn (ab 70 %), bad (ab 90 %) */
export const limitLevel = percent => (percent >= 90 ? "bad" : percent >= 70 ? "warn" : "ok");
/** Wann das Fenster zurückgesetzt wird: aus dem Zeitstempel (Codex) oder dem Text (Claude Code). `now` nur für Tests. */
export function formatReset(w, now = Date.now()) {
  if (w.resetsAt) {
    const d = new Date(w.resetsAt * 1000), diff = d.getTime() - now;
    if (diff <= 0) return "gleich";
    const mins = Math.round(diff / 60000);
    if (mins < 90) return `in ${mins} Min.`;
    if (mins < 36 * 60) return `in ${Math.round(mins / 60)} Std. (${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })})`;
    return `${d.toLocaleDateString("de-DE", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`;
  }
  return w.resetText || "";
}
/** Kurztext für die Kopfzeile: z. B. „5 Std. 10 % · Woche 11 %“ und die höchste Auslastung (für die Farbe). */
export function limitSummary(l) {
  if (!l?.ok) return { text: "Limit ?", percent: 0, title: l?.error || "Limit unbekannt" };
  const short = w => w.label.replace(/ \(5 Std\.\)$/, "").replace(" (alle Modelle)", "");
  const percent = Math.max(...l.windows.map(w => w.usedPercent));
  return { text: l.windows.slice(0, 2).map(w => `${short(w)} ${w.usedPercent} %`).join(" · "), percent,
    title: [...l.windows.map(w => `${w.label}: ${w.usedPercent} % verbraucht, noch ${100 - w.usedPercent} % frei${formatReset(w) ? ` · zurückgesetzt ${formatReset(w)}` : ""}`), l.note, l.plan ? `Tarif: ${l.plan}` : ""].filter(Boolean).join("\n") };
}
