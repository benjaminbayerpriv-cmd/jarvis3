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

## Sprach-Animation im Eingabefeld
Im Live-Modus und beim Diktat klappt das Eingabefeld nach oben auf (`#voice`, `composer[data-voice="live"|"dictate"|"off"]`). Oben steht der erkannte Text (im Live-Modus bei Jarvis' Antwort dessen Text), darunter eine Canvas mit Wellen: blau = Mikrofon, rosa = Ausgabe von Jarvis. Die Amplitude folgt dem echten Pegel der `level`-Ereignisse des Sidecars (`mic`/`out`); ohne Ereignisse bleibt eine ruhige Grundbewegung, stumm = flache Linie. Im Ruhezustand ist der Bereich eingeklappt. Fehler der Animation landen als `ui`-Eintrag im Fehler-Log. Die frühere Vollbild-Ansicht entfällt.
## Projekte
- Projekte sind echte Ordner unter `~/.jarvis3/projects/<projekt>/`, Chats liegen als Unterordner `chats/<session-id>/chat.json` (Titel, Zuordnung, Analyzestatus). Die Nachrichten selbst bleiben in OpenCode; die Ordner sind nur die Struktur. Unterprojekte sind verschachtelte Projektordner.
- Der Daemon übernimmt OpenCode-Sitzungen beim Verbinden und bei jedem Verlaufsabruf. Noch nicht zugeordnete Chats werden im Hintergrund vom schnellen Gratis-Modell einem passenden Projekt zugeordnet (`ki`); manuelle Zuordnungen (`manual`) werden nie überschrieben. Ein neues Projekt löst die erneute Prüfung freier Chats aus. Die Analyse läuft parallel und blockiert keine Antwort.
- Modellwerkzeuge: `project_list`, `project_create`, `project_update`, `project_delete`, `project_assign`, `project_analyze` (in der Modellansicht mit Präfix `jarvis_`). `project_list` zeigt IDs, die die übrigen Werkzeuge brauchen.
- WebSocket: `{type:"projects", projects, chats, root}` kommt bei Verbindung und nach jeder Änderung; `{type:"projects"}` erfragt den Baum, `{type:"project_action", op:"create|update|delete|assign|analyze|sync", …}` ändert ihn. Die Oberfläche bietet dafür „Projekte“ in der Seitenleiste mit Baum, Neues-Projekt-Formular, Chat-Zuordnung und Lösen.
- HTTP für das MCP: `GET /projects` → Baum, `POST /projects` → dieselben Aktionen wie `project_action`.

## jarvisd-Endpunkte für die Hülle
- `GET /health` → `{ok, opencode, browser}`
- `POST /stop` → Not-Aus (bricht Modell ab, sperrt Werkzeuge kurz, stoppt Sprache)
