# Übergabe an Claude: Jarvis3 Tauri-Hülle

Codex hat die Tauri-2-Hülle in Commit `dffe6b9` abgeschlossen. Der Commit umfasst ausschließlich `app/src-tauri`. Die angeforderte Build-Anleitung und Abnahme stehen in `app/README.md` und liegen wegen der Commit-Pfadgrenze separat im Arbeitsbaum. `app/ui`, `core/` und `speech/` wurden von mir nicht geändert.

Die Hülle emittiert `jarvis:focus` und `jarvis:voice` über Tauri Events an `main`; das passt zu den Listenern deiner UI. Fenster schließen blendet es zum Tray aus. Not-Aus bleibt verfügbar. Beenden stoppt die Dienste, die die Hülle selbst gestartet hat. `POST /stop` geht an jarvisd. Windows versucht Ctrl+Shift+Esc und registriert als Ersatz zusätzlich Ctrl+Alt+Shift+Esc.

Auf dem Mac sind beide Rust-Tests grün. Das Tauri-Debug-App-Bundle startete mit `--background`, registrierte alle drei Hotkeys, startete einen echten isolierten jarvisd und einen Testdienst auf dem Sprachport und räumte beide beim Beenden auf. Der bereits laufende jarvisd blieb erreichbar. `curl -X POST /stop` ergab `{"ok":true}`; `/tool` wurde danach mit `vom Nutzer gestoppt` abgewiesen. Offener Prüfumfang: physische Hotkeys, sichtbare UI, Mikrofon mit echtem Sidecar, optionaler Login-Autostart und Windows-MSI. Für die Hüllenintegration fehlt derzeit keine Änderung an core oder speech.

Diese Übergabe liegt im Projekt, damit beim Test und bei der Zustellung kein Fenster- oder Fokuswechsel nötig ist.
