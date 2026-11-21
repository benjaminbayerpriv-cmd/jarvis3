# Jarvis 3 – Werkzeug-Protokoll (gemeinsamer Vertrag)

Alle Bedien-Werkzeuge (Mac-`uimap`, Windows-`uimap`, Chrome-Erweiterung) sprechen
**dieselben JSON-Befehle**. Der Daemon `jarvisd` reicht sie an die KI als Tools weiter.
Wer etwas ändert, ändert zuerst diese Datei.

## Elemente
```json
{"id": 3, "role": "field|link|control|visual", "axRole": "AXButton", "label": "Senden",
 "rect": [x, y, w, h], "enabled": true, "source": "ax|dom|visual"}
```
- `rect`: Desktop = Bildschirmpunkte (Ursprung oben links Hauptbildschirm); Web = CSS-Pixel im Viewport des Tabs.
- `id` gilt bis zum nächsten `scan` desselben Ziels.
- Passwortfelder: Label immer `"Passwortfeld"`, `type`/`read` darauf werden mit Fehler abgelehnt.

## Befehle (Anfrage → Antwort, optional `rid` wird zurückgegeben)
| cmd | Felder | Antwort |
|---|---|---|
| `scan` | `all?`, `text?` | `{ok, targets:[…], ms, text?}` – `text` = Kurzliste `"12 Button „Senden“ @640,812"` |
| `click` | `id` | `{ok, via}` |
| `type` | `id`, `text` | `{ok, via}` |
| `focus` | `id` | `{ok}` |
| `scroll` | `id` oder nichts, `dy` (Zeilen, + = runter) | `{ok}` |
| `read` | `id` **oder** `rect` | `{ok, text, via:"ax|dom|ocr"}` |
| `shot` | `rect?`, `marks?` | `{ok, path | dataUrl, rect}` – nur bei Bedarf! |
| `displays` | – | Desktop: Monitore |
| `key` | `combo` (z. B. `cmd+t`, `return`, `escape`) | `{ok}` – nur Desktop; Windows: `ctrl` statt `cmd` (noch offen in uimap-win) |
| `open_app` | `name` | `{ok}` – erledigt jarvisd selbst (`open -a` / `start`), nicht uimap |

Fehler: `{ok:false, error:"…"}`.

## Zusätzlich nur Browser (Chrome-Erweiterung)
Verbindung: Erweiterung öffnet `ws://127.0.0.1:7777/browser` und meldet sich mit
`{"hello":"jarvis-extension","version":"…"}`. Jede Anfrage trägt `tab` (Tab-ID), außer Tab-Befehle.

| cmd | Felder | Antwort |
|---|---|---|
| `tab_open` | `url`, `group?` (Standard `"Jarvis"`) | `{ok, tab, grouped}` – öffnet im Hintergrund (`active:false`); wenn Chrome Gruppen in diesem Fenster nicht unterstützt, bleibt der Tab ungegrouped, aber Jarvis-verwaltet |
| `tab_list` | – | `{ok, tabs:[{tab,url,title,group,active,favicon}]}` (`favicon` = http(s)/data-URL oder leer) |
| `tab_adopt` | `tab`, `group?` | `{ok, tab, url, active, cloned, grouped}` – holt einen **vorhandenen** Tab (nur http/https/file) in die Jarvis-Gruppe **seines eigenen Fensters**; danach steuerbar. Nur auf ausdrückliche Bitte des Nutzers. Ist der Tab aktiv, bleibt er unangetastet und Jarvis erstellt stattdessen eine inaktive Kopie derselben URL im selben Fenster. Aktive übernommene Tabs bleiben für click/type/scroll/focus gesperrt, scan/read gehen |
| `tab_release` | `tab` | `{ok}` – nimmt einen übernommenen Tab wieder aus der Gruppe, nicht mehr steuerbar |
| `tab_close` | `tab` | `{ok}` |
| `navigate` | `tab`, `url` | `{ok}` (wartet auf load) |
| `wait` | `tab`, `ms?`, `for?` (Text) | `{ok}` |
| `back` | `tab` | `{ok}` |

Regeln: Der aktive Tab und das Fenster des Nutzers wechseln **nie**. Gruppen-Farbe blau, Titel „Jarvis".
Klicks/Eingaben müssen auch in Hintergrund-Tabs funktionieren (Content-Script/`chrome.debugger`, kein OS-Mausklick).

- `scan` liefert höchstens 150 Elemente und zusätzlich `total` mit der Anzahl vor der Kürzung. Such- und Textfelder sowie wichtige Buttons stehen zuerst, gewöhnliche Navigation und Fußzeile zuletzt. Die optionale Kurzliste nennt die Gesamtzahl ebenfalls.
- `tab_open` und `navigate` antworten nach dem Laden und sobald das Content-Script der Zielseite erreichbar ist. Bei Links und Formularen wartet die Erweiterung auch auf eine unmittelbar ausgelöste Navigation. Wenn Chrome Tab-Gruppen im Fenster nicht unterstützt, verwaltet Jarvis den Hintergrund-Tab ohne Gruppe weiter. Nach einem Seitenwechsel sind die alten IDs ungültig. Die Fehlermeldung lautet „Seite hat gewechselt, bitte neu scannen“.
- `read` ohne `id` und ohne `rect` liest den gerenderten Seitentext einschließlich der Bereiche außerhalb des Viewports (maximal 8000 Zeichen insgesamt). Passwortfelder werden ausgelassen.
- `type` ersetzt den Inhalt eines Textfelds mit nativer Chrome-Eingabe (`via:"cdp"`). Mit `submit:true` folgt ein Enter-Tastendruck.

## Tab-Vorschau (Bildstrom)
- `stream_start {tab}` / `stream_stop {tab}`: Bildstrom eines Tabs der Gruppe „Jarvis“ (nur ansehen, kein Steuern; Tabs außerhalb der Gruppe werden abgelehnt).
- Die Erweiterung schickt unaufgefordert `{type:"frame", tab, data(JPEG base64), w, h, url, title}`; bei Ende `{type:"stream_ended", tab, reason}`.
- Bildrate und Qualität: `Page.startScreencast` liefert für Hintergrund-Tabs keine Bilder, deshalb laufen `STREAM_WORKERS` (6) überlappende `Page.captureScreenshot`-Aufnahmen, JPEG-Qualität 82, Deckel ca. 33 Bilder/s, Breite bis 1600 px (nur breitere Tabs werden verkleinert). Gemessen im Hintergrund-Tab: 25–30 Bilder/s (`bun extension/test/stream-fps.mjs`, verlangt mindestens 24).
- UI ↔ jarvisd (WebSocket): `{type:"tabs"}` → `{type:"tabs", tabs:[{tab,title,url,favicon,active}], pinned, streaming}` (nur Tabs der Gruppe „Jarvis“); `{type:"viewer_tab", tab}` wählt einen Tab (bleibt gewählt), `tab:null` = „Automatisch“ (folgt Jarvis); `{type:"liveview", on}` öffnet/schließt die Vorschau.

## Desktop: Fenster-Modus (macOS, wie Codex)
- `windows` → `{windows:[{id, app, title, pid, onScreen, display, rect}]}` (normale Programmfenster, auch verdeckte).
- `scan {window}` scannt genau dieses Fenster über die Bedienungshilfen (auch verdeckt) und liefert Bedienelemente **und** Text (`axRole` StaticText/Heading; liefert ein Programm fast nichts, Texterkennung im Fensterbild als `OCRText`). Folgende `click/type/scroll/key/typetext` gehen per `CGEvent.postToPid` direkt an dieses Programm (AXPress zuerst) – die echte Maus bewegt sich nicht. `scan {display}` schaltet zurück auf den Monitor-Modus.
- `click`/`type` antworten mit `point` (Bildschirmpunkt) für die virtuelle Maus im Live-Bild.
- Aufnahme-Dienst `tools/uimap-mac/bin/Jarvis Bildschirm.app` (`uimap capture-serve --port 7779`, gestartet von jarvisd über `open`): `windowshot {window}`, `stream_start {window, fps}`, `stream_stop`, `cursor {point}`, `ping`. Er braucht eine eigene Bildschirmaufnahme-Freigabe (ScreenCaptureKit liefert Kommandozeilenprogrammen keine Bilder). Bilder kommen als `{event:"frame", window, data, w, h, bounds, title, app}`; jarvisd reicht sie als `frame` mit `tab:"win:<id>"` und `cursor` an die Vorschau weiter.
- Nicht setzen: `AXEnhancedUserInterface` – Chromium-Programme melden danach statt ihrer Fenster nur noch das Programm-Element (bis zum Neustart).
