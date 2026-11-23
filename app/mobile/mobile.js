import { renderMarkdown } from "/markdown.js";

const byId = id => document.getElementById(id);
const show = id => { for (const page of ["welcome", "pair", "app"]) byId(page).hidden = page !== id; };
let socket, chat, history = [], waiting = false, wantsChat = false, editing, streaming, reconnect, connectionGeneration = 0;
const send = message => {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
};
const notice = text => byId("notice").textContent = text;
const report = (error) => void fetch("/errors", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ platform: "web", message: String(error) }) }).catch(() => {});
function busy(value) {
  byId("stop").hidden = !value;
  byId("send").disabled = value;
}
function button(label, run) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.onclick = run;
  return element;
}
function renderHistory() {
  const rows = history.filter(item => !item.archived).map(item => {
    const row = document.createElement("li");
    row.append(button([item.folder, item.title].filter(Boolean).join(" · "), () => {
      chat = item.id;
      waiting = false;
      byId("chatPicker").close();
      send({ type: "open", id: chat });
    }));
    return row;
  });
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.textContent = "Noch keine Chats.";
    rows.push(empty);
  }
  byId("chatList").replaceChildren(...rows);
}
function addVisual(event, container) {
  for (const file of event.files ?? []) {
    if (!/^[\w.-]+\.(png|jpe?g|svg|webp)$/i.test(file) || !/^v[a-z0-9]{6,20}$/.test(event.id ?? "")) continue;
    const image = document.createElement("img");
    image.src = `/visual/${event.id}/${encodeURIComponent(file)}`;
    image.alt = event.title || "Visualisierung";
    image.loading = "lazy";
    container.append(image);
  }
}
function sendAgain(message) {
  if (send({ type: "resend", id: chat, messageID: message.id })) busy(true);
}
function addMessage(message) {
  const row = document.createElement("li");
  row.className = `message ${message.role === "user" ? "user" : ""}`;
  const body = document.createElement("div");
  if (message.role === "assistant") body.innerHTML = renderMarkdown(message.text ?? "");
  else body.textContent = message.text ?? "";
  row.append(body);
  for (const visual of message.visuals ?? []) addVisual(visual, row);
  if (message.role === "user" && chat && message.id) {
    row.append(button("Bearbeiten", () => {
      editing = message.id;
      byId("message").value = message.text ?? "";
      byId("message").focus();
      byId("cancelEdit").hidden = false;
    }), button("Erneut senden", () => sendAgain(message)));
  }
  byId("messages").append(row);
  return body;
}
function addTool(message) {
  if (!["running", "completed", "error"].includes(message.status)) return;
  let row = [...byId("messages").children].find(item => item.dataset.tool === message.id);
  if (!row) {
    row = document.createElement("li");
    row.dataset.tool = message.id;
    row.append(document.createElement("details"));
    row.firstElementChild.append(document.createElement("summary"), document.createElement("p"));
    byId("messages").append(row);
  }
  row.querySelector("summary").textContent = message.title || message.name || "Werkzeug";
  row.querySelector("p").textContent = message.error || message.status;
}
function receive(message) {
  if (message.type === "session" && (waiting || message.replaces === chat)) { chat = message.id; waiting = false; }
  if (message.session && message.session !== chat) return;
  switch (message.type) {
    case "history": history = message.sessions ?? []; renderHistory(); break;
    case "messages":
      if (message.session !== chat) break;
      byId("messages").replaceChildren();
      for (const item of message.messages ?? []) addMessage(item);
      streaming = undefined;
      busy(!!message.running);
      break;
    case "delta":
      streaming ??= { text: "", body: addMessage({ role: "assistant", text: "" }) };
      streaming.text += message.text;
      streaming.body.innerHTML = renderMarkdown(streaming.text);
      break;
    case "tool": addTool(message); break;
    case "done":
      streaming = undefined;
      busy(false);
      if (chat) send({ type: "open", id: chat });
      break;
    case "stopped": case "error":
      streaming = undefined;
      waiting = false;
      busy(false);
      if (message.message) notice(message.message);
      break;
    case "notice": notice(message.text); break;
    case "state": {
      const model = byId("model");
      const values = message.models ?? [];
      model.replaceChildren(...values.map(item => new Option(item.model, item.id)));
      model.value = message.model;
      byId("computer").checked = message.mode === "computer";
      byId("autoTitles").checked = message.autoChatTitles;
      byId("liveView").checked = message.liveView;
      busy(waiting || (message.busySessions ?? []).includes(chat));
      break;
    }
    case "tabs":
      byId("tabs").replaceChildren(new Option("Automatisch", ""), ...(message.tabs ?? []).map(item => new Option(item.title, item.tab)),
        ...(message.windows ?? []).map(item => new Option(item.title || item.app, `win:${item.id}`)));
      byId("tabs").value = message.pinned ?? "";
      break;
    case "frame":
      if (typeof message.data !== "string") break;
      byId("frame").src = message.data.startsWith("data:image/") ? message.data : `data:image/jpeg;base64,${message.data}`;
      byId("frame").hidden = false;
      byId("frameStatus").hidden = true;
      break;
    case "viewer_idle":
      byId("frame").hidden = true;
      byId("frameStatus").hidden = false;
      break;
    case "visual": {
      const row = document.createElement("li");
      addVisual(message, row);
      if (row.firstChild) byId("messages").append(row);
      break;
    }
  }
}
async function connect() {
  if (!wantsChat) return;
  const generation = ++connectionGeneration;
  try {
    const response = await fetch("/mobile/session", { cache: "no-store" });
    if (generation !== connectionGeneration) return;
    if (response.status === 401) { show("pair"); return; }
    if (!response.ok) throw new Error("Computer nicht erreichbar.");
    show("app");
    socket = new WebSocket(`wss://${location.host}/ui`);
    socket.onopen = () => {
      byId("connection").textContent = "Verbunden";
      if (chat) send({ type: "open", id: chat });
    };
    socket.onmessage = ({ data }) => {
      try { receive(JSON.parse(data)); } catch (error) { report(error); }
    };
    socket.onclose = () => {
      pendingReconnect();
    };
  } catch { pendingReconnect(); }
}
function pendingReconnect() {
  byId("connection").textContent = "Computer nicht erreichbar · verbinde erneut …";
  clearTimeout(reconnect);
  reconnect = setTimeout(connect, 1800);
}
byId("continue").onclick = () => { wantsChat = true; show("app"); void connect(); };
byId("pairForm").onsubmit = async event => {
  event.preventDefault();
  const status = byId("pairStatus");
  try {
    const response = await fetch("/pair/complete", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin: byId("pin").value, name: "Handy-Browser", browser: true }) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    byId("pin").value = "";
    status.textContent = "";
    void connect();
  } catch (error) { status.textContent = error.message; }
};
byId("composer").onsubmit = event => {
  event.preventDefault();
  const text = byId("message").value.trim();
  if (!text) return;
  const replacing = editing;
  if (!send(replacing ? { type: "replace", id: chat, messageID: replacing, text } :
    { type: "chat", session: chat ?? null, text, model: byId("model").value || undefined })) { notice("Jarvis ist gerade nicht erreichbar."); return; }
  waiting = !chat;
  if (!replacing) addMessage({ role: "user", text });
  byId("message").value = "";
  byId("cancelEdit").click();
  busy(true);
};
byId("cancelEdit").onclick = () => {
  if (editing) byId("message").value = "";
  editing = undefined;
  byId("cancelEdit").hidden = true;
};
byId("history").onclick = () => { send({ type: "history" }); byId("chatPicker").showModal(); };
byId("newChat").onclick = () => { chat = null; waiting = false; streaming = undefined; byId("messages").replaceChildren(); busy(false); };
byId("stop").onclick = () => { if (chat) send({ type: "stop", session: chat }); };
byId("emergency").onclick = async () => {
  try { if (!(await fetch("/stop", { method: "POST" })).ok) throw new Error(); notice("Jarvis gestoppt."); }
  catch { notice("Not-Aus konnte nicht gesendet werden."); }
};
byId("tabs").onchange = () => {
  const value = byId("tabs").value;
  send(value.startsWith("win:") ? { type: "viewer_window", window: Number(value.slice(4)) } :
    { type: "viewer_tab", tab: value ? Number(value) : null });
};
for (const [id, key, read] of [
  ["model", "model", element => element.value],
  ["computer", "mode", element => element.checked ? "computer" : "browser"],
  ["autoTitles", "autoChatTitles", element => element.checked],
  ["liveView", "liveView", element => element.checked],
]) byId(id).onchange = event => send({ type: "settings", settings: { [key]: read(event.target) } });
for (const tab of document.querySelectorAll("[data-page]")) tab.onclick = () => {
  for (const item of document.querySelectorAll("[data-page]")) {
    byId(item.dataset.page).hidden = item !== tab;
    if (item === tab) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  }
  if (tab.dataset.page === "preview") send({ type: "tabs" });
};
fetch("/mobile/downloads").then(response => response.json()).then(({ android }) => {
  byId("download").hidden = !android;
  if (!android) byId("downloadStatus").textContent = "Auf diesem Computer ist noch kein Android-Installationspaket hinterlegt.";
}).catch(() => { byId("downloadStatus").textContent = "Der App-Download ist gerade nicht erreichbar."; });
