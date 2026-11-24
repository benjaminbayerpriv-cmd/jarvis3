// Zusätze für den Jarvis-MCP-Server (mcp.ts), die jeder MCP-Client nutzen kann, vor allem Hermes:
//  1. Annotationen (readOnlyHint, destructiveHint, openWorldHint). Hermes fragt bei Servern mit `trust: untrusted` vor jedem Werkzeug ohne
//     readOnlyHint nach; ohne Annotationen würde dann jedes Lesen genehmigt werden müssen.
//  2. Abbruch: Bricht der Client einen Aufruf ab (Hermes: Nutzer stoppt den Lauf), wird auch die Anfrage an jarvisd abgebrochen und
//     optional (JARVIS_STOP_ON_CANCEL=1) der gemeinsame Not-Aus (POST /stop) ausgelöst, damit keine halbe Aktion weiterläuft.
//  3. Fehler als Text: Hermes zählt jedes Fehlerergebnis (isError) als „Strike“ gegen den Server und sperrt ihn nach 3 in Folge für 60 s
//     (Circuit Breaker, mcp_tool_handlers.py). Bei Jarvis sind Absagen normal (Computer-Steuerung aus, Not-Aus, Passwortfeld gesperrt,
//     veraltete ID): Drei davon hintereinander würden sonst ALLE Jarvis-Werkzeuge für eine Minute sperren. Darum liefert der Server
//     solche Meldungen für Hermes als normalen Text („Fehler: …“, das Modell liest sie trotzdem); andere Clients bekommen weiter isError.
import { AsyncLocalStorage } from "node:async_hooks";

export type Hint = { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };

/** Nur lesen: ändert nichts am Bildschirm, in Seiten oder in Projekten. */
const READ_ONLY = new Set(["desktop_displays", "desktop_windows", "desktop_scan", "desktop_read", "desktop_look", "browser_tab_list", "browser_scan",
  "browser_read", "browser_look", "project_list", "skill_list", "skill_read"]);
/** Löscht oder schließt etwas, das sich nicht einfach zurückholen lässt. */
const DESTRUCTIVE = new Set(["project_delete", "browser_tab_close", "browser_tab_release"]);

export function hintFor(name: string): Hint {
  const outside = name.startsWith("desktop_") || name.startsWith("browser_");       // wirkt auf Programme und Webseiten außerhalb von Jarvis
  if (READ_ONLY.has(name)) return { readOnlyHint: true, openWorldHint: outside };
  return { readOnlyHint: false, destructiveHint: DESTRUCTIVE.has(name), openWorldHint: outside };
}

export type CallContext = { signal?: AbortSignal; tool: string };
export const callContext = new AsyncLocalStorage<CallContext>();

/** Hängt Annotationen an alle registrierten Werkzeuge und führt jeden Aufruf in einem Kontext mit dem Abbruch-Signal des Clients aus. */
export function applyToolHints(server: unknown, { onCancel, errorsAsText }: { onCancel?: (tool: string) => void; errorsAsText?: () => boolean } = {}) {
  const tools = (server as { _registeredTools?: Record<string, { annotations?: Hint; handler: (...a: any[]) => any }> })._registeredTools ?? {};
  for (const [name, tool] of Object.entries(tools)) {
    tool.annotations = { ...hintFor(name), ...tool.annotations };
    const original = tool.handler;
    tool.handler = (...args: any[]) => {
      const extra = args.at(-1) as { signal?: AbortSignal } | undefined;      // Werkzeuge ohne Parameter bekommen nur `extra`
      const signal = extra?.signal;
      if (signal && onCancel) signal.addEventListener("abort", () => onCancel(name), { once: true });
      return Promise.resolve(callContext.run({ signal, tool: name }, () => original(...args))).then(out => {
        if (out && typeof out === "object" && out.isError && errorsAsText?.()) { const { isError: _drop, ...plain } = out; return plain; }
        return out;
      });
    };
  }
  return Object.keys(tools).length;
}
