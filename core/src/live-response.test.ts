import { expect, test } from "bun:test";
import { clickOutcome, formatLiveSpeech, inCorner, requestedClick } from "./live-response";
import { correct } from "./lexicon";

test("Discord-Klick bleibt ein Auftrag für das Programmfenster und dessen untere linke Ecke", () => {
  const click = requestedClick("Klicke in Discord unten links auf mein Profilbild")!;
  expect(click).toMatchObject({ app: "Discord", corner: "unten links" });
  const window = [1000, 1400, 800, 1000];
  expect(inCorner([1040, 1780, 28, 30], window, click.corner!)).toBe(false);
  expect(inCorner([1020, 2310, 40, 40], window, click.corner!)).toBe(true);
  expect(inCorner([-50, 2350, 20, 20], window, click.corner!)).toBe(false);
});

test("eine kurze Fortsetzung ist ein neuer Klickauftrag, Fragen und Abläufe bleiben frei", () => {
  const click = requestedClick("Ja ok, klick einfach, reicht")!;
  expect(click.followUp).toBe(true);
  expect(clickOutcome(click, false)).toBe("Ich konnte das Ziel nicht sicher anklicken.");
  expect(clickOutcome(click, true)).toContain("konnte ich nicht prüfen");
  expect(requestedClick("Was passiert, wenn ich klicke?")).toBeUndefined();
  expect(requestedClick("Klick unten links und dann auf Senden.")).toBeUndefined();
});

test("Live-Ausgabe lässt technische Details ohne Nachfrage weg", () => {
  expect(formatLiveSpeech("Der Klick war bei y=1795. Element 57 ist falsch. Ich finde dein Profilbild noch nicht. Ich schaue weiter. Mehr Text.", "Klick unten links"))
    .toBe("Ich finde dein Profilbild noch nicht. Ich schaue weiter. Mehr Text.");
  expect(formatLiveSpeech("Die Koordinaten waren 1054 und 1795.", "Sag mir die Koordinaten."))
    .toBe("Die Koordinaten waren 1054 und 1795.");
  expect(formatLiveSpeech("Erster Satz. Zweiter Satz. Dritter Satz.", "Lies mir das vor."))
    .toBe("Erster Satz. Zweiter Satz. Dritter Satz.");
  expect(correct("Gein Discord").text).toBe("In Discord");
});

test("Live-Ausgabe behält weitere Sätze und schneidet lange Sätze nicht ab", () => {
  const greeting = "Hallo! Alles gut bei dir. Wie kann ich dir heute helfen?";
  expect(formatLiveSpeech(greeting, "Was geht Jarvis?")).toBe(greeting);
  const longSentence = "Ich kann dir beim Einrichten helfen, " + "die Einstellungen gemeinsam mit dir durchgehen, ".repeat(6)
    + "und am Ende prüfen, ob alles so funktioniert, wie du es möchtest.";
  expect(formatLiveSpeech(longSentence, "Was kannst du?")).toBe(longSentence);
  expect(formatLiveSpeech("Öffne Version 1.25. Sag danach Bescheid.", "Wie geht es weiter?"))
    .toBe("Öffne Version 1.25. Sag danach Bescheid.");
});
