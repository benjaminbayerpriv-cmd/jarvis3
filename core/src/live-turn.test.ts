import { expect, test } from "bun:test";
import { LiveAnswer, TurnTrace, isEcho, type AnswerDeps } from "./live-turn";

function setup() {
  const s = { run: 1, wait: undefined as string | undefined, blocked: undefined as ReturnType<AnswerDeps["blocked"]>, now: 0, id: 0,
    said: [] as string[], unspoken: [] as string[], log: [] as string[] };
  const a = new LiveAnswer({
    say: t => { s.said.push(t); return ++s.id; },
    blocked: () => s.blocked,
    currentRun: () => s.run,
    mustWait: () => s.wait,
    log: (_r, ev) => { s.log.push(ev); },
    unspoken: (_r, t, reason) => { s.unspoken.push(`${t}|${reason}`); },
    now: () => s.now,
  });
  return { s, a };
}

test("ruhiger Fall: Antwort wird sofort gesprochen", () => {
  const { s, a } = setup();
  a.deliver(1, "Es sind 8 Grad.");
  expect(s.said).toEqual(["Es sind 8 Grad."]);
});

test("Geräusch während des Nachdenkens: Antwort wird gehalten und danach gesprochen (früher: verloren)", () => {
  const { s, a } = setup();
  s.wait = "Nutzer spricht gerade";        // speech_start durch Husten
  a.deliver(1, "Es sind 8 Grad.");
  expect(s.said).toEqual([]);
  s.wait = undefined;                        // final: "" bzw. Füllwort -> keine neue Frage
  a.release();
  expect(s.said).toEqual(["Es sind 8 Grad."]);
  expect(s.log).toContain("antwort-nachgeholt");
});

test("Geräusch, nachdem die Antwort an den Sidecar ging, aber bevor sie hörbar war: wird nachgeholt", () => {
  const { s, a } = setup();
  a.deliver(1, "Antwort.");
  a.onUserSpeech();                          // Sidecar verwirft seine Warteschlange
  s.wait = "Nutzer spricht gerade";
  a.release();
  expect(s.said.length).toBe(1);
  s.wait = undefined; a.release();
  expect(s.said).toEqual(["Antwort.", "Antwort."]);
});

test("echte neue Frage: alte Antwort wird verworfen", () => {
  const { s, a } = setup();
  s.wait = "Äußerung des Nutzers noch offen";
  a.deliver(1, "Alte Antwort.");
  s.run = 2; s.wait = undefined;
  a.release();
  expect(s.said).toEqual([]);
  expect(s.unspoken).toEqual([]);
});

test("Unterbrechung während die Antwort schon hörbar läuft: kein Nachholen", () => {
  const { s, a } = setup();
  a.deliver(1, "Lange Antwort.");
  a.onSayStart(1);
  a.onUserSpeech();
  a.release();
  expect(s.said.length).toBe(1);
});

test("Live geschlossen: nicht sprechen, kein Fehler", () => {
  const { s, a } = setup();
  s.blocked = { reason: "Live beendet", expected: true };
  a.deliver(1, "x y");
  expect(s.said).toEqual([]);
  expect(s.unspoken).toEqual([]);
});

test("Sidecar beginnt nie zu sprechen: Wächter meldet die ungesprochene Antwort", () => {
  const { s, a } = setup();
  a.deliver(1, "Antwort.");
  s.now = 16_000; a.tick();
  expect(s.unspoken.length).toBe(1);
});

test("Antwort zu lange gehalten: wird gemeldet statt still zu verschwinden", () => {
  const { s, a } = setup();
  s.wait = "Nutzer spricht gerade";
  a.deliver(1, "Antwort.");
  s.now = 21_000; a.tick();
  expect(s.unspoken.length).toBe(1);
  expect(s.said).toEqual([]);
});

test("say_end beendet, späteres say_start ohne eigenes say_start beendet ebenfalls", () => {
  const { a } = setup();
  a.deliver(1, "A."); a.onSayStart(1); a.onSayEnd(1);
  expect(a.playing).toBeUndefined();
  a.deliver(1, "B."); a.onSayStart(5);
  expect(a.playing).toBeUndefined();
});

test("Echo der eigenen Ansage wird erkannt, echte Sätze nicht", () => {
  const recent = [{ text: "Einen Moment.", at: 1000 }];
  expect(isEcho("Einen Moment", recent, 3000)).toBe(true);
  expect(isEcho("einen moment.", recent, 3000)).toBe(true);
  expect(isEcho("Wie ist das Wetter?", recent, 3000)).toBe(false);
  expect(isEcho("Einen Moment.", recent, 30_000)).toBe(false); // zu alt
  expect(isEcho("ja", recent, 3000)).toBe(false);
  expect(isEcho("YouTube öffnen", [{ text: "Soll ich YouTube öffnen?", at: 1000 }], 3000)).toBe(false);
});

test("TurnTrace schreibt Zeilen mit Laufnummer und behält die Folge", () => {
  const lines: string[] = [];
  const t = new TurnTrace(l => lines.push(l), 2);
  t.add(1, "lauf-start", "x"); t.add(1, "lauf-ende done"); t.add(2, "a"); t.add(3, "b");
  expect(lines[0]).toBe("[T1] lauf-start x");
  expect(t.get(1)).toEqual([]);          // nur die letzten 2 Läufe
  expect(t.get(3).map(e => e.ev)).toEqual(["b"]);
});
