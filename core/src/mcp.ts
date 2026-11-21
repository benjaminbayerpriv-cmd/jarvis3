// MCP-Server (stdio), den OpenCode startet. Leitet jedes Werkzeug an jarvisd (/tool) weiter.
// So sieht die KI Bedienelemente als Text und holt Bilder nur bei Bedarf (look).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { recordError } from "./errorlog";
import { readFileSync, unlinkSync } from "node:fs";

const JARVISD = process.env.JARVISD_URL ?? "http://127.0.0.1:7777";
const server = new McpServer({ name: "jarvis", version: "0.1.0" });

async function call(target: "desktop" | "browser", cmd: Record<string, unknown>) {
  try {
    const r = await fetch(`${JARVISD}/tool`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ target, cmd }) });
    return (await r.json()) as Record<string, any>;
  } catch (error) { // jarvisd nicht erreichbar: direkt ins Fehler-Log schreiben (gleiche Dateien)
    recordError({ category: "daemon", source: "mcp/call", message: `jarvisd nicht erreichbar: ${(error as Error)?.message ?? error}`, context: { target, cmd, url: JARVISD } });
    return { ok: false, error: "jarvisd nicht erreichbar" };
  }
}

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const result = (r: Record<string, any>) =>
  r.ok ? text(r.text ?? JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => k !== "rid"))))
       : { ...text(`Fehler: ${r.error}`), isError: true };

async function image(r: Record<string, any>) {
  if (!r.ok) return result(r);
  let data: string, mimeType = "image/png";
  if (r.dataUrl) { const [head, b64] = String(r.dataUrl).split(","); data = b64; mimeType = head.slice(5, head.indexOf(";")); }
  else { data = readFileSync(r.path).toString("base64"); try { unlinkSync(r.path); } catch {} }
  return { content: [{ type: "image" as const, data, mimeType }, { type: "text" as const, text: `Ausschnitt ${JSON.stringify(r.rect)}` }] };
}

const id = z.number().int().describe("Element-ID aus dem letzten scan");
const rect = z.array(z.number()).length(4).describe("[x, y, breite, höhe]");
const tab = z.number().int().describe("Tab-ID aus tab_open/tab_list");

// ---------- Desktop ----------
server.tool("desktop_scan", "Listet sichtbare Bedienelemente des Bildschirms als nummerierte Textliste. Immer zuerst benutzen.",
  {}, async () => result({ ...(await call("desktop", { cmd: "scan", text: true })), targets: undefined }));
server.tool("desktop_click", "Klickt ein Element per ID.", { id }, async a => result(await call("desktop", { cmd: "click", ...a })));
server.tool("desktop_type", "Schreibt Text in ein Feld per ID.", { id, text: z.string() },
  async a => result(await call("desktop", { cmd: "type", ...a })));
server.tool("desktop_scroll", "Scrollt an einem Element (dy Zeilen, positiv = runter).", { id, dy: z.number().int() },
  async a => result(await call("desktop", { cmd: "scroll", ...a })));
server.tool("desktop_read", "Liest Text eines Elements (id) oder eines Bildschirmbereichs (rect, per OCR).",
  { id: id.optional(), rect: rect.optional() }, async a => result(await call("desktop", { cmd: "read", ...a })));
server.tool("desktop_look", "Screenshot NUR wenn scan/read nicht reichen (Spiele, Grafiken, unklare Lage). marks=true zeichnet die IDs ein.",
  { rect: rect.optional(), marks: z.boolean().optional() }, async a => image(await call("desktop", { cmd: "shot", ...a })));
server.tool("desktop_key", "Drückt eine Tastenkombination, z. B. 'cmd+t', 'return', 'escape'.", { combo: z.string() },
  async a => result(await call("desktop", { cmd: "key", ...a })));
server.tool("desktop_open_app", "Öffnet ein Programm per Name.", { name: z.string() },
  async a => result(await call("desktop", { cmd: "open_app", ...a })));

// ---------- Browser (Tab-Gruppe „Jarvis“, im Hintergrund) ----------
server.tool("browser_tab_open", "Öffnet eine Seite im Hintergrund in der Tab-Gruppe Jarvis.", { url: z.string() },
  async a => result(await call("browser", { cmd: "tab_open", ...a })));
server.tool("browser_tab_list", "Listet die Tabs.", {}, async () => result(await call("browser", { cmd: "tab_list" })));
server.tool("browser_tab_adopt", "Übernimmt einen bereits offenen Tab des Nutzers in die Gruppe Jarvis, damit du ihn bedienen kannst. NUR auf ausdrückliche Bitte des Nutzers. Tab-ID aus browser_tab_list. Ist der Tab gerade der aktive, kannst du ihn nur lesen/scannen, nicht klicken oder tippen (dann den Nutzer bitten, kurz einen anderen Tab zu öffnen).",
  { tab }, async a => result(await call("browser", { cmd: "tab_adopt", ...a })));
server.tool("browser_tab_release", "Gibt einen übernommenen Tab wieder frei (aus der Gruppe Jarvis nehmen).", { tab },
  async a => result(await call("browser", { cmd: "tab_release", ...a })));
server.tool("browser_tab_close", "Schließt einen Jarvis-Tab.", { tab }, async a => result(await call("browser", { cmd: "tab_close", ...a })));
server.tool("browser_navigate", "Lädt eine URL im Tab.", { tab, url: z.string() },
  async a => result(await call("browser", { cmd: "navigate", ...a })));
server.tool("browser_back", "Zurück im Tab.", { tab }, async a => result(await call("browser", { cmd: "back", ...a })));
server.tool("browser_wait", "Wartet (ms) oder bis Text erscheint.", { tab, ms: z.number().optional(), for: z.string().optional() },
  async a => result(await call("browser", { cmd: "wait", ...a })));
server.tool("browser_scan", "Bedienelemente der Seite als nummerierte Textliste.", { tab },
  async a => result({ ...(await call("browser", { cmd: "scan", text: true, ...a })), targets: undefined }));
server.tool("browser_click", "Klickt ein Element der Seite.", { tab, id }, async a => result(await call("browser", { cmd: "click", ...a })));
server.tool("browser_type", "Schreibt in ein Feld der Seite. submit=true drückt danach Enter (z. B. Suchfeld absenden).",
  { tab, id, text: z.string(), submit: z.boolean().optional() },
  async a => result(await call("browser", { cmd: "type", ...a })));
server.tool("browser_scroll", "Scrollt die Seite oder ein Element.", { tab, id: id.optional(), dy: z.number().int() },
  async a => result(await call("browser", { cmd: "scroll", ...a })));
server.tool("browser_read", "Liest Text der Seite: ohne id/rect den gesamten sichtbaren Seitentext, sonst ein Element (id) oder einen Bereich (rect).",
  { tab, id: id.optional(), rect: rect.optional() },
  async a => {
    const whole = a.id === undefined && a.rect === undefined;
    const r = await call("browser", { cmd: "read", ...a, ...(whole ? { rect: [0, 0, 6000, 6000] } : {}) });
    if (r.ok && typeof r.text === "string" && r.text.length > 8000) r.text = r.text.slice(0, 8000) + "\n[… gekürzt]";
    return result(r);
  });
server.tool("browser_look", "Screenshot des Tabs, NUR wenn nötig.", { tab, rect: rect.optional(), marks: z.boolean().optional() },
  async a => image(await call("browser", { cmd: "shot", ...a })));

// ---------- Fehler-Log (docs/errors.md) ----------
server.tool("error_report", "Meldet einen Fehler ins zentrale Fehler-Log, wenn etwas nicht klappt und du es nicht selbst lösen kannst (Seite reagiert falsch, Element fehlt, Werkzeug liefert Unsinn). Bei Bildschirmbezug target angeben: es wird ein Screenshot gespeichert und die Stelle (id aus dem letzten scan oder rect) rot markiert.",
  { message: z.string().describe("Was ist schiefgegangen, was hast du erwartet?"),
    category: z.enum(["tool", "model", "speech", "daemon", "app", "extension", "ui"]).optional(),
    target: z.enum(["browser", "desktop"]).optional().describe("Wo der Fehler sichtbar ist"),
    tab: tab.optional(), id: id.optional(), rect: rect.optional(),
    context: z.record(z.string(), z.unknown()).optional().describe("Bedingungen: Aufgabe, Werkzeug, Argumente, URL …") },
  async a => {
    try {
      const r = await fetch(`${JARVISD}/errors`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...a, category: a.category ?? "tool", source: "model/error_report" }) });
      const j = await r.json() as Record<string, any>;
      return j.ok ? text(`Fehler ${j.id} gespeichert${j.screenshot ? " (mit markiertem Screenshot)" : ""}.`) : result(j);
    } catch {
      const e = recordError({ category: a.category ?? "tool", source: "model/error_report", message: a.message, context: { ...a.context, target: a.target, tab: a.tab } });
      return text(`Fehler ${e?.id ?? "?"} gespeichert (ohne Screenshot, jarvisd nicht erreichbar).`);
    }
  });

await server.connect(new StdioServerTransport());
