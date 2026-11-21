// jarvisd – Kern-Daemon. UI (Tauri) und Chrome-Erweiterung verbinden sich hierher.
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import type { ServerWebSocket } from "bun";
import { OpenCode, listModels, type ModelInfo, type BrainEvent, type PromptImage } from "./opencode";
import { Desktop } from "./desktop";
import { Browser } from "./browser";
import { SYSTEM_PROMPT } from "./prompt";
import { Speech, SentenceSplitter } from "./speech";
import { prepare, validate, hasImages, type Attachment } from "./attachments";
import { correct } from "./lexicon";
import { recordError, listErrors, resolveError, markPng, toImageBox, CATEGORIES, type ErrorCategory } from "./errorlog";
import { Projects } from "./projects";
import { classificationPrompt, parseClassification } from "./classify";

const PORT = Number(process.env.JARVIS_PORT ?? 7777);
const HOME = join(homedir(), ".jarvis3");
const SETTINGS = join(HOME, "settings.json");
const CHAT_META = join(HOME, "chat-meta.json");
const CHAT_FOLDERS = join(HOME, "chat-folders.json");
const ROOT = join(import.meta.dir, "../..");
mkdirSync(HOME, { recursive: true });

interface Settings { model: string; voiceModel: string; mode: "browser" | "computer"; lofi: boolean; liveView: boolean; micDevice: number | null }
const defaults: Settings = { model: "opencode/deepseek-v4.1-flash-free", voiceModel: "opencode/deepseek-v4.1-flash-free", mode: "browser", lofi: false, liveView: true, micDevice: null };
let settings: Settings = existsSync(SETTINGS) ? { ...defaults, ...JSON.parse(readFileSync(SETTINGS, "utf8")) } : defaults;
if (settings.micDevice !== null && !Number.isInteger(settings.micDevice)) settings.micDevice = null; // alte/ungültige Werte
const save = () => writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));
type ChatMeta = { title?: string; folder?: string; auto?: boolean };
let chatMeta: Record<string, ChatMeta> = existsSync(CHAT_META) ? JSON.parse(readFileSync(CHAT_META, "utf8")) : {};
let chatFolders: string[] = existsSync(CHAT_FOLDERS) ? JSON.parse(readFileSync(CHAT_FOLDERS, "utf8")) : [];
const saveChatMeta = () => writeFileSync(CHAT_META, JSON.stringify(chatMeta, null, 2));

// OpenCode-Arbeitsordner mit Jarvis-MCP und voller Autonomie (Nutzerentscheidung).
const workspace = join(ROOT, "workspace");
mkdirSync(workspace, { recursive: true });
writeFileSync(join(workspace, "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json",
  mcp: { jarvis: { type: "local", command: [process.execPath, join(ROOT, "core/src/mcp.ts")], enabled: true,
                   environment: { JARVISD_URL: `http://127.0.0.1:${PORT}` } } },
  permission: { edit: "allow", bash: "allow", webfetch: "allow", external_directory: "allow" },
}, null, 2));

const brain = new OpenCode(4096, workspace);
const desktop = new Desktop();
const browser = new Browser();
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
let session: string | undefined;
let busy = false;
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
const state = () => ({ type: "state", model: settings.model, voiceModel: settings.voiceModel, mode: settings.mode,
                       lofi: settings.lofi, liveView: settings.liveView, extStale: extensionStale, busy, browser: browser.connected, speech: speech.connected, voice, models,
                       micDevice: settings.micDevice, devices: audioDevices });

// ---------- Sprache ----------
let voice: "off" | "live" | "dictate" | "muted" = "off";
// Nur die Oberfläche, die Live gestartet hat, darf es auch beenden. Andere UIs (z. B. eine vergessene
// Registerkarte oder ein zweiter Client) schickten sonst sofort voice:off, sobald sie "live" im State sahen.
let voiceOwner: ServerWebSocket<{ kind: string; fresh?: boolean }> | undefined;
let splitter: SentenceSplitter | undefined;
const holds = new Set<ReturnType<typeof setTimeout>>(); // zurückgehaltene Sätze nach dem ersten Werkzeug (siehe chat)
const clearHolds = () => { for (const t of holds) clearTimeout(t); holds.clear(); };
import { appendFileSync } from "node:fs";
const vlog = (line: string) => { try { appendFileSync(join(HOME, "voice.log"), `${new Date().toISOString()} ${line}\n`); } catch {} };
const speech = new Speech(e => {
  if (e.type !== "level" && e.type !== "partial") vlog(`speech ${e.type} ${JSON.stringify({ ...e, type: undefined }).slice(0, 300)} voice=${voice}`);
  if (e.type === "connected") { speech.send({ type: "config", lofi: settings.lofi, input: settings.micDevice }); speech.mode(voice); if (voice === "off") speech.stopSpeaking(); broadcast(state()); return; }
  if (e.type === "disconnected") { broadcast(state()); return; }
  if (e.type === "error") recordError({ category: "speech", source: "speech/sidecar", message: String(e.message ?? "Sprachfehler"),
    context: { voice, lofi: settings.lofi, voiceModel: settings.voiceModel, event: e } });
  if (e.type === "ready") {
    audioDevices = e.devices as AudioDevices;
    if (settings.micDevice !== null && !audioDevices.input.some(d => d.id === settings.micDevice)) {
      vlog(`Mikrofon-ID ${settings.micDevice} nicht mehr vorhanden -> Systemstandard`);
      settings.micDevice = null; save(); speech.send({ type: "config", input: null });
      broadcast({ type: "notice", text: "Ausgewähltes Mikrofon ist nicht mehr verbunden – Systemstandard aktiv" });
    }
    broadcast(state());
  }
  if (e.type === "final" && typeof e.text === "string") {
    // Wortliste: typische Verhörer bei Denglisch und Programmnamen korrigieren, bevor der Text angezeigt/verarbeitet wird
    const fixed = correct(e.text);
    if (fixed.changes.length) vlog(`Wortliste: ${fixed.changes.map(([a, b]) => `${a} → ${b}`).join(", ")} | "${e.text}" → "${fixed.text}"`);
    e = { ...e, text: fixed.text };
  }
  broadcast({ ...e, type: "speech", event: e.type });
  // Der Nutzer redet: Ausgabe verstummen lassen, die laufende Antwort aber nicht abbrechen (Husten/Pausen mitten im Satz).
  if (e.type === "speech_start" && voice === "live") { clearHolds(); splitter = undefined; }
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
function hear(text: string) {
  if (STOP_WORDS.test(text.trim())) { pendingUtterance = ""; clearTimeout(utterTimer); void stop(); return; }
  if (!worthAnswering(text) && !pendingUtterance) return;
  pendingUtterance = `${pendingUtterance} ${text}`.trim();
  clearTimeout(utterTimer);
  utterTimer = setTimeout(sendUtterance, UTTER_WAIT_MS);
}
function sendUtterance() {
  const text = pendingUtterance.trim(); pendingUtterance = "";
  if (!worthAnswering(text) || voice !== "live") return;
  let full = text, replace = false;
  // Antwort läuft noch, hat aber keine Werkzeuge benutzt und der Nutzer spricht weiter: zu EINER Äußerung zusammenführen
  if (busy && lastRun && !lastRun.toolSeen && Date.now() - lastRun.startedAt < 20_000) { full = `${lastRun.text} ${text}`; replace = true; }
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
function setVoice(mode: typeof voice) {
  vlog(`setVoice ${voice} -> ${mode}`);
  voice = mode;
  if (mode === "off") voiceOwner = undefined;
  speech.mode(mode);
  // "muted" schließt nur das Mikrofon; eine laufende Antwort wird weiter gesprochen.
  if (mode === "off") { splitter = undefined; clearHolds(); speech.stopSpeaking(); }
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
    return list.filter(s => !s.parentID && s.title !== "Test" && (!isEmpty(s.title) || s.id === session))
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .map(s => ({ id: s.id, title: chatMeta[s.id]?.title || (isEmpty(s.title) ? "Neuer Chat" : s.title),
                   folder: projects.label(projects.chat(s.id)?.projectId ?? null), active: s.id === session,
                   updated: s.time?.updated ?? 0, projectId: projects.chat(s.id)?.projectId ?? null,
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
  const blocks: string[] = [], names: string[] = [], images: PromptImage[] = [], text: string[] = [];
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
    } else if (role === "user" && part.type === "file" && /^data:image\/(png|jpe?g|gif|webp);base64,/.test(part.url)) {
      images.push({ mime: part.mime, url: part.url, filename: part.filename });
    }
  }
  if (!names.length) names.push(...images.map(image => image.filename || "Bild"));
  const view = { id: message.info?.id, role, text: text.join(""), files: names.map(name => ({ name })) };
  return { view, saved: { text: blocks.join("\n\n"), images, names } };
}

async function sessionMessages(id: string) {
  const response = await fetch(`${brain.url}/session/${encodeURIComponent(id)}/message`);
  if (!response.ok) throw new Error(`Nachrichten konnten nicht geladen werden (${response.status})`);
  return (await response.json()) as any[];
}
const chatHistory = (messages: any[]) => messages.map(message => readChatMessage(message).view)
  .filter(message => message.text || message.files.length);

async function openSession(id: string) {
  const messages = chatHistory(await sessionMessages(id));
  session = id;
  return messages;
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
    void analyzeProjects();
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
async function analyzeProjects() {
  if (analysisRunning) return;
  const data = projects.data();
  const pending = data.chats.filter(c => !c.projectId && !c.analyzed && c.title !== "Neuer Chat").slice(0, 8);
  if (!data.projects.length || !pending.length) return;
  analysisRunning = true;
  try {
    for (const c of pending) {
      const { system, text } = classificationPrompt(projects.data(), c, await firstExcerpt(c.id));
      const parsed = parseClassification(await brain.ask(text, CLASSIFY_MODEL, system), projects.data().projects.map(p => p.id));
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
    projects.resetAnalysis(); broadcastProjects(); void analyzeProjects();
    return { ok: true, project: p };
  }
  if (op === "update") {
    const p = projects.update(String(action.id), (action.patch ?? {}) as { name?: string; description?: string; parentId?: string | null });
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
  if (op === "analyze") { projects.resetAnalysis(); broadcastProjects(); void analyzeProjects(); return { ok: true }; }
  if (op === "sync") { await syncProjects(); broadcastProjects(); return { ok: true, ...projects.data() }; }
  return { ok: false, error: `Unbekannte Projektaktion: ${op}` };
}

// Reihenfolge, in der ersatzweise andere Modelle probiert werden (Stand der Messung 2026-11-20).
const FALLBACKS = ["opencode/nemotron-3.5-lightning-free", "nvidia/minimaxai/minimax-m3.1-flash", "opencode/big-pickle",
  "opencode/longcat-2.5-free", "opencode/deepseek-v4.1-flash-free", "opencode/mimo-v2.6-flash-free"];
const limited = new Map<string, number>(); // Modell -> gesperrt bis (ms)
const isLimit = (msg: string) => /free usage exceeded|rate.?limit|quota|too many requests|subscribe/i.test(msg);
function nextModel(tried: string[]) {
  const now = Date.now();
  return FALLBACKS.find(m => !tried.includes(m) && (limited.get(m) ?? 0) < now);
}

function announcement(e: Extract<BrainEvent, { kind: "tool" }>) {
  const name = e.name.replace(/^jarvis_/, "");
  const input = e.input ?? {};
  let host = "";
  try { host = input.url ? new URL(String(input.url)).host.replace(/^www\./, "") : ""; } catch {}
  if (name === "browser_tab_open" || name === "browser_navigate") return `Ich öffne ${host || "die Seite"}, einen Moment.`;
  if (name === "webfetch") return `Ich rufe ${host || "die Seite"} ab, einen Moment.`;
  if (name === "desktop_open_app") return `Ich öffne ${input.name ?? "das Programm"}, einen Moment.`;
  if (name.startsWith("browser_")) return "Ich schaue mir die Seite an, einen Moment.";
  if (name.startsWith("desktop_")) return "Ich sehe mir den Bildschirm an, einen Moment.";
  return "Ich kümmere mich darum, einen Moment.";
}

const canSee = (id: string) => models.find(m => m.id === id)?.vision ?? false;

async function chat(text: string, model = settings.model, spoken = false, tried: string[] = [], fresh = false, atts: Attachment[] = [], saved?: SavedAttachments) {
  if (busy && session && !fresh) await brain.abort(session);
  // Bilder angehängt, aber das Modell kann nicht sehen: für diese Nachricht auf ein Bildmodell wechseln
  if ((hasImages(atts) || saved?.images.length) && !canSee(model)) {
    const free = (m: ModelInfo) => m.vision && (limited.get(m.id) ?? 0) < Date.now() && !tried.includes(m.id);
    const vm = models.find(m => free(m) && m.group === "free") ?? models.find(free);
    if (vm) { broadcast({ type: "notice", text: `${model.split("/").pop()} kann keine Bilder sehen – für dieses Bild nutze ich ${vm.model}.` }); model = vm.id; }
    else broadcast({ type: "notice", text: `${model.split("/").pop()} kann keine Bilder sehen und es ist kein Bildmodell verfügbar. Wähle in der Modellliste eins mit „Bild“.` });
  }
  // Ein Modell, das gerade am Limit ist, gar nicht erst anfragen
  if ((limited.get(model) ?? 0) > Date.now()) {
    const alt = nextModel([...tried, model]);
    if (alt) { broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` }); return chat(text, alt, spoken, [...tried, model], fresh, atts, saved); }
  }
  const isNew = !fresh && !session;
  const sid = fresh ? await brain.createSession("Test") : (session ??= await brain.createSession());
  if (!fresh) broadcast({ type: "session", id: sid });
  // Erste Titelfassung nach der ersten Nachricht; nach der Antwort wird ein thematischer Titel gesetzt.
  if (isNew) {
    const title = topicTitle(text || atts.map(file => file.name).join(" "));
    if (!chatMeta[sid]?.title) void setSessionTitle(sid, title, true);
  }
  busy = true; broadcast(state());
  const started = performance.now();
  let first = true, switching = false, textSeen = false, announced = false, responseText = "";
  splitter = spoken ? new SentenceSplitter() : undefined;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Nach dem ersten Werkzeugaufruf werden Sätze 1 s zurückgehalten: Folgt direkt ein weiteres Werkzeug, war es ein Zwischentext
  // über etwas, das ohnehin gerade passiert, und wird verworfen (sonst kündigt Jarvis Erledigtes erst nachträglich an).
  let toolSeen = false;
  const speakAll = (parts: string[]) => {
    for (const p of parts) {
      vlog(`say: ${toolSeen ? "(gehalten) " : ""}${p.slice(0, 120)}`);
      if (!toolSeen) { speech.say(p); continue; }
      const t = setTimeout(() => { holds.delete(t); speech.say(p); }, 1000);
      holds.add(t);
    }
  };
  const system = spoken ? SYSTEM_PROMPT + "\n\nDu bist gerade im Sprachmodus: antworte in höchstens zwei kurzen Sätzen, ohne Listen." : SYSTEM_PROMPT;
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
  const prompt = text || (attachmentText || images.length ? "Sieh dir die angehängten Dateien an." : "");
  await brain.prompt(sid, prompt, model, system, (e: BrainEvent) => {
    if (switching) return;
    if (e.kind === "error" && isLimit(e.message)) {
      limited.set(model, Date.now() + 30 * 60_000);
      const alt = nextModel([...tried, model]);
      if (alt) {
        switching = true;
        broadcast({ type: "notice", text: `${model.split("/").pop()} ist am Limit – wechsle zu ${alt.split("/").pop()}` });
        brain.abort(sid).then(() => { busy = false; return chat(text, alt, spoken, [...tried, model], fresh, atts, saved); });
        return;
      }
      e = { kind: "error", message: "Alle Gratis-Modelle sind am Limit. Wähle ein lokales Modell (LM Studio) oder warte etwas." };
    }
    if (e.kind === "error") recordError({ category: "model", source: "opencode/prompt", message: e.message,
      context: { model, request: text, mode: settings.mode, spoken, voice, session: sid, retry: e.retry, tried } });
    if (e.kind === "tool" && e.status === "error" && !e.name.startsWith("jarvis_")) // Jarvis-Werkzeuge protokolliert runTool selbst
      recordError({ category: "tool", source: `opencode/${e.name}`, message: e.error ?? "Werkzeug fehlgeschlagen",
        context: { tool: e.name, input: e.input, model, request: text, mode: settings.mode } });
    if (e.kind === "text") { textSeen = true; responseText += e.delta; }
    // Sitzung existiert nicht mehr (z. B. in OpenCode gelöscht): neue Sitzung anlegen und einmal erneut senden
    if (e.kind === "error" && /Session not found|NotFoundError/i.test(e.message) && !tried.includes("__session")) {
      switching = true;
      if (!fresh) session = undefined;
      brain.abort(sid).catch(() => {}).then(() => { busy = false; return chat(text, model, spoken, [...tried, "__session"], fresh, atts, saved); });
      return;
    }
    // Lauf ist zu Ende, aber es kam weder Text noch ein Werkzeugaufruf an: bis zu zweimal automatisch neu versuchen
    // (erst dasselbe Modell, dann ein anderes), damit Jarvis nie wortlos aufhört
    if (e.kind === "done" && !e.aborted && !textSeen && !toolSeen) {
      const attempts = tried.filter(t => t !== "__session").length;
      if (attempts < 2) {
        switching = true;
        const alt = attempts === 0 ? model : (nextModel([...tried, model]) ?? model);
        vlog(`Leere Antwort von ${model} – neuer Versuch mit ${alt}`);
        broadcast({ type: "notice", text: "Keine Antwort erhalten – ich versuche es noch einmal." });
        brain.abort(sid).catch(() => {}).then(() => { busy = false; return chat(text, alt, spoken, [...tried, model], fresh, atts, saved); });
        return;
      }
      recordError({ category: "model", source: "jarvisd/chat", message: "Antwort ohne Inhalt: Lauf beendet, aber weder Text noch Werkzeugaufruf angekommen",
        context: { model, request: text, mode: settings.mode, spoken, voice, session: sid, tried } });
      broadcast({ type: "error", message: "Jarvis hat nicht geantwortet. Bitte sag es noch einmal oder wähle ein anderes Modell." });
    }
    // Modelle, die wortlos loslegen: eine passende Ankündigung ergänzen (wie bei einem guten Assistenten)
    if (e.kind === "tool" && !textSeen && !announced && e.status !== "pending") {
      announced = true;
      const line = announcement(e) + "\n\n";
      if (splitter) { speakAll(splitter.push(line)); speakAll(splitter.flush()); } // Ankündigung sofort sprechen
      if (first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started), model }); }
      broadcast({ type: "delta", text: line });
    }
    if (splitter && e.kind === "text") {
      speakAll(splitter.push(e.delta));
      // Satz ohne folgendes Leerzeichen (Strom pausiert, z. B. vor einem Werkzeug): nach kurzer Pause trotzdem sprechen
      clearTimeout(flushTimer);
      flushTimer = setTimeout(() => { if (splitter) speakAll(splitter.flushIfSentence()); }, 600);
    }
    if (e.kind === "tool" && lastRun) lastRun.toolSeen = true;
    if (splitter && e.kind === "tool") {
      clearTimeout(flushTimer);
      if (toolSeen) { clearHolds(); splitter.flush(); vlog("Zwischentext vor Werkzeug verworfen"); } // Ankündigung gab es schon
      else speakAll(splitter.flush());
      toolSeen = true;
    }
    if (splitter && (e.kind === "done" || e.kind === "error")) { clearTimeout(flushTimer); speakAll(splitter.flush()); splitter = undefined; }
    if (e.kind === "text" && first) { first = false; broadcast({ type: "latency", firstTokenMs: Math.round(performance.now() - started), model }); }
    if (e.kind === "done" || e.kind === "error") {
      busy = false; broadcast(state());
      if (e.kind === "done" && isNew && responseText.trim() && chatMeta[sid]?.auto !== false)
        void aiTitle(text, responseText).then(title => setSessionTitle(sid, title ?? topicTitle(`${text} ${responseText}`), true));
    }
    broadcast(e.kind === "text" ? { type: "delta", text: e.delta } : e.kind === "reasoning" ? { type: "reasoning", text: e.delta }
      : { type: e.kind, ...e });
  }, images, attachmentText);
}

/** Kurzer Chat-Titel vom schnellen Gratis-Modell (2–5 Wörter); null, wenn das Modell nichts Brauchbares liefert. */
async function aiTitle(user: string, answer: string): Promise<string | null> {
  try {
    const system = "Du erzeugst Titel für Chat-Verläufe. Antworte NUR mit dem Titel: 2 bis 5 Wörter, in der Sprache des Nutzers, "
      + "beschreibt das Thema (kein Satz, keine Frage), ohne Anführungszeichen, ohne Punkt am Ende, ohne Emojis.";
    const text = `Nutzer: ${user.replace(/\s+/g, " ").slice(0, 400)}\nAntwort: ${answer.replace(/\s+/g, " ").slice(0, 400)}\n\nTitel:`;
    const raw = await brain.ask(text, CLASSIFY_MODEL, system, 15_000);
    const title = raw.split("\n").map(l => l.trim()).find(Boolean)?.replace(/^(titel|title)\s*:\s*/i, "").replace(/^["„“'`*#\s]+|["“”'`*.\s]+$/g, "") ?? "";
    return title.length >= 3 && title.length <= 60 && title.split(/\s+/).length <= 8 ? title : null;
  } catch { return null; }
}

function topicTitle(text: string) {
  const stop = new Set("aber alle also auch auf aus bei bin bis das dass dein deine dem den der des die dies doch du ein eine einer eines für gegen habe hat hier ich ihr im in ist ja kann kein mit nach nicht noch oder sein sie sind so über um und uns von vor was wenn wie wir zu zum zur".split(" "));
  const words = text.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}+-]*/gu) ?? [];
  const ranked = new Map<string, number>();
  for (const word of words) if (word.length > 2 && !stop.has(word)) ranked.set(word, (ranked.get(word) ?? 0) + 1);
  const key = [...ranked].sort((a,b) => b[1]-a[1]).slice(0, 4).map(([w]) => w);
  return key.length ? key.map(w => w[0].toLocaleUpperCase("de-DE") + w.slice(1)).join(" · ") : "Neuer Chat";
}
async function setSessionTitle(id: string, title: string, automatic = false) {
  chatMeta[id] ??= {};
  if (automatic) { if (chatMeta[id].auto === false) return; chatMeta[id].title = title; chatMeta[id].auto = true; }
  else if (!chatMeta[id].title) chatMeta[id].title = title;
  saveChatMeta();
  await fetch(`${brain.url}/session/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: chatMeta[id].title }) }).catch(() => {});
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
  } else if (msg.action === "move") {
    const folder = String(msg.folder ?? "").trim().slice(0, 100);
    let target = folder ? projectByLabel(folder) : undefined;
    if (folder && !target) target = projects.create(folder);
    projects.upsertChat({ id, title: chatMeta[id]?.title || id });
    projects.assign(id, target?.id ?? null, "manual");
  } else if (msg.action === "delete") {
    const response = await fetch(`${brain.url}/session/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error(`Chat konnte nicht gelöscht werden (${response.status})`);
    delete chatMeta[id]; saveChatMeta();
    if (session === id) { session = undefined; broadcast({ type: "session", id: null }); broadcast({ type: "messages", messages: [] }); }
  }
  broadcast({ type: "history", sessions: await history(), folders: folderLabels() });
}
async function rewindMessage(id: string, messageID: string) {
  if (busy && session) await brain.abort(session);
  const response = await fetch(`${brain.url}/session/${id}/revert`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messageID }) });
  if (!response.ok) throw new Error(`Nachricht konnte nicht zurückgesetzt werden (${response.status})`);
  session = id;
  broadcast({ type: "messages", messages: chatHistory(await sessionMessages(id)) });
}

// ---------- Live-Ansicht des Tabs, in dem Jarvis gerade arbeitet ----------
let streamTab: number | undefined;
let pinnedTab: number | undefined; // vom Nutzer in der Vorschau gewählter Tab: bleibt, bis er "Automatisch" wählt oder die Vorschau schließt
let streamTimer: ReturnType<typeof setTimeout> | undefined;
async function stopStream() {
  clearTimeout(streamTimer);
  const t = streamTab; streamTab = undefined;
  if (t !== undefined) await browser.call({ cmd: "stream_stop", tab: t }, 5000).catch(() => {});
}
async function ensureStream(tab: number, manual = false) {
  if (!manual && (!settings.liveView || pinnedTab !== undefined && pinnedTab !== tab)) return;
  if (uis.size === 0 || !browser.connected) return;
  clearTimeout(streamTimer);
  if (pinnedTab === undefined) streamTimer = setTimeout(stopStream, 12_000); // 12 s nach der letzten Aktion endet die Übertragung
  if (streamTab === tab) return;
  if (streamTab !== undefined) await browser.call({ cmd: "stream_stop", tab: streamTab }, 5000).catch(() => {});
  const r = await browser.call({ cmd: "stream_start", tab }, 8000);
  streamTab = r.ok ? tab : undefined;
  if (!r.ok && manual) broadcast({ type: "notice", text: `Tab-Vorschau nicht möglich: ${r.error ?? "unbekannter Fehler"}` });
}
/** Tabs der Gruppe "Jarvis" (auch "Jarvis …"-Gruppen) für die Auswahl oben in der Vorschau. */
async function jarvisTabs() {
  if (!browser.connected) return [];
  const r = await browser.call({ cmd: "tab_list" }, 5000).catch(() => undefined);
  const tabs = ((r?.tabs ?? []) as any[]).filter(t => typeof t.group === "string" && /^jarvis/i.test(t.group));
  return tabs.map(t => ({ tab: t.tab, title: t.title, url: t.url, favicon: t.favicon ?? "", active: !!t.active }));
}
// Erweiterung veraltet? Neue Versionen lädt sie auf Anweisung selbst; sehr alte (vor 1.2.0) muss der Nutzer einmal neu laden.
const wantedExtension = () => { try { return JSON.parse(readFileSync(join(ROOT, "extension/manifest.json"), "utf8")).version as string; } catch { return ""; } };
const versionNum = (v: string) => v.split(".").reduce((n, x) => n * 1000 + Number(x || 0), 0);
let extensionStale = false;
browser.onHello = version => {
  const want = wantedExtension();
  extensionStale = !!want && version !== want;
  if (extensionStale && versionNum(version) >= versionNum("1.2.0")) {
    vlog(`Erweiterung ${version} -> ${want}: lade neu`);
    setTimeout(() => void browser.call({ cmd: "reload" }, 3000).catch(() => {}), 300);
  } else if (extensionStale) {
    broadcast({ type: "notice", text: `Die Chrome-Erweiterung ist veraltet (${version}, aktuell ${want}). Bitte einmal unter chrome://extensions bei „Jarvis“ neu laden – danach aktualisiert sie sich selbst.` });
  }
  broadcast(state());
};
browser.onEvent = m => {
  if (m.type === "stream_ended" && m.tab === streamTab) streamTab = undefined;
  if (m.type === "stream_ended" && m.tab === pinnedTab && /geschlossen/i.test(String(m.reason ?? ""))) pinnedTab = undefined;
  broadcast(m);
};

async function stop() {
  stoppedUntil = Date.now() + 1500;
  splitter = undefined;
  clearHolds();
  speech.stopSpeaking();
  if (session) await brain.abort(session);
  busy = false; broadcast({ type: "stopped" }); broadcast(state());
}

// Letzte scan-Ergebnisse je Ziel, damit ein Fehler-Screenshot das betroffene Element markieren kann.
const lastTargets = new Map<string, { id: number; rect: number[] }[]>();
const targetKey = (target: string, tab: unknown) => target === "browser" ? `browser:${tab}` : "desktop";

/** Screenshot des Tabs bzw. Bildschirms, die Stellen in `boxes` (Seiten-/Bildschirmkoordinaten) rot umrandet. */
async function errorShot(target: string, tab: unknown, boxes: number[][]): Promise<Uint8Array | undefined> {
  try {
    let png: Uint8Array, rect: number[];
    if (target === "browser") {
      if (!browser.connected || !Number.isInteger(tab)) return undefined;
      const r = await browser.call({ cmd: "shot", tab }, 10_000);
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
  const el = Number.isInteger(cmd.id) ? lastTargets.get(targetKey(target, cmd.tab))?.find(t => t.id === cmd.id) : undefined;
  const boxes = [el?.rect, Array.isArray(cmd.rect) && cmd.rect.length === 4 ? cmd.rect : undefined].filter(Boolean) as number[][];
  const screenshot = NO_SHOT.test(message) || cmd.cmd === "shot" || cmd.screenshot === false ? undefined : await errorShot(target, cmd.tab, boxes);
  return recordError({ category: opts.category ?? "tool", source: opts.source ?? `${target}/${cmd.cmd}`, message, screenshot,
    context: { tool: `${target}_${cmd.cmd}`, args: cmd, element: el, mode: settings.mode, model: settings.model, voice, busy, ...opts.context } });
}

async function runTool(target: string, cmd: Record<string, any>) {
  const r: Record<string, any> = await runToolInner(target, cmd).catch(error => ({ ok: false, error: String(error?.message ?? error) }));
  if (r.ok && cmd.cmd === "scan" && Array.isArray(r.targets)) lastTargets.set(targetKey(target, cmd.tab), r.targets);
  if (!r.ok && r.error !== "vom Nutzer gestoppt") void logToolError(target, cmd, String(r.error ?? "Werkzeug fehlgeschlagen"));
  return r;
}

async function runToolInner(target: string, cmd: Record<string, any>) {
  if (Date.now() < stoppedUntil) return { ok: false, error: "vom Nutzer gestoppt" };
  broadcast({ type: "action", target, cmd: cmd.cmd, detail: cmd.url ?? cmd.id ?? cmd.name ?? "" });
  if (target === "browser") {
    if (Number.isInteger(cmd.tab)) void ensureStream(cmd.tab);
    const r = await browser.call(cmd);
    if (cmd.cmd === "tab_open" && r.ok && Number.isInteger(r.tab)) void ensureStream(r.tab as number);
    return r;
  }
  if (settings.mode !== "computer" && !["scan", "read", "shot"].includes(cmd.cmd))
    return { ok: false, error: "Computer-Steuerung ist aus (Modus: nur Browser). Nutzer bitten, sie einzuschalten." };
  if (cmd.cmd === "open_app") {
    const p = process.platform === "win32" ? Bun.spawn(["cmd", "/c", "start", "", cmd.name]) : Bun.spawn(["open", "-a", cmd.name]);
    const code = await p.exited;
    return code === 0 ? { ok: true } : { ok: false, error: `Programm „${cmd.name}“ nicht geöffnet (Exit-Code ${code})` };
  }
  return desktop.call(cmd);
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
      if (ws.data.kind === "browser") { browser.detach(ws); broadcast(state()); }
      else {
        vlog(`ui #${uiId(ws)} close`);
        uis.delete(ws);
        if (uis.size === 0) { pinnedTab = undefined; void stopStream(); }
        // Wer Live gestartet hat und die Verbindung verliert, beendet es. Das gilt auch, wenn andere UIs noch offen sind.
        if (voiceOwner === ws) { vlog(`voice-owner ui #${uiId(ws)} weg -> off`); setVoice("off"); }
        // Keine Oberfläche mehr offen: Mikrofon zu, nichts mehr sprechen.
        else if (uis.size === 0 && voice !== "off") setVoice("off");
      }
    },
    async message(ws, raw) {
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
    if (u.pathname.startsWith("/errors")) { const r = await errorsRoute(req, u); if (r) return r; }
    if (u.pathname === "/browser" || u.pathname === "/ui")
      return srv.upgrade(req, { data: { kind: u.pathname.slice(1), fresh: u.searchParams.has("fresh") } }) ? undefined : new Response("upgrade", { status: 400 });
    if (u.pathname === "/" || u.pathname.startsWith("/app")) { // Oberfläche zum Testen im Browser
      const rel = u.pathname.replace(/^\/app\/?/, "").replace(/^\/$/, "") || "index.html";
      const file = Bun.file(join(ROOT, "app/ui", rel.replace(/\.\.+/g, "")));
      if (u.pathname === "/") return Response.redirect("/app/", 302);
      return (await file.exists()) ? new Response(file) : new Response("nicht gefunden", { status: 404 });
    }
    if (u.pathname === "/health") return Response.json({ ok: true, opencode: await brain.healthy(), browser: browser.connected });
    if (u.pathname === "/models") return Response.json(models = await listModels());
    if (u.pathname === "/projects" && req.method === "GET") return Response.json(projects.data());
    if (u.pathname === "/projects" && req.method === "POST") {
      const r = await projectAction(await req.json() as Record<string, any>);
      return Response.json(r, { status: r.ok ? 200 : 400 });
    }
    if (u.pathname === "/tool" && req.method === "POST") {
      const { target, cmd } = await req.json();
      return Response.json(await runTool(target, cmd));
    }
    if (u.pathname === "/stop" && req.method === "POST") { await stop(); return Response.json({ ok: true }); }
    if (u.pathname === "/chat" && req.method === "POST") { // für Tests ohne UI
      const { text, model } = await req.json(); await chat(text, model); return Response.json({ ok: true });
    }
    return new Response("jarvisd", { status: 404 });
}

async function socketMessage(ws: ServerWebSocket<{ kind: string; fresh?: boolean }>, raw: string) {
      if (ws.data.kind === "browser") return browser.receive(raw);
      const msg = JSON.parse(raw);
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
      else if (msg.type === "stop") await stop();
      else if (msg.type === "settings") {
        settings = { ...settings, ...msg.settings };
        if ("micDevice" in msg.settings) settings.micDevice = Number.isInteger(settings.micDevice) ? settings.micDevice : null;
        save();
        if ("lofi" in msg.settings || "micDevice" in msg.settings)
          speech.send({ type: "config", lofi: settings.lofi, input: settings.micDevice });
        broadcast(state());
      }
      else if (msg.type === "liveview") { settings.liveView = !!msg.on; save(); if (!settings.liveView) { pinnedTab = undefined; await stopStream(); } broadcast(state()); }
      else if (msg.type === "tabs") ws.send(JSON.stringify({ type: "tabs", tabs: await jarvisTabs(), pinned: pinnedTab ?? null, streaming: streamTab ?? null }));
      else if (msg.type === "viewer_tab") {
        // Nutzer wählt einen Tab (Zahl) oder "Automatisch" (null: Jarvis' aktuellem Tab folgen)
        if (Number.isInteger(msg.tab)) { pinnedTab = msg.tab; await ensureStream(msg.tab, true); }
        else { pinnedTab = undefined; clearTimeout(streamTimer); streamTimer = setTimeout(stopStream, 12_000); }
        ws.send(JSON.stringify({ type: "tabs", tabs: await jarvisTabs(), pinned: pinnedTab ?? null, streaming: streamTab ?? null }));
      }
      else if (msg.type === "voice") requestVoice(ws, msg.mode);
      else if (msg.type === "history") { ws.send(JSON.stringify({ type: "history", sessions: await history(), folders: folderLabels() })); void syncProjects(); }
      else if (msg.type === "open") ws.send(JSON.stringify({ type: "messages", messages: await openSession(msg.id) }));
      else if (msg.type === "chat_action") await updateChat(msg);
      else if (msg.type === "rewind") await rewindMessage(String(msg.id), String(msg.messageID));
      else if (msg.type === "new") { session = undefined; broadcast(state()); }
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
  recordError({ category: "daemon", source: "jarvisd/crash", message: error.message, error, context: { mode: settings.mode, model: settings.model, voice, busy } });
  console.error(error);
  process.exit(1);
});

try { await brain.start(); } catch (error) {
  recordError({ category: "model", source: "jarvisd/opencode-start", message: String((error as Error)?.message ?? error), error, context: { workspace } });
  console.error(error);
  process.exit(1);
}
models = await listModels();
console.log(`jarvisd bereit: http://127.0.0.1:${PORT} · ${models.length} Modelle · Standard ${settings.model}`);
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { brain.stop(); desktop.stop(); process.exit(0); });
