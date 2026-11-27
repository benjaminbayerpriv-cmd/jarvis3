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

## Agenten-Backend: OpenCode, Hermes, Claude Code und Codex

OpenCode ist der Standard. Der Wechsel legt nur das Backend **neuer Chats** fest;
vorhandene Chats bleiben ihrem Backend und im Hermes-Fall der Serveradresse
zugeordnet, auch nach Neustart. Hermes-Chats haben `hermes_`-IDs. Verlauf,
Öffnen, Umbenennen, Löschen, Projekte und Streaming nutzen diese Zuordnung.
Textdateien und lesbare PDFs werden als Text übertragen; Bilder werden bei aktivierter
Bildfähigkeit über den multimodalen Sitzungsstream übergeben. Andere Binärdateien
und unlesbare PDFs werden abgelehnt. Die installierte Hermes-API kann Sitzungen
nur mit ihrem vollständigen Verlauf forken, nicht vor einer bestimmten Nachricht;
Bearbeiten und erneutes Senden werden daher explizit abgelehnt.

### UI ↔ Daemon (WebSocket `/ui`)

- `{type:"backend_get"}` → `{type:"backend", active, backends}`.
- `{type:"backend_set", backend:"opencode"|"hermes"}` speichert die Auswahl.
- `{type:"backend_config", backend:"hermes", config:{serverUrl, provider, model, modelBaseUrl?, modelSupportsVision?}}`
  speichert die Konfiguration. `serverUrl` ist die **Hermes-Gateway-Adresse**;
  `provider` und `model` wählen einen in Hermes konfigurierten Modellanbieter und
  dessen Modell. `modelBaseUrl` ist die getrennte HTTP(S)-Adresse eines OpenAI-
  kompatiblen Modellservers und darf auch im Heimnetz liegen. Ist sie gesetzt,
  wird Hermes als Anbieter `custom` konfiguriert. `modelSupportsVision` bestätigt
  die Bildfähigkeit des gewählten Modells. `default` bzw. `hermes-agent`
  verwenden die Hermes-Vorgabe.
  OpenCode verwaltet seine Anbieter selbst. Anbieter-URLs und -Schlüssel sind
  **nicht** die Hermes-Serveradresse und der Hermes-Server-Schlüssel.
- `{type:"backend_secret", backend:"hermes", target:"server"|"provider", apiKey:string|null}`
  setzt oder entfernt getrennt den Hermes-Server- bzw. Modellanbieter-Schlüssel.
  Fehlt `target`, gilt `server`. Antworten enthalten nur `keySet` und `providerKeySet`.
- `{type:"backend_test", backend}` prüft den gespeicherten Zugang; Antwort
  `{type:"backend_test", backend, ok, error?, latencyMs?}`. Speichern/Entfernen
  antwortet mit `{type:"backend_saved", backend, ok, error?}`.
- `backend.config` enthält für Hermes `serverUrl`, `provider`, `model`,
  `modelBaseUrl`, `modelSupportsVision`; Änderungen werden während eines aktiven
  Hermes-Laufs abgelehnt. UI-PR #64 muss die zusätzlichen Anbieter-Felder noch
  übernehmen. Das Backend behandelt `baseUrl` nicht als Serveradresse.

Gateway- und Modellanbieter-Adressen dürfen HTTP(S)-Netzwerkadressen ohne
eingebettete Zugangsdaten sein; Redirects zum Gateway werden abgelehnt.
Ein fremdes Gateway kann konfiguriert und verwendet werden, wird aber nicht von
Jarvis verwaltet: Seine Werkzeugfreigaben und Not-Aus-Anbindung müssen dort separat
eingerichtet werden. Ein lokal verwaltetes Gateway kann Modellserver im Heimnetz
oder Internet nutzen. Bei externen Gateways müssen Modellserver-Adresse und
Anbieter-Schlüssel direkt auf diesem Gateway eingerichtet werden; Jarvis lehnt
diese lokalen Einstellungen in diesem Fall ab. Der Server-Schlüssel liegt getrennt in `~/.jarvis3/backend/` (Verzeichnis
0700, Datei 0600, keine Verschlüsselung oder Schlüsselbundintegration); Windows
wird derzeit nicht unterstützt. Backend-Nachrichten über fremde Browser-Origins
werden abgewiesen. Der separate Modellanbieter-Schlüssel wird beim Start über eine Umgebungsvariable
an Hermes übergeben; im erzeugten YAML steht nur ein Variablenverweis.

Jarvis startet nur seinen **eigenen** Hermes-Gatewayprozess auf der gewählten freien
Adresse; ein vorhandener Prozess auf dem Port wird nicht übernommen. `setupHome()`
richtet `HERMES_HOME` ein und verbindet den Jarvis-MCP, das API-Profil verwendet nur
`platform_toolsets.api_server: [jarvis]`. Der von Jarvis verwaltete Profilordner
ist standardmäßig `~/.jarvis3/hermes/`; seine automatisch erzeugte `config.yaml`
wird bei jedem Start erneuert, fremde Konfigurationen werden nicht überschrieben.

SSE-Text und Werkzeugereignisse werden in den bestehenden Jarvis-Stream übersetzt;
`mcp__jarvis__` wird für die Anzeige entfernt. Stopp/Not-Aus fordert
`POST /v1/runs/{run_id}/stop` an, der MCP-Abbruch kann umgekehrt `/stop` auslösen.
Hermes stoppt kooperativ; nach zehn Sekunden ohne terminale Bestätigung wird ein
Fehler gemeldet und der Lauf kann weiterarbeiten. Die Hermes-Werkzeuge und deren
Sperren beschreibt `docs/hermes-tools.md`.

Geprüft: Ein echtes lokales Hermes-Gateway verarbeitete Text und Bild über einen
lokalen simulierten Modellserver; kein echtes Modell wurde dafür heruntergeladen.
Offen: Die Sicherheitsgrenzen mit einem echten Modell und fremdem Gateway sind
noch nicht end-to-end geprüft. Netzunterbrechungen und dabei
unbekannte Laufzustände, Freigabedialoge, Wiederverbindung und Windows
benötigen weitere Arbeit. Die Modellliste und Live-Modellauswahl zeigen beim Hermes-Chat das konfigurierte
Hermes-Modell; eine automatische Anbieter-/Modellinventur ist noch nicht implementiert.

### Claude Code und Codex

Beide sind die **schon installierten Programme** (`claude`, `codex`); Jarvis lädt nichts herunter. Sie melden sich selbst an (Claude-Abo bzw.
ChatGPT-Konto): Jarvis speichert, liest und sendet dafür **keine Schlüssel oder Passwörter** und öffnet keine Anmeldedateien; es fragt nur
`claude auth status` bzw. `codex login status` ab. Details und Grenzen: `docs/cli-backends.md`.

- `backend_set` akzeptiert zusätzlich `"claude"` und `"codex"`. Chats haben `claude_<uuid>`- bzw. `codex_<uuid>`-IDs und bleiben ihrem Backend zugeordnet.
- `{type:"backend_config", backend:"claude"|"codex", config:{model, files}}`: `model` leer = Vorgabe des Programms; `files` `"none"` (Standard) oder
  `"read"` (Lesewerkzeuge bei Claude Code; Nur-Lese-Sandbox mit Befehlen bei Codex). Änderungen werden abgelehnt, solange ein solcher Chat läuft.
- `{type:"backend_secret", backend:"claude"|"codex", …}` wird **abgelehnt** („meldet sich selbst an“).
- `{type:"backend_test", backend:"claude"|"codex"}` prüft Installation und Anmeldung (`backend_test`-Antwort mit `ok`/`error`, ohne Modellaufruf).
- `backend.backends.claude|codex`: `{label, status, error?, loginManaged:true, keySet:false, config:{provider, model, files}, providers:[]}`;
  `status` `ready` (installiert und angemeldet), `error` (nicht angemeldet; `error` nennt den Befehl), `unsupported` (nicht installiert),
  `connecting` (Status wird abgefragt). Die Statusabfrage läuft bei `backend_get` im Hintergrund; danach folgt ein neues `backend`.
- `config` hat zusätzlich `effort` (`""`, `low`…`max`, `ultra` nur Codex) und `adopt` (bool): installierte Skills und Plugins des Programms übernehmen, ohne dessen
  Hooks und MCP-Server (siehe `docs/cli-backends.md`). `backend.backends.claude|codex` liefert dazu `models:[{id,label}]`, `efforts:[…]` und `installed:{skills, plugins}`.
- Modellwahl im Chat: `{type:"settings", settings:{model:"claude/<modell>"|"codex/<modell>"}}` setzt `config.model` des aktiven Programms (`default` = Vorgabe);
  `state.models` führt „Vorgabe“ und die Liste des Programms.
- Limits: `{type:"limits_get", force?}` → `{type:"limits", limits:{claude?, codex?}}`, je `{kind, ok, windows:[{id,label,usedPercent,resetsAt?,resetText?}], plan?, note?, error?, at}`;
  ohne Modellaufruf (Claude Code `/usage`, Codex App-Server `account/rateLimits/read`).
- Eigene Werkzeuge: nur die von Jarvis (MCP `jarvis`, dieselben Sperren und derselbe Not-Aus über jarvisd). Bearbeiten/erneutes Senden und
  Zurücksetzen auf eine Nachricht sind für beide noch nicht möglich und werden abgelehnt.
