// Jarvis-Oberfläche: spricht per WebSocket mit jarvisd (ws://127.0.0.1:7777/ui).
import { TABLER as BASE } from "./tabler.js";
import { CUSTOM } from "./icons-custom.js";
const TABLER = { ...BASE, ...CUSTOM };
import { renderMarkdown } from "./markdown.js";
import { BlurText } from "./blurtext.js";

const $ = s => document.querySelector(s);
const DAEMON = (location.protocol.startsWith("http") && location.port === "7777") ? location.host : "127.0.0.1:7777";

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
let ws, retry = 0;
function connect() {
  ws = new WebSocket(`ws://${DAEMON}/ui`);
  ws.onopen = () => { retry = 0; setOffline(false); };
  ws.onclose = () => { setOffline(true); setTimeout(connect, Math.min(4000, 300 * 2 ** retry++)); };
  ws.onmessage = ev => handle(JSON.parse(ev.data));
}
const send = msg => ws?.readyState === 1 && ws.send(JSON.stringify(msg));
// Fehler der Oberfläche ins zentrale Fehler-Log des Daemons (docs/errors.md)
const reportError = (where, error) => send({ type: "client_error", where, message: String(error?.message ?? error), stack: error?.stack });
addEventListener("error", e => reportError("window.onerror", e.error ?? e.message));
addEventListener("unhandledrejection", e => reportError("unhandledrejection", e.reason));
function setOffline(off) {
  $("#footModel").textContent = off ? "– Jarvis-Dienst nicht erreichbar, verbinde neu …" : state.model;
}

function handle(m) {
  switch (m.type) {
    case "state":
      Object.assign(state, m); renderState(); fillAudioDevices();
      // Früher schickte jede Oberfläche beim ersten "live"-State sofort voice:off und hat damit den
      // Sprachmodus anderer Clients abgewürgt. Der Daemon klärt jetzt die Zuständigkeit (voiceOwner).
      break;
    case "delta": appendText(m.text); break;
    case "tool": toolEvent(m); break;
    case "action": break; // Details kommen über "tool"
    case "latency": if (current) { current.firstMs = m.firstTokenMs; if (m.model) current.model = m.model; } break;
    case "notice": showNotice(m.text); break;
    case "user": heardUser(m); break;
    case "frame": showFrame(m); break;
    case "spoken": if (live.on) liveSpoken(m.text); break;
    case "tabs": viewerTabsMessage(m); break;
    case "viewer_idle": viewerIdle(); break;
    case "error": showError(m.message); break;
    case "stopped": finishTurn("Gestoppt"); break;
    case "speech": speechEvent(m); break;
    case "history": chatFolderNames = m.folders || chatFolderNames; renderHistory(m.sessions); break;
    case "messages": renderMessages(m.messages); break;
    case "session": currentSession = m.id; break;
    case "projects": renderProjects(m); break;
  }
  if (m.type === "state" && !m.busy && current) finishTurn();
}

// ---------- Kopfzeile / Status ----------
const short = id => id ? id.split("/").pop().replace(/-free$/, "") : "…";
function renderState() {
  $("#modelName").textContent = short(state.model);
  $("#footModel").textContent = state.model;
  const pill = $("#browserPill");
  pill.classList.toggle("ok", state.browser);
  pill.title = state.browser ? (state.extStale ? "Chrome-Erweiterung veraltet – unter chrome://extensions neu laden" : "Chrome-Erweiterung verbunden") : "Chrome-Erweiterung nicht verbunden";
  pill.classList.toggle("stale", !!state.extStale);
  $("#modeSwitch").setAttribute("aria-checked", String(state.mode === "computer"));
  $("#setComputer").setAttribute("aria-checked", String(state.mode === "computer"));
  if (state.sttMode) $("#setStt").value = state.sttMode;
  $("#viewToggle").setAttribute("aria-pressed", String(state.liveView !== false));
  if (state.liveView === false && !viewer.hidden) hideViewer();
  $("#stop").hidden = !state.busy;
  updateSend();
  $("#stopBanner").hidden = !(state.busy && state.mode === "computer");
  fillVoiceModels();
}

// ---------- Gespräch ----------
const turns = $("#turns");
const conv = $("#conversation");
const stickToBottom = () => { if (conv.scrollHeight - conv.scrollTop - conv.clientHeight < 160) conv.scrollTop = conv.scrollHeight; };

const setZero = on => { $("#zero").classList.toggle("gone", !on); document.querySelector(".main").classList.toggle("is-zero", on); };
setZero(true);
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
  edit.onclick = () => { const msg = n.__message; if (!msg?.id || !currentSession) return; editingMessage = { id: currentSession, messageID: msg.id, hasFiles: !!msg.files?.length }; input.value = text; autosize(); updateSend(); input.focus(); };
  resend.onclick = () => { const msg = n.__message; if (msg?.id && currentSession) { turns.innerHTML = ""; send({ type: "resend", id: currentSession, messageID: msg.id, text }); } };
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
};
// Laufzeitform für die Kopfzeile ("Öffnet Tab …")
const TOOL_RUNNING = {
  desktop_windows: "Sucht das Fenster", desktop_scan: "Sieht sich den Bildschirm an", desktop_click: "Klickt", desktop_type: "Tippt", desktop_read: "Liest Text",
  desktop_look: "Macht einen Screenshot", browser_tab_open: "Öffnet einen Tab", browser_navigate: "Lädt die Seite",
  browser_wait: "Wartet auf die Seite", browser_scan: "Sieht sich die Seite an", browser_click: "Klickt auf der Seite",
  browser_type: "Schreibt auf der Seite", browser_read: "Liest die Seite", browser_scroll: "Scrollt", bash: "Führt einen Befehl aus",
  webfetch: "Ruft eine Webseite ab", read: "Liest eine Datei", edit: "Bearbeitet eine Datei", write: "Schreibt eine Datei",
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
  el.querySelector(".meta").textContent = [note, short(current.model ?? state.model), firstMs ? `erstes Wort ${(firstMs / 1000).toFixed(1)} s` : "", `${secs} s`]
    .filter(Boolean).join(" · ");
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
    send({ type: "chat", text, attachments });
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
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
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
$("#emergencyStop").onclick = () => send({ type: "stop" });

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
function dictShow(t) {
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
  send({ type: "new" }); currentSession = null; editingMessage = null; turns.innerHTML = ""; current = null; setZero(true); input.focus();
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

function renderHistory(list = []) {
  historySessions = list;
  const folders = [...new Set([...chatFolderNames, ...list.map(s => s.folder).filter(Boolean)])];
  const ul = $("#history"), q = $("#chatSearch").value.trim().toLocaleLowerCase("de-DE"); ul.innerHTML = "";
  const collapsed = new Set(JSON.parse(localStorage.getItem("jarvis.collapsedFolders") || "[]"));
  const collapsedSections = new Set(JSON.parse(localStorage.getItem("jarvis.collapsedHistorySections") || "[]"));
  const isSearching = !!q;
  const addSection = (name, key) => {
    const li = document.createElement("li"); li.className = "history-section";
    const toggle = document.createElement("button"); toggle.className = "history-section-toggle";
    if (key === "chats") toggle.dataset.chatDropFolder = "";
    const label = document.createElement("span"); label.textContent = name;
    toggle.append(label, document.createRange().createContextualFragment(icon("chevron-down")));
    toggle.setAttribute("aria-expanded", String(isSearching || !collapsedSections.has(key)));
    toggle.onclick = () => { collapsedSections.has(key) ? collapsedSections.delete(key) : collapsedSections.add(key); localStorage.setItem("jarvis.collapsedHistorySections", JSON.stringify([...collapsedSections])); renderHistory(historySessions); };
    li.append(toggle); ul.append(li);
    return isSearching || !collapsedSections.has(key);
  };
  const appendChat = (s, parent) => {
    const li = document.createElement("li"); li.className = "history-chat"; li.classList.toggle("active", !!s.active); li.dataset.id = s.id;
    if (!s.folder) li.dataset.chatDropFolder = "";
    const title = document.createElement("button"); title.className = "history-title";
    title.textContent = s.title || "Unterhaltung";
    title.onclick = () => { currentSession = s.id; send({ type: "open", id: s.id }); };
    const menu = document.createElement("div"); menu.className = "history-menu";
    const menuToggle = document.createElement("button"); menuToggle.type = "button"; menuToggle.className = "history-menu-toggle";
    menuToggle.title = "Chataktionen"; menuToggle.setAttribute("aria-label", `Aktionen für ${s.title || "Chat"}`);
    menuToggle.setAttribute("aria-expanded", "false"); menuToggle.innerHTML = icon("menu-2");
    const actions = document.createElement("div"); actions.className = "history-actions"; actions.hidden = true;
    const button = (label, glyph, fn) => { const b = document.createElement("button"); b.type = "button"; b.title = label; b.innerHTML = glyph; const text = document.createElement("span"); text.textContent = label; b.append(text); b.onclick = e => { e.stopPropagation(); actions.hidden = true; menuToggle.setAttribute("aria-expanded", "false"); fn(); }; actions.append(b); };
    button("Umbenennen", icon("edit"), () => showChatAction("rename", s.id, s.title));
    button("Verschieben", icon("folder"), () => showChatAction("move", s.id, s.title, s.folder || ""));
    button("Löschen", icon("trash"), () => showChatAction("delete", s.id, s.title));
    menuToggle.onclick = e => { e.stopPropagation(); const open = actions.hidden; document.querySelectorAll(".history-actions").forEach(el => { el.hidden = true; }); document.querySelectorAll(".history-menu-toggle").forEach(el => el.setAttribute("aria-expanded", "false")); actions.hidden = !open; menuToggle.setAttribute("aria-expanded", String(open)); };
    menu.append(menuToggle, actions); li.append(title, menu); parent.append(li);
  };
  const visible = list.filter(s => !q || s.title.toLocaleLowerCase("de-DE").includes(q) || (s.folder || "").toLocaleLowerCase("de-DE").includes(q));
  const addFolder = name => {
    const row = document.createElement("li"); row.className = "history-chat folder-chat"; row.dataset.folder = name;
    const isFolderCollapsed = !isSearching && collapsed.has(name);
    const toggle = document.createElement("button"); toggle.className = "folder-toggle";
    toggle.dataset.chatDropFolder = name;
    toggle.innerHTML = icon(isFolderCollapsed ? "folder" : "folder-open");
    const folderLabel = document.createElement("span"); folderLabel.textContent = name; toggle.append(folderLabel);
    toggle.setAttribute("aria-expanded", String(!isFolderCollapsed));
    toggle.setAttribute("aria-label", `${isFolderCollapsed ? "Projekt öffnen" : "Projekt schließen"}: ${name}`);
    toggle.onclick = () => { collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name); localStorage.setItem("jarvis.collapsedFolders", JSON.stringify([...collapsed])); renderHistory(historySessions); };
    const menu = document.createElement("div"); menu.className = "history-menu";
    const menuToggle = document.createElement("button"); menuToggle.type = "button"; menuToggle.className = "history-menu-toggle";
    menuToggle.title = "Projektaktionen"; menuToggle.setAttribute("aria-label", `Aktionen für Projekt ${name}`); menuToggle.setAttribute("aria-expanded", "false"); menuToggle.innerHTML = icon("menu-2");
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
  if (addSection("Projekte", "folders")) folders.forEach(addFolder);
  if (addSection("Chats", "chats")) visible.filter(s => !s.folder).forEach(s => appendChat(s, ul));
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
  turns.innerHTML = ""; current = null;
  setZero(msgs.length === 0);
  for (const m of msgs) {
    if (m.role === "user") { const n = addUser(m.text, m.files); n.__message = m; }
    else {
      const n = $("#tplJarvis").content.firstElementChild.cloneNode(true);
      n.classList.add("done");
      const md = document.createElement("div"); md.className = "md"; md.innerHTML = renderMarkdown(m.text);
      n.querySelector(".blocks").append(md);
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
  const open = () => { currentSession = c.id; send({ type: "open", id: c.id }); $("#projectsDialog").close(); };
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
    e.textContent = exSel ? "Dieses Projekt ist leer. Ordne Chats zu oder lege Unterprojekte an." : "Noch keine Projekte. Lege oben „Neues Projekt“ an.";
    list.append(e);
  }
  $("#exStatus").textContent = `${subs.length} ${subs.length === 1 ? "Projekt" : "Projekte"} · ${chats.length} ${chats.length === 1 ? "Chat" : "Chats"}${m.root ? ` · ~/${m.root}` : ""}`;
}
$("#openProjects").onclick = () => { send({ type: "projects" }); renderProjects(); $("#projectsDialog").showModal(); };
$("#closeProjects").onclick = () => $("#projectsDialog").close();
$("#analyzeProjects").onclick = () => projectAction({ op: "analyze" });
$("#exNew").onclick = () => {
  const list = $("#exList"); const li = document.createElement("li"); li.className = "ex-row is-folder";
  li.innerHTML = `<span class="ex-name">${icon("folder")}<input class="ex-rename" placeholder="Name des Projekts" aria-label="Projektname"></span><span class="ex-type">Projekt</span><span class="ex-date"></span><span class="ex-acts"></span>`;
  list.querySelector(".ex-empty")?.remove(); list.prepend(li);
  const input = li.querySelector("input"); input.focus(); let done = false;
  const finish = ok => { if (done) return; done = true; const name = input.value.trim(); if (ok && name) { projectAction({ op: "create", name, description: "", parent: exSel }); if (exSel) exOpen.add(exSel); } else renderProjects(); };
  input.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); finish(true); } else if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
};

// ---------- Live-Ansicht des Tabs ----------
const viewer = $("#viewer");
let viewerTimer, viewerPoll, viewerPicker = false, viewerEpoch = 0, viewerAspect = 0;
let viewerTabs = [], viewerWindows = [], viewerPinned = null, viewerStreaming = null, viewerGotFrame = false, viewerBusy = false, viewerNext = null;
const vcanvas = $("#viewerCanvas"), vctx = vcanvas.getContext("2d");

function renderViewerTabs() {
  const box = $("#viewerTabs"); box.replaceChildren();
  const mk = (label, sel, onclick, iconHtml = "", title = "") => {
    const b = document.createElement("button"); b.type = "button"; b.className = "vtab"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(sel));
    if (iconHtml) b.insertAdjacentHTML("beforeend", iconHtml);
    const t = document.createElement("span"); t.className = "t"; t.textContent = label; b.append(t); b.title = title || label; b.onclick = onclick; box.append(b);
  };
  mk("Automatisch", viewerPinned === null, () => chooseViewer(null), icon("sparkles"), "Dem Tab oder Fenster folgen, in dem Jarvis gerade arbeitet");
  for (const t of viewerTabs) {
    const fav = t.favicon ? `<img src="${t.favicon.replace(/"/g, "&quot;")}" alt="" referrerpolicy="no-referrer">` : icon("world");
    mk(t.title || t.url || "Tab", t.tab === viewerPinned, () => chooseViewer(t.tab), fav, t.url || t.title);
  }
  // Programmfenster (Bildschirmsteuerung): Live-Bild des Fensters, auch wenn es verdeckt ist
  for (const w of viewerWindows) {
    const key = `win:${w.id}`;
    mk(w.title || w.app, viewerPinned === key, () => chooseViewer(key),
      icon("device-desktop"), `${w.app} – ${w.title}${w.onScreen ? "" : " (verdeckt)"}`);
  }
  const empty = $("#viewerEmpty");
  if (!viewerGotFrame) empty.textContent = viewerTabs.length || viewerWindows.length ? "Wähle oben einen Tab oder ein Fenster, um es live zu sehen." : "Noch keine Tabs in der Gruppe „Jarvis“. Bitte Jarvis, eine Seite zu öffnen.";
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
  clearTimeout(viewerTimer); clearInterval(viewerPoll);
  viewer.hidden = true; viewerPicker = false; viewerPinned = null;
  resetViewerFrame();
  syncViewerButtons();
}
function viewerIdle() {
  viewerPinned = null;
  if (!viewerPicker) hideViewer();
  else { resetViewerFrame(); renderViewerTabs(); }
}
function chooseViewer(target) {
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
  if (!Array.isArray(m.cursor) || !Array.isArray(m.bounds) || !m.bounds[2]) return;
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
  if (m.w > 0 && m.h > 0 && m.w / m.h !== viewerAspect) {
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
  }, 12000); // Rückfall, falls die Verbindung ohne viewer_idle abreißt
}
function viewerTabsMessage(m) {
  viewerTabs = m.tabs || [];
  viewerWindows = m.windows || [];
  if (Object.hasOwn(m, "pinned")) viewerPinned = m.pinned;
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
viewerGrip.addEventListener("dblclick", () => {
  document.documentElement.style.removeProperty("--viewer-user-width");
  try { localStorage.removeItem("jarvis.viewerW"); } catch {}
});

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
$("#newFolder").onclick = () => { setRail(true); showChatAction("folder"); };
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
$("#openSettings").onclick = () => $("#settingsDialog").showModal();
function fillVoiceModels() {
  const sel = $("#setVoiceModel");
  const want = state.voiceModel || "opencode/deepseek-v4.1-flash-free";
  if (sel.options.length !== state.models.length) {
    sel.innerHTML = "";
    for (const m of state.models) sel.add(new Option(m.id, m.id));
  }
  sel.value = want;
}
$("#setStt").onchange = e => send({ type: "settings", settings: { sttMode: e.target.value } });
$("#setVoiceModel").onchange = e => send({ type: "settings", settings: { voiceModel: e.target.value } });

// Audiogeräte: Der Sidecar meldet sie im "ready"-Event, der Daemon cached sie im State.
function fillAudioDevices() {
  const inputs = state.devices?.input ?? [];
  const sel = $("#setMic");
  const key = inputs.map(d => `${d.id}:${d.name}`).join("|");
  if (sel.dataset.key !== key) {
    sel.dataset.key = key;
    sel.innerHTML = "";
    sel.add(new Option("Systemstandard", ""));
    const count = new Map();
    for (const d of inputs) count.set(d.name, (count.get(d.name) ?? 0) + 1);
    // Windows listet dasselbe Mikrofon mehrfach (WASAPI/DirectSound). Die ID macht die Auswahl eindeutig.
    for (const d of inputs) sel.add(new Option(count.get(d.name) > 1 ? `${d.name} (#${d.id})` : d.name, String(d.id)));
  }
  const want = state.micDevice == null ? "" : String(state.micDevice);
  if (want && !inputs.some(d => String(d.id) === want) && ![...sel.options].some(o => o.value === want))
    sel.add(new Option(`${want} (nicht verbunden)`, want));
  sel.value = want;
}
$("#setMic").onchange = e => send({ type: "settings", settings: { micDevice: e.target.value === "" ? null : Number(e.target.value) } });

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
  if (revealTimer) return;
  revealTimer = setInterval(() => {   // ~20 Zeichen/s, bei Rückstau schneller
    if (!revealQ) { clearInterval(revealTimer); revealTimer = 0; return; }
    const n = revealQ.length > 140 ? 4 : revealQ.length > 70 ? 2 : 1;
    spokenText += revealQ.slice(0, n); revealQ = revealQ.slice(n); showSpoken();
  }, 48);
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
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
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
    const slow = reduceMotion.matches ? .25 : 1;
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
  if (m.event === "ready" && m.devices) { state.devices = m.devices; fillAudioDevices(); }
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
      if (dictating) dictShow(m.text);
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
