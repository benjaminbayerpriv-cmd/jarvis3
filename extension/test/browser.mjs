import assert from "node:assert/strict";
import { startBrowser } from "./harness.mjs";

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
  <form action="/second" target="_blank">
    <input name="q" aria-label="Trusted input" onbeforeinput="if (!event.isTrusted) event.preventDefault()"
      oninput="document.querySelector('output').textContent = event.isTrusted ? 'Trusted: '+this.value : 'Synthetic'">
    <button formtarget="_blank">Submit form</button>
  </form>
  <p style="opacity:0">Invisible text</p>
  <iframe title="Nested fixture" src="/frame"></iframe>
  <p style="margin-top:500px">Down here</p>
  <script>document.querySelector('#message').addEventListener('focus', () => document.body.dataset.focused='yes')</script>`;

const { base, extension, connections, frames, devtools, evaluate, until, ok, fails, close } = await startBrowser(async path => {
  if (path === "/redirect") return new Response(null, { status: 302, headers: { Location: "/second" } });
  if (path === "/slow-script") {
    await Bun.sleep(600);
    return new Response("document.querySelector('output').textContent = 'Slow script loaded'", {
      headers: { "Content-Type": "application/javascript" }
    });
  }
  const html = path === "/fixture" ? fixture : path === "/frame" ?
    "<button onclick=\"this.textContent='Frame clicked'\">Frame button</button>" :
    path === "/slow" ? "<!doctype html><output>Loading</output><script async src='/slow-script'></script>" :
    path === "/dense" ? `<!doctype html><title>Dense fixture</title>
      <nav><a href="#nav">Navigation link</a></nav>
      <main><input type="search" aria-label="Find"><textarea aria-label="Notes"></textarea><button>Primary</button>
      ${Array.from({ length: 158 }, () => "<a href='#main'>More</a> ").join("")}</main>
      <footer><a href="#foot">Footer link</a></footer><p>${"Long text ".repeat(1000)}</p>` :
    "<!doctype html><title>Sentinel</title><p>Second page</p>";
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
});

try {
  const { id: extensionId } = await devtools("Extensions.loadUnpacked", { path: extension });
  await until(() => connections.length, "Extension did not connect to the mock");
  assert.deepEqual(connections[0].message, { hello: "jarvis-extension", version: "1.2.2" });
  const sentinel = await until(async () => (await ok("tab_list")).tabs.find(t => t.active && t.url === base + "/sentinel"),
    "Sentinel tab failed to load");
  const { tab } = await ok("tab_open", { url: base + "/fixture" });
  const onTab = fields => ({ tab, ...fields });
  assert.match((await ok("read", onTab())).text, /Ready/);
  const secondTab = await ok("tab_open", { url: base + "/slow" });
  assert.equal((await ok("read", { tab: secondTab.tab })).text, "Slow script loaded");
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
  const whole = await ok("read", onTab());
  assert.match(whole.text, /Down here/);
  assert.doesNotMatch(whole.text, /Invisible text|never-serialize-me/);
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
  await fails("read", onTab({ id: link.id }), /^Seite hat gewechselt, bitte neu scannen$/);
  assert.match((await ok("read", onTab())).text, /Second page/);
  await ok("back", onTab());
  assert.match((await ok("read", onTab())).text, /Ready/);
  const trusted = (await ok("scan", onTab())).targets.find(t => t.label === "Trusted input");
  assert.equal((await ok("type", onTab({ id: trusted.id, text: "Tauri" }))).via, "cdp");
  assert.match((await ok("read", onTab())).text, /Trusted: Tauri/);
  await ok("type", onTab({ id: trusted.id, text: "" }));
  assert.equal((await ok("read", onTab({ id: trusted.id }))).text, "");
  const nativeSubmit = await ok("type", onTab({ id: trusted.id, text: "Tauri", submit: true }));
  assert.equal(nativeSubmit.via, "cdp");
  assert.notEqual(nativeSubmit.submitted, false);
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === tab).url, base + "/second?q=Tauri");
  await fails("click", onTab({ id: trusted.id }), /^Seite hat gewechselt, bitte neu scannen$/);
  await ok("navigate", onTab({ url: base + "/fixture" }));
  const { id: formField } = (await ok("scan", onTab())).targets.find(t => t.label === "Trusted input");
  await evaluate(page, `(() => {
    const form = document.querySelector('form');
    const field = form.elements.q;
    const list = form.appendChild(document.createElement('div'));
    list.setAttribute('role', 'listbox');
    list.textContent = 'Autocomplete suggestions';
    globalThis.submitEvents = [];
    field.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      list.hidden = true;
      if (field.value === 'Inline') document.querySelector('output').textContent = 'Inline result';
    });
    form.addEventListener('submit', event => {
      submitEvents.push(event.submitter?.textContent);
      if (field.value !== 'Fallback') event.preventDefault();
    });
  })()`);
  const inline = await ok("type", onTab({ id: formField, text: "Inline", submit: true }));
  assert.equal(inline.via, "cdp");
  assert.notEqual(inline.submitted, false);
  assert.deepEqual(await evaluate(page, "submitEvents"), []);
  await evaluate(page, "document.querySelector('[role=listbox]').hidden = false");
  const { id: failedField } = (await ok("scan", onTab())).targets.find(t => t.label === "Trusted input");
  const failedSubmit = await ok("type", onTab({ id: failedField, text: "Ignored", submit: true }));
  assert.equal(failedSubmit.via, "cdp+form");
  assert.equal(failedSubmit.submitted, false);
  assert.deepEqual(await evaluate(page, "submitEvents"), ["Submit form"]);
  assert.equal(await evaluate(page, "document.querySelector('button[formtarget]').formTarget"), "_blank");
  const fallback = await ok("type", onTab({ id: failedField, text: "Fallback", submit: true }));
  assert.equal(fallback.via, "cdp+form");
  assert.notEqual(fallback.submitted, false);
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === tab).url, base + "/second?q=Fallback");
  await ok("navigate", onTab({ url: base + "/dense" }));
  const dense = await ok("scan", onTab({ text: true }));
  assert.deepEqual(dense.targets.slice(0, 3).map(t => t.label), ["Find", "Notes", "Primary"]);
  assert.equal(dense.targets.length, 150);
  assert(dense.total > 150);
  assert.match(dense.text, new RegExp("^150 von " + dense.total + " Elementen"));
  assert(!dense.targets.some(t => /Navigation link|Footer link/.test(t.label)));
  assert.equal((await ok("read", onTab())).text.length, 8000);
  await ok("navigate", onTab({ url: base + "/dense#main" }));
  await fails("read", onTab({ id: dense.targets[0].id }), /^Seite hat gewechselt, bitte neu scannen$/);
  const fragmentScan = await ok("scan", onTab());
  await ok("navigate", onTab({ url: base + "/redirect" }));
  await fails("read", onTab({ id: fragmentScan.targets[0].id }), /^Seite hat gewechselt, bitte neu scannen$/);
  assert.match((await ok("read", onTab())).text, /Second page/);
  await ok("wait", onTab({ ms: 10 }));
  await fails("wait", onTab({ ms: 150, for: "Absent text" }), /Zeitüberschreitung/);
  await fails("tab_close", { tab: sentinel.tab }, /gehört nicht/);
  // Live-Ansicht: Bilder kommen, Befehle gehen parallel weiter, Stopp beendet den Strom
  await ok("stream_start", onTab());
  await until(() => frames.filter(f => f.type === "frame" && f.tab === tab).length >= 3, "Keine Live-Bilder");
  const frame = frames.find(f => f.type === "frame");
  assert(frame.data.startsWith("/9j/"), "Live-Bild ist kein JPEG");
  assert(frame.w > 0 && frame.h > 0 && frame.url.includes("/second"));
  await ok("scan", onTab());               // Debugger wird mitbenutzt, kein zweites attach
  await ok("stream_stop", onTab());
  await until(() => frames.some(f => f.type === "stream_ended" && f.tab === tab), "stream_ended fehlt");
  const seen = frames.length; await Bun.sleep(900);
  assert.equal(frames.length, seen, "Nach dem Stopp dürfen keine Bilder mehr kommen");

  // Vorhandenen Tab übernehmen: erst gesperrt, nach tab_adopt steuerbar, aktiver Tab nur lesbar, tab_release gibt frei
  const existing = await evaluate(worker.targetId, `(async () => (await chrome.tabs.create({ url: ${JSON.stringify(base + "/fixture")}, active: false })).id)()`);
  await until(async () => (await evaluate(worker.targetId, `chrome.tabs.get(${existing}).then(t => t.status)`)) === "complete", "Vorhandener Tab lädt nicht");
  await Bun.sleep(300); // Content-Script nach document_idle
  await fails("scan", { tab: existing }, /gehört nicht/);
  const adopted = await ok("tab_adopt", { tab: existing });
  assert.equal(adopted.tab, existing);
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === existing).group, "Jarvis");
  assert.match((await ok("read", { tab: existing })).text, /Ready/);
  const scanned = await ok("scan", { tab: existing });
  assert(scanned.targets.length > 0);
  await fails("tab_adopt", { tab: sentinel.tab, group: "" }, /Gruppenname/);
  // Übernommener Tab, der gerade aktiv ist: lesen ja, bedienen nein; eigener Jarvis-Tab: auch aktiv bedienbar
  const activeAdopt = await ok("tab_adopt", { tab: sentinel.tab });
  assert.equal(activeAdopt.active, true);
  assert.match((await ok("read", { tab: sentinel.tab })).text, /Second page|Sentinel/);
  await fails("scroll", { tab: sentinel.tab, dy: 1 }, /aktive Tab des Nutzers/);
  await ok("tab_release", { tab: sentinel.tab });
  await ok("tab_release", { tab: existing });
  assert.equal((await ok("tab_list")).tabs.find(t => t.tab === existing).group, null);
  await fails("scan", { tab: existing }, /gehört nicht/);
  await evaluate(worker.targetId, `chrome.tabs.remove(${existing})`);

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
  console.log("Passed: all 13 commands, two-window background operation, trusted input, navigation, scan priority, full-page text, password protection, PNG capture, reconnect and idle connection.");
} finally {
  await close();
}
