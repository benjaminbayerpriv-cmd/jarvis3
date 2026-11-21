# Jarvis 3 – Übergabe für einen neuen Agenten

Lies zuerst diese Datei, dann `docs/protocol.md`, `docs/speech.md`, `docs/app.md`. Offene Fehler stehen im zentralen Fehler-Log (`bun core/scripts/errors.ts`, siehe `docs/errors.md`); behobene Fehler mit `resolve <id>` austragen. Die Nutzerin bzw. der Nutzer schreibt **Deutsch**; antworte auf Deutsch, ehrlich und ohne Beschönigung.

## Was Jarvis 3 ist
Ein lokaler KI-Assistent für den Desktop (Mac und Windows). Ersetzt den verbuggten alten Jarvis. Bausteine:

| Teil | Ordner | Sprache | Zweck |
|---|---|---|---|
| Daemon `jarvisd` | `core/` | Bun/TypeScript | Zentrale auf `127.0.0.1:7777`: startet `opencode serve` (Port 4096) als Gehirn, bietet den Jarvis-MCP (Desktop- und Browser-Werkzeuge) an, verbindet UI, Chrome-Erweiterung, Sprach-Sidecar |
| Oberfläche | `app/ui/` | HTML/CSS/JS (ohne Build) | Gemini-Look, Chat, Modellwahl, Live-Sprachmodus. Im Browser testbar: `http://127.0.0.1:7777/app/` |
| Desktop-Hülle | `app/src-tauri/` | Rust (Tauri 2) | Fenster, Tray, globale Hotkeys, Not-Aus, startet Daemon und Sidecar |
| Sprach-Sidecar | `speech/` | Python (uv) | Mikro → Silero-VAD → Parakeet-STT; Supertonic-TTS (Stimme M1, 5 Schritte, Tempo 1,25); WebSocket `7778` |
| Bildschirm-Werkzeug Mac | `tools/uimap-mac/` | Swift | `uimap serve`: nummerierte Bedienelemente als JSON/Text, Klick/Tippen/Lesen/Screenshot **nur bei Bedarf** |
| Bildschirm-Werkzeug Windows | `tools/uimap-win/` | C# (.NET 8) | Gleicher Vertrag mit UI Automation; **auf echtem Windows noch ungetestet** |
| Chrome-Erweiterung | `extension/` | JS (MV3) | Tab-Gruppe „Jarvis“ im Hintergrund, Seitenelemente scannen/klicken/tippen |
| Projekte | `~/.jarvis3/projects/` | JSON in Ordnern | Projekte mit Chat-Unterordnern; KI ordnet neue Chats zu, Nutzer verwaltet per `project_*`-Werkzeugen und „Projekte“-Tab |

Kernidee: Die KI bekommt Bedienelemente als **Textliste** (`12 Button „Senden“ @640,812`) und klickt per ID. Screenshots nur auf ausdrückliche Anfrage (`look`). Die Modelle laufen über **OpenCode** (kostenlose Free-Modelle, LM Studio lokal, NVIDIA).

## Start auf dem Mac
```sh
(cd core && bun install)
uv sync --project speech
cd core && bun run src/index.ts          # Daemon (startet opencode serve selbst)
uv run --project speech python -m jarvis_speech   # Sprach-Sidecar (eigenes Terminal)
# Oberfläche: http://127.0.0.1:7777/app/   oder Tauri: cd app && bunx --package @tauri-apps/cli@2.12.6 tauri dev
```
Tests: `cd core && bun test`, `uv run --project speech python speech/tests/test_sidecar.py`, `bun extension/test/browser.mjs`.
Einstellungen des Nutzers liegen in `~/.jarvis3/settings.json` (nicht im Repo).

## Harte Regeln des Nutzers
- **Kein Computer Use über Spaces/Fokus** auf dem Rechner des Nutzers (hat dessen Spaces zerstört). Aufgaben an andere Agenten per CLI, nicht per Bildschirmsteuerung.
- **Nie Passwörter oder Zahlungsdaten** eingeben oder auslesen (`uimap` und Erweiterung sperren Passwortfelder).
- Keine API-Schlüssel ins Repo. `workspace/` und `~/.jarvis3/` sind ignoriert.
- Gemini-Look der UI: Werte stammen 1:1 aus gemini.google.com (Tokens in `app/ui/styles.css`). Eigene Icons plus Tabler Icons (`app/ui/tabler.js`). Der Ladeindikator ist bewusst ein **kleines einfarbiges Zeichen**, nicht bunt. Der bunte Gemini-Lader gehört nur in den Live-Modus.
- Volle Autonomie ist gewünscht (Nutzerentscheidung); der Standardmodus ist trotzdem „nur Browser“, Computer-Übernahme per Schalter, Not-Aus Cmd/Ctrl+Shift+Esc.

## Bekannte offene Punkte (Stand 2026-11-20)
1. **Sprachmodus** funktioniert laut Nutzer „extrem schlecht“. Gefixt: Mikro blieb offen, wenn die UI zu war (Daemon setzt Voice jetzt auf `off`); Rauschfilter `worthAnswering` in `core/src/index.ts`. **Noch zu prüfen mit echtem Mikrofon/Lautsprecher** (Echo, Fehlerkennung, Antwortverhalten).
2. **Windows komplett ungetestet**: `tools/uimap-win`, Sprach-Sidecar (faster-whisper, SAPI, PortAudio), Tauri-MSI, Hotkeys (Ctrl+Shift+Esc kollidiert mit Task-Manager → Ersatz Ctrl+Alt+Shift+Esc). `uimap-win` hat noch keinen Befehl `key` (siehe `docs/protocol.md`).
3. Tauri-App nutzt zur Laufzeit noch den Checkout (`JARVIS_REPO`), keine gebündelten Sidecars.
4. Browser-Test „Wikipedia öffnen, suchen, erstes Ergebnis anklicken“ lief nur teilweise durch (Aktionen ausgeführt, Antwort nach 170 s nicht erhalten).
5. Free-Modelle von OpenCode sind unterschiedlich schnell: `deepseek-v4.1-flash-free` ≈ 1,7 s bis zum ersten Wort (Standard), `big-pickle` ≈ 15 s.

## Arbeitsweise
- Kleine, überprüfbare Schritte; vor „fertig“ wirklich ausführen und Messwerte nennen.
- Commit-Nachrichten auf Deutsch, ein Thema pro Commit. Auf `main` arbeiten wir mit Feature-Branches und Pull Requests.
- Offene Fragen an den Nutzer sammeln und gebündelt stellen.
