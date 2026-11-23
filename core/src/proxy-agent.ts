// Agent, der der Proxy in jede Seite des direkten Browsers setzt (läuft nur im Rahmen der Jarvis-Oberfläche):
//  - meldet Adresse und Titel an die Oberfläche (postMessage)
//  - leitet Links zu fremden Herkünften und neue Fenster über den Proxy bzw. in neue Tabs
//  - verbindet sich mit jarvisd (/page), damit Jarvis die Seite bedienen kann: scan, click, type, read, scroll, wait, back, forward, reload
import { CHOOSE_OPTION, FOCUS_FOR_TYPING, PREPARE, READ, SCAN } from "./ibrowser-page";

export function agentSource(): string {
  return `(() => {
  "use strict";
  if (window.top === window || !window.__JV || window.__jvAgent) return;
  window.__jvAgent = true;
  const JV = window.__JV;
  const SCAN = ${SCAN}, PREPARE = ${PREPARE}, FOCUS_FOR_TYPING = ${FOCUS_FOR_TYPING}, CHOOSE_OPTION = ${CHOOSE_OPTION}, READ = ${READ};
  const post = m => { try { parent.postMessage({ jv: true, ...m }, "*"); } catch {} };
  const PROXY_HOST = /^p[0-9a-f]{10}\\.localhost(:\\d+)?$/;
  const realUrl = () => JV.origin + location.pathname + location.search + location.hash;
  const toReal = u => (u.host === location.host ? JV.origin + u.pathname + u.search + u.hash : u.href);

  // ----- Adresse und Titel melden -----
  let last = "";
  const report = () => {
    const key = realUrl() + "\\n" + document.title;
    if (key === last) return;
    last = key; post({ kind: "nav", url: realUrl(), title: document.title });
  };
  addEventListener("load", report); addEventListener("popstate", report); addEventListener("hashchange", report);
  for (const name of ["pushState", "replaceState"]) { const orig = history[name]; history[name] = function (...args) { const r = orig.apply(this, args); setTimeout(report); return r; }; }
  new MutationObserver(report).observe(document.head || document.documentElement, { childList: true, subtree: true, characterData: true });
  report();

  // ----- Links, Formulare und neue Fenster -----
  document.addEventListener("click", e => {
    if (e.defaultPrevented || e.button !== 0) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a) return;
    let u; try { u = new URL(a.href, location.href); } catch { return; }
    if (!/^https?:$/.test(u.protocol)) return;
    const real = a.dataset.jvHref || toReal(u);
    if (a.target === "_blank" || e.metaKey || e.ctrlKey) { e.preventDefault(); post({ kind: "open", url: real }); return; }
    if (u.host !== location.host && !PROXY_HOST.test(u.host)) { e.preventDefault(); location.href = JV.open + encodeURIComponent(real); }
  }, true);
  document.addEventListener("submit", e => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement) || e.defaultPrevented) return;
    let u; try { u = new URL(f.action || location.href, location.href); } catch { return; }
    if ((f.method || "get").toLowerCase() === "get" && u.host !== location.host && !PROXY_HOST.test(u.host)) {
      e.preventDefault();
      const params = new URLSearchParams(new FormData(f)); u.search = params.toString();
      location.href = JV.open + encodeURIComponent(u.href);
    }
  }, true);
  window.open = (url) => { try { post({ kind: "open", url: toReal(new URL(url || "about:blank", location.href)) }); } catch {} return null; };

  // ----- Brücke zu Jarvis -----
  let ws, tab = null;
  addEventListener("message", e => {
    if (e.source !== parent || !e.data) return;
    if (e.data.jv === "cmd") { run({ cmd: e.data.cmd }).catch(() => {}); return; }   // Zurück, Vor, Neu laden aus der Adressleiste
    if (e.data.jv !== "tab") return;
    tab = e.data.id; connect();
  });
  function connect() {
    if (ws && ws.readyState < 2) try { ws.close(); } catch {}
    ws = new WebSocket(JV.daemon);
    ws.onopen = () => ws.send(JSON.stringify({ hello: true, tab, url: realUrl(), title: document.title }));
    ws.onmessage = async ev => {
      const m = JSON.parse(ev.data);
      let r;
      try { r = await run(m); } catch (error) { r = { ok: false, error: String(error && error.message || error) }; }
      ws.send(JSON.stringify({ rid: m.rid, ok: true, ...r }));
    };
    ws.onclose = () => setTimeout(() => { if (tab != null && (!ws || ws.readyState === 3)) connect(); }, 1500);
  }
  post({ kind: "hello" });

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const mouse = (el, x, y) => { for (const t of ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup"])
    el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y, button: 0, buttons: t.endsWith("down") ? 1 : 0 })); };

  async function run(m) {
    switch (m.cmd) {
      case "info": return { url: realUrl(), title: document.title };
      case "scan": {
        if (document.readyState === "loading") await sleep(300);
        const r = SCAN(m.all === true);
        const out = { targets: r.targets, total: r.total, url: realUrl(), title: r.title };
        if (m.text) out.text = [realUrl() + " – „" + r.title + "“", r.targets.length + " von " + r.total + " Elementen" + (r.scrollMax > 0 ? " · gescrollt " + r.scrollY + "/" + r.scrollMax + " px" : ""),
          ...r.targets.map(t => t.id + " " + t.axRole.slice(2) + " „" + t.label + "“ @" + Math.round(t.rect[0] + t.rect[2] / 2) + "," + Math.round(t.rect[1] + t.rect[3] / 2) + (t.enabled ? "" : " (aus)"))].join("\\n");
        return out;
      }
      case "click": {
        const p = PREPARE(Number(m.id));
        if (p.error) throw new Error(p.error);
        if (p.tag === "SELECT") throw new Error("Auswahlliste: mit browser_type den Eintrag wählen (Text des Eintrags)");
        const el = window.__jv.map.get(Number(m.id));
        post({ kind: "cursor", x: p.x, y: p.y });
        mouse(el, p.x, p.y); el.click();
        await sleep(150);
        return { via: "dom", x: p.x, y: p.y };
      }
      case "type": {
        const f = FOCUS_FOR_TYPING(Number(m.id));
        if (f.error) throw new Error(f.error);
        if (f.select) { const c = CHOOSE_OPTION(Number(m.id), String(m.text)); if (c.error) throw new Error(c.error); return { chose: c.value }; }
        const el = window.__jv.map.get(Number(m.id)), text = String(m.text ?? "");
        post({ kind: "cursor", ...(() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })() });
        if (/^(INPUT|TEXTAREA)$/.test(el.tagName)) {
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
          setter.call(el, text);
          el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (el.isContentEditable) document.execCommand("insertText", false, text);
        if (m.submit) {
          const down = new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true });
          if (el.dispatchEvent(down)) { el.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true })); if (el.form) el.form.requestSubmit(); }
          el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
          await sleep(300);
        }
        return {};
      }
      case "scroll": {
        let target = null;
        if (m.id != null) { const p = PREPARE(Number(m.id)); if (p.error) throw new Error(p.error); target = window.__jv.map.get(Number(m.id)); }
        const dy = (Number(m.dy) || 0) * 100;
        const scroller = target && target.scrollHeight > target.clientHeight ? target : null;
        (scroller || window).scrollBy({ top: dy, behavior: "instant" });
        await sleep(150);
        return {};
      }
      case "read": {
        const r = READ(m.id ?? null, Array.isArray(m.rect) ? m.rect : null, Math.min(60000, Number(m.limit) || 20000));
        if (r.error) throw new Error(r.error);
        return { text: r.text, via: "dom" };
      }
      case "wait": {
        if (typeof m.for === "string" && m.for) {
          const end = Date.now() + Math.min(30000, Number(m.ms) || 10000);
          while (Date.now() < end) { if ((document.body && document.body.innerText || "").includes(m.for)) return { found: true }; await sleep(250); }
          return { found: false };
        }
        await sleep(Math.min(30000, Math.max(0, Number(m.ms) || 1000)));
        return {};
      }
      case "back": setTimeout(() => history.back(), 50); return {};
      case "forward": setTimeout(() => history.forward(), 50); return {};
      case "reload": setTimeout(() => location.reload(), 50); return {};
      default: throw new Error("Unbekannter Befehl " + m.cmd);
    }
  }
})();`;
}
