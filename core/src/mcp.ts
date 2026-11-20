// MCP-Server (stdio), den OpenCode startet. Leitet jedes Werkzeug an jarvisd (/tool) weiter.
// So sieht die KI Bedienelemente als Text und holt Bilder nur bei Bedarf (look).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, unlinkSync } from "node:fs";

const JARVISD = process.env.JARVISD_URL ?? "http://127.0.0.1:7777";
const server = new McpServer({ name: "jarvis", version: "0.1.0" });

async function call(target: "desktop" | "browser", cmd: Record<string, unknown>) {
  const r = await fetch(`${JARVISD}/tool`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, cmd }) });
  return (await r.json()) as Record<string, any>;
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
server.tool("browser_tab_close", "Schließt einen Jarvis-Tab.", { tab }, async a => result(await call("browser", { cmd: "tab_close", ...a })));
server.tool("browser_navigate", "Lädt eine URL im Tab.", { tab, url: z.string() },
  async a => result(await call("browser", { cmd: "navigate", ...a })));
server.tool("browser_back", "Zurück im Tab.", { tab }, async a => result(await call("browser", { cmd: "back", ...a })));
server.tool("browser_wait", "Wartet (ms) oder bis Text erscheint.", { tab, ms: z.number().optional(), for: z.string().optional() },
  async a => result(await call("browser", { cmd: "wait", ...a })));
server.tool("browser_scan", "Bedienelemente der Seite als nummerierte Textliste.", { tab },
  async a => result({ ...(await call("browser", { cmd: "scan", text: true, ...a })), targets: undefined }));
server.tool("browser_click", "Klickt ein Element der Seite.", { tab, id }, async a => result(await call("browser", { cmd: "click", ...a })));
server.tool("browser_type", "Schreibt in ein Feld der Seite.", { tab, id, text: z.string() },
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

await server.connect(new StdioServerTransport());
