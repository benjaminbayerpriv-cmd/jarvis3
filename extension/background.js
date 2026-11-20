"use strict";

const endpoint = "ws://127.0.0.1:7777/browser";
const manifest = chrome.runtime.getManifest();
const scans = new Map();
const queues = new Map();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let socket;
let retryAt = 0;
let retryDelay = 1000;

function connect() {
  if (socket || Date.now() < retryAt) return;
  const connection = new WebSocket(endpoint);
  socket = connection;

  const timeout = setTimeout(() => {
    if (connection.readyState === WebSocket.CONNECTING) connection.close();
  }, 5000);
  connection.onopen = () => {
    clearTimeout(timeout);
    retryDelay = 1000;
    connection.send(JSON.stringify({ hello: "jarvis-extension", version: manifest.version }));
  };
  connection.onclose = () => {
    clearTimeout(timeout);
    socket = undefined;
    retryAt = Date.now() + retryDelay;
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
  connection.onmessage = async ({ data }) => {
    let request;
    let answer;
    try {
      request = JSON.parse(data);
      if (!request || typeof request.cmd !== "string") throw new Error("cmd fehlt");
      const key = Number.isInteger(request.tab) ? request.tab : "tabs";
      const operation = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(() => dispatch(request));
      queues.set(key, operation);
      try {
        answer = { ok: true, ...await operation };
      } finally {
        if (queues.get(key) === operation) queues.delete(key);
      }
    } catch (error) {
      answer = { ok: false, error: error.message };
    }
    if (request && Object.hasOwn(request, "rid")) answer.rid = request.rid;
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(answer));
  };
}

connect();
// An extension API call resets the MV3 idle timer without adding protocol messages.
let lastActivity = Date.now();
setInterval(() => {
  connect();
  if (Date.now() - lastActivity >= 15000) {
    lastActivity = Date.now();
    void chrome.storage.session.getBytesInUse().catch(console.error);
  }
}, 1000);

async function updateBadge(enabled) {
  await chrome.action.setBadgeBackgroundColor({ color: enabled ? "#136c5a" : "#515864" });
  await chrome.action.setBadgeText({ text: enabled ? "AN" : "AUS" });
  await chrome.action.setTitle({
    title: enabled ? "Jarvis-Markierungen ausschalten" : "Jarvis-Markierungen einschalten",
  });
}

void chrome.storage.local.get({ enabled: false }).then(({ enabled }) => updateBadge(enabled === true));

let togglePending = Promise.resolve();
chrome.action.onClicked.addListener(() => {
  togglePending = togglePending.catch(console.error).then(async () => {
    const { enabled } = await chrome.storage.local.get({ enabled: false });
    await chrome.storage.local.set({ enabled: !enabled });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.enabled) void updateBadge(changes.enabled.newValue === true);
});

const tabKey = tab => "jarvis-tab-" + tab;
const groupKey = group => "jarvis-group-" + group;

chrome.tabs.onRemoved.addListener(tab => {
  scans.delete(tab);
  void chrome.storage.session.remove(tabKey(tab));
});
chrome.tabGroups.onRemoved.addListener(({ id }) => {
  void chrome.storage.session.remove(groupKey(id));
});
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId === 0) scans.delete(tabId);
});

function urlFor(value) {
  if (typeof value !== "string") throw new Error("url fehlt");
  const url = new URL(value);
  if (!["http:", "https:", "file:"].includes(url.protocol)) throw new Error("URL-Schema nicht unterstützt");
  return url.href;
}

function groupTitle(value = "Jarvis") {
  if (typeof value !== "string" || !value.trim()) throw new Error("group muss ein Gruppenname sein");
  return value.trim();
}

async function openTab(request) {
  const url = urlFor(request.url);
  const title = groupTitle(request.group);
  const window = await chrome.windows.getLastFocused({ windowTypes: ["normal"] });
  const groups = await chrome.tabGroups.query({ windowId: window.id, title, color: "blue" });
  const groupKeys = groups.map(group => groupKey(group.id));
  const owned = await chrome.storage.session.get(groupKeys);
  const group = groups.find(group => owned[groupKey(group.id)] === true);
  const { id: tab } = await chrome.tabs.create({ windowId: window.id, active: false, url: "about:blank" });
  try {
    const groupId = await chrome.tabs.group(group ? { tabIds: tab, groupId: group.id } : { tabIds: tab });
    if (!group) await chrome.tabGroups.update(groupId, { title, color: "blue" });
    await chrome.storage.session.set({ [tabKey(tab)]: true, [groupKey(groupId)]: true });
    await chrome.tabs.update(tab, { url });
    return { tab };
  } catch (error) {
    // The user may have selected the tab since it was created.
    const current = await chrome.tabs.get(tab).catch(() => null);
    if (current && !current.active) await chrome.tabs.remove(tab);
    throw error;
  }
}

async function listTabs() {
  const [tabs, groups] = await Promise.all([chrome.tabs.query({}), chrome.tabGroups.query({})]);
  const names = new Map(groups.map(group => [group.id, group.title ?? ""]));
  return { tabs: tabs.map(({ id, url, pendingUrl, title, groupId, active }) => ({
    tab: id, url: url || pendingUrl || "", title: title || "", group: names.get(groupId) ?? null, active,
  })) };
}

async function requireManaged(tabId, background = false) {
  if (!Number.isInteger(tabId)) throw new Error("tab fehlt");
  const key = tabKey(tabId);
  const [tab, owned] = await Promise.all([chrome.tabs.get(tabId), chrome.storage.session.get(key)]);
  if (!owned[key] || tab.groupId < 0) throw new Error("Tab gehört nicht zu Jarvis");
  const group = groupKey(tab.groupId);
  const groups = await chrome.storage.session.get(group);
  if (!groups[group]) throw new Error("Tab gehört nicht zu einer Jarvis-Tab-Gruppe");
  if (background && (await chrome.tabs.get(tabId)).active) throw new Error("Jarvis-Tab ist gerade aktiv");
  return tab;
}

async function page(tab, request, frame = { frameId: 0 }) {
  let response;
  try {
    const options = frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId };
    response = await chrome.tabs.sendMessage(tab, request, options);
  } catch {
    throw new Error("Seite nicht erreichbar. Bei neuen Tabs zuerst wait verwenden.");
  }
  if (!response?.ok) throw new Error(response?.error ?? "Keine Antwort von der Seite");
  return response;
}

async function frames(tab, request, { requireTop = true } = {}) {
  const entries = await chrome.webNavigation.getAllFrames({ tabId: tab }) ?? [];
  const root = entries.find(frame => frame.frameId === 0);
  if (!root && requireTop) throw new Error("Seite ist noch nicht geladen");
  const results = await Promise.all(entries.map(async frame => {
    const result = await page(tab, request, frame).catch(error => {
      if (requireTop && frame === root) throw error;
      return null;
    });
    return result && !result.skipped ? { frame, result } : null;
  }));
  return results.filter(Boolean);
}

let nextId = Math.floor(Date.now() * 1024);

async function scan(tab, request) {
  const start = performance.now();
  scans.delete(tab);
  const entries = await frames(tab, { cmd: "scan", all: request.all });
  const targets = [];
  const locations = new Map();
  for (const { frame, result } of entries) {
    for (const { localId, ...target } of result.targets) {
      const id = nextId++;
      locations.set(id, { frame, localId, target: { id, ...target } });
      targets.push(locations.get(id).target);
    }
  }
  targets.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  scans.set(tab, locations);
  const reply = { targets, ms: Math.round(performance.now() - start) };
  if (request.text) {
    reply.text = targets.map(({ id, axRole, label, rect: [x, y, width, height], enabled }) =>
      `${id} ${axRole.slice(2)} „${label}“ @${Math.round(x + width / 2)},${Math.round(y + height / 2)}${enabled ? "" : " (aus)"}`).join("\n");
  }
  return reply;
}

function checkRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) {
    throw new Error("rect muss [x,y,Breite,Höhe] mit positiver Größe sein");
  }
}

async function targetCommand(tab, request) {
  const { cmd, id, rect, text, dy } = request;
  if (cmd === "type" && typeof text !== "string") throw new Error("text fehlt");
  if (cmd === "scroll" && !Number.isFinite(dy)) throw new Error("dy fehlt oder ist ungültig");
  if (cmd === "read") {
    if ((id === undefined) === (rect === undefined)) throw new Error("read erwartet entweder id oder rect");
    if (rect !== undefined) {
      checkRect(rect);
      const results = await frames(tab, { cmd, rect });
      return { text: results.map(({ result }) => result.text).filter(Boolean).join("\n"), via: "dom" };
    }
  }
  if (cmd === "scroll" && id === undefined) {
    await page(tab, { cmd, dy });
    return {};
  }
  const location = scans.get(tab)?.get(id);
  if (!location) throw new Error("Unbekannte oder abgelaufene ID. Erst scan ausführen.");
  const result = await page(tab, { cmd, id: location.localId, text, dy }, location.frame);
  if (cmd === "read") return { text: result.text, via: "dom" };
  if (cmd === "click" || cmd === "type") return { via: result.via };
  return {};
}

async function wait(tab, request) {
  const { ms = request.for === undefined ? 1000 : 10000, for: text } = request;
  if (!Number.isFinite(ms) || ms < 0 || ms > 120000) throw new Error("ms muss zwischen 0 und 120000 liegen");
  if (text === undefined) {
    await sleep(ms);
    return {};
  }
  if (typeof text !== "string" || !text) throw new Error("for muss ein nichtleerer Text sein");
  const deadline = Date.now() + ms;
  do {
    const results = await frames(tab, { cmd: "wait", for: text }, { requireTop: false });
    if (results.some(({ result }) => result.found)) return {};
    if (Date.now() >= deadline) break;
    await sleep(Math.min(150, deadline - Date.now()));
  } while (true);
  throw new Error("Zeitüberschreitung beim Warten auf Text");
}

async function navigate(tab, url) {
  const initial = await chrome.tabs.get(tab);
  const history = [];
  const onUpdate = (id, change, state) => {
    if (id === tab && (change.status || change.url)) history.push({ change, state });
  };
  chrome.tabs.onUpdated.addListener(onUpdate);
  try {
    await chrome.tabs.update(tab, { url });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab);
      const completed = history.some(({ change }) => change.status === "complete");
      const moved = current.url !== initial.url && !current.pendingUrl;
      if (current.status === "complete" && (completed || moved)) return {};
      await sleep(100);
    }
    throw new Error("Zeitüberschreitung beim Laden des Tabs");
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdate);
  }
}

function bounds(requested, [, , vw, vh]) {
  if (requested === undefined) return [0, 0, vw, vh];
  checkRect(requested);
  const [x, y, width, height] = requested;
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(vw, x + width);
  const bottom = Math.min(vh, y + height);
  if (left >= right || top >= bottom) throw new Error("rect liegt außerhalb des Viewports");
  return [left, top, right - left, bottom - top];
}

async function renderShot(data, viewport, rect, targets, passwords) {
  const image = await createImageBitmap(await (await fetch("data:image/png;base64," + data)).blob());
  try {
    const scaleX = image.width / viewport[2];
    const scaleY = image.height / viewport[3];
    const [x, y, w, h] = rect;
    const canvas = new OffscreenCanvas(Math.ceil(w * scaleX), Math.ceil(h * scaleY));
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, x * scaleX, y * scaleY, w * scaleX, h * scaleY, 0, 0, canvas.width, canvas.height);
    ctx.setTransform(scaleX, 0, 0, scaleY, -x * scaleX, -y * scaleY);
    ctx.fillStyle = "#18202b";
    for (const [left, top, width, height] of passwords) ctx.fillRect(left, top, width, height);
    ctx.font = "bold 12px sans-serif";
    ctx.textBaseline = "middle";
    for (const { id, rect: [left, top, width, height] } of targets) {
      if (left >= x + w || left + width <= x || top >= y + h || top + height <= y) continue;
      ctx.strokeStyle = "#5cf0cb";
      ctx.lineWidth = 2;
      ctx.strokeRect(left, top, width, height);
      const label = String(id);
      const labelX = Math.max(x, left);
      const labelY = Math.max(y, top);
      ctx.fillStyle = "#18202b";
      ctx.fillRect(labelX, labelY, ctx.measureText(label).width + 8, 17);
      ctx.fillStyle = "#5cf0cb";
      ctx.fillText(label, labelX + 4, labelY + 8.5);
    }
    const buffer = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < buffer.length; offset += 16384) {
      binary += String.fromCharCode(...buffer.subarray(offset, offset + 16384));
    }
    return "data:image/png;base64," + btoa(binary);
  } finally {
    image.close();
  }
}

async function shot(tab, request) {
  const viewports = await frames(tab, { cmd: "viewport" });
  const { rect: viewport } = viewports.find(({ frame }) => frame.frameId === 0).result;
  const rect = bounds(request.rect, viewport);
  const passwords = viewports.flatMap(({ result }) => result.passwords);
  const targets = request.marks ? Array.from(scans.get(tab)?.values() ?? [], ({ target }) => target) : [];
  const debuggee = { tabId: tab };
  try {
    await frames(tab, { cmd: "overlay", hide: true });
    await chrome.debugger.attach(debuggee, "1.3");
    let data;
    try {
      ({ data } = await chrome.debugger.sendCommand(debuggee, "Page.captureScreenshot", {
        format: "png", fromSurface: true,
      }));
    } finally {
      await chrome.debugger.detach(debuggee).catch(() => {});
    }
    return { rect, dataUrl: await renderShot(data, viewport, rect, targets, passwords) };
  } finally {
    await frames(tab, { cmd: "overlay", hide: false }, { requireTop: false }).catch(() => {});
  }
}

async function dispatch(request) {
  const { cmd, tab } = request;
  if (cmd === "tab_open") return openTab(request);
  if (cmd === "tab_list") return listTabs();
  if (!["tab_close", "navigate", "back", "wait", "scan", "shot", "click", "type", "focus", "scroll", "read"].includes(cmd)) {
    throw new Error("Unbekannter Befehl");
  }

  await requireManaged(tab, ["tab_close", "navigate", "back", "click", "type", "focus", "scroll", "shot"].includes(cmd));
  switch (cmd) {
    case "tab_close": await chrome.tabs.remove(tab); return {};
    case "navigate": return navigate(tab, urlFor(request.url));
    case "back": await chrome.tabs.goBack(tab); return {};
    case "wait": return wait(tab, request);
    case "scan": return scan(tab, request);
    case "shot": return shot(tab, request);
    default: return targetCommand(tab, request);
  }
}
