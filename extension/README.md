# Jarvis für Chrome

1. In Chrome `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** wählen und den Ordner `Jarvis3/extension` auswählen.
3. Den Jarvis-Daemon starten. Die Erweiterung verbindet sich automatisch mit `ws://127.0.0.1:7777/browser`.
4. Für sichtbare Markierungen das Jarvis-Symbol in der Chrome-Symbolleiste anklicken. Die Markierungen starten ausgeschaltet. Falls das Symbol fehlt, lässt es sich über das Erweiterungsmenü anheften.

Neue Tabs landen im Hintergrund in der blauen Gruppe **Jarvis** im zuletzt fokussierten normalen Chrome-Fenster. `tab_open.group` kann einen anderen Gruppentitel angeben. `tab_list` führt auch die übrigen Tabs auf. Jarvis bearbeitet nur Tabs, die es in der laufenden Chrome-Sitzung selbst geöffnet hat und die noch in einer seiner Gruppen liegen. Nach einem Browserneustart neue Jarvis-Tabs öffnen. Wenn ein Jarvis-Tab manuell ausgewählt wird, bleiben Befehle mit Seiteneffekten gesperrt, bis der Tab wieder im Hintergrund liegt.

`scan` funktioniert bei ausgeschalteten Rahmen. Ein neuer Scan oder eine Seitennavigation kann Element-IDs ungültig machen. Ein Screenshot entsteht auf `shot`, als PNG-Data-URL. `marks:true` verwendet die IDs des letzten Scans. Passwortfelder werden als „Passwortfeld“ erkannt und bei `read` und `type` gesperrt. Erkannte Passwortfelder werden im PNG abgedeckt.

## Grenzen

- Die DOM-Bedienung funktioniert auf zugänglichen HTTP(S)-Seiten und mit entsprechender Chrome-Freigabe auf Datei-URLs. Browserinterne Seiten, PDFs im eingebauten Viewer, fremde oder transformierte Iframes sowie Canvas-/WebGL-Elemente ohne DOM-Bedienelemente sind darüber nicht bedienbar. `read` hat keine OCR.
- Die DOM-Ereignisse sind synthetisch. Seiten, die echte Benutzereingaben, Tastensequenzen oder native Dialoge voraussetzen, können Aktionen ablehnen. Links mit Ziel in einem anderen Tab werden im Jarvis-Tab geöffnet. Seiteneigene Skripte und browserseitige Dialoge liegen teilweise außerhalb der Kontrolle der Erweiterung.
- Chrome kann bei `shot` und `back` einen Debugging-Hinweis zeigen. Wenn der Debugger-Zugriff blockiert oder der Tab schon von DevTools belegt ist, kann der jeweilige Befehl fehlschlagen. Screenshots zeigen den Seiten-Viewport.

## Integrationstest

Auf macOS aus dem Repo ausführen:

```sh
bun extension/test/browser.mjs
```

Der Test benötigt Bun und eine aktuelle Chrome-Version mit DevTools-Unterstützung für entpackte Erweiterungen. `CHROME_BIN` überschreibt den Pfad zur Chrome-Binärdatei. Der Test startet Chrome in einem temporären Profil, verwendet einen eigenen WebSocket-Mock und lässt einen Daemon auf Port 7777 unangetastet. Der Lauf umfasst alle 13 Browserbefehle, den Symbolschalter, Passwortschutz, Chromium-Fokusereignisse über zwei Fenster, Screenshot-Pixel und den Wiederaufbau der Verbindung.
