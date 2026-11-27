import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOGO_MAX_BYTES, LogoStore, checkPng } from "./logo";

// 1×1 PNG (rot)
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const png = (w: number, h: number) => { const b = Buffer.from(PIXEL, "base64"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };

test("PNG-Prüfung: Signatur, Kopf, Größe und Seitenlängen", () => {
  expect(checkPng(Buffer.from(PIXEL, "base64"))).toEqual({ width: 1, height: 1 });
  expect(checkPng(png(1024, 512))).toEqual({ width: 1024, height: 512 });
  expect(() => checkPng(png(1025, 10))).toThrow("höchstens 1024");
  expect(() => checkPng(png(0, 10))).toThrow("höchstens 1024");
  expect(() => checkPng(Buffer.from("<svg onload=alert(1)></svg>".padEnd(60)))).toThrow("PNG-Bild");
  expect(() => checkPng(Buffer.from("GIF89a".padEnd(60)))).toThrow("PNG-Bild");
  expect(() => checkPng(new Uint8Array(LOGO_MAX_BYTES + 1))).toThrow("zu groß");
  const bad = png(8, 8); bad.write("XXXX", 12); expect(() => checkPng(bad)).toThrow("kein gültiges PNG");
});

test("Logo speichern, ersetzen, entfernen; Datei nur für den Nutzer lesbar; ohne Logo Version 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "logo-"));
  const store = new LogoStore(dir);
  expect(store.version()).toBe(0);
  const v = store.save(PIXEL);
  expect(v).toBeGreaterThan(0); expect(store.version()).toBe(v);
  expect(readdirSync(dir)).toEqual(["logo.png"]); expect(statSync(join(dir, "logo.png")).mode & 0o077).toBe(0);
  expect(new LogoStore(dir).version()).toBe(v);                    // bleibt nach Neustart
  store.save(png(64, 64).toString("base64")); expect(store.version()).toBeGreaterThan(0);
  store.clear(); expect(store.version()).toBe(0); expect(readdirSync(dir)).toEqual([]);      // zurück zum Standard
  store.clear();                                                    // zweimal löschen ist kein Fehler
  store.clear(true); expect(store.version()).toBe(-1); expect(readdirSync(dir)).toEqual(["logo.none"]);   // ausdrücklich kein Logo
  expect(new LogoStore(dir).version()).toBe(-1);
  store.save(PIXEL); expect(store.version()).toBeGreaterThan(0); expect(readdirSync(dir)).toEqual(["logo.png"]);   // ein neues Logo hebt „kein Logo“ auf
  store.clear(true); store.clear(); expect(store.version()).toBe(0);
});

test("Ungültige Eingaben werden abgelehnt und ändern nichts", () => {
  const dir = mkdtempSync(join(tmpdir(), "logo-")); const store = new LogoStore(dir);
  for (const bad of [undefined, 5, "", "kein base64!!", "A".repeat(2_000_000), Buffer.from("hallo welt, kein bild".padEnd(60)).toString("base64"), png(5000, 5000).toString("base64")])
    expect(() => store.save(bad)).toThrow();
  expect(store.version()).toBe(0);
  store.save(PIXEL); expect(() => store.save("kaputt!")).toThrow(); expect(store.version()).toBeGreaterThan(0);   // das alte Logo bleibt
});
