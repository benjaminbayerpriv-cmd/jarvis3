# Backend-Wechsel in der Oberfläche (Einstellungen → Backend)

Die Oberfläche folgt dem Daemon-Vertrag aus PR #63 (`docs/protocol.md`, Abschnitt „Agenten-Backend: OpenCode und Hermes“). Die Formen stehen in `app/ui/backends.js`; getestet in `app/ui/backends.test.js` und gegen `app/ui/test/mock-daemon.mjs`.

## Begriffe (bewusst getrennt)

| Feld | Bedeutung |
| --- | --- |
| Hermes-Serveradresse (`serverUrl`) | Adresse des Hermes-Gateways. Nur `http://` mit fester Loopback-IP (`127.x.x.x`, `[::1]`), ohne Zugangsdaten, kein Hostname wie `localhost`. |
| Hermes-Server-Schlüssel (`backend_secret`) | Schlüssel des Hermes-Servers. Antworten enthalten nur `keySet`. |
| Modellanbieter in Hermes (`provider`), Modell (`model`) | Wählen einen **in Hermes** eingerichteten Anbieter; `default` / `hermes-agent` = Hermes-Vorgabe. Anbieter-Adressen und -Schlüssel werden hier nicht gespeichert. |

OpenCode verwaltet seine Anbieter selbst: Die Karte zeigt nur den Zustand, es gibt keine Felder, kein `backend_config`, kein `backend_secret`. `baseUrl` aus der OpenCode-Konfiguration wird nie als Hermes-Serveradresse gelesen.

## Verhalten

* Wechsel gilt nur für **neue** Chats; vorhandene bleiben bei ihrem Backend.
* Während eines laufenden Hermes-Laufs sind die Hermes-Felder gesperrt (der Daemon lehnt Änderungen dann ab); Fehlermeldungen des Daemons erscheinen in der Karte.
* Der Schlüssel steht nur im Passwortfeld, geht einmal in `backend_secret` und wird sofort aus dem Feld gelöscht, auch beim Verlassen des Bereichs.

## Schlüsselablage: was zutrifft

Der Hinweis in der Oberfläche nennt nur den tatsächlichen Stand: Datei in `~/.jarvis3/backend/` (Verzeichnis 0700, Datei 0600), geschützt durch Dateirechte, **nicht verschlüsselt**, **kein** Schlüsselbund, Windows **noch nicht** unterstützt. Ändert sich die Ablage in core, muss `KEY_STORAGE_NOTE` in `backends.js` mitgeändert werden.
