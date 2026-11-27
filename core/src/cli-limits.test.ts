import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { germanReset, parseClaudeUsage, parseCodexRateLimits, readClaudeLimits, readCodexLimits } from "./cli-limits";

const usage = `You are currently using your subscription to power your Claude Code usage

Current session: 10% used · resets Nov 28 at 2:20am (Europe/Berlin)
Current week (all models): 11% used · resets Dec 3 at 11am (Europe/Berlin)
Current week (Opus): 3.4% used

What's contributing to your usage?
Last 24h · 212 requests · 6 sessions
  100%  Start fresh when you switch tasks · run /clear`;

test("Claude /usage (aufgezeichnet): Fenster, Prozent, Zurücksetzen auf Deutsch; Empfehlungen zählen nicht", () => {
  expect(parseClaudeUsage(usage)).toEqual([
    { id: "current-session", label: "Sitzung (5 Std.)", usedPercent: 10, resetText: "28. Nov., 02:20" },
    { id: "current-week-all-models", label: "Woche (alle Modelle)", usedPercent: 11, resetText: "3. Dez., 11:00" },
    { id: "current-week-opus", label: "Woche (Opus)", usedPercent: 3 },
  ]);
  expect(parseClaudeUsage("Kein Abo erkannt")).toEqual([]);
});
test("Zeitformat: am/pm, nur Uhrzeit, unbekannt", () => {
  expect(germanReset("Nov 28 at 12:05am (Europe/Berlin)")).toBe("28. Nov., 00:05");
  expect(germanReset("Mar 1 at 12pm")).toBe("1. März, 12:00");
  expect(germanReset("5pm (Europe/Berlin)")).toBe("17:00");
  expect(germanReset("irgendwann")).toBe("irgendwann");
});
test("Codex rateLimits (aufgezeichnet): 5-Std- und Wochenfenster, Plan, Limit erreicht", () => {
  const r = parseCodexRateLimits({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1795829552 }, secondary: { usedPercent: 45, windowDurationMins: 10080, resetsAt: 1796050412 }, credits: { hasCredits: false, unlimited: false, balance: "0" }, planType: "plus", rateLimitReachedType: null } });
  expect(r).toEqual({ windows: [{ id: "primary", label: "5 Std.", usedPercent: 0, resetsAt: 1795829552 }, { id: "secondary", label: "Woche", usedPercent: 45, resetsAt: 1796050412 }], plan: "plus" });
  expect(parseCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } } }).note).toBe("Limit erreicht");
  expect(parseCodexRateLimits({}).windows).toEqual([]);
  expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 250, windowDurationMins: 90 } } }).windows[0]).toEqual({ id: "primary", label: "90 Min.", usedPercent: 100 });
});

const script = (body: string) => { const dir = mkdtempSync(join(tmpdir(), "lim-")), p = join(dir, "x"); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
test("Ersatzprogramme: Claude liefert /usage, Codex antwortet auf initialize und rateLimits/read; Fehler und fehlende Programme sind ok:false", async () => {
  const c = await readClaudeLimits(script(`cat <<'EOF'\n{"type":"result","result":"Current session: 42% used · resets 5pm"}\nEOF`));
  expect(c).toMatchObject({ kind: "claude", ok: true, windows: [{ usedPercent: 42, resetText: "17:00" }] });
  expect((await readClaudeLimits(script(`echo '{"result":"nichts"}'`))).ok).toBe(false);
  expect((await readClaudeLimits("/gibt/es/nicht")).ok).toBe(false);
  const cx = await readCodexLimits(script(`read a; echo '{"id":1,"result":{}}'; read b; read d; echo '{"id":2,"result":{"rateLimits":{"primary":{"usedPercent":7,"windowDurationMins":300,"resetsAt":1795829552},"planType":"pro"}}}'; sleep 5`));
  expect(cx).toMatchObject({ kind: "codex", ok: true, plan: "pro", windows: [{ label: "5 Std.", usedPercent: 7 }] });
  expect((await readCodexLimits(script(`read a; echo '{"id":1,"result":{}}'; read b; read d; echo '{"id":2,"error":{"message":"x"}}'`))).ok).toBe(false);
  expect((await readCodexLimits("/gibt/es/nicht")).ok).toBe(false);
}, 30000);
