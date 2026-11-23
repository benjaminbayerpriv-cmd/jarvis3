# Eingebauter Browser

Jarvis hat einen eigenen Browser, der in der Vorschau rechts läuft (Webseite und Tauri-App) und den Jarvis genauso bedient wie Chrome.

## Aufbau
- `core/src/ibrowser.ts`: startet bei Bedarf ein unsichtbares Chrome (`--headless=new`, Profil `~/.jarvis3/browser-profile`, Port 9333) und steuert es über das DevTools-Protokoll (`core/src/cdp.ts`). Chrome wird gefunden unter `/Applications/Google Chrome.app`, Chromium, Brave oder Edge; `JARVIS_CHROME` überschreibt den Pfad, `JARVIS_BROWSER_PORT` und `JARVIS_BROWSER_PROFILE` ebenfalls.
- Tab-Nummern ab 100 001 gehören dem eigenen Browser, alle anderen der Chrome-Erweiterung.
- `core/src/ibrowser-page.ts`: Seitenskripte (scan, Klick vorbereiten, Text lesen, Markierungen). Echte Klicks, Tippen und Scrollen laufen über `Input.dispatch*`, es sind also vertrauenswürdige Eingaben.
- Bildstrom: `Page.startScreencast` in der Größe des Vorschaufensters mal Pixeldichte (scharf). Die Oberfläche meldet ihre Größe per `{type:"ib", op:"resize", tab, w, h, dpr}`; der Tab passt sich an.

## Werkzeuge
`browser_tab_open` öffnet standardmäßig im eigenen Browser; `in: "chrome"` im echten Chrome (Tab-Gruppe „Jarvis“, braucht die Erweiterung). `browser_tab_list` zeigt beide (`internal`, `chrome`). scan, click, type, read, scroll, wait, look, tab_close verhalten sich gleich. Passwortfelder sind gesperrt. Einstellung „Eigenen Browser bevorzugen“ (`internalBrowser`).

## Nachrichten Oberfläche → jarvisd
`{type:"ib", op: new|navigate|back|forward|reload|close|resize|input|copy, tab, url, w, h, dpr, event}`; `input` trägt Maus-, Tasten- und Einfüge-Ereignisse (`event.kind` mouse|key|text). Antwort auf `copy`: `{type:"ib_clipboard", text}`. Live-Bilder: `{type:"frame", tab, data, w, h, dpr, internal:true, url, title}`.
