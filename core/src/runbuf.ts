// Merkt sich pro laufendem Chat die Ereignisse der aktuellen Antwort (Text, Denken, Werkzeuge), damit eine Oberfläche,
// die erst später zu diesem Chat wechselt, die halbfertige Antwort nachgereicht bekommt.
export type RunEvent = { type: string; [key: string]: unknown };

const MAX_EVENTS = 4000;

export class RunBuffer {
  private runs = new Map<string, RunEvent[]>();

  start(session: string) { this.runs.set(session, []); }
  clear(session: string) { this.runs.delete(session); }
  has(session: string) { return this.runs.has(session); }
  get(session: string): RunEvent[] { return this.runs.get(session) ?? []; }

  /** Nur Ereignisse, die eine Antwort aufbauen. Aufeinanderfolgender Text wird zusammengefasst, ein Werkzeug-Update ersetzt das alte. */
  add(session: string, event: RunEvent) {
    const list = this.runs.get(session);
    if (!list) return;
    if (event.type === "delta" || event.type === "reasoning") {
      const last = list.at(-1);
      if (last?.type === event.type) { last.text = String(last.text ?? "") + String(event.text ?? ""); return; }
      list.push({ ...event });
    } else if (event.type === "tool") {
      const at = list.findIndex(e => e.type === "tool" && e.id === event.id);
      if (at >= 0) list[at] = { ...event }; else list.push({ ...event });
    } else return;
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
  }
}
