import { test, expect } from "bun:test";
import { correct, distance } from "./lexicon";

const none = { begriffe: [], ersetzungen: [] };
const fix = (s: string) => correct(s, none).text;

test("korrigiert die gemessenen Verhörer", () => {
  expect(fix("Hey Jarvis, can you open the system install engine for me please.")).toBe("Hey Jarvis, can you open the Systemeinstellungen for me please.");
  expect(fix("Mach einen neuen Tapp auf, öffne Gmini und frag nach dem Wetter.")).toBe("Mach einen neuen Tab auf, öffne Gemini und frag nach dem Wetter.");
});

test("Anrede und Programme", () => {
  expect(fix("Hey Jervis, öffne you tube")).toBe("Hey Jarvis, öffne YouTube");
  expect(fix("geh in die Cloud desktop app")).toBe("geh in die Claude desktop app");
  expect(fix("Genik Cloud Browser, also öffne Cloud, geh in den Browser")).toContain("öffne Claude");
  expect(fix("check mal den pull request und den main branch")).toBe("check mal den Pull Request und den Main Branch");
});

test("lässt echte Wörter in Ruhe", () => {
  for (const s of ["Das ist eine gemeine Frage.", "Mein Tag war gut.", "Ich speichere das in der Cloud.", "Open the cloud storage settings.",
    "Die Tabs sind offen.", "Das Chrome-Fenster ist zu.", "Der Download läuft."]) expect(fix(s)).toBe(s);
});

test("Schreibweise von Begriffen und knappe Verhörer", () => {
  expect(fix("youtube ist offen")).toBe("YouTube ist offen");
  expect(fix("Systemeinstellung öffnen")).toBe("Systemeinstellungen öffnen");
  expect(correct("öffne den Zettelkasten", { begriffe: ["Zettelkasten"], ersetzungen: [] }).text).toBe("öffne den Zettelkasten");
  expect(correct("öffne den Zetelkasten", { begriffe: ["Zettelkasten"], ersetzungen: [] }).text).toBe("öffne den Zettelkasten");
});

test("eigene Ersetzungen und kaputte Muster", () => {
  const user = { begriffe: [], ersetzungen: [{ von: "\\bhey jarvis wach auf\\b", nach: "Jarvis aufwachen" }, { von: "(", nach: "x" }] };
  expect(correct("hey Jarvis wach auf", user).text).toBe("Jarvis aufwachen");   // kaputtes Muster wird übersprungen
});

test("Abstand", () => {
  expect(distance("Gmini", "Gemini")).toBe(1);
  expect(distance("Cloud", "Claude")).toBe(2);
});
