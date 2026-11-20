// OpenCode als Gehirn: Modellliste, headless Server, Sitzungen und Token-Stream.
import { join } from "node:path";

export type ModelGroup = "free" | "lmstudio" | "nvidia" | "other";
export interface ModelInfo { id: string; provider: string; model: string; group: ModelGroup; vision: boolean }

export function parseModels(stdout: string): ModelInfo[] {
  return stdout.split("\n").map(l => l.trim()).filter(l => /^[\w.-]+\/\S+$/.test(l)).map(id => {
    const [provider, ...rest] = id.split("/");
    const group: ModelGroup = provider === "opencode" ? "free"
      : provider === "lmstudio" ? "lmstudio" : provider === "nvidia" ? "nvidia" : "other";
    return { id, provider, model: rest.join("/"), group, vision: /(-vl\b|-vl-|vision|gemma-4|paligemma|omni)/.test(id) };
  });
}

export async function listModels(): Promise<ModelInfo[]> {
  const p = Bun.spawn(["opencode", "models"], { stdout: "pipe", stderr: "ignore" });
  return parseModels(await new Response(p.stdout).text());
}

/** Ein Ereignis aus Jarvis-Sicht – Denk-Text wird getrennt gemeldet, nie gesprochen. */
export type BrainEvent =
  | { kind: "text"; delta: string }
  | { kind: "reasoning"; delta: string }
  | { kind: "tool"; name: string; status: string; title?: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export class OpenCode {
  url: string;
  private proc?: ReturnType<typeof Bun.spawn>;
  private partKinds = new Map<string, string>();
  private listeners = new Map<string, (e: BrainEvent) => void>();

  constructor(public port = 4096, public workspace = join(import.meta.dir, "../../workspace")) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start() {
    if (await this.healthy()) return; // läuft schon (z. B. nach Daemon-Neustart)
    this.proc = Bun.spawn(["opencode", "serve", "--port", String(this.port), "--hostname", "127.0.0.1"],
      { cwd: this.workspace, stdout: "ignore", stderr: "inherit", env: { ...process.env } });
    for (let i = 0; i < 60 && !(await this.healthy()); i++) await Bun.sleep(250);
    if (!(await this.healthy())) throw new Error("opencode serve startet nicht");
    this.listen();
  }

  stop() { this.proc?.kill(); }

  async healthy() {
    try { return (await fetch(`${this.url}/global/health`)).ok; } catch { return false; }
  }

  async createSession(title = "Jarvis"): Promise<string> {
    const r = await fetch(`${this.url}/session`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }) });
    return (await r.json()).id;
  }

  /** Startet einen Prompt; Ereignisse kommen über onEvent, bis "done". */
  async prompt(session: string, text: string, model: string, system: string, onEvent: (e: BrainEvent) => void,
               images: { mime: string; url: string }[] = []) {
    const [providerID, ...rest] = model.split("/");
    this.listeners.set(session, onEvent);
    const parts: unknown[] = [{ type: "text", text }];
    for (const img of images) parts.push({ type: "file", mime: img.mime, url: img.url });
    const r = await fetch(`${this.url}/session/${session}/prompt_async`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID, modelID: rest.join("/") }, system, parts }),
    });
    if (!r.ok) { this.listeners.delete(session); onEvent({ kind: "error", message: `${r.status} ${await r.text()}` }); }
  }

  async abort(session: string) {
    await fetch(`${this.url}/session/${session}/abort`, { method: "POST" }).catch(() => {});
    this.listeners.get(session)?.({ kind: "done" });
    this.listeners.delete(session);
  }

  private async listen() {
    for (;;) {
      try {
        const r = await fetch(`${this.url}/event`);
        const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.startsWith("data:")) this.dispatch(JSON.parse(line.slice(5)));
          }
        }
      } catch { /* Server weg – kurz warten, neu verbinden */ }
      await Bun.sleep(500);
    }
  }

  private dispatch(e: any) {
    const p = e.properties ?? {};
    const cb = this.listeners.get(p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID);
    if (!cb) return;
    switch (e.type) {
      case "message.part.updated": {
        const part = p.part;
        this.partKinds.set(part.id, part.type);
        if (part.type === "tool") cb({ kind: "tool", name: part.tool, status: part.state?.status, title: part.state?.title });
        break;
      }
      case "message.part.delta": {
        const kind = this.partKinds.get(p.partID);
        if (p.field !== "text") break;
        if (kind === "text") cb({ kind: "text", delta: p.delta });
        else if (kind === "reasoning") cb({ kind: "reasoning", delta: p.delta });
        break;
      }
      case "session.error":
        cb({ kind: "error", message: p.error?.data?.message ?? p.error?.name ?? "Fehler" });
        break;
      case "session.idle":
        cb({ kind: "done" });
        this.listeners.delete(p.sessionID);
        break;
    }
  }
}
