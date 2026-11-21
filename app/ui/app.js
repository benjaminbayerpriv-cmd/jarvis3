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
const state = { model: "", mode: "browser", busy: false, browser: false, models: [], voiceModel: "", lofi: false };
let current = null;        // aktuelle Jarvis-Antwort {el, text, started}
let live = { on: false, muted: false };

// ---------- Verbindung ----------
let ws, retry = 0, firstState = true;
function connect() {
  ws = new WebSocket(`ws://${DAEMON}/ui`);
  ws.onopen = () => { retry = 0; firstState = true; setOffline(false); };
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
      Object.assign(state, m); renderState();
      // Nach Neuladen: Daemon denkt noch "live", diese Oberfläche aber nicht -> einmalig schließen.
      // Nur beim ersten Zustand einer Verbindung, sonst würde eine zweite offene Oberfläche Live abwürgen.
      if (firstState) { firstState = false; if (state.voice === "live" && !live.on && !dictating) send({ type: "voice", mode: "off" }); }
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
    case "history": renderHistory(m.sessions); break;
    case "messages": renderMessages(m.messages); break;
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
  turns.append(n);
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
$("#dictate").onclick = () => {
  dictating = !dictating;
  $("#dictate").classList.toggle("rec", dictating);
  send({ type: "voice", mode: dictating ? "dictate" : "off" });
};

// Vorschläge im Startzustand
const SUGGEST = [
  ["world", "Öffne YouTube und such nach Lofi-Musik"],
  ["device-desktop", "Was ist gerade auf meinem Bildschirm?"],
  ["search", "Fasse die Nachrichten von heute zusammen"],
  ["edit", "Schreib mir eine kurze E-Mail-Vorlage"],
];
$("#suggestions").innerHTML = SUGGEST.map(([i, t], k) =>
  `<button class="chip" style="animation-delay:${120 + k * 40}ms">${icon(i)}<span></span></button>`).join("");
$("#suggestions").querySelectorAll(".chip span").forEach((s, k) => s.textContent = SUGGEST[k][1]);
$("#suggestions").addEventListener("click", e => { const c = e.target.closest(".chip"); if (c) ask(c.textContent); });

// ---------- Seitenleiste / Verlauf ----------
$("#railToggle").onclick = () => { const a = $("#app"); a.dataset.rail = a.dataset.rail === "open" ? "collapsed" : "open"; };
$("#newChat").onclick = () => {
  send({ type: "new" }); turns.innerHTML = ""; current = null; setZero(true); input.focus();
};
function renderHistory(list = []) {
  const ul = $("#history");
  ul.innerHTML = "";
  for (const s of list.slice(0, 40)) {
    const li = document.createElement("li");
    li.textContent = s.title || "Unterhaltung";
    li.classList.toggle("active", !!s.active);
    li.onclick = () => send({ type: "open", id: s.id });
    ul.append(li);
  }
}
function renderMessages(msgs = []) {
  turns.innerHTML = ""; current = null;
  setZero(msgs.length === 0);
  for (const m of msgs) {
    if (m.role === "user") addUser(m.text);
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

// ---------- Sprachmodus (Live) ----------
const liveEl = $("#live");
function liveCaption(text, user) {
  const c = $("#liveCaption");
  const words = text.trim().split(/\s+/);
  c.textContent = words.slice(-40).join(" ") || "Ich höre zu …";
  c.classList.toggle("user", !!user);
}
function openLive() {
  live.on = true; live.muted = false;
  liveEl.hidden = false; liveEl.classList.remove("closing"); liveEl.dataset.state = "listening";
  $("#liveMute").classList.remove("muted");
  liveCaption("", true);
  send({ type: "voice", mode: "live" });
}
function closeLive() {
  live.on = false;
  send({ type: "voice", mode: "off" });
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

const glow = $("#liveGlow");
let level = 0;
function speechEvent(m) {
  switch (m.event) {
    case "level": {
      const target = Math.min(1, Math.max(m.mic ?? 0, m.out ?? 0) * 1.6);
      level += (target - level) * 0.35;
      glow.style.setProperty("--lvl", level.toFixed(3));
      break;
    }
    case "speech_start": liveEl.dataset.state = "listening"; break;
    case "partial":
      if (dictating) { input.value = m.text; autosize(); updateSend(); }
      else if (live.on) liveCaption(m.text, true);
      break;
    case "final":
      if (dictating) { input.value = m.text; autosize(); updateSend(); input.focus(); }
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
