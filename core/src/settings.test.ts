import { expect, test } from "bun:test";
import { DEFAULT_APP_NAME, cleanAppName, defaults, parseSettings } from "./settings";
import { SYSTEM_PROMPT, systemPrompt } from "./prompt";

test("App-Name: 1 bis 24 Zeichen, Leerraum zusammengezogen, Steuerzeichen und Tag-/Anführungszeichen entfernt", () => {
  expect(DEFAULT_APP_NAME).toBe("Jarvis"); expect(defaults.appName).toBe("Jarvis");
  expect(cleanAppName("  Hugo  ")).toBe("Hugo");
  expect(cleanAppName("Mein   Assistent")).toBe("Mein Assistent");
  expect(cleanAppName("<b>Max</b>")).toBe("bMax/b");
  expect(cleanAppName('Ro"bo`t\\')).toBe("Robot");
  expect(cleanAppName("a\u0000b\nc")).toBe("abc");
  expect(cleanAppName("x".repeat(24))).toHaveLength(24);
  for (const bad of ["", "   ", "x".repeat(25), 5, null, undefined, {}, "<>\"`"]) expect(cleanAppName(bad)).toBe("");
});

test("parseSettings übernimmt nur einen gültigen App-Namen", () => {
  expect(parseSettings({ appName: " Hugo " })).toEqual({ appName: "Hugo" });
  expect(parseSettings({ appName: "" })).toEqual({});
  expect(parseSettings({ appName: "x".repeat(40) })).toEqual({});
  expect(parseSettings({ appName: 42 })).toEqual({});
  expect(parseSettings({ appName: "Max" }, true)).toEqual({ appName: "Max" });
});

test("Modell-Anweisung: bei „Jarvis“ unverändert, sonst mit dem gewählten Namen", () => {
  expect(systemPrompt("Jarvis")).toBe(SYSTEM_PROMPT); expect(systemPrompt("")).toBe(SYSTEM_PROMPT);
  const p = systemPrompt("Hugo");
  expect(p.startsWith("Du bist Hugo,")).toBe(true);
  expect(p).toContain("Dein Name ist Hugo."); expect(p).toContain("Browser von Hugo");
  expect(p).toContain("Tab-Gruppe");                      // technische Namen bleiben erklärt
  expect(p.startsWith("Du bist Jarvis")).toBe(false);
});
