import { test, expect } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepare, validate, hasImages, LIMITS } from "./attachments";

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const dir = () => mkdtempSync(join(tmpdir(), "jarvis-att-"));

test("Textdatei wird eingebettet und im Ordner abgelegt", async () => {
  const d = dir();
  const p = await prepare([{ name: "notiz.md", mime: "text/markdown", data: b64("# Hallo\nWelt") }], d, false);
  expect(p.text).toContain("# Hallo");
  expect(p.images).toHaveLength(0);
  expect(readdirSync(d)[0]).toMatch(/notiz\.md$/);
});

test("Bild geht nur an Modelle mit Bildverständnis, sonst als Pfad", async () => {
  const png = { name: "foto.png", mime: "image/png", data: b64(new Uint8Array([137, 80, 78, 71])) };
  expect(hasImages([png])).toBe(true);
  const sees = await prepare([png], dir(), true);
  expect(sees.images[0].url).toStartWith("data:image/png;base64,");
  const blind = await prepare([png], dir(), false);
  expect(blind.images).toHaveLength(0);
  expect(blind.text).toContain("nicht sehen");
});

test("Binärdatei: Pfad, Hinweis und Fehler-Eintrag", async () => {
  const p = await prepare([{ name: "a.zip", mime: "application/zip", data: b64(new Uint8Array([80, 75, 0, 3])) }], dir(), true);
  expect(p.text).toContain("liegt unter");
  expect(p.notes).toHaveLength(1);
  expect(p.problems).toHaveLength(1);
});

test("Pfadzeichen im Dateinamen werden entschärft", async () => {
  const d = dir();
  await prepare([{ name: "..\..\evil/x.txt", mime: "text/plain", data: b64("x") }], d, false);
  expect(readdirSync(d)).toHaveLength(1);
});

test("Grenzen", () => {
  const big = { name: "gross.bin", mime: "", data: "A".repeat(Math.ceil((LIMITS.fileBytes + 10) * 4 / 3)) };
  expect(validate([big])).toContain("größer");
  expect(validate(Array.from({ length: LIMITS.files + 1 }, () => ({ name: "a", mime: "", data: "" })))).toContain("Höchstens");
  expect(validate([{ name: "ok.txt", mime: "text/plain", data: b64("hi") }])).toBeUndefined();
});
