import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateTokens, parseRange, readUsage, recordUsage, summarize, usageFromInfo, type UsageEntry } from "./usage";

let file = "";
beforeEach(() => { file = join(mkdtempSync(join(tmpdir(), "jarvis-usage-")), "usage.jsonl"); process.env.JARVIS_USAGE_FILE = file; });

const NOW = new Date(2026, 10, 21, 15, 30).getTime();
const at = (daysAgo: number, hour = 12, e: Partial<UsageEntry> = {}): UsageEntry => {
  const d = new Date(NOW); d.setDate(d.getDate() - daysAgo); d.setHours(hour, 0, 0, 0);
  return { ts: d.getTime(), model: "opencode/x", input: 100, output: 50, estimated: false, ...e };
};

test("usageFromInfo liest echte Zahlen nur bei fertiger Assistentennachricht", () => {
  const info = { role: "assistant", providerID: "opencode", modelID: "m", time: { completed: 1 }, tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } } };
  expect(usageFromInfo(info)).toEqual({ input: 14, output: 7, model: "opencode/m" });
  expect(usageFromInfo({ ...info, time: {} })).toBeNull();
  expect(usageFromInfo({ ...info, role: "user" })).toBeNull();
  expect(usageFromInfo({ ...info, tokens: { input: 0, output: 0 } })).toBeNull();
});

test("Schätzung: etwa vier Zeichen pro Token", () => {
  expect(estimateTokens(0)).toBe(0);
  expect(estimateTokens(1)).toBe(1);
  expect(estimateTokens(400)).toBe(100);
});

test("Speichern und Lesen; leere und kaputte Zeilen werden übergangen, keine Inhalte gespeichert", () => {
  recordUsage({ ts: 1, model: "a/b", input: 5, output: 6, estimated: true });
  recordUsage({ ts: 2, model: "a/b", input: 0, output: 0, estimated: true }); // nichts zu speichern
  require("node:fs").appendFileSync(file, "kaputt\n");
  const r = readUsage();
  expect(r).toEqual([{ ts: 1, model: "a/b", input: 5, output: 6, estimated: true }]);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8").split("\n")[0])).sort()).toEqual(["estimated", "input", "model", "output", "ts"]);
});

test("1 Tag: 24 Stundenbalken, nur letzte 24 Stunden", () => {
  const s = summarize([at(0, 15), at(0, 3), at(2, 12)], "1d", NOW);
  expect(s.unit).toBe("hour");
  expect(s.buckets).toHaveLength(24);
  expect(s.total).toBe(300);
  expect(s.calls).toBe(2);
  expect(s.buckets.at(-1)!.input).toBe(100); // 15:00 ist die letzte Stunde
});

test("7 und 30 Tage: Tagesbalken, ältere Einträge zählen nicht", () => {
  const e = [at(0), at(6), at(7), at(29), at(40)];
  const w = summarize(e, "7d", NOW), m = summarize(e, "30d", NOW);
  expect(w.buckets).toHaveLength(7); expect(w.calls).toBe(2);
  expect(m.buckets).toHaveLength(30); expect(m.calls).toBe(4);
  expect(m.buckets.at(-1)!.output).toBe(50);
});

test("Gesamt: Tage, bei langer Spanne Monate; Summen, Modelle und geschätzter Anteil", () => {
  const a = summarize([at(3), at(0, 12, { model: "n/y", input: 300, output: 0, estimated: true })], "all", NOW);
  expect(a.unit).toBe("day");
  expect(a.buckets).toHaveLength(4);
  expect(a.input).toBe(400); expect(a.output).toBe(50);
  expect(a.models.map(x => x.model)).toEqual(["n/y", "opencode/x"]);
  expect(a.estimatedShare).toBeCloseTo(300 / 450);
  const long = summarize([at(400), at(0)], "all", NOW);
  expect(long.unit).toBe("month");
  expect(long.buckets.length).toBeGreaterThanOrEqual(13);
  expect(long.calls).toBe(2);
});

test("leere Daten und ungültiger Zeitraum", () => {
  const s = summarize([], "all", NOW);
  expect(s.total).toBe(0); expect(s.estimatedShare).toBe(0);
  expect(parseRange("nonsense")).toBe("7d"); expect(parseRange("30d")).toBe("30d");
});
