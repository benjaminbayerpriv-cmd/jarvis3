// Direkter Browser, Teil 2: Brücke zwischen jarvisd und den Seiten, die die Oberfläche im Rahmen zeigt.
// Die Tabs gehören der Oberfläche (Rahmen im Vorschaufenster); jede Seite verbindet sich über ihren Agenten (proxy-agent.ts) mit /page
// und führt Jarvis' Befehle (scan, click, type, read …) direkt im DOM aus. Tab-Nummern: 300 001–399 999.
import type { ServerWebSocket } from "bun";
import { urlFor } from "./ibrowser";

export const DIRECT_FIRST = 300_000;
export const DIRECT_LAST = 399_999;
type Reply = Record<string, any> & { ok: boolean };
export type PageSocket = ServerWebSocket<{ kind: "page" }>;
interface Tab { id: number; url: string; title: string; ws?: PageSocket }

export class DirectBrowser {
  private tabs = new Map<number, Tab>();
  private pending = new Map<number, { resolve: (r: Reply) => void; tab: number }>();
  private waiting = new Map<number, Set<(ok?: boolean) => void>>();
  private rid = 0;
  private next = DIRECT_FIRST + 1;
  /** Oberflächen anweisen (dt_open, dt_close, dt_nav) */
  tell: (message: Record<string, unknown>) => void = () => {};
  onTabs?: () => void;

  owns(id: unknown): boolean { return Number.isInteger(id) && (id as number) > DIRECT_FIRST && (id as number) <= DIRECT_LAST; }
  allocate(): number { return this.next++; }

  /** Die Oberfläche meldet ihre Tabs (Titel und Adresse) */
  setTabs(list: { id: number; url: string; title: string }[]) {
    const keep = new Set(list.map(t => t.id));
    for (const t of list) {
      const known = this.tabs.get(t.id);
      if (known) { known.url = t.url; known.title = t.title; } else this.tabs.set(t.id, { id: t.id, url: t.url, title: t.title });
      this.next = Math.max(this.next, t.id + 1);
    }
    for (const id of [...this.tabs.keys()]) if (!keep.has(id)) this.tabs.delete(id);
    this.onTabs?.();
  }

  list() {
    return [...this.tabs.values()].map(t => ({ tab: t.id, title: t.title, url: t.url, favicon: "", active: !!t.ws, group: "Jarvis", direct: true }));
  }
  get count() { return this.tabs.size; }

  // ----- Seiten-Verbindungen -----
  attach(ws: PageSocket, hello: { tab: number; url?: string; title?: string }) {
    if (!this.owns(hello.tab)) return;
    const tab = this.tabs.get(hello.tab) ?? { id: hello.tab, url: "", title: "" };
    tab.ws = ws; tab.url = hello.url ?? tab.url; tab.title = hello.title ?? tab.title;
    this.tabs.set(tab.id, tab);
    (ws as any).tabId = tab.id;
    for (const fn of this.waiting.get(tab.id) ?? []) fn(true);
    this.waiting.delete(tab.id);
    this.onTabs?.();
  }

  detach(ws: PageSocket) {
    const id = (ws as any).tabId as number | undefined;
    if (id === undefined) return;
    const tab = this.tabs.get(id);
    if (tab?.ws === ws) tab.ws = undefined;
    for (const [rid, p] of this.pending) if (p.tab === id) { this.pending.delete(rid); p.resolve({ ok: false, error: "Seite wurde verlassen oder neu geladen" }); }
  }

  receive(ws: PageSocket, raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.hello) return this.attach(ws, m);
    const p = this.pending.get(m.rid);
    if (p) { this.pending.delete(m.rid); p.resolve(m); }
  }

  /** Die Seite lässt den direkten Browser nicht zu: wartende open()-Aufrufe sofort beenden (Ausweichen auf den Video-Browser) */
  blocked(id: number) {
    this.tabs.delete(id);
    const set = this.waiting.get(id); this.waiting.delete(id);
    for (const fn of set ?? []) fn(false);
  }

  private waitFor(id: number, ms: number): Promise<boolean> {
    if (this.tabs.get(id)?.ws) return Promise.resolve(true);
    return new Promise(resolve => {
      const done = (ok = true) => { clearTimeout(timer); resolve(ok); };
      const timer = setTimeout(() => { this.waiting.get(id)?.delete(done); resolve(false); }, ms);
      let set = this.waiting.get(id);
      if (!set) this.waiting.set(id, set = new Set());
      set.add(done);
    });
  }

  /** Öffnet einen Tab in der Oberfläche und wartet, bis die Seite sich gemeldet hat. */
  async open(url: string, uiCount: number, timeoutMs = 20_000): Promise<Reply> {
    if (uiCount === 0) return { ok: false, error: "Keine Oberfläche geöffnet" };
    const id = this.allocate();
    this.tabs.set(id, { id, url, title: "" });
    this.tell({ type: "dt_open", id, url });
    if (!await this.waitFor(id, timeoutMs)) return { ok: false, error: "Die Seite hat sich im direkten Browser nicht gemeldet (blockiert sie das Einbetten?)", tab: id };
    const tab = this.tabs.get(id)!;
    return { ok: true, tab: id, url: tab.url, title: tab.title };
  }

  async call(cmd: Record<string, any>): Promise<Reply> {
    const id = Number(cmd.tab);
    const tab = this.tabs.get(id);
    if (!tab) return { ok: false, error: `Unbekannter Tab ${id}` };
    switch (cmd.cmd) {
      case "tab_close": this.tell({ type: "dt_close", id }); this.tabs.delete(id); this.onTabs?.(); return { ok: true };
      case "tab_list": return { ok: true, tabs: this.list() };
      case "navigate": {
        const before = tab.ws;
        this.tell({ type: "dt_nav", id, url: urlFor(String(cmd.url ?? "")) });
        for (let i = 0; i < 80 && (this.tabs.get(id)?.ws === before || !this.tabs.get(id)?.ws); i++) await Bun.sleep(250); // neue Seite meldet sich
        const t = this.tabs.get(id);
        return t?.ws ? { ok: true, url: t.url, title: t.title } : { ok: false, error: "Seite lädt nicht" };
      }
      case "shot": return { ok: false, error: "Im direkten Browser gibt es keine Screenshots: benutze browser_scan und browser_read." };
    }
    if (!await this.waitFor(id, 15_000)) return { ok: false, error: "Die Seite ist nicht bereit" };
    const ws = this.tabs.get(id)?.ws;
    if (!ws) return { ok: false, error: "Die Seite ist nicht bereit" };
    const rid = ++this.rid;
    return new Promise<Reply>(resolve => {
      const timer = setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, error: "Zeitüberschreitung" }); }, 30_000);
      this.pending.set(rid, { tab: id, resolve: r => { clearTimeout(timer); resolve(r); } });
      ws.send(JSON.stringify({ ...cmd, rid }));
    });
  }
}
