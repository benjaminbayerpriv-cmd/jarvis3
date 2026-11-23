# Erweiterungen: Befehle, Skills, MCP, Plugins

Jarvis läuft auf OpenCode. Erweiterungen werden in `~/.jarvis3/extensions.json` gespeichert und beim Start (und nach jeder Änderung in den Einstellungen) in den OpenCode-Arbeitsordner geschrieben (`core/src/extensions.ts`):

| Art | Gespeichert | Wirkung in OpenCode |
|---|---|---|
| MCP-Server | `mcp` (OpenCode-Format `local`/`remote`) | `workspace/opencode.json` → `mcp`; Status über `GET /mcp` |
| Skills | `skillDirs` (Verweise auf Ordner mit `SKILL.md`), `disabledSkills` | Verknüpfungen in `workspace/.opencode/skills/`; gesperrte Skills als `permission.skill: deny` |
| Befehle | `commands` (Name, Beschreibung, Vorlage) | Markdown-Dateien in `workspace/.opencode/command/` |
| Plugins | `plugins` (npm-Paket oder Dateipfad) | `workspace/opencode.json` → `plugin` |

Nach Änderungen ruft jarvisd `POST /instance/dispose` auf; OpenCode lädt Konfiguration, Befehle, Skills und MCP-Server neu.

## Schrägstrich-Befehle im Chat
Tippe `/` im Eingabefeld. Das Menü (Pfeiltasten, Tab/Enter, Esc) zeigt
- **Jarvis**-Befehle: `/neu`, `/stop`, `/modell <name>`, `/live`, `/diktat`, `/vorschau`, `/projekte`, `/einstellungen`, `/erweiterungen`, `/import`, `/hilfe`,
- **Befehle** (eigene und aus OpenCode, z. B. `/init`, `/review`) und
- **Skills** (jeder Skill ist auch ein Befehl: `/name Aufgabe`).

Eigene Befehle und Skills schickt die Oberfläche als `{type:"run_command", name, args}`; jarvisd füllt die Vorlage (`$ARGUMENTS`, `$1`, `$2` …) und sendet sie wie eine Nachricht. Die Nutzernachricht im Verlauf zeigt `/name Argumente`.

## Import
Einstellungen → Import liest (nur lesend) die Dateien von
- **Claude**: `~/.claude.json` (`mcpServers`), `~/.claude/skills`, `~/.claude/commands`, installierte Plugins (`~/.claude/plugins/installed_plugins.json` → Skills, Befehle, `.mcp.json`),
- **Codex**: `~/.codex/config.toml` (`[mcp_servers.*]`), `~/.codex/skills`, `~/.codex/prompts`,
- **OpenCode**: `~/.config/opencode/opencode.json(c)` (`mcp`, `command`, `plugin`), `command/`, `skills/`, `plugin/`.
MCP-Formate werden umgerechnet (stdio → `local` mit `command` + `args`, URL → `remote`). MCP-Server sind im Import nicht vorausgewählt, weil sie fremde Programme starten.

## WebSocket (UI ↔ jarvisd)
`commands` → `{type:"commands", items:[{name, description, source: builtin|command|skill}]}` · `ext_list` → `{type:"extensions", mcp, skills, commands, plugins}` · `ext_scan {from}` → `{type:"ext_scan", items}` · `ext_import {from, ids}` · `ext_mcp {op: add|remove|toggle, name, entry|enabled}` · `ext_skill {name, enabled|remove}` · `ext_command {op: add|remove, name, description, template}` · `ext_plugin {op: add|remove, name}` (Antwort jeweils `extensions`) · `run_command {name, args}`.


## Skills bei Bedarf und Funktions-Befehle
- **Skills stehen nie im Systemprompt.** OpenCodes eigenes Skill-Werkzeug bekommt keinen Skill (`permission.skill: {"*": "deny"}`). Stattdessen hat Jarvis zwei Werkzeuge (`core/src/mcp.ts`): `skill_list` (aktivierte Skills mit Beschreibung) und `skill_read` (SKILL.md plus Liste weiterer Dateien zum Nachlesen). Er lädt nur den Skill, den er gerade braucht. Beliebig viele aktivierte Skills kosten damit keinen Kontext. Daten: `GET /skills`, `GET /skills/<name>`.
- Importierte Skills starten aus; aktivieren geht in den Einstellungen → Skills. `/<skill> Aufgabe` lädt und befolgt den Skill.
- **Funktions-Befehle** (`core/src/functions.ts`): `/computer`, `/browser`, `/chrome`, `/recherche`, `/diagramm`, `/projekt`, `/bildschirm`, `/tabs`, `/skills`. Jede Vorlage sagt dem Modell genau, welche Werkzeuge es in welcher Reihenfolge benutzen soll. `/computer` schaltet die Computer-Steuerung ein.
- Achtung: Die Werkzeuge von **MCP-Servern** stehen weiter im Prompt. Ein Server mit Hunderten Werkzeugen (z. B. `rea`) allein kostet 60 000+ Tokens und sprengt das Limit kleiner Modelle.
