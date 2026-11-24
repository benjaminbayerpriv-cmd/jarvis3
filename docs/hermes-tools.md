# Jarvis-Werkzeuge in Hermes

Hermes Agent ist ein MCP-Client. Jarvis stellt seine Werkzeuge (Browser, Computer-Steuerung, Vorschau …) über `core/src/mcp.ts` bereit; Hermes startet diesen Server per stdio. Quellen: Hermes-Doku „MCP Config Reference“, „MCP“, „API Server“, „Browser“ und „Computer Use“ (Repository NousResearch/hermes-agent, `website/docs`).

## Einrichten

```sh
bun core/scripts/hermes-jarvis.ts setup            # schreibt ~/.jarvis3/hermes/config.yaml (eigenes HERMES_HOME, fasst ~/.hermes nicht an)
bun core/scripts/hermes-jarvis.ts test             # hermes mcp test jarvis: Verbindung + Anzahl Werkzeuge
bun core/scripts/hermes-jarvis.ts add-command      # Alternative: Befehl für eine bestehende Hermes-Installation
```

Die Konfiguration (`core/src/hermes-tools.ts`, `managedConfig`) enthält nie einen Schlüssel. Eine fremde `config.yaml` ohne Jarvis-Markierung wird nicht überschrieben (nur mit `--force`).

## Regeln, die gelten bleiben

* **Hermes' eigene Werkzeugsätze `browser` und `computer_use` sind abgeschaltet** (`agent.disabled_toolsets`). Sie umgingen Passwortsperre, Computer-Steuerung an/aus, Not-Aus und Vorschau. Geprüft mit `hermes tools list`.
* Jeder Aufruf läuft über jarvisd (`POST /tool`). Damit gelten dieselben Sperren wie bei OpenCode: Modus „Computer-Steuerung“ aus → Absage, Not-Aus (`stoppedUntil`) → Absage, Passwortfelder bleiben gesperrt.
* Werkzeugnamen in Hermes: `mcp__jarvis__<werkzeug>` (z. B. `mcp__jarvis__browser_scan`). `baseToolName()` bildet auf den Jarvis-Namen zurück.
* `supports_parallel_tool_calls: false`: Bildschirm- und Seitenaktionen nie gleichzeitig. `trust: full`, weil Jarvis die Regeln selbst durchsetzt.

## Absagen als Text (`JARVIS_MCP_ERRORS=text`)

Hermes sperrt einen MCP-Server nach 3 Fehlerergebnissen in Folge für 60 s (Circuit Breaker). Absagen sind bei Jarvis normal; sonst wären nach drei Absagen alle Werkzeuge 60 s weg. Mit `text` kommen Absagen als normaler Text ohne `isError`. Geprüft mit Hermes' echtem MCP-Client. Die erzeugte Konfiguration setzt das ausdrücklich, weil die installierte Hermes-Version sich als Client „mcp“ meldet und nicht automatisch erkannt wird (`flag` erzwingt das alte Verhalten).

## Gemeinsamer Not-Aus

Kette: Hermes bricht ab → MCP-Abbruch → `extra.signal` → `callContext` (`core/src/mcp-hints.ts`) → laufende Anfrage an jarvisd wird abgebrochen. Zusätzlich mit `JARVIS_STOP_ON_CANCEL=1` (`--stop-on-cancel`) löst ein Abbruch `POST /stop` aus, also den echten Jarvis-Not-Aus. Umgekehrt (Jarvis-Not-Aus → Hermes-Lauf) ist Sache des Backend-Adapters in `core/src/hermes.ts`: `POST /v1/runs/{id}/stop`.

Nicht Teil dieses PR (Entscheidungen für core): siehe PR-Beschreibung.
