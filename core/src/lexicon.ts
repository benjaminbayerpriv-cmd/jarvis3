// Wortliste für die Spracherkennung (Denglisch). Parakeet versteht Deutsch und Englisch, verhört sich aber bei
// deutschen Wörtern in englischen Sätzen und bei Programmnamen ("Systemeinstellungen" -> "system install engine").
// Zwei Mechanismen, beide ohne Verzögerung:
//   1. Ersetzungen: feste Muster (Regex) -> Text, für bekannte Verhörer und Satzzusammenhänge.
//   2. Begriffe: Wörter, die ähnlich klingende Verhörer (1–2 Buchstaben daneben) automatisch ersetzen.
// Eigene Ergänzungen: ~/.jarvis3/lexicon.json (wird bei Änderung automatisch neu gelesen), Format siehe docs/lexicon.md.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";

export interface Rule { von: string; nach: string }
export interface Lexicon { begriffe: string[]; ersetzungen: Rule[] }
export interface Result { text: string; changes: [string, string][] }

/** Eingebaute Ersetzungen (Groß-/Kleinschreibung egal). Nur Fälle, die wirklich vorkamen oder sehr wahrscheinlich sind. */
export const BUILTIN_RULES: Rule[] = [
  // bei der Messung verhört
  { von: "\\bsystem[ -]?install(?:ation)?[ -]?engine\\b", nach: "Systemeinstellungen" },
  { von: "\\bsystem[ -]?einstellung(?:en)?\\b", nach: "Systemeinstellungen" },
  { von: "\\bsystem settings\\b(?= (?:for|bitte|öffnen))", nach: "Systemeinstellungen" },
  { von: "\\b(?:tapp|tabb|tep)\\b", nach: "Tab" },
  // Anrede
  { von: "\\b(?:jervis|jarwis|jarvas|jarvice|gervis|dscharvis|tscharvis|charvis|harvis|yarvis)\\b", nach: "Jarvis" },
  // Programme und Dienste
  { von: "\\bgmini\\b|\\bgemeni\\b|\\bjemini\\b|\\bdschemini\\b|\\bgeminy\\b", nach: "Gemini" },
  { von: "\\byou[ -]?tube\\b|\\bjutub\\b|\\bu[ -]tube\\b", nach: "YouTube" },
  { von: "\\bgit[ -]?hub\\b", nach: "GitHub" },
  { von: "\\bopen[ -]code\\b", nach: "OpenCode" },
  { von: "\\bkodex\\b|\\bcodecs\\b(?= (?:app|fenster|chat|task))", nach: "Codex" },
  // "Claude" wird oft als "Cloud" verstanden. Das echte Wort "Cloud" bleibt, wenn der Zusammenhang nicht passt.
  { von: "\\bcloud[ -]?(code|desktop|app|chat|fenster)\\b", nach: "Claude $1" },
  // \\b kennt keine Umlaute (vor "öffne" gäbe es keine Wortgrenze): Unicode-Grenzen mit Lookbehind/-ahead
  { von: "(?<![\\p{L}\\d])(öffne|starte|geh in|gehe in|geh auf|gehe auf|nimm|wechsel zu|wechsle zu)( die| den| das)? cloud(?![\\p{L}\\d])(?! (?:storage|speicher|server|computing))", nach: "$1$2 Claude" },
  { von: "\\b(?:chrom|krom|chroom)\\b", nach: "Chrome" },
  // typische Begriffe
  { von: "\\bpull[ -]?request\\b|\\bpul request\\b", nach: "Pull Request" },
  { von: "\\bmain[ -]?branch\\b", nach: "Main Branch" },
  { von: "\\bmack ?book\\b|\\bmäc ?buch\\b", nach: "MacBook" },
  { von: "\\bhinter grundbild\\b|\\bhintergrund bild\\b", nach: "Hintergrundbild" },
];

/** Eingebaute Begriffe: knappe Verhörer (1 Buchstabe, bei langen Wörtern 2) werden automatisch auf sie korrigiert. */
export const BUILTIN_TERMS = [
  "Jarvis", "Gemini", "YouTube", "GitHub", "Systemeinstellungen", "Hintergrundbild", "Chrome", "Claude", "Codex", "OpenCode",
  "Browser", "Download", "Desktop", "Screenshot", "Tabgruppe", "Pull Request", "MacBook", "Obsidian", "Spotify", "WhatsApp",
];

/** Wortliste für die Spracherkennung (Whisper-Startprompt): eingebaute und eigene Begriffe, kurz gehalten. */
export function recognitionPrompt(): string {
  const terms = [...new Set([...BUILTIN_TERMS, ...loadUser().begriffe])];
  return terms.join(", ").slice(0, 500);
}

const USER_FILE = () => process.env.JARVIS_LEXICON ?? join(homedir(), ".jarvis3", "lexicon.json");
let cache: { mtime: number; lex: Lexicon } | undefined;

/** Lädt eigene Ergänzungen; fehlerhafte Datei wird ignoriert (die Erkennung darf daran nie scheitern). */
export function loadUser(): Lexicon {
  const file = USER_FILE();
  try {
    if (!existsSync(file)) return { begriffe: [], ersetzungen: [] };
    const mtime = statSync(file).mtimeMs;
    if (cache?.mtime === mtime) return cache.lex;
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const lex: Lexicon = {
      begriffe: Array.isArray(raw.begriffe) ? raw.begriffe.filter((x: unknown) => typeof x === "string") : [],
      ersetzungen: Array.isArray(raw.ersetzungen) ? raw.ersetzungen.filter((r: any) => typeof r?.von === "string" && typeof r?.nach === "string") : [],
    };
    cache = { mtime, lex };
    return lex;
  } catch { return { begriffe: [], ersetzungen: [] }; }
}

/** Abstand zweier Wörter (Einfügen, Löschen, Ersetzen = je 1), ohne Groß-/Kleinschreibung, bricht bei > max ab. */
export function distance(a: string, b: string, max = 3): number {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Wörter, die zwar ähnlich aussehen, aber echte Wörter sind und nie "korrigiert" werden dürfen. */
const KEEP = new Set(["gemeine", "gemein", "tag", "tage", "tabs", "tab", "chrome", "browser", "claude", "download", "downloads", "desktop",
  "codec", "codecs", "jarvis"].map(w => w.toLowerCase()));

export function correct(text: string, user: Lexicon = loadUser()): Result {
  const changes: [string, string][] = [];
  let out = text;
  for (const r of [...BUILTIN_RULES, ...user.ersetzungen]) {
    let re: RegExp;
    try { re = new RegExp(r.von, "giu"); } catch { continue; }
    out = out.replace(re, (m, ...args) => {
      // $1/$2 aus den Gruppen einsetzen (fehlende Gruppen = leer)
      const groups = args.slice(0, -2).filter(a => typeof a === "string" || a === undefined) as (string | undefined)[];
      const res = r.nach.replace(/\$(\d)/g, (_, n) => groups[Number(n) - 1] ?? "");
      if (res !== m) changes.push([m, res]);
      return res;
    });
  }
  // Begriffe: ähnlich geschriebene Einzelwörter (nur Wörter ab 5 Buchstaben, Mehrwort-Begriffe nur über Ersetzungen)
  const terms = [...new Set([...BUILTIN_TERMS, ...user.begriffe])].filter(t => !/\s/.test(t) && t.length >= 6);
  out = out.replace(/[\p{L}\p{N}-]{5,}/gu, word => {
    if (KEEP.has(word.toLowerCase())) return word;
    for (const t of terms) {
      if (word === t) return word;
      const max = t.length >= 12 ? 2 : 1;
      if (word.toLowerCase() !== t.toLowerCase() && distance(word, t, max) <= max) { changes.push([word, t]); return t; }
      if (word.toLowerCase() === t.toLowerCase() && word !== t) { changes.push([word, t]); return t; } // nur Schreibweise (youtube -> YouTube)
    }
    return word;
  });
  return { text: out, changes };
}
