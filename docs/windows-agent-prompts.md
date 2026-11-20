# Prompts für den Windows-Agenten

Der Agent läuft auf Windows (Tower) und weiß nichts über das Projekt. Reihenfolge: Prompt 0, dann 1, 2, 3. Jeder Prompt endet mit einem Bericht, den der Nutzer an Claude weitergibt.

## Prompt 0 – Einrichten und Überblick
```text
Du arbeitest auf einem Windows-PC an dem Projekt "Jarvis 3" (privates GitHub-Repo benjaminbayerpriv-cmd/jarvis3). Der Nutzer spricht Deutsch, antworte auf Deutsch, ehrlich und ohne Beschönigung.

1. Klone das Repo nach C:\dev\jarvis3 (git clone https://github.com/benjaminbayerpriv-cmd/jarvis3), arbeite auf einem eigenen Branch windows/setup.
2. Lies docs/HANDOFF.md, dann docs/protocol.md, docs/speech.md, docs/app.md und tools/uimap-win/README.md.
3. Installiere, falls fehlend: Git, Bun, uv, Rust (stable, MSVC), Visual Studio Build Tools (C++-Desktop), .NET 8 SDK und Desktop Runtime, WebView2 Runtime, opencode (https://opencode.ai). Prüfe jede Version mit --version und liste sie auf.
4. Starte den Daemon: cd core; bun install; bun run src/index.ts. Prüfe http://127.0.0.1:7777/health (erwartet {"ok":true,"opencode":true}) und http://127.0.0.1:7777/app/ im Browser.
5. Führe die vorhandenen Tests aus (cd core; bun test) und notiere, was auf Windows fehlschlägt.

Regeln: Keine Passwörter oder Schlüssel ins Repo. Verwende kein Computer Use auf fremden Rechnern. Committe kleine Schritte auf deutsch, pushe deinen Branch, öffne am Ende einen Pull Request nach main.
Bericht am Ende: Versionen, was lief, was nicht, nächste Hindernisse.
```

## Prompt 1 – Bildschirm-Werkzeug (uimap-win) auf echtem Windows abnehmen
```text
Projekt Jarvis 3, Repo C:\dev\jarvis3, neuer Branch windows/uimap. Lies zuerst docs/HANDOFF.md und docs/protocol.md.

Aufgabe: tools/uimap-win (C#/.NET 8, UI Automation) wurde auf dem Mac nur cross-kompiliert und lokal gegen Protokoll-Tests geprüft. Es ist auf echtem Windows NICHT getestet. Bitte:
1. Baue es nach tools/uimap-win/README.md zu bin/uimap.exe (Pfad muss zu core/src/desktop.ts passen).
2. Teste "uimap.exe serve" mit JSON-Zeilen auf stdin gegen Notepad, den Windows-Explorer, Chrome, Discord und die Einstellungen-App: scan (Listen mit sinnvollen Labels, sichtbare Elemente, verdeckte Fenster ausgeblendet), click per ID, type in ein Textfeld, read (UIA-Text, sonst OCR via Windows.Media.Ocr), shot mit marks:true (PNG mit nummerierten Rahmen), scroll, focus, displays. Passwortfelder müssen "Passwortfeld" heißen und type/read ablehnen.
3. Messe die Scanzeit (Ziel < 300 ms für ein Fenster) und liste Elemente, die fehlen oder falsch beschriftet sind.
4. Ergänze den fehlenden Befehl "key" (z. B. {"cmd":"key","combo":"ctrl+t"}; ctrl statt cmd) nach docs/protocol.md.
5. Behebe gefundene Fehler. Teste dann das Zusammenspiel: Daemon laufen lassen, in der Weboberfläche (http://127.0.0.1:7777/app/) den Schalter "Computer" einschalten und Jarvis bitten: "Öffne den Editor, schreibe Hallo und sag mir, was im Fenster steht." Notiere das Ergebnis.
Committe nur unter tools/uimap-win und docs/protocol.md, Pull Request nach main.
Bericht: Messwerte, Testtabelle pro Programm (ok/Fehler), offene Probleme.
```

## Prompt 2 – Sprach-Sidecar auf Windows
```text
Projekt Jarvis 3, Repo C:\dev\jarvis3, Branch windows/speech. Lies docs/HANDOFF.md und docs/speech.md.

Aufgabe: Der Sprach-Sidecar (speech/, Python mit uv, WebSocket ws://127.0.0.1:7778) lief bisher nur auf dem Mac (Parakeet über MLX, Supertonic-Stimme M1 mit 5 Schritten und Tempo 1,25). Unter Windows soll faster-whisper (large-v3-turbo) die Spracherkennung übernehmen, die Ersatzstimme ist SAPI.
1. uv sync --project speech; python -m jarvis_speech starten (uv run --project speech python -m jarvis_speech). Behebe Windows-Probleme (parakeet-mlx darf dort nicht installiert werden, CUDA/CPU-Wahl für faster-whisper, PortAudio-Geräte, Pfade).
2. Führe speech/tests/test_sidecar.py aus. Messe: Ende des Sprechens bis "final" (Ziel < 400 ms; GPU nutzen, falls vorhanden), und "say" bis erster Ton.
3. Teste mit echtem Mikrofon und Lautsprecher über speech/tests/ws_client.py: mode live, sprechen, final erscheint; say wird gesprochen; eigene Stimme darf kein speech_start auslösen (Echo-Schutz); stop_speaking stoppt in unter 150 ms. Prüfe auch Bluetooth-Headsets.
4. Prüfe die Qualität der deutschen Erkennung mit 10 selbst gesprochenen Sätzen (Zahlen, Eigennamen, Anglizismen) und notiere Fehler.
Committe nur unter speech/, Pull Request nach main.
Bericht: Messwerte, Fehlerliste der Erkennung, was auf Windows anders ist.
```

## Prompt 3 – Tauri-App, Hotkeys, Installer
```text
Projekt Jarvis 3, Repo C:\dev\jarvis3, Branch windows/app. Lies docs/HANDOFF.md, docs/app.md und app/README.md.

Aufgabe: Die Tauri-2-Hülle in app/src-tauri läuft auf dem Mac, Windows ist ungetestet.
1. Baue: cd app; bunx --package @tauri-apps/cli@2.12.6 tauri build --bundles msi. Behebe Build-Fehler.
2. Teste: Fenster-Start, Tray-Symbol, Hotkeys Strg+Umschalt+J (Fenster), Strg+Umschalt+Leertaste (Live-Modus), Not-Aus. Strg+Umschalt+Esc gehört dem Task-Manager; die Hülle registriert als Ersatz Strg+Alt+Umschalt+Esc. Prüfe, dass der Not-Aus wirklich POST /stop an jarvisd schickt und dass nach dem Not-Aus keine Werkzeuge mehr laufen.
3. Prüfe, dass beim Schließen von Fenster/App das Mikrofon aus ist und Jarvis nicht weiterspricht (Daemon setzt Voice off, wenn keine Oberfläche verbunden ist).
4. Die Hülle startet Daemon und Sidecar noch aus dem Checkout. Bereite das Bundling vor (Konzept und, wenn machbar, Umsetzung): Bun und uv/Python als Sidecars, damit ein Installer ohne Checkout läuft. Dokumentiere Aufwand und Entscheidung, bevor du groß umbaust.
Committe nur unter app/src-tauri und app/README.md, Pull Request nach main.
Bericht: Was lief, Screenshots des Fensters (Hell und Dunkel), offene Punkte.
```
