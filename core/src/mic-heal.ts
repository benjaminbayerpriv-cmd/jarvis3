// Selbstheilung, wenn das Mikrofon stumm ist (Pegel exakt 0). Stufen, jede nur einmal pro Versuch:
//   1. Sprach-Sidecar neu starten (liest Geräte frisch ein, startet ihn sauber unter launchd)
//   2. nacheinander andere echte Eingabegeräte probieren (Systemstandard zuerst, virtuelle Mikrofone zuletzt)
//   3. aufgeben und dem Nutzer die Lage erklären
export interface InputDevice { id: number; name: string; default: boolean }
export type MicStep =
  | { action: "restart" }
  | { action: "device"; id: number; name: string }
  | { action: "giveup" };

/** Pegel darunter gilt als "kein Signal": Meldungen sind auf 3 Stellen gerundet, ein stilles Zimmer liefert trotzdem > 0. */
export const DEAD_LEVEL = 0.001;

const VIRTUAL = /virtu|virtual|blackhole|loopback|soundflower|zoom|teams|aggregate|ndi|obs|iphone|ipad/i;

/** Nächster Schritt; `tried` enthält bereits probierte Geräte-IDs (das aktuelle gehört dazu). */
export function nextMicStep(restarted: boolean, devices: InputDevice[], tried: ReadonlySet<number | null>): MicStep {
  if (!restarted) return { action: "restart" };
  const rank = (d: InputDevice) => (VIRTUAL.test(d.name) ? 2 : d.default ? 0 : 1);
  const next = devices.filter(d => !tried.has(d.id)).sort((a, b) => rank(a) - rank(b) || a.id - b.id)[0];
  return next ? { action: "device", id: next.id, name: next.name } : { action: "giveup" };
}
