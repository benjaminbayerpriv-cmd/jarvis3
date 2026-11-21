// Token-Verbrauch: pro Modellaufruf ein Eintrag (Zeit, Modell, Tokens). Keine Chat-Inhalte.
// Gespeichert als JSON-Zeilen unter ~/.jarvis3/usage.jsonl (JARVIS_USAGE_FILE überschreibt den Pfad für Tests).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface UsageEntry { ts: number; model: string; input: number; output: number; estimated: boolean }
export type UsageRange = "1d" | "7d" | "30d" | "all";
export interface UsageBucket { start: number; label: string; input: number; output: number }
export interface UsageSummary {
  range: UsageRange; unit: "hour" | "day" | "month"; input: number; output: number; total: number; calls: number;
  estimatedShare: number; // Anteil (0..1) der Tokens, die nur geschätzt sind
  buckets: UsageBucket[]; models: { model: string; input: number; output: number; total: number; calls: number }[];
}

const DAY = 86_400_000, HOUR = 3_600_000;
const file = () => process.env.JARVIS_USAGE_FILE || join(homedir(), ".jarvis3", "usage.jsonl");

/** Grobe Schätzung, wenn die API keine Zahlen liefert: ca. 4 Zeichen pro Token. */
export const estimateTokens = (chars: number) => chars > 0 ? Math.max(1, Math.round(chars / 4)) : 0;

/** Zahlen aus der Info einer fertigen OpenCode-Assistentennachricht; null, wenn keine echten Zahlen da sind. */
export function usageFromInfo(info: any): { input: number; output: number; model: string } | null {
  const t = info?.tokens;
  if (!t || info.role !== "assistant" || !info.time?.completed) return null;
  const n = (v: unknown) => (typeof v === "number" && v > 0 ? v : 0);
  const input = n(t.input) + n(t.cache?.read) + n(t.cache?.write), output = n(t.output) + n(t.reasoning);
  if (!input && !output) return null;
  return { input, output, model: info.providerID && info.modelID ? `${info.providerID}/${info.modelID}` : String(info.modelID ?? "unbekannt") };
}

export function recordUsage(e: UsageEntry) {
  if (!(e.input > 0 || e.output > 0)) return;
  try {
    const f = file();
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, JSON.stringify({ ts: e.ts, model: e.model, input: e.input, output: e.output, estimated: e.estimated }) + "\n");
  } catch { /* Verbrauchsstatistik darf nie einen Chat stören */ }
}

export function readUsage(): UsageEntry[] {
  const f = file();
  if (!existsSync(f)) return [];
  const out: UsageEntry[] = [];
  for (const line of readFileSync(f, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (Number.isFinite(e.ts) && typeof e.model === "string") out.push({ ts: e.ts, model: e.model, input: +e.input || 0, output: +e.output || 0, estimated: !!e.estimated });
    } catch { /* kaputte Zeile überspringen */ }
  }
  return out;
}

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfMonth = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); d.setDate(1); return d.getTime(); };
const addMonth = (t: number) => { const d = new Date(t); d.setMonth(d.getMonth() + 1); return d.getTime(); };
const pad = (n: number) => String(n).padStart(2, "0");

export function summarize(entries: UsageEntry[], range: UsageRange, now = Date.now()): UsageSummary {
  const hourly = range === "1d";
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  const first = entries.reduce((m, e) => Math.min(m, e.ts), now);
  const monthly = range === "all" && now - first > 120 * DAY;
  const unit = hourly ? "hour" : monthly ? "month" : "day";
  // Bucket-Grenzen
  const starts: number[] = [];
  if (hourly) { const s = Math.floor(now / HOUR) * HOUR; for (let i = 23; i >= 0; i--) starts.push(s - i * HOUR); }
  else if (days) { const s = startOfDay(now); for (let i = days - 1; i >= 0; i--) { const d = new Date(s); d.setDate(d.getDate() - i); starts.push(d.getTime()); } }
  else if (monthly) { for (let t = startOfMonth(first); t <= now; t = addMonth(t)) starts.push(t); }
  else { for (let t = startOfDay(first); t <= now; ) { starts.push(t); const d = new Date(t); d.setDate(d.getDate() + 1); t = d.getTime(); } }
  const label = (t: number) => { const d = new Date(t);
    return hourly ? `${pad(d.getHours())}:00` : monthly ? `${pad(d.getMonth() + 1)}.${d.getFullYear()}` : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`; };
  const buckets: UsageBucket[] = starts.map(s => ({ start: s, label: label(s), input: 0, output: 0 }));
  const lo = buckets.length ? buckets[0].start : now;
  const models = new Map<string, { model: string; input: number; output: number; total: number; calls: number }>();
  let input = 0, output = 0, calls = 0, est = 0;
  for (const e of entries) {
    if (e.ts < lo || e.ts > now) continue;
    let i = buckets.length - 1; while (i > 0 && buckets[i].start > e.ts) i--; // Zeitumstellung-sicher statt Division
    buckets[i].input += e.input; buckets[i].output += e.output;
    input += e.input; output += e.output; calls++;
    if (e.estimated) est += e.input + e.output;
    const m = models.get(e.model) ?? { model: e.model, input: 0, output: 0, total: 0, calls: 0 };
    m.input += e.input; m.output += e.output; m.total += e.input + e.output; m.calls++; models.set(e.model, m);
  }
  const total = input + output;
  return { range, unit, input, output, total, calls, estimatedShare: total ? est / total : 0, buckets,
           models: [...models.values()].sort((a, b) => b.total - a.total) };
}

export const parseRange = (v: unknown): UsageRange => (v === "1d" || v === "7d" || v === "30d" || v === "all" ? v : "7d");
