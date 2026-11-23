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
- In „Automatisch“ startet der Bildstrom bei Werkzeugaktivität im Tab oder Programmfenster. Ein Zielwechsel wird kurz gesammelt, damit die Vorschau bei schnell wechselnden Zielen stabil bleibt. Nach der eingestellten Dauer ohne Werkzeugaktivität (Standard: 8 Sekunden) blendet die Oberfläche die Vorschau aus (`{type:"viewer_idle"}`). Eine manuelle Auswahl bleibt geöffnet.
- UI ↔ jarvisd (WebSocket): `{type:"tabs"}` → `{type:"tabs", tabs:[{tab,title,url,favicon,active}], windows, pinned}`. `pinned` ist die Tab-ID, `"win:<id>"` oder `null`. `{type:"viewer_tab", tab}` und `{type:"viewer_window", window}` wählen eine feste Quelle. `tab:null` wählt „Automatisch“. `{type:"liveview", on}` aktiviert oder deaktiviert die Vorschau.

## Desktop: Fenster-Modus (macOS, wie Codex)
- `windows` → `{windows:[{id, app, title, pid, onScreen, display, rect}]}` (normale Programmfenster, auch verdeckte).
- `scan {window}` scannt genau dieses Fenster über die Bedienungshilfen (auch verdeckt) und liefert Bedienelemente **und** Text (`axRole` StaticText/Heading; liefert ein Programm fast nichts, Texterkennung im Fensterbild als `OCRText`). Folgende `click/type/scroll/key/typetext` gehen per `CGEvent.postToPid` direkt an dieses Programm (AXPress zuerst) – die echte Maus bewegt sich nicht. `scan {display}` schaltet zurück auf den Monitor-Modus.
- Der macOS-Scan liefert zusätzlich `bounds` (Bildschirmpunkte), im Fenster-Modus auch `window`, `app` und `scanToken`. Das Desktop-Werkzeug nutzt diese Daten für Positionen relativ zum Fenster.
- `click` akzeptiert im macOS-Fenster-Modus optional `window` und `scanToken` als Prüfung der Scan-Zuordnung. `click`/`type` antworten mit `point` (Bildschirmpunkt) für die virtuelle Maus im Live-Bild. `ok` beim Klick bestätigt die Übergabe an das Programm. Für eine Aussage über das Ergebnis ist eine Beobachtung danach nötig.
- Aufnahme-Dienst `tools/uimap-mac/bin/Jarvis Bildschirm.app` (`uimap capture-serve --port 7779`, gestartet von jarvisd über `open`): `windowshot {window}`, `stream_start {window, fps}`, `stream_stop`, `cursor {point, click?}`, `cursor_hide`, `ping`. Er braucht eine eigene Bildschirmaufnahme-Freigabe (ScreenCaptureKit liefert Kommandozeilenprogrammen keine Bilder). Bilder kommen als `{event:"frame", window, data, w, h, bounds, title, app}`; jarvisd reicht sie als `frame` mit `tab:"win:<id>"` und `cursor` an die Vorschau weiter.
- Nicht setzen: `AXEnhancedUserInterface` – Chromium-Programme melden danach statt ihrer Fenster nur noch das Programm-Element (bis zum Neustart).

## Handy-Zugriff im privaten Netz

Die Desktop-Oberfläche bleibt auf dem bisherigen Loopback-Port. Erst `settings.lanAccess: true` startet den separaten HTTPS/WSS-Listener auf 7787 (Standard: Desktop-Port + 10, überschreibbar mit `JARVIS_LAN_PORT`). Der Listener prüft die tatsächliche Quelladresse und veröffentlicht per mDNS `_jarvis3._tcp`. Beim Ausschalten werden die LAN-Verbindungen geschlossen, vorhandene Kopplungen bleiben gespeichert.

- `GET /devices` liefert am Computer die Anzeigenamen, IDs, Kopplungszeiten und erreichbaren LAN-Adressen. `POST /pair/start` liefert am Computer PIN, Ablaufzeit, TLS-Fingerabdruck und QR-Bild. Der QR-Inhalt ist `{url, fingerprint, secret}`. Eine Kopplung gilt zwei Minuten und erlaubt insgesamt fünf Versuche. Eine erfolgreiche Kopplung verbraucht den Code.
- Das Handy sendet `POST /pair/complete` mit `{name, pin}` oder `{name, secret}` über HTTPS. Die Antwort enthält `{id, token}`. Die Pixel-App vergleicht beim TLS-Verbindungsaufbau den SHA-256-Fingerabdruck des Serverzertifikats mit dem QR-Code oder der Eingabe vom Computer. Das zufällige Token wird per Android Keystore geschützt.
- Für die Handy-Webseite sendet der Browser zusätzlich `browser: true`. Jarvis setzt dann ein Secure/HttpOnly/SameSite-Cookie und gibt nur die ID zurück. `GET /mobile/session` prüft die Kopplung. Cross-Origin-Anfragen werden verworfen.
- Geräte verwenden `Authorization: Bearer <token>` oder das Browser-Cookie an `/ui`, `/visual/<id>/<datei>` (Bilddateien), `POST /stop` und `POST /errors`. Das Protokoll für Chat, Verlauf, Modell, Vorschau und Einstellungen bleibt das bestehende. Die LAN-Schnittstelle stellt nur diese Routen und die Handy-Seite bereit. `DELETE /devices/<id>` widerruft am Computer ein Gerät und schließt seine WebSockets. `devices.json` enthält Token-Hashes.
- Die Handy-Seite zeigt den Android-Download über `GET /download/Jarvis.apk`, sofern am Computer ein Paket hinterlegt ist. Diese Datei und der Einstieg sind ohne Kopplung im privaten Netz erreichbar. Chatdaten und Vorschaubilder brauchen eine Kopplung.
- Haptik verwendet vorhandene UI-Ereignisse. `action` mit `cmd: "click"` oder `"dblclick"` gibt einen Klickimpuls, `tool` markiert Werkzeugbeginn und -ende, `delta` markiert den Schreibfluss. Für die laufende Anfrage ohne Werkzeug oder Text taktet die Pixel-App lokal. Bei `done`, `stopped`, Fehler oder Hintergrund stoppt sie.
- In dieser Version wandelt die Pixel-App Sprache lokal per Android-Spracherkennung in einen Chatentwurf um. Der LAN-Listener übernimmt keinen Mikrofon-Audiostream. Der geplante Hin- und Rückweg für Live-Sprache steht in [mobile-live-audio.md](mobile-live-audio.md).
