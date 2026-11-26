# Claude Code und Codex als Backends

Jarvis startet je Nachricht einen Lauf des **installierten** Programms (`claude -p …` bzw. `codex exec …`) und übersetzt dessen JSON-Ausgabe
(`core/src/cli-agents.ts`) in die bekannten Jarvis-Ereignisse (Text, Denk-Text, Werkzeug, Ende, Fehler). Es gibt keinen Download und keinen
eigenen Server; ohne installiertes oder angemeldetes Programm zeigt die Oberfläche „Nicht verfügbar“ bzw. den Anmeldebefehl.

## Anmeldung und Schlüssel

* Beide Programme melden sich selbst an. Jarvis hat dafür **kein** Schlüssel- oder Passwortfeld, liest keine Anmeldedateien (`~/.claude`, `~/.codex/auth.json`) und
  fragt nur den Status ab (`claude auth status`, `codex login status`). `backend_secret` wird abgelehnt.
* Anmeldung nur im Terminal durch den Nutzer: `claude` starten bzw. `codex login`.

## Werkzeuge und Sicherheit

* **Jarvis-MCP** (`core/src/mcp.ts`) ist angebunden. Damit laufen Browser, Computer-Steuerung, Projekte und Vorschau über jarvisd und unterliegen denselben Regeln wie
  bei OpenCode/Hermes: Computer-Steuerung an/aus, Not-Aus, gesperrte Passwortfelder.
* Die Einstellungen des Nutzers werden nicht geladen: Claude Code mit `--strict-mcp-config --setting-sources ""`, Codex mit `--ignore-user-config`
  (die Anmeldung bleibt erhalten, andere MCP-Server wie etwa mit offener Anmeldung stören nicht).
* **Standard „Keine Dateien“:** Claude Code `--tools ""` (nur `mcp__jarvis__*` erlaubt), Codex `--disable shell_tool`.
  **„Dateien lesen“:** Claude Code zusätzlich `Read, Glob, Grep`; Codex mit Shell in der Sandbox `read-only` (kein Schreiben, Lesen auf dem Rechner möglich).
  Schreiben, Bearbeiten und Befehle sind bei Claude Code nicht freigegeben; Codex startet immer mit `sandbox_mode="read-only"` (das Verhalten der Sandbox selbst ist Sache von Codex und hier nicht eigens geprüft). Nie `--dangerously-…`.
* **Not-Aus / Stopp:** `SIGTERM` an das Programm und seine Unterprozesse (Werkzeug-Server, Shells), nach 4 s `SIGKILL`; Antwort `stopped` wie bei den anderen Backends.

## Sitzungen und Verlauf

* Claude Code: Jarvis vergibt die Sitzungs-ID (`--session-id`, danach `--resume`). Codex: die Thread-ID kommt im ersten Lauf (`thread.started`), danach `codex exec resume`.
* Den **Verlauf führt Jarvis selbst** (Text der Nachrichten und Dateinamen) in der geschützten Ablage `~/.jarvis3/backend/` (Dateirechte 0700/0600, nicht
  verschlüsselt, Windows noch nicht unterstützt). Das Programm speichert zusätzlich seine eigene Sitzung (`~/.claude`, `~/.codex`) nach seinen Regeln.
* Die Jarvis-Anweisungen gehen bei Claude Code als `--append-system-prompt`, bei Codex (keine getrennte Systemanweisung) vor die erste Nachricht der Unterhaltung.

## Grenzen (Stand jetzt)

* Bilder: Codex immer (`-i`); Claude Code nur mit „Dateien lesen“ (Bild liegt im Arbeitsordner, Claude liest es mit `Read`).
* Codex streamt keinen Text Token für Token, sondern fertige Nachrichten; Claude Code streamt.
* Bearbeiten/erneut senden und Zurücksetzen auf eine Nachricht fehlen (wie bei Hermes).
* Modell- und Kontingentfehler der Programme kommen als Fehlermeldung „Claude Code: …“ bzw. „Codex: …“ an; Jarvis wechselt dabei nicht selbst das Backend.
* Computer-Steuerung des Programms selbst (z. B. Computer Use) ist nicht verfügbar; nur Jarvis' Werkzeuge.

## Prüfen

```sh
bun test core/src/cli-agents.test.ts core/src/cli-backends.test.ts core/src/cli-integration.test.ts core/src/cli-ui-contract.test.ts
bun core/scripts/cli-check.ts claude   # echtes Programm, zwei kurze Anfragen am Konto: Werkzeug, Fortsetzen, Abbrechen
bun core/scripts/cli-check.ts codex
```

`cli-integration.test.ts` startet den echten `index.ts` mit isoliertem `HOME` und Ersatzprogrammen (kein Konto, kein Netz).
