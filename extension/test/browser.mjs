import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const extension = fileURLToPath(new URL("../", import.meta.url));
const chromePath = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const connections = [];
const pending = new Map();
let rid = 0;
const fixture = `<!doctype html>
  <meta charset="utf-8"><title>Jarvis fixture</title>
  <style>body {margin:20px;min-height:2600px;background:#f7ead9} input {display:block}</style>
  <button onclick="document.querySelector('output').textContent='Clicked in background'">Test button</button>
  <output>Ready</output>
  <label>Message<input id="message" oninput="document.querySelector('output').textContent='Input: '+this.value"></label>
  <input aria-label="Secret label" type="password" value="never-serialize-me">
  <input aria-label="Another secret" autocomplete="current-password" value="also-never-serialize-me">
  <div contenteditable="true" aria-label="Editor"></div>
  <button onclick="window.open('/unexpected')">Try popup</button>
  <button disabled>Disabled</button>
  <a target="_blank" href="/second">Open second</a>
  <iframe title="Nested fixture" src="/frame"></iframe>
  <p style="margin-top:500px">Down here</p>
  <script>document.querySelector('#message').addEventListener('focus', () => document.body.dataset.focused='yes')</script>`;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request, server) {
    const path = new URL(request.url).pathname;
    if (path === "/browser" && server.upgrade(request)) return;
    const html = path === "/fixture" ? fixture : path === "/frame" ?
      "<button onclick=\"this.textContent='Frame clicked'\">Frame button</button>" :
      "<!doctype html><title>Sentinel</title><p>Second page</p>";
    return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
  },
  websocket: {
    idleTimeout: 0,
    message(ws, raw) {
      const message = JSON.parse(raw);
      if (message.hello === "jarvis-extension") connections.push({ ws, message });
      else {
        assert(pending.has(message.rid), "Unexpected protocol message");
        pending.get(message.rid)(message);
      }
    }
  }
});

const base = `http://127.0.0.1:${server.port}`;
// Chrome tunnels the production WebSocket URL through an isolated proxy in the
// test profile. This leaves any real daemon already listening on 7777 alone.
const proxy = createServer(client => {
  client.on("error", () => {});
  function connect(chunk) {
    const split = chunk.indexOf("\r\n\r\n");
    if (split < 0) return client.destroy();
    if (!chunk.toString().startsWith("CONNECT 127.0.0.1:7777 HTTP/")) return client.destroy();
    const upstream = Bun.connect({
      hostname: "127.0.0.1", port: server.port,
      socket: {
        open(socket) {
          client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          const remaining = chunk.subarray(split + 4);
          if (remaining.length) socket.write(remaining);
          client.on("data", data => socket.write(data));
          client.on("close", () => socket.end());
        },
        data(_socket, data) { client.write(data); },
        close() { client.end(); },
        error() { client.destroy(); },
      }
    });
    upstream.catch(() => client.destroy());
  }
  client.once("data", connect);
});
proxy.listen(0, "127.0.0.1");
await once(proxy, "listening");

const profile = await mkdtemp(join(tmpdir(), "jarvis-chrome-"));
const chrome = spawn(chromePath, [
  "--user-data-dir=" + profile, "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-pipe", "--enable-unsafe-extension-debugging", "--disable-background-networking",
  `--proxy-server=http=http://127.0.0.1:${proxy.address().port}`,
  `--proxy-bypass-list=<-loopback>;127.0.0.1:${server.port}`, base + "/sentinel"
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const closed = once(chrome, "close");
const devtoolsPending = new Map();
let buffer = "";
let sequence = 0;
chrome.stdio[4].setEncoding("utf8");
chrome.stdio[4].on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\0")) >= 0) {
    const response = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    devtoolsPending.get(response.id)?.(response);
  }
});
function devtools(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      devtoolsPending.delete(id);
      reject(new Error("DevTools timeout: " + method));
    }, 10000);
    devtoolsPending.set(id, ({ error, result }) => {
      clearTimeout(timer);
      devtoolsPending.delete(id);
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, sessionId }) + "\0");
  });
}

async function until(check, message, ms = 12000) {
  const deadline = Date.now() + ms;
  do {
    const value = await check();
    if (value) return value;
    await Bun.sleep(100);
  } while (Date.now() < deadline);
  assert.fail(message);
}

function ask(request) {
  const id = ++rid;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Protocol timeout: " + request.cmd));
    }, 35000);
    pending.set(id, answer => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(answer);
    });
    connections.at(-1).ws.send(JSON.stringify({ ...request, rid: id }));
  });
}

async function ok(cmd, fields) {
  const answer = await ask({ cmd, ...fields });
  assert.equal(answer.ok, true, cmd + ": " + answer.error);
  return answer;
}

async function fails(cmd, fields, error) {
  const answer = await ask({ cmd, ...fields });
  assert.equal(answer.ok, false, cmd);
  assert.match(answer.error, error);
}

async function evaluate(target, expression) {
  const { sessionId } = await devtools("Target.attachToTarget", { targetId: target, flatten: true });
  try {
    const reply = await devtools("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    assert(!reply.exceptionDetails, JSON.stringify(reply.exceptionDetails));
    return reply.result.value;
  } finally {
    await devtools("Target.detachFromTarget", { sessionId });
  }
}

try {
  const { id: extensionId } = await devtools("Extensions.loadUnpacked", { path: extension });
  await until(() => connections.length, "Extension did not connect to the mock");
  assert.deepEqual(connections[0].message, { hello: "jarvis-extension", version: "1.1.0" });
  const sentinel = await until(async () => (await ok("tab_list")).tabs.find(t => t.active && t.url === base + "/sentinel"),
    "Sentinel tab failed to load");
  const { tab } = await ok("tab_open", { url: base + "/fixture" });
  const onTab = fields => ({ tab, ...fields });
  await ok("wait", onTab({ for: "Ready" }));
  const secondTab = await ok("tab_open", { url: base + "/second" });
  const customTab = await ok("tab_open", { url: base + "/second", group: "Jarvis Test" });
  const groupTab = (await ok("tab_list")).tabs.find(t => t.tab === tab);
  assert.equal(groupTab.group, "Jarvis");
  assert.equal(groupTab.active, false);
  const worker = (await devtools("Target.getTargets")).targetInfos.find(target => target.type === "service_worker"
    && target.url.startsWith("chrome-extension://" + extensionId));
  const groupInfo = await evaluate(worker.targetId, `(async () => {
    const tab = await chrome.tabs.get(${tab});
    const group = await chrome.tabGroups.get(tab.groupId);
    return {color: group.color, window: (await chrome.windows.getLastFocused()).id,
      reused: (await chrome.tabs.get(${secondTab.tab})).groupId === group.id,
      custom: (await chrome.tabGroups.get((await chrome.tabs.get(${customTab.tab})).groupId)).title};
  })()`);
  assert.equal(groupInfo.color, "blue");
  assert.equal(groupInfo.reused, true);
  assert.equal(groupInfo.custom, "Jarvis Test");
  await ok("tab_close", { tab: secondTab.tab });
  await ok("tab_close", { tab: customTab.tab });

  const sentinelTarget = (await devtools("Target.getTargets")).targetInfos.find(t => t.url === base + "/sentinel").targetId;
  const sentinelTabTarget = (await devtools("Target.getTargets", { filter: [{ type: "tab" }] }))
    .targetInfos.find(t => t.url === base + "/sentinel").targetId;
  const hasOverlay = () => evaluate(sentinelTarget, "!!document.querySelector('web-bildschirmmarker-overlay')");
  assert.equal(await hasOverlay(), false);
  await devtools("Extensions.triggerAction", { id: extensionId, targetId: sentinelTabTarget });
  await until(hasOverlay, "Toolbar action did not enable the overlay");
  await devtools("Extensions.triggerAction", { id: extensionId, targetId: sentinelTabTarget });
  await until(async () => !await hasOverlay(), "Toolbar action did not disable the overlay");

  await devtools("Target.createTarget", { url: base + "/other-window", newWindow: true });
  const baseline = await evaluate(worker.targetId, `(async () => ({
    focus: (await chrome.windows.getLastFocused()).id,
    active: (await chrome.tabs.query({active:true})).map(t => t.id).sort(),
    count: (await chrome.tabs.query({})).length
  }))()`);
  assert.notEqual(baseline.focus, groupInfo.window);
  assert(baseline.active.includes(sentinel.tab));
  await evaluate(worker.targetId, `(() => {
    globalThis.focusEvents = [];
    chrome.tabs.onActivated.addListener(info => focusEvents.push(info));
    chrome.windows.onFocusChanged.addListener(id => focusEvents.push({windowId: id}));
  })()`);

  const otherWindowTab = await ok("tab_open", { url: base + "/second" });
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === otherWindowTab.tab).active, false);
  await ok("tab_close", { tab: otherWindowTab.tab });

  const scan = await ok("scan", onTab({ text: true }));
  assert.match(scan.text, /Button „Test button“ @\d+,\d+/);
  const find = name => {
    const target = scan.targets.find(t => t.label === name);
    assert(target, "Missing target: " + name);
    return target;
  };
  const page = (await devtools("Target.getTargets")).targetInfos.find(t => t.url === base + "/fixture").targetId;
  assert.equal(await evaluate(page, "!!document.querySelector('web-bildschirmmarker-overlay')"), false);
  await ok("click", onTab({ id: find("Test button").id }));
  await ok("wait", onTab({ for: "Clicked in background" }));
  await ok("focus", onTab({ id: find("Message").id }));
  assert.equal(await evaluate(page, "document.activeElement.id"), "message");
  await ok("type", onTab({ id: find("Message").id, text: "Grüße 👋" }));
  await ok("wait", onTab({ for: "Input: Grüße 👋" }));
  assert.equal((await ok("read", onTab({ id: find("Message").id }))).text, "Grüße 👋");
  await ok("type", onTab({ id: find("Editor").id, text: "Edited" }));
  assert.equal((await ok("read", onTab({ id: find("Editor").id }))).text, "Edited");
  const passwords = scan.targets.filter(t => t.label === "Passwortfeld");
  assert.equal(passwords.length, 2);
  for (const password of passwords) {
    await fails("read", onTab({ id: password.id }), /Passwort/);
    await fails("type", onTab({ id: password.id, text: "change" }), /Passwort/);
  }
  assert.equal(await evaluate(page, "document.querySelector('[type=password]').value"), "never-serialize-me");
  const text = await ok("read", onTab({ rect: [0, 0, 600, 350] }));
  assert.match(text.text, /Grüße 👋/);
  assert.doesNotMatch(JSON.stringify([scan, text]), /never-serialize-me|Secret label/);
  await fails("click", onTab({ id: find("Disabled").id }), /deaktiviert/);
  await ok("click", onTab({ id: find("Frame button").id }));
  await ok("wait", onTab({ for: "Frame clicked" }));
  await ok("click", onTab({ id: find("Try popup").id }));

  const region = [0, 0, 300, 180];
  const plain = await ok("shot", onTab({ rect: region }));
  const marked = await ok("shot", onTab({ rect: region, marks: true }));
  assert.deepEqual(plain.rect, region);
  assert.match(plain.dataUrl, /^data:image\/png;base64,/);
  assert.notEqual(plain.dataUrl, marked.dataUrl);
  const png = Buffer.from(plain.dataUrl.split(",")[1], "base64");
  assert(png.readUInt32BE(16) >= region[2] && png.readUInt32BE(20) >= region[3]);
  // Decode the screenshot in Chrome and check a known background pixel and the password mask.
  const [passwordX, passwordY, passwordWidth, passwordHeight] = passwords[0].rect;
  assert.deepEqual(await evaluate(page, `(async () => {
    const image = await createImageBitmap(await (await fetch(${JSON.stringify(plain.dataUrl)})).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image,0,0);
    const pixel = (x,y) => Array.from(ctx.getImageData(x,y,1,1).data);
    return [pixel(5,5), pixel(Math.floor((${passwordX} + ${passwordWidth}/2) * image.width / ${region[2]}),
      Math.floor((${passwordY} + ${passwordHeight}/2) * image.height / ${region[3]}))];
  })()`), [[247, 234, 217, 255], [24, 32, 43, 255]]);

  await ok("scroll", onTab({ id: find("Test button").id, dy: 5 }));
  assert.equal(await evaluate(page, "scrollY"), 200);
  await ok("scroll", onTab({ dy: -5 }));
  assert.equal(await evaluate(page, "scrollY"), 0);
  await ok("scan", onTab({ all: true }));
  await fails("click", onTab({ id: find("Test button").id }), /ID/);
  const link = (await ok("scan", onTab())).targets.find(t => t.label === "Open second");
  await ok("click", onTab({ id: link.id }));
  await ok("wait", onTab({ for: "Second page" }));
  await ok("back", onTab());
  await ok("wait", onTab({ for: "Ready" }));
  await ok("navigate", onTab({ url: base + "/second" }));
  await ok("wait", onTab({ for: "Second page" }));
  await ok("wait", onTab({ ms: 10 }));
  await fails("wait", onTab({ ms: 150, for: "Absent text" }), /Zeitüberschreitung/);
  await fails("tab_close", { tab: sentinel.tab }, /gehört nicht/);
  const current = await evaluate(worker.targetId, `(async () => ({
    focus: (await chrome.windows.getLastFocused()).id,
    active: (await chrome.tabs.query({active:true})).map(t => t.id).sort(),
    count: (await chrome.tabs.query({})).length
  }))()`);
  assert.deepEqual(current, baseline, "Focus, active tab and total tab count must stay stable");
  assert.deepEqual(await evaluate(worker.targetId, "focusEvents"), [], "Even transient focus changes are forbidden");
  await ok("tab_close", onTab());
  assert(!(await ok("tab_list")).tabs.some(t => t.tab === tab));

  connections[0].ws.close();
  await until(() => connections.length === 2, "Extension did not reconnect");
  await Bun.sleep(32000);
  await ok("tab_list");
  assert.equal(connections.length, 2, "Worker disconnected while idle");
  console.log("Passed: all 13 commands, toolbar toggle, two-window background operation, password protection, PNG capture, reconnect and idle connection.");
} finally {
  await devtools("Browser.close").catch(() => {});
  await Promise.race([closed, Bun.sleep(3000)]);
  if (chrome.exitCode === null) chrome.kill();
  proxy.close();
  server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
