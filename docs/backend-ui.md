# Backend-Wechsel in der Oberfläche (Einstellungen → Backend)

Die Oberfläche folgt dem Daemon-Vertrag aus PR #63 (`docs/protocol.md`, „Agenten-Backend: OpenCode und Hermes“), **geprüft gegen den Code** (`core/src/backend-config.ts`, `hermes.ts`, Handler in `index.ts`). Formen: `app/ui/backends.js`. Tests: `app/ui/backends.test.js`, `app/ui/test/mock-daemon.test.js`; Vertragsprüfung gegen den echten Daemon: `app/ui/test/real-daemon-check.ts`.

## Felder (bewusst getrennt)

| Feld (Nachricht) | Bedeutung |
| --- | --- |
| Hermes-Serveradresse (`serverUrl`) | Adresse des Hermes-**Gateways**: `http://` oder `https://`, auch im Netzwerk; ohne Zugangsdaten, Query oder `#`. |
| Hermes-Server-Schlüssel (`backend_secret`, `target:"server"`) | Schlüssel des Gateways. |
| Modellanbieter in Hermes (`provider`), Modell (`model`) | Anbieter aus `providers` des Daemons (`default`, `custom`); `default`/`hermes-agent` = Hermes-Vorgabe. |
| Modellserver-Adresse (`modelBaseUrl`, optional) | **Getrennt vom Gateway:** OpenAI-kompatibler Server für lokale Modelle (LM Studio, Ollama, vLLM), auch im Heimnetz. Gesetzt → Hermes nutzt den Anbieter `custom`. Leer („“) löscht sie. |
| Modellanbieter-Schlüssel (`target:"provider"`) | Schlüssel des Modellservers; getrennt vom Server-Schlüssel. |
| Modell versteht Bilder (`modelSupportsVision`) | Bestätigung der Bildfähigkeit; nur dann werden Bilder an Hermes übergeben. |

Antworten tragen nur `keySet` und `providerKeySet` (Ja/Nein). OpenCode verwaltet seine Anbieter selbst: Die Karte zeigt nur den Zustand, es gibt kein `backend_config`/`backend_secret` dafür; `baseUrl` aus der OpenCode-Konfiguration wird nie als Hermes-Adresse gelesen.

## Verwaltetes und fremdes Gateway

`isManagedGateway` spiegelt `managedGateway` im Daemon: `http://` auf `127.0.0.1`, `[::1]` oder `localhost`, Pfad `/`. Dann startet Jarvis das Gateway selbst und Modellserver-Adresse und Anbieter-Schlüssel gelten.

Jedes andere Gateway (Heimnetz oder Internet) kann konfiguriert werden, wird aber **nicht von Jarvis verwaltet**: Werkzeugfreigaben, Not-Aus, Modellanbieter und dessen Schlüssel müssen dort eingerichtet werden. Die Oberfläche sperrt dafür Modellserver-Adresse und Anbieter-Schlüssel (der Daemon lehnt sie ebenfalls ab) und zeigt einen Hinweis. `http://` über das Internet wird als unverschlüsselt gewarnt.

## Verhalten

* Wechsel gilt nur für **neue** Chats.
* Während eines Hermes-Laufs sind die Hermes-Felder gesperrt (der Daemon lehnt Änderungen ab); Daemon-Fehler erscheinen in der Karte.
* Schlüssel stehen nur in Passwortfeldern, gehen je einmal in `backend_secret` und werden sofort aus dem Feld gelöscht, auch beim Verlassen des Bereichs. Entfernen braucht zwei Klicks.

## Schlüsselablage: was zutrifft

Dateien in `~/.jarvis3/backend/` (Verzeichnis 0700, Datei 0600), geschützt durch Dateirechte, **nicht verschlüsselt**, kein Schlüsselbund, Windows noch nicht unterstützt. Der Modellanbieter-Schlüssel wird Hermes beim Start über eine Umgebungsvariable übergeben; im erzeugten YAML steht nur ein Verweis. Das haben `real-daemon-check.ts` (Rechte 600, kein Schlüsselwert im YAML oder in Nachrichten) bestätigt. Ändert sich die Ablage in core, müssen `KEY_STORAGE_NOTE`/`PROVIDER_KEY_NOTE` in `backends.js` mitgeändert werden.

## Vertragsprüfung

* `bun test app/ui`: Logik und Mock-Daemon.
* `JARVIS_CORE=<core mit PR #63> bun app/ui/test/real-daemon-check.ts`: startet den echten `index.ts` mit isoliertem `HOME`, Fake-OpenCode und Fake-Hermes (alles lokal, keine Downloads) und prüft Konfiguration, beide Schlüssel, Test, fremdes Gateway, Ablehnungen und Geheimnisfreiheit.

## Claude Code und Codex

Zwei weitere Backends neben OpenCode und Hermes (Umschalter mit vier Einträgen). Die Karten haben nur:

| Feld | Bedeutung |
| --- | --- |
| Anmeldung | Hinweis: die Programme melden sich selbst an (Terminal: `claude` bzw. `codex login`). Kein Schlüsselfeld; Jarvis speichert dafür nichts. „Anmeldung prüfen“ fragt nur den Status ab. |
| Modell (optional) | `model`; leer = Vorgabe des Programms. |
| Dateizugriff | `files`: „Keine Dateien“ (Standard) oder „Dateien lesen“. |

Zustand kommt als `loginManaged:true`, `status` und bei fehlender Anmeldung `error` mit dem Befehl (auch als Banner, wenn das Programm aktiv ist). Logik und Prüfung: `backends.js`
(`validateCliConfig`, `cliConfigOf`); `core/src/cli-ui-contract.test.ts` stellt sicher, dass Oberfläche und Daemon dieselben Einstellungen zulassen. Daemon-Seite: `docs/cli-backends.md`.
