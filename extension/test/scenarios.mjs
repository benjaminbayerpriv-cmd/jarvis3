import assert from "node:assert/strict";
import { startBrowser } from "./harness.mjs";

const { base, extension, connections, devtools, evaluate, until, ok, fails, close } = await startBrowser(
  () => new Response("<!doctype html><title>Jarvis focus sentinel</title>", {
    headers: { "Content-Type": "text/html; charset=utf-8" }
  }),
  ["--window-size=1440,1000"]
);

try {
  const { id: extensionId } = await devtools("Extensions.loadUnpacked", { path: extension });
  await until(() => connections.length, "Extension did not connect to the scenario daemon");
  const sentinel = await until(async () => (await ok("tab_list")).tabs.find(
    tab => tab.active && tab.url === base + "/sentinel"), "Sentinel did not load");
  const worker = (await devtools("Target.getTargets")).targetInfos.find(target => target.type === "service_worker"
    && target.url.startsWith("chrome-extension://" + extensionId)).targetId;
  const baseline = await evaluate(worker, `(async () => {
    globalThis.scenarioFocusEvents = [];
    chrome.tabs.onActivated.addListener(info => scenarioFocusEvents.push(info));
    chrome.windows.onFocusChanged.addListener(id => scenarioFocusEvents.push(id));
    return (await chrome.windows.getLastFocused()).id;
  })()`);

  const tabUrl = async tab => (await ok("tab_list")).tabs.find(item => item.tab === tab).url;
  const find = async (tab, predicate, description) => {
    const scan = await ok("scan", { tab, text: true });
    const target = scan.targets.find(predicate);
    assert(target, description + "\n" + scan.text);
    return target.id;
  };
  const searchField = target => target.role === "field" && /search|such/i.test(target.axRole + " " + target.label);
  const wikiField = target => searchField(target) && target.rect[1] > 100;

  const { tab: wiki } = await ok("tab_open", { url: "https://de.wikipedia.org/wiki/Spezial:Suche" });
  const wikiSearch = await find(wiki, wikiField, "Wikipedia search field missing");
  await ok("type", { tab: wiki, id: wikiSearch, text: "Tauri", submit: true });
  assert.match(await tabUrl(wiki), /[?&]search=Tauri\b/);
  await fails("read", { tab: wiki, id: wikiSearch }, /^Seite hat gewechselt, bitte neu scannen$/);
  console.log("Passed: German Wikipedia search and Enter.");
  // The German search has no article result for "Tauri". Use English Wikipedia for the article flow.
  await ok("navigate", { tab: wiki, url: "https://en.wikipedia.org/wiki/Special:Search" });
  const englishSearch = await find(wiki, wikiField, "English Wikipedia search field missing");
  await ok("type", { tab: wiki, id: englishSearch, text: "Tauri", submit: true });
  assert.match(await tabUrl(wiki), /[?&]search=Tauri\b/);
  const firstResult = await find(wiki, target => target.role === "link" && /^Tauri(?:$| \()/.test(target.label),
    "Wikipedia search result missing");
  await ok("click", { tab: wiki, id: firstResult });
  assert.match(await tabUrl(wiki), /\/wiki\/[^/?]+/);
  assert.doesNotMatch(await tabUrl(wiki), /Spezial:Suche|[?&]search=/);
  await fails("read", { tab: wiki, id: firstResult }, /^Seite hat gewechselt, bitte neu scannen$/);
  assert.match((await ok("read", { tab: wiki })).text, /\bTauri\b/);
  console.log("Passed: Wikipedia search → first result → page text.");

  const { tab: duck } = await ok("tab_open", { url: "https://duckduckgo.com/" });
  const duckSearch = await find(duck, searchField, "DuckDuckGo search field missing");
  await ok("type", { tab: duck, id: duckSearch, text: "Tauri" });
  assert.equal((await ok("read", { tab: duck, id: duckSearch })).text, "Tauri");
  await ok("type", { tab: duck, id: duckSearch, text: "Tauri", submit: true });
  await until(async () => /[?&]q=Tauri\b/i.test(await tabUrl(duck)), "DuckDuckGo did not submit on Enter");
  console.log("Passed: DuckDuckGo text entry and Enter.");

  const { tab: github } = await ok("tab_open", { url: "https://github.com/tauri-apps/tauri" });
  const fileSearch = target => target.role === "field" && target.label === "Go to file";
  const githubSearch = await find(github, fileSearch, "GitHub file search field missing");
  await ok("type", { tab: github, id: githubSearch, text: "README.md" });
  assert.equal((await ok("read", { tab: github, id: githubSearch })).text, "README.md");
  const repo = (await devtools("Target.getTargets")).targetInfos.find(t => t.url === "https://github.com/tauri-apps/tauri");
  // GitHub's animated overlay can remain transparent in a headless background tab.
  await until(() => evaluate(repo.targetId, `(() => {
    const field = document.querySelector('[aria-label="Go to file"]');
    const option = document.getElementById(field?.getAttribute("aria-activedescendant"));
    return option?.textContent.includes("README.md") ?? false;
  })()`), "GitHub file suggestions did not update");
  const githubSubmit = await find(github, fileSearch, "GitHub file search field missing");
  await ok("type", { tab: github, id: githubSubmit, text: "README.md", submit: true });
  await until(async () => /\/blob\/[^/]+\/README\.md$/i.test(await tabUrl(github)), "GitHub did not open the file on Enter");
  console.log("Passed: GitHub file search, suggestions and Enter.");

  for (const tab of [wiki, duck, github]) await ok("tab_close", { tab });
  assert.deepEqual((await ok("tab_list")).tabs.filter(tab => tab.active).map(tab => tab.tab), [sentinel.tab]);
  assert.equal(await evaluate(worker, "chrome.windows.getLastFocused().then(window => window.id)"), baseline);
  assert.deepEqual(await evaluate(worker, "scenarioFocusEvents"), []);
  console.log("Passed: no changes to the active tab or focused window.");
} finally {
  await close();
}
