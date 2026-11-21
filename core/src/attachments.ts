// Anhänge aus der Oberfläche („+“): prüfen, im Arbeitsordner ablegen und für das Modell aufbereiten.
// Bilder gehen als Bildteil an Modelle mit Bildverständnis; Textdateien und PDFs werden als Text eingebettet;
// alles andere (und alles, was nicht lesbar war) liegt als Datei in workspace/uploads, das Modell bekommt den Pfad.
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export interface Attachment { name: string; mime: string; data: string } // data = Base64 (ohne data:-Präfix)

export const LIMITS = { files: 8, fileBytes: 10 * 1024 * 1024, totalBytes: 25 * 1024 * 1024, textChars: 60_000 };
const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp)$/;
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|yaml|yml|toml|ini|log|html?|css|scss|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|tex|rtf|srt|vtt|svg|env|cfg|conf)$/i;

export interface Prepared {
  text: string;                                   // Zusatz für die Nachricht ans Modell
  images: { mime: string; url: string }[];        // Bildteile (data:-URLs)
  imageNames: string[];
  notes: string[];                                // Hinweise für den Nutzer
  problems: { name: string; message: string; context?: Record<string, unknown> }[]; // für das Fehler-Log
}

const safeName = (n: string) => n.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/^\.+/, "").slice(0, 120) || "datei";
export const hasImages = (atts: Attachment[] = []) => atts.some(a => IMAGE_MIME.test(a.mime));

/** Prüft Anzahl und Größe; liefert eine Fehlermeldung oder undefined. */
export function validate(atts: Attachment[]): string | undefined {
  if (atts.length > LIMITS.files) return `Höchstens ${LIMITS.files} Anhänge pro Nachricht.`;
  let total = 0;
  for (const a of atts) {
    if (typeof a?.data !== "string" || typeof a?.name !== "string") return "Ungültiger Anhang.";
    const size = Math.floor(a.data.length * 3 / 4);
    if (size > LIMITS.fileBytes) return `„${a.name}“ ist größer als ${LIMITS.fileBytes / 1024 / 1024} MB.`;
    total += size;
  }
  if (total > LIMITS.totalBytes) return `Die Anhänge sind zusammen größer als ${LIMITS.totalBytes / 1024 / 1024} MB.`;
}

async function pdfText(path: string): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["pdftotext", "-layout", "-enc", "UTF-8", path, "-"], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => p.kill(), 15_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    return (await p.exited) === 0 && out.trim() ? out : undefined;
  } catch { return undefined; } // pdftotext nicht installiert
}

export async function prepare(atts: Attachment[], dir: string, canSeeImages: boolean): Promise<Prepared> {
  const out: Prepared = { text: "", images: [], imageNames: [], notes: [], problems: [] };
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const blocks: string[] = [];
  for (const [i, a] of atts.entries()) {
    const name = safeName(a.name);
    const path = join(dir, `${stamp}-${i + 1}-${name}`);
    let bytes: Buffer;
    try { bytes = Buffer.from(a.data, "base64"); writeFileSync(path, bytes); } catch (error) {
      out.problems.push({ name, message: `Anhang nicht gespeichert: ${(error as Error).message}` });
      out.notes.push(`„${name}“ konnte nicht gelesen werden.`);
      continue;
    }
    if (IMAGE_MIME.test(a.mime)) {
      if (canSeeImages) { out.images.push({ mime: a.mime, url: `data:${a.mime};base64,${a.data}` }); out.imageNames.push(name); }
      else blocks.push(`[Bild „${name}“ liegt unter ${path}. Du kannst es mit diesem Modell nicht sehen.]`);
      continue;
    }
    const isPdf = a.mime === "application/pdf" || /\.pdf$/i.test(name);
    let text: string | undefined;
    if (isPdf) text = await pdfText(path);
    else if (a.mime.startsWith("text/") || /json|xml|javascript|yaml/.test(a.mime) || TEXT_EXT.test(name)) {
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { /* kein UTF-8 */ }
      if (text?.includes("\0")) text = undefined;
    }
    if (text !== undefined) {
      const cut = text.length > LIMITS.textChars;
      blocks.push(`--- Datei „${name}“${cut ? ` (auf ${LIMITS.textChars} Zeichen gekürzt, vollständig unter ${path})` : ""} ---\n${text.slice(0, LIMITS.textChars)}\n--- Ende „${name}“ ---`);
      if (cut) out.notes.push(`„${name}“ ist lang und wurde gekürzt.`);
    } else {
      blocks.push(`[Datei „${name}“ (${a.mime || "unbekannter Typ"}, ${bytes.length} Bytes) liegt unter ${path}. Lies sie bei Bedarf mit deinen Werkzeugen.]`);
      out.notes.push(isPdf ? `Aus „${name}“ ließ sich kein Text lesen (gescanntes PDF oder pdftotext fehlt).`
        : `„${name}“ hat ein Format, das Jarvis nicht direkt liest; die Datei liegt im Arbeitsordner.`);
      out.problems.push({ name, message: "Anhang nicht als Text lesbar", context: { mime: a.mime, bytes: bytes.length, pdf: isPdf } });
    }
  }
  if (out.images.length) blocks.unshift(`[${out.images.length} Bild(er) angehängt: ${out.imageNames.join(", ")}]`);
  out.text = blocks.length ? "\n\nAngehängt vom Nutzer:\n" + blocks.join("\n\n") : "";
  return out;
}
