import { test, expect } from "bun:test";
import { Haptics, type Pulse } from "./haptics";

test("Klick und Text lösen die richtigen Impulse aus, aus = still", async () => {
  const got: Pulse[] = [];
  let on = true;
  const h = new Haptics({ enabled: () => on, sink: (p: Pulse) => got.push(p) });
  h.pulse("click");
  expect(got).toEqual(["click"]);
  const h2 = new Haptics({ enabled: () => on, sink: (p: Pulse) => got.push(p), streamEveryMs: 30, streamQuietMs: 60 });
  h2.text(5000);                        // riesiges Textstück: trotzdem nur der gleichmäßige Takt, kein Stau
  await Bun.sleep(130);
  const ticks = got.filter(p => p === "tick").length;
  expect(ticks).toBeGreaterThanOrEqual(2); expect(ticks).toBeLessThanOrEqual(6);
  await Bun.sleep(150);                 // kein Text mehr: nach spätestens ~quiet ist Schluss
  const after = got.filter(p => p === "tick").length;
  await Bun.sleep(150);
  expect(got.filter(p => p === "tick").length).toBe(after);
  h2.text(1); h2.finish();              // fertig/gestoppt: sofort Ruhe
  const stopped = got.length; await Bun.sleep(150);
  expect(got.length).toBe(stopped);
  on = false;
  const before = got.length;
  h.pulse("click"); h2.text(10); await Bun.sleep(100);
  expect(got.length).toBe(before);      // Einstellung aus: nichts
  h.stop();
});

test("Arten lassen sich einzeln abschalten, Stärke wird mitgegeben", () => {
  const got: [Pulse, number][] = [];
  const allowed: Record<Pulse, boolean> = { click: true, tool: false, tick: true };
  let strength: "soft" | "normal" | "strong" = "strong";
  const h = new Haptics({ enabled: () => true, allow: p => allowed[p], strength: () => strength, sink: (p, n) => got.push([p, n]) });
  h.pulse("tool"); h.pulse("click");
  expect(got).toEqual([["click", 15]]);
  strength = "soft"; h.pulse("click");
  expect(got.at(-1)).toEqual(["click", 3]);
});
