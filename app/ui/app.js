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
    case "latency": if (current) current.firstMs = m.firstTokenMs; break;
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
  pill.title = state.browser ? "Chrome-Erweiterung verbunden" : "Chrome-Erweiterung nicht verbunden";
  $("#modeSwitch").setAttribute("aria-checked", String(state.mode === "computer"));
  $("#setComputer").setAttribute("aria-checked", String(state.mode === "computer"));
  $("#setLofi").setAttribute("aria-checked", String(!!state.lofi));
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
  current = { el: n, text: "", started: performance.now(), tools: new Map() };
  conv.scrollTop = conv.scrollHeight;
}
let rafPending = false;
function appendText(t) {
  if (!current) startJarvis();
  current.text += t;
  current.el.classList.remove("empty");
  if (!rafPending) {
    rafPending = true;
    setTimeout(() => { // Timer statt rAF: läuft auch, wenn das Fenster im Hintergrund ist
      rafPending = false;
      if (!current) return;
      const md = current.el.querySelector(".md");
      const before = md.children.length;
      md.innerHTML = renderMarkdown(current.text);
      // neue Blöcke sanft einblenden (Gemini: fade-in-text 400 ms)
      [...md.children].forEach((el, i) => { if (i >= Math.max(0, before - 1) && !current.faded?.has(i)) { el.classList.add("fade"); (current.faded ??= new Set()).add(i); } });
      stickToBottom();
    }, 33);
  }
  if (live.on) liveCaption(current.text, false);
}
const TOOL_LABEL = {
  desktop_scan: "Sieht sich den Bildschirm an", desktop_click: "Klickt", desktop_type: "Tippt", desktop_scroll: "Scrollt",
  desktop_read: "Liest Text", desktop_look: "Macht einen Screenshot", desktop_key: "Drückt Tasten", desktop_open_app: "Öffnet ein Programm",
  browser_tab_open: "Öffnet Tab in „Jarvis“", browser_tab_list: "Prüft Tabs", browser_tab_close: "Schließt Tab",
  browser_navigate: "Lädt Seite", browser_back: "Geht zurück", browser_wait: "Wartet auf Seite", browser_scan: "Liest Seitenelemente",
  browser_click: "Klickt auf der Seite", browser_type: "Schreibt auf der Seite", browser_scroll: "Scrollt Seite",
  browser_read: "Liest Seite", browser_look: "Screenshot vom Tab",
  webfetch: "Ruft Webseite ab", bash: "Führt Befehl aus", read: "Liest Datei", write: "Schreibt Datei", edit: "Bearbeitet Datei",
};
function toolEvent(m) {
  if (!current) startJarvis();
  current.el.classList.remove("empty");
  const key = m.name + "#" + (m.status === "pending" ? current.tools.size : [...current.tools.keys()].filter(k => k.startsWith(m.name + "#")).pop()?.split("#")[1] ?? current.tools.size);
  let row = current.tools.get(key);
  if (!row) {
    row = document.createElement("div");
    row.className = "act";
    const base = m.name.replace(/^jarvis_/, "");
    row.innerHTML = `<span class="ring"></span><span></span>`;
    row.lastElementChild.textContent = TOOL_LABEL[base] ?? base;
    current.el.querySelector(".actions-feed").append(row);
    current.tools.set(key, row);
  }
  if (m.title) row.lastElementChild.textContent = (TOOL_LABEL[m.name.replace(/^jarvis_/, "")] ?? m.name) + " · " + m.title;
  row.classList.toggle("ok", m.status === "completed");
  row.classList.toggle("err", m.status === "error");
  stickToBottom();
}
function finishTurn(note) {
  if (!current) return;
  const { el, text, started, firstMs } = current;
  el.classList.remove("busy", "empty");
  el.classList.add("done");
  el.querySelector(".md").innerHTML = renderMarkdown(text || (note ? "" : "…"));
  el.querySelectorAll(".act:not(.ok):not(.err)").forEach(r => r.classList.add(note ? "err" : "ok"));
  const secs = ((performance.now() - started) / 1000).toFixed(1);
  el.querySelector(".meta").textContent = [note, short(state.model), firstMs ? `erstes Wort ${(firstMs / 1000).toFixed(1)} s` : "", `${secs} s`]
    .filter(Boolean).join(" · ");
  current = null;
  send({ type: "history" });
}
function showError(msg) {
  if (!current) startJarvis();
  const p = document.createElement("p");
  p.className = "error-text";
  p.textContent = `Fehler: ${msg}`;
  current.el.querySelector(".md").after(p);
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
      n.querySelector(".md").innerHTML = renderMarkdown(m.text);
      turns.append(n);
    }
  }
  conv.scrollTop = conv.scrollHeight;
}

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
      else if (live.on) { liveCaption(m.text, true); addUser(m.text); startJarvis(); }
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
