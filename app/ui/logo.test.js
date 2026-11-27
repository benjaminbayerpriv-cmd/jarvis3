import { expect, test } from "bun:test";
import { MAX_FILE, checkLogoFile, fitSize, logoUrl } from "./logo.js";

test("Größe: verkleinern bis 256 px, Seitenverhältnis bleibt, nie vergrößern", () => {
  expect(fitSize(1024, 512)).toEqual({ width: 256, height: 128 });
  expect(fitSize(300, 900)).toEqual({ width: 85, height: 256 });
  expect(fitSize(100, 40)).toEqual({ width: 100, height: 40 });
  expect(fitSize(1, 1000)).toEqual({ width: 1, height: 256 });
  expect(fitSize(0, 10)).toEqual({ width: 0, height: 0 });
});
test("Datei prüfen: nur Bilder, höchstens 8 MB", () => {
  expect(checkLogoFile(null)).toContain("Keine Datei");
  expect(checkLogoFile({ type: "image/png", size: 10 })).toBe("");
  expect(checkLogoFile({ type: "image/svg+xml", size: 10 })).toBe("");
  expect(checkLogoFile({ type: "application/pdf", size: 10 })).toContain("kein Bild");
  expect(checkLogoFile({ type: "", size: 10 })).toContain("kein Bild");
  expect(checkLogoFile({ type: "image/png", size: MAX_FILE + 1 })).toContain("zu groß");
});
test("Adresse nur mit Logo", () => {
  expect(logoUrl("127.0.0.1:7777", 0)).toBe(""); expect(logoUrl("127.0.0.1:7777", 5)).toBe("http://127.0.0.1:7777/logo?v=5");
});
