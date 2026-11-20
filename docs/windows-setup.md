# Windows-Setup und Verifikation (2026-11-20)

Branch: `windows/setup`. Alle Befehle wurden in PowerShell auf einem Windows-PC ausgeführt.

## Installierte Versionen

| Tool | Version | Befehl |
|---|---|---|
| Git | 2.55.0.windows.5 | `git --version` |
| Bun | 1.4.5 | `bun --version` |
| uv | 0.13.9 | `uv --version` |
| Rust (stable, MSVC) | rustc 1.100.0 / cargo 1.100.0 | `rustc --version`, `cargo --version` |
| Visual Studio Build Tools 2022 (C++-Desktop) | 17.14.45, MSVC 14.44.35207 | winget / `VC\Tools\MSVC` |
| .NET 8 SDK | 8.0.428 | `dotnet --version` |
| .NET 8 Desktop Runtime | 8.0.34 (`Microsoft.WindowsDesktop.App`) | `dotnet --list-runtimes` |
| WebView2 Runtime | 157.0.4341.60 (Registry) | Registry `EdgeUpdate\Clients\{F3017226-…}` |
| opencode | 1.19.6 | `opencode --version` |

Hinweis WebView2: winget meldete erfolgreiche Installation von 158.0.4370.33, die Registry
des Systems zeigt weiterhin 157.0.4341.60. Die Laufzeit ist vorhanden, die Versionsanzeige
ist widersprüchlich.

## Was lief

- Clone nach `C:\dev\jarvis3`, Branch `windows/setup`, keine Secrets im Repo.
- `cd core && bun install`: 92 Pakete installiert, keine Fehler.
- `cd core && bun run src/index.ts`: Daemon startete; `opencode serve` kam hoch.
- `GET http://127.0.0.1:7777/health` → `{"ok":true,"opencode":true,"browser":false}`.
  `browser:false` ist erwartet, solange keine Chrome-Erweiterung verbunden ist.
- `http://127.0.0.1:7777/app/` im Browser: Seite „Jarvis“ geladen, Modell
  `deepseek-v4.1-flash-free` sichtbar, keine Konsolenfehler.
- `cd core && bun test`: 3 Tests bestanden, 0 fehlgeschlagen (8 `expect()`-Aufrufe, 2 Dateien).
  Windows-spezifische Testfehler gab es **nicht**.
- `dotnet publish .\uimap.csproj -c Release -r win-x64 --self-contained false -o .\bin`
  in `tools\uimap-win`: erfolgreich.
- `uimap.exe --help` und `uimap.exe displays`: erfolgreich; zwei Monitore
  (2560×1440 bei x=0 und x=2560) erkannt.

## Was nicht lief / offen

- Keine interaktiven Desktop-Tests mit `uimap-win` durchgeführt (UIA-Klick, Tippen,
  Passwortsperre, OCR, Overlay, DPI/Monitorwechsel). Die Abnahmetabelle in
  `tools/uimap-win/README.md` steht damit weiter aus.
- `uimap-win` hat noch keinen `key`-Befehl (`docs/protocol.md`).
- Sprach-Sidecar nicht gestartet: Modelle, Mikrofon und Lautsprecher nicht geprüft.
- Tauri-App/MSI nicht gebaut; Hotkey `Ctrl+Shift+Esc` kollidiert mit dem Task-Manager
  (Ersatz `Ctrl+Alt+Shift+Esc` ist dokumentiert, aber nicht implementiert/geprüft).
- Browser-Endpunkt der Chrome-Erweiterung nicht getestet (`browser:false`).

## Nächste Hindernisse

1. Interaktive `uimap-win`-Abnahme auf dem entsperrten Desktop (PowerShell direkt oder
   interaktive geplante Aufgabe), inklusive OCR-Sprachpaket prüfen.
2. `uv sync --project speech` und Laufzeittest mit echtem Mikrofon/Lautsprecher
   (Echo, Barge-in, Windows-Audio-Backends).
3. Hotkey-Kollision auflösen und Tauri-Build (`bunx tauri build`) angehen.
4. WebView2-Versionswiderspruch klären, falls Tauri-WebView darauf angewiesen ist.
