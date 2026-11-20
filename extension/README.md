# Jarvis für Chrome

1. In Chrome `chrome://extensions` öffnen und **Entwicklermodus** einschalten.
2. **Entpackte Erweiterung laden** wählen und den Ordner `Jarvis3/extension` auswählen.
3. Den Jarvis-Daemon starten. Die Erweiterung verbindet sich automatisch mit `ws://127.0.0.1:7777/browser`.
4. Für sichtbare Markierungen das Jarvis-Symbol in der Chrome-Symbolleiste anklicken. Die Markierungen starten ausgeschaltet. Falls das Symbol fehlt, lässt es sich über das Erweiterungsmenü anheften.

Neue Tabs landen im Hintergrund in der blauen Gruppe **Jarvis** im zuletzt fokussierten normalen Chrome-Fenster. `tab_open.group` kann einen anderen Gruppentitel angeben. `tab_list` führt auch die übrigen Tabs auf. Jarvis bearbeitet nur Tabs, die es in der laufenden Chrome-Sitzung selbst geöffnet hat und die noch in einer seiner Gruppen liegen. Nach einem Browserneustart neue Jarvis-Tabs öffnen. Wenn ein Jarvis-Tab manuell ausgewählt wird, bleiben Befehle mit Seiteneffekten gesperrt, bis der Tab wieder im Hintergrund liegt.

`scan` funktioniert bei ausgeschalteten Rahmen. Such- und Textfelder sowie wichtige Buttons stehen am Anfang der Liste. Die Antwort enthält höchstens 150 Elemente und nennt die Gesamtzahl als `total`. Nach Navigation, Linkklick oder Formularabsendung einen neuen Scan ausführen. `tab_open` und `navigate` warten auf den Seiten-Load und das Content-Script.

`read` ohne `id` und `rect` liefert bis zu 8000 Zeichen gerenderten Seitentext, auch unterhalb des sichtbaren Ausschnitts. `type` ersetzt den Text mit nativer Chrome-Eingabe. `submit:true` drückt anschließend Enter. Passwortfelder werden als „Passwortfeld“ erkannt und bei `read` und `type` gesperrt. `shot` liefert eine PNG-Data-URL und deckt erkannte Passwortfelder ab. `marks:true` zeichnet die IDs des letzten Scans ein.

## Grenzen

- Die DOM-Bedienung funktioniert auf zugänglichen HTTP(S)-Seiten und mit entsprechender Chrome-Freigabe auf Datei-URLs. Browserinterne Seiten, PDFs im eingebauten Viewer, fremde oder transformierte Iframes sowie Canvas-/WebGL-Elemente ohne DOM-Bedienelemente sind darüber nicht bedienbar. `read` hat keine OCR.
- Klicks erfolgen über das DOM. Links und native Formularziele bleiben im Jarvis-Tab. Ein DOM-Klick wartet bei Bedarf, bis die kurzzeitige Chrome-Benutzeraktivierung einer vorherigen Eingabe abgeklungen ist. Seitenskripte, die direkt auf native Tasteneingabe mit einem Popup reagieren, und browserseitige Dialoge liegen teilweise außerhalb der Kontrolle der Erweiterung.
- Chrome kann bei `type`, `shot` und `back` einen Debugging-Hinweis zeigen. Wenn der Debugger-Zugriff blockiert oder der Tab schon von DevTools belegt ist, kann der jeweilige Befehl fehlschlagen. Screenshots zeigen den Seiten-Viewport.
- Ansichten, die nach dem Seiten-Load asynchron Daten nachladen, können weiterhin `wait` auf einen erwarteten Seitentext benötigen.

## Integrationstests

Auf macOS aus dem Repo ausführen:

```sh
bun extension/test/browser.mjs
bun extension/test/scenarios.mjs
```

Die Tests benötigen Bun und Chrome mit DevTools-Unterstützung für entpackte Erweiterungen. `CHROME_BIN` überschreibt den Pfad zur Chrome-Binärdatei. Beide Tests starten Chrome im Headless-Modus in einem temporären Profil und verwenden jeweils einen eigenen Mock-Daemon.

- **Lokaler Integrationstest.** Alle 13 Browserbefehle, verzögertes Laden und Redirects, ID-Wechsel, Scan-Limit und Sortierung, Passwortschutz, native Eingabe, Screenshot-Pixel, Fokus in zwei Fenstern und Wiederverbindung bestanden.
- **Live-Szenarien.** Enter-Suche auf de.wikipedia.org und DuckDuckGo sowie React-Dateisuche mit Vorschlägen und Enter auf GitHub bestanden. Die deutsche Wikipedia lieferte für „Tauri“ keinen Artikel als Suchergebnis. Der Klick auf den ersten Treffer und das Lesen von „Tauri“ im Artikel wurden daher auf der englischen Wikipedia geprüft. Die Tests zeichneten keine Tab- oder Fensteraktivierung auf.
- **Offen.** Der globale GitHub-Suchdialog reagierte im Testprofil auf den DOM-Klick nicht zuverlässig. Der Toolbar-Klick war im fensterlosen Testlauf nicht prüfbar. Im MCP müssen `submit` weitergereicht und der `rect`-Notbehelf entfernt werden, damit das Modell beide erweiterten Protokollbefehle nutzen kann.
