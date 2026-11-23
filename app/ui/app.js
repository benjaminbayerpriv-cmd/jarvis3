// Jarvis-Oberfläche: spricht per WebSocket mit jarvisd (ws://127.0.0.1:7777/ui).
import { TABLER as BASE } from "./tabler.js";
import { CUSTOM } from "./icons-custom.js";
const TABLER = { ...BASE, ...CUSTOM };
import { renderMarkdown } from "./markdown.js";
import { BlurText } from "./blurtext.js";
import { preferences, setPreference, lessMotion } from "./preferences.js";

const $ = s => document.querySelector(s);
const DAEMON = location.protocol.startsWith("http") && location.port ? location.host : "127.0.0.1:7777"; // von jarvisd ausgeliefert: derselbe Dienst (auch auf Testports)

// ---------- Icons ----------
export function icon(name, cls = "ic") {
  const i = TABLER[name];
  if (!i) return "";
  return i.fill
    ? `<svg class="${cls}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${i.d}</svg>`
    : `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${i.d}</svg>`;
}
TABLER.file ??= { d: '<path d="M14 3v4a1 1 0 0 0 1 1h4" /><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z" />', fill: false };
const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach(el => {
  if (!el.dataset.painted) { el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon)); el.dataset.painted = "1"; }
});
paintIcons();

// ---------- Zustand ----------
const state = { model: "", mode: "browser", busy: false, browser: false, models: [], voiceModel: "", micDevice: null, devices: null };
let current = null;        // aktuelle Jarvis-Antwort {el, text, started}
let currentSession = null;
let historySessions = [];
let chatFolderNames = [];
let editingMessage = null;
let sending = false;
let pendingChatAction = null;
let live = { on: false, muted: false };
let dictating = false;   // Diktat läuft (Mikro-Knopf wird zum Stopp, Live-Knopf zum Senden)
let projectData = { projects: [], chats: [], root: "" };

// ---------- Verbindung ----------
let ws, retry = 0, hadSocket = false;
function connect() {
  ws = new WebSocket(`ws://${DAEMON}/ui`);
  ws.onopen = () => {
    retry = 0; setOffline(false);
    // Nach einem Verbindungsabbruch (z. B. Neustart von jarvisd) sind Ereignisse verloren gegangen: den gezeigten Chat neu laden,
    // sonst bleibt eine laufende Antwort leer, bis der Nutzer die Seite aktualisiert.
    if (hadSocket && currentSession && !editingMessage) send({ type: "open", id: currentSession });
    hadSocket = true;
    reportFocus();
  };
  // Ohne Verbindung weiß die Oberfläche nichts vom Lauf: nicht im alten „läuft“-Zustand (Stopp-Pille, Stopp-Knopf) hängen bleiben.
  // Nach dem Wiederverbinden schickt der Daemon den echten Zustand.
  ws.onclose = () => { state.busy = false; state.busySessions = []; renderState(); setOffline(true);setTimeout(connect, Math.min(4000, 300 * 2 ** retry++)); };
  ws.onmessage = ev => handle(JSON.parse(ev.data));
}
const send = msg => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
// Fokus melden: der Daemon vibriert nur, wenn Jarvis (App oder Webseite) im Vordergrund ist
const reportFocus = () => send({ type: "focus", focused: document.hasFocus() && !document.hidden });
addEventListener("focus", reportFocus); addEventListener("blur", reportFocus); document.addEventListener("visibilitychange", reportFocus);
// Fehler der Oberfläche ins zentrale Fehler-Log des Daemons (docs/errors.md)
const reportError = (where, error) => send({ type: "client_error", where, message: String(error?.message ?? error), stack: error?.stack });
addEventListener("error", e => reportError("window.onerror", e.error ?? e.message));
addEventListener("unhandledrejection", e => reportError("unhandledrejection", e.reason));
function setOffline(off) {
  $("#footModel").textContent = off ? "– Jarvis-Dienst nicht erreichbar, verbinde neu …" : state.model;
}

// Mehrere Chats laufen gleichzeitig: Ereignisse tragen die Chat-ID und gelten nur für den Chat, den diese Oberfläche gerade zeigt.
// "Läuft" und der Stopp-Knopf beziehen sich auf den gezeigten Chat; die übrigen laufenden Chats stehen in der Seitenleiste.
const CHAT_EVENTS = new Set(["delta", "reasoning", "tool", "latency", "error", "stopped", "done", "notice", "messages", "visual"]);
const syncBusy = () => { state.busy = !!currentSession && (state.busySessions || []).includes(currentSession); };
const openChat = id => { currentSession = id; renderState(); send({ type: "open", id }); };
let runningKey = "";
function handle(m) {
  if (CHAT_EVENTS.has(m.type) && m.session !== undefined && m.session !== currentSession) return;
  switch (m.type) {
    case "state":
      Object.assign(state, m); renderState(); renderSettingsState();
      { const key = (m.busySessions || []).join(","); if (key !== runningKey) { runningKey = key; send({ type: "history" }); } } // Lauf-Markierung in der Seitenleiste
      // Früher schickte jede Oberfläche beim ersten "live"-State sofort voice:off und hat damit den
      // Sprachmodus anderer Clients abgewürgt. Der Daemon klärt jetzt die Zuständigkeit (voiceOwner).
      break;
    case "delta": appendText(m.text); if (live.on && state.spokenReplies === false) liveUnspoken(m.text); break;
    case "tool": toolEvent(m); break;
    case "action": break; // Details kommen über "tool"
    case "latency": if (current) { current.firstMs = m.firstTokenMs; if (m.model) current.model = m.model; } break;
    case "notice": showNotice(m.text); break;
    case "user": heardUser(m); break;
    case "frame": showFrame(m); break;
    case "spoken": if (live.on) liveSpoken(m.text); break;
    case "voice_sample":
      $("#voiceSampleStatus").textContent = m.ok ? "Stimmprobe an den Sprachdienst gesendet." : "Schließe zuerst den Live-Modus oder warte auf den Sprachdienst.";
      break;
    case "live_unspoken": if (live.on) liveUnspoken(m.text); break; // Antwort konnte nicht gesprochen werden: wenigstens zeigen
    case "tabs": viewerTabsMessage(m); break;
    case "commands": slashItems = m.items || []; renderSlash(); break;
    case "extensions": renderExtensions(m); break;
    case "mobile_devices": clearMobileCode(); void refreshMobileDevices(); break;
    case "ext_scan": renderImport(m); break;
    case "viewer_idle": viewerIdle(); break;
    case "visual": visualEvent(m); break;
    case "ib_clipboard": if (m.text) navigator.clipboard?.writeText(m.text).catch(() => {}); break;
    case "error": showError(m.message); break;
    case "stopped": finishTurn("Gestoppt"); break;
    case "speech": speechEvent(m); break;
    case "history": chatFolderNames = m.folders || chatFolderNames; renderHistory(m.sessions); break;
    case "messages": renderMessages(m.messages); if (m.running) startJarvis(); break; // läuft der Chat noch, kommt die halbe Antwort gleich als Ereignisse
    case "session": if (!currentSession || m.id === null || m.replaces === currentSession) { currentSession = m.id; renderState(); } break;
    case "message_ids": applyMessageIds(m); break;
    case "projects": renderProjects(m); break;
    case "usage": renderUsage(m); break;
  }
  if (m.type === "state" && !state.busy && current) finishTurn();
}

// ---------- Kopfzeile / Status ----------
const short = id => id ? id.split("/").pop().replace(/-free$/, "") : "…";
function renderState() {
  syncBusy();
  $("#modelName").textContent = short(state.model);
  $("#footModel").textContent = state.model;
  const pill = $("#browserPill");
  pill.classList.toggle("ok", state.browser);
  pill.title = state.browser ? (state.extStale ? "Chrome-Erweiterung veraltet – unter chrome://extensions neu laden" : "Chrome-Erweiterung verbunden") : "Chrome-Erweiterung nicht verbunden";
  pill.classList.toggle("stale", !!state.extStale);
  $("#modeSwitch").setAttribute("aria-checked", String(state.mode === "computer"));
  $("#setComputer").setAttribute("aria-checked", String(state.mode === "computer"));
  $("#viewToggle").setAttribute("aria-pressed", String(state.liveView !== false));
  if (state.liveView === false && !viewer.hidden) hideViewer();
  $("#stop").hidden = !state.busy;
  const stopKeys = $("#stopKeys");
  if (stopKeys) stopKeys.textContent = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent) ? "⌘⇧⎋" : "Strg+Alt+Umschalt+Esc";
  updateSend();
  $("#stopBanner").hidden = !(state.busy && state.mode === "computer");
}

// ---------- Gespräch ----------
const turns = $("#turns");
const conv = $("#conversation");
const stickToBottom = () => { if (conv.scrollHeight - conv.scrollTop - conv.clientHeight < 160) conv.scrollTop = conv.scrollHeight; };

const setZero = on => { $("#zero").classList.toggle("gone", !on); document.querySelector(".main").classList.toggle("is-zero", on); };
setZero(true);
// Nachrichten, die gerade erst geschrieben wurden, kennen ihre ID noch nicht: beim Klick vom Daemon holen
let idWaiters = [];
function withMessageId(n, run) {
  if (n.__message?.id) return run();
  if (!currentSession) return showNotice("Dieser Chat ist noch nicht gespeichert. Bitte kurz warten und noch einmal versuchen.");
  idWaiters.push(() => { if (n.__message?.id) run(); else showNotice("Die Nachricht wurde nicht gefunden. Bitte den Chat neu öffnen."); });
  send({ type: "message_ids", id: currentSession });
}
function applyMessageIds(m) {
  if (m.session !== currentSession) return;
  const nodes = [...turns.querySelectorAll(".turn.user")], users = m.users || [];
  nodes.forEach((n, i) => { const u = users[users.length - nodes.length + i]; if (u) n.__message = u; });
  for (const w of idWaiters.splice(0)) w();
}
function addUser(text, files = []) {
  setZero(false);
  const n = $("#tplUser").content.firstElementChild.cloneNode(true);
  const bubble = n.querySelector(".bubble");
  if (files.length) {
    const row = document.createElement("div");
    row.className = "bubble-files";
    for (const f of files) row.append(fileChip(f, false));
    bubble.append(row);
  }
  if (text) { const t = document.createElement("div"); t.textContent = text; bubble.append(t); }
  const tools = document.createElement("div"); tools.className = "user-tools";
  const edit = document.createElement("button"); edit.type = "button"; edit.title = "Bearbeiten"; edit.setAttribute("aria-label", "Nachricht bearbeiten"); edit.innerHTML = icon("edit");
  const resend = document.createElement("button"); resend.type = "button"; resend.title = "Erneut senden"; resend.setAttribute("aria-label", "Nachricht erneut senden"); resend.innerHTML = icon("refresh");
  tools.append(edit, resend); n.append(tools);
  edit.onclick = () => withMessageId(n, () => { const msg = n.__message; if (!msg?.id || !currentSession) return; editingMessage = { id: currentSession, messageID: msg.id, hasFiles: !!msg.files?.length }; input.value = text; autosize(); updateSend(); input.focus(); });
  resend.onclick = () => withMessageId(n, () => { const msg = n.__message; if (msg?.id && currentSession) { turns.innerHTML = ""; send({ type: "resend", id: currentSession, messageID: msg.id, text }); } });
  turns.append(n);
  return n;
}
function startJarvis() {
  const n = $("#tplJarvis").content.firstElementChild.cloneNode(true);
  n.classList.add("busy", "empty");
  turns.append(n);
  current = { el: n, blocks: [], text: "", started: performance.now(), calls: new Map() };
  conv.scrollTop = conv.scrollHeight;
}
const blocksOf = () => current.el.querySelector(".blocks");

// Textblock: Fortsetzung des letzten Textblocks, sonst neuer (nach einer Werkzeug-Gruppe beginnt ein neuer)
function textBlock() {
  let b = current.blocks.at(-1);
  if (b?.kind !== "text") {
    b = { kind: "text", text: "", el: document.createElement("div"), faded: new Set() };
    b.el.className = "md";
    blocksOf().append(b.el);
    current.blocks.push(b);
  }
  return b;
}
let rafPending = false;
function appendText(t) {
  if (!current) startJarvis();
  const b = textBlock();
  b.text += t;
  current.text += t;
  current.el.classList.remove("empty");
  if (!rafPending) {
    rafPending = true;
    setTimeout(() => { // Timer statt rAF: läuft auch, wenn das Fenster im Hintergrund ist
      rafPending = false;
      if (!current) return;
      for (const blk of current.blocks) if (blk.kind === "text" && blk.dirty !== false) paintText(blk);
      stickToBottom();
    }, 33);
  }
}
function paintText(b) {
  const before = b.el.children.length;
  b.el.innerHTML = renderMarkdown(b.text);
  [...b.el.children].forEach((el, i) => { if (i >= Math.max(0, before - 1) && !b.faded.has(i)) { el.classList.add("fade"); b.faded.add(i); } });
}

const TOOL_LABEL = {
  desktop_windows: "Fenster suchen", desktop_scan: "Bildschirm ansehen", desktop_click: "Klicken", desktop_type: "Tippen", desktop_scroll: "Scrollen",
  desktop_read: "Text lesen", desktop_look: "Screenshot", desktop_key: "Tasten drücken", desktop_open_app: "Programm öffnen",
  browser_tab_open: "Tab öffnen", browser_tab_list: "Tabs prüfen", browser_tab_close: "Tab schließen",
  browser_navigate: "Seite laden", browser_back: "Zurück", browser_wait: "Auf Seite warten", browser_scan: "Seite ansehen",
  browser_click: "Auf Seite klicken", browser_type: "Auf Seite schreiben", browser_scroll: "Seite scrollen",
  browser_read: "Seite lesen", browser_look: "Screenshot vom Tab",
  webfetch: "Webseite abrufen", bash: "Befehl ausführen", read: "Datei lesen", write: "Datei schreiben", edit: "Datei bearbeiten",
  glob: "Dateien suchen", grep: "Text suchen", list: "Ordner lesen",
  visualize_python: "Grafik zeichnen", visualize_html: "Visualisierung bauen",
};
// Laufzeitform für die Kopfzeile ("Öffnet Tab …")
const TOOL_RUNNING = {
  desktop_windows: "Sucht das Fenster", desktop_scan: "Sieht sich den Bildschirm an", desktop_click: "Klickt", desktop_type: "Tippt", desktop_read: "Liest Text",
  desktop_look: "Macht einen Screenshot", browser_tab_open: "Öffnet einen Tab", browser_navigate: "Lädt die Seite",
  browser_wait: "Wartet auf die Seite", browser_scan: "Sieht sich die Seite an", browser_click: "Klickt auf der Seite",
  browser_type: "Schreibt auf der Seite", browser_read: "Liest die Seite", browser_scroll: "Scrollt", bash: "Führt einen Befehl aus",
  webfetch: "Ruft eine Webseite ab", read: "Liest eine Datei", edit: "Bearbeitet eine Datei", write: "Schreibt eine Datei",
  visualize_python: "Zeichnet eine Grafik", visualize_html: "Baut eine Visualisierung",
};
const baseName = n => n.replace(/^jarvis_/, "");
function detail(input = {}, title) {
  const v = input.url ?? (typeof input.text === "string" ? `„${input.text.slice(0, 60)}“` : undefined)
    ?? input.combo ?? input.name ?? input.command ?? input.filePath ?? input.pattern
    ?? (input.id === undefined ? title : undefined);
  return v === undefined ? "" : String(v).slice(0, 90);
}

function toolsBlock() {
  let b = current.blocks.at(-1);
  if (b?.kind !== "tools") {
    const el = document.createElement("details");
    el.className = "tools";
    el.innerHTML = `<summary><span class="tools-label"></span>${icon("chevron-down", "ic chev")}</summary><div class="tool-list"></div>`;
    blocksOf().append(el);
    b = { kind: "tools", el, rows: new Map() };
    current.blocks.push(b);
  }
  return b;
}
function paintToolsHeader(b) {
  const rows = [...b.rows.values()];
  const running = rows.filter(r => r.status === "pending" || r.status === "running").at(-1);
  const label = b.el.querySelector(".tools-label");
  if (running) {
    label.textContent = (TOOL_RUNNING[baseName(running.name)] ?? TOOL_LABEL[baseName(running.name)] ?? baseName(running.name)) + " …";
    label.classList.add("shimmer");
  } else {
    const n = rows.length, failed = rows.filter(r => r.status === "error").length;
    label.textContent = `${n} ${n === 1 ? "Schritt" : "Schritte"} ausgeführt` + (failed ? `, ${failed} fehlgeschlagen` : "");
    label.classList.remove("shimmer");
  }
}
function toolEvent(m) {
  if (!current) startJarvis();
  current.el.classList.remove("empty");
  const b = toolsBlock();
  let r = b.rows.get(m.id);
  if (!r) {
    const el = document.createElement("div");
    el.className = "tool-row";
    el.innerHTML = `<span class="tool-name"></span><span class="tool-detail"></span>`;
    b.el.querySelector(".tool-list").append(el);
    r = { el, name: m.name };
    b.rows.set(m.id, r);
  }
  r.status = m.status;
  r.el.querySelector(".tool-name").textContent = TOOL_LABEL[baseName(m.name)] ?? baseName(m.name);
  r.el.querySelector(".tool-detail").textContent = detail(m.input, m.title);
  r.el.classList.toggle("err", m.status === "error");
  r.el.classList.toggle("running", m.status === "pending" || m.status === "running");
  paintToolsHeader(b);
  stickToBottom();
}
function finishTurn(note) {
  if (!current) return;
  // Antwort ohne Inhalt (abgebrochen, bevor etwas kam): nicht als leere Blase mit Zeitangabe stehen lassen
  if (!current.blocks.length) { current.el.remove(); current = null; return; }
  const { el, started, firstMs } = current;
  el.classList.remove("busy", "empty");
  el.classList.add("done");
  for (const b of current.blocks) {
    if (b.kind === "text") b.el.innerHTML = renderMarkdown(b.text);
    else if (b.kind === "tools") { for (const r of b.rows.values()) if (r.status === "pending" || r.status === "running") { r.status = note ? "error" : "completed"; r.el.classList.remove("running"); } paintToolsHeader(b); }
  }
  if (!current.blocks.some(b => b.kind === "text") && !note && !current.blocks.length) textBlock().el.textContent = "…";
  if (current.text.trim()) {  // Antwort kopieren
    const b = document.createElement("button");
    b.className = "copy-btn"; b.type = "button"; b.title = "Antwort kopieren"; b.setAttribute("aria-label", "Antwort kopieren");
    b.innerHTML = icon("copy");
    const text = current.text.trim();
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(text); } catch { return; }
      b.innerHTML = icon("check"); b.classList.add("done");
      setTimeout(() => { b.innerHTML = icon("copy"); b.classList.remove("done"); }, 1400);
    };
    el.querySelector(".body").insertBefore(b, el.querySelector(".meta"));
  }
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  const meta = el.querySelector(".meta");
  const summary = [note, short(current.model ?? state.model)].filter(Boolean).join(" · ");
  const timing = document.createElement("span");
  timing.className = "response-timing";
  timing.textContent = [firstMs ? `erstes Wort ${(firstMs / 1000).toFixed(1)} s` : "", `${secs} s`].filter(Boolean).join(" · ");
  if (summary) timing.textContent = " · " + timing.textContent;
  meta.replaceChildren(summary, timing);
  current = null;
  send({ type: "history" }); send({ type: "projects" });
}
function showNotice(text) {
  if (!current) startJarvis();
  const p = document.createElement("p");
  p.className = "notice";
  p.textContent = text;
  blocksOf().append(p);
  current.blocks.push({ kind: "notice", el: p });
  stickToBottom();
}
// Gesprochene Äußerung, die der Daemon an das Modell schickt (Fetzen sind schon zusammengefasst)
function heardUser(m) {
  if (m.replace) {  // Nutzer sprach weiter: letzte Nachricht samt abgebrochener Antwort durch die zusammengeführte ersetzen
    if (current) { current.el.remove(); current = null; }
    [...turns.querySelectorAll(".turn.user")].at(-1)?.remove();
  }
  addUser(m.text, m.files);
  startJarvis();
}
function showError(msg) {
  if (/abort/i.test(String(msg))) return;
  if (!current) startJarvis();
  current.el.classList.remove("empty");
  const p = document.createElement("p");
  p.className = "error-text";
  p.textContent = `Fehler: ${msg}`;
  blocksOf().append(p);
  current.blocks.push({ kind: "error", el: p });
}

async function ask(text) {
  text = text.trim();
  if (text.startsWith("/") && !editingMessage && !pending.length) return runSlash(text);
  const edit = editingMessage;
  const session = currentSession;
  const files = [...pending];
  if (!text && !files.length && !edit?.hasFiles) return false;
  const attachments = await Promise.all(files.map(readFile));
  if (editingMessage !== edit || currentSession !== session) return false;
  if (ws?.readyState !== WebSocket.OPEN) throw new Error("Jarvis ist gerade nicht verbunden.");
  if (edit) {
    send({ type: "replace", id: edit.id, messageID: edit.messageID, text, attachments });
    editingMessage = null;
    turns.innerHTML = "";
  } else {
    send({ type: "chat", text, attachments, session: currentSession });
    addUser(text, files);
    startJarvis();
  }
  pending.splice(0, files.length);
  renderChips();
  return true;
}

// ---------- Eingabe ----------
const input = $("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, input.scrollHeight) + "px"; }
function updateSend() {
  const has = !!input.value.trim() || pending.length > 0 || !!editingMessage?.hasFiles;
  $("#send").hidden = state.busy || !(has || dictating);
  $("#send").disabled = !has || sending;
  $("#liveBtn").hidden = has || dictating || state.busy;
}
input.addEventListener("input", () => {
  if (dictating) { dictBase = input.value; taMirror.set(input.value, { animate: false }); }   // eigene Änderungen während des Diktierens bleiben erhalten
  const was = !$("#send").hidden;
  autosize(); updateSend();
  if (!was && !$("#send").hidden) { const c = $("#composer"); c.classList.remove("pulse"); void c.offsetWidth; c.classList.add("pulse"); }
});
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && (preferences.enterSends || e.metaKey || e.ctrlKey)) {
    e.preventDefault(); $("#composer").requestSubmit();
  }
});
$("#composer").addEventListener("submit", e => {
  e.preventDefault();
  if (state.busy || sending) return;
  if (dictating) $("#dictate").click();
  const draft = input.value;
  sending = true;
  updateSend();
  ask(draft).then(sent => {
    if (sent && input.value === draft) input.value = "";
    autosize();
  }).catch(error => {
    reportError("attachments", error);
    toast(error.message);
  }).finally(() => {
    sending = false;
    updateSend();
  });
});
$("#stop").onclick = () => send({ type: "stop" });
$("#emergencyStop").onclick = () => send({ type: "stop", all: true });

// ---------- Anhänge (Fotos und Dateien) ----------
// Grenzen wie im Daemon (core/src/attachments.ts); der Daemon prüft nochmals.
const ATT = { files: 8, fileBytes: 10 * 1024 * 1024, totalBytes: 25 * 1024 * 1024 };
const pending = [];
const isImage = f => /^image\/(png|jpe?g|gif|webp)$/.test(f.type);
const fmtSize = n => n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`;
function fileChip(f, removable) {
  const c = document.createElement("div");
  c.className = "chip";
  if (f instanceof Blob && isImage(f)) {
    f._url ??= URL.createObjectURL(f);
    const im = document.createElement("img"); im.src = f._url; im.alt = ""; c.append(im);
  } else {
    const ic = document.createElement("span"); ic.className = "chip-ic"; ic.dataset.icon = "file"; c.append(ic);
  }
  const t = document.createElement("span"); t.className = "chip-name"; t.textContent = f.name; t.title = Number.isFinite(f.size) ? `${f.name} · ${fmtSize(f.size)}` : f.name; c.append(t);
  if (removable) {
    const x = document.createElement("button");
    x.type = "button"; x.className = "chip-x"; x.setAttribute("aria-label", `${f.name} entfernen`); x.dataset.icon = "x";
    x.onclick = () => { if (sending) return; const i = pending.indexOf(f); if (i >= 0) pending.splice(i, 1); renderChips(); updateSend(); };
    c.append(x);
  }
  paintIcons(c);
  return c;
}
function renderChips() {
  const box = $("#chips");
  box.replaceChildren(...pending.map(f => fileChip(f, true)));
  box.hidden = pending.length === 0;
}
function addFiles(list) {
  const problems = [];
  for (const f of list) {
    const total = pending.reduce((n, p) => n + p.size, 0) + f.size;
    if (pending.length >= ATT.files) { problems.push(`Höchstens ${ATT.files} Anhänge pro Nachricht.`); break; }
    if (f.size === 0) problems.push(`„${f.name}“ ist leer.`);
    else if (f.size > ATT.fileBytes) problems.push(`„${f.name}“ ist größer als ${ATT.fileBytes / 1048576} MB (${fmtSize(f.size)}).`);
    else if (total > ATT.totalBytes) problems.push(`„${f.name}“ passt nicht mehr dazu (zusammen höchstens ${ATT.totalBytes / 1048576} MB).`);
    else pending.push(f);
  }
  renderChips(); updateSend();
  if (problems.length) {
    toast(problems.join(" "));
    send({ type: "client_error", where: "attachments", message: problems.join(" ") });
  }
}
function toast(text) {
  const t = $("#attachNote");
  t.textContent = text; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000);
}
const readFile = f => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve({ name: f.name, mime: f.type || "", data: String(r.result).split(",")[1] ?? "" });
  r.onerror = () => reject(r.error ?? new Error(`„${f.name}“ nicht lesbar`));
  r.readAsDataURL(f);
});
$("#attach").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = e => { addFiles([...e.target.files]); e.target.value = ""; input.focus(); };
// Drag and Drop auf das ganze Fenster, Einfügen (Strg/Cmd+V) von Bildern aus der Zwischenablage
let dragDepth = 0;
const hasFiles = e => [...(e.dataTransfer?.types ?? [])].includes("Files");
addEventListener("dragenter", e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("dropping"); });
addEventListener("dragover", e => { if (hasFiles(e)) e.preventDefault(); });
addEventListener("dragleave", e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dropping"); } });
addEventListener("drop", e => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; document.body.classList.remove("dropping");
  addFiles([...e.dataTransfer.files]);
});
input.addEventListener("paste", e => {
  const files = [...(e.clipboardData?.files ?? [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});

// Diktat: Sprach-Sidecar transkribiert ins Eingabefeld
let dictBase = "";   // bereits fertig diktierter Text; jeder neue Satz wird angehängt statt das Feld zu überschreiben
const dictJoin = t => dictBase && t ? dictBase + (/\s$/.test(dictBase) ? "" : " ") + t : dictBase || t;
const taMirror = new BlurText($("#taMirror"));   // zeigt den diktierten Text mit Einblend-Effekt (nur während des Diktierens sichtbar)
const syncMirrorScroll = () => { $("#taMirror").style.transform = `translateY(${-input.scrollTop}px)`; };
input.addEventListener("scroll", syncMirrorScroll);
function dictShow(t, partial = false) {
  // Zwischentext: Whisper hängt bei abgeschnittenem Wort "…" an ("…über ein E…"); das gehört nicht ins Feld
  if (partial) t = String(t ?? "").replace(/\s*(\.{2,}|…)\s*$/, "");
  // Whisper liefert bei abgeschnittenen Wörtern oder Rauschen manchmal nur "…" / "...": das darf den Text nicht ersetzen
  if (!/[\p{L}\p{N}]/u.test(String(t ?? ""))) return;
  if (!input.value.trim()) dictBase = "";   // Nachricht wurde abgeschickt oder Feld geleert
  input.value = dictJoin(t); autosize(); updateSend();
  taMirror.set(input.value); syncMirrorScroll();
}
$("#dictate").onclick = () => {
  dictating = !dictating;
  if (dictating && state.speech === false) showNotice("Das Sprachmodul startet gerade (ca. 30 s). Diktieren geht, sobald es bereit ist.");
  if (dictating) { dictBase = input.value; taMirror.set(input.value, { animate: false }); }
  $("#dictate").classList.toggle("rec", dictating);
  $("#dictate").innerHTML = icon(dictating ? "player-stop-filled" : "microphone");
  $("#dictate").setAttribute("aria-label", dictating ? "Diktat beenden" : "Diktieren");
  updateSend();
  if (!live.on) setVoiceUi(dictating ? "dictate" : "off");
  send({ type: "voice", mode: dictating ? "dictate" : "off" });
};

// ---------- Seitenleiste / Verlauf ----------
const railBtn = $("#railToggle");
const setRail = open => {
  $("#app").dataset.rail = open ? "open" : "collapsed";
  railBtn.setAttribute("aria-expanded", String(open));
  railBtn.setAttribute("aria-label", open ? "Seitenleiste schließen" : "Seitenleiste öffnen");
  railBtn.title = open ? "Seitenleiste schließen" : "Seitenleiste öffnen";
  railBtn.querySelector("span").innerHTML = icon(open ? "layout-sidebar-left-collapse" : "layout-sidebar-left-expand");
  try { localStorage.setItem("jarvis.rail", open ? "open" : "collapsed"); } catch {}
};
railBtn.onclick = () => setRail($("#app").dataset.rail !== "open");
try { if (localStorage.getItem("jarvis.rail") === "open") setRail(true); } catch {}
$("#newChat").onclick = () => {
  send({ type: "new" }); currentSession = null; renderState(); editingMessage = null; turns.innerHTML = ""; current = null; setZero(true); input.focus();
};

// Chatzeilen werden innerhalb der WebView verschoben. Das native Datei-Drag-and-drop
// braucht dafür weder Daten im Drag-Transfer noch Zugriff auf die Geste.
const chatHistory = $("#history");
let chatDrag = null;
let suppressChatClick = false;

chatHistory.addEventListener("pointerdown", e => {
  if (!e.isPrimary || e.button !== 0) return;
  suppressChatClick = false;
  const row = e.target.closest(".history-chat[data-id]");
  if (!row || e.target.closest(".history-menu")) return;
  chatDrag = { pointer: e.pointerId, row, id: row.dataset.id, x: e.clientX, y: e.clientY };
});

function chatDropTarget(x, y) {
  const target = document.elementFromPoint(x, y)?.closest("[data-chat-drop-folder]");
  return target && chatHistory.contains(target) ? target : null;
}

function updateChatDrag() {
  const drag = chatDrag;
  const bounds = chatHistory.getBoundingClientRect();
  if (drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom) {
    if (drag.y < bounds.top + 24) chatHistory.scrollTop -= 7;
    else if (drag.y > bounds.bottom - 24) chatHistory.scrollTop += 7;
  }
  const target = chatDropTarget(drag.x, drag.y);
  if (drag.target !== target) {
    drag.target?.classList.remove("drop-target");
    target?.classList.add("drop-target");
    drag.target = target;
  }
  drag.frame = requestAnimationFrame(updateChatDrag);
}

window.addEventListener("pointermove", e => {
  const drag = chatDrag;
  if (!drag || e.pointerId !== drag.pointer) return;
  if (!drag.preview) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
    if (!drag.row.isConnected) { chatDrag = null; return; }
    chatHistory.setPointerCapture(e.pointerId);
    suppressChatClick = true;
    drag.row.classList.add("chat-drag-source");
    drag.preview = document.createElement("div");
    drag.preview.className = "chat-drag-preview";
    drag.preview.setAttribute("aria-hidden", "true");
    drag.preview.textContent = drag.row.querySelector(".history-title").textContent;
    document.body.append(drag.preview);
    drag.frame = requestAnimationFrame(updateChatDrag);
  }
  drag.x = e.clientX;
  drag.y = e.clientY;
  drag.preview.style.transform = `translate(${drag.x + 12}px, ${drag.y + 12}px)`;
});

function clearChatDrag() {
  const drag = chatDrag;
  chatDrag = null;
  if (!drag?.preview) return;
  cancelAnimationFrame(drag.frame);
  drag.target?.classList.remove("drop-target");
  drag.row.classList.remove("chat-drag-source");
  drag.preview.remove();
  if (chatHistory.hasPointerCapture(drag.pointer)) chatHistory.releasePointerCapture(drag.pointer);
}

window.addEventListener("pointerup", e => {
  const drag = chatDrag;
  if (!drag || e.pointerId !== drag.pointer) return;
  const folder = drag.preview ? chatDropTarget(e.clientX, e.clientY)?.dataset.chatDropFolder : undefined;
  clearChatDrag();
  const chat = historySessions.find(s => s.id === drag.id);
  if (chat && folder !== undefined && folder !== (chat.folder || "")) {
    send({ type: "chat_action", action: "move", id: chat.id, folder });
  }
});
window.addEventListener("pointercancel", e => { if (e.pointerId === chatDrag?.pointer) clearChatDrag(); });
chatHistory.addEventListener("lostpointercapture", e => { if (e.pointerId === chatDrag?.pointer) clearChatDrag(); });
window.addEventListener("blur", clearChatDrag);
window.addEventListener("keydown", e => { if (e.key === "Escape") clearChatDrag(); });
chatHistory.addEventListener("click", e => {
  if (!suppressChatClick || !e.detail) return;
  suppressChatClick = false;
  e.preventDefault();
  e.stopImmediatePropagation();
}, true);

// Die Liste wird komplett neu aufgebaut. Passiert das zwischen Maus-Druck und Loslassen (Polling,
// Lauf-Punkt, fertige Antwort), verschwindet das gedrückte Element und der Klick geht verloren.
// Darum: unveränderte Daten nicht neu zeichnen, und während ein Zeiger gedrückt ist erst danach.
let historyPressed = false, historyPending = null, historySig = "";
const releaseHistory = () => {
  if (!historyPressed) return;
  historyPressed = false;
  setTimeout(() => { if (!historyPressed && historyPending) { const list = historyPending; historyPending = null; renderHistory(list); } }, 80);
};
chatHistory.addEventListener("pointerdown", e => { if (e.isPrimary) historyPressed = true; }, true);
window.addEventListener("pointerup", releaseHistory, true);
window.addEventListener("pointercancel", releaseHistory, true);
window.addEventListener("blur", releaseHistory);
function renderHistory(list = []) {
  if (historyPressed) { historyPending = list; return; }
  historyPending = null;
  const sig = JSON.stringify([list, chatFolderNames, $("#chatSearch").value, localStorage.getItem("jarvis.collapsedFolders"), localStorage.getItem("jarvis.collapsedHistorySections")]);
  if (sig === historySig && chatHistory.childElementCount) return;
  historySig = sig;
  historySessions = list;
  const folders = [...new Set([...chatFolderNames, ...list.map(s => s.folder).filter(Boolean)])];
  const ul = $("#history"), q = $("#chatSearch").value.trim().toLocaleLowerCase("de-DE"); ul.innerHTML = "";
  const collapsed = new Set(JSON.parse(localStorage.getItem("jarvis.collapsedFolders") || "[]"));
  const collapsedSections = new Set(JSON.parse(localStorage.getItem("jarvis.collapsedHistorySections") || "[]"));
  const isSearching = !!q;
  const addSection = (name, key, closedByDefault = false) => {
    const isOpen = () => isSearching || (closedByDefault ? collapsedSections.has(key) : !collapsedSections.has(key));
    const li = document.createElement("li"); li.className = "history-section";
    const toggle = document.createElement("button"); toggle.className = "history-section-toggle";
    if (key === "chats") toggle.dataset.chatDropFolder = "";
    const label = document.createElement("span"); label.textContent = name;
    toggle.append(label, document.createRange().createContextualFragment(icon("chevron-down")));
    toggle.setAttribute("aria-expanded", String(isOpen()));
    toggle.onclick = () => { collapsedSections.has(key) ? collapsedSections.delete(key) : collapsedSections.add(key); localStorage.setItem("jarvis.collapsedHistorySections", JSON.stringify([...collapsedSections])); renderHistory(historySessions); };
    li.append(toggle); ul.append(li);
    return isOpen();
  };
  const appendChat = (s, parent) => {
    const li = document.createElement("li"); li.className = "history-chat"; li.classList.toggle("active", !!s.active); li.classList.toggle("running", !!s.running); li.dataset.id = s.id;
    if (!s.folder) li.dataset.chatDropFolder = "";
    const title = document.createElement("button"); title.className = "history-title";
    title.textContent = s.title || "Unterhaltung";
    title.onclick = () => openChat(s.id);
    const menu = document.createElement("div"); menu.className = "history-menu";
    const menuToggle = document.createElement("button"); menuToggle.type = "button"; menuToggle.className = "history-menu-toggle";
    menuToggle.title = "Chataktionen"; menuToggle.setAttribute("aria-label", `Aktionen für ${s.title || "Chat"}`);
    menuToggle.setAttribute("aria-expanded", "false"); menuToggle.innerHTML = icon("dots");
    const actions = document.createElement("div"); actions.className = "history-actions"; actions.hidden = true;
    const button = (label, glyph, fn) => { const b = document.createElement("button"); b.type = "button"; b.title = label; b.innerHTML = glyph; const text = document.createElement("span"); text.textContent = label; b.append(text); b.onclick = e => { e.stopPropagation(); actions.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); fn(); }; actions.append(b); };
    if (!s.archived) button(s.pinned ? "Lösen" : "Anpinnen", icon("pin"), () => send({ type: "chat_action", action: "pin", id: s.id, value: !s.pinned }));
    button("Umbenennen", icon("edit"), () => showChatAction("rename", s.id, s.title));
    button(s.archived ? "Wiederherstellen" : "Archivieren", icon("archive"), () => send({ type: "chat_action", action: "archive", id: s.id, value: !s.archived }));
    if (!s.archived) button("Verschieben", icon("folder"), () => showChatAction("move", s.id, s.title, s.folder || ""));
    button("Löschen", icon("trash"), () => showChatAction("delete", s.id, s.title));
    menuToggle.onclick = e => { e.stopPropagation(); const open = actions.hidden; document.querySelectorAll(".history-actions").forEach(el => { el.hidden = true; }); document.querySelectorAll(".history-menu-toggle").forEach(el => el.setAttribute("aria-expanded", "false")); actions.hidden = !open; menuToggle.setAttribute("aria-expanded", String(open)); };
    menu.append(menuToggle, actions); li.append(title, menu); parent.append(li);
  };
  const matches = s => !q || s.title.toLocaleLowerCase("de-DE").includes(q) || (s.folder || "").toLocaleLowerCase("de-DE").includes(q);
  const pinned = list.filter(s => s.pinned && !s.archived && matches(s));
  const archived = list.filter(s => s.archived && matches(s));
  const visible = list.filter(s => !s.pinned && !s.archived && matches(s));
  const addFolder = name => {
    const row = document.createElement("li"); row.className = "history-chat folder-chat"; row.dataset.folder = name;
    const isFolderCollapsed = !isSearching && collapsed.has(name);
    const toggle = document.createElement("button"); toggle.className = "folder-toggle";
    toggle.dataset.chatDropFolder = name;
    const folderLabel = document.createElement("span"); folderLabel.textContent = name; toggle.append(folderLabel);
    toggle.setAttribute("aria-expanded", String(!isFolderCollapsed));
    toggle.setAttribute("aria-label", `${isFolderCollapsed ? "Projekt öffnen" : "Projekt schließen"}: ${name}`);
    toggle.onclick = () => { collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name); localStorage.setItem("jarvis.collapsedFolders", JSON.stringify([...collapsed])); renderHistory(historySessions); };
    const menu = document.createElement("div"); menu.className = "history-menu";
    const menuToggle = document.createElement("button"); menuToggle.type = "button"; menuToggle.className = "history-menu-toggle";
    menuToggle.title = "Projektaktionen"; menuToggle.setAttribute("aria-label", `Aktionen für Projekt ${name}`); menuToggle.setAttribute("aria-expanded", "false"); menuToggle.innerHTML = icon("dots");
    const actions = document.createElement("div"); actions.className = "history-actions"; actions.hidden = true;
    const action = (label, glyph, fn) => { const b = document.createElement("button"); b.type = "button"; b.innerHTML = glyph; const text = document.createElement("span"); text.textContent = label; b.append(text); b.onclick = e => { e.stopPropagation(); actions.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); fn(); }; actions.append(b); };
    action("Umbenennen", icon("edit"), () => showChatAction("rename-folder", "", name, name));
    action("Verschieben", icon("folder"), () => showChatAction("move-folder", "", name));
    action("Löschen", icon("trash"), () => showChatAction("delete-folder", "", name));
    menuToggle.onclick = e => { e.stopPropagation(); const open = actions.hidden; document.querySelectorAll(".history-actions").forEach(el => { el.hidden = true; }); document.querySelectorAll(".history-menu-toggle").forEach(el => el.setAttribute("aria-expanded", "false")); actions.hidden = !open; menuToggle.setAttribute("aria-expanded", String(open)); };
    menu.append(menuToggle, actions);
    const head = document.createElement("div"); head.className = "folder-head"; head.append(toggle, menu); row.append(head);
    if (!isFolderCollapsed) {
      const children = document.createElement("ul"); children.className = "folder-children";
      visible.filter(s => s.folder === name).forEach(s => appendChat(s, children));
      row.append(children);
    }
    ul.append(row);
  };
  if (pinned.length && addSection("Angepinnt", "pinned")) pinned.forEach(s => appendChat(s, ul));
  if (addSection("Projekte", "folders")) folders.forEach(addFolder);
  if (addSection("Chats", "chats")) visible.filter(s => !s.folder).forEach(s => appendChat(s, ul));
  if (archived.length && addSection("Archiviert", "archived", true)) archived.forEach(s => appendChat(s, ul));
}
document.addEventListener("click", () => {
  document.querySelectorAll(".history-actions").forEach(el => { el.hidden = true; });
  document.querySelectorAll(".history-menu-toggle").forEach(el => el.setAttribute("aria-expanded", "false"));
});
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  document.querySelectorAll(".history-actions").forEach(el => { el.hidden = true; });
  document.querySelectorAll(".history-menu-toggle").forEach(el => el.setAttribute("aria-expanded", "false"));
});
function renderMessages(msgs = []) {
  turns.innerHTML = ""; current = null; viewerVisuals = [];
  setZero(msgs.length === 0);
  for (const m of msgs) {
    if (m.role === "user") { const n = addUser(m.text, m.files); n.__message = m; }
    else {
      const n = $("#tplJarvis").content.firstElementChild.cloneNode(true);
      n.classList.add("done");
      const blocks = n.querySelector(".blocks");
      const addText = t => { if (!t.trim()) return; const md = document.createElement("div"); md.className = "md"; md.innerHTML = renderMarkdown(t); blocks.append(md); };
      if (m.order) { let t = ""; for (const o of m.order) { if (o.visual) { addText(t); t = ""; blocks.append(visualCard(o.visual)); rememberVisual(o.visual); } else t += o.text; } addText(t); }
      else addText(m.text);
      turns.append(n);
    }
  }
  conv.scrollTop = conv.scrollHeight;
}

// ---------- Projekte ----------
// ---------- Projekte: Explorer (Projekte = Ordner, Chats = Dateien) ----------
const projectAction = action => send({ type: "project_action", ...action });
let exSel = null;                 // gewähltes Projekt (null = oberste Ebene)
const exOpen = new Set();         // aufgeklappte Projekte im Baum
const pById = id => projectData.projects.find(x => x.id === id);
const childrenOf = id => projectData.projects.filter(x => (x.parentId ?? null) === id);
const chatsOf = id => projectData.chats.filter(c => (c.projectId ?? null) === id);
function projectLabel(id) {
  const names = [], seen = new Set();
  let p = pById(id);
  while (p && !seen.has(p.id)) { seen.add(p.id); names.unshift(p.name); p = pById(p.parentId); }
  return names.join(" / ");
}
const countDeep = id => chatsOf(id).length + childrenOf(id).reduce((n, p) => n + countDeep(p.id), 0);
const fmtDate = t => { if (!t) return ""; const d = new Date(t), now = new Date();
  return d.toDateString() === now.toDateString() ? d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: now.getFullYear() === d.getFullYear() ? undefined : "2-digit" }); };

function exBtn(name, label, fn) {
  const b = document.createElement("button"); b.type = "button"; b.className = "ex-act"; b.title = label; b.setAttribute("aria-label", label);
  b.innerHTML = icon(name); b.onclick = e => { e.stopPropagation(); fn(b); }; return b;
}
function exRename(row, current, save) {
  const name = row.querySelector(".ex-name"); const input = document.createElement("input");
  input.className = "ex-rename"; input.value = current; name.replaceChildren(input); input.focus(); input.select();
  let done = false; const finish = ok => { if (done) return; done = true; const v = input.value.trim(); if (ok && v && v !== current) save(v); else renderProjects(); };
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true); input.onclick = e => e.stopPropagation();
}
function exMoveMenu(anchor, onPick, exclude = new Set()) {
  document.querySelectorAll(".ex-menu").forEach(m => m.remove());
  const menu = document.createElement("div"); menu.className = "ex-menu";
  const add = (label, id, depth) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.style.paddingLeft = `${12 + depth * 14}px`;
    b.onclick = e => { e.stopPropagation(); menu.remove(); onPick(id); }; menu.append(b); };
  add("Ohne Projekt (oberste Ebene)", null, 0);
  const walk = (parent, depth) => { for (const p of childrenOf(parent)) { if (exclude.has(p.id)) continue; add(p.name, p.id, depth + 1); walk(p.id, depth + 1); } };
  walk(null, 0);
  anchor.closest(".ex-row").append(menu);
  const off = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", off, true); } };
  setTimeout(() => document.addEventListener("pointerdown", off, true));
}
const descendants = id => { const out = new Set([id]); const walk = p => childrenOf(p).forEach(c => { out.add(c.id); walk(c.id); }); walk(id); return out; };

function exProjectRow(p) {
  const li = document.createElement("li"); li.className = "ex-row is-folder"; li.tabIndex = 0;
  const n = countDeep(p.id), sub = childrenOf(p.id).length;
  li.innerHTML = `<span class="ex-name">${icon("folder")}<span class="ex-text"></span></span><span class="ex-type">Projekt</span><span class="ex-date">${n} ${n === 1 ? "Chat" : "Chats"}${sub ? ` · ${sub} ${sub === 1 ? "Unterprojekt" : "Unterprojekte"}` : ""}</span><span class="ex-acts"></span>`;
  li.querySelector(".ex-text").textContent = p.name;
  li.onclick = () => { exSel = p.id; exOpen.add(p.id); renderProjects(); };
  li.onkeydown = e => { if (e.key === "Enter") li.click(); };
  li.querySelector(".ex-acts").append(
    exBtn("edit", "Umbenennen", () => exRename(li, p.name, name => projectAction({ op: "update", id: p.id, patch: { name } }))),
    exBtn("move", "Verschieben", b => exMoveMenu(b, to => projectAction({ op: "update", id: p.id, patch: { parentId: to } }), descendants(p.id))),
    exBtn("trash", "Löschen", () => showChatAction("delete-folder", "", projectLabel(p.id))));
  return li;
}
function exChatRow(c) {
  const li = document.createElement("li"); li.className = "ex-row is-chat"; li.tabIndex = 0;
  li.innerHTML = `<span class="ex-name">${icon("message")}<span class="ex-text"></span></span><span class="ex-type">Chat${c.assignedBy === "ki" ? " · KI" : ""}</span><span class="ex-date">${fmtDate(c.updated)}</span><span class="ex-acts"></span>`;
  li.querySelector(".ex-text").textContent = c.title;
  const open = () => { openChat(c.id); $("#projectsDialog").close(); };
  li.onclick = open; li.onkeydown = e => { if (e.key === "Enter") open(); };
  li.querySelector(".ex-acts").append(
    exBtn("move", "In Projekt verschieben", b => exMoveMenu(b, to => projectAction({ op: "assign", id: c.id, projectId: to, by: "manual" }))));
  return li;
}
function exTreeNode(parent, depth, host) {
  for (const p of childrenOf(parent)) {
    const kids = childrenOf(p.id).length, open = exOpen.has(p.id);
    const row = document.createElement("button"); row.type = "button"; row.className = "ex-node" + (exSel === p.id ? " active" : ""); row.style.setProperty("--d", depth);
    row.innerHTML = `<span class="ex-chev${kids ? "" : " none"}${open ? " open" : ""}">${icon("chevron-right")}</span>${icon(open && kids ? "folder-open" : "folder")}<span class="ex-text"></span>`;
    row.querySelector(".ex-text").textContent = p.name;
    row.querySelector(".ex-chev").onclick = e => { e.stopPropagation(); open ? exOpen.delete(p.id) : exOpen.add(p.id); renderProjects(); };
    row.onclick = () => { exSel = p.id; exOpen.add(p.id); renderProjects(); };
    host.append(row);
    if (open) exTreeNode(p.id, depth + 1, host);
  }
}
function renderProjects(m = projectData) {
  projectData = m;
  if (exSel && !pById(exSel)) exSel = null;
  $("#exRoot").dataset.view = exSel ? "detail" : "grid";
  renderProjectGrid();
  // Baum
  const tree = $("#exTree"); tree.innerHTML = "";
  const root = document.createElement("button"); root.type = "button"; root.className = "ex-node" + (exSel === null ? " active" : ""); root.style.setProperty("--d", 0);
  root.innerHTML = `<span class="ex-chev none">${icon("chevron-right")}</span>${icon("home")}<span class="ex-text">Alle Projekte</span>`;
  root.onclick = () => { exSel = null; renderProjects(); };
  tree.append(root); exTreeNode(null, 0, tree);
  // Pfad
  const crumbs = $("#exCrumbs"); crumbs.innerHTML = "";
  const chain = []; for (let p = pById(exSel); p; p = pById(p.parentId)) chain.unshift(p);
  const crumb = (label, id, last) => { const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.className = last ? "last" : "";
    b.onclick = () => { exSel = id; renderProjects(); }; crumbs.append(b); if (!last) crumbs.insertAdjacentHTML("beforeend", icon("chevron-right")); };
  crumb("Projekte", null, chain.length === 0); chain.forEach((p, i) => crumb(p.name, p.id, i === chain.length - 1));
  // Inhalt
  const list = $("#exList"); list.innerHTML = "";
  const subs = childrenOf(exSel), chats = chatsOf(exSel);
  for (const p of subs) list.append(exProjectRow(p));
  for (const c of chats) list.append(exChatRow(c));
  if (!subs.length && !chats.length) {
    const e = document.createElement("li"); e.className = "ex-empty";
    e.textContent = exSel ? "Dieses Projekt ist leer. Ordne Chats zu oder lege Unterprojekte an." : "Noch keine Projekte.";
    list.append(e);
  }
  $("#exStatus").textContent = `${subs.length} ${subs.length === 1 ? "Projekt" : "Projekte"} · ${chats.length} ${chats.length === 1 ? "Chat" : "Chats"}${m.root ? ` · ~/${m.root}` : ""}`;
}
// ---------- Projekte: Übersicht (Kacheln) ----------
const SORTS = {
  recent: ["Zuletzt aktiv", (a, b) => b.act - a.act],
  oldest: ["Älteste Aktivität", (a, b) => a.act - b.act],
  az: ["A bis Z", (a, b) => a.p.name.localeCompare(b.p.name, "de")],
  za: ["Z bis A", (a, b) => b.p.name.localeCompare(a.p.name, "de")],
  newest: ["Neueste zuerst", (a, b) => b.p.created - a.p.created],
  created: ["Älteste zuerst", (a, b) => a.p.created - b.p.created],
  chats: ["Meiste Chats", (a, b) => b.n - a.n],
};
const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
let pgTab = "active", pgQuery = "", pgSort = SORTS[lsGet("jarvis.projectSort", "recent")] ? lsGet("jarvis.projectSort", "recent") : "recent";
// letzte Aktivität = jüngster Chat im Projekt samt Unterprojekten, sonst Erstellzeit
const activityOf = id => { let t = pById(id)?.created ?? 0; for (const c of chatsOf(id)) t = Math.max(t, c.updated || 0); for (const k of childrenOf(id)) t = Math.max(t, activityOf(k.id)); return t; };
const fmtShort = t => { const d = new Date(t), now = new Date(); const h = (now - d) / 3600e3;
  if (h < 1) { const m = Math.max(1, Math.floor(h * 60)); return m === 1 ? "vor 1 Minute" : `vor ${m} Minuten`; }
  if (h < 24) { const n = Math.floor(h); return n === 1 ? "vor 1 Stunde" : `vor ${n} Stunden`; }
  return d.toLocaleDateString("de-DE", { day: "numeric", month: "short", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }); };
const ago = t => {
  const m = Math.floor((Date.now() - t) / 60000);
  if (m < 1) return "gerade eben"; if (m < 60) return `vor ${m} Min.`;
  const h = Math.floor(m / 60); if (h < 24) return `vor ${h} Std.`;
  const d = Math.floor(h / 24); if (d < 30) return d === 1 ? "gestern" : `vor ${d} Tagen`;
  const mo = Math.floor(d / 30); if (mo < 12) return mo === 1 ? "vor 1 Monat" : `vor ${mo} Monaten`;
  const y = Math.floor(d / 365); return y <= 1 ? "vor 1 Jahr" : `vor ${y} Jahren`;
};
function pgMenu(card, p) {
  document.querySelectorAll(".pg-card .ex-menu").forEach(m => m.remove());
  const menu = document.createElement("div"); menu.className = "ex-menu pg-card-menu"; menu.setAttribute("role", "menu");
  const add = (label, glyph, fn) => { const b = document.createElement("button"); b.type = "button"; b.innerHTML = icon(glyph); b.append(label);
    b.onclick = e => { e.stopPropagation(); menu.remove(); fn(); }; menu.append(b); };
  if (!p.archived) add(p.pinned ? "Lösen" : "Anheften", "pin", () => projectAction({ op: "update", id: p.id, patch: { pinned: !p.pinned } }));
  add("Umbenennen", "edit", () => pgRename(card, p));
  add(p.archived ? "Wiederherstellen" : "Archivieren", "archive", () => projectAction({ op: "update", id: p.id, patch: { archived: !p.archived } }));
  add("Löschen", "trash", () => showChatAction("delete-folder", "", projectLabel(p.id)));
  card.append(menu);
  const off = ev => { if (!menu.contains(ev.target)) { menu.remove(); document.removeEventListener("pointerdown", off, true); } };
  setTimeout(() => document.addEventListener("pointerdown", off, true));
}
function pgRename(card, p) {
  const t = card.querySelector(".pg-name"); const input = document.createElement("input");
  input.className = "ex-rename"; input.value = p.name; t.replaceChildren(input); input.focus(); input.select();
  let done = false; const finish = ok => { if (done) return; done = true; const v = input.value.trim(); if (ok && v && v !== p.name) projectAction({ op: "update", id: p.id, patch: { name: v } }); else renderProjectGrid(); };
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true); input.onclick = e => e.stopPropagation();
}
function renderProjectGrid() {
  $("#pgTabActive").setAttribute("aria-selected", String(pgTab === "active"));
  $("#pgTabArchived").setAttribute("aria-selected", String(pgTab === "archived"));
  $("#pgSortLabel").textContent = SORTS[pgSort][0]; $("#pgSortBtn").title = "Sortieren: " + SORTS[pgSort][0];
  const q = pgQuery.trim().toLocaleLowerCase("de-DE");
  const rows = projectData.projects
    .filter(p => !!p.archived === (pgTab === "archived") && (!q || p.name.toLocaleLowerCase("de-DE").includes(q) || (p.description || "").toLocaleLowerCase("de-DE").includes(q)))
    .map(p => ({ p, act: activityOf(p.id), n: countDeep(p.id) }))
    .sort((a, b) => (pgTab === "active" ? (b.p.pinned ? 1 : 0) - (a.p.pinned ? 1 : 0) : 0) || SORTS[pgSort][1](a, b));
  const grid = $("#pgGrid"); grid.replaceChildren();
  for (const { p, act, n } of rows) {
    const card = document.createElement("div"); card.className = "pg-card" + (p.pinned ? " pinned" : ""); card.tabIndex = 0; card.setAttribute("role", "button");
    card.innerHTML = `<div class="pg-ico">${icon("folder")}</div><div class="pg-txt"><div class="pg-name"></div><div class="pg-meta"></div></div>`
      + (p.pinned ? `<span class="pg-pin" title="Angeheftet">${icon("pin")}</span>` : "")
      + `<button type="button" class="pg-more" aria-label="Projektaktionen">${icon("dots-vertical")}</button>`;
    card.querySelector(".pg-name").textContent = p.name;
    card.querySelector(".pg-meta").textContent = fmtShort(act);
    card.title = (p.parentId ? projectLabel(p.parentId) + " / " : "") + p.name + " · " + n + (n === 1 ? " Chat" : " Chats");
    card.onclick = () => { exSel = p.id; exOpen.add(p.id); renderProjects(); };
    card.onkeydown = e => { if (e.target === card && e.key === "Enter") card.click(); };
    card.querySelector(".pg-more").onclick = e => { e.stopPropagation(); pgMenu(card, p); };
    grid.append(card);
  }
  if (!rows.length) {
    const e = document.createElement("div"); e.className = "ex-empty pg-empty";
    e.textContent = q ? "Keine Projekte gefunden." : pgTab === "archived" ? "Keine archivierten Projekte." : "Noch keine Projekte. Lege oben rechts „Neues Projekt“ an.";
    grid.append(e);
  }
}
function pgNew() {
  // neue Kachel mit Namensfeld; Enter legt an, Esc oder leer bricht ab
  if (pgTab !== "active") { pgTab = "active"; renderProjectGrid(); }
  const grid = $("#pgGrid"); grid.querySelector(".pg-empty")?.remove();
  const card = document.createElement("div"); card.className = "pg-card";
  card.innerHTML = `<div class="pg-ico">${icon("folder")}</div><div class="pg-txt"><div class="pg-name"><input class="ex-rename" placeholder="Name des Projekts" aria-label="Projektname"></div><div class="pg-meta">Neues Projekt</div></div>`;
  grid.prepend(card);
  const input = card.querySelector("input"); input.focus(); let done = false;
  const finish = ok => { if (done) return; done = true; const name = input.value.trim(); if (ok && name) projectAction({ op: "create", name, description: "", parent: null }); else renderProjectGrid(); };
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
}
function pgSortMenu() {
  const menu = $("#pgSortMenu"), btn = $("#pgSortBtn");
  if (!menu.hidden) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); return; }
  menu.replaceChildren();
  for (const [key, [label]] of Object.entries(SORTS)) {
    const b = document.createElement("button"); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(key === pgSort));
    b.innerHTML = `<span class="chk">${key === pgSort ? icon("check") : ""}</span>`; b.append(label);
    b.onclick = () => { pgSort = key; lsSet("jarvis.projectSort", key); menu.hidden = true; btn.setAttribute("aria-expanded", "false"); renderProjectGrid(); };
    menu.append(b);
  }
  menu.hidden = false; btn.setAttribute("aria-expanded", "true");
  const off = ev => { if (!menu.contains(ev.target) && !btn.contains(ev.target)) { menu.hidden = true; btn.setAttribute("aria-expanded", "false"); document.removeEventListener("pointerdown", off, true); } };
  setTimeout(() => document.addEventListener("pointerdown", off, true));
}
$("#openProjects").onclick = () => { send({ type: "projects" }); exSel = null; renderProjects(); $("#projectsDialog").showModal(); };
$("#closeProjects").onclick = () => $("#projectsDialog").close();
$("#closeProjectsGrid").onclick = () => $("#projectsDialog").close();
$("#exBack").onclick = () => { exSel = null; renderProjects(); };
$("#pgNew").onclick = pgNew;
$("#pgTabActive").onclick = () => { pgTab = "active"; renderProjectGrid(); };
$("#pgTabArchived").onclick = () => { pgTab = "archived"; renderProjectGrid(); };
$("#pgSearchBtn").onclick = () => { const b = $("#pgSearchBox"); b.classList.toggle("open"); if (b.classList.contains("open")) $("#pgSearch").focus(); else { $("#pgSearch").value = ""; pgQuery = ""; renderProjectGrid(); } };
$("#pgSearch").oninput = e => { pgQuery = e.target.value; renderProjectGrid(); };
$("#pgSortBtn").onclick = pgSortMenu;

// ---------- Live-Ansicht des Tabs ----------
const viewer = $("#viewer");
let viewerTimer, viewerPoll, viewerPicker = false, viewerEpoch = 0, viewerAspect = 0;
let viewerTabs = [], viewerWindows = [], viewerPinned = null, viewerStreaming = null, viewerGotFrame = false, viewerBusy = false, viewerNext = null;
const vcanvas = $("#viewerCanvas"), vctx = vcanvas.getContext("2d");

function renderViewerTabs() {
  const box = $("#viewerTabs"); box.replaceChildren();
  const mk = (label, sel, onclick, iconHtml = "", title = "", onclose = null, extra = "") => {
    const b = document.createElement("button"); b.type = "button"; b.className = "vtab" + (extra ? " " + extra : ""); b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(sel));
    if (iconHtml) b.insertAdjacentHTML("beforeend", iconHtml);
    const t = document.createElement("span"); t.className = "t"; t.textContent = label; b.append(t); b.title = title || label; b.onclick = onclick;
    if (onclose) { // Tab des eigenen Browsers schließen
      const x = document.createElement("span"); x.className = "vtab-x"; x.setAttribute("role", "button"); x.setAttribute("aria-label", "Tab schließen"); x.innerHTML = icon("x");
      x.onclick = e => { e.stopPropagation(); onclose(); }; b.append(x);
    }
    box.append(b);
  };
  mk("Automatisch", viewerPinned === null, () => chooseViewer(null), icon("sparkles"), "Dem Tab oder Fenster folgen, in dem Jarvis gerade arbeitet");
  for (const v of viewerVisuals) {
    const key = `vis:${v.id}`;
    mk(v.title, viewerPinned === key, () => showVisual(v), icon("chart-line"), v.title);
  }
  for (const t of viewerTabs) {
    const fav = t.favicon ? `<img src="${t.favicon.replace(/"/g, "&quot;")}" alt="" referrerpolicy="no-referrer">` : icon(t.chrome ? "brand-chrome" : "world");
    mk(t.title || t.url || "Neuer Tab", t.tab === viewerPinned, () => chooseViewer(t.tab), fav, `${t.chrome ? "Chrome · " : ""}${t.url || t.title || ""}`,
      t.internal ? () => send({ type: "ib", op: "close", tab: t.tab }) : null);
  }
  // Programmfenster (Bildschirmsteuerung): Live-Bild des Fensters, auch wenn es verdeckt ist
  for (const w of viewerWindows) {
    const key = `win:${w.id}`;
    mk(w.title || w.app, viewerPinned === key, () => chooseViewer(key),
      icon("device-desktop"), `${w.app} – ${w.title}${w.onScreen ? "" : " (verdeckt)"}`);
  }
  if (state.internalBrowser !== false) mk("Neuer Tab", false, newBrowserTab, icon("plus"), "Neuen Tab im eingebauten Browser öffnen", null, "vtab-new");
  const empty = $("#viewerEmpty");
  if (String(viewerPinned).startsWith("vis:")) empty.textContent = "";
  else if (!viewerGotFrame) empty.textContent = viewerTabs.length || viewerWindows.length ? "Wähle oben einen Tab oder ein Fenster, um es live zu sehen." : "Noch kein Tab offen. Mit „Neuer Tab“ öffnest du selbst eine Seite, oder bitte Jarvis darum.";
  else empty.textContent = "";
}
const syncViewerButtons = () => { $("#liveView").setAttribute("aria-pressed", String(!viewer.hidden)); $("#viewToggle").setAttribute("aria-pressed", String(!viewer.hidden)); };
function openViewer(picker = false) {
  if (picker) {
    viewerPicker = true;
    state.liveView = true;
    send({ type: "liveview", on: true });
  }
  viewer.hidden = false;
  syncViewerButtons();
  send({ type: "tabs" });
  clearInterval(viewerPoll); viewerPoll = setInterval(() => send({ type: "tabs" }), 3000);
  renderViewerTabs();
}
function resetViewerFrame() {
  viewerEpoch++;
  viewerNext = null;
  viewerGotFrame = false;
  viewerStreaming = null;
  viewerAspect = 0;
  viewer.dataset.idle = "1";
  vctx.clearRect(0, 0, vcanvas.width, vcanvas.height);
  $("#viewerTitle").textContent = "Vorschau";
  $("#viewerHost").textContent = "";
  document.documentElement.style.removeProperty("--viewer-frame-width");
}
function hideViewer() {
  clearVisual(); setInternal(null);
  clearTimeout(viewerTimer); clearInterval(viewerPoll);
  viewer.hidden = true; viewerPicker = false; viewerPinned = null;
  resetViewerFrame();
  syncViewerButtons();
}
function viewerIdle() {
  if (String(viewerPinned).startsWith("vis:")) return; // eine Visualisierung bleibt stehen, bis der Nutzer umschaltet
  viewerPinned = null;
  if (!viewerPicker) hideViewer();
  else { resetViewerFrame(); renderViewerTabs(); }
}
function chooseViewer(target) {
  clearVisual(); setInternal(null);
  viewerPinned = target;
  if (target !== null) viewerPicker = false;
  resetViewerFrame();
  renderViewerTabs();
  if (typeof target === "string") send({ type: "viewer_window", window: Number(target.slice(4)) });
  else send({ type: "viewer_tab", tab: target });
}
const viewerFrame = vcanvas.parentElement;
function sizeViewer() {
  if (!viewerAspect || viewer.hidden) return;
  const width = Math.round(viewerFrame.clientHeight * viewerAspect + 25) + "px";
  const style = document.documentElement.style;
  if (style.getPropertyValue("--viewer-frame-width") !== width) style.setProperty("--viewer-frame-width", width);
}
new ResizeObserver(sizeViewer).observe(viewerFrame);
// Virtuelle Maus: wo Jarvis zuletzt geklickt/getippt hat (Bildschirmpunkt -> Bildpunkt über die Fensterlage)
function drawVirtualCursor(m) {
  if (!preferences.showPreviewCursor || !Array.isArray(m.cursor) || !Array.isArray(m.bounds) || !m.bounds[2]) return;
  const sx = vcanvas.width / m.bounds[2], sy = vcanvas.height / m.bounds[3];
  const x = (m.cursor[0] - m.bounds[0]) * sx, y = (m.cursor[1] - m.bounds[1]) * sy;
  if (x < 0 || y < 0 || x > vcanvas.width || y > vcanvas.height) return;
  const k = Math.max(1, vcanvas.width / 1100);
  vctx.save(); vctx.translate(x, y); vctx.scale(k, k);
  vctx.shadowColor = "rgba(0,0,0,.55)"; vctx.shadowBlur = 8;
  vctx.fillStyle = "#a78bfa"; vctx.strokeStyle = "#fff"; vctx.lineWidth = 1.6;
  vctx.beginPath(); vctx.moveTo(0, 0); vctx.lineTo(0, 23); vctx.lineTo(6, 17); vctx.lineTo(11, 27); vctx.lineTo(15, 25); vctx.lineTo(10, 15); vctx.lineTo(19, 15); vctx.closePath();
  vctx.fill(); vctx.stroke(); vctx.restore();
}
function drawFrame(m) {
  // Dekodieren abseits des Hauptthreads; kommt ein neues Bild, während eins dekodiert wird, zählt nur das neueste
  if (viewerBusy) { viewerNext = m; return; }
  viewerBusy = true;
  const epoch = viewerEpoch;
  const bin = atob(m.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  createImageBitmap(new Blob([bytes], { type: "image/jpeg" })).then(bmp => {
    if (viewer.hidden || epoch !== viewerEpoch || viewerStreaming !== m.tab) { bmp.close(); return; }
    if (vcanvas.width !== bmp.width || vcanvas.height !== bmp.height) { vcanvas.width = bmp.width; vcanvas.height = bmp.height; }
    vctx.drawImage(bmp, 0, 0); bmp.close();
    drawVirtualCursor(m);
  }).catch(() => {}).finally(() => { viewerBusy = false; if (viewerNext) { const n = viewerNext; viewerNext = null; drawFrame(n); } });
}
function showFrame(m) {
  if (state.liveView === false || (viewerPinned !== null && viewerPinned !== m.tab)) return;
  if (viewer.hidden) openViewer();
  viewerPicker = false;
  const changed = viewerStreaming !== m.tab;
  viewerStreaming = m.tab;
  if (m.internal) { // eigener Browser: Größe richtet sich nach dem Vorschaufenster, nicht umgekehrt
    setInternal(m.tab, m);
  } else if (m.w > 0 && m.h > 0 && m.w / m.h !== viewerAspect) {
    viewerAspect = m.w / m.h;
    sizeViewer();
  }
  drawFrame(m);
  $("#viewerTitle").textContent = m.title || "Vorschau";
  try { $("#viewerHost").textContent = new URL(m.url).host.replace(/^www\./, ""); } catch { $("#viewerHost").textContent = ""; }
  delete viewer.dataset.idle;
  if (!viewerGotFrame || changed) { viewerGotFrame = true; renderViewerTabs(); }
  clearTimeout(viewerTimer);
  viewerTimer = setTimeout(() => {
    if (viewerPinned === null) viewerIdle();
    else viewer.dataset.idle = "1";
  }, Math.max(12000, (Number(state.previewIdleSeconds) || 8) * 1000 + 4000)); // Rückfall bei Verbindungsabbruch
}
function viewerTabsMessage(m) {
  viewerTabs = m.tabs || [];
  viewerWindows = m.windows || [];
  if (Object.hasOwn(m, "pinned") && !String(viewerPinned).startsWith("vis:")) viewerPinned = m.pinned;
  if (!viewer.hidden) renderViewerTabs();
}
const closeViewer = () => { state.liveView = false; send({ type: "liveview", on: false }); hideViewer(); };
$("#viewerClose").onclick = closeViewer;
const toggleViewer = () => viewer.hidden ? openViewer(true) : closeViewer();
$("#viewToggle").onclick = toggleViewer;
$("#liveView").onclick = toggleViewer;
try {
  const w = Number(localStorage.getItem("jarvis.viewerW"));
  if (w > 0) document.documentElement.style.setProperty("--viewer-user-width", w + "px");
} catch {}
const viewerGrip = $("#viewerGrip");
viewerGrip.addEventListener("pointerdown", e => {
  viewerGrip.setPointerCapture(e.pointerId);
  viewerGrip.classList.add("drag");
  const move = ev => {
    const width = Math.max(160, Math.round(innerWidth - ev.clientX));
    document.documentElement.style.setProperty("--viewer-user-width", width + "px");
    try { localStorage.setItem("jarvis.viewerW", width); } catch {}
  };
  const finish = () => {
    viewerGrip.classList.remove("drag");
    viewerGrip.removeEventListener("pointermove", move);
    viewerGrip.removeEventListener("lostpointercapture", finish);
  };
  viewerGrip.addEventListener("pointermove", move);
  viewerGrip.addEventListener("lostpointercapture", finish);
});
function resetViewerWidth() {
  document.documentElement.style.removeProperty("--viewer-user-width");
  try { localStorage.removeItem("jarvis.viewerW"); } catch {}
}
viewerGrip.addEventListener("dblclick", resetViewerWidth);

// ---------- Eingebauter Browser: Adressleiste, Größe, Maus und Tastatur ----------
let viewerInternal = null, viewerInfo = { w: 0, h: 0, dpr: 1 }, viewerSent = "", resizeTimer = 0;
const urlInput = $("#viewerUrl");
function setInternal(tab, frame) {
  const changed = viewerInternal !== tab;
  viewerInternal = tab;
  $("#viewerNav").hidden = tab === null;
  if (tab === null) { delete viewer.dataset.internal; return; }
  viewer.dataset.internal = "1";
  if (frame) {
    viewerInfo = { w: frame.w, h: frame.h, dpr: frame.dpr || 1 };
    if (document.activeElement !== urlInput && (changed || urlInput.value !== (frame.url || ""))) urlInput.value = frame.url === "about:blank" ? "" : (frame.url || "");
    fitInternal();
  }
}
/** Viewport des Tabs an die Größe des Vorschaufensters anpassen (scharf: Pixeldichte des Bildschirms) */
function fitInternal(now = false) {
  if (viewerInternal === null || viewer.hidden) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const w = Math.round(viewerFrame.clientWidth), h = Math.round(viewerFrame.clientHeight), dpr = Math.min(3, devicePixelRatio || 1);
    if (w < 120 || h < 80) return;
    const key = `${viewerInternal}:${w}x${h}@${dpr}`;
    if (key === viewerSent) return;
    viewerSent = key;
    send({ type: "ib", op: "resize", tab: viewerInternal, w, h, dpr });
  }, now ? 0 : 120);
}
new ResizeObserver(() => fitInternal()).observe(viewerFrame);
const newBrowserTab = () => { send({ type: "ib", op: "new", url: "about:blank" }); setTimeout(() => urlInput.focus(), 400); };
$("#viewerNav").onsubmit = e => { e.preventDefault(); const url = urlInput.value.trim(); if (viewerInternal !== null && url) { send({ type: "ib", op: "navigate", tab: viewerInternal, url }); vcanvas.focus(); } };
$("#vBack").onclick = () => viewerInternal !== null && send({ type: "ib", op: "back", tab: viewerInternal });
$("#vFwd").onclick = () => viewerInternal !== null && send({ type: "ib", op: "forward", tab: viewerInternal });
$("#vReload").onclick = () => viewerInternal !== null && send({ type: "ib", op: "reload", tab: viewerInternal });
urlInput.addEventListener("focus", () => urlInput.select());
document.addEventListener("keydown", e => { // Cmd/Strg+L: Adressleiste
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "l" && viewerInternal !== null && !viewer.hidden) { e.preventDefault(); urlInput.focus(); }
});

const mods = e => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
/** Punkt im Seiten-Koordinatensystem (CSS-Pixel des Tabs) */
function pagePoint(e) {
  const r = vcanvas.getBoundingClientRect();
  if (!vcanvas.width || !viewerInfo.w) return null;
  const scale = Math.min(r.width / vcanvas.width, r.height / vcanvas.height);
  const cw = vcanvas.width * scale, ch = vcanvas.height * scale;
  const x = (e.clientX - (r.left + (r.width - cw) / 2)) / cw * viewerInfo.w, y = (e.clientY - (r.top + (r.height - ch) / 2)) / ch * viewerInfo.h;
  return x < 0 || y < 0 || x > viewerInfo.w || y > viewerInfo.h ? null : { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}
const sendInput = event => viewerInternal !== null && send({ type: "ib", op: "input", tab: viewerInternal, event });
const BUTTONS = ["left", "middle", "right"];
let moveFrame = 0, lastMove = null;
vcanvas.addEventListener("pointerdown", e => {
  if (viewerInternal === null) return;
  vcanvas.focus(); vcanvas.setPointerCapture(e.pointerId);
  const p = pagePoint(e); if (!p) return;
  e.preventDefault();
  sendInput({ kind: "mouse", type: "mousePressed", ...p, button: BUTTONS[e.button] ?? "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) });
});
vcanvas.addEventListener("pointerup", e => {
  if (viewerInternal === null) return;
  const p = pagePoint(e) ?? lastMove; if (!p) return;
  sendInput({ kind: "mouse", type: "mouseReleased", ...p, button: BUTTONS[e.button] ?? "left", buttons: e.buttons, clickCount: e.detail || 1, modifiers: mods(e) });
});
vcanvas.addEventListener("pointermove", e => {
  if (viewerInternal === null) return;
  const p = pagePoint(e); if (!p) return;
  lastMove = p;
  if (moveFrame) return;
  moveFrame = requestAnimationFrame(() => { moveFrame = 0; sendInput({ kind: "mouse", type: "mouseMoved", ...lastMove, button: e.buttons & 1 ? "left" : "none", buttons: e.buttons, modifiers: mods(e) }); });
});
vcanvas.addEventListener("wheel", e => {
  if (viewerInternal === null) return;
  const p = pagePoint(e); if (!p) return;
  e.preventDefault();
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? viewerInfo.h : 1;
  sendInput({ kind: "mouse", type: "mouseWheel", ...p, deltaX: e.deltaX * k, deltaY: e.deltaY * k, modifiers: mods(e) });
}, { passive: false });
vcanvas.addEventListener("contextmenu", e => { if (viewerInternal !== null) e.preventDefault(); });
const EDIT = { a: "selectAll", c: "copy", x: "cut", z: "undo", y: "redo" };
const pasteText = () => navigator.clipboard?.readText().then(t => t && sendInput({ kind: "text", text: t })).catch(() => {});
function keyEvent(e, type) {
  if (type === "keyDown" && (e.metaKey || e.ctrlKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === "v") { e.preventDefault(); pasteText(); return; }
    if (k === "c") { e.preventDefault(); send({ type: "ib", op: "copy", tab: viewerInternal }); return; }
    if (EDIT[k]) { e.preventDefault(); sendInput({ kind: "key", type: "rawKeyDown", key: e.key, code: e.code, modifiers: mods(e), vk: e.keyCode, commands: [EDIT[k] === "redo" ? "redo" : EDIT[k]] }); return; }
    if (k === "l") return; // Adressleiste
  }
  const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
  if (e.key === "Dead" || e.key === "Process" || e.key === "Unidentified") return;
  e.preventDefault();
  const text = printable ? e.key : e.key === "Enter" ? "\r" : e.key === "Tab" ? "\t" : undefined;
  sendInput({ kind: "key", type: type === "keyUp" ? "keyUp" : text ? "keyDown" : "rawKeyDown", key: e.key, code: e.code, text, modifiers: mods(e), vk: e.keyCode });
}
vcanvas.addEventListener("keydown", e => { if (viewerInternal !== null) keyEvent(e, "keyDown"); });
vcanvas.addEventListener("keyup", e => { if (viewerInternal !== null) keyEvent(e, "keyUp"); });
vcanvas.addEventListener("paste", e => { if (viewerInternal === null) return; e.preventDefault(); const t = e.clipboardData?.getData("text/plain"); if (t) sendInput({ kind: "text", text: t }); });

// ---------- Visualisierungen (Werkzeuge visualize_python / visualize_html) ----------
// Bilder und HTML-Seiten liefert jarvisd unter /visual/<id>/<datei>; HTML läuft in einer abgeschotteten Sandbox.
let viewerVisuals = [];
const visualUrl = (v, f) => `http://${DAEMON}/visual/${v.id}/${encodeURIComponent(f)}`;
const isHtml = f => /\.html$/i.test(f);
function visualMedia(v, f, big = false) {
  if (isHtml(f)) {
    const fr = document.createElement("iframe");
    fr.src = visualUrl(v, f); fr.title = v.title; fr.loading = "lazy";
    // abgeschottet wird über den CSP-Header "sandbox" von jarvisd; ein sandbox-Attribut zusätzlich ließ die Seite leer
    if (!big) fr.className = "visual-frame";
    return fr;
  }
  const img = document.createElement("img");
  img.src = visualUrl(v, f); img.alt = v.title; img.loading = "lazy"; img.decoding = "async";
  return img;
}
function rememberVisual(v) {
  viewerVisuals = [v, ...viewerVisuals.filter(x => x.id !== v.id)].slice(0, 8);
  if (!viewer.hidden) renderViewerTabs();
}
function visualCard(v) {
  const fig = document.createElement("figure");
  fig.className = "visual"; fig.dataset.id = v.id;
  const files = v.files || [];
  const media = document.createElement("div"); media.className = "visual-media" + (files.length > 1 ? " multi" : "");
  for (const f of files) {
    const el = visualMedia(v, f);
    if (el.tagName === "IMG") { el.tabIndex = 0; el.title = "In der Vorschau öffnen"; el.onclick = () => showVisual(v, f); el.onkeydown = e => { if (e.key === "Enter") showVisual(v, f); }; }
    media.append(el);
  }
  const cap = document.createElement("figcaption");
  const t = document.createElement("span"); t.className = "visual-title"; t.textContent = v.title;
  const btn = (ic, label, fn) => { const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn small"; b.title = label; b.setAttribute("aria-label", label); b.innerHTML = icon(ic); b.onclick = fn; return b; };
  cap.insertAdjacentHTML("beforeend", icon("chart-line", "ic visual-ic")); cap.append(t);
  const first = files[0];
  if (first && !isHtml(first)) cap.append(btn("download", "Bild speichern", () => { const a = document.createElement("a"); a.href = visualUrl(v, first); a.download = `${v.title}${first.slice(first.lastIndexOf("."))}`; a.target = "_blank"; a.click(); }));
  cap.append(btn("arrow-up-right", "In der Vorschau öffnen", () => showVisual(v)));
  fig.append(media, cap);
  return fig;
}
function clearVisual() {
  const box = $("#viewerVisual");
  if (box && !box.hidden) { box.hidden = true; box.replaceChildren(); }
  delete viewer.dataset.mode;
}
function showVisual(v, file) {
  rememberVisual(v);
  if (viewer.hidden) openViewer();
  viewerPicker = false;
  resetViewerFrame();
  viewerPinned = `vis:${v.id}`;
  const box = $("#viewerVisual");
  box.replaceChildren(...(file ? [file] : v.files).map(f => visualMedia(v, f, true)));
  box.classList.toggle("multi", !file && v.files.length > 1);
  box.hidden = false;
  viewer.dataset.mode = "visual";
  delete viewer.dataset.idle;
  $("#viewerTitle").textContent = v.title;
  $("#viewerHost").textContent = v.kind === "python" ? "Python" : "HTML";
  renderViewerTabs();
}
function visualEvent(v) {
  if (!v.files?.length) return;
  if (!current) startJarvis();
  current.el.classList.remove("empty");
  const card = visualCard(v);
  blocksOf().append(card);
  current.blocks.push({ kind: "visual", el: card });
  stickToBottom();
  if (state.liveView !== false || live.on) showVisual(v);
  else rememberVisual(v);
}

// ---------- Modus „Computer übernehmen“ ----------
const toggleMode = () => send({ type: "settings", settings: { mode: state.mode === "computer" ? "browser" : "computer" } });
$("#modeSwitch").onclick = toggleMode;
$("#setComputer").onclick = toggleMode;

// ---------- Modellwahl ----------
const GROUPS = { free: "Kostenlos (OpenCode)", lmstudio: "Lokal (LM Studio)", nvidia: "NVIDIA", other: "Weitere" };
function renderModels(filter = "") {
  const list = $("#modelList");
  const f = filter.toLowerCase();
  list.innerHTML = "";
  for (const [g, title] of Object.entries(GROUPS)) {
    const items = state.models.filter(m => m.group === g && m.id.toLowerCase().includes(f));
    if (!items.length) continue;
    const h = document.createElement("div"); h.className = "model-group"; h.textContent = title; list.append(h);
    for (const m of items) {
      const b = document.createElement("button");
      b.className = "model-opt"; b.type = "button";
      b.innerHTML = `<span class="name"></span>${m.vision ? `<span class="tag">Bild</span>` : ""}<span class="check">${m.id === state.model ? icon("check") : ""}</span>`;
      b.querySelector(".name").textContent = m.model;
      b.onclick = () => { send({ type: "settings", settings: { model: m.id } }); $("#modelDialog").close(); };
      list.append(b);
    }
  }
}
$("#chatSearch").addEventListener("input", () => renderHistory(historySessions));
$(".chat-search").addEventListener("click", () => { if ($("#app").dataset.rail !== "open") { setRail(true); requestAnimationFrame(() => $("#chatSearch").focus()); } });
function showChatAction(action, id = "", title = "", value = "") {
  pendingChatAction = { action, id, title };
  const labels = { folder: "Projekt erstellen", rename: "Chat umbenennen", move: "Chat verschieben", delete: "Chat löschen?",
    "rename-folder": "Projekt umbenennen", "move-folder": "Projekt verschieben", "delete-folder": "Projekt löschen?" };
  $("#chatActionTitle").textContent = labels[action];
  const desc = { delete: `„${title}“ wird dauerhaft aus dem Verlauf entfernt.`,
    move: "Projektnamen eingeben oder ein vorhandenes Projekt auswählen. Leer lassen, um den Chat aus dem Projekt zu lösen.",
    "move-folder": "Überprojekt eingeben oder auswählen. Leer lassen für die oberste Ebene.",
    "delete-folder": `Projekt „${title}“ samt Unterprojekten wird gelöscht. Die Chats bleiben erhalten.` };
  $("#chatActionDesc").textContent = desc[action] ?? "";
  $("#chatActionField").hidden = action === "delete" || action === "delete-folder";
  $("#chatActionValue").value = value;
  $("#chatActionValue").placeholder = action === "rename" ? "Chatname" : action === "rename-folder" ? "Neuer Projektname" : action === "move-folder" ? "Überprojekt (leer = oberste Ebene)" : "Projektname";
  $("#chatActionValue").setAttribute("list", "chatFolderOptions");
  $("#chatFolderOptions").replaceChildren(...chatFolderNames.map(name => { const option = document.createElement("option"); option.value = name; return option; }));
  $("#chatActionDialog").showModal();
  if (!action.startsWith("delete")) requestAnimationFrame(() => $("#chatActionValue").focus());
}
$("#chatActionDialog").addEventListener("close", () => {
  const action = pendingChatAction, result = $("#chatActionDialog").returnValue;
  pendingChatAction = null;
  if (!action || result !== "apply") return;
  const value = $("#chatActionValue").value.trim();
  if (action.action === "folder" && value) {
    if (!chatFolderNames.includes(value)) chatFolderNames.push(value);
    renderHistory(historySessions);
    send({ type:"chat_action", action:"folder", name:value });
  }
  else if (action.action === "rename" && value) send({ type:"chat_action", action:"rename", id:action.id, title:value });
  else if (action.action === "move") send({ type:"chat_action", action:"move", id:action.id, folder:value });
  else if (action.action === "delete") send({ type:"chat_action", action:"delete", id:action.id });
  else if (action.action.endsWith("-folder")) {
    const p = projectData.projects.find(x => projectLabel(x.id) === action.title);
    if (!p) return showNotice("Projekt nicht gefunden");
    if (action.action === "rename-folder" && value) projectAction({ op: "update", id: p.id, patch: { name: value } });
    else if (action.action === "delete-folder") projectAction({ op: "delete", id: p.id });
    else if (action.action === "move-folder") {
      const parent = value ? projectData.projects.find(x => projectLabel(x.id) === value || x.name === value) : null;
      if (value && !parent) return showNotice(`Überprojekt „${value}“ gibt es nicht`);
      projectAction({ op: "update", id: p.id, patch: { parentId: parent?.id ?? null } });
    }
  }
});
$("#chatActionValue").addEventListener("keydown", e => {
  if (e.key === "Enter") { e.preventDefault(); $("#chatActionDialog").close("apply"); }
});
$("#modelChip").onclick = () => { renderModels(); $("#modelSearch").value = ""; $("#modelDialog").showModal(); $("#modelSearch").focus(); };
$("#modelSearch").addEventListener("input", e => renderModels(e.target.value));

let usageRange = "7d";
const requestUsage = () => send({ type: "usage", range: usageRange });
for (const b of document.querySelectorAll(".usage-range .chip")) b.onclick = () => {
  usageRange = b.dataset.range;
  for (const c of document.querySelectorAll(".usage-range .chip")) c.classList.toggle("active", c === b);
  requestUsage();
};
const fmtTokens = n => n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} Mio.` : n >= 1e4 ? `${Math.round(n / 1e3)} Tsd.` : n >= 1e3 ? `${(n / 1e3).toFixed(1)} Tsd.` : String(n);
function renderUsage(m) {
  if (m.range !== usageRange) return; // veraltete Antwort
  $("#usageTotal").textContent = m.total.toLocaleString("de-DE");
  $("#usageSplit").textContent = `${m.input.toLocaleString("de-DE")} Eingabe · ${m.output.toLocaleString("de-DE")} Ausgabe · ${m.calls} Aufrufe`;
  const chart = $("#usageChart"); chart.textContent = "";
  const max = Math.max(1, ...m.buckets.map(b => b.input + b.output));
  if (!m.total) { const e = document.createElement("span"); e.className = "empty"; e.textContent = "Noch keine Nutzung in diesem Zeitraum"; chart.append(e); }
  else for (const b of m.buckets) {
    const bar = document.createElement("div"); bar.className = "bar";
    bar.title = `${b.label}: ${(b.input + b.output).toLocaleString("de-DE")} Tokens (${b.input.toLocaleString("de-DE")} Eingabe, ${b.output.toLocaleString("de-DE")} Ausgabe)`;
    const out = document.createElement("i"); out.className = "out"; out.style.height = `${b.output / max * 100}%`;
    const inp = document.createElement("i"); inp.style.height = `${b.input / max * 100}%`;
    bar.append(out, inp); chart.append(bar);
  }
  const list = $("#usageModels"); list.textContent = "";
  for (const x of m.models) {
    const row = document.createElement("div"), a = document.createElement("span"), c = document.createElement("span");
    a.textContent = x.model; c.textContent = `${fmtTokens(x.total)} · ${x.calls}×`; row.append(a, c); list.append(row);
  }
  const first = m.buckets[0]?.label, last = m.buckets.at(-1)?.label;
  $("#usageNote").textContent = (m.total && first ? `${first} bis ${last}. ` : "") +
    (m.estimatedShare > 0 ? `${Math.round(m.estimatedShare * 100)} % der Tokens sind geschätzt (Anbieter lieferte keine Zahlen).` : "");
}
function fillModelSelect(sel, selected) {
  const list = state.models ?? [];
  const key = JSON.stringify([selected, list.map(model => model.id)]);
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    const options = list.map(model => new Option(model.id, model.id));
    if (selected && !list.some(model => model.id === selected)) options.unshift(new Option(selected, selected));
    sel.replaceChildren(...options);
  }
  sel.value = selected || "";
}

function fillDeviceSelect(sel, devices, selected) {
  const list = devices ?? [];
  const key = JSON.stringify([selected, list.map(device => [device.id, device.name])]);
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    const count = new Map();
    for (const device of list) count.set(device.name, (count.get(device.name) ?? 0) + 1);
    const options = list.map(device => new Option(count.get(device.name) > 1 ? `${device.name} (#${device.id})` : device.name, String(device.id)));
    if (selected != null && !list.some(device => device.id === selected))
      options.push(new Option("Gespeichertes Gerät (nicht verbunden)", String(selected)));
    sel.replaceChildren(new Option("Systemstandard", ""), ...options);
  }
  sel.value = selected == null ? "" : String(selected);
}

// ---------- Sprachmodus (Live) ----------
const liveEl = $("#live");
const glow = $("#liveGlow");
let level = 0;
// Diktieren: das Eingabefeld klappt nach oben auf und zeigt Wellen. Der Live-Modus ist eine Vollbild-Ansicht (#live).
const composerEl = $("#composer");
const voiceEl = $("#voice");
function setVoiceUi(mode) { // "off" | "dictate"
  composerEl.dataset.voice = mode;
  voiceEl.setAttribute("aria-hidden", String(mode === "off"));
  if (mode === "dictate") startWaves(); else stopWaves();
}
// Live-Untertitel: zeigt, was der Nutzer gerade sagt, und von Jarvis nur das, was schon gesprochen wird (Satz für Satz, im
// Sprechtempo). Jeder neue Buchstabe erscheint unscharf und wird scharf (BlurText).
const liveBT = new BlurText($("#liveCaption"));
let spokenText = "", spokenCut = 0, revealQ = "", revealTimer = 0, spokenActive = false;
function revealStop() { clearInterval(revealTimer); revealTimer = 0; revealQ = ""; spokenText = ""; spokenCut = 0; spokenActive = false; }
function liveCaption(text, user) {
  revealStop();
  const c = $("#liveCaption");
  const words = text.trim().split(/\s+/).filter(Boolean);
  c.classList.toggle("user", !!user);
  liveBT.set(words.length ? words.slice(-40).join(" ") : "Ich höre zu …", { animate: words.length > 0 });
}
function showSpoken() {
  let view = spokenText.slice(spokenCut);
  if (view.length > 260) { // alte Sätze vorn abschneiden (ohne Animation), damit der Text nicht endlos wächst
    const m = /[.!?…]\s+/.exec(view.slice(40));
    if (m) { spokenCut += 40 + m.index + m[0].length; view = spokenText.slice(spokenCut); liveBT.set(view, { animate: false }); return; }
  }
  liveBT.set(view);
}
function liveSpoken(sentence) {
  const c = $("#liveCaption");
  c.classList.remove("user");
  if (!spokenActive) { liveBT.set("", { animate: false }); spokenText = ""; spokenCut = 0; revealQ = ""; spokenActive = true; }
  const add = sentence.trim();
  if (!add) return;
  revealQ += (spokenText || revealQ ? " " : "") + add;
  if (lessMotion()) {
    clearInterval(revealTimer); revealTimer = 0;
    spokenText += revealQ; revealQ = "";
    liveBT.set(spokenText.slice(-260), { animate: false });
    return;
  }
  if (revealTimer) return;
  revealTimer = setInterval(() => {   // ~20 Zeichen/s, bei Rückstau schneller
    if (!revealQ) { clearInterval(revealTimer); revealTimer = 0; return; }
    const n = revealQ.length > 140 ? 4 : revealQ.length > 70 ? 2 : 1;
    spokenText += revealQ.slice(0, n); revealQ = revealQ.slice(n); showSpoken();
  }, 48);
}
// Der Daemon meldet eine Antwort, die nicht gesprochen werden konnte (Sprachausgabe hing, Nutzer sprach lange weiter …).
// Früher verschwand sie dann still aus der Live-Ansicht und stand nur im Chat.
function liveUnspoken(text) {
  revealStop();
  $("#liveCaption").classList.remove("user");
  liveBT.set(String(text || "").trim().slice(0, 260), { animate: false });
}
function flushSpoken() { if (revealQ) { spokenText += revealQ; revealQ = ""; showSpoken(); } }  // Satz ist zu Ende gesprochen: Rest sofort zeigen
function openLive() {
  if (live.on) return;
  if (state.speech === false) showNotice("Das Sprachmodul startet gerade (ca. 30 s). Live beginnt, sobald es bereit ist.");
  if (dictating) $("#dictate").click();
  live.on = true; live.muted = false;
  liveEl.hidden = false; liveEl.classList.remove("closing"); liveEl.dataset.state = "listening";
  $("#liveMute").classList.remove("muted");
  $("#liveMute").innerHTML = icon("microphone");
  liveCaption("", true);
  send({ type: "voice", mode: "live" });
}
function closeLive() {
  if (!live.on) return;
  live.on = false;
  send({ type: "voice", mode: dictating ? "dictate" : "off" });
  liveEl.classList.add("closing");
  setTimeout(() => { liveEl.hidden = true; }, 250);
}
$("#liveBtn").onclick = openLive;
$("#liveEnd").onclick = closeLive;
$("#liveInterrupt").onclick = () => send({ type: "stop" });
$("#liveMute").onclick = () => {
  live.muted = !live.muted;
  $("#liveMute").classList.toggle("muted", live.muted);
  $("#liveMute").innerHTML = icon(live.muted ? "microphone-off" : "microphone");
  send({ type: "voice", mode: live.muted ? "muted" : "live" });
};
document.addEventListener("keydown", e => { if (e.key === "Escape" && live.on) closeLive(); });

// Wellen: zwei Gruppen übereinander, Blau = Mikrofon (du), Rosa = Ausgabe (Jarvis). Amplitude folgt dem echten Pegel
// der "level"-Ereignisse des Sprach-Sidecars; ohne Ereignisse bleibt nur eine ruhige Grundbewegung.
const canvas = $("#voiceWaves");
let micLvl = 0, outLvl = 0, micRaw = 0, outRaw = 0, rafId = 0, phase = 0, lastT = 0;
const WAVES = [ // Frequenz, Tempo, Anteil an der Amplitude, Deckkraft, Breite
  { f: 1.1, s: 1.0, a: 1.0, o: 1.0, w: 2.4 },
  { f: 1.7, s: -1.3, a: .72, o: .6, w: 1.8 },
  { f: 2.6, s: 1.8, a: .5, o: .42, w: 1.4 },
  { f: 0.8, s: -.7, a: .85, o: .3, w: 3 },
];
function cssColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888"; }
function drawGroup(ctx, w, h, amp, color, shift, t) {
  const mid = h / 2;
  for (const k of WAVES) {
    ctx.beginPath();
    ctx.lineWidth = k.w; ctx.strokeStyle = color; ctx.globalAlpha = k.o * (.35 + .65 * Math.min(1, amp * 3 + .15));
    for (let x = 0; x <= w; x += 3) {
      const u = x / w;
      const env = Math.sin(Math.PI * u) ** 1.6;               // an den Rändern ruhig, in der Mitte hoch
      const y = mid + Math.sin(u * Math.PI * 2 * k.f * 1.5 + t * k.s + shift) * env * k.a * amp * (mid - 4);
      x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}
function frame(now) {
  rafId = requestAnimationFrame(frame);
  try {
    const dt = Math.min(.05, (now - (lastT || now)) / 1000); lastT = now;
    const slow = lessMotion() ? .25 : 1;
    phase += dt * 2.2 * slow;
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    // Pegel glätten: schneller Anstieg, langsames Abklingen
    const mt = live.muted ? 0 : Math.min(1, Math.sqrt(micRaw) * 1.5), ot = Math.min(1, Math.sqrt(outRaw) * 1.5);
    micLvl += (mt - micLvl) * (mt > micLvl ? .4 : .12);
    outLvl += (ot - outLvl) * (ot > outLvl ? .4 : .12);
    micRaw *= .9; outRaw *= .9; // fällt ab, falls keine Ereignisse mehr kommen
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const idle = .06 + .02 * Math.sin(phase * .7);
    drawGroup(ctx, w, h, Math.max(idle, outLvl), cssColor("--brand-pink"), 1.3, phase);
    drawGroup(ctx, w, h, live.muted ? idle * .5 : Math.max(idle, micLvl), cssColor("--primary"), 0, phase * 1.1);
  } catch (e) { stopWaves(); reportError("voice-waves", e); }
}
function startWaves() { if (!rafId) { micRaw = outRaw = 0; lastT = 0; rafId = requestAnimationFrame(frame); } }
function stopWaves() { cancelAnimationFrame(rafId); rafId = 0; micLvl = outLvl = micRaw = outRaw = 0; canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height); }

function speechEvent(m) {
  if (m.event === "ready" && m.devices) { state.devices = m.devices; renderSettingsState(); }
  switch (m.event) {
    case "level": {
      micRaw = Math.max(micRaw, m.mic ?? 0); outRaw = Math.max(outRaw, m.out ?? 0);
      const target = Math.min(1, Math.max(m.mic ?? 0, m.out ?? 0) * 1.6);
      level += (target - level) * 0.35;
      glow.style.setProperty("--lvl", level.toFixed(3));
      break;
    }
    case "speech_start": liveEl.dataset.state = "listening"; break;
    case "partial":
      if (dictating) dictShow(m.text, true);
      else if (live.on) liveCaption(m.text, true);
      break;
    case "final":
      if (dictating) { dictShow(m.text); dictBase = input.value; input.focus(); }
      else if (live.on) liveCaption(m.text, true);  // die Nachricht erscheint, wenn der Daemon sie nach einer Pause abschickt
      break;
    case "say_start": liveEl.dataset.state = "speaking"; break;
    case "say_end": liveEl.dataset.state = "listening"; flushSpoken(); break;
  }
}

// ---------- Tauri-Hülle (globale Hotkeys) ----------
const tauri = window.__TAURI__;
if (tauri?.event) {
  tauri.event.listen("jarvis:focus", () => input.focus());
  tauri.event.listen("jarvis:voice", () => (live.on ? closeLive() : openLive()));
}
document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#newChat").click(); }
});

connect();
setInterval(() => send({ type: "history" }), 60000);
input.focus();

// Test-Zugang (nur Entwicklung): window.__jarvisDebug.handle({...}) spielt Daemon-Nachrichten ein
window.__jarvisDebug = { handle };


// ---------- Schrägstrich-Befehle im Chat ----------
let slashItems = [], slashIndex = 0, slashOpen = false, slashAsked = false;
const SOURCE_LABEL = { builtin: "Jarvis", command: "Befehl", skill: "Skill" };
function slashQuery() { const v = input.value; return v.startsWith("/") && !/\s/.test(v) ? v.slice(1).toLowerCase() : null; }
function slashMatches() {
  const q = slashQuery(); if (q === null) return [];
  const rank = it => (it.name.toLowerCase().startsWith(q) ? 0 : it.name.toLowerCase().includes(q) ? 1 : (it.description || "").toLowerCase().includes(q) ? 2 : 9);
  return slashItems.filter(it => rank(it) < 9).sort((x, y) => rank(x) - rank(y) || (x.source === "builtin" ? -1 : 0) - (y.source === "builtin" ? -1 : 0) || x.name.localeCompare(y.name)).slice(0, 40);
}
function renderSlash() {
  const menu = $("#slashMenu"), items = slashMatches();
  slashOpen = items.length > 0 && slashQuery() !== null && !editingMessage;
  menu.hidden = !slashOpen;
  if (!slashOpen) return;
  slashIndex = Math.min(slashIndex, items.length - 1);
  menu.replaceChildren(...items.map((it, i) => {
    const b = document.createElement("button"); b.type = "button"; b.className = "slash-item"; b.setAttribute("role", "option"); b.setAttribute("aria-selected", String(i === slashIndex));
    b.innerHTML = `<span class="slash-name"></span><span class="slash-desc"></span><span class="slash-src"></span>`;
    b.querySelector(".slash-name").textContent = "/" + it.name;
    b.querySelector(".slash-desc").textContent = it.description || "";
    b.querySelector(".slash-src").textContent = SOURCE_LABEL[it.source] || it.source;
    b.onmousedown = e => { e.preventDefault(); pickSlash(it); };
    return b;
  }));
  menu.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}
function pickSlash(it) {
  input.value = "/" + it.name + " "; autosize(); updateSend(); renderSlash(); input.focus();
  if (it.source === "builtin" && !it.hint) $("#composer").requestSubmit();   // Befehle ohne Argument sofort ausführen
}
input.addEventListener("input", () => {
  if (slashQuery() !== null && !slashAsked) { slashAsked = true; send({ type: "commands" }); }
  slashIndex = 0; renderSlash();
});
input.addEventListener("keydown", e => {
  if (!slashOpen) return;
  const items = slashMatches();
  if (e.key === "ArrowDown") { e.preventDefault(); e.stopImmediatePropagation(); slashIndex = (slashIndex + 1) % items.length; renderSlash(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); e.stopImmediatePropagation(); slashIndex = (slashIndex - 1 + items.length) % items.length; renderSlash(); }
  else if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey && !e.isComposing)) { e.preventDefault(); e.stopImmediatePropagation(); pickSlash(items[slashIndex]); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); input.value = ""; autosize(); updateSend(); renderSlash(); }
}, true);
input.addEventListener("blur", () => setTimeout(() => { $("#slashMenu").hidden = true; slashOpen = false; }, 120));

async function runSlash(text) {
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return false;
  const name = m[1].toLowerCase(), args = m[2].trim();
  const done = () => { input.value = ""; autosize(); updateSend(); renderSlash(); return true; };
  const open = openSettings;
  switch (name) {
    case "neu": $("#newChat").click(); return done();
    case "stop": send({ type: "stop" }); return done();
    case "live": openLive(); return done();
    case "diktat": $("#dictate").click(); return done();
    case "vorschau": toggleViewer(); return done();
    case "projekte": $("#openProjects").click(); return done();
    case "einstellungen": open("general"); return done();
    case "erweiterungen": open("mcp"); return done();
    case "import": open("import"); return done();
    case "modell": {
      const q = args.toLowerCase();
      const hit = q && (state.models || []).find(x => (x.id || "").toLowerCase().includes(q) || (x.model || "").toLowerCase().includes(q));
      if (hit) { send({ type: "settings", settings: { model: hit.id } }); showNotice(`Modell: ${hit.model || hit.id}`); }
      else { renderModels(); $("#modelSearch").value = args; $("#modelDialog").showModal(); }
      return done();
    }
    case "hilfe": {
      if (!slashItems.length) send({ type: "commands" });
      const lines = slashItems.filter(i => i.source === "builtin").map(i => `/${i.name} – ${i.description}`);
      showNotice("Befehle: " + (lines.join(" · ") || "gleich verfügbar") + ". Eigene Befehle und Skills erscheinen, sobald du / tippst.");
      return done();
    }
  }
  const known = slashItems.find(i => i.name.toLowerCase() === name);
  if (!known && !slashItems.length) { send({ type: "commands" }); showNotice("Befehle werden geladen … bitte gleich noch einmal."); return false; }
  if (!known) { showNotice(`Den Befehl „/${name}“ gibt es nicht. /hilfe zeigt alle.`); return false; }
  addUser("/" + name + (args ? " " + args : ""));
  startJarvis();
  send({ type: "run_command", name: known.name, args, session: currentSession });
  return done();
}

// ---------- Große Einstellungen ----------
const PANES = { general: "Allgemein", voice: "Sprache und Audio", display: "Darstellung", control: "Steuerung", privacy: "Datenschutz", usage: "Nutzung", mcp: "MCP-Server", skills: "Skills", commands: "Befehle", plugins: "Plugins", import: "Import" };
let extState = null;
function showSettingsPane(name) {
  $("#settingsSearch").value = "";
  $("#settingsResults").hidden = true;
  document.querySelectorAll(".set-nav-item").forEach(button => {
    const selected = button.dataset.pane === name;
    button.classList.toggle("active", selected);
    if (selected) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
  document.querySelectorAll(".set-pane").forEach(p => { p.hidden = p.dataset.pane !== name; });
  $("#setTitle").textContent = PANES[name] || "";
  if (name === "general") { void refreshAutostart(); if (state.lanAccess) void refreshMobileDevices(); }
  if (name === "usage") requestUsage();
  if (["mcp", "skills", "commands", "plugins"].includes(name)) send({ type: "ext_list" });
}
document.querySelectorAll(".set-nav-item").forEach(b => { b.onclick = () => showSettingsPane(b.dataset.pane); });
$("#closeSettings").onclick = () => $("#settingsDialog").close();
$("#settingsSearch").oninput = event => {
  const query = event.target.value.toLocaleLowerCase("de").trim();
  const results = $("#settingsResults");
  if (!query) {
    showSettingsPane(document.querySelector(".set-nav-item.active")?.dataset.pane ?? "general");
    return;
  }
  document.querySelectorAll(".set-pane").forEach(section => { section.hidden = true; });
  const rows = [...document.querySelectorAll(".set-pane .setting")].filter(row =>
    !row.hidden && row.textContent.toLocaleLowerCase("de").includes(query));
  results.replaceChildren(...rows.map(row => {
    const pane = row.closest(".set-pane").dataset.pane;
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "set-result";
    const title = document.createElement("span"), category = document.createElement("small");
    title.textContent = row.querySelector("label, b")?.textContent ?? "";
    category.textContent = PANES[pane];
    button.append(title, category);
    button.onclick = () => {
      showSettingsPane(pane);
      row.scrollIntoView({ block: "nearest" });
      row.querySelector("button, select")?.focus();
    };
    item.append(button);
    return item;
  }));
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "set-results-empty";
    empty.textContent = "Keine Einstellung gefunden.";
    results.append(empty);
  }
  results.hidden = false;
};
const STATUS_LABEL = { connected: "verbunden", disabled: "aus", failed: "Fehler", needs_auth: "Anmeldung nötig", "?": "…", unbekannt: "startet …" };
function extRow(title, sub, { chip, chipClass, toggle, onToggle, onRemove } = {}) {
  const li = document.createElement("li"); li.className = "ext-row-item";
  const text = document.createElement("div"); text.className = "ext-text";
  const t = document.createElement("b"); t.textContent = title; text.append(t);
  if (sub) { const p = document.createElement("p"); p.textContent = sub; text.append(p); }
  li.append(text);
  if (chip) { const c = document.createElement("span"); c.className = "ext-chip " + (chipClass || ""); c.textContent = chip; li.append(c); }
  if (onToggle) { const b = document.createElement("button"); b.type = "button"; b.className = "toggle-lg small"; b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(!!toggle)); b.setAttribute("aria-label", title); b.onclick = () => { if (ws?.readyState !== WebSocket.OPEN) return showNotice("Jarvis ist gerade nicht verbunden."); b.disabled = true; onToggle(!toggle); }; li.append(b); }
  if (onRemove) { const b = document.createElement("button"); b.type = "button"; b.className = "icon-btn ext-remove"; b.title = "Entfernen"; b.setAttribute("aria-label", "Entfernen"); b.innerHTML = icon("trash"); b.onclick = onRemove; li.append(b); }
  return li;
}
const emptyRow = text => { const li = document.createElement("li"); li.className = "ext-empty"; li.textContent = text; return li; };
function renderExtensions(m) {
  extState = m;
  $("#extMcp").replaceChildren(...m.mcp.map(s => extRow(s.name, `${s.type === "remote" ? "Remote" : "Lokal"} · ${s.detail}${s.error ? " · " + s.error : ""}`, {
    chip: STATUS_LABEL[s.status] || s.status, chipClass: s.status === "connected" ? "ok" : s.status === "failed" ? "bad" : "",
    toggle: s.enabled, onToggle: on => send({ type: "ext_mcp", op: "toggle", name: s.name, enabled: on }),
    onRemove: s.managed ? () => send({ type: "ext_mcp", op: "remove", name: s.name }) : undefined })));
  renderSkills();
  $("#extCommands").replaceChildren(...(m.commands.length ? m.commands.map(c => extRow("/" + c.name, c.description || "", { chip: c.source === "manual" ? "eigener" : c.source,
    onRemove: () => send({ type: "ext_command", op: "remove", name: c.name }) })) : [emptyRow("Noch keine eigenen Befehle. Unten anlegen oder im Import übernehmen.")]));
  $("#extPlugins").replaceChildren(...(m.plugins.length ? m.plugins.map(p => extRow(p, "", { onRemove: () => send({ type: "ext_plugin", op: "remove", name: p }) })) : [emptyRow("Keine Plugins eingetragen.")]));
}
function renderSkills() {
  if (!extState) return;
  const q = $("#skillSearch").value.trim().toLowerCase();
  const list = extState.skills.filter(s => !q || s.name.toLowerCase().includes(q) || (s.description || "").toLowerCase().includes(q)).sort((x, y) => x.source.localeCompare(y.source) || x.name.localeCompare(y.name));
  $("#extSkills").replaceChildren(...(list.length ? list.map(s => extRow(s.name, s.description, { chip: s.source, toggle: !s.disabled,
    onToggle: on => send({ type: "ext_skill", name: s.name, enabled: on }) })) : [emptyRow("Keine Skills gefunden.")]));
}
$("#skillSearch").oninput = renderSkills;
$("#mcpForm").onsubmit = e => {
  e.preventDefault();
  const name = $("#mcpName").value.trim(), target = $("#mcpTarget").value.trim();
  if (!name || !target) return showNotice("Name und Befehl oder URL angeben.");
  send({ type: "ext_mcp", op: "add", name, entry: /^https?:\/\//.test(target) ? { url: target } : { command: target } });
  $("#mcpName").value = ""; $("#mcpTarget").value = "";
};
$("#commandForm").onsubmit = e => {
  e.preventDefault();
  const name = $("#cmdName").value.trim().replace(/^\//, ""), template = $("#cmdTemplate").value.trim();
  if (!name || !template) return showNotice("Name und Anweisung angeben.");
  send({ type: "ext_command", op: "add", name, description: $("#cmdDesc").value.trim(), template });
  $("#cmdName").value = ""; $("#cmdDesc").value = ""; $("#cmdTemplate").value = "";
};
$("#pluginForm").onsubmit = e => {
  e.preventDefault();
  const name = $("#pluginName").value.trim(); if (!name) return;
  send({ type: "ext_plugin", op: "add", name }); $("#pluginName").value = "";
};
// Import
let importFrom = null, importItems = [];
document.querySelectorAll("[data-import]").forEach(b => { b.onclick = () => { importFrom = b.dataset.import; $("#importCount").textContent = "Suche …"; $("#importResult").hidden = false; $("#importList").replaceChildren(); send({ type: "ext_scan", from: importFrom }); }; });
const KIND_LABEL = { mcp: "MCP", skill: "Skill", command: "Befehl", plugin: "Plugin" };
function renderImport(m) {
  importItems = m.items || [];
  const fresh = importItems.filter(i => i.status === "neu").length;
  $("#importCount").textContent = importItems.length ? `${importItems.length} gefunden, ${fresh} neu` : "Nichts gefunden.";
  $("#importList").replaceChildren(...importItems.map(it => {
    const li = extRow(it.name, it.detail, { chip: KIND_LABEL[it.kind] + (it.status === "vorhanden" ? " · schon da" : "") });
    const cb = document.createElement("input"); cb.type = "checkbox"; cb.className = "import-check"; cb.dataset.id = it.id; cb.checked = it.status === "neu" && (it.kind === "command" || it.kind === "plugin");   // MCP-Server starten fremde Programme: bewusst selbst wählen
    li.prepend(cb); return li;
  }));
}
$("#importAll").onclick = () => document.querySelectorAll(".import-check").forEach(cb => { cb.checked = importItems.find(i => i.id === cb.dataset.id)?.status === "neu"; });
$("#importGo").onclick = () => {
  const ids = [...document.querySelectorAll(".import-check:checked")].map(cb => cb.dataset.id);
  if (!ids.length) return showNotice("Nichts ausgewählt.");
  send({ type: "ext_import", from: importFrom, ids }); showNotice("Importiere … Jarvis lädt die Erweiterungen neu.");
  $("#importResult").hidden = true;
};
function openSettings(pane = "general") {
  const dialog = $("#settingsDialog");
  if (!dialog.open) dialog.showModal();
  showSettingsPane(pane);
}

const daemonControls = [...document.querySelectorAll("#settingsDialog [data-daemon]")];
const localControls = [...document.querySelectorAll("#settingsDialog [data-local]")];
const switchRole = (control) => control.getAttribute("role") === "switch";
const paintSetting = (control, value) => {
  if (switchRole(control)) control.setAttribute("aria-checked", String(value === true));
  else if (value !== undefined) control.value = value == null ? "" : String(value);
};

const numeric = new Set(["micDevice", "speakerDevice", "voiceSpeed", "previewIdleSeconds"]);
let mobileEnabled = false;
let mobileExpiry;
const mobileAdmin = async (path, method = "GET") => {
  const response = await fetch(`http://${DAEMON}${path}`, { method });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Anfrage fehlgeschlagen.");
  return data;
};
function mobileAddresses(addresses) {
  $("#mobileAddresses").replaceChildren(...addresses.map(url => {
    const row = document.createElement("p");
    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.target = "_blank";
    link.rel = "noopener";
    row.append(link);
    return row;
  }));
}
function clearMobileCode() {
  clearTimeout(mobileExpiry);
  $("#mobileQr").hidden = true;
  $("#mobileQr").removeAttribute("src");
  $("#mobilePin").textContent = "";
  $("#mobileFingerprint").textContent = "";
}
async function refreshMobileDevices() {
  try {
    const { devices, addresses } = await mobileAdmin("/devices");
    mobileAddresses(addresses);
    $("#mobileDevices").replaceChildren(...devices.map(device => {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = "Widerrufen";
      button.onclick = async () => {
        try { await mobileAdmin(`/devices/${device.id}`, "DELETE"); await refreshMobileDevices(); }
        catch (error) { $("#mobileStatus").textContent = error.message; }
      };
      row.append(document.createTextNode(device.name + " "), button);
      return row;
    }));
  } catch (error) { $("#mobileStatus").textContent = error.message; }
}
$("#mobilePairStart").onclick = async () => {
  try {
    clearMobileCode();
    const data = await mobileAdmin("/pair/start", "POST");
    mobileAddresses(data.addresses);
    $("#mobileQr").src = data.qr;
    $("#mobileQr").hidden = false;
    $("#mobilePin").textContent = `PIN ${data.pin}`;
    $("#mobileFingerprint").textContent = `Zertifikat ${data.fingerprint}`;
    $("#mobileStatus").textContent = "Der Code gilt zwei Minuten.";
    mobileExpiry = setTimeout(() => { clearMobileCode(); void refreshMobileDevices(); }, Math.max(0, data.expires - Date.now()));
  } catch (error) { $("#mobileStatus").textContent = error.message; }
};
function renderSettingsState() {
  $("#mobilePairing").hidden = !state.lanAccess;
  if (mobileEnabled !== !!state.lanAccess) {
    mobileEnabled = !!state.lanAccess;
    if (mobileEnabled) void refreshMobileDevices();
    else clearMobileCode();
  }
  fillModelSelect($("#setChatModel"), state.model);
  fillModelSelect($("#setVoiceModel"), state.voiceModel);
  fillDeviceSelect($("#setMic"), state.devices?.input, state.micDevice);
  fillDeviceSelect($("#setSpeaker"), state.devices?.output, state.speakerDevice);
  for (const control of daemonControls) {
    const key = control.dataset.daemon;
    paintSetting(control, state[key]);
    const audioDevice = key === "micDevice" || key === "speakerDevice";
    control.disabled = state[key] === undefined || (audioDevice && (!state.speech || !state.devices));
  }
  $("#set-actionAnnouncements").disabled ||= state.spokenReplies === false;
  $("#set-previewAuto").disabled ||= state.liveView === false;
  $("#set-previewIdleSeconds").disabled ||= state.liveView === false || state.previewAuto === false;
  $("#voiceSample").disabled = !state.speech || state.busy || state.voice !== "off";
}

for (const control of daemonControls) {
  control.disabled = true;
  const name = control.dataset.daemon;
  const value = () => numeric.has(name) ? (control.value === "" ? null : Number(control.value)) : control.value;
  if (switchRole(control)) {
    control.onclick = () => send({ type: "settings", settings: { [name]: !state[name] } });
  } else {
    control.onchange = () => send({ type: "settings", settings: { [name]: value() } });
  }
}
for (const control of localControls) {
  const name = control.dataset.local;
  paintSetting(control, preferences[name]);
  if (switchRole(control)) {
    control.onclick = () => { setPreference(name, !preferences[name]); paintSetting(control, preferences[name]); };
  } else {
    control.onchange = () => { setPreference(name, control.value); if (name === "textSize") autosize(); };
  }
}
$("#voiceSample").onclick = () => send({ type: "voice_sample" });
$("#resetViewerWidth").onclick = resetViewerWidth;
$("#openSettings").onclick = () => openSettings();

const autostartControl = $("#setAutostart");
const autostartStatus = $("#setAutostartStatus");
function paintAutostart(enabled) {
  paintSetting(autostartControl, enabled);
  autostartStatus.textContent = "Startet Jarvis im Hintergrund.";
}
async function refreshAutostart() {
  if (!tauri?.core?.invoke) return;
  $("#setAutostartRow").hidden = false;
  autostartControl.disabled = true;
  try {
    paintAutostart(await tauri.core.invoke("get_launch_at_login"));
    autostartControl.disabled = false;
  } catch {
    autostartStatus.textContent = "Autostart-Status konnte nicht geladen werden.";
  }
}
autostartControl.onclick = async () => {
  const enabled = autostartControl.getAttribute("aria-checked") !== "true";
  autostartControl.disabled = true;
  try {
    paintAutostart(await tauri.core.invoke("set_launch_at_login", { enabled }));
  } catch {
    autostartStatus.textContent = "Autostart konnte nicht geändert werden.";
  } finally { autostartControl.disabled = false; }
};
if (tauri?.event) tauri.event.listen("jarvis:autostart", event => paintAutostart(event.payload)).catch(() => {});
