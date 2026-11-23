// Minimaler Chrome-DevTools-Protocol-Client (JSON über WebSocket), ohne Abhängigkeiten.
type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export class Cdp {
  private id = 0;
  private pending = new Map<number, Pending>();
  private handlers = new Map<string, Set<(params: any) => void>>();
  closed = false;
  onClose?: () => void;

  private constructor(private ws: WebSocket) {
    ws.onmessage = ev => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id); clearTimeout(p.timer);
        if (m.error) p.reject(new Error(`${m.error.message ?? "CDP-Fehler"}`)); else p.resolve(m.result ?? {});
      } else if (m.method) for (const fn of this.handlers.get(m.method) ?? []) { try { fn(m.params ?? {}); } catch { /* Handler dürfen die Verbindung nicht stören */ } }
    };
    ws.onclose = () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("Browser-Verbindung beendet")); }
      this.pending.clear();
      this.onClose?.();
    };
  }

  static connect(url: string, timeoutMs = 8000): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("Verbindung zum Browser: Zeitüberschreitung")); }, timeoutMs);
      ws.onopen = () => { clearTimeout(timer); resolve(new Cdp(ws)); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error("Verbindung zum Browser fehlgeschlagen")); };
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15000): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser-Verbindung beendet"));
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}: Zeitüberschreitung`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error as Error); }
    });
  }

  on(event: string, fn: (params: any) => void) {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, set = new Set());
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** Wartet einmalig auf ein Ereignis (oder gibt nach timeoutMs auf: false). */
  once(event: string, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const off = this.on(event, () => { off(); clearTimeout(timer); resolve(true); });
      const timer = setTimeout(() => { off(); resolve(false); }, timeoutMs);
    });
  }

  close() { this.closed = true; try { this.ws.close(); } catch {} }
}
