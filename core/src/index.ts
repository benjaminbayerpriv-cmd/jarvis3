// jarvisd – Kern-Daemon. UI (Tauri) und Chrome-Erweiterung verbinden sich hierher.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { OpenCode, listModels, type ModelInfo, type BrainEvent, type PromptImage } from "./opencode";
import { Desktop } from "./desktop";
import { Browser } from "./browser";
import { InternalBrowser, urlFor } from "./ibrowser";
import { DirectBrowser, type PageSocket } from "./dbrowser";
import { WebProxy } from "./proxy";
import { agentSource } from "./proxy-agent";
import { FUNCTION_COMMANDS } from "./functions";
import { SYSTEM_PROMPT } from "./prompt";
import { Speech } from "./speech";
import { clickOutcome, formatLiveSpeech, inCorner, relativeCenter, requestedClick, type ClickIntent } from "./live-response";
import { prepare, validate, hasImages, type Attachment } from "./attachments";
import { correct, recognitionPrompt } from "./lexicon";
import { recordError, listErrors, resolveError, markPng, toImageBox, CATEGORIES, type ErrorCategory } from "./errorlog";
import { Projects } from "./projects";
import { SidecarSupervisor } from "./sidecar";
import { DEAD_LEVEL, nextMicStep } from "./mic-heal";
import { Capture } from "./capture";
import { applyImport, enabledSkills, expandTemplate, loadStore, readSkill, skillCatalog, mcpSummary, saveStore, scanImport, writeWorkspace, type Candidate, type McpEntry, type Source } from "./extensions";
import { Preview, type PreviewTarget } from "./preview";
import { classificationPrompt, parseClassification } from "./classify";
import { parseRange, readUsage, summarize } from "./usage";
import { LiveAnswer, TurnTrace, isEcho } from "./live-turn";
import { RunBuffer } from "./runbuf";
import { defaults, parseSettings, type Settings } from "./settings";
import { Haptics } from "./haptics";
import { MARKER, markers, getVisual, runPython, saveHtml, serveVisual, setVisualTheme, type Visual } from "./visuals";
import { needsChatTitle, parseChatTitle, provisionalChatTitle, titleExcerpt, visibleChatTitle, type ChatMeta } from "./chat-title";

const PORT = Number(process.env.JARVIS_PORT ?? 7777);
const HOME = join(homedir(), ".jarvis3");
const SETTINGS = join(HOME, "settings.json");
const CHAT_META = join(HOME, "chat-meta.json");
const CHAT_FOLDERS = join(HOME, "chat-folders.json");
const ROOT = join(import.meta.dir, "../..");
mkdirSync(HOME, { recursive: true });

let settings: Settings = { ...defaults };
try {
  if (existsSync(SETTINGS)) Object.assign(settings, parseSettings(JSON.parse(readFileSync(SETTINGS, "utf8")), true));
} catch (error) {
  recordError({ category: "daemon", source: "jarvisd/settings", message: "Einstellungen konnten nicht gelesen werden", error });
}
const save = () => writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
let chatMeta: Record<string, ChatMeta> = existsSync(CHAT_META) ? JSON.parse(readFileSync(CHAT_META, "utf8")) : {};
let chatFolders: string[] = existsSync(CHAT_FOLDERS) ? JSON.parse(readFileSync(CHAT_FOLDERS, "utf8")) : [];
const saveChatMeta = () => writeFileSync(CHAT_META, JSON.stringify(chatMeta, null, 2));

// OpenCode-Arbeitsordner mit Jarvis-MCP und voller Autonomie (Nutzerentscheidung).
const workspace = join(ROOT, "workspace");
mkdirSync(workspace, { recursive: true });
const BASE_OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  mcp: { jarvis: { type: "local", command: [process.execPath, join(ROOT, "core/src/mcp.ts")], enabled: true,
                   environment: { JARVISD_URL: `http://127.0.0.1:${PORT}` } } },
  permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" },
};
writeWorkspace(workspace, BASE_OPENCODE_CONFIG);   // plus MCP-Server, Plugins, Befehle und Skills aus ~/.jarvis3/extensions.json

const brain = new OpenCode(Number(process.env.JARVIS_OPENCODE_PORT ?? 4096), workspace);
const desktop = new Desktop();
const browser = new Browser();
const dbrowser = new DirectBrowser();         // direkter Browser: echte Seiten im Rahmen der Vorschau (Proxy), Jarvis steuert sie über einen Agenten in der Seite
let uiDark = true;   // Darstellung der Oberfläche (hell/dunkel, Systemmodus eingeschlossen)
const webProxy = new WebProxy(PORT, agentSource, undefined, () => ({ dark: uiDark, forceDark: settings.darkPages }));
const ibrowser = new InternalBrowser();   // eigener, eingebauter Browser (Vorschau); Chrome-Erweiterung bleibt für echtes Chrome
const projects = new Projects();
try { projects.load(); } catch (error) {
  recordError({ category: "daemon", source: "jarvisd/projects-load", message: "Projekte konnten nicht gelesen werden", error });
}
// Projekte sind die einzigen Ordner: die Seitenleiste zeigt dieselben Projekte (Name samt Überprojekt als Pfad).
const folderLabels = () => projects.data().projects.map(p => projects.label(p.id)).sort((a, b) => a.localeCompare(b, "de"));
const projectByLabel = (label: string) => projects.data().projects.find(p => projects.label(p.id) === label);
const broadcastProjects = () => { broadcast({ type: "projects", ...projects.data() }); void history().then(sessions => broadcast({ type: "history", sessions, folders: folderLabels() })); };

// Einmalig: die alten Seitenleisten-Ordner (chat-folders.json / chat-meta.json) werden zu Projekten.
function migrateFolders() {
  try {
    const names = new Set([...chatFolders, ...Object.values(chatMeta).map(m => m.folder ?? "")].filter(Boolean));
    if (!names.size) return;
    for (const name of names) if (!projectByLabel(name)) projects.create(name);
    for (const [id, m] of Object.entries(chatMeta)) {
      if (!m.folder) continue;
      const target = projectByLabel(m.folder);
      projects.upsertChat({ id, title: m.title || id });
      if (target && !projects.chat(id)?.projectId) projects.assign(id, target.id, "manual");
      delete m.folder;
    }
    chatFolders = []; writeFileSync(CHAT_FOLDERS, "[]"); saveChatMeta();
  } catch (error) { recordError({ category: "daemon", source: "jarvisd/migrate-folders", message: "Ordner konnten nicht zu Projekten werden", error }); }
}
migrateFolders();
let models: ModelInfo[] = [];
let session: string | undefined;   // der Chat, den die Oberfläche gerade zeigt und an den neue Nachrichten gehen
// Mehrere Chats laufen parallel: pro Chat ein eigener Lauf. latestRun merkt die neueste Lauf-Nummer je Chat; nur sie gilt als aktuell.
const busySessions = new Set<string>();
// Haptik am Trackpad (nur macOS): Klick, Denk-Takt, Buchstaben im Antwort-Stream
// Fokus: vibriert wird nur, wenn mindestens eine Jarvis-Oberfläche (App oder Webseite) im Vordergrund ist.
const uiFocus = new Map<unknown, boolean>();
const anyUiFocused = () => [...uiFocus.values()].some(Boolean);
const runningTools = new Set<string>();            // laufende Werkzeugaufrufe (kein Denk-Takt, solange eins läuft)
const haptics = new Haptics({
  enabled: () => settings.haptics && anyUiFocused(),
  allow: p => ({ click: settings.hapticsClick, tool: settings.hapticsTool, tick: settings.hapticsType })[p],
  strength: () => settings.hapticsStrength,
});
const latestRun = new Map<string, number>();
const runBuffer = new RunBuffer();
const isBusy = () => !!session && busySessions.has(session);
let stoppedUntil = 0; // Not-Aus: Werkzeuge kurz sperren

const uis = new Set<ServerWebSocket<{ kind: string; fresh?: boolean }>>();
const uiIds = new WeakMap<ServerWebSocket<{ kind: string; fresh?: boolean }>, number>();
let uiSeq = 0;
const uiId = (ws: ServerWebSocket<{ kind: string; fresh?: boolean }>) => {
  let id = uiIds.get(ws);
  if (!id) { id = ++uiSeq; uiIds.set(ws, id); }
  return id;
};
const broadcast = (msg: unknown) => { const s = JSON.stringify(msg); for (const ui of uis) ui.send(s); };
type AudioDevice = { id: number; name: string; default: boolean };
type AudioDevices = { input: AudioDevice[]; output: AudioDevice[] };
let audioDevices: AudioDevices | undefined;
const state = () => ({ type: "state", ...settings, extStale: extensionStale, busy: isBusy(), busySessions: [...busySessions], browser: browser.connected,
  speech: speech.connected, voice, models, devices: audioDevices });

// ---------- Sprache ----------
let voice: "off" | "live" | "dictate" | "muted" = "off";
// Nur die Oberfläche, die Live gestartet hat, darf es auch beenden. Andere UIs (z. B. eine vergessene
// Registerkarte oder ein zweiter Client) schickten sonst sofort voice:off, sobald sie "live" im State sahen.
let voiceOwner: ServerWebSocket<{ kind: string; fresh?: boolean }> | undefined;
let speechEpoch = 0;
import { appendFileSync } from "node:fs";
const vlog = (line: string) => { if (!settings.voiceLog) return; try { appendFileSync(join(HOME, "voice.log"), `${new Date().toISOString()} ${line}\n`); } catch {} };
let micPeak = 0, micWatch: ReturnType<typeof setTimeout> | undefined, lastLevelAt = 0, lastRestart = 0;
const speaking = new Set<number>();
const speechStarted = new Map<number, () => void>();
// Mikrofon-Wächter mit Selbstheilung (mic-heal.ts): kommt nach dem Start des Zuhörens 7 s lang kein Pegel (exakt 0), ist das Gerät
// stumm, der Sidecar hat die Audiogeräte veraltet oder macOS verweigert das Mikrofon. Der Wächter probiert selbst nacheinander:
// Sidecar neu starten, dann andere echte Mikrofone; erst danach folgt ein Hinweis. Kommt irgendwann Signal, beginnt alles von vorn.
let micRestarted = false; const micTried = new Set<number | null>();
function micHealthy() { micRestarted = false; micTried.clear(); }
function armMicWatch() {
  clearTimeout(micWatch); micPeak = 0;
  if (voice !== "live" && voice !== "dictate") { micHealthy(); return; }
  micWatch = setTimeout(() => {
    if (voice !== "live" && voice !== "dictate") return;
    if (micPeak >= DEAD_LEVEL) { micHealthy(); return; }
    if (!speech.connected) { armMicWatch(); return; }          // Sidecar startet gerade: danach neu prüfen
    micTried.add(settings.micDevice ?? audioDevices?.input.find(d => d.default)?.id ?? null);
    const step = nextMicStep(micRestarted, audioDevices?.input ?? [], micTried);
    if (step.action === "restart") { micRestarted = true; restartSidecar(`Mikrofon „${micLabel()}“ lieferte kein Signal`, true); armMicWatch(); }
    else if (step.action === "device") {
      settings = { ...settings, micDevice: step.id, micName: step.name }; save();
      micTried.add(step.id);
      vlog(`Mikrofon ohne Signal -> versuche „${step.name}“`);
      broadcast({ type: "notice", text: `Das Mikrofon lieferte kein Signal – ich versuche „${step.name}“.` });
      configureSpeech(true); broadcast(state()); armMicWatch();
    } else broadcast({ type: "notice", text: `Kein Mikrofon liefert ein Signal. Prüfe in den macOS-Einstellungen unter Datenschutz & Sicherheit → Mikrofon, ob das Programm, das Jarvis startet, erlaubt ist, und die Eingangslautstärke.` });
  }, 7000);
}
function restartSidecar(reason: string, force = false) {
  if (!sidecar || (!force && Date.now() - lastRestart < 30_000)) return;
  lastRestart = Date.now();
  vlog(`Sprach-Sidecar wird neu gestartet: ${reason}`);
  broadcast({ type: "notice", text: `${reason} – das Sprachmodul startet neu (ca. 30 s).` });
  void sidecar.restart();
}
// Diagnose pro Turn: jede Station (Äußerung, Modell, Werkzeug, Fertig, Sprachausgabe) landet als "[T<lauf>] …" in voice.log.
const trace = new TurnTrace(vlog);
brain.onLog = vlog;
let userSpeaking = false;                              // speech_start gesehen, final steht noch aus
const recentSaid: { text: string; at: number }[] = []; // für den Echo-Filter
const liveAnswer = new LiveAnswer({
  say: text => say(text),
  blocked: () => !settings.spokenReplies || voice === "off" || voice === "dictate"
    ? { reason: settings.spokenReplies ? `Live beendet (voice=${voice})` : "Sprachausgabe deaktiviert", expected: true } : undefined,
  currentRun: () => voiceRun,
  mustWait: () => userSpeaking ? "Nutzer spricht gerade" : pendingUtterance ? "Äußerung des Nutzers noch offen"
    : !speech.connected ? "Sprachmodul nicht verbunden" : undefined,
  log: (run, ev, info) => trace.add(run, ev, info),
  unspoken: (run, text, reason) => {
    trace.add(run, "antwort-ungesprochen", reason);
    broadcast({ type: "live_unspoken", text, reason });
    recordError({ category: "speech", source: "jarvisd/live-answer", message: `Live-Antwort nicht gesprochen: ${reason.replace(/\d+/g, "#")}`,
      context: { run, reason, text: text.slice(0, 300), voice, speech: speech.connected, model: settings.voiceModel, trace: trace.get(run) } });
  },
  now: () => Date.now(),
});
function configureSpeech(includeDevices = false) {
  speech.send({ type: "config", lofi: settings.lofi, voice: settings.voicePreset, speed: settings.voiceSpeed,
    stt: settings.sttMode, stt_prompt: recognitionPrompt(),
    ...(includeDevices ? { input: settings.micDevice, output: settings.speakerDevice } : {}) });
}
function syncAudioDevices(devices: AudioDevices) {
  let changed = false;
  for (const side of ["input", "output"] as const) {
    const key = side === "input" ? "micDevice" : "speakerDevice";
    const nameKey = side === "input" ? "micName" : "speakerName";
    const id = settings[key], name = settings[nameKey];
    if (id === null) continue;
    const list = devices[side];
    const selected = list.find(d => d.id === id && (!name || d.name === name)) ?? (name ? list.find(d => d.name === name) : undefined);
    const nextId = selected?.id ?? null, nextName = selected?.name ?? null;
    if (nextId === id && nextName === name) continue;
    settings[key] = nextId;
    settings[nameKey] = nextName;
    changed = true;
    if (!selected) broadcast({ type: "notice", text: `Gewähltes ${side === "input" ? "Mikrofon" : "Ausgabegerät"} fehlt. Der Systemstandard ist aktiv.` });
  }
  if (changed) save();
}
const micLabel = () =>audioDevices?.input.find(d => d.id === settings.micDevice)?.name ?? (settings.micDevice === null ? "Systemstandard" : `Gerät ${settings.micDevice}`);
const speech = new Speech(e => {
  if (e.type === "level") { micPeak = Math.max(micPeak, Number(e.mic) || 0); lastLevelAt = Date.now(); }
  if (e.type === "speech_start" || e.type === "partial") lastUserActivityAt = Date.now();
  // Der Nutzer unterbricht: der Sidecar verwirft seine Warteschlange ohne say_start/say_end zu melden, und angesammelte
  // Ansagen ("gehalten") würden danach mitten in seinen Satz platzen.
  if (e.type === "speech_start" && voice === "live") {
    speech.sayTimes.clear(); speechEpoch++; userSpeaking = true;
    trace.add(runSeq, "nutzer-spricht", `busy=${isBusy()}${liveAnswer.playing ? ` antwort=say#${liveAnswer.playing.id}${liveAnswer.playing.started ? "(läuft)" : "(wartet)"}` : ""}`);
    liveAnswer.onUserSpeech();
  }
  if (e.type === "final" || e.type === "connected" || e.type === "disconnected") userSpeaking = false;
  // Sätze ohne hörbaren Ton (z. B. nur "1.") bekommen nie ein say_start: alles bis zur gestarteten/beendeten ID gilt als erledigt
  const doneUpTo = (id: number) => { for (const k of [...speech.sayTimes.keys()]) if (k <= id) speech.sayTimes.delete(k); };
  if (e.type === "say_start") {
    speaking.add(Number(e.id)); doneUpTo(Number(e.id));
    speechStarted.get(Number(e.id))?.();
    liveAnswer.onSayStart(Number(e.id));
  }
  if (e.type === "say_end") { speaking.delete(Number(e.id)); doneUpTo(Number(e.id)); liveAnswer.onSayEnd(Number(e.id)); }
  if (e.type === "connected") { lastLevelAt = 0; micPeak = 0; speech.sayTimes.clear(); speaking.clear(); armMicWatch(); }
  if (e.type === "say_start") { const text = speech.said.get(Number(e.id)); if (text) broadcast({ type: "spoken", id: e.id, text }); } // Live-Anzeige: nur, was schon gesprochen wird
  if (e.type !== "level" && e.type !== "partial") vlog(`speech ${e.type} ${JSON.stringify({ ...e, type: undefined }).slice(0, 300)} voice=${voice}`);
  if (e.type === "connected") { configureSpeech(); speech.mode(voice); if (voice === "off") speech.stopSpeaking(); broadcast(state()); liveAnswer.release(); return; }
  if (e.type === "disconnected") { broadcast(state()); return; }
  if (e.type === "replaced") {
    broadcast({ type: "notice", text: "Ein anderer Jarvis-Dienst nutzt gerade den Sprachdienst. Er wird beim nächsten Diktat oder Live-Start zurückgeholt." });
    return;
  }
  if (e.type === "error") recordError({ category: "speech", source: "speech/sidecar", message: String(e.message ?? "Sprachfehler"),
    context: { voice, lofi: settings.lofi, voiceModel: settings.voiceModel, event: e } });
  if (e.type === "ready") {
    audioDevices = e.devices as AudioDevices;
    syncAudioDevices(audioDevices);
    configureSpeech(true);
    broadcast(state());
  }
  if (e.type === "final" && typeof e.text === "string") {
    // Wortliste: typische Verhörer bei Denglisch und Programmnamen korrigieren, bevor der Text angezeigt/verarbeitet wird
    const fixed = correct(e.text);
    if (fixed.changes.length) vlog(`Wortliste: ${fixed.changes.map(([a, b]) => `${a} → ${b}`).join(", ")} | "${e.text}" → "${fixed.text}"`);
    e = { ...e, text: fixed.text };
  }
  broadcast({ ...e, type: "speech", event: e.type });
  if (e.type === "final" && voice === "live") hear(String(e.text ?? ""));
});

// Satzfetzen zu einer Äußerung zusammenfassen: erst nach UTTER_WAIT_MS ohne neue Sprache wird an das Modell gesendet.
// Die Spracherkennung beendet einen Satz schon nach ~0,3 s Pause; ohne diese Wartezeit würde jeder Fetzen ("Äh, du kannst." –
// "Für mich mal." – …) als eigene Nachricht die vorige abbrechen.
const UTTER_WAIT_MS = 1000;
let pendingUtterance = "";
let utterTimer: ReturnType<typeof setTimeout> | undefined;
let lastRun: { text: string; toolSeen: boolean; startedAt: number } | undefined;
const STOP_WORDS = /^(stopp?|halt|abbrechen|hör auf|hoer auf|lass das|stop it)[.!?\s]*$/i;
// Wann ist der Nutzer wirklich fertig? Der Sidecar meldet schon nach ~0,3 s Pause einen "final". Bei einem langen Satz mit Atempausen
// würde das den Satz in Stücke schneiden und das erste Stück zu früh abschicken. Darum wartet jarvisd mit dem Absenden, solange
// (a) der Nutzer erneut zu sprechen anfängt (speech_start/partial), (b) der Satz offensichtlich unfertig ist (kurzes Bruchstück,
// endet auf "und/dass/auf/…" oder ohne Satzzeichen) – dann bis zu 3,5 s, insgesamt höchstens 8 s.
let lastUserActivityAt = 0, pendingSince = 0;
function looksUnfinished(text: string) {
  const t = text.trim();
  // Vollständige Befehle mit erkennbarem Ziel haben auch ohne Satzzeichen eine kurze Wartezeit.
  const open = /^(?:bitte\s+)?(?:öffne|open)\s+\S/i.test(t);
  const click = /^(?:bitte\s+)?(?:klicke?|click)\s+(?:.+\s+)?(?:auf|on)\s+\S/i.test(t);
  if ((open || click) && !/\b(?:auf|in|dem|den|das|die|und|mit|for|the|on)$/i.test(t)) return false;
  // Die Erkennung setzt am Ende eines vollständigen Satzes fast immer ein Satzzeichen; abgeschnittene Bruchstücke haben keins.
  if (/[.!?…]["»“]?$/.test(t)) return false;
  return true;
}
function hear(text: string) {
  if (STOP_WORDS.test(text.trim())) { pendingUtterance = ""; clearTimeout(utterTimer); void stop(); return; }
  // Lautsprecher-Echo der eigenen Ansage ("Einen Moment.") wäre sonst eine neue Frage und bräche die echte ab
  if (!pendingUtterance && isEcho(text, recentSaid, Date.now())) { trace.add(runSeq, "echo-verworfen", text.slice(0, 80)); liveAnswer.release(); return; }
  if (!worthAnswering(text) && !pendingUtterance) { trace.add(runSeq, "geräusch-ignoriert", JSON.stringify(text.slice(0, 60))); liveAnswer.release(); return; }
  if (!pendingUtterance) pendingSince = Date.now();
  pendingUtterance = `${pendingUtterance} ${text}`.trim();
  clearTimeout(utterTimer);
  utterTimer = setTimeout(sendUtterance, looksUnfinished(pendingUtterance) ? 3500 : UTTER_WAIT_MS);
}
function sendUtterance() {
  // Der Nutzer redet noch (neue Sprache seit kurzem): weiter warten, aber nie länger als 8 s seit dem ersten Stück
  if (pendingUtterance && voice === "live" && Date.now() - lastUserActivityAt < 1200 && Date.now() - pendingSince < 8000) {
    utterTimer = setTimeout(sendUtterance, 600); return;
  }
  const text = pendingUtterance.trim(); pendingUtterance = "";
  if (!worthAnswering(text) || voice !== "live") { liveAnswer.release(); return; }
  let full = text, replace = false;
  // Antwort läuft noch, hat aber keine Werkzeuge benutzt und der Nutzer spricht weiter: zu EINER Äußerung zusammenführen
  if (isBusy() && lastRun && !lastRun.toolSeen && Date.now() - lastRun.startedAt < 20_000) { full = `${lastRun.text} ${text}`; replace = true; }
  lastRun = { text: full, toolSeen: false, startedAt: Date.now() };
  vlog(`Äußerung: ${full.slice(0, 160)}${replace ? " (zusammengeführt)" : ""}`);
  broadcast({ type: "user", text: full, replace });
  void chat(full, settings.voiceModel, true);
}
// Rauschen, Füllwörter und Fehlerkennungen ("Untertitel…", "Äh", "Mm-hmm") nicht beantworten.
const FILLERS = new Set(["äh", "ähm", "äm", "öh", "öhm", "hm", "hmm", "mhm", "mm", "mmhmm", "mm-hmm", "um", "uh", "ah", "oh", "eh", "also", "ja", "nein", "okay", "ok", "ne", "na", "so", "genau"]);
function worthAnswering(text: string) {
  const words = text.toLowerCase().replace(/[.!?…,;:]+/g, " ").split(/\s+/).filter(Boolean);
  const content = words.filter(w => !FILLERS.has(w));
  if (!content.length || content.join("").length < 3) return false;
  return !/untertitel|copyright|vielen dank fürs zuschauen/i.test(text);
}
const sidecar = process.env.JARVIS_SPEECH_URL || process.env.JARVIS_NO_SIDECAR ? undefined : new SidecarSupervisor(() => speech.connected, vlog, ROOT, HOME);
// Die Desktop-Hülle startet den Sidecar parallel. Erst nach ihrem Health-Timeout selbst einspringen.
sidecar?.start(process.env.JARVIS_SHELL_STARTS_SPEECH === "1" ? 45_000 : 0);
setInterval(() => {   // Wächter: hängt der Sidecar (keine Pegel mehr) oder die Sprachausgabe (Satz gesendet, nie gestartet)?
  // final verloren (z. B. Moduswechsel setzt den Endpunkt zurück): "Nutzer spricht" darf nicht ewig hängen
  if (userSpeaking && Date.now() - lastUserActivityAt > 15_000) { userSpeaking = false; trace.add(runSeq, "nutzer-spricht-zurückgesetzt", "kein final nach 15 s"); }
  liveAnswer.tick();
  if (!speech.connected) return;
  const now = Date.now();
  if (voice !== "off" && lastLevelAt && now - lastLevelAt > 5000) { lastLevelAt = now; restartSidecar("Das Sprachmodul reagierte nicht mehr"); return; }
  const oldest = Math.min(Infinity, ...speech.sayTimes.values());
  // nur wenn der Nutzer lange still war: nach einer Unterbrechung fehlen say_start-Meldungen zu Recht
  if (speaking.size === 0 && Number.isFinite(oldest) && now - oldest > 30_000 && now - lastUserActivityAt > 20_000) { speech.sayTimes.clear(); restartSidecar("Die Sprachausgabe hing"); }
}, 2000);
function setVoice(mode: typeof voice) {
  vlog(`setVoice ${voice} -> ${mode}`);
  voice = mode;
  armMicWatch();
  if (mode === "off") voiceOwner = undefined;
  speech.mode(mode);
  if (mode !== "live") userSpeaking = false; // Mikrofon zu: ein offenes speech_start bekommt kein final mehr
  // "muted" schließt nur das Mikrofon; eine laufende Antwort wird weiter gesprochen.
  if (mode === "off") { speechEpoch++; speech.stopSpeaking(); liveAnswer.drop("Live beendet"); }
  else liveAnswer.release();
  broadcast(state());
}
let lastIgnoredOffLog = 0;
function requestVoice(ws: ServerWebSocket<{ kind: string; fresh?: boolean }>, mode: typeof voice) {
  vlog(`voice von ui #${uiId(ws)} ${ws.remoteAddress ?? "?"}: ${mode}`);
  if (mode === "off" && voiceOwner && voiceOwner !== ws) {
    // Kein broadcast(state()): alte Clients antworten auf jeden live-State mit off -> sonst Dauerschleife.
    if (Date.now() - lastIgnoredOffLog > 1000) {
      vlog(`voice:off von ui #${uiId(ws)} ignoriert – Live gehört ui #${uiId(voiceOwner)}`);
      lastIgnoredOffLog = Date.now();
    }
    return;
  }
  voiceOwner = mode === "off" ? undefined : ws;
  setVoice(mode);
}

// ---------- Verlauf (OpenCode-Sitzungen) ----------
async function history() {
  try {
    const list = await (await fetch(`${brain.url}/session`)).json() as any[];
    // Nur echte Unterhaltungen: Testläufe ("Test") und leere Sitzungen ohne eigenen Titel ausblenden
    const isEmpty = (t: string) => !t || t === "Jarvis" || /^New session/i.test(t) || /^Child session/i.test(t);
    return list.filter(s => !s.parentID && s.title !== "Test" && (!isEmpty(s.title) || s.id === session || busySessions.has(s.id)))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .map(s => ({ id: s.id, title: visibleChatTitle(chatMeta[s.id]) || (isEmpty(s.title) ? "Neuer Chat" : s.title),
                   folder: projects.label(projects.chat(s.id)?.projectId ?? null), active: s.id === session, running: busySessions.has(s.id),
                   updated: s.time?.updated ?? 0, pinned: !!chatMeta[s.id]?.pinned, archived: !!chatMeta[s.id]?.archived, projectId: projects.chat(s.id)?.projectId ?? null,
                   project: projects.label(projects.chat(s.id)?.projectId ?? null) }));
  } catch (error) {
    recordError({ category: "model", source: "jarvisd/history", message: "Verlauf von OpenCode nicht abrufbar", error, context: { url: brain.url } });
    return [];
  }
}
const ATTACHMENT_HEADER = "Angehängte Dateien: ";
type SavedAttachments = { text: string; images: PromptImage[]; names: string[] };

function readChatMessage(message: any) {
  const parts = message.parts ?? [];
  const role = message.info?.role;
  const blocks: string[] = [], names: string[] = [], images: PromptImage[] = [], text: string[] = [], visuals: Visual[] = [];
  const order: ({ text: string } | { visual: Visual })[] = []; // Reihenfolge von Text und Grafiken in einer Antwort
  for (const part of parts) {
    if (part.type === "text" && !part.synthetic && typeof part.text === "string") {
      if (role === "user" && part.text.startsWith(ATTACHMENT_HEADER) && part.text.includes("\n")) {
        try {
          const files = JSON.parse(part.text.slice(ATTACHMENT_HEADER.length).split("\n", 1)[0]);
          if (Array.isArray(files) && files.every(name => typeof name === "string")) {
            names.push(...files);
            blocks.push(part.text.slice(part.text.indexOf("\n") + 1));
            continue;
          }
        } catch { /* normaler Nachrichtentext */ }
      }
      text.push(part.text);
      if (role === "assistant") order.push({ text: part.text });
    } else if (part.type === "tool" && typeof part.state?.output === "string") {
      for (const id of markers(part.state.output)) { const v = getVisual(id); if (v) { visuals.push(v); order.push({ visual: v }); } }
    } else if (role === "user" && part.type === "file" && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(part.url)) {
      images.push({ mime: part.mime, url: part.url, filename: part.filename });
    }
  }
  if (!names.length) names.push(...images.map(image => image.filename || "Bild"));
  const view = { id: message.info?.id, role, text: text.join(""), files: names.map(name => ({ name })), visuals, ...(visuals.length ? { order } : {}) };
  return { view, saved: { text: blocks.join("\n\n"), images, names } };
}

async function sessionMessages(id: string) {
  const response = await fetch(`${brain.url}/session/${encodeURIComponent(id)}/message`);
  if (!response.ok) throw new Error(`Nachrichten konnten nicht geladen werden (${response.status})`);
  return (await response.json()) as any[];
}
const chatHistory = (messages: any[], running = false) => {
  if (running) { // die halbfertige Antwort des laufenden Chats weglassen; sie wird aus dem Ereignispuffer nachgereicht
    const lastUser = messages.map(message => message.info?.role).lastIndexOf("user");
    if (lastUser >= 0) messages = messages.slice(0, lastUser + 1);
  }
  return messages.map(message => readChatMessage(message).view).filter(message => message.text || message.files.length || message.visuals.length);
};

async function openSession(id: string) {
  const running = busySessions.has(id);
  const messages = chatHistory(await sessionMessages(id), running);
  session = id;
  return { messages, running: running && busySessions.has(id) };
}

// ---------- Projekte: Sitzungen übernehmen, Zuordnung durch das Modell ----------
const CLASSIFY_MODEL = "opencode/deepseek-v4.1-flash-free";
let analysisRunning = false;
async function syncProjects() {
  try {
    const sessions = await history();
    let changed = false;
    for (const s of sessions) if (projects.upsertChat({ id: s.id, title: s.title, updated: s.updated })) changed = true;
    if (changed) broadcastProjects();
    if (settings.autoProjects) void analyzeProjects();
  } catch (error) {
    recordError({ category: "daemon", source: "jarvisd/projects-sync", message: "Projekte konnten nicht aktualisiert werden", error });
  }
}
async function firstExcerpt(id: string) {
  try {
    const msgs = await (await fetch(`${brain.url}/session/${id}/message`)).json() as any[];
    const first = msgs.find(m => m.info?.role === "user");
    return String((first?.parts ?? []).filter((p: any) => p.type === "text" && !p.synthetic).map((p: any) => p.text).join(" "))
      .replace(/\s+/g, " ").trim().slice(0, 500);
  } catch { return ""; }
}
async function analyzeProjects(manual = false) {
  if (analysisRunning) return;
  const data = projects.data();
  const pending = data.chats.filter(c => !c.projectId && !c.analyzed && c.title !== "Neuer Chat").slice(0, 8);
  if (!data.projects.length || !pending.length) return;
  analysisRunning = true;
  try {
    for (const c of pending) {
      if (!manual && !settings.autoProjects) return;
      const { system, text } = classificationPrompt(projects.data(), c, await firstExcerpt(c.id));
      const parsed = parseClassification(await brain.ask(text, CLASSIFY_MODEL, system), projects.data().projects.map(p => p.id));
      if (!manual && !settings.autoProjects) return;
      if (parsed?.projectId) projects.assign(c.id, parsed.projectId, "ki");
      else projects.markAnalyzed(c.id);
      broadcastProjects();
    }
  } catch (error) {
    recordError({ category: "model", source: "jarvisd/project-analysis", message: "Projektzuordnung fehlgeschlagen", error });
  } finally { analysisRunning = false; }
}

/** Gemeinsamer Weg für HTTP (MCP) und WebSocket (Oberfläche). */
async function projectAction(action: Record<string, any>) {
  const op = String(action.op ?? "");
  if (op === "create") {
    const p = projects.create(String(action.name ?? ""), String(action.description ?? ""), action.parent ? String(action.parent) : null);
    projects.resetAnalysis(); broadcastProjects();
    if (settings.autoProjects) void analyzeProjects();
    return { ok: true, project: p };
  }
  if (op === "update") {
    const p = projects.update(String(action.id), (action.patch ?? {}) as { name?: string; description?: string; parentId?: string | null; pinned?: boolean; archived?: boolean });
    broadcastProjects(); return { ok: true, project: p };
  }
  if (op === "delete") {
    const moved = projects.remove(String(action.id)); broadcastProjects(); return { ok: true, moved };
  }
  if (op === "assign") {
    const by = ["manual", "ki", "auto"].includes(String(action.by)) ? action.by as "manual" | "ki" | "auto" : "manual";
    const c = projects.assign(String(action.id), action.projectId ? String(action.projectId) : null, by);
    broadcastProjects(); return { ok: true, chat: c };
  }
  if (op === "analyze") { projects.resetAnalysis(); broadcastProjects(); void analyzeProjects(true); return { ok: true }; }
  if (op === "sync") { await syncProjects(); broadcastProjects(); return { ok: true, ...projects.data() }; }
  return { ok: false, error: `Unbekannte Projektaktion: ${op}` };
}

// Reihenfolge, in der ersatzweise andere Modelle probiert werden (Stand der Messung 2026-11-20).
const FALLBACKS = ["opencode/nemotron-3.5-lightning-free", "nvidia/minimaxai/minimax-m3.1-flash", "opencode/big-pickle",
  "opencode/longcat-2.5-free", "opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"];
const limited = new Map<string, number>(); // Modell -> gesperrt bis (ms)
const isLimit = (msg: string) => /free usage exceeded|rate.?limit|quota|too many requests|subscribe/i.test(msg);
function nextModel(tried: string[], preferVision = false) {
  const now = Date.now();
  const available = (id: string) => !tried.includes(id) && (limited.get(id) ?? 0) < now;
  if (preferVision) {
    const vision = [settings.model, ...models.filter(m => m.vision && m.group === "free").map(m => m.id)];
    const match = vision.find(id => canSee(id) && available(id));
    if (match) return match;
  }
  return FALLBACKS.find(available);
}

function announcement(e: Extract<BrainEvent, { kind: "tool" }>) {
  const name = e.name.replace(/^jarvis_/, "");
  const input = e.input ?? {};
  let host = "";
  try { host = input.url ? new URL(String(input.url)).host.replace(/^www\./, "") : ""; } catch {}
  const target = name.startsWith("browser_") ? "browser" : "desktop";
  const key = targetKey(target, input.tab ?? input.window ?? desktopScanWindow);
  const label = Number.isInteger(input.id) ? lastTargets.get(key)?.find(t => t.id === input.id)?.label : undefined;
  const short = (t: unknown) => String(t ?? "").replace(/\s+/g, " ").slice(0, 50);
  if (name === "browser_tab_open" || name === "browser_navigate") return `Ich öffne ${host || "die Seite"}, einen Moment.`;
  if (name === "browser_tab_close") return "Ich schließe den Tab, einen Moment.";
  if (name === "browser_back") return "Ich gehe eine Seite zurück, einen Moment.";
  if (name === "webfetch") return `Ich rufe ${host || "die Seite"} ab, einen Moment.`;
  if (name === "desktop_open_app") return `Ich öffne ${input.name ?? "das Programm"}, einen Moment.`;
  if (name === "browser_click" || name === "desktop_click") return label ? `Ich klicke jetzt auf ${short(label)}, einen Moment.` : "Ich klicke jetzt auf die Stelle, einen Moment.";
  if (name === "browser_type" || name === "desktop_type") return label ? `Ich schreibe in ${short(label)}, einen Moment.` : "Ich schreibe den Text, einen Moment.";
  if (name === "desktop_type_text") return "Ich tippe den Text, einen Moment.";
  if (name === "desktop_key") return `Ich drücke ${short(input.combo)}, einen Moment.`;
  if (name === "browser_scroll" || name === "desktop_scroll") return "Ich scrolle ein Stück, einen Moment.";
  if (name.startsWith("browser_")) return "Ich schaue mir die Seite an, einen Moment.";
  if (name === "desktop_windows") return "Ich sehe nach, welche Fenster offen sind, einen Moment.";
  if (name.startsWith("desktop_")) return "Ich sehe mir den Bildschirm an, einen Moment.";
  return "Ich kümmere mich darum, einen Moment.";
}

const canSee = (id: string) => models.find(m => m.id === id)?.vision ?? false;

let runSeq = 0, voiceRun = 0, lastSayAt = 0;   // jeder chat()-Aufruf bekommt eine Nummer; ein abgelöster Lauf darf danach nichts mehr auslösen (z. B. Wiederholung)
type ActiveTurn = { run: number; sid?: string; spoken: boolean; click?: ClickIntent; clickSent?: boolean; clickInFlight?: boolean; firstAction?: Promise<void> };
let activeTurn: ActiveTurn | undefined;
let recentClick: { session: string; intent: ClickIntent; text: string; at: number } | undefined;

function say(text: string) {
  lastSayAt = Date.now();
  recentSaid.push({ text, at: lastSayAt });
  if (recentSaid.length > 10) recentSaid.shift();
  const id = speech.say(text);
  vlog(`say#${id ?? "-"}${speech.connected ? "" : " (Sprachmodul getrennt)"}: ${text.slice(0, 120)}`);
  return id;
}
function waitUntilSpoken(id: number | undefined) {
  if (id === undefined || !speech.sayTimes.has(id)) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); speechStarted.delete(id); resolve(); };
    const timer = setTimeout(done, 1200);
    speechStarted.set(id, done);
  });
}

const announcedActions: Record<string, string> = {
  click: "click", type: "type", typetext: "type_text", key: "key", scroll: "scroll",
  open_app: "open_app", tab_open: "tab_open", navigate: "navigate", back: "back", tab_close: "tab_close",
};

async function announceToolAction(target: "browser" | "desktop", cmd: Record<string, any>) {
  const turn = activeTurn;
  const action = announcedActions[cmd.cmd];
  if (!settings.spokenReplies || !settings.actionAnnouncements || !action || !turn?.spoken || !turn.sid || !busySessions.has(turn.sid) || voice !== "live" || !speech.connected) return true;
  const stopBefore = stoppedUntil;
  const userBefore = speechEpoch;
  if (!turn.firstAction) {
    const line = announcement({ kind: "tool", id: "", status: "running", name: `${target}_${action}`, input: cmd });
    turn.firstAction = waitUntilSpoken(say(line));
  }
  await turn.firstAction;
  return stoppedUntil === stopBefore && latestRun.get(turn.sid) === turn.run && speechEpoch === userBefore;
}

async function chat(text: string, model = settings.model, spoken = false, tried: string[] = [], fresh = false, atts: Attachment[] = [], saved?: SavedAttachments,
                    target?: string | null, replaces?: string) {
  // target: der Chat, an den die Nachricht geht (Standard: der gezeigte); null = neuen Chat anlegen; replaces: der verlorene Chat, den er ersetzt
  const existing = fresh || target === null ? undefined : (target ?? session);
  const runId = ++runSeq;
  let click = requestedClick(text);
  let clickContext: string | undefined;
  if (click?.followUp && recentClick && recentClick.session === existing && Date.now() - recentClick.at < 120_000) {
    click = { ...recentClick.intent, english: click.english };
    clickContext = recentClick.text;
  }
  const turn: ActiveTurn = { run: runId, spoken, click };
  activeTurn = turn;
  if (spoken) voiceRun = runId;
  if (existing) latestRun.set(existing, runId); // ab jetzt gilt ein laufender Lauf dieses Chats als abgelöst
  if (spoken) trace.add(runId, "lauf-start", `model=${model}${tried.length ? ` versuch=${tried.length + 1}` : ""} busy=${isBusy()} text=${JSON.stringify(text.slice(0, 80))}`);
  if (existing && busySessions.has(existing)) await brain.abort(existing);
  // Bilder angehängt, aber das Modell kann nicht sehen: für diese Nachricht auf ein Bildmodell wechseln
  if ((hasImages(atts) || saved?.images.length) && !canSee(model)) {
    const free = (m: ModelInfo) => m.vision && (limited.get(m.id) ?? 0) < Date.now() && !tried.includes(m.id);
    const vm = models.find(m => free(m) && m.group === "free") ?? models.find(free);
    if (vm) { broadcast({ type: "notice", text: `${model.split("/").pop()} kann keine Bilder sehen – für dieses Bild nutze ich ${vm.model}.` }); model = vm.id; }
    else broadcast({ type: "notice", text: `${model.split("/").pop()} kann keine Bilder sehen und es ist kein Bildmodell verfügbar. Wähle in der Modellliste eins mit „Bild“.` });
  }
  if (click?.corner && !canSee(model)) {
    const candidate = nextModel(tried, true);
    if (candidate && canSee(candidate)) model = candidate;
  }
  // Ein Modell, das gerade am Limit ist, gar nicht erst anfragen
  if ((limited.get(model) ?? 0) > Date.now()) {
    const alt = nextModel([...tried, model], !!click?.corner);
    if (alt) { if (!spoken) broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` }); return chat(text, alt, spoken, [...tried, model], fresh, atts, saved, target, replaces); }
  }
  const isNew = !fresh && !existing;
  const sid = fresh ? await brain.createSession("Test") : (existing ?? (session = await brain.createSession()));
  turn.sid = sid; latestRun.set(sid, runId);
  if (isNew) broadcast({ type: "session", id: sid, replaces });
  if (click && !fresh) recentClick = { session: sid, intent: click, text: clickContext ?? text, at: Date.now() };
  // Erste Titelfassung nach der ersten Nachricht; nach der Antwort wird ein thematischer Titel gesetzt.
  if (isNew) {
    const title = provisionalChatTitle(text || atts.map(file => file.name).join(" "));
    if (!chatMeta[sid]?.title) void setSessionTitle(sid, title, true);
  }
  busySessions.add(sid); runBuffer.start(sid); broadcast(state());
  const emit = (msg: Record<string, unknown>) => { const m = { ...msg, session: sid }; runBuffer.add(sid, m as any); broadcast(m); };
  const started = performance.now();
  let first = true, switching = false, finished = false, textSeen = false, toolSeen = false, responseText = "", finalSpeech = "";
  // Nur ein abgelöster Lauf (neue Frage), Stopp oder Live-Ende verhindern das Sprechen. Ein Geräusch während des Nachdenkens
  // (speech_start ohne neue Frage) tut es NICHT mehr; die Antwort wird dann gehalten und nachgeholt (live-turn.ts).
  const maySpeak = () => settings.spokenReplies && spoken && runId === latestRun.get(sid) && voice !== "off" && voice !== "dictate" && !userSpeaking && !pendingUtterance;
  const ackTimer = setTimeout(() => {
    if (maySpeak() && busySessions.has(sid) && !textSeen && !turn.firstAction && Date.now() - lastSayAt >= 2500)
      say("Einen Moment.");
  }, 1300);
  const system = spoken ? SYSTEM_PROMPT + "\n\nIm Sprachmodus übernimmt Jarvis die kurze Ansage vor der Aktion. Arbeite ohne Zwischenkommentare und schreibe am Ende nur die Antwort, die vorgelesen werden soll. Antworte knapp und direkt in vollständigen Sätzen. Wenn der Nutzer um Details bittet oder etwas vorgelesen haben möchte, gib den gewünschten Inhalt vollständig wieder. Erwähne Koordinaten und Elementnummern nur auf Nachfrage." : SYSTEM_PROMPT;
  const attachmentBlocks = saved?.text ? [saved.text] : [];
  const attachmentNames = [...(saved?.names ?? []), ...atts.map(file => file.name)];
  const images = canSee(model) ? [...(saved?.images ?? [])] : [];
  if (atts.length) {
    const prep = await prepare(atts, join(workspace, "uploads"), canSee(model));
    attachmentBlocks.push(prep.text);
    images.push(...prep.images);
    if (prep.notes.length) broadcast({ type: "notice", text: prep.notes.join(" ") });
    for (const p of prep.problems) recordError({ category: "ui", source: "jarvisd/attachment", message: p.message,
      context: { ...p.context, name: p.name, model, session: sid } });
  }
  const attachmentText = attachmentNames.length
    ? ATTACHMENT_HEADER + JSON.stringify(attachmentNames) + "\n" + attachmentBlocks.join("\n\n")
    : "";
  const prompt = clickContext ? `${text}\n\nDer damit gemeinte vorherige Auftrag war: ${clickContext}`
    : text || (attachmentText || images.length ? "Sieh dir die angehängten Dateien an." : "");
  try {
  await brain.prompt(sid, prompt, model, system, (e: BrainEvent) => {
    // Ein Lauf, der von einer neueren Nachricht abgelöst wurde, endet oft "leer" (OpenCode meldet idle vor unserem Abbruch).
    // Früher startete das eine Wiederholung PARALLEL zur neuen Nachricht: zwei Läufe gleichzeitig, die neue Frage ging unter.
    if (runId !== latestRun.get(sid)) {
      if (e.kind === "done" || e.kind === "error") { clearTimeout(ackTimer); if (spoken) trace.add(runId, `ereignis-nach-ablösung ${e.kind}`, e.kind === "done" ? `aborted=${!!e.aborted}` : e.message); }
      if (e.kind === "done" && e.aborted) emit({ type: "done", ...e }); // Oberfläche schließt die abgebrochene Antwort ab
      return;
    }
    if (switching || finished) return;
    if (e.kind === "error" && isLimit(e.message) && !turn.clickSent) {
      limited.set(model, Date.now() + 30 * 60_000);
      const alt = nextModel([...tried, model], !!click?.corner);
      if (alt) {
        switching = true; clearTimeout(ackTimer);
        if (!spoken) broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` });
        brain.abort(sid).then(() => { busySessions.delete(sid); return chat(text, alt, spoken, [...tried, model], fresh, atts, saved, sid); });
        return;
      }
      e = { kind: "error", message: "Alle Gratis-Modelle sind am Limit. Wähle ein lokales Modell (LM Studio) oder warte etwas." };
    }
    if (e.kind === "error") recordError({ category: "model", source: "opencode/prompt", message: e.message,
      context: { model, request: text, mode: settings.mode, spoken, voice, session: sid, retry: e.retry, tried } });
    if (e.kind === "tool" && e.status === "error" && !e.name.startsWith("jarvis_")) // Jarvis-Werkzeuge protokolliert runTool selbst
      recordError({ category: "tool", source: `opencode/${e.name}`, message: e.error ?? "Werkzeug fehlgeschlagen",
        context: { tool: e.name, input: e.input, model, request: text, mode: settings.mode } });
    if (e.kind === "text") {
      textSeen = true;
      responseText += e.delta;
      finalSpeech += e.delta;
    }
    if (e.kind === "tool") {
      const key = `${sid}:${e.id}`;
      if ((e.status === "pending" || e.status === "running") && !runningTools.has(key)) { runningTools.add(key); haptics.pulse("tool"); }  // Aufruf beginnt
      else if ((e.status === "completed" || e.status === "error") && runningTools.delete(key)) haptics.pulse("tool");                    // Aufruf endet
      toolSeen = true;
      if (lastRun) lastRun.toolSeen = true;
      if (e.status === "pending" || e.status === "running") finalSpeech = "";
    }
    // Sitzung existiert nicht mehr (z. B. in OpenCode gelöscht): neue Sitzung anlegen und einmal erneut senden
    if (e.kind === "error" && /Session not found|NotFoundError/i.test(e.message) && !turn.clickSent && !tried.includes("__session")) {
      switching = true; clearTimeout(ackTimer);
      if (!fresh && session === sid) session = undefined;
      brain.abort(sid).catch(() => {}).then(() => { busySessions.delete(sid); return chat(text, model, spoken, [...tried, "__session"], fresh, atts, saved, null, sid); });
      return;
    }
    // Lauf ist zu Ende, aber es kam weder Text noch ein Werkzeugaufruf an: bis zu zweimal automatisch neu versuchen
    // (erst dasselbe Modell, dann ein anderes), damit Jarvis nie wortlos aufhört
    if (e.kind === "done" && !e.aborted && !textSeen && !toolSeen && !turn.clickSent) {
      const attempts = tried.filter(t => t !== "__session").length;
      if (attempts < 2) {
        switching = true; clearTimeout(ackTimer);
        // Ein Modell, das leer antwortet, wird sofort gewechselt (derselbe Versuch scheitert meist wieder, z. B. big-pickle)
        const alt = nextModel([...tried, model], !!click?.corner) ?? model;
        vlog(`Leere Antwort von ${model} – neuer Versuch mit ${alt}`);
        broadcast({ type: "notice", text: attempts === 0 ? "Keine Antwort erhalten – ich versuche es noch einmal." : `Wieder keine Antwort – ich versuche es mit ${alt}.`, session: sid });
        brain.abort(sid).catch(() => {}).then(async () => {
          // die leere Runde samt Nutzer-Nachricht zurücknehmen, sonst steht die Frage nach jedem Versuch noch einmal im Chat
          try {
            const last = (await sessionMessages(sid)).filter(m => m.info?.role === "user").pop();
            if (last?.info?.id) await fetch(`${brain.url}/session/${sid}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageID: last.info.id }) });
          } catch { /* dann eben doppelt */ }
          busySessions.delete(sid); return chat(text, alt, spoken, [...tried, model], fresh, atts, saved, sid);
        });
        return;
      }
      recordError({ category: "model", source: "jarvisd/chat", message: "Antwort ohne Inhalt: Lauf beendet, aber weder Text noch Werkzeugaufruf angekommen",
        context: { model, request: text, mode: settings.mode, spoken, voice, session: sid, tried } });
      emit({ type: "error", message: "Jarvis hat nicht geantwortet. Bitte sag es noch einmal oder wähle ein anderes Modell." });
    }
    if (spoken && e.kind === "tool" && (e.status === "running" || e.status === "error")) trace.add(runId, `werkzeug-${e.status}`, e.name);
    if (spoken && e.kind === "error") trace.add(runId, "fehler", `${e.retry ? "(retry) " : ""}${e.message}`);
    if (e.kind === "text" && first) {
      first = false;
      if (spoken) trace.add(runId, "erster-text", `${Math.round(performance.now() - started)} ms`);
      emit({ type: "latency", firstTokenMs: Math.round(performance.now() - started), model });
    }
    if (e.kind === "done" || e.kind === "error") {
      finished = true;
      haptics.finish();
      for (const key of runningTools) if (key.startsWith(`${sid}:`)) runningTools.delete(key);
      clearTimeout(ackTimer);
      const aborted = e.kind === "done" && e.aborted;
      if (!aborted) {
        const result = click ? clickOutcome(click, !!turn.clickSent) : "";
        const toRead = result || formatLiveSpeech(finalSpeech || (!toolSeen ? responseText : ""), text);
        if (spoken || result) emit({ type: "delta", text: toRead || "Ich konnte die Antwort nicht abschließen." });
        if (spoken) {
          trace.add(runId, `lauf-ende ${e.kind}`, `${Math.round(performance.now() - started)} ms text=${responseText.length} zeichen werkzeug=${toolSeen} voice=${voice}`);
          liveAnswer.deliver(runId, toRead || "Ich konnte die Antwort nicht abschließen.");
        }
      } else if (spoken) trace.add(runId, "lauf-ende abgebrochen");
      busySessions.delete(sid); runBuffer.clear(sid);
      if (activeTurn === turn) activeTurn = undefined;
      broadcast(state());
      if (e.kind === "done" && !aborted && !fresh && (responseText.trim() || toolSeen))
        void refineChatTitle(sid);
    }
    if (e.kind === "text") {
      if (!spoken && !click) { emit({ type: "delta", text: e.delta }); haptics.text(e.delta.length); }
    } else if (e.kind === "reasoning") {
      if (!spoken && !click) emit({ type: "reasoning", text: e.delta });
    } else emit({ type: e.kind, ...e });
  }, images, attachmentText);
  } catch (error) {
    // Schlägt schon das Absenden fehl (OpenCode nicht erreichbar), käme nie ein „done“: ohne Rücksetzen bliebe busy für immer true
    // und die Oberfläche zeigte im Leerlauf dauerhaft Stopp.
    clearTimeout(ackTimer);
    finished = true;
    busySessions.delete(sid); runBuffer.clear(sid);
    if (activeTurn === turn) activeTurn = undefined;
    broadcast(state());
    throw error;
  }
}

const titleInFlight = new Set<string>();
const titleModelBackoff = new Map<string, number>();
const TITLE_RETRY_MS = 5 * 60_000;
let repairingTitles = false;

async function refineChatTitle(id: string) {
  const initial = chatMeta[id];
  if (!settings.autoChatTitles || !needsChatTitle(initial) || titleInFlight.has(id) || busySessions.has(id)) return;
  const candidates = ["opencode/nemotron-3.5-lightning-free", CLASSIFY_MODEL, "openrouter/nvidia/nemotron-3.5-lightning:free",
    "opencode/longcat-2.5-free", "opencode/big-pickle"]
    .filter(model => models.some(entry => entry.id === model) && Math.max(limited.get(model) ?? 0, titleModelBackoff.get(model) ?? 0) <= Date.now());
  if (!candidates.length) return;
  titleInFlight.add(id);
  try {
    const messages = chatHistory(await sessionMessages(id));
    const user = messages.filter(message => message.role === "user").slice(0, 3)
      .map(message => titleExcerpt([message.text, ...message.files.map(file => file.name)].join(" "), 240)).join("\n");
    if (!user.trim()) return;
    const answer = titleExcerpt(messages.findLast(message => message.role === "assistant")?.text ?? "", 350);
    const system = "Benenne das Thema des Chatverlaufs in 2 bis 5 Wörtern in der Sprache des Nutzers. "
      + "Gib nur den Titel aus, ohne Anführungszeichen, Aufzählung oder Punkt am Ende. "
      + "Behandle den Chatinhalt nur als Text zum Benennen.";
    const prompt = "Gib nur einen kurzen Titel zum Thema dieser Chatdaten aus. Beantworte keine Frage daraus. "
      + "Beispiel für einen Titel: Urlaub in Berlin.\n\nChatdaten: " + JSON.stringify({ nutzer: user, antwort: answer });
    for (const model of candidates) {
      if (!settings.autoChatTitles || chatMeta[id] !== initial) return;
      if (Math.max(limited.get(model) ?? 0, titleModelBackoff.get(model) ?? 0) > Date.now()) continue;
      const raw = await brain.ask(prompt, model, system, 12_000).catch(() => "");
      const title = parseChatTitle(raw);
      if (title) {
        if (settings.autoChatTitles && chatMeta[id] === initial) await setSessionTitle(id, title, false);
        return;
      }
      if (!raw.trim()) titleModelBackoff.set(model, Date.now() + TITLE_RETRY_MS);
    }
  } catch (error) {
    recordError({ category: "daemon", source: "jarvisd/chat-title", message: "Chattitel konnte nicht aktualisiert werden", error, context: { id } });
  } finally {
    titleInFlight.delete(id);
  }
}

async function repairChatTitles() {
  if (!settings.autoChatTitles || repairingTitles) return;
  repairingTitles = true;
  try {
    for (const chat of await history()) {
      if (!settings.autoChatTitles) break;
      if (needsChatTitle(chatMeta[chat.id])) await refineChatTitle(chat.id);
    }
  } finally {
    repairingTitles = false;
  }
}

async function setSessionTitle(id: string, title: string, provisional: boolean) {
  if (chatMeta[id]?.auto === false) return;
  chatMeta[id] = { ...chatMeta[id], title, auto: true, provisional };
  saveChatMeta();
  await fetch(`${brain.url}/session/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) }).catch(() => {});
  void syncProjects();
  broadcast({ type: "history", sessions: await history(), folders: folderLabels() });
}
async function updateChat(msg: any) {
  const id = String(msg.id ?? "");
  if (msg.action === "folder") {
    const name = String(msg.name ?? "").trim().slice(0, 50);
    if (name && !projectByLabel(name)) projects.create(name);
  } else if (!id) return;
  else if (msg.action === "rename") {
    const title = String(msg.title ?? "").trim().slice(0, 100);
    if (!title) return;
    chatMeta[id] = { ...chatMeta[id], title, auto: false }; saveChatMeta();
    await fetch(`${brain.url}/session/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
  } else if (msg.action === "pin" || msg.action === "archive") {
    const key = msg.action === "pin" ? "pinned" : "archived";
    chatMeta[id] = { ...chatMeta[id] };
    if (msg.value) chatMeta[id][key] = true; else delete chatMeta[id][key];
    if (key === "archived" && msg.value) delete chatMeta[id].pinned; // Archivierte Chats sind nie angepinnt
    if (key === "pinned" && msg.value) delete chatMeta[id].archived;
    saveChatMeta();
  } else if (msg.action === "move") {
    const folder = String(msg.folder ?? "").trim().slice(0, 100);
    let target = folder ? projectByLabel(folder) : undefined;
    if (folder && !target) target = projects.create(folder);
    projects.upsertChat({ id, title: chatMeta[id]?.title || id });
    projects.assign(id, target?.id ?? null, "manual");
  } else if (msg.action === "delete") {
    if (busySessions.has(id)) await brain.abort(id);
    const response = await fetch(`${brain.url}/session/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Chat konnte nicht gelöscht werden (${response.status})`);
    delete chatMeta[id]; saveChatMeta();
    if (session === id) { session = undefined; broadcast({ type: "session", id: null }); broadcast({ type: "messages", session: null, messages: [] }); }
  }
  broadcast({ type: "history", sessions: await history(), folders: folderLabels() });
}
async function rewindMessage(id: string, messageID: string) {
  if (busySessions.has(id)) await brain.abort(id);
  const response = await fetch(`${brain.url}/session/${id}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageID }) });
  if (!response.ok) throw new Error(`Nachricht konnte nicht zurückgesetzt werden (${response.status})`);
  session = id;
  broadcast({ type: "messages", session: id, messages: chatHistory(await sessionMessages(id)) });
}

// ---------- Live-Ansicht des Ziels, in dem Jarvis gerade arbeitet ----------
function follow(target: PreviewTarget) {
  if (settings.liveView && settings.previewAuto && uis.size > 0) preview.work(target);
}
/** Tabs der Gruppe "Jarvis" (auch "Jarvis …"-Gruppen) für die Auswahl oben in der Vorschau. */
async function jarvisTabs() {
  const mine = settings.internalBrowser && ibrowser.running ? ibrowser.list() : [];
  if (!browser.connected) return mine;
  const r = await browser.call({ cmd: "tab_list" }, 5000).catch(() => undefined);
  const tabs = ((r?.tabs ?? []) as any[]).filter(t => typeof t.group === "string" && /^jarvis/i.test(t.group));
  return [...mine, ...tabs.map(t => ({ tab: t.tab, title: t.title, url: t.url, favicon: t.favicon ?? "", active: !!t.active, chrome: true }))];
}
// Erweiterung veraltet? Neue Versionen lädt sie auf Anweisung selbst; sehr alte (vor 1.2.0) muss der Nutzer einmal neu laden.
const wantedExtension = () => { try { return JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")).version as string; } catch { return ""; } };
const versionNum = (v: string) => v.split(".").reduce((n, x) => n * 1000 + Number(x || 0), 0);
let extensionStale = false;
let attemptedExtensionUpdate = "";
browser.onHello = version => {
  const want = wantedExtension();
  extensionStale = !!want && versionNum(version) < versionNum(want);
  if (extensionStale && versionNum(version) >= versionNum("1.2.0")) {
    const update = `${version}->${want}`;
    if (attemptedExtensionUpdate !== update) {
      attemptedExtensionUpdate = update;
      vlog(`Erweiterung ${version} -> ${want}: lade neu`);
      setTimeout(() => void browser.call({ cmd: "reload" }, 3000).catch(() => {}), 300);
    }
  } else if (extensionStale) {
    broadcast({ type: "notice", text: `Die Chrome-Erweiterung ist veraltet (${version}, aktuell ${want}). Bitte einmal unter chrome://extensions bei „Jarvis“ neu laden – danach aktualisiert sie sich selbst.` });
  }
  broadcast(state());
};
// Bilder des eigenen Browsers gehen binär (4 Byte Kopflänge, JSON-Kopf, JPEG): kein Base64, kein JSON-Zerlegen, schnelleres Dekodieren
ibrowser.onFrame = m => {
  if (!preview.shows(m.tab)) return;
  const { data, ...header } = m;
  const head = Buffer.from(JSON.stringify(header)), jpeg = Buffer.from(String(data), "base64");
  const out = Buffer.allocUnsafe(4 + head.length + jpeg.length);
  out.writeUInt32BE(head.length, 0); head.copy(out, 4); jpeg.copy(out, 4 + head.length);
  for (const ui of uis) ui.send(out);
};
ibrowser.onClosed = tab => preview.ended(tab);
dbrowser.tell = m => broadcast(m);
ibrowser.onNotice = text => broadcast({ type: "notice", text });
ibrowser.onOpened = tab => { if (preview.pinned !== undefined || uis.size > 0) preview.pin(tab); };        // Popup der Seite: gleich zeigen
let tabsTimer: ReturnType<typeof setTimeout> | undefined;
ibrowser.onTabs = () => {                                                                                  // Tab-Leiste in allen Oberflächen aktuell halten
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => broadcast({ type: "tabs", tabs: await jarvisTabs(), windows: await previewWindows(), pinned: preview.pinned ?? null }), 150);
};
browser.onEvent = m => {
  if (m.type === "stream_ended") preview.ended(m.tab);
  else if (m.type === "frame" && preview.shows(m.tab)) broadcast(m);
};

/** Stoppt den gezeigten Chat; mit all=true (Not-Aus) alle laufenden Chats. Die anderen Chats laufen sonst ungestört weiter. */
async function stop(all = false, chat = session) {
  haptics.finish();
  const targets = all ? [...busySessions] : chat && busySessions.has(chat) ? [chat] : [];
  if (all || targets.length >= busySessions.size) stoppedUntil = Date.now() + 1500; // Werkzeuge nur sperren, wenn kein anderer Chat sie braucht
  preview.clear();
  speechEpoch++;
  speech.stopSpeaking();
  if (lastDesktopPoint && Date.now() - lastDesktopPoint.at < 4000 && capture.available())
    void capture.call({ cmd: "cursor_hide" }, 3000);
  lastDesktopPoint = undefined;
  liveAnswer.drop("Stopp");
  trace.add(runSeq, "stopp");
  await Promise.all(targets.map(async sid => {
    await brain.abort(sid);
    busySessions.delete(sid); runBuffer.clear(sid);
    broadcast({ type: "stopped", session: sid });
  }));
  if (!targets.length) broadcast({ type: "stopped", session: chat });
  broadcast(state());
}

// Letzte scan-Ergebnisse je Ziel, damit ein Fehler-Screenshot das betroffene Element markieren kann.
const lastTargets = new Map<string, { id: number; rect: number[]; label?: string }[]>();
const targetKey = (target: string, id: unknown) => `${target}:${id ?? ""}`;

/** Screenshot des Tabs bzw. Bildschirms, die Stellen in `boxes` (Seiten-/Bildschirmkoordinaten) rot umrandet. */
async function errorShot(target: string, tab: unknown, boxes: number[][]): Promise<Uint8Array | undefined> {
  try {
    let png: Uint8Array, rect: number[];
    if (target === "browser") {
      if (!Number.isInteger(tab) || (!ibrowser.owns(tab) && !browser.connected)) return undefined;
      const r = ibrowser.owns(tab) ? await ibrowser.call({ cmd: "shot", tab }) : await browser.call({ cmd: "shot", tab }, 10_000);
      if (!r.ok || typeof r.dataUrl !== "string" || !r.dataUrl.startsWith("data:image/png")) return undefined;
      png = Buffer.from(r.dataUrl.split(",")[1], "base64"); rect = r.rect as number[];
    } else {
      const r = await desktop.call({ cmd: "shot" }, 10_000);
      if (!r.ok || typeof r.path !== "string") return undefined;
      png = new Uint8Array(readFileSync(r.path)); rect = r.rect as number[];
      try { unlinkSync(r.path); } catch { /* temporäre Datei schon weg */ }
    }
    return markPng(png, boxes.map(b => toImageBox(png, rect ?? [0, 0, 0, 0], b)));
  } catch (error) {
    console.error("Fehler-Screenshot nicht möglich:", error);
    return undefined;
  }
}

// Fehler, bei denen ein Bild nichts zeigt (Verbindung, Modus, Nutzer-Stopp, Passwortsperre).
const NO_SHOT = /nicht verbunden|Computer-Steuerung ist aus|vom Nutzer gestoppt|Passwort/i;
/** Werkzeugfehler ins Fehler-Log, bei Bildschirmbezug mit Screenshot; markiert wird das Element (id) bzw. der Bereich (rect). */
async function logToolError(target: string, cmd: Record<string, any>, message: string, opts: { category?: ErrorCategory; source?: string; context?: Record<string, unknown> } = {}) {
  const el = Number.isInteger(cmd.id) ? lastTargets.get(targetKey(target, cmd.tab ?? cmd.window ?? desktopScanWindow))?.find(t => t.id === cmd.id) : undefined;
  const boxes = [el?.rect, Array.isArray(cmd.rect) && cmd.rect.length === 4 ? cmd.rect : undefined].filter(Boolean) as number[][];
  const screenshot = !settings.errorScreenshots || NO_SHOT.test(message) || cmd.cmd === "shot" || cmd.screenshot === false ? undefined : await errorShot(target, cmd.tab, boxes);
  return recordError({ category: opts.category ?? "tool", source: opts.source ?? `${target}/${cmd.cmd}`, message, screenshot,
    context: { tool: `${target}_${cmd.cmd}`, args: cmd, element: el, mode: settings.mode, model: settings.model, voice, busy: isBusy(), ...opts.context } });
}

type DesktopTarget = { id: number; label?: string; axRole?: string; enabled?: boolean; rect: number[] };
let desktopScan: { window: number; app: string; bounds: number[]; token: string; targets: DesktopTarget[]; run?: number } | undefined;

function describeWindowScan(r: Record<string, any>, corner?: ClickIntent["corner"]) {
  if (!corner || !Array.isArray(r.targets) || !Array.isArray(r.bounds)) return;
  const targets = (r.targets as DesktopTarget[]).filter(target => target.enabled !== false && inCorner(target.rect, r.bounds, corner));
  const summary = targets.slice(0, 65).map(target => {
    const center = relativeCenter(target.rect, r.bounds)!;
    return `${target.id} ${target.axRole ?? ""} „${target.label ?? ""}“ · ${Math.round(center[0] * 100)} % von links, ${Math.round(center[1] * 100)} % von oben`;
  }).join("\n");
  r.text = `Fenster „${r.app ?? ""}“, Ausschnitt ${corner}. Koordinaten beziehen sich auf das Fenster.\n`
    + (summary || "Hier ist kein aktiviertes Element erkennbar. Sieh dir das Fenster mit Markierungen an.")
    + "\nKlicke nur ein eindeutig identifiziertes Ziel. Bei Zweifel desktop_look mit derselben Fenster-ID und marks=true.";
}

function guardDesktopClick(cmd: Record<string, any>, turn: ActiveTurn) {
  const intent = turn.click!;
  if (!intent.app && !intent.corner) return {};
  const scan = desktopScan;
  if (!scan || scan.run !== turn.run) return { error: "Zuerst das passende Programmfenster in diesem Auftrag scannen." };
  if (intent.app && scan.app.toLowerCase() !== intent.app.toLowerCase()) {
    return { error: `Das gescannte Fenster gehört nicht zu ${intent.app}.` };
  }
  const target = scan.targets.find(target => target.id === cmd.id);
  if (!target || target.enabled === false) return { error: "Das Ziel fehlt im aktuellen Fenster-Scan." };
  if (intent.corner && !inCorner(target.rect, scan.bounds, intent.corner)) {
    return { error: `Das gewählte Ziel liegt nicht ${intent.corner} im Fenster. Prüfe die markierte Ansicht.` };
  }
  return { window: scan.window, scanToken: scan.token };
}

// ---------- Visualisierungen (visuals.ts) ----------
async function visualize(b: Record<string, any>) {
  if (Date.now() < stoppedUntil) return { ok: false, error: "vom Nutzer gestoppt" };
  const title = String(b.title ?? "").trim() || "Visualisierung";
  let v: Visual;
  try {
    if (b.kind === "python" && typeof b.code === "string" && b.code.trim()) v = await runPython(b.code, title);
    else if (b.kind === "html" && typeof b.html === "string" && b.html.trim()) v = saveHtml(b.html, title);
    else return { ok: false, error: "kind=python mit code oder kind=html mit html erwartet" };
  } catch (error) {
    recordError({ category: "tool", source: "jarvisd/visualize", message: "Visualisierung fehlgeschlagen", error, context: { kind: b.kind, title } });
    return { ok: false, error: String((error as Error)?.message ?? error) };
  }
  if (v.files.length) { // dem Chat zuordnen, der das Werkzeug gerade benutzt
    const sid = activeTurn?.sid && busySessions.has(activeTurn.sid) ? activeTurn.sid : busySessions.size === 1 ? [...busySessions][0] : undefined;
    const m = { type: "visual", ...v, ...(sid ? { session: sid } : {}) };
    if (sid) runBuffer.add(sid, m as any);
    broadcast(m);
  }
  if (v.error && !v.files.length) return { ok: false, error: v.error, stdout: v.stdout };
  return { ok: true, ...v, marker: MARKER(v.id), url: `http://127.0.0.1:${PORT}/visual/${v.id}/` };
}
// Python-Pakete einmal vorab laden, damit die erste Grafik nicht eine Minute braucht
setTimeout(() => { void runPython("import numpy, matplotlib, pandas, scipy, sympy, PIL", "Vorbereitung").catch(() => {}); }, 15_000);

async function runTool(target: string, cmd: Record<string, any>) {
  const turn = activeTurn?.sid && busySessions.has(activeTurn.sid) ? activeTurn : undefined;
  const click = cmd.cmd === "click" && turn?.click ? turn : undefined;
  if (click?.clickSent || click?.clickInFlight) return { ok: false, error: "Für diesen Auftrag wird bereits ein Klick gesendet." };
  if (click) {
    if (target === "browser" && click.click?.app) return { ok: false, error: "Für diesen Auftrag das Programmfenster verwenden." };
    if (target === "desktop") {
      const checked = guardDesktopClick(cmd, click);
      if (checked.error) return { ok: false, error: checked.error };
      cmd = { ...cmd, ...checked };
    }
    click.clickInFlight = true;
  }
  if (target === "desktop" && cmd.cmd === "scan") desktopScan = undefined;
  let r: Record<string, any>;
  try {
    r = await runToolInner(target, cmd);
    if (click && r.ok) click.clickSent = true;
    if (r.ok && cmd.cmd === "click") haptics.pulse("click"); // Webseite oder Computer: ein Klick am Trackpad
  } catch (error) {
    r = { ok: false, error: String((error as Error)?.message ?? error) };
  } finally {
    if (click) click.clickInFlight = false;
  }
  if (r.ok && cmd.cmd === "scan" && Array.isArray(r.targets)) {
    lastTargets.set(targetKey(target, cmd.tab ?? cmd.window ?? desktopScanWindow), r.targets);
    if (target === "desktop" && Number.isInteger(r.window) && typeof r.app === "string" && typeof r.scanToken === "string") {
      desktopScan = { window: r.window, app: r.app, bounds: r.bounds, token: r.scanToken, targets: r.targets, run: turn?.run };
      describeWindowScan(r, turn?.click?.corner);
    }
  }
  if (!r.ok && r.error !== "vom Nutzer gestoppt") void logToolError(target, cmd, String(r.error ?? "Werkzeug fehlgeschlagen"));
  return r;
}

async function runToolInner(target: string, cmd: Record<string, any>) {
  if (Date.now() < stoppedUntil) return { ok: false, error: "vom Nutzer gestoppt" };
  broadcast({ type: "action", target, cmd: cmd.cmd, detail: cmd.url ?? cmd.id ?? cmd.name ?? "" });
  if (target === "browser") {
    if (!await announceToolAction("browser", cmd)) return { ok: false, error: "vom Nutzer gestoppt" };
    if (Number.isInteger(cmd.tab) && !["tab_close", "tab_release"].includes(cmd.cmd) && !dbrowser.owns(cmd.tab)) follow(cmd.tab);
    // Reihenfolge: direkter Browser (echte Seite im Rahmen der Vorschau) > Video-Browser (unsichtbares Chrome als Bildstrom) > echtes Chrome.
    // Chrome nur auf ausdrücklichen Wunsch (in: "chrome") oder wenn nichts anderes geht; in: "video" erzwingt den Video-Browser.
    if (cmd.cmd === "tab_list") {
      const [video, chrome] = await Promise.all([ibrowser.running ? ibrowser.call({ cmd: "tab_list" }) : { ok: true, tabs: [] },
        browser.connected ? browser.call(cmd) : { ok: true, tabs: [] }]);
      const chromeTabs = ((chrome as any).tabs ?? []).map((t: any) => ({ ...t, chrome: true }));
      return { ok: true, tabs: [...dbrowser.list(), ...((video as any).tabs ?? []), ...chromeTabs], ...(chrome.ok ? {} : { chromeError: chrome.error }) };
    }
    if (dbrowser.owns(cmd.tab)) return dbrowser.call(cmd);
    if (ibrowser.owns(cmd.tab)) { const r = await ibrowser.call(cmd); return r; }
    if (cmd.cmd === "tab_open" && cmd.in !== "chrome" && settings.internalBrowser) {
      if (cmd.in !== "video") {
        const r = await dbrowser.open(urlFor(cmd.url ?? "about:blank"), uis.size);
        if (r.ok) return r;
        if (typeof r.tab === "number") { dbrowser.tell({ type: "dt_close", id: r.tab }); dbrowser.setTabs(dbrowser.list().filter(t => t.tab !== r.tab).map(t => ({ id: t.tab, url: t.url, title: t.title }))); }
        vlog(`direkter Browser: ${r.error} – weiche auf den Video-Browser aus`);
      }
      if (ibrowser.available()) { const r = await ibrowser.call(cmd); if (r.ok && Number.isInteger(r.tab)) follow(r.tab as number); return r; }
    }
    const r = await browser.call(cmd);
    if (cmd.cmd === "tab_open" && r.ok && Number.isInteger(r.tab)) follow(r.tab as number);
    return r;
  }
  if (settings.mode !== "computer" && !["scan", "read", "shot", "displays", "windows"].includes(cmd.cmd))
    return { ok: false, error: "Computer-Steuerung ist aus (Modus: nur Browser). Nutzer bitten, sie einzuschalten." };
  if (!await announceToolAction("desktop", cmd)) return { ok: false, error: "vom Nutzer gestoppt" };
  if (cmd.cmd === "open_app") {
    const p = process.platform === "win32" ? Bun.spawn(["cmd", "/c", "start", "", cmd.name]) : Bun.spawn(["open", "-a", cmd.name]);
    const code = await p.exited;
    return code === 0 ? { ok: true } : { ok: false, error: `Programm „${cmd.name}“ nicht geöffnet (Exit-Code ${code})` };
  }
  const window = Number.isInteger(cmd.window) ? cmd.window as number
    : cmd.cmd === "scan" ? undefined : desktopScanWindow;
  if (window !== undefined && !["windows", "displays"].includes(cmd.cmd)) follow(`win:${window}`);
  // Fensterbild über den Aufnahme-Dienst (auch verdeckt); geht das nicht, macht uimap ein Bild des sichtbaren Bereichs
  if (cmd.cmd === "shot" && Number.isInteger(cmd.window) && !cmd.marks && capture.available()) {
    const r = await capture.call({ cmd: "windowshot", window: cmd.window });
    if (r.ok) return r;
    vlog(`Aufnahme-Dienst: ${r.error}`);
  }
  const r = await desktop.call(cmd);
  if (Array.isArray(r.point)) {
    lastDesktopPoint = { window, point: r.point as [number, number], at: Date.now() };
    // violetter Jarvis-Zeiger im ECHTEN Fenster (Overlay im Aufnahme-Dienst) und im Live-Bild
    if (capture.available()) void capture.call({ cmd: "cursor", point: r.point, click: cmd.cmd === "click" }, 3000);
  }
  if (cmd.cmd === "scan") desktopScanWindow = r.ok ? window : undefined;
  return r;
}

// ---------- Erweiterungen: Schrägstrich-Befehle, Skills, MCP, Plugins, Import ----------
const ocGet = async (path: string): Promise<any> => { try { return await (await fetch(`${brain.url}${path}`, { signal: AbortSignal.timeout(4000) })).json(); } catch { return undefined; } };
const skillSource = (loc: string) => /built-in/i.test(loc) ? "OpenCode" : loc.includes("/workspace/.opencode/") ? "Jarvis" : loc.includes("/.claude/") ? "Claude" : loc.includes("/.codex/") ? "Codex"
  : loc.includes("/.config/opencode/") ? "OpenCode" : loc.includes("/.agents/") ? "Agents" : "Sonstige";
const BUILTIN_COMMANDS = [
  { name: "neu", description: "Neuen Chat beginnen" }, { name: "stop", description: "Laufende Antwort abbrechen" },
  { name: "modell", description: "Modell wählen, z. B. /modell nemotron", hint: "Name" }, { name: "live", description: "Sprachmodus starten" },
  { name: "diktat", description: "Diktieren starten" }, { name: "vorschau", description: "Tab- und Fenster-Vorschau öffnen" },
  { name: "projekte", description: "Projekte öffnen" }, { name: "einstellungen", description: "Einstellungen öffnen" },
  { name: "erweiterungen", description: "MCP, Skills, Befehle und Plugins verwalten" }, { name: "import", description: "Aus Claude, Codex oder OpenCode importieren" },
  { name: "hilfe", description: "Alle Befehle anzeigen" },
];
async function commandList() {
  const oc: any[] = (await ocGet("/command")) ?? [];
  const items = oc.filter(c => c.source !== "skill").map(c => ({ name: c.name, description: String(c.description ?? "").slice(0, 160), source: "command", hint: c.hints?.length ? "Argumente" : undefined }));
  const taken = new Set([...BUILTIN_COMMANDS.map(c => c.name), ...FUNCTION_COMMANDS.map(c => c.name), ...items.map(c => c.name)]);
  const skills = enabledSkills().filter(sk => !taken.has(sk.name)).map(sk => ({ name: sk.name, description: sk.description.slice(0, 160), source: "skill", hint: "Aufgabe" }));
  return [...BUILTIN_COMMANDS.map(c => ({ ...c, source: "builtin" })), ...FUNCTION_COMMANDS.map(c => ({ name: c.name, description: c.description, hint: c.hint, source: "function" })), ...items, ...skills];
}
async function extensionState() {
  const store = loadStore();
  const status: Record<string, any> = (await ocGet("/mcp")) ?? {};
  const configured = (await ocGet("/config"))?.mcp ?? {};
  const definitions: Record<string, any> = { ...BASE_OPENCODE_CONFIG.mcp, ...configured };
  const names = new Set([...Object.keys(definitions), ...Object.keys(status), ...Object.keys(store.mcp)]);
  const mcp = [...names].map(name => {
    const builtin = name === "jarvis";
    const managed = !builtin && Object.hasOwn(store.mcp, name);
    const definition = definitions[name];
    const enabled = managed ? store.mcp[name].enabled
      : store.mcpOverrides?.[name] ?? (definition?.enabled !== false && status[name]?.status !== "disabled");
    return { name, builtin, managed, enabled, type: (managed ? store.mcp[name] : definition)?.type ?? "local",
      detail: builtin ? "Browser- und Desktop-Werkzeuge" : managed ? mcpSummary(store.mcp[name]) : "Aus OpenCode",
      status: enabled ? status[name]?.status ?? "unbekannt" : "disabled", error: enabled ? status[name]?.error : undefined };
  });
  const skills = skillCatalog(store).map(sk => ({ name: sk.name, description: sk.description.slice(0, 200), source: skillSource(sk.path), disabled: !sk.enabled }));
  const commands = Object.entries(store.commands).map(([name, c]) => ({ name, description: c.description, source: c.source, custom: true }));
  return { type: "extensions", mcp, skills, commands, plugins: store.plugins };
}
/** Konfiguration neu schreiben und OpenCode neu laden (Befehle, Skills, MCP, Plugins). */
async function reloadExtensions() {
  writeWorkspace(workspace, BASE_OPENCODE_CONFIG);
  const response = await fetch(`${brain.url}/instance/dispose`, { method: "POST", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`OpenCode konnte Erweiterungen nicht neu laden (${response.status}).`);

}
async function extensionMessage(msg: any): Promise<any> {
  const store = loadStore();
  if (msg.type === "ext_scan") return { type: "ext_scan", from: msg.from, items: scanImport(msg.from as Source, store).map(c => ({ ...c })) };
  if (msg.type === "ext_import") {
    const all = scanImport(msg.from as Source, store);
    const wanted = new Set<string>(Array.isArray(msg.ids) ? msg.ids : []);
    const picked = all.filter(c => wanted.has(c.id));
    const counts = applyImport(picked as Candidate[], store);
    await reloadExtensions();
    broadcast({ type: "notice", text: `Importiert aus ${msg.from}: ${counts.mcp} MCP, ${counts.skill} Skills, ${counts.command} Befehle, ${counts.plugin} Plugins.` });
    return await extensionState();
  }
  if (msg.type === "ext_mcp") {
    const name = String(msg.name ?? "").trim();
    if (msg.op === "remove" && name !== "jarvis" && Object.hasOwn(store.mcp, name)) delete store.mcp[name];
    else if (msg.op === "toggle" && typeof msg.enabled === "boolean") {
      if (name !== "jarvis" && Object.hasOwn(store.mcp, name)) store.mcp[name].enabled = msg.enabled;
      else {
        const configured = (await ocGet("/config"))?.mcp;
        if (name !== "jarvis" && !Object.hasOwn(configured ?? {}, name))
          return { type: "error", message: "Dieser MCP-Server ist in OpenCode nicht konfiguriert." };
        const latest = loadStore();
        latest.mcpOverrides = { ...latest.mcpOverrides, [name]: msg.enabled };
        saveStore(latest); await reloadExtensions();
        return await extensionState();
      }
    }
    else if (msg.op === "add") {
      const raw = msg.entry ?? {};
      const entry: McpEntry | undefined = raw.url
        ? { type: "remote", url: String(raw.url), headers: raw.headers, enabled: true, source: "manual" }
        : String(raw.command ?? "").trim() ? { type: "local", command: String(raw.command).trim().split(/\s+/), environment: raw.environment, enabled: true, source: "manual" } : undefined;
      if (!name || !entry) return { type: "error", message: "MCP-Server braucht einen Namen und einen Befehl oder eine URL." };
      const key = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
      if (key === "jarvis") return { type: "error", message: "Der Name „jarvis“ gehört zum eingebauten MCP-Server." };
      store.mcp[key] = entry;
    }
    saveStore(store); await reloadExtensions();
    return await extensionState();
  }
  if (msg.type === "ext_skill") {
    const name = String(msg.name ?? "");
    if (msg.remove) delete store.skillDirs[name];   // importierten Skill wieder entfernen (Verknüpfung)
    store.disabledSkills = store.disabledSkills.filter(n => n !== name);
    if (msg.enabled === false) store.disabledSkills.push(name);
    saveStore(store); await reloadExtensions();
    return await extensionState();
  }
  if (msg.type === "ext_command") {
    const name = String(msg.name ?? "").toLowerCase().replace(/[^a-z0-9äöüß_-]+/g, "-");
    if (msg.op === "remove") delete store.commands[name];
    else if (msg.op === "add" && name && String(msg.template ?? "").trim())
      store.commands[name] = { description: String(msg.description ?? "").slice(0, 200), template: String(msg.template), source: "manual" };
    else return { type: "error", message: "Befehl braucht einen Namen und einen Text." };
    saveStore(store); await reloadExtensions();
    return await extensionState();
  }
  if (msg.type === "ext_plugin") {
    const name = String(msg.name ?? "").trim();
    if (msg.op === "remove") store.plugins = store.plugins.filter(p => p !== name);
    else if (msg.op === "add" && name && !store.plugins.includes(name)) store.plugins.push(name);
    saveStore(store); await reloadExtensions();
    return await extensionState();
  }
  return { type: "error", message: "Unbekannte Erweiterungsaktion" };
}

// ---------- Live-Bild eines Fensters, das Jarvis bedient (Aufnahme-Dienst, virtuelle Maus) ----------
const capture = new Capture();
let desktopScanWindow: number | undefined;
let lastDesktopPoint: { window?: number; point: [number, number]; at: number } | undefined;
let lowFpsNoticeAt = 0;
let windowCaptureRun = 0;

function windowFrame(win: number, m: Record<string, any>) {
  if (!preview.shows(`win:${win}`)) return;
  const cursor = lastDesktopPoint?.window === win && Date.now() - lastDesktopPoint.at < 4000 ? lastDesktopPoint.point : undefined;
  broadcast({ type: "frame", tab: `win:${win}`, data: m.data, w: m.w, h: m.h, bounds: m.bounds,
    title: m.title ? `${m.app} – ${m.title}` : m.app, url: "", cursor });
}
capture.onEvent = m => {
  if (m.event === "frame") windowFrame(m.window, m);
  else if (m.event === "stream_ended") preview.ended(`win:${m.window}`);
};

/** Rückfall ohne Bildschirmaufnahme-Freigabe: Einzelbilder des sichtbaren Fensterbereichs über uimap. */
async function windowFallbackLoop(win: number, run: number) {
  const target = `win:${win}` as const;
  const running = () => windowCaptureRun === run && preview.active === target;
  while (running()) {
    const frame = await desktop.call({ cmd: "framejpeg", window: win, maxWidth: 1280 }, 6000).catch(() => undefined);
    if (!running()) return;
    if (!frame?.ok) {
      vlog(`Fenster-Vorschau (Rückfall) beendet: ${frame?.error ?? "keine Antwort"}`);
      if (preview.pinned === target) broadcast({ type: "notice", text: "Fenster-Vorschau nicht verfügbar." });
      preview.ended(target);
      return;
    }
    windowFrame(win, frame);
    await Bun.sleep(80);
  }
}

const preview = new Preview({
  async start(target) {
    if (typeof target === "number") {
      const r = ibrowser.owns(target) ? await ibrowser.call({ cmd: "stream_start", tab: target }) : await browser.call({ cmd: "stream_start", tab: target }, 8000);
      if (!r.ok && preview.pinned === target) broadcast({ type: "notice", text: `Tab-Vorschau nicht möglich: ${r.error ?? "unbekannter Fehler"}` });
      return r.ok;
    }
    const win = Number(target.slice(4));
    const r = capture.available() ? await capture.call({ cmd: "stream_start", window: win, fps: 20 }, 10_000)
      : { ok: false, error: "kein Aufnahme-Dienst" };
    if (!r.ok) {
      vlog(`Fenster-Live-Bild über den Aufnahme-Dienst nicht möglich (${r.error}) – Rückfall auf Einzelbilder`);
      if (/TCC|abgelehnt|Freigabe/i.test(String(r.error)) && Date.now() - lowFpsNoticeAt > 10 * 60_000) {
        lowFpsNoticeAt = Date.now();
        broadcast({ type: "notice", text: "Für ein flüssiges Fensterbild „Jarvis Bildschirm“ unter Bildschirmaufnahme erlauben." });
      }
      void windowFallbackLoop(win, ++windowCaptureRun);
    }
    return true;
  },
  async stop(target) {
    if (typeof target === "number") await (ibrowser.owns(target) ? ibrowser.call({ cmd: "stream_stop", tab: target }) : browser.call({ cmd: "stream_stop", tab: target }, 5000));
    else {
      windowCaptureRun++;
      if (capture.available()) await capture.call({ cmd: "stream_stop" }, 4000);
    }
  },
  idle: () => broadcast({ type: "viewer_idle" }),
}, { settle: 450, hold: 1800, idle: settings.previewIdleSeconds * 1000 });
/** Fenster für die Auswahl oben in der Vorschau */
async function previewWindows() {
  const r: any = await desktop.call({ cmd: "windows" }, 5000).catch(() => ({}));
  return (Array.isArray(r?.windows) ? r.windows : [])
    .filter((w: any) => w.title && w.rect?.[3] >= 150 && w.pid !== ibrowser.pid && !/^Jarvis/.test(w.title) && !/AuthWarn|UserNotificationCenter|loginwindow/i.test(w.app))
    .slice(0, 12).map((w: any) => ({ id: w.id, app: w.app, title: w.title, onScreen: w.onScreen }));
}

Bun.serve<{ kind: string; fresh?: boolean }, {}>({
  port: PORT, hostname: "127.0.0.1",
  async fetch(req, srv) {
    try { return await route(req, srv); } catch (error) {
      recordError({ category: "daemon", source: "jarvisd/http", message: String((error as Error)?.message ?? error), error,
        context: { method: req.method, path: new URL(req.url).pathname } });
      return Response.json({ ok: false, error: String(error) }, { status: 500 });
    }
  },
  websocket: {
    maxPayloadLength: 48 * 1024 * 1024, // Anhänge kommen Base64-kodiert (bis ~25 MB Dateien)
    open(ws) {
      if ((ws.data.kind as string) === "page") return;
      if (ws.data.kind === "browser") { browser.attach(ws); broadcast(state()); }
      else {
        vlog(`ui #${uiId(ws)} open ${ws.remoteAddress ?? "?"} fresh=${!!ws.data.fresh}`);
        // Erste Oberfläche nach Start/Neuladen: neuer Chat (die Oberfläche zeigt ohnehin einen leeren Chat)
        if (uis.size === 0 && !ws.data.fresh) session = undefined;
        uis.add(ws); ws.send(JSON.stringify(state())); ws.send(JSON.stringify({ type: "projects", ...projects.data() })); history().then(s => ws.send(JSON.stringify({ type: "history", sessions: s, folders: folderLabels() })));
        ws.send(JSON.stringify({ type: "projects", ...projects.data() })); void syncProjects();
      }
    },
    close(ws) {
      if ((ws.data.kind as string) === "page") { dbrowser.detach(ws as unknown as PageSocket); return; }
      if (ws.data.kind === "browser") {
        browser.detach(ws);
        if (!browser.connected && typeof preview.active === "number") preview.ended(preview.active);
        broadcast(state());
      }
      else {
        vlog(`ui #${uiId(ws)} close`);
        uis.delete(ws); uiFocus.delete(ws);
        if (uis.size === 0) preview.clear();
        // Wer Live gestartet hat und die Verbindung verliert, beendet es. Das gilt auch, wenn andere UIs noch offen sind.
        if (voiceOwner === ws) { vlog(`voice-owner ui #${uiId(ws)} weg -> off`); setVoice("off"); }
        // Keine Oberfläche mehr offen: Mikrofon zu, nichts mehr sprechen.
        else if (uis.size === 0 && voice !== "off") setVoice("off");
      }
    },
    async message(ws, raw) {
      if ((ws.data.kind as string) === "page") { dbrowser.receive(ws as unknown as PageSocket, String(raw)); return; }
      try { await socketMessage(ws, String(raw)); } catch (error) {
        recordError({ category: ws.data.kind === "browser" ? "extension" : "daemon", source: `jarvisd/ws-${ws.data.kind}`,
          message: String((error as Error)?.message ?? error), error, context: { bytes: String(raw).length } });
      }
    },
  },
});

// ---------- Fehler-Log-API (docs/errors.md) ----------
async function errorsRoute(req: Request, u: URL): Promise<Response | undefined> {
  if (u.pathname === "/errors" && req.method === "GET") return Response.json(listErrors(u.searchParams.get("category") ?? undefined));
  if (u.pathname === "/errors" && req.method === "POST") { // Meldung von Oberfläche, Erweiterung, MCP (error_report) oder anderen Prozessen
    const b = await req.json().catch(() => undefined) as Record<string, any> | undefined;
    if (!b || typeof b !== "object") return Response.json({ ok: false, error: "JSON-Objekt erwartet" }, { status: 400 });
    const category: ErrorCategory = CATEGORIES.includes(b.category) ? b.category : "tool";
    const message = String(b.message ?? "").trim();
    if (!message) return Response.json({ ok: false, error: "message fehlt" }, { status: 400 });
    const source = String(b.source ?? "http/report");
    const entry = b.screenshot === false || (b.target !== "browser" && b.target !== "desktop")
      ? recordError({ category, source, message, context: { ...b.context, mode: settings.mode, model: settings.model } })
      : await logToolError(b.target, { cmd: "report", tab: b.tab, id: b.id, rect: b.rect }, message, { category, source, context: b.context });
    return Response.json(entry ? { ok: true, id: entry.id, screenshot: !!entry.screenshot } : { ok: false, error: "nicht geschrieben" });
  }
  const m = u.pathname.match(/^\/errors\/([0-9a-f]{12})(\/resolve)?$/);
  if (m && (req.method === "DELETE" || (req.method === "POST" && m[2]))) {
    const ok = resolveError(m[1]);
    return Response.json(ok ? { ok } : { ok, error: "unbekannte Fehler-ID" }, { status: ok ? 200 : 404 });
  }
  return undefined;
}

async function route(req: Request, srv: any) {
    const u = new URL(req.url);
    // Seiten des direkten Browsers: Unterdomain p<hex>.localhost -> fremde Seite über den Proxy
    const hostLabel = webProxy.labelOf(req.headers.get("host") ?? "");
    if (hostLabel) return webProxy.handle(req, hostLabel);
    if (u.pathname === "/page") { // Agent in einer Seite des direkten Browsers
      const origin = req.headers.get("origin");
      let host = ""; try { host = origin ? new URL(origin).host : ""; } catch { /* kein Ursprung */ }
      if (!webProxy.isProxyHost(host)) return new Response("verboten", { status: 403 });
      return srv.upgrade(req, { data: { kind: "page" } }) ? undefined : new Response("upgrade", { status: 400 });
    }
    if (u.pathname === "/skills") return Response.json(enabledSkills().map(sk => ({ name: sk.name, description: sk.description })));   // für skill_list (mcp.ts)
    if (u.pathname.startsWith("/skills/")) return Response.json(readSkill(decodeURIComponent(u.pathname.slice(8))));                   // für skill_read
    if (u.pathname === "/__jarvis__/open") { // Navigation zu einer echten Adresse: in den Proxy umleiten
      const target = webProxy.proxify(u.searchParams.get("u") ?? "");
      return target ? Response.redirect(target, 302) : new Response("ungültige Adresse", { status: 400 });
    }
    if (u.pathname.startsWith("/errors")) { const r = await errorsRoute(req, u); if (r) return r; }
    if (u.pathname === "/browser" || u.pathname === "/ui")
      return srv.upgrade(req, { data: { kind: u.pathname.slice(1), fresh: u.searchParams.has("fresh") } }) ? undefined : new Response("upgrade", { status: 400 });
    // "/app" ohne Schrägstrich würde die relativen Pfade (styles.css, app.js) auf "/styles.css" auflösen: ungestylte Seite. Darum umleiten.
    if (u.pathname === "/" || u.pathname === "/app") return Response.redirect(new URL("/app/", u), 302);
    if (u.pathname.startsWith("/app/")) { // Oberfläche zum Testen im Browser
      const rel = u.pathname.replace(/^\/app\/?/, "").replace(/^\/$/, "") || "index.html";
      const file = Bun.file(join(ROOT, "app/ui", rel.replace(/\.\.+/g, "")));
      return (await file.exists()) ? new Response(file) : new Response("nicht gefunden", { status: 404 });
    }
    if (u.pathname === "/health") return Response.json({ ok: true, opencode: await brain.healthy(), browser: browser.connected });
    if (u.pathname === "/usage") return Response.json(summarize(readUsage(), parseRange(u.searchParams.get("range"))));
    if (u.pathname === "/models") return Response.json(models = await listModels());
    if (u.pathname === "/projects" && req.method === "GET") return Response.json(projects.data());
    if (u.pathname === "/projects" && req.method === "POST") {
      const r = await projectAction(await req.json() as Record<string, any>);
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    if (u.pathname.startsWith("/visual/") && req.method === "GET") return serveVisual(u.pathname);
    if (u.pathname === "/visualize" && req.method === "POST") return Response.json(await visualize(await req.json() as Record<string, any>));
    if (u.pathname === "/tool" && req.method === "POST") {
      const { target, cmd } = await req.json();
      return Response.json(await runTool(target, cmd));
    }
    if (u.pathname === "/stop" && req.method === "POST") { await stop(true); return Response.json({ ok: true }); }
    if (u.pathname === "/chat" && req.method === "POST") { // für Tests ohne UI
      const { text, model } = await req.json(); await chat(text, model); return Response.json({ ok: true });
    }
    return new Response("jarvisd", { status: 404 });
}

async function socketMessage(ws: ServerWebSocket<{ kind: string; fresh?: boolean }>, raw: string) {
      if (ws.data.kind === "browser") return browser.receive(raw);
      const msg = JSON.parse(raw);
      // Die Oberfläche sagt, in welchem Chat sie gerade ist (null = neuer Chat); sie bestimmt, wohin die Nachricht geht.
      if ((msg.type === "chat" || msg.type === "run_command") && "session" in msg) session = msg.session ? String(msg.session) : undefined;
      if (msg.type === "chat" || msg.type === "resend" || msg.type === "replace") {
        const atts: Attachment[] = Array.isArray(msg.attachments) ? msg.attachments : [];
        const bad = validate(atts);
        if (bad) {
          recordError({ category: "ui", source: "jarvisd/attachment", message: bad, context: { count: atts.length } });
          ws.send(JSON.stringify({ type: "error", message: bad }));
          return;
        }
        const text = String(msg.text ?? "");
        if (msg.type === "chat") {
          if (text.trim() || atts.length) await chat(text, msg.model, false, [], ws.data.fresh, atts);
        } else {
          const id = String(msg.id), messageID = String(msg.messageID);
          const original = (await sessionMessages(id)).find(message => message.info?.id === messageID && message.info.role === "user");
          if (!original) throw new Error("Nachricht nicht gefunden");
          const { view, saved } = readChatMessage(original);
          const nextText = msg.type === "resend" ? view.text : text;
          await rewindMessage(id, messageID);
          const files = [...view.files, ...atts.map(file => ({ name: file.name }))];
          broadcast({ type: "user", text: nextText, files });
          await chat(nextText, settings.model, false, [], false, atts, saved);
        }
      }
      else if (msg.type === "client_error") recordError({ category: "ui", source: "app/ui", message: String(msg.message ?? "Fehler in der Oberfläche"),
        context: { where: msg.where, stack: String(msg.stack ?? "").slice(0, 2000), voice, mode: settings.mode } });
      else if (msg.type === "stop") await stop(!!msg.all, msg.session ? String(msg.session) : session);
      else if (msg.type === "settings" || msg.type === "liveview") {
        const patch = msg.type === "settings" ? parseSettings(msg.settings) : parseSettings({ liveView: msg.on });
        for (const [key, nameKey, side] of [["micDevice", "micName", "input"], ["speakerDevice", "speakerName", "output"]] as const) {
          if (!(key in patch)) continue;
          const selected = audioDevices?.[side].find(d => d.id === patch[key]);
          if (patch[key] !== null && !selected) { delete patch[key]; continue; }
          patch[nameKey] = selected?.name ?? null;
        }
        const previous = settings;
        settings = { ...settings, ...patch };
        save();
        if ((previous.liveView && !settings.liveView) || (previous.previewAuto && !settings.previewAuto && preview.pinned === undefined))
          preview.clear();
        if (settings.previewIdleSeconds !== previous.previewIdleSeconds) preview.setIdle(settings.previewIdleSeconds * 1000);
        if (settings.spokenReplies !== previous.spokenReplies && !settings.spokenReplies) speech.stopSpeaking();
        if (["lofi", "micDevice", "speakerDevice", "sttMode", "voicePreset", "voiceSpeed"].some(key => key in patch))
          configureSpeech("micDevice" in patch || "speakerDevice" in patch);
        if (settings.autoProjects && !previous.autoProjects) void analyzeProjects();
        if (settings.autoChatTitles && !previous.autoChatTitles) void repairChatTitles();
        broadcast(state());
      }
      else if (msg.type === "voice_sample") {
        const ok = speech.connected && !busySessions.size && voice === "off" && speaking.size === 0 && speech.sayTimes.size === 0;
        if (ok) say("Hallo, ich bin Jarvis. So klingt meine Stimme.");
        ws.send(JSON.stringify({ type: "voice_sample", ok }));
      }
      else if (msg.type === "tabs") {
        const [tabs, windows] = await Promise.all([jarvisTabs(), previewWindows()]);
        ws.send(JSON.stringify({ type: "tabs", tabs, windows, pinned: preview.pinned ?? null }));
      }
      else if (msg.type === "dt_new") dbrowser.tell({ type: "dt_open", id: dbrowser.allocate(), url: urlFor(msg.url ?? "about:blank") });      // „Neuer Tab“ in der Vorschau
      else if (msg.type === "dt_blocked" && Number.isInteger(msg.id)) dbrowser.blocked(msg.id);
      else if (msg.type === "dt_tabs" && Array.isArray(msg.tabs)) dbrowser.setTabs(msg.tabs.filter((t: any) => dbrowser.owns(t?.id)).map((t: any) => ({ id: t.id, url: String(t.url ?? ""), title: String(t.title ?? "") })));
      else if (msg.type === "ib") { // Bedienung des Video-Browsers aus der Vorschau
        const op = String(msg.op ?? "");
        if (!["new", "navigate", "back", "forward", "reload", "close", "resize", "input", "copy"].includes(op)) return;
        const r = await ibrowser.call(op === "new" ? { cmd: "tab_open", url: msg.url ?? "about:blank" } : { cmd: op, tab: msg.tab, url: msg.url, w: msg.w, h: msg.h, dpr: msg.dpr, event: msg.event });
        if (op === "copy") { if (r.ok && typeof r.text === "string") ws.send(JSON.stringify({ type: "ib_clipboard", text: r.text })); return; }
        if (op === "new" && r.ok) { preview.pin(r.tab as number); ibrowser.onTabs?.(); }
        else if (!r.ok && op !== "input" && op !== "resize") ws.send(JSON.stringify({ type: "notice", text: `Browser: ${r.error}` }));
      }
      else if (msg.type === "viewer_tab" && settings.liveView) {
        if (Number.isInteger(msg.tab)) preview.pin(msg.tab);
        else if (settings.previewAuto) preview.pin();
        else preview.clear();
      }
      else if (msg.type === "viewer_window" && settings.liveView && Number.isInteger(msg.window)) preview.pin(`win:${msg.window}`);
      else if (msg.type === "voice") requestVoice(ws, msg.mode);
      else if (msg.type === "focus") uiFocus.set(ws, msg.focused === true);
      else if (msg.type === "theme") { uiDark = msg.dark !== false; setVisualTheme(uiDark ? "dark" : "light"); ibrowser.setTheme(msg.dark !== false); }   // hell/dunkel der Oberfläche (Systemmodus eingeschlossen)
      else if (msg.type === "history") { ws.send(JSON.stringify({ type: "history", sessions: await history(), folders: folderLabels() })); void syncProjects(); }
      else if (msg.type === "open") {
        const id = String(msg.id);
        const opened = await openSession(id);
        ws.send(JSON.stringify({ type: "messages", session: id, messages: opened.messages, running: opened.running }));
        if (opened.running) for (const event of runBuffer.get(id)) ws.send(JSON.stringify(event)); // halbfertige Antwort nachreichen
      }
      else if (msg.type === "message_ids") { // IDs der Nutzer-Nachrichten, damit Bearbeiten/Erneut senden auch bei gerade geschriebenen Nachrichten gehen
        const id = String(msg.id ?? "");
        const users = id ? chatHistory(await sessionMessages(id)).filter(m => m.role === "user") : [];
        ws.send(JSON.stringify({ type: "message_ids", session: id, users }));
      }
      else if (msg.type === "commands") ws.send(JSON.stringify({ type: "commands", items: await commandList() }));
      else if (msg.type === "ext_list") ws.send(JSON.stringify(await extensionState()));
      else if (typeof msg.type === "string" && msg.type.startsWith("ext_")) {
        try {
          ws.send(JSON.stringify(await extensionMessage(msg)));
          if (msg.type === "ext_skill" || msg.type === "ext_import")
            broadcast({ type: "commands", items: await commandList() });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ws.send(JSON.stringify({ type: "notice", text: message }));
          ws.send(JSON.stringify(await extensionState()));
        }
      }
      else if (msg.type === "run_command") {
        // Schrägstrich-Befehl oder Skill: Vorlage mit Argumenten füllen und wie eine Nachricht senden
        const name = String(msg.name ?? ""), args = String(msg.args ?? "");
        const fn = FUNCTION_COMMANDS.find(c => c.name === name);
        const skill = skillCatalog().find(sk => sk.name === name);
        const found = fn || skill ? undefined : ((await ocGet("/command")) as any[] | undefined)?.find(c => c.name === name);
        if (fn) {
          if (fn.mode && settings.mode !== fn.mode) { settings = { ...settings, mode: fn.mode }; save(); broadcast(state()); }   // /computer schaltet die Computer-Steuerung ein
          await chat(expandTemplate(fn.template, args), msg.model, false, [], ws.data.fresh);
        } else if (skill) {
          if (!skill.enabled) ws.send(JSON.stringify({ type: "notice", text: `Der Skill „${name}“ ist deaktiviert (Einstellungen → Skills).` }));
          else await chat(`Nutze den Skill „${skill.name}“ für diese Aufgabe. Lies ihn zuerst mit skill_read und befolge ihn.${args.trim() ? `\n\nAufgabe: ${args.trim()}` : ""}`, msg.model, false, [], ws.data.fresh);
        } else if (!found) ws.send(JSON.stringify({ type: "error", message: `Den Befehl „/${name}“ gibt es nicht. /hilfe zeigt alle.` }));
        else await chat(expandTemplate(String(found.template ?? ""), args), msg.model, false, [], ws.data.fresh);
      }
      else if (msg.type === "chat_action") await updateChat(msg);
      else if (msg.type === "rewind") await rewindMessage(String(msg.id), String(msg.messageID));
      else if (msg.type === "new") { session = undefined; broadcast(state()); }
      else if (msg.type === "usage") ws.send(JSON.stringify({ type: "usage", ...summarize(readUsage(), parseRange(msg.range)) }));
      else if (msg.type === "projects") ws.send(JSON.stringify({ type: "projects", ...projects.data() }));
      else if (msg.type === "project_action") {
        const r = await projectAction(msg.action ?? msg);
        if (!r.ok) ws.send(JSON.stringify({ type: "notice", text: r.error }));
      }
}

// Abstürze und vergessene Promise-Fehler landen im Fehler-Log statt nur auf stderr.
process.on("unhandledRejection", error => {
  recordError({ category: "daemon", source: "jarvisd/unhandledRejection", message: String((error as Error)?.message ?? error), error });
  console.error(error);
});
process.on("uncaughtException", error => {
  recordError({ category: "daemon", source: "jarvisd/crash", message: error.message, error, context: { mode: settings.mode, model: settings.model, voice, busy: [...busySessions] } });
  console.error(error);
  process.exit(1);
});

try { await brain.start(); } catch (error) {
  recordError({ category: "model", source: "jarvisd/opencode-start", message: String((error as Error)?.message ?? error), error, context: { workspace } });
  console.error(error);
  process.exit(1);
}
models = await listModels();
void repairChatTitles();
setInterval(() => void repairChatTitles(), TITLE_RETRY_MS);
console.log(`jarvisd bereit: http://127.0.0.1:${PORT} · ${models.length} Modelle · Standard ${settings.model}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { brain.stop(); desktop.stop(); ibrowser.stop(); haptics.stop(); process.exit(0); });
