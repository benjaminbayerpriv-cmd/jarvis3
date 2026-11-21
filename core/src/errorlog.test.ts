import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { recordError, listErrors, resolveError, fnv, errorId, markPng, toImageBox } from "./errorlog";

beforeEach(() => { process.env.JARVIS_ERRORS_DIR = mkdtempSync(join(tmpdir(), "jarvis-errors-")); });

// Kleines RGB-PNG (Filter 0) ohne Zusatzpakete erzeugen; die CRC prüft der Decoder nicht.
function png(w: number, h: number, rgb = [255, 255, 255]) {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(rgb, y * (w * 3 + 1) + 1 + x * 3);
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length), d = new DataView(b.buffer);
    d.setUint32(0, data.length); b.set(new TextEncoder().encode(type), 4); b.set(data, 8); return b;
  };
  const ihdr = new Uint8Array(13); const v = new DataView(ihdr.buffer);
  v.setUint32(0, w); v.setUint32(4, h); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())]);
}
function pixel(p: Uint8Array, x: number, y: number) {
  const w = new DataView(p.buffer, p.byteOffset).getUint32(16);
  const len = new DataView(p.buffer, p.byteOffset).getUint32(33);
  const raw = inflateSync(p.subarray(41, 41 + len));
  const o = y * (w * 3 + 1) + 1 + x * 3;
  return [...raw.subarray(o, o + 3)];
}

test("FNV-IDs sind dieselben wie in Python und Rust", () => {
  expect(fnv("abc")).toBe("e71fa2190541");
  expect(errorId("tool", "browser/click", "Tab 12 nicht gefunden")).toBe(errorId("tool", "browser/click", "Tab 998 nicht gefunden"));
});

test("gleiche Fehler werden gezählt, Kontext bleibt aktuell, Geheimnisse fliegen raus", () => {
  recordError({ category: "model", source: "opencode/prompt", message: "429 rate limit", context: { model: "a", apiKey: "geheim" } });
  const e = recordError({ category: "model", source: "opencode/prompt", message: "429 rate limit", context: { model: "b" } })!;
  expect(e.count).toBe(2);
  expect(e.context.model).toBe("b");
  const list = listErrors();
  expect(list).toHaveLength(1);
  expect(JSON.stringify(list)).not.toContain("geheim");
  recordError({ category: "speech", source: "speech/sidecar", message: "Mikrofon fehlt", context: { apiKey: "geheim" } });
  expect(JSON.stringify(listErrors("speech"))).not.toContain("geheim");
  expect(listErrors("speech")).toHaveLength(1);
});

test("resolve löscht Eintrag und Screenshot", () => {
  const e = recordError({ category: "tool", source: "browser/click", message: "Element weg", screenshot: png(4, 4) })!;
  const dir = process.env.JARVIS_ERRORS_DIR!;
  expect(existsSync(join(dir, `${e.id}.png`))).toBe(true);
  expect(resolveError(e.id)).toBe(true);
  expect(existsSync(join(dir, `${e.id}.json`))).toBe(false);
  expect(existsSync(join(dir, `${e.id}.png`))).toBe(false);
  expect(resolveError(e.id)).toBe(false);
  expect(resolveError("../../etwas")).toBe(false);
});

test("markPng zeichnet einen roten Rahmen um die Fehlerstelle", () => {
  const src = png(40, 30);
  const out = markPng(src, [[10, 10, 10, 8]], 2);
  expect(pixel(out, 9, 12)).toEqual([255, 0, 40]);   // linker Rand
  expect(pixel(out, 15, 14)).toEqual([255, 255, 255]); // Innenfläche bleibt frei
  expect(pixel(out, 0, 0)).toEqual([255, 255, 255]);
  expect(markPng(src, [])).toBe(src);
});

test("toImageBox rechnet Koordinaten in Bildpixel um (Retina = Faktor 2)", () => {
  expect(toImageBox(png(200, 100), [0, 0, 100, 50], [10, 20, 30, 5])).toEqual([20, 40, 60, 10]);
  expect(toImageBox(png(100, 50), [50, 50, 100, 50], [60, 70, 10, 10])).toEqual([10, 20, 10, 10]);
});

test("Fehlerdatei ist lesbares JSON mit allen Pflichtfeldern", () => {
  const e = recordError({ category: "daemon", source: "jarvisd/crash", message: "boom", error: new Error("boom") })!;
  const j = JSON.parse(readFileSync(join(process.env.JARVIS_ERRORS_DIR!, `${e.id}.json`), "utf8"));
  for (const k of ["id", "category", "source", "message", "context", "firstSeen", "lastSeen", "count", "stack"]) expect(j).toHaveProperty(k);
});
