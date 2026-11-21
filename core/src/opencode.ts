// OpenCode als Gehirn: Modellliste, headless Server, Sitzungen und Token-Stream.
import { join } from "node:path";
import { recordError } from "./errorlog";
import { estimateTokens, recordUsage, usageFromInfo } from "./usage";

export type ModelGroup = "free" | "lmstudio" | "nvidia" | "other";
export interface ModelInfo { id: string; provider: string; model: string; group: ModelGroup; vision: boolean }
export type PromptImage = { mime: string; url: string; filename?: string };

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
  | { kind: "tool"; id: string; name: string; status: string; title?: string; input?: Record<string, unknown>; error?: string }
  | { kind: "done"; aborted?: boolean }
  | { kind: "error"; message: string; retry?: boolean };

export class OpenCode {
  url: string;
  private proc?: ReturnType<typeof Bun.spawn>;
  private partKinds = new Map<string, string>();
  private listeners = new Map<string, (e: BrainEvent) => void>();
  private started = new Set<string>(); // Sitzungen, in denen der aktuelle Lauf schon Ereignisse geliefert hat
  private lastStreamError = 0;
  private lastEvent = new Map<string, number>(); // Sitzung -> letztes Ereignis bzw. Start des Laufs
  private watchdog?: ReturnType<typeof setInterval>;
  // Verbrauch: pro Lauf gemerkt, ob echte Zahlen kamen; sonst wird am Ende geschätzt (nur Zeichenzahlen, keine Inhalte)
  private runs = new Map<string, { model: string; inChars: number; outChars: number; real: boolean }>();
  private seenUsage = new Set<string>();
  /** Diagnose (jarvisd schreibt es in voice.log). */
  onLog: (line: string) => void = () => {};

  constructor(public port = 4096, public workspace = join(import.meta.dir, "../../workspace")) {
    this.url = `http://127.0.0.1:${port}`;
  }

  async start() {
    if (await this.healthy()) { this.listen(); return; } // läuft schon (z. B. nach Daemon-Neustart)
    this.proc = Bun.spawn(["opencode", "serve", "--port", String(this.port), "--hostname", "127.0.0.1"],
      { cwd: this.workspace, stdout: "ignore", stderr: "inherit",
        // Skills nur aus dem Jarvis-Arbeitsordner (Erweiterungen): ~/.claude/skills & Co. würden sonst alle automatisch in jede Anfrage geladen
        env: { ...process.env, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1" } });
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

  /** Eine Frage ohne Nutzer-Sichtbarkeit beantworten (z. B. Projektzuordnung). Liefert nur den Text. */
  async ask(text: string, model: string, system: string, timeoutMs = 25_000): Promise<string> {
    const sid = await this.createSession("Test"); // "Test" bleibt im Verlauf verborgen
    let out = "";
    return new Promise<string>(resolve => {
      let finished = false;
      const finish = () => { if (finished) return; finished = true; clearTimeout(timer); resolve(out); };
      const timer = setTimeout(() => { void this.abort(sid, false); finish(); }, timeoutMs);
      void this.prompt(sid, text, model, system, e => {
        if (e.kind === "text") out += e.delta;
        else if (e.kind === "done" || e.kind === "error") finish();
      }).catch(finish);
    });
  }

  /** Startet einen Prompt; Ereignisse kommen über onEvent, bis "done". */
  async prompt(session: string, text: string, model: string, system: string, onEvent: (e: BrainEvent) => void,
               images: PromptImage[] = [], attachmentText = "") {
    const [providerID, ...rest] = model.split("/");
    this.listeners.set(session, onEvent);
    this.runs.set(session, { model, inChars: text.length + system.length + attachmentText.length, outChars: 0, real: false });
    this.lastEvent.set(session, Date.now());
    this.started.delete(session); // ein spätes "idle" des vorherigen (abgebrochenen) Laufs darf diesen nicht beenden
    const parts: unknown[] = [{ type: "text", text }];
    if (attachmentText) parts.push({ type: "text", text: attachmentText });
    for (const img of images) parts.push({ type: "file", mime: img.mime, url: img.url, filename: img.filename });
    const r = await fetch(`${this.url}/session/${session}/prompt_async`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: { providerID, modelID: rest.join("/") }, system, parts }),
    });
    if (!r.ok) { this.listeners.delete(session); onEvent({ kind: "error", message: `${r.status} ${await r.text()}` }); }
  }

  /** Lauf zu Ende: gab es keine echten Zahlen der API, wird der Verbrauch geschätzt und als geschätzt gespeichert. */
  private finishRun(session: string) {
    const r = this.runs.get(session);
    this.runs.delete(session);
    if (!r || r.real) return;
    recordUsage({ ts: Date.now(), model: r.model, input: estimateTokens(r.inChars), output: estimateTokens(r.outChars), estimated: true });
  }

  /** Wartet, bis OpenCode die Sitzung wirklich im Leerlauf meldet (nach einem Abbruch läuft noch Aufräumarbeit). */
  async idle(session: string, maxMs = 4000) {
    const t0 = Date.now();
    for (;;) {
      try {
        const st = await (await fetch(`${this.url}/session/status`)).json() as Record<string, unknown>;
        if (!st[session]) break;
      } catch { /* weiter versuchen */ }
      if (Date.now() - t0 > maxMs) break;
      await Bun.sleep(80);
    }
    await Bun.sleep(150); // das späte "idle"-Ereignis des abgebrochenen Laufs trifft noch ein, solange kein Zuhörer registriert ist
  }

  /**
   * Bricht den laufenden Lauf ab. Mit wait=true (Standard) kehrt die Funktion erst zurück, wenn die Sitzung im Leerlauf ist;
   * sonst würde das späte "idle" des abgebrochenen Laufs den NÄCHSTEN Lauf beenden, bevor dessen Text ankommt.
   */
  async abort(session: string, wait = true) {
    await fetch(`${this.url}/session/${session}/abort`, { method: "POST" }).catch(() => {});
    this.listeners.get(session)?.({ kind: "done", aborted: true });
    this.listeners.delete(session);
    this.finishRun(session);
    if (wait) await this.idle(session);
  }

  /**
   * Wächter: Geht das "idle" eines Laufs verloren (Ereignisstrom kurz getrennt, neu verbunden), bliebe jarvisd für immer
   * "beschäftigt" und die Antwort käme nie an. Ist eine Sitzung mit Zuhörer 30 s still und meldet OpenCode sie im Leerlauf,
   * wird der Lauf hier beendet.
   */
  private async checkStalled() {
    const now = Date.now();
    const quiet = [...this.listeners.keys()].filter(sid => now - (this.lastEvent.get(sid) ?? now) > 30_000);
    if (!quiet.length) return;
    let status: Record<string, unknown>;
    try { status = await (await fetch(`${this.url}/session/status`)).json() as Record<string, unknown>; } catch { return; }
    for (const sid of quiet) {
      if (status[sid]) { this.lastEvent.set(sid, Date.now()); continue; } // arbeitet noch (z. B. langes Werkzeug)
      const cb = this.listeners.get(sid);
      if (!cb) continue;
      this.listeners.delete(sid);
      this.finishRun(sid);
      this.onLog(`OpenCode: Sitzung ${sid} im Leerlauf, aber kein idle-Ereignis angekommen -> Lauf beendet`);
      recordError({ category: "model", source: "opencode/missing-idle", message: "Lauf-Ende (session.idle) nicht angekommen, vom Wächter beendet",
        context: { session: sid, started: this.started.has(sid) } });
      cb({ kind: "done" });
    }
  }

  private async listen() {
    this.watchdog ??= setInterval(() => void this.checkStalled(), 5000);
    for (;;) {
      try {
        const r = await fetch(`${this.url}/event`);
        if (this.lastStreamError || this.listeners.size) this.onLog(`OpenCode-Ereignisstrom verbunden (laufende Sitzungen: ${this.listeners.size})`);
        const reader = r.body!.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { this.onLog("OpenCode-Ereignisstrom beendet, verbinde neu"); break; }
          buf += value;
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (line.startsWith("data:")) this.dispatch(JSON.parse(line.slice(5)));
          }
        }
      } catch (error) { // Server weg – kurz warten, neu verbinden (höchstens einmal pro Minute ins Fehler-Log)
        if (Date.now() - this.lastStreamError > 60_000) {
          this.lastStreamError = Date.now();
          recordError({ category: "model", source: "opencode/event-stream", message: "OpenCode-Ereignisstrom unterbrochen", error, context: { url: this.url } });
        }
      }
      await Bun.sleep(500);
    }
  }

  /** Echte Token-Zahlen einer fertigen Assistentennachricht (jede Nachricht höchstens einmal). */
  private noteUsage(sid: string, info: any) {
    const u = usageFromInfo(info);
    if (!u || this.seenUsage.has(info.id)) return;
    this.seenUsage.add(info.id);
    if (this.seenUsage.size > 5000) this.seenUsage.delete(this.seenUsage.values().next().value!);
    const r = this.runs.get(sid); if (r) r.real = true;
    recordUsage({ ts: Date.now(), model: u.model, input: u.input, output: u.output, estimated: false });
  }

  private dispatch(e: any) {
    const p = e.properties ?? {};
    const sid = p.sessionID ?? p.part?.sessionID ?? p.info?.sessionID;
    if (e.type === "message.updated" && sid) this.noteUsage(sid, p.info);
    const cb = this.listeners.get(sid);
    if (!cb) return;
    this.lastEvent.set(sid, Date.now());
    if (e.type === "message.part.delta" || (e.type === "message.part.updated" && p.part?.type !== "text") || (e.type === "session.status" && p.status?.type === "busy")) this.started.add(sid); // die Nutzer-Nachricht (Textteil) zählt nicht
    switch (e.type) {
      case "message.part.updated": {
        const part = p.part;
        this.partKinds.set(part.id, part.type);
        if (part.type === "tool") cb({ kind: "tool", id: part.id, name: part.tool, status: part.state?.status, title: part.state?.title, input: part.state?.input, error: part.state?.error });
        break;
      }
      case "message.part.delta": {
        const kind = this.partKinds.get(p.partID);
        if (p.field !== "text") break;
        if (kind === "text" || kind === "reasoning") { const r = this.runs.get(sid); if (r) r.outChars += String(p.delta ?? "").length; }
        if (kind === "text") cb({ kind: "text", delta: p.delta });
        else if (kind === "reasoning") cb({ kind: "reasoning", delta: p.delta });
        break;
      }
      case "session.status": {
        // OpenCode wiederholt endlos, wenn das Gratis-Kontingent leer ist -> als Fehler melden
        const st = p.status;
        if (st?.type === "retry") cb({ kind: "error", message: String(st.message ?? "Wiederholung"), retry: true });
        break;
      }
      case "session.error":
        if (p.error?.name === "MessageAbortedError") break; // vom Nutzer/Daemon abgebrochen: kein Fehler
        cb({ kind: "error", message: p.error?.data?.message ?? p.error?.name ?? "Fehler" });
        break;
      case "session.idle":
        if (!this.started.has(p.sessionID)) break; // veraltetes Ereignis eines früheren Laufs
        cb({ kind: "done" });
        this.listeners.delete(p.sessionID);
        this.finishRun(p.sessionID);
        break;
    }
  }
}
