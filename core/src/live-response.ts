import { clean } from "./speech";

export type Corner = "oben links" | "oben rechts" | "unten links" | "unten rechts";
export type ClickIntent = { corner?: Corner; app?: string; followUp: boolean; english: boolean };

export function requestedClick(text: string): ClickIntent | undefined {
  const request = text.trim().replace(/^(?:(?:ja|ok(?:ay)?|bitte)\b[\s,.]+)+/i, "");
  if (!/^(?:klick(?:e)?|click|(?:kannst|könntest) du\b[^.!?]*\bklicken)\b/i.test(request)) return;
  if (/\b(?:was passiert|was würde|wie|nicht klicken)\b/i.test(request) || /[.!?]\s+\S/.test(request)
    || /\b(?:und dann|danach|anschließend|then)\b/i.test(request)) return;
  const match = request.match(/\b(oben|unten|top|bottom)[ -]+(links|rechts|left|right)\b/i);
  let corner: Corner | undefined;
  if (match) {
    const vertical = /oben|top/i.test(match[1]) ? "oben" : "unten";
    const horizontal = /links|left/i.test(match[2]) ? "links" : "rechts";
    corner = `${vertical} ${horizontal}`;
  }
  const followUp = /^(?:klick(?:e)?|click)(?:\s+(?:einfach|bitte|weiter|drauf|nochmal|noch mal|again|it|please))*[,.! ]*(?:reicht[.! ]*)?$/i.test(request);
  return { corner, app: /\bDiscord\b/i.test(request) && !/\b(?:Browser|Webseite|Discord-Web|discord\.com)\b/i.test(request) ? "Discord" : undefined, followUp, english: /^click\b/i.test(request) };
}

export function relativeCenter(rect: unknown, bounds: unknown) {
  if (!Array.isArray(rect) || !Array.isArray(bounds) || rect.length !== 4 || bounds.length !== 4
    || !rect.every(Number.isFinite) || !bounds.every(Number.isFinite)
    || rect[2] <= 0 || rect[3] <= 0 || bounds[2] <= 0 || bounds[3] <= 0) return;
  return [(rect[0] + rect[2] / 2 - bounds[0]) / bounds[2], (rect[1] + rect[3] / 2 - bounds[1]) / bounds[3]];
}

export function inCorner(rect: unknown, bounds: unknown, corner: Corner) {
  const center = relativeCenter(rect, bounds);
  if (!center) return false;
  const [x, y] = center;
  if (x < 0 || y < 0 || x > 1 || y > 1) return false;
  return (corner.endsWith("links") ? x <= 0.4 : x >= 0.6) && (corner.startsWith("oben") ? y <= 0.35 : y >= 0.65);
}

export function clickOutcome(intent: ClickIntent, sent: boolean) {
  if (intent.english) return sent ? "I sent the click, but couldn't confirm the result." : "I couldn't reliably click the target.";
  return sent ? "Ich habe den Klick gesendet. Die Reaktion konnte ich nicht prüfen." : "Ich konnte das Ziel nicht sicher anklicken.";
}

export function conciseSpeech(answer: string, request: string) {
  const readAloud = /\b(?:lies|lese)\b.*\bvor\b|\b(?:read aloud|vorlesen)\b/i.test(request);
  const wantsDetails = /\b(?:koordinaten|coordinates|elementnummer|element.?id|elementnummern|pixelposition)\b/i.test(request);
  const sentences = clean(answer).match(/[^.!?…]+(?:[.!?…]+|$)/g) ?? [];
  const speakable = sentences.map(s => s.trim()).filter(s => s &&
    (wantsDetails || !/\b(?:koordinaten|coordinates|element\s*(?:[-#]?\s*id|#?\d+)|x\s*=|y\s*=)\b|\(\s*-?\d+\s*,\s*-?\d+\s*\)/i.test(s)));
  if (readAloud) return speakable.join(" ");
  const short = speakable.slice(0, 2).join(" ");
  if (short.length <= 240) return short;
  const end = short.lastIndexOf(" ", 237);
  return short.slice(0, end > 0 ? end : 237) + "…";
}
