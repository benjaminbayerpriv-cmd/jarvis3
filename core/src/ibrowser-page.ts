// Seitenseitige Skripte des eingebauten Browsers. Jedes ist der Quelltext einer Funktion, den ibrowser.ts per
// Runtime.evaluate in der Seite ausführt (kein Zugriff auf Jarvis, nur DOM).

/** Sichtbare Bedienelemente einsammeln: (all: boolean) => { targets, total, url, title, scrollY, scrollMax } */
export const SCAN = `(all) => {
  const J = (window.__jv ??= { n: 0, map: new Map() });
  J.map.clear();
  const vw = innerWidth, vh = innerHeight;
  const roles = { button: "Button", link: "Link", textbox: "TextField", searchbox: "SearchField", checkbox: "CheckBox", radio: "RadioButton",
    combobox: "ComboBox", menuitem: "MenuItem", tab: "Tab", switch: "Switch", option: "Option", slider: "Slider", spinbutton: "SpinButton",
    listbox: "ListBox", treeitem: "TreeItem", menuitemcheckbox: "MenuItem", menuitemradio: "MenuItem" };
  const fields = new Set(["textbox", "searchbox", "combobox", "spinbutton", "listbox"]);
  const inputRole = { button: "button", submit: "button", reset: "button", image: "button", file: "button", checkbox: "checkbox", radio: "radio",
    range: "slider", search: "searchbox", number: "spinbutton", color: "button" };
  const tagRole = { BUTTON: "button", A: "link", AREA: "link", TEXTAREA: "textbox", SELECT: "combobox", SUMMARY: "button", OPTION: "option" };
  const clean = s => (s || "").replace(/\\s+/g, " ").trim();
  const roleOf = el => {
    if (el.tagName === "INPUT" && el.type === "hidden") return null;
    const r = (el.getAttribute("role") || "").trim().split(/\\s+/).find(v => roles[v]);
    if (r) return r;
    const t = el.tagName;
    if (t === "INPUT") return Object.prototype.hasOwnProperty.call(inputRole, el.type) ? inputRole[el.type] : "textbox";
    if (t === "A" || t === "AREA") return el.hasAttribute("href") ? "link" : (el.onclick || el.hasAttribute("onclick") ? "button" : null);
    if (t === "OPTION" && el.closest("select")?.size < 2) return null;
    if (t === "SUMMARY" && el.parentElement?.tagName !== "DETAILS") return null;
    if (tagRole[t]) return tagRole[t];
    if (el.isContentEditable && el.hasAttribute("contenteditable")) return "textbox";
    if (el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1" && getComputedStyle(el).cursor === "pointer")) return "button";
    if (getComputedStyle(el).cursor === "pointer" && el.children.length < 4 && clean(el.innerText).length) return "button";
    return null;
  };
  const labelOf = el => {
    let l = el.getAttribute("aria-label");
    if (!l) { const by = el.getAttribute("aria-labelledby"); if (by) l = by.split(/\\s+/).map(i => document.getElementById(i)?.innerText || "").join(" "); }
    if (!l && el.labels?.length) l = [...el.labels].map(x => x.innerText).join(" ");
    if (!l) l = el.tagName === "INPUT" && /^(button|submit|reset)$/.test(el.type) ? el.value : "";
    if (!l && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) l = el.innerText || el.textContent;
    if (!l) l = el.placeholder || el.title || el.alt || el.getAttribute("name") || el.value || "";
    if (!l && el.querySelector("img[alt]")) l = el.querySelector("img[alt]").alt;
    l = clean(l);
    return l.length > 90 ? l.slice(0, 89) + "…" : l;
  };
  const found = new Set(), items = [];
  const consider = el => {
    if (found.has(el)) return;
    found.add(el);
    const role = roleOf(el);
    if (!role) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    if (!all && (r.bottom < 0 || r.right < 0 || r.top > vh || r.left > vw)) return;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return;
    const cx = Math.min(vw - 1, Math.max(0, r.left + r.width / 2)), cy = Math.min(vh - 1, Math.max(0, r.top + r.height / 2));
    if (!all) {
      const top = document.elementFromPoint(cx, cy);
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some(x => x.contains(top)))) return;
    }
    const password = el.tagName === "INPUT" && el.type === "password";
    const enabled = !el.matches(":disabled, [aria-disabled='true']") && !password;
    const label = password ? "Passwortfeld (gesperrt)" : labelOf(el);
    const main = el.closest("main, [role=main]");
    const peripheral = el.closest("nav, footer, [role=navigation], [role=contentinfo], [role=banner]") || (!main && el.closest("header"));
    let priority = 4;
    if (!enabled) priority = 7;
    else if (role === "searchbox" || (fields.has(role) && /such|search/i.test(label))) priority = 0;
    else if (role === "textbox") priority = 1;
    else if (peripheral) priority = 6;
    else if (role === "button" && (main || el.type === "submit")) priority = 2;
    else if (role === "button" || fields.has(role)) priority = 3;
    items.push({ el, role, label, enabled, priority, password, rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
  };
  const walk = root => {
    root.querySelectorAll("*").forEach(el => { consider(el); if (el.shadowRoot) walk(el.shadowRoot); });
  };
  walk(document);
  items.sort((a, b) => a.priority - b.priority || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
  const targets = items.slice(0, 150).map(({ el, role, label, enabled, password, rect }) => {
    const id = ++J.n;
    J.map.set(id, el);
    const category = password || fields.has(role) ? "field" : role === "link" ? "link" : "control";
    return { id, role: category, axRole: "AX" + (password ? "SecureTextField" : roles[role] || "Unknown"), label, enabled, rect, source: "dom" };
  });
  const se = document.scrollingElement || document.documentElement;
  return { targets, total: items.length, url: location.href, title: document.title, scrollY: Math.round(se.scrollTop), scrollMax: Math.max(0, se.scrollHeight - innerHeight) };
}`;

/** Element zum Klicken vorbereiten: (id) => { x, y, tag, type, disabled } | { error } */
export const PREPARE = `(id) => {
  const el = window.__jv?.map.get(id);
  if (!el || !el.isConnected) return { error: "Unbekannte oder abgelaufene ID. Erst scan ausführen." };
  if (el.matches(":disabled, [aria-disabled='true']")) return { error: "Element ist deaktiviert" };
  if (el.tagName === "INPUT" && el.type === "password") return { error: "Passwortfelder sind gesperrt" };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: el.tagName, type: el.type || "", editable: el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) };
}`;

/** Textfeld fokussieren und Inhalt markieren (wird beim Tippen ersetzt): (id) => { ok } | { error } */
export const FOCUS_FOR_TYPING = `(id) => {
  const el = window.__jv?.map.get(id);
  if (!el || !el.isConnected) return { error: "Unbekannte oder abgelaufene ID. Erst scan ausführen." };
  if (el.matches(":disabled, [aria-disabled='true']")) return { error: "Element ist deaktiviert" };
  if (el.tagName === "INPUT" && el.type === "password") return { error: "Passwortfelder sind gesperrt" };
  if (el.tagName === "SELECT") return { select: true };
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  el.focus({ preventScroll: true });
  if (el.ownerDocument.activeElement !== el && el.getRootNode().activeElement !== el) return { error: "Element ist nicht fokussierbar" };
  if (typeof el.select === "function" && /^(INPUT|TEXTAREA)$/.test(el.tagName)) { try { el.select(); } catch {} }
  else if (el.isContentEditable) { const range = document.createRange(); range.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(range); }
  return { ok: true };
}`;

/** Eintrag einer Auswahlliste wählen: (id, text) => { ok } | { error } */
export const CHOOSE_OPTION = `(id, text) => {
  const el = window.__jv?.map.get(id);
  if (!el || el.tagName !== "SELECT") return { error: "Keine Auswahlliste" };
  const want = String(text).trim().toLowerCase();
  const option = [...el.options].find(o => o.label.trim().toLowerCase() === want || o.value.toLowerCase() === want)
    || [...el.options].find(o => o.label.toLowerCase().includes(want));
  if (!option) return { error: "Eintrag nicht gefunden: " + [...el.options].map(o => o.label.trim()).slice(0, 12).join(", ") };
  el.value = option.value;
  el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: option.label.trim() };
}`;

/** Text lesen: (id | null, rect | null, limit) => { text } | { error } */
export const READ = `(id, rect, limit) => {
  const clean = s => (s || "").replace(/[ \\t]+/g, " ").replace(/\\n{3,}/g, "\\n\\n").trim();
  if (id != null) {
    const el = window.__jv?.map.get(id);
    if (!el || !el.isConnected) return { error: "Unbekannte oder abgelaufene ID. Erst scan ausführen." };
    if (el.tagName === "INPUT" && el.type === "password") return { error: "Passwortfelder sind gesperrt" };
    if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) return { text: el.value };
    if (el.tagName === "SELECT") return { text: el.selectedOptions[0]?.label ?? "" };
    return { text: clean(el.innerText || el.textContent) };
  }
  if (!rect) return { text: clean(document.body?.innerText || "").slice(0, limit) };
  const [x, y, w, h] = rect, out = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.nodeValue.trim()) continue;
    range.selectNodeContents(node);
    const r = range.getBoundingClientRect();
    if (r.width && r.right > x && r.left < x + w && r.bottom > y && r.top < y + h) out.push(node.nodeValue.trim());
  }
  return { text: clean(out.join("\\n")).slice(0, limit) };
}`;

/** Nummerierte Rahmen für Screenshots (marks) ein- bzw. ausblenden: (ids | null) => void */
export const MARKS = `(ids) => {
  document.getElementById("__jv_marks")?.remove();
  if (!ids) return;
  const host = document.createElement("div");
  host.id = "__jv_marks";
  host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;font:700 12px system-ui;";
  for (const id of ids) {
    const el = window.__jv?.map.get(id);
    if (!el || !el.isConnected) continue;
    const r = el.getBoundingClientRect();
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;border:2px solid #ff3b6b;border-radius:3px;left:" + r.left + "px;top:" + r.top + "px;width:" + r.width + "px;height:" + r.height + "px";
    const tag = document.createElement("span");
    tag.textContent = id;
    tag.style.cssText = "position:absolute;left:-2px;top:-16px;background:#ff3b6b;color:#fff;padding:0 4px;border-radius:3px;line-height:14px";
    box.append(tag); host.append(box);
  }
  document.documentElement.append(host);
}`;
