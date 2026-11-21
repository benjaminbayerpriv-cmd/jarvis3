import { expect, test } from "bun:test";
import { clickOutcome, conciseSpeech, inCorner, requestedClick } from "./live-response";
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

test("Live-Ausgabe ist kurz und lässt technische Details ohne Nachfrage weg", () => {
  expect(conciseSpeech("Der Klick war bei y=1795. Element 57 ist falsch. Ich finde dein Profilbild noch nicht. Ich schaue weiter. Mehr Text.", "Klick unten links"))
    .toBe("Ich finde dein Profilbild noch nicht. Ich schaue weiter.");
  expect(conciseSpeech("Die Koordinaten waren 1054 und 1795.", "Sag mir die Koordinaten."))
    .toBe("Die Koordinaten waren 1054 und 1795.");
  expect(conciseSpeech("Erster Satz. Zweiter Satz. Dritter Satz.", "Lies mir das vor."))
    .toBe("Erster Satz. Zweiter Satz. Dritter Satz.");
  expect(correct("Gein Discord").text).toBe("In Discord");
});
