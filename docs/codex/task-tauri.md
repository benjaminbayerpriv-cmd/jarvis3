Du arbeitest mit Claude zusammen an Jarvis3 (~/Documents/Jarvis3). Claude baut die Oberfläche (app/ui) und den Daemon (core/), ein zweiter Codex baut den Sprach-Sidecar (speech/). Deine Aufgabe: die Tauri-2-Desktop-Hülle in app/src-tauri, exakt nach docs/app.md.

- Lies zuerst docs/app.md, docs/protocol.md und core/src/index.ts.
- Fasse app/ui NICHT an. Lege dort höchstens eine minimale Platzhalter-index.html an, falls noch keine existiert, und markiere sie als Platzhalter. Claude überschreibt sie.
- Ändere nichts in core/ oder speech/. Brauchst du dort etwas, schreib es in deine Abschlussnachricht.
- Funktionen: jarvisd- und Sidecar-Start mit Health-Check, globale Hotkeys inklusive Not-Aus (POST /stop), Tray/Menüleiste, randloses Fenster mit macOS-Overlay-Titelleiste, Mikrofon-Berechtigung, optionaler Autostart, Windows-Build-Konfiguration.
- Teste auf dem Mac: cargo tauri dev bzw. build, App startet, Hotkeys und Not-Aus funktionieren (prüfe mit curl, ob /stop ankommt). Benutze dabei kein Computer Use und keine Bildschirmsteuerung. Fokus-, Space- oder Fensterwechsel stören den Nutzer.
- Committe nur Dateien unter app/src-tauri (plus die Platzhalter-UI) mit git add <pfad>. Ein anderer Agent committet parallel. Bei index.lock kurz warten und erneut versuchen.
- Am Ende: Build-Anleitung in app/README.md, was getestet wurde und was offen ist.
