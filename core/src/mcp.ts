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
const display = z.number().int().min(0).describe("Monitor-Nummer aus desktop_displays (0 = Hauptbildschirm)");
type Mon = { index: number; name: string; rect: [number, number, number, number] };
const monitors = async (): Promise<Mon[]> => { const r: any = await call("desktop", { cmd: "displays" }).catch(() => ({})); return Array.isArray(r?.displays) ? r.displays : []; };
server.tool("desktop_displays", "Listet alle angeschlossenen Monitore (Nummer, Name, Größe, Lage). Nötig, wenn etwas auf einem anderen Monitor als dem Hauptbildschirm liegt.",
  {}, async () => result(await call("desktop", { cmd: "displays" })));
const windowId = z.number().int().min(1).max(0xffffffff).describe("Fenster-ID aus desktop_windows");
server.tool("desktop_windows", "Listet die offenen Programmfenster (ID, Programm, Titel, Monitor, sichtbar oder verdeckt). Für Arbeit in einem Programm IMMER zuerst hier das Fenster holen und dann mit window=ID scannen und bedienen: das Fenster muss dafür nicht vorne sein, die Maus des Nutzers bleibt, wo sie ist.",
  {}, async () => {
    const r: any = await call("desktop", { cmd: "windows" });
    const list = (Array.isArray(r?.windows) ? r.windows : []).filter((w: any) => (w.title || w.onScreen) && w.rect?.[3] >= 150);
    return result({ ok: r?.ok ?? false, error: r?.error, text: list.map((w: any) =>
      `${w.id} ${w.app}${w.title ? ` „${w.title}“` : ""} · Monitor ${w.display} · ${w.onScreen ? "sichtbar" : "verdeckt"} · ${w.rect[2]}×${w.rect[3]}`).join("\n") || "keine Fenster" });
  });
server.tool("desktop_scan", "Listet Bedienelemente UND sichtbaren Text als nummerierte Textliste (Text-Einträge: Rolle StaticText/Heading/OCRText). Mit window=ID nur dieses Fenster (auch verdeckt, bevorzugt). Ohne Angabe: ganzer Monitor (display=N, Standard Hauptbildschirm). Text steht schon in der Liste – kein Screenshot nötig, um ihn zu lesen.",
  { window: windowId.optional(), display: display.optional() }, async a => {
    const r: any = await call("desktop", { cmd: "scan", text: true, ...(a.window !== undefined ? { window: a.window } : { display: a.display ?? 0 }) });
    if (a.window !== undefined) return result({ ...r, targets: undefined });
    const others = (await monitors()).filter(m => m.index !== (a.display ?? 0));
    if (others.length && typeof r?.text === "string")
      r.text += `\n\nWeitere Monitore: ${others.map(m => `${m.index} „${m.name}“ ${m.rect[2]}×${m.rect[3]}`).join("; ")} – mit display=N scannen.`;
    return result({ ...r, targets: undefined });
  });
server.tool("desktop_click", "Klickt ein Element aus dem letzten Scan. Bei Ortsangaben wie unten links die Position im Fenster prüfen. Bei mehreren Kandidaten zuerst desktop_look mit marks=true. Ein erfolgreicher Aufruf bestätigt nur die Übergabe, beobachte die Reaktion danach.", { id }, async a => result(await call("desktop", { cmd: "click", ...a })));
server.tool("desktop_type", "Schreibt Text in ein Feld per ID.", { id, text: z.string() },
  async a => result(await call("desktop", { cmd: "type", ...a })));
server.tool("desktop_scroll", "Scrollt an einem Element (dy Zeilen, positiv = runter).", { id, dy: z.number().int() },
  async a => result(await call("desktop", { cmd: "scroll", ...a })));
server.tool("desktop_read", "Liest Text eines Elements (id) oder eines Bildschirmbereichs (rect, per OCR).",
  { id: id.optional(), rect: rect.optional() }, async a => result(await call("desktop", { cmd: "read", ...a })));
server.tool("desktop_look", "Screenshot NUR wenn scan/read nicht reichen (Spiele, Grafiken, unklare Lage). marks=true zeichnet die IDs ein. window=ID nimmt genau dieses Fenster auf; display wählt den Monitor (ohne Angabe: das zuletzt gescannte Fenster bzw. der Monitor).",
  { rect: rect.optional(), marks: z.boolean().optional(), display: display.optional(), window: windowId.optional() }, async ({ display: d, ...a }) => {
    if (d !== undefined && !a.rect) { // Monitor-Fläche als Bereich aufnehmen (gilt über alle Monitore)
      const m = (await monitors()).find(x => x.index === d);
      if (!m) return result({ ok: false, error: `Monitor ${d} gibt es nicht (desktop_displays zeigt die vorhandenen)` });
      a.rect = m.rect;
    }
    return image(await call("desktop", { cmd: "shot", ...a }));
  });
server.tool("desktop_key", "Drückt EINE Taste oder Tastenkombination, z. B. 'cmd+t', 'cmd+shift+4', 'return', 'escape', 'tab', 'left', 'f5', 'cmd+z'. Auch einzelne Zeichen wie '8', '*', '=' gehen (richtet sich nach der Tastatur). Modifier immer MIT einer Taste verbinden (nicht 'shift' allein), keine Anführungszeichen. Zum SCHREIBEN von Text, Zahlen oder Rechnungen desktop_type_text benutzen, nicht viele einzelne Tasten.", { combo: z.string(), window: windowId.optional().describe("Taste direkt an dieses Fenster/Programm schicken (ohne es nach vorn zu holen)") },
  async a => result(await call("desktop", { cmd: "key", ...a })));
server.tool("desktop_type_text", "Schreibt Text in das gerade fokussierte Feld bzw. Programm (Rechner, Notizen, Suchfeld …), ohne Element-ID. Mit window=ID geht der Text direkt an dieses Programm (es muss nicht vorne sein); sonst zuerst das Feld mit desktop_click fokussieren. Für Rechnen: z. B. text='8*8=' und danach ggf. desktop_key 'return'. Passwortfelder sind gesperrt.",
  { text: z.string().max(2000), window: windowId.optional() }, async a => result(await call("desktop", { cmd: "typetext", ...a })));
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
server.tool("browser_tab_close", "Schließt einen Tab der Gruppe Jarvis (Tab-ID aus browser_tab_list). Mach das, wenn du mit einem Tab fertig bist oder der Nutzer darum bittet.", { tab }, async a => result(await call("browser", { cmd: "tab_close", ...a })));
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

// ---------- Projekte ----------
async function projectCall(action: Record<string, unknown>) {
  try {
    const r = await fetch(`${JARVISD}/projects`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(action) });
    return await r.json() as Record<string, any>;
  } catch {
    const e = recordError({ category: "daemon", source: "mcp/project", message: "jarvisd nicht erreichbar", context: { action } });
    return { ok: false, error: `jarvisd nicht erreichbar${e ? ` (Fehler ${e.id})` : ""}` };
  }
}
function projectTree(d: Record<string, any>) {
  const projects = Array.isArray(d.projects) ? d.projects as Record<string, any>[] : [];
  const chats = Array.isArray(d.chats) ? d.chats as Record<string, any>[] : [];
  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const p of projects.filter(x => (x.parentId ?? null) === parent)) {
      lines.push(`${"  ".repeat(depth)}${p.name} [${p.id}]${p.description ? ` – ${p.description}` : ""}`);
      for (const c of chats.filter(x => x.projectId === p.id))
        lines.push(`${"  ".repeat(depth + 1)}- ${c.title} [${c.id}]${c.assignedBy ? ` (${c.assignedBy})` : ""}`);
      walk(p.id, depth + 1);
    }
  };
  walk(null, 0);
  const loose = chats.filter(c => !c.projectId);
  if (loose.length) { lines.push("Ohne Projekt:"); for (const c of loose) lines.push(`- ${c.title} [${c.id}]`); }
  return lines.join("\n") || "Noch keine Projekte und Chats.";
}
server.tool("project_list", "Zeigt den Projektbaum mit allen Projekt- und Chat-IDs. Vor Änderungen immer aufrufen.",
  {}, async () => {
    try {
      const r = await fetch(`${JARVISD}/projects`) as any;
      const d = await r.json() as Record<string, any>;
      return text(projectTree(d) + `\nSpeicher: ${d.root ?? "~/.jarvis3/projects"}`);
    } catch { return { ...text("Fehler: Projekte nicht abrufbar"), isError: true }; }
  });
server.tool("project_create", "Legt ein Projekt an (parent = ID eines Oberprojekts, sonst leer).",
  { name: z.string(), description: z.string().optional(), parent: z.string().optional() },
  async a => result(await projectCall({ op: "create", ...a })));
server.tool("project_update", "Benennt ein Projekt um, ändert die Beschreibung oder verschiebt es unter ein anderes Projekt (parentId=null für die oberste Ebene).",
  { id: z.string(), name: z.string().optional(), description: z.string().optional(), parentId: z.string().nullable().optional() },
  async a => {
    const patch: Record<string, unknown> = {};
    for (const k of ["name", "description", "parentId"]) if (a[k] !== undefined) patch[k] = a[k];
    return result(await projectCall({ op: "update", id: a.id, patch }));
  });
server.tool("project_delete", "Löscht ein Projekt samt Unterprojekten; seine Chats bleiben ohne Projekt erhalten.",
  { id: z.string() }, async a => result(await projectCall({ op: "delete", ...a })));
server.tool("project_assign", "Legt einen Chat in ein Projekt (projectId=null löst ihn). Die ID kommt aus project_list.",
  { chatId: z.string(), projectId: z.string().nullable(), by: z.enum(["manual", "ki", "auto"]).optional() },
  async a => result(await projectCall({ op: "assign", id: a.chatId, projectId: a.projectId, by: a.by ?? "manual" })));
server.tool("project_analyze", "Prüft die Zuordnung aller noch nicht zugeordneten Chats erneut mit dem Modell.",
  {}, async () => result(await projectCall({ op: "analyze" })));

// ---------- Visualisierungen (Chat + Vorschau) ----------
async function visualize(body: Record<string, unknown>, showMe = false) {
  let r: Record<string, any>;
  try {
    r = await (await fetch(`${JARVISD}/visualize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as Record<string, any>;
  } catch { return { ...text("Fehler: jarvisd nicht erreichbar"), isError: true }; }
  if (!r.ok) return { ...text(`Fehler: ${r.error}${r.stdout ? `\nAusgabe:\n${r.stdout}` : ""}`), isError: true };
  const files: string[] = r.files ?? [];
  const lines = [
    `${r.marker} „${r.title}“ wird dem Nutzer im Chat und in der Vorschau angezeigt${files.length ? ` (${files.join(", ")})` : ""}.`,
    files.length ? "Beschreibe nicht den Code, sondern kurz, was die Grafik zeigt. Kein Link nötig." : "Es ist kein Bild entstanden: Figur mit matplotlib zeichnen oder eine Datei (png/svg/html) im aktuellen Ordner speichern.",
    r.stdout?.trim() ? `Ausgabe:\n${String(r.stdout).trim()}` : "",
    r.error ? `Warnungen/Fehler:\n${r.error}` : "",
  ].filter(Boolean);
  const content: any[] = [{ type: "text", text: lines.join("\n") }];
  const png = files.find(f => /\.(png|jpe?g)$/i.test(f));
  if (showMe && png) {
    try {
      const img = await fetch(`${JARVISD}/visual/${r.id}/${png}`);
      content.push({ type: "image", data: Buffer.from(await img.arrayBuffer()).toString("base64"), mimeType: png.endsWith(".png") ? "image/png" : "image/jpeg" });
    } catch {}
  }
  return { content };
}
const vtitle = z.string().max(120).describe("Kurzer Titel, z. B. „Sinus und Kosinus“");
server.tool("visualize_python",
  "Rechnet und zeichnet mit Python und zeigt das Ergebnis als Bild im Chat und in der Vorschau. Für Funktionsplots, Diagramme aus Daten, Statistik, Geometrie, Fraktale, generierte Bilder, Rechnungen mit Ergebnis-Grafik. Verfügbar: numpy, matplotlib, pandas, scipy, sympy, pillow. Jede matplotlib-Figur wird automatisch gespeichert (plt.show() genügt, kein savefig nötig); eigene Bilder (PIL, SVG, HTML) einfach im aktuellen Ordner speichern. print-Ausgaben bekommst du zurück. Kein Internet, keine Dateien des Nutzers ändern.",
  { code: z.string().max(60_000).describe("Vollständiges Python-Skript"), title: vtitle,
    check: z.boolean().optional().describe("true: du bekommst das erste Bild zurück, um es zu prüfen (nur mit Bildmodell)") },
  async a => visualize({ kind: "python", code: a.code, title: a.title }, a.check));
server.tool("visualize_html",
  "Zeigt eine eigene HTML-Seite im Chat und in der Vorschau: interaktive Diagramme (Chart.js, Plotly, D3, ECharts), Flussdiagramme/Mindmaps (Mermaid), Formeln (KaTeX/MathJax), Animationen (Canvas, three.js), Tabellen, Zeitstrahlen, kleine Rechner. Bibliotheken per <script src> von cdn.jsdelivr.net, unpkg.com oder cdnjs.cloudflare.com laden. Dunkler Hintergrund #131314, Text #e3e3e3, Akzentfarben #4fa0ff #d8627e #00a5b7. Ein reines <svg> wird als Bild gezeigt. Die Seite läuft abgeschottet (kein Zugriff auf Jarvis oder lokale Dateien).",
  { html: z.string().max(200_000).describe("HTML-Inhalt (ganzes Dokument oder nur der Body) oder ein <svg>"), title: vtitle },
  async a => visualize({ kind: "html", html: a.html, title: a.title }));

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
