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

## Modell und Denkaufwand

* Die **Modellwahl im Chat** (Modellmenü) zeigt bei Claude Code die Kurznamen (`sonnet`, `opus`, `haiku`) und bekannten IDs, bei Codex den Katalog des Programms (`codex debug models`, nur Text, sichtbare Modelle nach Priorität). Die Auswahl setzt das Modell des Programms (`--model` / `-m`); „Vorgabe“ lässt dem Programm die Wahl. Das Modell steht auch in den Backend-Einstellungen.
* **Denkaufwand** (`effort`: `low` bis `max`, bei Codex zusätzlich `ultra`; leer = Vorgabe): Claude Code `--effort`, Codex `model_reasoning_effort`. `ultra` gibt es nur bei Codex und wird bei Claude Code nicht gesendet. Nicht jedes Modell kennt jede Stufe.

## Installierte Skills und Plugins übernehmen (`adopt`)

Schalter je Programm, Standard aus. An: das Programm lädt die Skills und Plugins aus **deiner** Installation. **Nicht** übernommen wird, was Jarvis' Sperren und den Not-Aus umgehen würde:

| | Claude Code | Codex |
| --- | --- | --- |
| Übernommen | `--setting-sources user`: Skills (`~/.claude/skills`) und Plugins aus den Nutzereinstellungen, über das `Skill`-Werkzeug | `config.toml` wird geladen (Plugins, Skills); Skills liest Codex über eine **nur lesende** Shell (`sandbox_mode="read-only"`), die dann an ist |
| Abgeschaltet | Hooks (`disableAllHooks`); MCP-Server von Nutzer und Plugins (`--strict-mcp-config`); eingebaute Werkzeuge außer `Skill` (und bei „Dateien lesen“ `Read`/`Glob`/`Grep`) | Hooks (`--disable hooks`); **jeder** MCP-Server aus `config.toml` (`mcp_servers.<name>.enabled=false`, z. B. Computer-Steuerung); Rückfragen (`approval_policy="never"`) |

Folge: Skills und Plugins, die Befehle mit Schreibzugriff, eigene MCP-Werkzeuge oder Computer-Steuerung brauchen, laufen in Jarvis nicht; reine Anleitungs-Skills schon. Jarvis liest dafür nur Namen und Anzahl (`config.toml`: Namen der MCP-Server; Skill-/Plugin-Ordner: Anzahl), keine Inhalte und keine Anmeldedateien. Jarvis' eigene Skills (Einstellungen → Skills, `skill_list`/`skill_read` im Jarvis-MCP) stehen unabhängig davon immer bereit.

## Limit-Anzeige

Zeigt, wie viel vom Kontingent verbraucht ist, **ohne Modellaufruf** (kein Verbrauch): Claude Code über den lokalen Befehl `/usage` (`claude -p /usage`), Codex über `account/rateLimits/read` des Codex-App-Servers (`codex app-server`, JSON-RPC über stdio). Jarvis liest keine Tokens; die Programme sprechen selbst mit ihrem Konto.

* Nachricht `{type:"limits_get", force?}` → `{type:"limits", limits:{claude?, codex?}}` mit `windows:[{id, label, usedPercent, resetsAt?, resetText?}]`, `plan?`, `note?`, `error?`.
* Der Daemon fragt höchstens alle 20 s (`force` erzwingt), alle 5 Minuten bei offener Oberfläche und aktivem Programm sowie 3 s nach jedem Lauf.
* Oberfläche: Chip in der Kopfzeile bei Claude Code/Codex (z. B. „Sitzung 10 % · Woche 11 %“, ab 70 % gelb, ab 90 % rot, Klick aktualisiert) und Balken in den Backend-Einstellungen. Claude Code liefert den Zeitpunkt des Zurücksetzens nur als Text, Codex als Zeitstempel. Angaben von Claude Code gelten laut Programm „approximate“.

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
bun core/scripts/cli-check.ts claude --adopt   # zusätzlich: Übernahme installierter Skills (eine weitere kurze Anfrage)
```

`cli-integration.test.ts` startet den echten `index.ts` mit isoliertem `HOME` und Ersatzprogrammen (kein Konto, kein Netz).
