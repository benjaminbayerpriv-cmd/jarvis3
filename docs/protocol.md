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

Fehler: `{ok:false, error:"…"}`.

## Zusätzlich nur Browser (Chrome-Erweiterung)
Verbindung: Erweiterung öffnet `ws://127.0.0.1:7777/browser` und meldet sich mit
`{"hello":"jarvis-extension","version":"…"}`. Jede Anfrage trägt `tab` (Tab-ID), außer Tab-Befehle.

| cmd | Felder | Antwort |
|---|---|---|
| `tab_open` | `url`, `group?` (Standard `"Jarvis"`) | `{ok, tab}` – öffnet im Hintergrund (`active:false`) in der Tab-Gruppe |
| `tab_list` | – | `{ok, tabs:[{tab,url,title,group,active}]}` |
| `tab_close` | `tab` | `{ok}` |
| `navigate` | `tab`, `url` | `{ok}` (wartet auf load) |
| `wait` | `tab`, `ms?`, `for?` (Text) | `{ok}` |
| `back` | `tab` | `{ok}` |

Regeln: Der aktive Tab und das Fenster des Nutzers wechseln **nie**. Gruppen-Farbe blau, Titel „Jarvis".
Klicks/Eingaben müssen auch in Hintergrund-Tabs funktionieren (Content-Script/`chrome.debugger`, kein OS-Mausklick).
