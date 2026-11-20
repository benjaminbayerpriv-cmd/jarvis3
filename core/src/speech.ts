// Verbindung zum Sprach-Sidecar (docs/speech.md): jarvisd ist Client von ws://127.0.0.1:7778.
export type SpeechEvent = { type: string; [k: string]: unknown };

export class Speech {
  private ws?: WebSocket;
  private queue: string[] = [];
  connected = false;
  private sayId = 0;

  constructor(private onEvent: (e: SpeechEvent) => void, private url = "ws://127.0.0.1:7778") {
    this.connect();
  }

  private connect() {
    const ws = new WebSocket(this.url);
    ws.onopen = () => { this.connected = true; this.ws = ws; for (const m of this.queue.splice(0)) ws.send(m); this.onEvent({ type: "connected" }); };
    ws.onmessage = ev => this.onEvent(JSON.parse(String(ev.data)));
    ws.onclose = () => {
      if (this.connected) this.onEvent({ type: "disconnected" });
      this.connected = false; this.ws = undefined;
      setTimeout(() => this.connect(), 2000);
    };
    ws.onerror = () => {};
  }

  send(msg: Record<string, unknown>) {
    const s = JSON.stringify(msg);
    if (this.ws && this.connected) this.ws.send(s);
    else if (msg.type === "mode" || msg.type === "config") this.queue.push(s);
  }

  mode(value: "off" | "ptt" | "live" | "dictate" | "muted") {
    // Diktat und Stummschalten sind aus Sidecar-Sicht live bzw. aus; jarvisd unterscheidet selbst.
    this.send({ type: "mode", value: value === "dictate" ? "live" : value === "muted" ? "off" : value });
  }
  say(text: string) { if (text.trim()) this.send({ type: "say", id: ++this.sayId, text }); }
  stopSpeaking() { this.send({ type: "stop_speaking" }); }
}

/** Zerlegt einen Token-Stream in sprechbare Sätze, sobald sie fertig sind. */
export class SentenceSplitter {
  private buf = "";
  private inCode = false;
  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (;;) {
      if (this.buf.includes("```")) {
        // Codeblöcke werden nicht vorgelesen
        const i = this.buf.indexOf("```");
        const before = this.buf.slice(0, i);
        if (!this.inCode) out.push(...this.cut(before, true));
        this.inCode = !this.inCode;
        this.buf = this.buf.slice(i + 3);
        continue;
      }
      if (this.inCode) { this.buf = this.buf.slice(-2); break; }
      // Nur an Satzenden teilen (nicht an : oder ;): jedes Stück wird einzeln gesprochen und bekäme sonst neue Betonung
      const m = this.buf.match(/^([\s\S]*?[.!?…](?=\s)|[\s\S]*?\n\n)/);
      if (!m || m[1].length < 2) break;
      out.push(m[1]);
      this.buf = this.buf.slice(m[1].length);
    }
    return out.map(clean).filter(Boolean);
  }
  /** Gibt den Puffer frei, wenn er mit einem Satzzeichen endet (Strom pausiert, z. B. vor einem Werkzeugaufruf). */
  flushIfSentence(): string[] {
    if (this.inCode || !/[.!?…]["')\]]?\s*$/.test(this.buf)) return [];
    return this.flush();
  }
  flush(): string[] { const rest = this.inCode ? "" : this.buf; this.buf = ""; this.inCode = false; return [clean(rest)].filter(Boolean); }
  private cut(s: string, all: boolean) { return all ? [s] : []; }
}

export function clean(s: string) {
  return s
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_#>~|]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}
