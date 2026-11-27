// Limit-Anzeige: wie viel vom Kontingent in Claude Code und Codex schon verbraucht ist. Beide Abfragen laufen über die installierten Programme
// und brauchen KEINEN Modellaufruf (kein Verbrauch): Claude Code `/usage` (lokaler Befehl), Codex `account/rateLimits/read` des App-Servers.
// Schlüssel, Tokens und Anmeldedateien liest Jarvis nicht; die Programme sprechen selbst mit ihrem Konto.
import type { CliKind } from "./cli-agents";

export type LimitWindow = { id: string; label: string; usedPercent: number; resetsAt?: number; resetText?: string };
export type Limits = { kind: CliKind; ok: boolean; windows: LimitWindow[]; plan?: string; note?: string; error?: string; at: number };

const MONTHS: Record<string, string> = { Jan: "Jan.", Feb: "Feb.", Mar: "März", Apr: "Apr.", May: "Mai", Jun: "Juni", Jul: "Juli", Aug: "Aug.", Sep: "Sep.", Oct: "Okt.", Nov: "Nov.", Dec: "Dez." };
const clampPercent = (n: unknown) => Math.max(0, Math.min(100, Math.round(Number(n)))) || 0;

/** „Nov 28 at 2:20am (Europe/Berlin)“ → „28. Nov., 02:20“. Unbekanntes Format bleibt, wie es ist. */
export function germanReset(text: string): string {
  const m = /^(?:(\w{3}) (\d{1,2}) at )?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([^)]+)\))?$/i.exec(text.trim());
  if (!m) return text.trim();
  let hour = Number(m[3]) % 12; if (m[5].toLowerCase() === "pm") hour += 12;
  const time = `${String(hour).padStart(2, "0")}:${m[4] ?? "00"}`;
  return m[1] ? `${Number(m[2])}. ${MONTHS[m[1]] ?? m[1]}, ${time}` : `${time}`;
}

const claudeLabel = (name: string) => name.replace(/^Current session$/i, "Sitzung (5 Std.)").replace(/^Current week/i, "Woche").replace(/all models/i, "alle Modelle");

/** Liest die Zeilen „Current session: 10% used · resets …“ der Claude-Code-Ausgabe von `/usage`. */
export function parseClaudeUsage(text: string): LimitWindow[] {
  const windows: LimitWindow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(Current [^:]+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/i.exec(line);
    if (!m) continue;
    windows.push({ id: m[1].toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), label: claudeLabel(m[1]), usedPercent: clampPercent(m[2]), ...(m[3] ? { resetText: germanReset(m[3]) } : {}) });
  }
  return windows;
}

const windowLabel = (mins: unknown) => {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return "Fenster";
  if (m % 10080 === 0) return m === 10080 ? "Woche" : `${m / 10080} Wochen`;
  if (m % 1440 === 0) return `${m / 1440} Tage`;
  if (m % 60 === 0) return `${m / 60} Std.`;
  return `${m} Min.`;
};

/** Antwort von `account/rateLimits/read` (Codex App-Server). */
export function parseCodexRateLimits(result: any): { windows: LimitWindow[]; plan?: string; note?: string } {
  const rl = result?.rateLimits ?? {};
  const windows: LimitWindow[] = [];
  for (const [id, w] of [["primary", rl.primary], ["secondary", rl.secondary]] as const)
    if (w && Number.isFinite(Number(w.usedPercent))) windows.push({ id, label: windowLabel(w.windowDurationMins), usedPercent: clampPercent(w.usedPercent), ...(Number.isFinite(Number(w.resetsAt)) ? { resetsAt: Number(w.resetsAt) } : {}) });
  const note = result?.ordinaryUsageAllowed === false || rl.rateLimitReachedType ? "Limit erreicht" : rl.credits?.hasCredits ? `Guthaben ${String(rl.credits.balance ?? "")}`.trim() : undefined;
  return { windows, ...(typeof rl.planType === "string" && rl.planType !== "unknown" ? { plan: rl.planType } : {}), ...(note ? { note } : {}) };
}

export async function readCodexLimits(bin = "codex", timeoutMs = 20_000): Promise<Limits> {
  const at = Date.now();
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn([bin, "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env });
    const p = proc, send = (o: object) => { (p.stdin as any).write(JSON.stringify(o) + "\n"); (p.stdin as any).flush(); };
    const timer = setTimeout(() => p.kill(), timeoutMs);
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "jarvis", title: "Jarvis", version: "0.1" } } });
    const reader = (p.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "", step = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += chunk.value;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
          let m: any; try { m = JSON.parse(line); } catch { continue; }
          if (m.id === 1 && step === 0) { step = 1; send({ method: "initialized" }); send({ id: 2, method: "account/rateLimits/read" }); }
          else if (m.id === 2) {
            if (m.error) return { kind: "codex", ok: false, windows: [], error: "Codex meldet keine Limits (angemeldet?)", at };
            const parsed = parseCodexRateLimits(m.result);
            return { kind: "codex", ok: parsed.windows.length > 0, ...parsed, ...(parsed.windows.length ? {} : { error: "Codex meldet keine Limits" }), at };
          }
        }
      }
    } finally { clearTimeout(timer); }
    return { kind: "codex", ok: false, windows: [], error: "Codex hat nicht geantwortet", at };
  } catch {
    return { kind: "codex", ok: false, windows: [], error: "Codex ist nicht installiert oder nicht erreichbar", at };
  } finally { try { proc?.kill(); } catch { /* beendet */ } }
}

export async function readClaudeLimits(bin = "claude", timeoutMs = 60_000): Promise<Limits> {
  const at = Date.now();
  try {
    const p = Bun.spawn([bin, "-p", "/usage", "--output-format", "json", "--setting-sources", "", "--no-session-persistence"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: process.env });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    const out = await new Response(p.stdout).text(); await p.exited; clearTimeout(timer);
    let text = ""; try { text = String(JSON.parse(out).result ?? ""); } catch { text = out; }
    const windows = parseClaudeUsage(text);
    return windows.length ? { kind: "claude", ok: true, windows, at } : { kind: "claude", ok: false, windows: [], error: "Claude Code meldet keine Limits (angemeldet?)", at };
  } catch {
    return { kind: "claude", ok: false, windows: [], error: "Claude Code ist nicht installiert oder nicht erreichbar", at };
  }
}

export const readLimits = (kind: CliKind, bin?: string) => kind === "claude" ? readClaudeLimits(bin) : readCodexLimits(bin);
