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

Der Installer liegt unter `app/src-tauri/target/release/bundle/msi`. Der Windows-Installer enthält die Hülle und die UI. Er nutzt den lokalen Checkout und dessen Dienste.

## Hotkeys

| Funktion | macOS | Windows |
| --- | --- | --- |
| Fenster zeigen oder ausblenden | Cmd+Shift+J | Ctrl+Shift+J |
| Sprachmodus umschalten | Cmd+Shift+Leertaste | Ctrl+Shift+Leertaste |
| Not-Aus | Cmd+Shift+Esc | Ctrl+Shift+Esc oder Ctrl+Alt+Shift+Esc |

Windows verwendet Ctrl+Shift+Esc für den Task-Manager. Die Hülle versucht die vereinbarte Kombination zu registrieren und bietet zusätzlich Ctrl+Alt+Shift+Esc an. Der Not-Aus im Tray funktioniert über denselben `POST /stop` wie der Hotkey. [Microsoft-Dokumentation zu Windows-Tastenkombinationen](https://support.microsoft.com/en-us/accessibility/windows/keyboard-shortcuts-in-windows)

## Abnahme

- Automatisch auf macOS geprüft: Rust-Tests, Tauri-Debug-Bundle, Mikrofon-Verwendungszweck in der Paket-Plist, unsichtbarer Start, Registrierung aller drei macOS-Hotkeys, Health-Checks sowie Start und Ende der eigenen Prozesse. Für den Sprachprozess diente ein lokaler Port-Testdienst. Ein separat gestarteter jarvisd blieb erreichbar.
- Not-Aus geprüft: `curl -X POST /stop` an eine isolierte echte jarvisd-Instanz ergab `{"ok":true}`. Ein unmittelbar folgender Werkzeugaufruf wurde mit `vom Nutzer gestoppt` abgewiesen. Ein Rust-Test prüft separat die HTTP-Anfrage der Hülle.
- Interaktive Abnahme offen: physischer Tastendruck aller Hotkeys, Fokus und Sprachmodus in der sichtbaren UI, Tray-Menü per Klick, Mikrofonaufnahme des echten Sprach-Sidecars, Anmelde-Autostart nach erneutem Login und Windows-MSI-Build.
