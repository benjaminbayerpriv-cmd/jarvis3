// Browser-Brücke: die Jarvis-Chrome-Erweiterung verbindet sich per WebSocket (docs/protocol.md).
import type { ServerWebSocket } from "bun";

type Reply = Record<string, unknown> & { ok: boolean };

export class Browser {
  private socket?: ServerWebSocket<unknown>;
  private pending = new Map<number, (r: Reply) => void>();
  private rid = 0;
  version?: string;
  onEvent?: (m: Record<string, any>) => void;
  onHello?: (version: string) => void;  // Live-Bilder und Stream-Ende der Erweiterung

  get connected() { return !!this.socket; }

  attach(ws: ServerWebSocket<unknown>) { this.socket = ws; }

  detach(ws: ServerWebSocket<unknown>) {
    if (this.socket !== ws) return;
    this.socket = undefined;
    for (const [, resolve] of this.pending) resolve({ ok: false, error: "Erweiterung getrennt" });
    this.pending.clear();
  }

  receive(raw: string) {
    const msg = JSON.parse(raw);
    if (msg.hello) { this.version = msg.version; this.onHello?.(String(msg.version)); return; }
    if (msg.type === "frame" || msg.type === "stream_ended") { this.onEvent?.(msg); return; }
    const id = msg.rid as number;
    this.pending.get(id)?.(msg); this.pending.delete(id);
  }

  call(cmd: Record<string, unknown>, timeoutMs = 30000): Promise<Reply> {
    if (!this.socket) return Promise.resolve({ ok: false, error: "Chrome-Erweiterung nicht verbunden" });
    const rid = ++this.rid;
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(rid); resolve({ ok: false, error: "Zeitüberschreitung" }); }, timeoutMs);
      this.pending.set(rid, r => { clearTimeout(timer); resolve(r); });
      this.socket!.send(JSON.stringify({ ...cmd, rid }));
    });
  }
}
