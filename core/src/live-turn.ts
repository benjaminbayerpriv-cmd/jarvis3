// Live-Modus: Zustellung der fertigen Antwort an die Sprachausgabe und Diagnose pro Turn.
//
// Früher galt JEDES speech_start während des Nachdenkens als Unterbrechung (Husten, „ähm“, Tastatur, Echo der eigenen
// Ansage). Die fertige Antwort stand dann im Chat, wurde aber nie gesprochen und in der Live-Ansicht nie gezeigt, weil
// die Untertitel nur zeigen, was wirklich gesprochen wird. Jetzt gilt: eine Antwort wird nur verworfen, wenn sie durch
// eine NEUE Frage (neuer Lauf) oder ein Stopp abgelöst wurde. Spricht der Nutzer gerade bzw. ist seine Äußerung noch
// offen, wird die Antwort gehalten und danach gesprochen, sobald klar ist, dass keine neue Frage kam.

export type TraceEntry = { at: string; ev: string; info?: string };

/** Ereignisfolge der letzten Läufe (für voice.log und das Fehler-Log). */
export class TurnTrace {
  private runs = new Map<number, TraceEntry[]>();
  constructor(private write: (line: string) => void, private keep = 8) {}
  add(run: number, ev: string, info?: string) {
    let list = this.runs.get(run);
    if (!list) {
      list = []; this.runs.set(run, list);
      for (const k of [...this.runs.keys()]) if (this.runs.size > this.keep) this.runs.delete(k);
    }
    if (list.length < 80) list.push({ at: new Date().toISOString(), ev, ...(info ? { info: info.slice(0, 200) } : {}) });
    this.write(`[T${run}] ${ev}${info ? ` ${info.slice(0, 200)}` : ""}`);
  }
  get(run: number) { return [...(this.runs.get(run) ?? [])]; }
}

export interface AnswerDeps {
  say(text: string): number | undefined;
  /** Grund, warum gerade nicht gesprochen werden kann; `expected` = gewollt (Live geschlossen), kein Fehler. */
  blocked(): { reason: string; expected: boolean } | undefined;
  currentRun(): number;
  /** Grund zu warten: Nutzer spricht gerade, seine Äußerung wird noch gesammelt oder das Sprachmodul ist nicht verbunden. */
  mustWait(): string | undefined;
  log(run: number, ev: string, info?: string): void;
  /** Antwort konnte nicht gesprochen werden (Oberfläche zeigt sie, Fehler-Log). */
  unspoken(run: number, text: string, reason: string): void;
  now(): number;
}

const MAX_HOLD_MS = 20_000;   // so lange wartet eine gehaltene Antwort auf das Ende der Nutzer-Äußerung
const MAX_START_MS = 15_000;  // so lange darf der Sidecar bis zum say_start brauchen

export class LiveAnswer {
  held?: { run: number; text: string; since: number; reason: string };
  playing?: { run: number; text: string; id: number; since: number; started: boolean };
  constructor(private d: AnswerDeps) {}

  /** Lauf ist fertig: Antwort sprechen, halten oder (begründet) verwerfen. */
  deliver(run: number, text: string) {
    if (!text.trim()) return;
    if (run !== this.d.currentRun()) { this.d.log(run, "antwort-verworfen", "abgelöst durch neueren Lauf"); return; }
    const b = this.d.blocked();
    if (b) {
      this.d.log(run, "antwort-nicht-gesprochen", b.reason);
      if (!b.expected) this.d.unspoken(run, text, b.reason);
      return;
    }
    const wait = this.d.mustWait();
    if (wait) { this.hold(run, text, wait); return; }
    this.play(run, text);
  }

  private hold(run: number, text: string, reason: string) {
    this.held = { run, text, since: this.d.now(), reason };
    this.d.log(run, "antwort-gehalten", reason);
  }

  private play(run: number, text: string) {
    this.held = undefined;
    const id = this.d.say(text);
    if (id === undefined) return;
    this.playing = { run, text, id, since: this.d.now(), started: false };
    this.d.log(run, "antwort-gesendet", `say#${id}`);
  }

  onSayStart(id: number) {
    const p = this.playing;
    if (!p) return;
    if (id === p.id && !p.started) { p.started = true; this.d.log(p.run, "antwort-spricht", `say#${id}`); }
    else if (id > p.id) this.playing = undefined; // stummer Satz ohne say_start, ein späterer läuft schon
  }
  onSayEnd(id: number) {
    const p = this.playing;
    if (p && id >= p.id) { this.d.log(p.run, "antwort-fertig", `say#${p.id}`); this.playing = undefined; }
  }

  /** speech_start: der Sidecar hat seine Ausgabe-Warteschlange verworfen. */
  onUserSpeech() {
    const p = this.playing;
    if (!p) return;
    this.playing = undefined;
    if (p.started) { this.d.log(p.run, "antwort-unterbrochen", "Nutzer sprach während der Antwort"); return; }
    // Noch nicht hörbar gewesen: gehalten statt verloren. Kommt keine neue Frage, wird sie danach gesprochen.
    this.hold(p.run, p.text, "vor dem Sprechen durch Sprache/Geräusch verdrängt");
  }

  /** Nutzer ist fertig und es kam keine neue Frage: gehaltene Antwort jetzt sprechen. */
  release() {
    const h = this.held;
    if (!h || this.d.mustWait()) return;
    this.held = undefined;
    if (h.run !== this.d.currentRun()) { this.d.log(h.run, "antwort-verworfen", "neue Frage gestellt"); return; }
    const b = this.d.blocked();
    if (b) { this.d.log(h.run, "antwort-nicht-gesprochen", b.reason); if (!b.expected) this.d.unspoken(h.run, h.text, b.reason); return; }
    this.d.log(h.run, "antwort-nachgeholt", h.reason);
    this.play(h.run, h.text);
  }

  /** Stopp, Live aus: nichts mehr nachholen. */
  drop(reason: string) {
    const r = this.held?.run ?? this.playing?.run;
    if (r !== undefined) this.d.log(r, "antwort-verworfen", reason);
    this.held = undefined; this.playing = undefined;
  }

  /** Regelmäßig aufrufen (Wächter). */
  tick() {
    this.release();
    const now = this.d.now();
    const h = this.held;
    if (h && now - h.since > MAX_HOLD_MS) {
      this.held = undefined;
      if (h.run === this.d.currentRun()) this.d.unspoken(h.run, h.text, `Antwort ${Math.round((now - h.since) / 1000)} s gehalten, ${h.reason}`);
    }
    const p = this.playing;
    if (p && !p.started && now - p.since > MAX_START_MS) {
      this.playing = undefined;
      this.d.unspoken(p.run, p.text, `Sprachausgabe hat say#${p.id} nach ${Math.round((now - p.since) / 1000)} s nicht begonnen`);
    }
  }
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, "");
/** Hat das Mikrofon nur Jarvis' eigene Ansage gehört (Lautsprecher-Echo)? Nur (fast) wörtlich gleiche Sätze zählen, damit
 *  "YouTube öffnen" nach "Soll ich YouTube öffnen?" eine echte Antwort bleibt. */
export function isEcho(heard: string, recent: { text: string; at: number }[], now: number, windowMs = 15_000) {
  const h = norm(heard);
  if (h.length < 4) return false;
  return recent.some(r => now - r.at < windowMs && (() => { const s = norm(r.text); return s.length >= 4 && (s === h || (h.length >= 0.8 * s.length && s.includes(h))); })());
}
