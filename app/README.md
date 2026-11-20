# Jarvis3 Desktop (Tauri 2)

Die Hülle lädt die lokale Oberfläche aus `app/ui`. Die Oberfläche verbindet sich mit `ws://127.0.0.1:7777/ui`. Beim Start verwendet die Hülle vorhandene Instanzen oder startet `jarvisd` mit Bun und den Sprach-Sidecar mit uv. Für jarvisd prüft sie `GET /health`, beim Sidecar den lokalen Listener auf Port 7778. Das `ready`-Ereignis der Sprache läuft über den WebSocket an jarvisd.

Das Fenster lässt sich schließen und aus der Menüleiste oder über den Hotkey wieder öffnen. **Beenden** im Menü beendet die Hülle und ihre eigenen Dienste. Bereits separat gestartete Dienste bleiben dabei aktiv. Unter macOS beendet auch `SIGTERM` die Hülle sauber.

## macOS

Benötigt werden Xcode Command Line Tools, Rust Stable, Bun, uv und `opencode`. Die Abhängigkeiten in `core` und `speech` müssen verfügbar sein. Aus der Repo-Wurzel:

```sh
(cd core && bun install --frozen-lockfile)
uv sync --project speech --locked
cd app

# Entwicklung
bunx --package @tauri-apps/cli@2.12.6 tauri dev

# App-Bundle
bunx --package @tauri-apps/cli@2.12.6 tauri build --bundles app

# Rust-Tests
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Mit installierter Tauri-Rust-CLI funktionieren aus `app` auch `cargo tauri dev` und `cargo tauri build --bundles app`. Das Bundle liegt unter `app/src-tauri/target/release/bundle/macos/Jarvis3.app`. Ein Debug-Bundle baut derselbe Befehl mit `--debug`.

`Jarvis3.app/Contents/MacOS/jarvis3 --background` startet die Hülle ohne sichtbares Fenster. Auch der optionale Autostart benutzt diesen Modus. Unter **Beim Anmelden starten** im Tray lässt er sich ein- oder ausschalten. Der aktuelle Stand braucht zur Laufzeit noch den Checkout und die installierten Tools. Falls die Hülle den Checkout nicht findet oder er verschoben wurde, vor dem Start `JARVIS_REPO` auf dessen absoluten Pfad setzen. Die Auslieferung der beiden Dienste als eigenständige Bundle-Sidecars folgt separat.

Das Bundle enthält `NSMicrophoneUsageDescription`. macOS fragt den Zugriff beim tatsächlichen Mikrofonzugriff an. Falls der Python-Sidecar im Entwicklungsbetrieb unter einem Terminal läuft, kann die Freigabe dem Terminal oder dessen verantwortlichem Prozess zugeordnet sein. Bedienungshilfen und Bildschirmaufnahme für die Desktop-Steuerung verwaltet `uimap`. Die Freigaben finden sich unter **Systemeinstellungen → Datenschutz & Sicherheit**.

## Windows

Visual Studio Build Tools mit C++-Desktoptools und WebView2 Runtime sowie Rust Stable, Bun, uv und `opencode` installieren. In PowerShell aus der Repo-Wurzel:

```powershell
Set-Location core
bun install --frozen-lockfile
Set-Location ..
uv sync --project speech --locked
Set-Location app
bunx --package @tauri-apps/cli@2.12.6 tauri build --bundles msi
```

Der Installer liegt unter `app/src-tauri/target/release/bundle/msi` (z. B. `Jarvis3_0.1.0_x64_de-DE.msi`). Der Windows-Installer enthält die Hülle und die UI. Er nutzt weiterhin den lokalen Checkout und dessen Dienste; siehe **Bundling** unten. Der Build wurde am 21.11.2026 mit Rust 1.100.0 und Tauri-CLI 2.12.6 erfolgreich ausgeführt. `bunx.exe` war in der WinGet-Installation nicht vorhanden; `bun x --package @tauri-apps/cli@2.12.6 tauri build --bundles msi` ist funktional gleichwertig.

## Hotkeys

| Funktion | macOS | Windows |
| --- | --- | --- |
| Fenster zeigen oder ausblenden | Cmd+Shift+J | Ctrl+Shift+J |
| Sprachmodus umschalten | Cmd+Shift+Leertaste | Ctrl+Shift+Leertaste |
| Not-Aus | Cmd+Shift+Esc | Ctrl+Alt+Shift+Esc |

Windows reserviert Ctrl+Shift+Esc für den Task-Manager; die Hülle registriert dort nur den Ersatzhotkey. Damit kann die Registrierung nicht mehr an der Task-Manager-Belegung scheitern. Der Not-Aus im Tray funktioniert über denselben `POST /stop` wie der Hotkey. [Microsoft-Dokumentation zu Windows-Tastenkombinationen](https://support.microsoft.com/en-us/accessibility/windows/keyboard-shortcuts-in-windows)

## Bundling: Checkout-freier Installer (Konzept, noch nicht umgesetzt)

**Aktueller Stand:** `services.rs` sucht über `repo_root()` nach `core/src/index.ts` und `speech/pyproject.toml` und startet danach `bun run core/src/index.ts` sowie `uv run --project speech python -m jarvis_speech` aus dem Checkout. Die UI liegt bereits im Bundle (`frontendDist`), die Dienste nicht. Ein MSI ohne Checkout startet deshalb keine Dienste.

**Ziel:** Zur Laufzeit ein beschreibbares Verzeichnis, z. B. `%LOCALAPPDATA%\Jarvis3\runtime`, mit `core/`, `speech/`, `bin/bun.exe`, `bin/uv.exe`, portablem Python, einem `opencode`-Binary und einem Offline-Paket-Cache. `services.rs` bekommt eine `runtime_root()`-Auflösung: `JARVIS_REPO` für die Entwicklung, sonst Installationsressourcen; alle Kindprozesse nutzen absolute Binary-Pfade statt `PATH`. Ein `uv sync --offline --python <portables Python>` erzeugt die virtuelle Umgebung beim ersten Start unter `%LOCALAPPDATA%`, damit nie in `Program Files` geschrieben wird. `core` braucht zusätzlich `bun install --frozen-lockfile --offline` und `opencode` im PATH des Kindprozesses.

**Aufwand (grobe Schätzung):**

| Schritt | Aufwand | Anmerkung |
| --- | --- | --- |
| Ressourcen im MSI, `runtime_root()` und absolute Pfade | 0,5–1 Tag | Eigenständige Änderung in `src-tauri` |
| Bun + `core/node_modules` + `opencode` bündeln | 1 Tag | Bun-Binary ca. 120 MB, Lizenz/Größe von `opencode` prüfen |
| uv + portables Python + Offline-Wheel-Cache | 1–2 Tage | `.venv` ist nicht verschiebbar (absolute Shebangs/`pyvenv.cfg`) |
| CUDA-Abhängigkeiten der Sprache | 0,5–2 Tage | CPU-only ca. 200 MB, CUDA Several GB; Default/cpu-Fallback entscheiden |
| Installer-Upgrade/Deinstallation und Clean-VM-Test | 1 Tag | Test ohne Checkout, ohne Bun/uv/Python/opencode |

**Entscheidung:** Nicht in diesem Auftrag umgesetzt. Der Umbau betrifft Release-Pipeline, Abhängigkeiten und Installation und ist größer als die Hülle selbst. Erst die Konfiguration und ein sauberer Build, dann die oben genannten Punkte als eigener Schritt. Bis dahin gilt: MSI braucht auf dem Zielrechner entweder den Checkout plus Tools oder ein manuell vorbereitetes `JARVIS_REPO`.

## Abnahme

- Automatisch auf macOS geprüft: Rust-Tests, Tauri-Debug-Bundle, Mikrofon-Verwendungszweck in der Paket-Plist, unsichtbarer Start, Registrierung aller drei macOS-Hotkeys, Health-Checks sowie Start und Ende der eigenen Prozesse. Für den Sprachprozess diente ein lokaler Port-Testdienst. Ein separat gestarteter jarvisd blieb erreichbar.
- Windows 21.11.2026: MSI-Build erfolgreich (3,92 MiB), `cargo test` 2/2 grün. Fenster startet sichtbar mit 1100×760 (Rahmen 1116×769), randlos, hell und dunkel geprüft. `Ctrl+Shift+J` blendet ein/aus; `Ctrl+Shift+Space` öffnet die sichtbare Live-Ansicht. Registrierung von `Ctrl+Alt+Shift+Esc` ohne Task-Manager-Konflikt; `Ctrl+Shift+Esc` wird auf Windows nicht mehr registriert.
- Not-Aus geprüft: Gegen einen isolierten Mock-Daemon auf Port 7799 wurden `GET /health` und danach `POST /stop` protokolliert und vom Hüllen-Log als bestätigt gemeldet. Am echten jarvisd folgte auf den Hotkey ein Werkzeugaufruf mit `{"ok":false,"error":"vom Nutzer gestoppt"}`; danach lief kein Werkzeug. Ein Rust-Test prüft separat `GET /health` und `POST /stop`.
- Fenster schließen: `WM_CLOSE` wird abgefangen, das Fenster versteckt sich und die Hülle löst vorher `voice: off` über die UI aus; kein Fehler im Hüllen-Log. Beim App-Beenden schließt die Webview ihren WebSocket, worauf jarvisd die Stimme auf `off` setzt.
- Offen: Der Tray-Eintrag wurde im Log erfolgreich erzeugt (`setup_tray`), lies sich aber nicht per UI-Automation in der Windows-Taskleiste eindeutig identifizieren; Klick-Abnahme fehlt. In dieser Testumgebung hält ein zusätzlicher WebSocket-Client (`opencode-cli`) eine UI-Verbindung und setzt den Voice-Modus sofort wieder auf `off`; der Hotkey erreicht die UI (Live-Ansicht sichtbar), aber die dauerhafte Mikrofon-/Sprachabschaltung konnte nicht isoliert werden. Physische Tastatureingaben statt `SendKeys`, echte Mikrofonaufnahme, Autostart nach Login und Installer-Test auf frischer Maschine stehen noch aus.
