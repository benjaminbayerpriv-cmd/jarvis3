// App-Name: „Jarvis“ lässt sich in den Einstellungen umbenennen; der gewählte Name steht dann überall in der Oberfläche.
// Reine Textfunktionen (testbar) plus ein kleiner DOM-Ersatz, der Texte und Beschriftungen (title, placeholder, aria-label, alt) ersetzt.
// Nicht ersetzt werden die Chatnachrichten selbst (Verlauf bleibt, wie er war) und Elemente mit data-keep-name.
export const DEFAULT_NAME = "Jarvis";

/** Wie im Daemon (cleanAppName in settings.ts): 1 bis 24 Zeichen, keine Steuerzeichen, < > " ` \, Leerraum zusammengezogen. Leer = ungültig. */
export function cleanAppName(v) {
  if (typeof v !== "string") return "";
  const s = v.replace(/[\u0000-\u001f\u007f<>"`\\]/g, "").replace(/\s+/g, " ").trim();
  return s.length >= 1 && s.length <= 24 ? s : "";
}

/** „Jarvis“ durch den Namen ersetzen (nicht in „Jarvis Bildschirm“, dem Namen der macOS-App). */
export function brand(text, name) {
  const s = String(text ?? "");
  return name && name !== DEFAULT_NAME ? s.replace(/\bJarvis\b(?! Bildschirm)/g, () => name) : s;
}

const ATTRS = ["title", "placeholder", "aria-label", "alt"];
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "INPUT", "SELECT", "OPTION", "TEMPLATE"]);
const textOrig = new WeakMap(), attrOrig = new WeakMap();
const skipped = el => !el || SKIP_TAGS.has(el.tagName) || !!el.closest?.("[data-keep-name], .turn, template");

// Gemerkt wird je Knoten das Original und der zuletzt geschriebene Text: weicht der aktuelle Text davon ab, hat die Seite ihn neu gesetzt
function applyText(node, name) {
  if (skipped(node.parentElement)) return;
  const now = node.nodeValue, mem = textOrig.get(node);
  const orig = mem && mem.last === now ? mem.orig : now;
  if (!/Jarvis/.test(orig)) { textOrig.delete(node); return; }
  const next = brand(orig, name);
  textOrig.set(node, { orig, last: next });
  if (next !== now) node.nodeValue = next;
}

function applyAttrs(el, name) {
  if (!el.getAttribute || el.closest("[data-keep-name], .bubble")) return;
  let map = attrOrig.get(el);
  for (const a of ATTRS) {
    const now = el.getAttribute(a);
    if (now === null) continue;
    const mem = map?.[a];
    const orig = mem && mem.last === now ? mem.orig : now;
    if (!/Jarvis/.test(orig)) { if (map) delete map[a]; continue; }
    if (!map) attrOrig.set(el, map = {});
    const next = brand(orig, name);
    map[a] = { orig, last: next };
    if (next !== now) el.setAttribute(a, next);
  }
}

/** Ersetzt in `root` (Standard: ganze Seite) alle Texte und Beschriftungen. */
export function applyName(name, root = document.body) {
  if (!root) return;
  if (root.nodeType === 3) { applyText(root, name); return; }
  if (root.nodeType !== 1) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) applyText(n, name);
  applyAttrs(root, name);
  for (const el of root.querySelectorAll(ATTRS.map(a => `[${a}]`).join(","))) applyAttrs(el, name);
}

/** Hält die Seite aktuell: neu erzeugte Texte (Hinweise, Meldungen, Einstellungen) bekommen den Namen sofort. `getName` liefert den aktuellen Namen. */
export function watchName(getName) {
  let timer = 0; const pending = new Set();
  const run = () => { timer = 0; const name = getName(); for (const n of pending) if (n.isConnected) applyName(name, n); pending.clear(); };
  const obs = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === "childList") for (const n of m.addedNodes) pending.add(n);
      else pending.add(m.type === "attributes" ? m.target : m.target);
    }
    if (!timer) timer = setTimeout(run, 0);
  });
  obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  return { refresh: () => { applyName(getName()); document.title = brand(titleOrig, getName()); }, stop: () => obs.disconnect() };
}
const titleOrig = typeof document !== "undefined" ? document.title : "Jarvis";
