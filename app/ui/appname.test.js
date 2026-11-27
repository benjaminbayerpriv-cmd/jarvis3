import { expect, test } from "bun:test";
import { DEFAULT_NAME, brand, cleanAppName } from "./appname.js";

test("Name prüfen wie im Daemon", () => {
  expect(DEFAULT_NAME).toBe("Jarvis");
  expect(cleanAppName("  Hugo  ")).toBe("Hugo"); expect(cleanAppName("Mein   Assistent")).toBe("Mein Assistent");
  expect(cleanAppName('Ro"bo`t\\')).toBe("Robot"); expect(cleanAppName("a\u0000b")).toBe("ab");
  expect(cleanAppName("x".repeat(24))).toHaveLength(24);
  for (const bad of ["", "   ", "x".repeat(25), 5, null, undefined, "<>\"`"]) expect(cleanAppName(bad)).toBe("");
});

test("Ersetzen: ganze Wörter, Mehrfachtreffer, Bindestrich-Wörter; Standardname und macOS-App-Name bleiben", () => {
  expect(brand("Frag Jarvis", "Hugo")).toBe("Frag Hugo");
  expect(brand("Jarvis kann Fehler machen. Jarvis!", "Hugo")).toBe("Hugo kann Fehler machen. Hugo!");
  expect(brand("Jarvis-Dienst nicht erreichbar", "Hugo")).toBe("Hugo-Dienst nicht erreichbar");
  expect(brand("„Jarvis Bildschirm“ erlauben, damit Jarvis sieht", "Hugo")).toBe("„Jarvis Bildschirm“ erlauben, damit Hugo sieht");
  expect(brand("Frag Jarvis", "Jarvis")).toBe("Frag Jarvis"); expect(brand("Frag Jarvis", "")).toBe("Frag Jarvis");
  expect(brand("Jarvisch und MeinJarvis", "Hugo")).toBe("Jarvisch und MeinJarvis");      // nur das ganze Wort
  expect(brand("Preis $& \\1", "Jarvis")).toBe("Preis $& \\1");
  expect(brand("Hallo Jarvis", "$&-Bot")).toBe("Hallo $&-Bot");                          // Sonderzeichen im Namen bleiben wörtlich
  expect(brand(undefined, "Hugo")).toBe("");
});
