import { test, expect } from "bun:test";
import { Haptics, type Pulse } from "./haptics";

test("Klick, Text und Denken lösen die richtigen Impulse aus, aus = still", async () => {
  const got: Pulse[] = [];
  let on = true, waiting = true;
  const h = new Haptics({ enabled: () => on, waiting: () => waiting, sink: p => got.push(p), thinkEveryMs: 40 });
  h.pulse("click");
  expect(got).toEqual(["click"]);
  h.text(10);                           // höchstens 4 Buchstaben-Impulse
  await Bun.sleep(120);
  expect(got.filter(p => p === "tick").length).toBe(4);
  h.text(1); h.text(1);                 // zweiter Aufruf innerhalb von 20 ms wird verschluckt
  await Bun.sleep(60);
  expect(got.filter(p => p === "tick").length).toBe(5);
  got.length = 0;
  h.start(); h.start();                 // doppelter Start: nur ein Takt
  await Bun.sleep(200);
  expect(got.filter(p => p === "think").length).toBeGreaterThanOrEqual(2);
  expect(got.filter(p => p === "think").length).toBeLessThanOrEqual(5);
  waiting = false; got.length = 0;
  await Bun.sleep(120);
  expect(got).toEqual([]);              // wartet nicht mehr: kein Denk-Takt
  on = false; waiting = true;
  h.pulse("click"); await Bun.sleep(100);
  expect(got).toEqual([]);              // Einstellung aus: nichts
  h.stop();
});
