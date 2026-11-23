# Eingebauter Browser

Es gibt zwei Betriebsarten. Standard ist der **direkte Browser**: echte Seiten, die als normales HTML im Vorschaufenster laufen (kein Videostrom). Der **Video-Browser** (unsichtbares Chrome als Bildstrom) ist die Ausweichlösung für Seiten, die im direkten Browser nicht funktionieren.

## Direkter Browser
- `core/src/proxy.ts`: Jarvis lädt die Seite selbst. Jede Herkunft (Schema, Host, Port) bekommt eine Unterdomain `p<10 Hex>.localhost:7777` (zufällig, nur auf Wunsch der Oberfläche angelegt, gespeichert in `~/.jarvis3/proxy-origins.json`). Relative und Root-Adressen landen dadurch von selbst beim Proxy; Cookies und Speicher sind je Seite getrennt. Der Proxy entfernt X-Frame-Options und CSP, schreibt Umleitungen, Set-Cookie, eigene absolute Adressen in HTML, CSS, JS und JSON sowie Links zu fremden Herkünften um und setzt einen Agenten in jede Seite.
- `core/src/proxy-agent.ts`: läuft in der Seite. Meldet Adresse und Titel an die Oberfläche (`postMessage`), führt Links zu fremden Herkünften und neue Fenster in Tabs bzw. über den Proxy, und verbindet sich mit `ws://127.0.0.1:7777/page` (nur von Proxy-Unterdomains erlaubt). Darüber führt Jarvis scan, click, type, read, scroll, wait, back, forward, reload direkt im DOM aus.
- `core/src/dbrowser.ts`: Tab-Verzeichnis und Brücke zu den Seiten. Tab-Nummern 300 001–399 999. Die Tabs gehören der Oberfläche (iframes im Vorschaufenster) und werden per `dt_tabs` gemeldet. Nachrichten an die Oberfläche: `dt_open`, `dt_close`, `dt_nav`; von der Oberfläche: `dt_new`, `dt_tabs`.
- Grenzen: Seiten mit strenger Anmeldung, eigener Origin-Prüfung, WebSockets zu ihrem Server, Service Workern oder Drittanbieter-Cookies funktionieren teils nicht. Dafür gibt es in der Adressleiste „Als Videostrom öffnen“. Es gibt keine Screenshots (`browser_look`) im direkten Browser; Jarvis nutzt scan und read. Ohne geöffnete Oberfläche fällt `browser_tab_open` automatisch auf den Video-Browser zurück.

## Video-Browser

Hier hat Jarvis einen eigenen Browser, der in der Vorschau rechts läuft (Webseite und Tauri-App) und den Jarvis genauso bedient wie Chrome.

## Aufbau
- `core/src/ibrowser.ts`: startet bei Bedarf ein unsichtbares Chrome (`--headless=new`, Profil `~/.jarvis3/browser-profile`, Port 9333) und steuert es über das DevTools-Protokoll (`core/src/cdp.ts`). Chrome wird gefunden unter `/Applications/Google Chrome.app`, Chromium, Brave oder Edge; `JARVIS_CHROME` überschreibt den Pfad, `JARVIS_BROWSER_PORT` und `JARVIS_BROWSER_PROFILE` ebenfalls.
- Tab-Nummern 100 001–199 999 gehören dem Video-Browser, Chrome-Tabs haben Nummern in Millionenhöhe.
- `core/src/ibrowser-page.ts`: Seitenskripte (scan, Klick vorbereiten, Text lesen, Markierungen). Echte Klicks, Tippen und Scrollen laufen über `Input.dispatch*`, es sind also vertrauenswürdige Eingaben.
- Bildstrom: `Page.startScreencast` in der Größe des Vorschaufensters mal Pixeldichte (scharf). Die Oberfläche meldet ihre Größe per `{type:"ib", op:"resize", tab, w, h, dpr}`; der Tab passt sich an.

## Werkzeuge
`browser_tab_open` öffnet standardmäßig im direkten Browser (Ausweichen: Video-Browser); `in: "video"` erzwingt den Video-Browser, `in: "chrome"` das echte Chrome (Tab-Gruppe „Jarvis“, braucht die Erweiterung). `browser_tab_list` zeigt beide (`internal`, `chrome`). scan, click, type, read, scroll, wait, look, tab_close verhalten sich gleich. Passwortfelder sind gesperrt. Einstellung „Eigenen Browser bevorzugen“ (`internalBrowser`).

## Nachrichten Oberfläche → jarvisd
`{type:"ib", op: new|navigate|back|forward|reload|close|resize|input|copy, tab, url, w, h, dpr, event}`; `input` trägt Maus-, Tasten- und Einfüge-Ereignisse (`event.kind` mouse|key|text). Antwort auf `copy`: `{type:"ib_clipboard", text}`. Live-Bilder: `{type:"frame", tab, data, w, h, dpr, internal:true, url, title}`.
