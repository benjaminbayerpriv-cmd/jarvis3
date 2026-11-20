Commit `b8fcbf5` enthält die Änderungen an `extension/` und `docs/protocol.md`.

- `read` ohne Ziel liefert bis zu 8000 Zeichen gerenderten Seitentext und lässt Passwortfelder aus.
- `tab_open` und `navigate` warten auf die geladene Zielseite. Nach einem Seitenwechsel, Linkklick oder Formular-Submit fordert die Erweiterung einen neuen Scan an.
- `scan` priorisiert Suchfelder, Textfelder und wichtige Buttons, liefert höchstens 150 Elemente und nennt die Gesamtzahl in `total`. `type` nutzt native Chrome-Eingabe und unterstützt `submit: true` für Enter.

Beide Tests bestanden in temporären Chrome-Profilen ohne Tab- oder Fensterwechsel. Geprüft wurden die Suche auf de.wikipedia.org und DuckDuckGo sowie die React-Dateisuche auf GitHub mit Vorschlägen und Enter. Den vollständigen „Tauri“-Ablauf mit erstem Treffer und Artikeltext habe ich auf der englischen Wikipedia geprüft, weil die deutsche Suche keinen Artikeltreffer lieferte.

Offen bleiben der globale GitHub-Suchdialog und die MCP-Anbindung von `submit` und `read` ohne `rect`. Details stehen im [Testbericht](/Users/benjaminbayer/Documents/Jarvis3/extension/README.md).