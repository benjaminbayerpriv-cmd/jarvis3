# Zentrales Fehler-Log

Alle Teile von Jarvis 3 schreiben ihre Fehler an **eine** Stelle:

```
~/.jarvis3/errors/            (Windows: %USERPROFILE%\.jarvis3\errors\)
  <id>.json                   ein offener Fehler
  <id>.png                    optional: Screenshot, Fehlerstelle rot umrandet
```

Das Log enthält nur **offene** Fehler. Wer einen Fehler behoben hat, löscht den Eintrag (siehe unten). Gleiche Fehler
(gleiche Kategorie, Quelle und Meldung, Zahlen ignoriert) landen im selben Eintrag, `count` zählt mit, `lastSeen` und
`context` zeigen das letzte Auftreten. Taucht ein gelöschter Fehler wieder auf, entsteht der Eintrag neu.

## Eintrag

```json
{
  "id": "bc8848b6dd83",
  "category": "tool",
  "source": "browser/click",
  "message": "Element 3 ist verdeckt",
  "context": { "tool": "browser_click", "args": { "cmd": "click", "tab": 7, "id": 3 },
               "element": { "id": 3, "rect": [20, 10, 40, 20] }, "mode": "browser",
               "model": "opencode/deepseek-v4.1-flash-free", "voice": "off", "busy": true },
  "stack": "…",
  "screenshot": "bc8848b6dd83.png",
  "firstSeen": "2026-11-21T00:24:01.123Z",
  "lastSeen": "2026-11-21T00:31:44.456Z",
  "count": 3
}
```

| Kategorie | Wer schreibt | Typischer Kontext |
|---|---|---|
| `speech` | Sprach-Sidecar (Python, `LOG.error/exception`, `error`-Ereignisse, Absturz), jarvisd | `voice`, `lofi`, `command`, Logger und Codestelle |
| `model` | jarvisd (`opencode/prompt`, Ereignisstrom, OpenCode-Start, Verlauf) | `model`, `request`, `mode`, `spoken`, `tried` (Fallback-Kette) |
| `tool` | jarvisd `runTool` (Browser/Desktop), OpenCode-Werkzeuge wie `bash`/`webfetch`, MCP `error_report` | `tool`, `args`, `element` (Rechteck aus dem letzten scan) |
| `daemon` | jarvisd (HTTP/WebSocket-Fehler, unbehandelte Ausnahmen, Absturz), MCP wenn jarvisd fehlt | Pfad, Rohnachricht |
| `app` | Tauri-Hülle (Dienststart, Not-Aus, Hotkeys, Fenster, Panic) | Dienst, Port, `JARVIS_REPO` |
| `ui` | Oberfläche (`window.onerror`, unbehandelte Promises) | Stack |
| `extension` | jarvisd, wenn eine Nachricht der Chrome-Erweiterung nicht verarbeitet werden kann | Rohnachricht |

Felder, deren Name nach Geheimnis aussieht (`password`, `token`, `secret`, `apiKey`), werden im TypeScript-Teil nicht
gespeichert. Lange Texte werden gekürzt.

## Screenshots

Bei Werkzeugfehlern mit Bildschirmbezug macht jarvisd selbst einen Screenshot (Browser: der betroffene Tab, Desktop:
der Bildschirm) und umrandet die Fehlerstelle rot: das Element aus `id` (Rechteck aus dem letzten `scan`) und/oder den
Bereich `rect`. Kein Bild gibt es bei Fehlern, bei denen der Bildschirm nichts zeigt (Erweiterung nicht verbunden,
Computer-Steuerung aus, Nutzer-Stopp, Passwortsperre).

Das Modell kann einen Fehler auch selbst melden, mit MCP-Werkzeug **`jarvis_error_report`**
(`message`, `category?`, `target?: "browser"|"desktop"`, `tab?`, `id?`, `rect?`, `context?`). Mit `target` wird ein
Screenshot gespeichert und die angegebene Stelle markiert.

## Für Agenten: Fehler lesen und als behoben markieren

```sh
bun core/scripts/errors.ts                 # offene Fehler, neueste zuerst
bun core/scripts/errors.ts list tool       # nur eine Kategorie (--json für Maschinenformat)
bun core/scripts/errors.ts show <id>       # ganzer Eintrag mit Kontext, Stack und Screenshot-Pfad
bun core/scripts/errors.ts resolve <id>…   # nach dem Fix: Eintrag und Screenshot löschen
```

Die CLI arbeitet direkt auf dem Ordner, jarvisd muss dafür nicht laufen. Gleiches über HTTP (jarvisd, nur `127.0.0.1`):

| Methode | Pfad | Zweck |
|---|---|---|
| `GET` | `/errors?category=tool` | Liste der offenen Fehler |
| `POST` | `/errors` | Fehler melden: `{category, source, message, context?, target?, tab?, id?, rect?, screenshot?: false}` |
| `POST` | `/errors/<id>/resolve` (oder `DELETE /errors/<id>`) | Fehler behoben, Eintrag löschen |

**Regel:** Erst `resolve`, wenn der Fix wirklich drin ist (Test oder Nachstellen). Einträge, die nur „nicht
reproduzierbar“ sind, bleiben stehen. Für Tests lässt sich der Ordner mit `JARVIS_ERRORS_DIR` umlenken.

Die ID ist ein FNV-1a-Hash (64 bit, erste 12 Hex-Zeichen) über `kategorie|quelle|meldung` (Ziffernfolgen durch `#`
ersetzt), in TypeScript (`core/src/errorlog.ts`), Python (`speech/jarvis_speech/errorlog.py`) und Rust
(`app/src-tauri/src/errorlog.rs`) gleich umgesetzt.
