// Eingebauter Browser: ein eigenes, unsichtbares Chrome (Profil unter ~/.jarvis3/browser-profile) wird über das DevTools-Protokoll
// gesteuert. Die Vorschau zeigt seine Tabs als scharfes Live-Bild (Screencast in der Größe des Vorschaufensters) und leitet Maus,
// Tastatur und Scrollen weiter; Jarvis bedient dieselben Tabs mit denselben Werkzeugen (scan, click, type, read …) wie in Chrome.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Cdp } from "./cdp";
import { CHOOSE_OPTION, FOCUS_FOR_TYPING, MARKS, PREPARE, READ, SCAN } from "./ibrowser-page";

type Reply = Record<string, any> & { ok: boolean };
interface Tab {
  id: number; targetId: string; cdp: Cdp; title: string; url: string;
  w: number; h: number; dpr: number;
  streaming: boolean; lastFrame: number; frameTimer?: ReturnType<typeof setInterval>;
  cursor?: [number, number]; cursorAt: number;
}

/** Tab-Nummern: 100 001–199 999 = Video-Browser (dieses Modul), 300 001–399 999 = direkter Browser (dbrowser.ts); Chrome-Tabs haben Nummern in Millionenhöhe */
export const FIRST_ID = 100_000;
export const LAST_ID = 199_999;
const SCREENCAST_MIN_MS = 25;
const QUALITY = 76;               // Bildqualität des Streams: sichtbar scharf, aber nur etwa halb so groß wie 90
const MAX_PIXELS = 2_000_000;      // Obergrenze je Bild (etwa 1600×1250)

/** Eingabe der Adressleiste: vollständige Adresse oder Suchbegriff */
export function urlFor(input: string): string {
  const text = String(input ?? "").trim();
  if (!text) return "about:blank";
  if (/^(https?|file|about|data|chrome|blob):/i.test(text)) return text;
  if (/^localhost(:\d+)?(\/|$)/i.test(text) || /^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(text)) return "http://" + text;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?([/?#].*)?$/i.test(text)) return "https://" + text;
  return "https://www.google.com/search?q=" + encodeURIComponent(text);
}

export function findChrome(): string | undefined {
  const env = process.env.JARVIS_CHROME;
  if (env && existsSync(env)) return env;
  const local = process.env.LOCALAPPDATA ?? "", pf = process.env["ProgramFiles"] ?? "C:\\Program Files", pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const candidates = process.platform === "darwin" ? [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ] : process.platform === "win32" ? [
    join(pf, "Google/Chrome/Application/chrome.exe"), join(pf86, "Google/Chrome/Application/chrome.exe"), join(local, "Google/Chrome/Application/chrome.exe"),
    join(pf86, "Microsoft/Edge/Application/msedge.exe"), join(pf, "Microsoft/Edge/Application/msedge.exe"),
  ] : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"];
  return candidates.find(existsSync);
}

export class InternalBrowser {
  private tabs = new Map<number, Tab>();
  private byTarget = new Map<string, number>();
  private proc?: ReturnType<typeof Bun.spawn>;
  private root?: Cdp;
  private starting?: Promise<string | undefined>;
  private nextId = FIRST_ID + 1;
  private ua = "";
  private expectBlank = 0;
  /** Live-Bild eines Tabs (nur für gestreamte Tabs) */
  onFrame?: (m: Record<string, any>) => void;
  /** Tabs kamen hinzu, gingen oder haben Titel/Adresse geändert */
  onTabs?: () => void;
  /** Ein gestreamter Tab ist verschwunden */
  onClosed?: (tab: number) => void;
  /** Ein Tab wurde von der Seite selbst geöffnet (window.open, target=_blank) */
  onOpened?: (tab: number) => void;
  /** Hinweise für den Nutzer (z. B. Dialoge) */
  onNotice?: (text: string) => void;

  constructor(private port = Number(process.env.JARVIS_BROWSER_PORT ?? 9333),
              private profile = process.env.JARVIS_BROWSER_PROFILE ?? join(homedir(), ".jarvis3", "browser-profile")) {}

  isTab(id: unknown): id is number { return Number.isInteger(id) && (id as number) > FIRST_ID && (id as number) <= LAST_ID && this.tabs.has(id as number); }
  /** Gehört die Nummer zum eingebauten Browser (auch wenn der Tab inzwischen weg ist)? */
  owns(id: unknown): boolean { return Number.isInteger(id) && (id as number) > FIRST_ID && (id as number) <= LAST_ID; }
  available() { return !!findChrome(); }
  get running() { return !!this.root && !this.root.closed; }
  /** Prozess des eigenen Chrome (macOS legt für ihn ein verdecktes Fenster an, das in der Fensterliste nichts zu suchen hat) */
  get pid() { return this.proc?.pid; }

  private http(path: string, method = "GET") {
    return fetch(`http://127.0.0.1:${this.port}${path}`, { method, signal: AbortSignal.timeout(5000) });
  }

  /** Startet Chrome bei Bedarf. Gibt eine Fehlermeldung zurück, wenn das nicht geht. */
  ensure(): Promise<string | undefined> {
    if (this.running) return Promise.resolve(undefined);
    return this.starting ??= this.start().finally(() => { this.starting = undefined; });
  }

  private async start(): Promise<string | undefined> {
    try {
      let version: any = await this.http("/json/version").then(r => r.json()).catch(() => undefined);
      if (!version) {
        const bin = findChrome();
        if (!bin) return "Kein Chrome gefunden (JARVIS_CHROME setzen oder Google Chrome installieren)";
        mkdirSync(this.profile, { recursive: true });
        this.proc = Bun.spawn([bin, "--headless=new", `--remote-debugging-port=${this.port}`, "--remote-allow-origins=*",
          `--user-data-dir=${this.profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling",
          "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--hide-crash-restore-bubble",
          "--disable-search-engine-choice-screen", "--password-store=basic", "--use-mock-keychain", "--window-size=1280,800", "--lang=de-DE", "about:blank"],
          { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
        for (let i = 0; i < 60 && !version; i++) { await Bun.sleep(250); version = await this.http("/json/version").then(r => r.json()).catch(() => undefined); }
        if (!version) return "Der eingebaute Browser startet nicht";
      }
      this.ua = String(version["User-Agent"] ?? "").replace(/HeadlessChrome/g, "Chrome");
      this.root = await Cdp.connect(version.webSocketDebuggerUrl);
      this.root.onClose = () => { this.root = undefined; for (const t of this.tabs.values()) this.dropTab(t, false); this.onTabs?.(); };
      this.root.on("Target.targetCreated", ({ targetInfo }) => void this.discovered(targetInfo));
      this.root.on("Target.targetInfoChanged", ({ targetInfo }) => {
        const tab = this.tabs.get(this.byTarget.get(targetInfo.targetId) ?? -1);
        if (!tab) return;
        tab.title = targetInfo.title || tab.title; tab.url = targetInfo.url || tab.url; this.onTabs?.();
      });
      this.root.on("Target.targetDestroyed", ({ targetId }) => { const tab = this.tabs.get(this.byTarget.get(targetId) ?? -1); if (tab) this.dropTab(tab); });
      await this.root.send("Target.setDiscoverTargets", { discover: true });
      return undefined;
    } catch (error) { return `Der eingebaute Browser startet nicht: ${(error as Error)?.message ?? error}`; }
  }

  private async discovered(info: any) {
    if (info.type !== "page" || this.byTarget.has(info.targetId) || /^devtools:/.test(info.url)) return;
    if (info.url === "about:blank" && !info.openerId && this.expectBlank === 0) { // leerer Starttab von Chrome: nicht anzeigen
      void this.http(`/json/close/${info.targetId}`).catch(() => {});
      return;
    }
    const opened = await this.attach(info.targetId, info.url, info.title).catch(() => undefined);
    if (opened && info.openerId) this.onOpened?.(opened.id);
  }

  private attaching = new Map<string, Promise<Tab | undefined>>();
  /** Jeder Tab wird nur einmal verbunden, auch wenn Ereignis und Öffnen gleichzeitig eintreffen. */
  private attach(targetId: string, url = "", title = ""): Promise<Tab | undefined> {
    let p = this.attaching.get(targetId);
    if (!p) this.attaching.set(targetId, p = this.attachNow(targetId, url, title).finally(() => this.attaching.delete(targetId)));
    return p;
  }

  private async attachNow(targetId: string, url: string, title: string): Promise<Tab | undefined> {
    if (this.byTarget.has(targetId)) return this.tabs.get(this.byTarget.get(targetId)!);
    const list: any[] = await this.http("/json/list").then(r => r.json());
    const entry = list.find(t => t.id === targetId);
    if (!entry?.webSocketDebuggerUrl) return undefined;
    const cdp = await Cdp.connect(entry.webSocketDebuggerUrl);
    const tab: Tab = { id: this.nextId++, targetId, cdp, title: title || entry.title || "", url: url || entry.url || "", w: 1280, h: 800, dpr: 1,
      streaming: false, lastFrame: 0, cursorAt: 0 };
    this.tabs.set(tab.id, tab); this.byTarget.set(targetId, tab.id);
    cdp.onClose = () => this.dropTab(tab);
    await cdp.send("Page.enable"); await cdp.send("Runtime.enable");
    if (this.ua) await cdp.send("Emulation.setUserAgentOverride", { userAgent: this.ua, acceptLanguage: "de-DE,de;q=0.9,en;q=0.8" }).catch(() => {});
    await this.applyViewport(tab);
    cdp.on("Page.screencastFrame", p => this.screencastFrame(tab, p));
    cdp.on("Page.javascriptDialogOpening", p => {
      this.onNotice?.(`Die Seite zeigt: ${String(p.message ?? "").slice(0, 160)}`);
      void cdp.send("Page.handleJavaScriptDialog", { accept: p.type === "alert" || p.type === "beforeunload" }).catch(() => {});
    });
    cdp.on("Page.frameNavigated", p => { if (!p.frame?.parentId) { tab.url = p.frame.url; this.onTabs?.(); } });
    this.onTabs?.();
    return tab;
  }

  private dropTab(tab: Tab, notify = true) {
    clearInterval(tab.frameTimer);
    this.tabs.delete(tab.id); this.byTarget.delete(tab.targetId);
    try { tab.cdp.close(); } catch {}
    if (notify) { this.onClosed?.(tab.id); this.onTabs?.(); }
  }

  list() {
    return [...this.tabs.values()].map(t => ({ tab: t.id, title: t.title, url: t.url, favicon: "", active: t.streaming, group: "Jarvis", internal: true }));
  }

  private tab(id: unknown): Tab { const t = this.tabs.get(Number(id)); if (!t) throw new Error(`Unbekannter Tab ${id}`); return t; }

  // ---------- Größe und Live-Bild ----------
  private async applyViewport(tab: Tab) {
    await tab.cdp.send("Emulation.setDeviceMetricsOverride", { width: tab.w, height: tab.h, deviceScaleFactor: tab.dpr, mobile: false, screenWidth: tab.w, screenHeight: tab.h });
  }

  /** Viewport an das Vorschaufenster anpassen (CSS-Pixel und Pixeldichte): scharf und ohne Ränder */
  async resize(id: number, w: number, h: number, dpr: number) {
    const tab = this.tab(id);
    w = Math.max(240, Math.min(3840, Math.round(w))); h = Math.max(160, Math.min(2400, Math.round(h))); dpr = Math.max(1, Math.min(3, Math.round(dpr * 4) / 4));
    if (w === tab.w && h === tab.h && dpr === tab.dpr) return;
    tab.w = w; tab.h = h; tab.dpr = dpr;
    await this.applyViewport(tab);
    if (tab.streaming) { await this.startCast(tab); }
  }

  private async startCast(tab: Tab) {
    // Pixelbudget: sehr große Vorschaufenster mit doppelter Dichte erzeugen sonst Bilder, die weder Chrome noch der Browser flüssig schaffen
    const scale = Math.min(1, Math.sqrt(MAX_PIXELS / (tab.w * tab.dpr * tab.h * tab.dpr)));
    await tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: QUALITY, maxWidth: Math.round(tab.w * tab.dpr * scale), maxHeight: Math.round(tab.h * tab.dpr * scale), everyNthFrame: 1 });
    // Stehende Seiten liefern keine Bilder: nach Start/Größenänderung ein Einzelbild nachreichen
    setTimeout(() => void this.snapshot(tab), 120);
  }

  private async snapshot(tab: Tab) {
    if (!tab.streaming || Date.now() - tab.lastFrame < 400) return;
    const shot = await tab.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: QUALITY, fromSurface: true }).catch(() => undefined);
    if (shot?.data && tab.streaming) this.emitFrame(tab, shot.data);
  }

  private screencastFrame(tab: Tab, p: any) {
    void tab.cdp.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
    if (!tab.streaming || Date.now() - tab.lastFrame < SCREENCAST_MIN_MS) return;
    this.emitFrame(tab, p.data);
  }

  private emitFrame(tab: Tab, data: string) {
    tab.lastFrame = Date.now();
    const recent = tab.cursor && Date.now() - tab.cursorAt < 4000;
    this.onFrame?.({ type: "frame", tab: tab.id, data, w: tab.w, h: tab.h, dpr: tab.dpr, url: tab.url, title: tab.title, internal: true,
      ...(recent ? { cursor: tab.cursor, bounds: [0, 0, tab.w, tab.h] } : {}) });
  }

  async streamStart(id: number) {
    const tab = this.tab(id);
    tab.streaming = true;
    await tab.cdp.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
    await this.root?.send("Target.activateTarget", { targetId: tab.targetId }).catch(() => {});
    await this.startCast(tab);
    clearInterval(tab.frameTimer);
    tab.frameTimer = setInterval(() => void this.snapshot(tab), 1500); // Rückfall für Seiten, die sich nicht neu zeichnen
  }

  async streamStop(id: number) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    tab.streaming = false; clearInterval(tab.frameTimer);
    await tab.cdp.send("Page.stopScreencast").catch(() => {});
  }

  // ---------- Befehle (gleiche Namen wie bei der Chrome-Erweiterung) ----------
  async call(cmd: Record<string, any>): Promise<Reply> {
    const startError = await this.ensure();
    if (startError) return { ok: false, error: startError };
    try { return { ok: true, ...(await this.run(cmd)) }; }
    catch (error) { return { ok: false, error: String((error as Error)?.message ?? error) }; }
  }

  private async eval<T = any>(tab: Tab, fn: string, ...args: unknown[]): Promise<T> {
    const r = await tab.cdp.send("Runtime.evaluate", { expression: `(${fn})(${args.map(a => JSON.stringify(a ?? null)).join(",")})`, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? "Fehler in der Seite");
    return r.result?.value as T;
  }

  private async waitLoaded(tab: Tab, ms = 20_000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const ready = await this.eval<string>(tab, "() => document.readyState").catch(() => "loading");
      if (ready === "complete") return;
      await Bun.sleep(150);
    }
  }

  private async mouse(tab: Tab, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
    await tab.cdp.send("Input.dispatchMouseEvent", { type, x, y, ...extra });
  }

  private async run(cmd: Record<string, any>): Promise<Record<string, any>> {
    switch (cmd.cmd) {
      case "tab_list": return { tabs: this.list() };
      case "tab_open": {
        const url = urlFor(cmd.url ?? "about:blank");
        if (url === "about:blank") this.expectBlank++;
        let info: any;
        try { info = await (await this.http(`/json/new?${encodeURIComponent(url)}`, "PUT")).json(); }
        finally { if (url === "about:blank") setTimeout(() => this.expectBlank--, 1500); }
        const tab = await this.attach(info.id, info.url, info.title);
        if (!tab) throw new Error("Tab konnte nicht geöffnet werden");
        if (url !== "about:blank") await this.waitLoaded(tab, 12_000);
        return { tab: tab.id, url: tab.url, title: tab.title };
      }
      case "tab_close": {
        const tab = this.tab(cmd.tab);
        await this.http(`/json/close/${tab.targetId}`).catch(() => {});
        this.dropTab(tab);
        return {};
      }
      case "stream_start": await this.streamStart(Number(cmd.tab)); return {};
      case "stream_stop": await this.streamStop(Number(cmd.tab)); return {};
      case "resize": await this.resize(Number(cmd.tab), Number(cmd.w), Number(cmd.h), Number(cmd.dpr) || 1); return {};
      case "navigate": {
        const tab = this.tab(cmd.tab);
        const r = await tab.cdp.send("Page.navigate", { url: urlFor(cmd.url) });
        if (r.errorText) throw new Error(`Seite lädt nicht: ${r.errorText}`);
        await this.waitLoaded(tab);
        return { url: tab.url, title: await this.eval<string>(tab, "() => document.title").catch(() => tab.title) };
      }
      case "back": case "forward": {
        const tab = this.tab(cmd.tab);
        const h = await tab.cdp.send("Page.getNavigationHistory");
        const entry = h.entries[h.currentIndex + (cmd.cmd === "back" ? -1 : 1)];
        if (!entry) throw new Error(cmd.cmd === "back" ? "Keine frühere Seite" : "Keine spätere Seite");
        await tab.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await this.waitLoaded(tab);
        return { url: entry.url };
      }
      case "reload": { const tab = this.tab(cmd.tab); await tab.cdp.send("Page.reload"); await this.waitLoaded(tab); return {}; }
      case "wait": {
        const tab = this.tab(cmd.tab);
        if (typeof cmd.for === "string" && cmd.for) {
          const end = Date.now() + Math.min(30_000, Number(cmd.ms) || 10_000);
          while (Date.now() < end) {
            const found = await this.eval<boolean>(tab, "(t) => (document.body?.innerText || '').includes(t)", cmd.for).catch(() => false);
            if (found) return { found: true };
            await Bun.sleep(250);
          }
          return { found: false };
        }
        await Bun.sleep(Math.min(30_000, Math.max(0, Number(cmd.ms) || 1000)));
        return {};
      }
      case "scan": {
        const tab = this.tab(cmd.tab);
        await this.waitLoaded(tab, 8000);
        const r = await this.eval<any>(tab, SCAN, cmd.all === true);
        const out: Record<string, any> = { targets: r.targets, total: r.total, url: r.url, title: r.title };
        if (cmd.text) {
          out.text = [`${r.url} – „${r.title}“`, `${r.targets.length} von ${r.total} Elementen${r.scrollMax > 0 ? ` · gescrollt ${r.scrollY}/${r.scrollMax} px` : ""}`,
            ...r.targets.map((t: any) => `${t.id} ${t.axRole.slice(2)} „${t.label}“ @${Math.round(t.rect[0] + t.rect[2] / 2)},${Math.round(t.rect[1] + t.rect[3] / 2)}${t.enabled ? "" : " (aus)"}`)].join("\n");
        }
        return out;
      }
      case "click": {
        const tab = this.tab(cmd.tab);
        const p = await this.eval<any>(tab, PREPARE, Number(cmd.id));
        if (p.error) throw new Error(p.error);
        if (p.tag === "SELECT") throw new Error("Auswahlliste: mit browser_type den Eintrag wählen (Text des Eintrags)");
        tab.cursor = [p.x, p.y]; tab.cursorAt = Date.now();
        await this.mouse(tab, "mouseMoved", p.x, p.y);
        await this.mouse(tab, "mousePressed", p.x, p.y, { button: "left", buttons: 1, clickCount: 1 });
        await this.mouse(tab, "mouseReleased", p.x, p.y, { button: "left", clickCount: 1 });
        await Bun.sleep(150);
        return { via: "cdp", x: p.x, y: p.y };
      }
      case "type": {
        const tab = this.tab(cmd.tab);
        const text = String(cmd.text ?? "");
        const f = await this.eval<any>(tab, FOCUS_FOR_TYPING, Number(cmd.id));
        if (f.error) throw new Error(f.error);
        if (f.select) { const c = await this.eval<any>(tab, CHOOSE_OPTION, Number(cmd.id), text); if (c.error) throw new Error(c.error); return { chose: c.value }; }
        if (text) await tab.cdp.send("Input.insertText", { text });
        if (cmd.submit) {
          for (const type of ["keyDown", "keyUp"]) await tab.cdp.send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: type === "keyDown" ? "\r" : undefined });
          await Bun.sleep(300);
        }
        return {};
      }
      case "scroll": {
        const tab = this.tab(cmd.tab);
        let x = Math.round(tab.w / 2), y = Math.round(tab.h / 2);
        if (cmd.id != null) { const p = await this.eval<any>(tab, PREPARE, Number(cmd.id)); if (p.error) throw new Error(p.error); x = p.x; y = p.y; }
        await this.mouse(tab, "mouseWheel", x, y, { deltaX: 0, deltaY: (Number(cmd.dy) || 0) * 100 });
        await Bun.sleep(200);
        return {};
      }
      case "read": {
        const tab = this.tab(cmd.tab);
        const r = await this.eval<any>(tab, READ, cmd.id ?? null, Array.isArray(cmd.rect) ? cmd.rect : null, Math.min(60_000, Number(cmd.limit) || 20_000));
        if (r.error) throw new Error(r.error);
        return { text: r.text, via: "dom" };
      }
      case "shot": {
        const tab = this.tab(cmd.tab);
        const ids = cmd.marks ? await this.eval<number[]>(tab, "() => [...(window.__jv?.map.keys() ?? [])]") : null;
        if (ids) await this.eval(tab, MARKS, ids);
        try {
          const clip = Array.isArray(cmd.rect) ? { x: cmd.rect[0], y: cmd.rect[1], width: cmd.rect[2], height: cmd.rect[3], scale: 1 } : undefined;
          const r = await tab.cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true, ...(clip ? { clip } : {}) });
          return { dataUrl: "data:image/png;base64," + r.data, rect: clip ? cmd.rect : [0, 0, tab.w, tab.h] };
        } finally { if (ids) await this.eval(tab, MARKS, null).catch(() => {}); }
      }
      case "input": { // Maus, Tastatur und Einfügen aus der Vorschau
        const tab = this.tab(cmd.tab);
        const e = cmd.event ?? {};
        if (e.kind === "mouse") {
          const x = Number(e.x), y = Number(e.y);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"].includes(e.type)) throw new Error("Ungültiges Mausereignis");
          await this.mouse(tab, e.type, x, y, { button: e.button ?? "none", buttons: e.buttons ?? 0, clickCount: e.clickCount ?? 0, modifiers: e.modifiers ?? 0,
            ...(e.type === "mouseWheel" ? { deltaX: Number(e.deltaX) || 0, deltaY: Number(e.deltaY) || 0 } : {}) });
        } else if (e.kind === "key") {
          if (!["keyDown", "keyUp", "rawKeyDown", "char"].includes(e.type)) throw new Error("Ungültiges Tastenereignis");
          await tab.cdp.send("Input.dispatchKeyEvent", { type: e.type, key: e.key, code: e.code, text: e.text, unmodifiedText: e.text, modifiers: e.modifiers ?? 0,
            windowsVirtualKeyCode: e.vk, nativeVirtualKeyCode: e.vk, ...(Array.isArray(e.commands) ? { commands: e.commands.map(String) } : {}) });
        } else if (e.kind === "text") {
          await tab.cdp.send("Input.insertText", { text: String(e.text ?? "").slice(0, 100_000) });
        } else throw new Error("Unbekanntes Eingabeereignis");
        return {};
      }
      case "copy": return { text: await this.eval<string>(this.tab(cmd.tab), "() => getSelection()?.toString() || (document.activeElement && 'value' in document.activeElement ? document.activeElement.value.substring(document.activeElement.selectionStart, document.activeElement.selectionEnd) : '')") };
      default: throw new Error(`Unbekannter Befehl ${cmd.cmd}`);
    }
  }

  stop() {
    for (const t of this.tabs.values()) { clearInterval(t.frameTimer); try { t.cdp.close(); } catch {} }
    this.tabs.clear(); this.byTarget.clear();
    try { this.root?.close(); } catch {}
    this.root = undefined;
    try { this.proc?.kill(); } catch {}
    this.proc = undefined;
  }
}
