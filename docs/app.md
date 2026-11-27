# Desktop-App (Tauri) – Vertrag (app/)

Aufteilung: **Hülle** = `app/src-tauri` (Rust, Codex). **Oberfläche** = `app/ui` (HTML/CSS/JS, Claude) – die Hülle ändert `app/ui` nicht.

## Hülle
- Tauri 2. Startet beim Öffnen `jarvisd` (`bun run core/src/index.ts`, Arbeitsordner Repo-Wurzel) und den Sprach-Sidecar
  (`uv run --project speech python -m jarvis_speech`), sofern noch nicht laufend (`GET http://127.0.0.1:7777/health`).
  Beendet beide beim Schließen. Entwicklung: Pfade relativ zum Repo; Bundle: später als Sidecars.
- Fenster lädt `app/ui/index.html` (lokal gebündelt). Die UI spricht selbst per WebSocket mit `ws://127.0.0.1:7777/ui`.
- Fenster: 1100×760, min. 380×560, randlos mit eigener Titelleiste (macOS: `titleBarStyle: Overlay`, Ampel bleibt sichtbar), Hintergrund aus UI.
- Globale Hotkeys:
  - `Cmd+Shift+J` / `Ctrl+Shift+J`: Fenster zeigen/verstecken (Fokus ins Eingabefeld → JS-Event `jarvis:focus`).
  - `Cmd+Shift+Space` / `Ctrl+Shift+Space`: Sprachmodus umschalten → JS-Event `jarvis:voice`.
  - **Not-Aus** `Cmd+Shift+Escape` (macOS) / `Ctrl+Alt+Shift+Esc` (Windows, `Ctrl+Shift+Escape` ist dort für den Task-Manager reserviert): `POST http://127.0.0.1:7777/stop` (auch wenn Fenster zu).
- Tray/Menüleisten-Symbol: Öffnen, Sprachmodus, Not-Aus, Beenden. Icon: `app/ui/icons/tray.svg` (liefert Claude; bis dahin Platzhalter).
- Rechte macOS: Mikrofon (`NSMicrophoneUsageDescription`), Bedienungshilfen und Bildschirmaufnahme werden von `uimap` angefragt (Hinweis im Readme).
- Windows: gleiche Funktionen; Build .msi.
- Autostart beim Login optional (Einstellung, Tauri-Plugin autostart).

## Sprache / Mikrofon
- Der Sidecar meldet seine Audiogeräte im `speech`-Event `ready`; jarvisd cached sie im `state` (`devices`).
- Einstellung `micDevice` in `~/.jarvis3/settings.json` (PortAudio-Geräte-ID oder `null` = Systemstandard). Die UI bietet dafür eine Auswahl unter „Einstellungen → Mikrofon“ (mehrfach gelistete Geräte werden mit `#ID` unterschieden) und schickt `{type:"settings", settings:{micDevice:…}}`. Der Daemon leitet das als `{type:"config", input:…}` an den Sidecar weiter; ein Wechsel während des Live-Modus übernimmt sofort. Verschwindet die ID (z. B. nach Neustart), fällt der Daemon beim `ready`-Event auf den Systemstandard zurück.
- `voice:off` wirkt nur von der Oberfläche, die den Live-Modus auch gestartet hat (`voiceOwner` im Daemon). Andere verbundene UIs oder alte Registerkarten können ein Gespräch nicht mehr beenden. Verliert der Besitzer die Verbindung, schaltet jarvisd selbst auf `off`.

## Einstellungen

Die Einstellungen sind über die Seitenleiste oder über `/einstellungen` erreichbar. Die Suche findet Einträge gruppenübergreifend.

- **Allgemein**: Chatmodell, KI-Titel, automatische Projektzuordnung und Autostart beim Anmelden (Desktop).
- **Sprache und Audio**: Ein- und Ausgabegerät, Spracherkennung, Live-Modell, Stimme und Tempo. Die Stimmprobe arbeitet mit dem aktuell gewählten Ausgabegerät, wenn Live und Diktat aus sind. Sprachausgabe und Aktionsansagen lassen sich separat ausschalten.
- **Darstellung**: Farbschema, Chat-Schriftgröße, reduzierte Bewegung, Untertitel, Werkzeugschritte, Antwortzeiten, Enter-Tastenkürzel. Diese Auswahl gilt lokal in der jeweiligen App oder im Browserprofil.
- **Steuerung**: Computer-Modus, automatische Vorschau, Ruhezeit, Zeigerbild und Rücksetzen der Vorschau-Breite.
- **Datenschutz**: automatische Diagnosebilder und das Sprachprotokoll `voice.log`. Beide Schalter beeinflussen künftige Aufzeichnungen. Andere Fehler der App bleiben im Fehlerprotokoll sichtbar.

Jarvisd prüft Änderungen aus `{type:"settings", settings:{…}}`, speichert gültige Felder und bestätigt sie im `state`. Standardwerte gelten auch für bestehende Konfigurationen, in denen neue Felder fehlen.

## Sprach-Animation im Eingabefeld
Im Live-Modus und beim Diktat klappt das Eingabefeld nach oben auf (`#voice`, `composer[data-voice="live"|"dictate"|"off"]`). Oben steht der erkannte Text (im Live-Modus bei Jarvis' Antwort dessen Text), darunter eine Canvas mit Wellen: blau = Mikrofon, rosa = Ausgabe von Jarvis. Die Amplitude folgt dem echten Pegel der `level`-Ereignisse des Sidecars (`mic`/`out`); ohne Ereignisse bleibt eine ruhige Grundbewegung, stumm = flache Linie. Im Ruhezustand ist der Bereich eingeklappt. Fehler der Animation landen als `ui`-Eintrag im Fehler-Log. Die frühere Vollbild-Ansicht entfällt.
## Projekte
- **Projekte sind die einzigen Ordner.** Die Seitenleiste zeigt dieselben Projekte (Abschnitt „Projekte“, Verschachtelung als Pfad „A / B“); Chat-Verschieben laufen über `chat_action` und legen echte Projektordner an. Alte Ordner aus `chat-folders.json`/`chat-meta.json` werden beim Start einmalig zu Projekten migriert. Der Menüpunkt „Projekte“ öffnet die Projekte-Seite wie bei Claude: Überschrift, Tabs „Deine Projekte“ / „Archiviert“, Suche, Sortierung (Zuletzt aktiv, Älteste Aktivität, A bis Z, Z bis A, Neueste zuerst, Älteste zuerst, Meiste Chats; wird gemerkt) und ein einziger Button „Neues Projekt“; darunter alle Projekte als Kacheln (Anheften, Umbenennen, Archivieren, Löschen im Kachelmenü). Ein Klick auf eine Kachel öffnet die Projektansicht (Baum links, Inhalt rechts: Unterprojekte = Ordner, Chats = Dateien, Verschieben-Menü). `pinned`/`archived` stehen in der `project.json`. Die KI-Zuordnung läuft weiter automatisch (beim Anlegen eines Projekts und für neue Chats); der frühere Knopf „Automatisch zuordnen“ ist entfernt.
- Projekte sind echte Ordner unter `~/.jarvis3/projects/<projekt>/`, Chats liegen als Unterordner `chats/<session-id>/chat.json` (Titel, Zuordnung, Analyzestatus). Die Nachrichten selbst bleiben in OpenCode; die Ordner sind nur die Struktur. Unterprojekte sind verschachtelte Projektordner.
- Der Daemon übernimmt OpenCode-Sitzungen beim Verbinden und bei jedem Verlaufsabruf. Noch nicht zugeordnete Chats werden im Hintergrund vom schnellen Gratis-Modell einem passenden Projekt zugeordnet (`ki`); manuelle Zuordnungen (`manual`) werden nie überschrieben. Ein neues Projekt löst die erneute Prüfung freier Chats aus. Die Analyse läuft parallel und blockiert keine Antwort.
- Modellwerkzeuge: `project_list`, `project_create`, `project_update`, `project_delete`, `project_assign`, `project_analyze` (in der Modellansicht mit Präfix `jarvis_`). `project_list` zeigt IDs, die die übrigen Werkzeuge brauchen.
- WebSocket: `{type:"projects", projects, chats, root}` kommt bei Verbindung und nach jeder Änderung; `{type:"projects"}` erfragt den Baum, `{type:"project_action", op:"create|update|delete|assign|analyze|sync", …}` ändert ihn. Die Oberfläche bietet dafür „Projekte“ in der Seitenleiste mit Baum, Neues-Projekt-Formular, Chat-Zuordnung und Lösen.
- HTTP für das MCP: `GET /projects` → Baum, `POST /projects` → dieselben Aktionen wie `project_action`.

## Parallele Chats
Mehrere Chats laufen gleichzeitig; jeder hat seinen eigenen Lauf (OpenCode-Sitzung) und Stopp.
- jarvisd führt `busySessions` (Set der laufenden Chats) und `latestRun` (neueste Lauf-Nummer je Chat). Eine neue Nachricht löst nur den Lauf **desselben** Chats ab. `state` enthält `busySessions`; `busy` gilt nur für den gezeigten Chat (`session`).
- Chat-Ereignisse (`delta`, `reasoning`, `tool`, `latency`, `error`, `done`, `stopped`) tragen `session`. Die Oberfläche zeigt nur Ereignisse ihres gerade offenen Chats; laufende Chats markiert die Seitenleiste mit einem Punkt (`running` im Verlauf).
- `chat` und `run_command` tragen `session` (null = neuer Chat). `stop` stoppt nur `session` bzw. den gezeigten Chat; `stop {all:true}` und `POST /stop` (Not-Aus) stoppen alle.
- Wechselt man zu einem laufenden Chat (`open`), antwortet jarvisd mit `messages {running:true}` ohne die halbe Antwort und spielt die gepufferten Ereignisse (`core/src/runbuf.ts`) nach.
- Browser und Bildschirm sind gemeinsame Werkzeuge: zwei Chats, die gleichzeitig dieselben Tabs bedienen, können sich in die Quere kommen.

## jarvisd-Endpunkte für die Hülle
- `GET /health` → `{ok, opencode, browser}`
- `POST /stop` → Not-Aus (bricht Modell ab, sperrt Werkzeuge kurz, stoppt Sprache)

## Anhänge („+“ im Eingabefeld)
- Auswahl per Dateidialog, Ziehen und Ablegen auf das Fenster oder Einfügen (Strg/Cmd+V) von Bildern. Vorschau-Chips über dem Eingabefeld, jeder Chip hat ein ✕ zum Entfernen vor dem Senden.
- Grenzen (UI und Daemon, `core/src/attachments.ts` `LIMITS`): höchstens 8 Dateien, je 10 MB, zusammen 25 MB. Verstöße zeigt die UI an und meldet sie als `client_error` ins Fehler-Log.
- Protokoll: `{type:"chat", text, attachments:[{name, mime, data}]}`, `data` = Base64 ohne `data:`-Präfix. `text` darf leer sein.
- jarvisd legt jede Datei unter `workspace/uploads/` ab (damit auch Werkzeuge sie lesen können) und bereitet sie auf:
  - **Bilder** (PNG, JPEG, GIF, WebP) gehen als Bildteil an das Modell. Kann das gewählte Modell keine Bilder (`vision` in der Modellliste), wechselt jarvisd nur für diese Nachricht auf das erste verfügbare Bildmodell (Gratis zuerst) und meldet das per `notice`; gibt es keins, steht nur der Dateipfad im Prompt plus Hinweis.
  - **Text-/Code-Dateien** (UTF-8) werden eingebettet, über 60 000 Zeichen gekürzt.
  - **PDF**: Text per `pdftotext` (poppler), falls installiert; sonst nur Pfad.
  - Alles andere: nur Pfad, dazu ein Hinweis; Fehlschläge landen als Kategorie `ui`, Quelle `jarvisd/attachment` im Fehler-Log.

## App-Name (Einstellungen → Allgemein → „Name der App“)

`appName` in `~/.jarvis3/settings.json` (Standard „Jarvis“, 1 bis 24 Zeichen, keine Steuerzeichen und `< > " ` \`; Prüfung `cleanAppName` in `core/src/settings.ts` und `app/ui/appname.js`). Gilt sofort für alle verbundenen Oberflächen (`state.appName`):

- **Oberfläche:** `app/ui/appname.js` ersetzt „Jarvis“ in Texten und Beschriftungen (`title`, `placeholder`, `aria-label`, `alt`), im Seitentitel und, in der Desktop-Hülle, im Fenstertitel; auch bei später erzeugten Hinweisen. Nicht ersetzt werden die Chatnachrichten (Verlauf bleibt) und Elemente mit `data-keep-name`.
- **Daemon:** Die Anweisung an das Modell (`systemPrompt(name)`, alle Backends) stellt den Assistenten mit dem Namen vor; Hinweise, Fehler und Ansagen (`notice`, `error`, `say`) nennen ihn. „Jarvis Bildschirm“ (Name der macOS-App) bleibt.
- **Unverändert, weil technisch:** die Tab-Gruppe „Jarvis“ im Chrome des Nutzers, Werkzeug- und Dateinamen (`jarvis_*`, `~/.jarvis3`), Name der macOS-Hilfs-App, Menüleisten-Symbol und Programmname der Desktop-Hülle (dafür wäre ein neuer Build nötig).
