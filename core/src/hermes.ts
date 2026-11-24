// Hermes Runs- und Sitzungs-Streaming-API.
import type { BrainEvent, PromptImage } from "./opencode";
import { baseToolName } from "./hermes-tools";

export type HermesConfig = { url: string; apiKey: string; provider?: string; model?: string };

// Gateway-Adresse und Anbieter-Adresse sind unabhängig. Redirects bleiben gesperrt.
export function hermesUrl(value: string): string {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error("Hermes-Adresse muss eine HTTP(S)-Adresse ohne Zugangsdaten sein");
  return u.toString().replace(/\/$/, "");
}
export function managedGateway(value: string) {
  const u = new URL(hermesUrl(value));
  return u.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) && u.pathname === "/";
}

type Active = { runId?: string; stopRequested: boolean; controller: AbortController; finished: Promise<void>; finish: () => void; stopping?: Promise<void> };

export class Hermes {
  private active = new Map<string, Active>();
  constructor(private config: HermesConfig, private stopWaitMs = 10000) { hermesUrl(config.url); }

  private async request(path: string, init: RequestInit = {}) {
    const r = await fetch(hermesUrl(this.config.url) + path, {
      ...init, redirect: "error", headers: { "content-type": "application/json", ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}), ...init.headers },
    });
    // Fehlermeldungen und Antwort-Bodies können Geheimnisse enthalten.
    if (!r.ok) throw new Error(`Hermes-Anfrage fehlgeschlagen (HTTP ${r.status})`);
    return r;
  }

  async testConnection() {
    const r = await this.request("/v1/capabilities", { signal: AbortSignal.timeout(5000) });
    const data = await r.json() as { features?: Record<string, unknown> };
    if (!data.features?.run_submission || !data.features?.run_events_sse || !data.features?.run_stop) throw new Error("Hermes-Server unterstützt die benötigte Runs-API nicht");
    const sessions = await this.request("/api/sessions?limit=1", { signal: AbortSignal.timeout(5000) });
    const list = await sessions.json() as { data?: unknown };
    if (!Array.isArray(list.data)) throw new Error("Hermes-Sitzungsverwaltung ist nicht bereit");
  }

  /** Hermes-API-Sitzungen sind vom OpenCode-Verlauf getrennt. */
  async createSession(title = "Jarvis"): Promise<string> {
    const r = await this.request("/api/sessions", { method: "POST", signal: AbortSignal.timeout(5000), body: JSON.stringify({ title }) });
    const data = await r.json() as { session?: { id?: unknown } };
    if (typeof data.session?.id !== "string" || !data.session.id) throw new Error("Hermes lieferte keine Sitzungs-ID");
    return data.session.id;
  }
  async messages(session: string): Promise<unknown[]> {
    const messages: unknown[] = [];
    for (let offset = 0; offset <= 10000; offset += 500) {
      const r = await this.request(`/api/sessions/${encodeURIComponent(session)}/messages?limit=500&order=oldest&offset=${offset}`, { signal: AbortSignal.timeout(5000) });
      const data = await r.json() as { data?: unknown };
      if (!Array.isArray(data.data)) throw new Error("Hermes lieferte keinen gültigen Verlauf");
      messages.push(...data.data);
      if (data.data.length < 500) return messages;
    }
    throw new Error("Hermes-Verlauf ist zu groß");
  }
  async renameSession(session: string, title: string) {
    await this.request(`/api/sessions/${encodeURIComponent(session)}`, { method: "PATCH", signal: AbortSignal.timeout(5000), body: JSON.stringify({ title }) });
  }
  async deleteSession(session: string) {
    await this.request(`/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
  }

  private stopRun(run: Active) {
    if (!run.runId) return Promise.resolve();
    return run.stopping ??= this.request(`/v1/runs/${encodeURIComponent(run.runId)}/stop`, { method: "POST", signal: AbortSignal.timeout(5000) }).then(() => {});
  }

  async abort(session: string) {
    const run = this.active.get(session);
    if (!run) return;
    run.stopRequested = true;
    if (run.runId) await this.stopRun(run);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([run.finished, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Hermes hat den Stopp noch nicht bestätigt")), this.stopWaitMs); })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  async prompt(session: string, input: string, instructions: string, onEvent: (event: BrainEvent) => void, images: PromptImage[] = []) {
    if (this.active.has(session)) throw new Error("Für diese Hermes-Sitzung läuft bereits eine Anfrage");
    let finish!: () => void;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const run: Active = { stopRequested: false, controller: new AbortController(), finished, finish };
    this.active.set(session, run);
    let terminal = false;
    try {
      let stream: Response;
      if (images.length) {
        // Die native Sitzungs-API validiert multimodalen Inhalt; Runs verarbeitet
        // Bildteile je Hermes-Version unterschiedlich.
        stream = await this.request(`/api/sessions/${encodeURIComponent(session)}/chat/stream`, { method: "POST", signal: run.controller.signal,
          body: JSON.stringify({ message: [{ type: "text", text: input }, ...images.map(image => ({ type: "image_url", image_url: { url: image.url } }))], instructions,
            ...(this.config.provider ? { provider: this.config.provider } : {}), ...(this.config.model ? { model: this.config.model } : {}) }) });
      } else {
        const response = await this.request("/v1/runs", { method: "POST", signal: AbortSignal.timeout(15000), headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({ input, session_id: session, instructions, ...(this.config.provider ? { provider: this.config.provider } : {}), ...(this.config.model ? { model: this.config.model } : {}) }) });
        const result = await response.json() as { run_id?: unknown };
        if (typeof result.run_id !== "string" || !result.run_id) throw new Error("Hermes lieferte keine Lauf-ID");
        run.runId = result.run_id;
        if (run.stopRequested) await this.stopRun(run);
        stream = await this.request(`/v1/runs/${encodeURIComponent(run.runId)}/events`, { signal: run.controller.signal });
      }
      if (!stream.body) throw new Error("Hermes lieferte keinen Ereignisstrom");
      const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "", text = "", toolsSeen = false;
      const ids = new Map<string, string[]>();
      const dispatch = (data: string, eventName?: string) => {
        const event = JSON.parse(data);
        event.event ??= eventName;
        if (!run.runId && typeof event.run_id === "string") {
          run.runId = event.run_id;
          if (run.stopRequested) void this.stopRun(run).catch(() => {});
        }
        if ((event.event === "message.delta" || event.event === "assistant.delta") && typeof event.delta === "string") { text += event.delta; onEvent({ kind: "text", delta: event.delta }); }
        if (event.event === "assistant.completed" && !text && typeof event.content === "string" && event.content) { text += event.content; onEvent({ kind: "text", delta: event.content }); }
        if (event.event === "tool.started") {
          toolsSeen = true;
          const name = baseToolName(String(event.tool ?? event.tool_name ?? "Werkzeug")), id = String(event.tool_call_id || crypto.randomUUID());
          ids.set(name, [...(ids.get(name) ?? []), id]);
          onEvent({ kind: "tool", id, name, status: "running" });
        }
        if (event.event === "tool.completed" || event.event === "tool.failed") {
          const name = baseToolName(String(event.tool ?? event.tool_name ?? "Werkzeug")), queue = ids.get(name) ?? [];
          const id = String(event.tool_call_id || queue.shift() || crypto.randomUUID());
          ids.set(name, queue.filter(x => x !== id));
          onEvent({ kind: "tool", id, name, status: event.error || event.event === "tool.failed" ? "error" : "completed", ...(event.error || event.event === "tool.failed" ? { error: "Hermes-Werkzeug fehlgeschlagen" } : {}) });
        }
        if (event.event === "run.completed") {
          if (!text && typeof event.output === "string" && event.output) onEvent({ kind: "text", delta: event.output });
          terminal = true;
          if (!text && !toolsSeen && !(typeof event.output === "string" && event.output)) onEvent({ kind: "error", message: "Hermes hat keine Antwort geliefert" });
          else onEvent({ kind: "done" });
        } else if (event.event === "run.cancelled") { terminal = true; onEvent({ kind: "done", aborted: true }); }
        else if (["run.failed", "run.interrupted", "error"].includes(event.event)) { terminal = true; onEvent({ kind: "error", message: "Hermes-Lauf fehlgeschlagen oder unterbrochen" }); }
      };
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer = (buffer + chunk.value).replace(/\r\n/g, "\n");
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
          const eventName = frame.split("\n").find(line => line.startsWith("event:"))?.slice(6).trim();
          if (data) dispatch(data, eventName);
          if (terminal) { await reader.cancel(); break; }
        }
        if (terminal) break;
      }
      if (!terminal) throw new Error("Hermes-Ereignisstrom ohne Laufende beendet");
    } catch (error) {
      onEvent({ kind: "error", message: error instanceof Error && /^(Hermes-|Hermes )/.test(error.message) ? error.message : "Hermes-Anfrage oder Ereignisstrom fehlgeschlagen" });
    } finally {
      this.active.delete(session); run.finish();
    }
  }
}
