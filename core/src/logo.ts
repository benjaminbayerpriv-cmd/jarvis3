// Logo der App: ein vom Nutzer hochgeladenes Bild (PNG) in ~/.jarvis3/logo.png. Drei Zustände: Standard (kein Logo in der Seitenleiste, eingebautes
// Symbol im Tab), eigenes Logo (Version > 0), „kein Logo“ (Marker logo.none, Version -1: auch das Tab-Symbol bleibt leer).
// Die Oberfläche verkleinert das Bild vor dem Hochladen auf höchstens 256 px und sendet PNG; hier wird alles noch einmal streng geprüft.
import { existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const LOGO_MAX_BYTES = 1024 * 1024;
export const LOGO_MAX_SIDE = 1024;
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Prüft ein PNG (Signatur, IHDR, Größe, Seitenlängen) und gibt Breite und Höhe zurück. Wirft einen verständlichen Fehler. */
export function checkPng(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > LOGO_MAX_BYTES) throw new Error("Das Logo ist zu groß (höchstens 1 MB)");
  if (bytes.length < 33 || PNG.some((b, i) => bytes[i] !== b)) throw new Error("Das Logo muss ein PNG-Bild sein");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.slice(12, 16)) !== "IHDR") throw new Error("Das Logo ist kein gültiges PNG");
  const width = view.getUint32(16), height = view.getUint32(20);
  if (!width || !height || width > LOGO_MAX_SIDE || height > LOGO_MAX_SIDE) throw new Error(`Das Logo darf höchstens ${LOGO_MAX_SIDE} × ${LOGO_MAX_SIDE} Pixel groß sein`);
  return { width, height };
}

export class LogoStore {
  private file: string; private marker: string;
  constructor(readonly dir: string) { this.file = join(dir, "logo.png"); this.marker = join(dir, "logo.none"); }
  /** Eigenes Logo: Version zum Zwischenspeichern (> 0); Standard: 0; ausdrücklich kein Logo: -1. */
  version(): number { try { return existsSync(this.file) ? Math.max(1, Math.round(statSync(this.file).mtimeMs)) : existsSync(this.marker) ? -1 : 0; } catch { return 0; } }
  save(base64: unknown): number {
    if (typeof base64 !== "string" || base64.length > Math.ceil(LOGO_MAX_BYTES * 4 / 3) + 8 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new Error("Das Logo konnte nicht gelesen werden");
    const bytes = Buffer.from(base64, "base64");
    checkPng(bytes);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.file, bytes, { mode: 0o600 });
    try { unlinkSync(this.marker); } catch { /* kein Marker */ }
    return this.version();
  }
  /** Entfernt das eigene Logo. none=true: ausdrücklich kein Logo (auch kein Tab-Symbol), sonst zurück zum Standard. */
  clear(none = false) {
    for (const f of [this.file, this.marker]) { try { unlinkSync(f); } catch (e: any) { if (e.code !== "ENOENT") throw e; } }
    if (none) { mkdirSync(this.dir, { recursive: true }); writeFileSync(this.marker, "", { mode: 0o600 }); }
  }
  file_() { return Bun.file(this.file); }
}
