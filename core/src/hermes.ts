// Hermes Runs API. Dieser Adapter ist noch nicht mit dem Daemon verdrahtet.
import type { BrainEvent } from "./opencode";

export type HermesConfig = { url: string; apiKey: string; provider?: string; model?: string };

// Nur explizite Loopback-Adressen: kein Redirect oder DNS-Rebinding für den API-Schlüssel.
export function hermesUrl(value: string): string {
  const u = new URL(value);
  if (u.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(u.hostname) || u.username || u.password || u.search || u.hash)
    throw new Error("Hermes-Adresse muss eine lokale HTTP-Loopback-Adresse sein");
  return u.toString().replace(/\/$/, "");
}

type Active = { runId?: string; stopRequested: boolean; controller: AbortController; finished: Promise<void>; finish: () => void };

export class Hermes {
  private active = new Map<string, Active>();
  constructor(private config: HermesConfig) { hermesUrl(config.url); }

  private async request(path: string, init: RequestInit = {}) {
    const r = await fetch(hermesUrl(this.config.url) + path, {
      ...init, redirect: "error", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...init.headers },
    });
    // Fehlermeldungen und Antwort-Bodies können Geheimnisse enthalten.
    if (!r.ok) throw new Error(`Hermes-Anfrage fehlgeschlagen (HTTP ${r.status})`);
    return r;
  }

  async abort(session: string) {
    const run = this.active.get(session);
    if (!run) return;
    run.stopRequested = true;
    if (run.runId) await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST" });
    await run.finished;
  }

  async prompt(session: string, input: string, instructions: string, onEvent: (event: BrainEvent) => void) {
    if (this.active.has(session)) throw new Error("Für diese Hermes-Sitzung läuft bereits eine Anfrage");
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const run: Active = { stopRequested: false, controller: new AbortController(), finished, finish };
    this.active.set(session, run);
    let terminal = false;
    try {
      const response = await this.request("/v1/runs", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ input, session_id: session, instructions, ...(this.config.provider ? { provider: this.config.provider } : {}), ...(this.config.model ? { model: this.config.model } : {}) }) });
      const result = await response.json() as { run_id?: unknown };
      if (typeof result.run_id !== "string" || !result.run_id) throw new Error("Hermes lieferte keine Lauf-ID");
      run.runId = result.run_id;
      if (run.stopRequested) await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST" });
      const stream = await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/events`, { signal: run.controller.signal });
      if (!stream.body) throw new Error("Hermes lieferte keinen Ereignisstrom");
      const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "", text = "";
      const ids = new Map<string, string[]>();
      const dispatch = (data: string) => {
        const event = JSON.parse(data);
        if (event.event === "message.delta" && typeof event.delta === "string") { text += event.delta; onEvent({ kind: "text", delta: event.delta }); }
        if (event.event === "tool.started") {
          const name = String(event.tool ?? "Werkzeug"), id = String(event.tool_call_id || crypto.randomUUID());
          ids.set(name, [...(ids.get(name) ?? []), id]);
          onEvent({ kind: "tool", id, name, status: "running" });
        }
        if (event.event === "tool.completed") {
          const name = String(event.tool ?? "Werkzeug"), queue = ids.get(name) ?? [];
          const id = String(event.tool_call_id || queue.shift() || crypto.randomUUID());
          ids.set(name, queue.filter(x => x !== id));
          onEvent({ kind: "tool", id, name, status: event.error ? "error" : "completed", ...(event.error ? { error: "Hermes-Werkzeug fehlgeschlagen" } : {}) });
        }
        if (event.event === "run.completed") {
          if (!text && typeof event.output === "string" && event.output) onEvent({ kind: "text", delta: event.output });
          terminal = true; onEvent({ kind: "done" });
        } else if (event.event === "run.cancelled") { terminal = true; onEvent({ kind: "done", aborted: true }); }
        else if (["run.failed", "run.interrupted"].includes(event.event)) { terminal = true; onEvent({ kind: "error", message: "Hermes-Lauf fehlgeschlagen oder unterbrochen" }); }
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + chunk.value).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          if (data) dispatch(data);
          if (terminal) { await reader.cancel(); break; }
        }
        if (terminal) break;
      }
      if (!terminal) throw new Error("Hermes-Ereignisstrom ohne Laufende beendet");
    } catch (error) {
      onEvent({ kind: "error", message: error instanceof Error ? error.message : "Hermes-Anfrage fehlgeschlagen" });
    } finally {
      this.active.delete(session); run.finish();
    }
  }
}
