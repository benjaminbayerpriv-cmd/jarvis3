// Jarvis-Oberfläche: spricht per WebSocket mit jarvisd (ws://127.0.0.1:7777/ui).
import { TABLER as BASE } from "./tabler.js";
import { CUSTOM } from "./icons-custom.js";
const TABLER = { ...BASE, ...CUSTOM };
import { renderMarkdown } from "./markdown.js";

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
const paintIcons = (root = document) => root.querySelectorAll("[data-icon]").forEach(el => {
  if (!el.dataset.painted) { el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon)); el.dataset.painted = "1"; }
});
paintIcons();

// ---------- Zustand ----------
const state = { model: "", mode: "browser", busy: false, browser: false, models: [], voiceModel: "", lofi: false, micDevice: null, devices: null };
let current = null;        // aktuelle Jarvis-Antwort {el, text, started}
let currentSession = null;
let historySessions = [];
let chatFolderNames = [];
let editingMessage = null;
let pendingChatAction = null;
let live = { on: false, muted: false };

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
    case "stream_ended": hideViewer(); break;
    case "error": showError(m.message); break;
    case "stopped": finishTurn("Gestoppt"); break;
    case "speech": speechEvent(m); break;
    case "history": chatFolderNames = m.folders || chatFolderNames; renderHistory(m.sessions); break;
    case "messages": renderMessages(m.messages); break;
    case "session": currentSession = m.id; break;
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
  $("#setLofi").setAttribute("aria-checked", String(!!state.lofi));
  $("#viewToggle").setAttribute("aria-pressed", String(state.liveView !== false));
  if (state.liveView === false) hideViewer();
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
function addUser(text) {
  setZero(false);
  const n = $("#tplUser").content.firstElementChild.cloneNode(true);
  n.querySelector(".bubble").textContent = text;
  const tools = document.createElement("div"); tools.className = "user-tools";
  const edit = document.createElement("button"); edit.type = "button"; edit.title = "Bearbeiten"; edit.setAttribute("aria-label", "Nachricht bearbeiten"); edit.innerHTML = icon("edit");
  const resend = document.createElement("button"); resend.type = "button"; resend.title = "Erneut senden"; resend.setAttribute("aria-label", "Nachricht erneut senden"); resend.innerHTML = icon("refresh");
  tools.append(edit, resend); n.append(tools);
  edit.onclick = () => { const msg = n.__message; if (!msg?.id || !currentSession) return; editingMessage = { id: currentSession, messageID: msg.id }; input.value = text; autosize(); updateSend(); input.focus(); };
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
  if (live.on) liveCaption(current.text, false);
}
function paintText(b) {
  const before = b.el.children.length;
  b.el.innerHTML = renderMarkdown(b.text);
  [...b.el.children].forEach((el, i) => { if (i >= Math.max(0, before - 1) && !b.faded.has(i)) { el.classList.add("fade"); b.faded.add(i); } });
}

const TOOL_LABEL = {
  desktop_scan: "Bildschirm ansehen", desktop_click: "Klicken", desktop_type: "Tippen", desktop_scroll: "Scrollen",
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
  desktop_scan: "Sieht sich den Bildschirm an", desktop_click: "Klickt", desktop_type: "Tippt", desktop_read: "Liest Text",
  desktop_look: "Macht einen Screenshot", browser_tab_open: "Öffnet einen Tab", browser_navigate: "Lädt die Seite",
  browser_wait: "Wartet auf die Seite", browser_scan: "Sieht sich die Seite an", browser_click: "Klickt auf der Seite",
  browser_type: "Schreibt auf der Seite", browser_read: "Liest die Seite", browser_scroll: "Scrollt", bash: "Führt einen Befehl aus",
  webfetch: "Ruft eine Webseite ab", read: "Liest eine Datei", edit: "Bearbeitet eine Datei", write: "Schreibt eine Datei",
};
const baseName = n => n.replace(/^jarvis_/, "");
function detail(input = {}, title) {
  const v = input.url ?? (typeof input.text === "string" ? `„${input.text.slice(0, 60)}“` : undefined)
    ?? input.combo ?? input.name ?? input.command ?? input.filePath ?? input.pattern
    ?? (input.id !== undefined ? `Element ${input.id}` : undefined) ?? title;
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
  send({ type: "history" });
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
  addUser(m.text);
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

function ask(text) {
  text = text.trim();
  if (!text) return;
  if (editingMessage) {
    const edit = editingMessage; editingMessage = null;
    turns.innerHTML = "";
    send({ type: "replace", ...edit, text });
    return;
  }
  addUser(text);
  startJarvis();
  send({ type: "chat", text });
}

// ---------- Eingabe ----------
const input = $("#input");
function autosize() { input.style.height = "auto"; input.style.height = Math.min(240, input.scrollHeight) + "px"; }
function updateSend() {
  const has = input.value.trim().length > 0;
  $("#send").hidden = state.busy || !has;
  $("#liveBtn").hidden = has || state.busy;
}
input.addEventListener("input", () => {
  if (dictating) dictBase = input.value;   // eigene Änderungen während des Diktierens bleiben erhalten
  const was = !$("#send").hidden;
  autosize(); updateSend();
  if (!was && !$("#send").hidden) { const c = $("#composer"); c.classList.remove("pulse"); void c.offsetWidth; c.classList.add("pulse"); }
});
input.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#composer").requestSubmit(); }
});
$("#composer").addEventListener("submit", e => {
  e.preventDefault();
  if (state.busy) return;
  ask(input.value); input.value = ""; autosize(); updateSend();
});
$("#stop").onclick = () => send({ type: "stop" });
$("#emergencyStop").onclick = () => send({ type: "stop" });
$("#attach").onclick = () => input.focus();

// Diktat: Sprach-Sidecar transkribiert ins Eingabefeld
let dictating = false;
let dictBase = "";   // bereits fertig diktierter Text; jeder neue Satz wird angehängt statt das Feld zu überschreiben
const dictJoin = t => dictBase && t ? dictBase + (/\s$/.test(dictBase) ? "" : " ") + t : dictBase || t;
function dictShow(t) {
  if (!input.value.trim()) dictBase = "";   // Nachricht wurde abgeschickt oder Feld geleert
  input.value = dictJoin(t); autosize(); updateSend();
}
$("#dictate").onclick = () => {
  dictating = !dictating;
  if (dictating) dictBase = input.value;
  $("#dictate").classList.toggle("rec", dictating);
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
function renderHistory(list = []) {
  historySessions = list;
  const folders = chatFolderNames.length ? chatFolderNames : [...new Set(list.map(s => s.folder).filter(Boolean))];
  const ul = $("#history"), q = $("#chatSearch").value.trim().toLocaleLowerCase("de-DE"); ul.innerHTML = "";
  const collapsed = new Set(JSON.parse(localStorage.getItem("jarvis.collapsedFolders") || "[]"));
  const appendChat = (s, parent) => {
    const li = document.createElement("li"); li.className = "history-chat"; li.draggable = true; li.classList.toggle("active", !!s.active); li.dataset.id = s.id;
    const title = document.createElement("button"); title.className = "history-title"; title.textContent = s.title || "Unterhaltung"; title.title = title.textContent;
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
    li.addEventListener("dragstart", e => { e.dataTransfer.setData("text/plain", s.id); e.dataTransfer.effectAllowed = "move"; });
  };
  const visible = list.filter(s => !q || s.title.toLocaleLowerCase("de-DE").includes(q) || (s.folder || "").toLocaleLowerCase("de-DE").includes(q));
  const addFolder = name => {
    const row = document.createElement("li"); row.className = "folder-row"; row.dataset.folder = name;
    const toggle = document.createElement("button"); toggle.className = "folder-toggle"; toggle.innerHTML = icon(collapsed.has(name) ? "folder" : "folder-open"); const folderLabel = document.createElement("span"); folderLabel.textContent = name; toggle.append(folderLabel); toggle.setAttribute("aria-expanded", String(!collapsed.has(name)));
    toggle.onclick = () => { collapsed.has(name) ? collapsed.delete(name) : collapsed.add(name); localStorage.setItem("jarvis.collapsedFolders", JSON.stringify([...collapsed])); renderHistory(historySessions); };
    row.append(toggle); row.addEventListener("dragover", e => { e.preventDefault(); row.classList.add("drop-target"); }); row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
    row.addEventListener("drop", e => { e.preventDefault(); row.classList.remove("drop-target"); send({type:"chat_action", action:"move", id:e.dataTransfer.getData("text/plain"), folder:name}); }); ul.append(row);
    if (!collapsed.has(name)) visible.filter(s => s.folder === name).forEach(s => appendChat(s, ul));
  };
  folders.forEach(addFolder);
  const loose = visible.filter(s => !s.folder); if (loose.length) { const section = document.createElement("li"); section.className = "folder-row loose-row"; section.textContent = "Zuletzt"; ul.append(section); loose.forEach(s => appendChat(s, ul)); }
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
    if (m.role === "user") { const n = addUser(m.text); n.__message = m; }
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

// ---------- Live-Ansicht des Tabs ----------
const viewer = $("#viewer");
let viewerTimer;
let viewTab, viewRatio = 0;
function showFrame(m) {
  if (state.liveView === false) return;
  // Seitenverhältnis des Tabs übernehmen; kleine Schwankungen (z. B. Chromes Hinweisleiste) ignorieren
  if (m.w > 0 && m.h > 0) {
    const ratio = m.w / m.h;
    if (m.tab !== viewTab || Math.abs(ratio - viewRatio) / viewRatio > 0.10) {
      viewTab = m.tab; viewRatio = ratio;
      viewer.style.setProperty("--ar", `${m.w} / ${m.h}`);
    }
  }
  $("#viewerImg").src = "data:image/jpeg;base64," + m.data;
  $("#viewerTitle").textContent = m.title || "Tab";
  try { $("#viewerHost").textContent = new URL(m.url).host.replace(/^www\./, ""); } catch { $("#viewerHost").textContent = ""; }
  if (viewer.hidden) { viewer.classList.remove("leaving"); viewer.hidden = false; }
  clearTimeout(viewerTimer);
  viewerTimer = setTimeout(hideViewer, 6000); // keine Bilder mehr -> Ansicht ausblenden
}
function hideViewer() {
  clearTimeout(viewerTimer);
  if (viewer.hidden) return;
  viewer.classList.add("leaving");
  setTimeout(() => { if (viewer.classList.contains("leaving")) { viewer.hidden = true; viewer.classList.remove("leaving"); } }, 200);
}
$("#viewerHead").onclick = e => { if (!e.target.closest("#viewerClose")) viewer.classList.toggle("big"); };
$("#viewerClose").onclick = () => { send({ type: "liveview", on: false }); hideViewer(); };
$("#viewToggle").onclick = () => send({ type: "liveview", on: state.liveView === false });

// ---------- Modus „Computer übernehmen“ ----------
const toggleMode = () => send({ type: "settings", settings: { mode: state.mode === "computer" ? "browser" : "computer" } });
$("#modeSwitch").onclick = toggleMode;
$("#setComputer").onclick = toggleMode;
$("#setLofi").onclick = () => send({ type: "settings", settings: { lofi: !state.lofi } });

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
$("#newFolder").onclick = () => showChatAction("folder");
function showChatAction(action, id = "", title = "", value = "") {
  pendingChatAction = { action, id, title };
  const labels = { folder: "Ordner erstellen", rename: "Chat umbenennen", move: "Chat verschieben", delete: "Chat löschen?" };
  $("#chatActionTitle").textContent = labels[action];
  $("#chatActionDesc").textContent = action === "delete" ? `„${title}“ wird dauerhaft aus dem Verlauf entfernt.` : action === "move" ? "Ordnernamen eingeben oder einen vorhandenen Ordner auswählen. Leer lassen, um den Chat aus dem Ordner zu lösen." : "";
  $("#chatActionField").hidden = action === "delete";
  $("#chatActionValue").value = value;
  $("#chatActionValue").placeholder = action === "folder" ? "Ordnername" : action === "rename" ? "Chatname" : "Ordnername";
  $("#chatActionValue").setAttribute("list", "chatFolderOptions");
  $("#chatFolderOptions").replaceChildren(...chatFolderNames.map(name => { const option = document.createElement("option"); option.value = name; return option; }));
  $("#chatActionDialog").showModal();
  if (action !== "delete") requestAnimationFrame(() => $("#chatActionValue").focus());
}
$("#chatActionDialog").addEventListener("close", () => {
  const action = pendingChatAction, result = $("#chatActionDialog").returnValue;
  pendingChatAction = null;
  if (!action || result !== "apply") return;
  const value = $("#chatActionValue").value.trim();
  if (action.action === "folder" && value) send({ type:"chat_action", action:"folder", name:value });
  else if (action.action === "rename" && value) send({ type:"chat_action", action:"rename", id:action.id, title:value });
  else if (action.action === "move") send({ type:"chat_action", action:"move", id:action.id, folder:value });
  else if (action.action === "delete") send({ type:"chat_action", action:"delete", id:action.id });
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
function liveCaption(text, user) {
  const c = $("#liveCaption");
  const words = text.trim().split(/\s+/);
  c.textContent = words.slice(-40).join(" ") || "Ich höre zu …";
  c.classList.toggle("user", !!user);
}
function openLive() {
  if (live.on) return;
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
    case "say_end": liveEl.dataset.state = "listening"; break;
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
