"use strict";

const endpoint = "ws://127.0.0.1:7777/browser";
const manifest = chrome.runtime.getManifest();
const scans = new Map();
const changedPage = "Seite hat gewechselt, bitte neu scannen";
const textLimit = 8000;
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
function invalidateScan(tab) {
  const scan = scans.get(tab);
  if (scan) scan.stale = true;
}

chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  if (frameId === 0) invalidateScan(tabId);
});

const pageChanges = [
  chrome.webNavigation.onCommitted,
  chrome.webNavigation.onHistoryStateUpdated,
  chrome.webNavigation.onReferenceFragmentUpdated,
];
for (const event of pageChanges) {
  event.addListener(({ tabId, frameId, documentId, url }) => {
    const frame = scans.get(tabId)?.documents.get(frameId);
    if (frame && (frame.documentId !== documentId || frame.url !== url
      || event === chrome.webNavigation.onCommitted)) invalidateScan(tabId);
  });
}

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
    await navigate(tab, url);
    return { tab };
  } catch (error) {
    // The user may have selected the tab since it was created.
    const current = await chrome.tabs.get(tab).catch(() => null);
    if (current && !current.active) await chrome.tabs.remove(tab);
    throw error;
  }
}

// Vorhandenen Tab des Nutzers in die Jarvis-Gruppe seines eigenen Fensters holen (nur auf ausdrückliche Bitte).
async function adoptTab(request) {
  const tabId = request.tab;
  if (!Number.isInteger(tabId)) throw new Error("tab fehlt");
  const tab = await chrome.tabs.get(tabId).catch(() => { throw new Error("Tab nicht gefunden"); });
  const url = tab.url || tab.pendingUrl || "";
  if (!/^(https?|file):/.test(url)) throw new Error("Dieser Tab (z. B. chrome://, Erweiterungsseite, Neuer Tab) kann nicht übernommen werden");
  const key = tabKey(tabId);
  if ((await chrome.storage.session.get(key))[key] && tab.groupId >= 0) return { tab: tabId, url, active: tab.active, already: true };
  // Tabs, die vor dem Laden/Neuladen der Erweiterung geöffnet wurden, haben noch kein Content-Script.
  const alive = await chrome.tabs.sendMessage(tabId, { cmd: "ready" }).catch(() => null);
  if (!alive) {
    await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] })
      .catch(() => { throw new Error("Dieser Tab erlaubt keine Steuerung (z. B. Chrome Web Store oder geschützte Seite)"); });
  }
  const title = groupTitle(request.group);
  // Nur Gruppen im selben Fenster: der Tab soll das Fenster des Nutzers nicht wechseln.
  const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title, color: "blue" });
  const owned = await chrome.storage.session.get(groups.map(group => groupKey(group.id)));
  const group = groups.find(group => owned[groupKey(group.id)] === true);
  const groupId = await chrome.tabs.group(group ? { tabIds: tabId, groupId: group.id } : { tabIds: tabId });
  if (!group) await chrome.tabGroups.update(groupId, { title, color: "blue" });
  await chrome.storage.session.set({ [key]: "adopted", [groupKey(groupId)]: true });
  return { tab: tabId, url, active: tab.active };
}

// Übernommenen Tab wieder freigeben: aus der Gruppe nehmen, nicht mehr steuerbar.
async function releaseTab(request) {
  await requireManaged(request.tab);
  await chrome.tabs.ungroup(request.tab);
  await chrome.storage.session.remove(tabKey(request.tab));
  scans.delete(request.tab);
  return {};
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
  // Eigene Jarvis-Tabs dürfen bedient werden, auch wenn der Nutzer gerade zusieht. Übernommene Tabs des Nutzers
  // bleiben gesperrt, solange sie der aktive Tab sind (dort arbeitet der Nutzer selbst).
  if (background && owned[key] === "adopted" && (await chrome.tabs.get(tabId)).active) {
    throw new Error("Dieser übernommene Tab ist gerade der aktive Tab des Nutzers. Bitte den Nutzer, kurz einen anderen Tab zu öffnen.");
  }
  return tab;
}

async function page(tab, request, frame = { frameId: 0 }) {
  let response;
  try {
    const options = frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId };
    response = await chrome.tabs.sendMessage(tab, request, options);
  } catch {
    throw new Error("Seite nicht erreichbar");
  }
  if (!response?.ok) throw new Error(response?.error ?? "Keine Antwort von der Seite");
  return response;
}

async function frames(tab, request, { requireTop = true } = {}) {
  const entries = await chrome.webNavigation.getAllFrames({ tabId: tab }) ?? [];
  const root = entries.find(frame => frame.frameId === 0);
  if (!root && requireTop) throw new Error("Seite ist noch nicht geladen");
  const results = await Promise.all(entries.map(async frame => {
    const command = typeof request === "function" ? request(frame) : request;
    const result = await page(tab, command, frame).catch(error => {
      if (requireTop && frame === root) throw error;
      return null;
    });
    return result && !result.skipped ? { frame, result } : null;
  }));
  return results.filter(Boolean);
}

let nextId = 1;

async function scan(tab, request) {
  const start = performance.now();
  scans.delete(tab);
  const entries = await frames(tab, { cmd: "scan", all: request.all });
  const candidates = entries.flatMap(({ frame, result }) => result.targets.map(target => ({ frame, ...target })));
  candidates.sort((a, b) => a.priority - b.priority || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  const total = candidates.length;
  const locations = new Map();
  const documents = new Map(entries.map(({ frame }) => [frame.frameId, frame]));
  const targets = candidates.slice(0, 150).map(({ frame, localId, priority, ...target }) => {
    const id = nextId++;
    locations.set(id, { frame, localId });
    return { id, ...target };
  });
  scans.set(tab, { documents, locations, stale: false });
  await checkScanFrame(tab, documents.get(0));
  const reply = { targets, total, ms: Math.round(performance.now() - start) };
  if (request.text) {
    reply.text = [`${targets.length} von ${total} Elementen`, ...targets.map(({ id, axRole, label, rect: [x, y, width, height], enabled }) =>
      `${id} ${axRole.slice(2)} „${label}“ @${Math.round(x + width / 2)},${Math.round(y + height / 2)}${enabled ? "" : " (aus)"}`)].join("\n");
  }
  return reply;
}

function checkRect(rect) {
  if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0) {
    throw new Error("rect muss [x,y,Breite,Höhe] mit positiver Größe sein");
  }
}

async function targetCommand(tab, request) {
  const { cmd, id, rect, text, dy, submit } = request;
  if (cmd === "type" && typeof text !== "string") throw new Error("text fehlt");
  if (cmd === "type" && submit !== undefined && typeof submit !== "boolean") throw new Error("submit muss ein Boolean sein");
  if (cmd === "scroll" && !Number.isFinite(dy)) throw new Error("dy fehlt oder ist ungültig");
  if (cmd === "read") {
    if (id !== undefined && rect !== undefined) throw new Error("read erwartet höchstens id oder rect");
    if (id === undefined) {
      if (rect !== undefined) checkRect(rect);
      const results = await frames(tab, { cmd, rect, limit: rect === undefined ? textLimit : undefined });
      const text = results.map(({ result }) => result.text).filter(Boolean).join("\n");
      return { text: rect === undefined ? text.slice(0, textLimit) : text, via: "dom" };
    }
  }
  if (cmd === "scroll" && id === undefined) {
    await page(tab, { cmd, dy });
    return {};
  }
  const scan = scans.get(tab);
  if (scan?.stale) throw new Error(changedPage);
  const location = scan?.locations.get(id);
  if (!location) throw new Error("Unbekannte oder abgelaufene ID. Erst scan ausführen.");
  await checkScanFrame(tab, scan.documents.get(0));
  if (location.frame.frameId !== 0) await checkScanFrame(tab, location.frame);
  const send = request => page(tab, { id: location.localId, ...request }, location.frame);
  // Jarvis-Cursor zum Ziel bewegen; bei laufender Live-Ansicht kurz warten, damit man ihn ankommen sieht.
  const moveCursor = async () => {
    const { rect } = await send({ cmd: "rect" }).catch(() => ({}));
    if (!rect) return;
    await page(tab, { cmd: "agentCursor", x: rect[0] + rect[2] / 2, y: rect[1] + rect[3] / 2 }).catch(() => {});
    if (streams.has(tab)) await sleep(450);
  };
  if (cmd === "type") {
    await moveCursor();
    if (submit) {
      return observeNavigation(tab, navigating => typeAndSubmit(tab, send, text, navigating), false, location.frame.frameId);
    }
    await typeInTab(tab, send, text, false);
    return { via: "cdp" };
  }
  if (cmd === "click") {
    await moveCursor();
    return observeNavigation(tab, async () => {
      const deadline = Date.now() + 6000;
      do {
        await requireManaged(tab, true);
        await checkScanFrame(tab, location.frame);
        const result = await send({ cmd });
        if (!result.activationPending) {
          if (result.invalidates) invalidateScan(tab);
          return { via: result.via };
        }
        await sleep(150);
      } while (Date.now() < deadline);
      throw new Error("Klick wartet auf das Ende der Chrome-Benutzeraktivierung");
    }, false);
  }
  const result = await send({ cmd, dy }).catch(async error => {
    await checkScanFrame(tab, location.frame);
    throw error;
  });
  if (cmd === "read") return { text: result.text, via: "dom" };
  return {};
}

async function checkScanFrame(tab, frame) {
  const current = await chrome.webNavigation.getFrame({ tabId: tab, frameId: frame.frameId }).catch(() => null);
  if (current?.documentId !== frame.documentId || current?.url !== frame.url) invalidateScan(tab);
  if (scans.get(tab)?.stale) throw new Error(changedPage);
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
  invalidateScan(tab);
  return observeNavigation(tab, async () => {
    await chrome.tabs.update(tab, { url });
    return {};
  });
}

async function observeNavigation(tab, action, required = true, targetFrame = 0) {
  const initial = await chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 });
  const deadline = Date.now() + 25000;
  const isObserved = event => event.tabId === tab && (event.frameId === 0 || event.frameId === targetFrame);
  let frameId = targetFrame;
  let started = false;
  let changed = false;
  let failure;
  const onStart = event => {
    if (!isObserved(event)) return;
    frameId = event.frameId;
    started = true;
    changed = false;
    failure = undefined;
  };
  const onChange = event => {
    if (!isObserved(event)) return;
    frameId = event.frameId;
    changed = true;
  };
  const onError = event => {
    if (isObserved(event) && event.error !== "net::ERR_ABORTED") failure = event.error;
  };
  chrome.webNavigation.onBeforeNavigate.addListener(onStart);
  for (const event of pageChanges) event.addListener(onChange);
  chrome.webNavigation.onErrorOccurred.addListener(onError);
  try {
    const result = await action(() => started || changed);
    const grace = Date.now() + 400;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab);
      if (failure) throw new Error("Navigation fehlgeschlagen: " + failure);
      const moved = changed || current.url !== initial?.url;
      const loading = current.status === "loading" || current.pendingUrl;
      if (!required && !started && !moved && !loading && Date.now() >= grace) return result;
      if (moved && !loading) {
        const frame = await chrome.webNavigation.getFrame({ tabId: tab, frameId });
        const ready = frame && await page(tab, { cmd: "ready" }, frame).catch(() => null);
        if (ready?.loaded && (frameId !== 0 || current.url === frame.url) && !failure && changed) return result;
      }
      await sleep(100);
    }
    throw new Error("Zeitüberschreitung beim Laden des Tabs");
  } finally {
    chrome.webNavigation.onBeforeNavigate.removeListener(onStart);
    for (const event of pageChanges) event.removeListener(onChange);
    chrome.webNavigation.onErrorOccurred.removeListener(onError);
  }
}

// Live-Ansicht: Tabs, deren Bild gerade an Jarvis gestreamt wird (Debugger bleibt angehängt).
const streams = new Map();

async function withDebugger(tab, operation) {
  const debuggee = { tabId: tab };
  if (streams.has(tab)) return operation((method, params) => chrome.debugger.sendCommand(debuggee, method, params));
  await chrome.debugger.attach(debuggee, "1.3");
  try {
    return await operation((method, params) => chrome.debugger.sendCommand(debuggee, method, params));
  } finally {
    await chrome.debugger.detach(debuggee).catch(() => {});
  }
}

function sendFrame(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

async function streamStart(tab) {
  if (streams.has(tab)) return { already: true };
  const target = { tabId: tab };
  await chrome.debugger.attach(target, "1.3");
  const state = { target, stopped: false };
  streams.set(tab, state);
  void streamLoop(tab, state);
  return {};
}

async function streamStop(tab, reason = "gestoppt") {
  const state = streams.get(tab);
  if (!state) return;
  state.stopped = true;
  streams.delete(tab);
  await chrome.debugger.detach(state.target).catch(() => {});
  sendFrame({ type: "stream_ended", tab, reason });
}

// Bild ohne clip/scale aufnehmen: Ein Ausschnitt mit Skalierungsfaktor lässt Chrome die Seite kurz umrechnen,
// das flackert im echten Fenster. Verkleinert wird stattdessen hier in der Erweiterung.
async function downscale(base64, maxWidth) {
  const blob = await (await fetch("data:image/jpeg;base64," + base64)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 })).arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { data: btoa(binary), w: width, h: height };
}

async function streamLoop(tab, state) {
  while (!state.stopped && streams.get(tab) === state) {
    const started = Date.now();
    try {
      const { data } = await chrome.debugger.sendCommand(state.target, "Page.captureScreenshot", {
        format: "jpeg", quality: 70, fromSurface: true, optimizeForSpeed: true,
      });
      const frame = await downscale(data, 1280);
      const current = await chrome.tabs.get(tab);
      if (!state.stopped) sendFrame({ type: "frame", tab, ...frame, url: current.url ?? "", title: current.title ?? "" });
    } catch {
      if (!(await chrome.tabs.get(tab).catch(() => null))) { await streamStop(tab, "Tab geschlossen"); return; }
    }
    await sleep(Math.max(0, 250 - (Date.now() - started)));
  }
}

chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
  const state = streams.get(tabId);
  if (!state || state.stopped) return;
  state.stopped = true;
  streams.delete(tabId);
  sendFrame({ type: "stream_ended", tab: tabId, reason: reason === "canceled_by_user" ? "Vom Nutzer beendet" : reason });
});

async function typeInTab(tab, pageCommand, text, submit) {
  await withDebugger(tab, async send => {
    const key = async (key, windowsVirtualKeyCode, text) => {
      const params = { key, code: key, windowsVirtualKeyCode };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...params, text });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
    };
    await requireManaged(tab, true);
    await pageCommand({ cmd: "prepareType" });
    if (text) await send("Input.insertText", { text });
    else await key("Backspace", 8);
    if (submit) {
      await requireManaged(tab, true);
      await pageCommand({ cmd: "prepareSubmit" });
      try {
        await key("Enter", 13, "\r");
      } finally {
        // A navigating document can be frozen in the back-forward cache.
        void pageCommand({ cmd: "finishEnter" }).catch(() => {});
      }
    }
  });
}

async function typeAndSubmit(tab, pageCommand, text, navigating) {
  const changed = async () => {
    const deadline = Date.now() + 1500;
    do {
      if (navigating()) return true;
      const state = await pageCommand({ cmd: "submitProgress" }).catch(() => null);
      if (state?.changed || navigating()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(150, deadline - Date.now()));
    } while (true);
  };
  const success = via => {
    invalidateScan(tab);
    return { via };
  };
  try {
    await typeInTab(tab, pageCommand, text, true);
    if (await changed()) return success("cdp");
    await requireManaged(tab, true);
    if (navigating()) return success("cdp");
    const fallback = await pageCommand({ cmd: "submitForm" }).catch(error => {
      if (!navigating()) throw error;
    });
    if (fallback?.changed || (!fallback?.attempted && navigating())) return success("cdp");
    if (!fallback?.attempted) return { via: "cdp", submitted: false };
    if (await changed()) return success("cdp+form");
    return { via: "cdp+form", submitted: false };
  } finally {
    void pageCommand({ cmd: "finishType" }).catch(() => {});
  }
}

async function back(tab) {
  return observeNavigation(tab, () => withDebugger(tab, async send => {
    const { currentIndex, entries } = await send("Page.getNavigationHistory");
    const previous = entries[currentIndex - 1];
    if (!previous) throw new Error("Kein vorheriger Verlaufseintrag");
    await send("Page.navigateToHistoryEntry", { entryId: previous.id });
    return {};
  }));
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
  const marksByDocument = new Map();
  if (request.marks) {
    const scan = scans.get(tab);
    for (const [id, { frame, localId }] of (scan?.stale ? [] : scan?.locations ?? [])) {
      if (!marksByDocument.has(frame.documentId)) marksByDocument.set(frame.documentId, []);
      marksByDocument.get(frame.documentId).push({ id, localId });
    }
  }
  const viewports = await frames(tab, frame => ({ cmd: "viewport", marks: marksByDocument.get(frame.documentId) }));
  const top = viewports.find(({ frame }) => frame.frameId === 0);
  const viewport = top.result.rect;
  const rect = bounds(request.rect, viewport);
  const passwords = viewports.flatMap(({ result }) => result.passwords);
  const targets = viewports.flatMap(({ result }) => result.marks);
  try {
    await frames(tab, { cmd: "overlay", hide: true });
    const { data } = await withDebugger(tab, send => send("Page.captureScreenshot", {
      format: "png", fromSurface: true,
    }));
    const current = await chrome.webNavigation.getFrame({ tabId: tab, frameId: 0 });
    if (current?.documentId !== top.frame.documentId) throw new Error("Seite hat sich während des Screenshots geändert");
    return { rect, dataUrl: await renderShot(data, viewport, rect, targets, passwords) };
  } finally {
    await frames(tab, { cmd: "overlay", hide: false }, { requireTop: false }).catch(() => {});
  }
}

async function dispatch(request) {
  const { cmd, tab } = request;
  if (cmd === "reload") { setTimeout(() => chrome.runtime.reload(), 150); return {}; } // Update aus dem Ordner einspielen
  if (cmd === "tab_open") return openTab(request);
  if (cmd === "tab_list") return listTabs();
  if (cmd === "tab_adopt") return adoptTab(request);
  if (cmd === "tab_release") return releaseTab(request);
  if (!["tab_close", "navigate", "back", "wait", "scan", "shot", "preview", "click", "type", "focus", "scroll", "read", "stream_start", "stream_stop"].includes(cmd)) {
    throw new Error("Unbekannter Befehl");
  }

  await requireManaged(tab, ["tab_close", "navigate", "back", "click", "type", "focus", "scroll", "shot", "preview"].includes(cmd));
  switch (cmd) {
    case "tab_close": await streamStop(tab); await chrome.tabs.remove(tab); return {};
    case "stream_start": return streamStart(tab);
    case "stream_stop": await streamStop(tab); return {};
    case "navigate": return navigate(tab, urlFor(request.url));
    case "back": return back(tab);
    case "wait": return wait(tab, request);
    case "scan": return scan(tab, request);
    case "shot": return shot(tab, request);
    case "preview": {
      const [{ data }] = await withDebugger(tab, send => send("Page.captureScreenshot", { format: "jpeg", quality: 55, fromSurface: true }));
      return { dataUrl: "data:image/jpeg;base64," + data, tab };
    }
    default: return targetCommand(tab, request);
  }
}
