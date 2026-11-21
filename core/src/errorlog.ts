// Zentrales Fehler-Log (docs/errors.md): ein JSON pro Fehler in ~/.jarvis3/errors/, optional mit markiertem Screenshot.
// Gleiche Fehler (gleiche Kategorie, Quelle, Meldung ohne Zahlen) werden zusammengefasst und gezählt.
// Ist ein Fehler behoben, löscht `resolve` den Eintrag samt Screenshot – das Log enthält nur offene Fehler.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { inflateSync, deflateSync } from "node:zlib";

export type ErrorCategory = "speech" | "model" | "tool" | "daemon" | "app" | "extension" | "ui";
export const CATEGORIES: ErrorCategory[] = ["speech", "model", "tool", "daemon", "app", "extension", "ui"];

export interface ErrorEntry {
  id: string;
  category: ErrorCategory;
  source: string;            // z. B. "jarvisd/chat", "speech/endpoint", "browser/click"
  message: string;
  context: Record<string, unknown>; // Bedingungen: Modell, Anfrage, Modus, Werkzeug, Argumente …
  stack?: string;
  screenshot?: string;       // Dateiname im Fehlerordner (PNG, Fehlerstelle rot markiert)
  firstSeen: string;
  lastSeen: string;
  count: number;
}

export const errorDir = () => process.env.JARVIS_ERRORS_DIR ?? join(homedir(), ".jarvis3", "errors");

/** FNV-1a (64 bit) – dieselbe Funktion nutzen Sprach-Sidecar (Python) und App (Rust). */
export function fnv(s: string) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) h = BigInt.asUintN(64, (h ^ BigInt(b)) * 0x100000001b3n);
  return h.toString(16).padStart(16, "0").slice(0, 12);
}
export const errorId = (category: string, source: string, message: string) =>
  fnv(`${category}|${source}|${message.replace(/\d+/g, "#").slice(0, 300)}`);

const clip = (v: unknown, depth = 0): unknown => {
  if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + " […]" : v;
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.slice(0, 50).map(x => clip(x, depth + 1));
  return Object.fromEntries(Object.entries(v).filter(([k]) => !/password|passwort|token|secret|api.?key/i.test(k))
    .map(([k, x]) => [k, clip(x, depth + 1)]));
};

export interface RecordInput {
  category: ErrorCategory; source: string; message: string;
  context?: Record<string, unknown>; error?: unknown; screenshot?: Uint8Array;
}

/** Schreibt (oder zählt hoch) einen Fehler. Wirft nie – das Log darf selbst keinen Absturz auslösen. */
export function recordError(input: RecordInput): ErrorEntry | undefined {
  try {
    const dir = errorDir();
    mkdirSync(dir, { recursive: true });
    const message = String(input.message || (input.error as Error)?.message || input.error || "Unbekannter Fehler").slice(0, 2000);
    const id = errorId(input.category, input.source, message);
    const file = join(dir, `${id}.json`);
    const now = new Date().toISOString();
    const old: ErrorEntry | undefined = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
    const entry: ErrorEntry = {
      id, category: input.category, source: input.source, message,
      context: clip(input.context ?? {}) as Record<string, unknown>,
      stack: input.error instanceof Error ? input.error.stack?.slice(0, 4000) : old?.stack,
      screenshot: old?.screenshot,
      firstSeen: old?.firstSeen ?? now, lastSeen: now, count: (old?.count ?? 0) + 1,
    };
    if (input.screenshot) { writeFileSync(join(dir, `${id}.png`), input.screenshot); entry.screenshot = `${id}.png`; }
    writeFileSync(file, JSON.stringify(entry, null, 2));
    return entry;
  } catch (e) {
    console.error("Fehler-Log nicht schreibbar:", e);
    return undefined;
  }
}

export function listErrors(category?: string): ErrorEntry[] {
  const dir = errorDir();
  if (!existsSync(dir)) return [];
  const out: ErrorEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), "utf8"))); } catch { /* halb geschriebene Datei: beim nächsten Mal */ }
  }
  return out.filter(e => !category || e.category === category).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

/** Fehler ist behoben: Eintrag und Screenshot löschen. Liefert false, wenn die ID nicht (mehr) existiert. */
export function resolveError(id: string): boolean {
  if (!/^[0-9a-f]{12}$/.test(id)) return false;
  const dir = errorDir();
  const file = join(dir, `${id}.json`);
  if (!existsSync(file)) return false;
  try { unlinkSync(join(dir, `${id}.png`)); } catch { /* kein Screenshot */ }
  unlinkSync(file);
  return true;
}

// ---------- Screenshot markieren (PNG ohne Zusatzpakete) ----------
const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = (b: Uint8Array) => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };

/** Zeichnet rote Rahmen (Bildpixel [x,y,w,h]) in ein PNG (8 bit RGB/RGBA, nicht interlaced). Sonst unverändert zurück. */
export function markPng(png: Uint8Array, boxes: number[][], thickness = 4): Uint8Array {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8, width = 0, height = 0, bpp = 0;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = view.getUint32(pos), type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = view.getUint32(pos + 8); height = view.getUint32(pos + 12);
      const depth = data[8], color = data[9], interlace = data[12];
      if (depth !== 8 || interlace !== 0 || (color !== 2 && color !== 6)) return png;
      bpp = color === 6 ? 4 : 3;
    }
    if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  if (!bpp || !boxes.length) return png;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) { // Zeilenfilter rückgängig machen
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = px.subarray(y * stride, (y + 1) * stride), up = y ? px.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      row[i] = (src[i] + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 0xff;
    }
  }
  const paint = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const o = y * stride + x * bpp; px[o] = 255; px[o + 1] = 0; px[o + 2] = 40; if (bpp === 4) px[o + 3] = 255;
  };
  for (const [bx, by, bw, bh] of boxes.map(b => b.map(Math.round))) {
    for (let t = -thickness; t < 0; t++) {
      for (let x = bx + t; x <= bx + bw - t; x++) { paint(x, by + t); paint(x, by + bh - t); }
      for (let y = by + t; y <= by + bh - t; y++) { paint(bx + t, y); paint(bx + bw - t, y); }
    }
  }
  const out = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) out.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const b = new Uint8Array(12 + data.length), d = new DataView(b.buffer);
    d.setUint32(0, data.length); b.set(new TextEncoder().encode(type), 4); b.set(data, 8);
    d.setUint32(8 + data.length, crc32(b.subarray(4, 8 + data.length)));
    return b;
  };
  const ihdr = png.subarray(16, 29);
  return Buffer.concat([png.subarray(0, 8), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(out)), chunk("IEND", new Uint8Array())]);
}

/** Rechnet ein Element-Rechteck (Seiten-/Bildschirmkoordinaten) in Bildpixel eines Screenshots vom Bereich `shotRect` um. */
export function toImageBox(png: Uint8Array, shotRect: number[], box: number[]) {
  const w = new DataView(png.buffer, png.byteOffset).getUint32(16);
  const scale = shotRect[2] ? w / shotRect[2] : 1;
  return [(box[0] - shotRect[0]) * scale, (box[1] - shotRect[1]) * scale, box[2] * scale, box[3] * scale];
}
