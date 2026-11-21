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

## jarvisd-Endpunkte für die Hülle
- `GET /health` → `{ok, opencode, browser}`
- `POST /stop` → Not-Aus (bricht Modell ab, sperrt Werkzeuge kurz, stoppt Sprache)
