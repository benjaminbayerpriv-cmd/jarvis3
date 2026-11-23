# Codex-Auftrag: native Jarvis-Apps für iPhone und Google Pixel

Du arbeitest im Repo `jarvis3` (Checkout: `~/Documents/Jarvis3`). Lies zuerst `AGENTS.md`, `docs/HANDOFF.md`, `docs/protocol.md`, `docs/app.md` und `docs/errors.md`. Antworten, UI-Texte, Kommentare und Commit-Texte auf Deutsch.

## Ziel

Zwei echte native Apps als Fernbedienung und Begleiter für Jarvis auf dem Computer des Nutzers:

- **iOS** (iPhone): Swift und SwiftUI, gebaut **mit Xcode** (echtes `.xcodeproj`, Signierung, Simulator, `xcodebuild`; nutze die Xcode-Werkzeuge und -Agent-Skills, die auf dem Mac vorhanden sind, und starte die App im iOS-Simulator, um sie anzusehen). Verwende konsequent **Liquid Glass** und die neuesten nativen APIs des aktuellen SDK: `glassEffect`, `GlassEffectContainer`, `.buttonStyle(.glass)` und `.glassProminent`, native `TabView` mit minimierender Tab-Leiste, `NavigationStack` und `NavigationSplitView`, System-Toolbars, Sheets mit Glas-Hintergrund, `ContentUnavailableView`, `searchable`, SF Symbols mit Symbol-Effekten, Materials, Dynamic Type, Dark/Light, Zeitleisten-Animationen mit `matchedGeometryEffect` und Glas-Morphing. Mindestversion ist die iOS-Version, die Liquid Glass einführt. **Keine eigenen Nachbauten** von Tab-Leisten, Navigationsleisten, Schaltflächen, Eingabefeldern oder Menüs, keine selbstgemalten Glas-Imitationen, keine Third-Party-UI-Bibliotheken, keine Web-Views. Wo das System ein Bedienelement liefert, wird es benutzt.
- **Android** (Google Pixel): Kotlin und Jetpack Compose mit **Material 3 Expressive** und Material You (dynamische Farben), die neuesten Compose-Material3-Komponenten (Navigationsleiste, Top-App-Bar mit Scroll-Verhalten, Floating-Toolbar, Bottom-Sheets, Suchleiste, Button-Gruppen), Material Symbols, Edge-to-Edge, Predictive Back, Formen und Bewegung aus dem Expressive-Katalog. Keine eigenen Nachbauten von Standardelementen, keine Web-Views, kein Flutter, kein React Native.

Beide Apps sollen sich wie Apps ihrer Plattform anfühlen, nicht wie ein Port der Web-Oberfläche. Optisch bleibt Jarvis erkennbar (Name, Farben Blau, Rosa und Türkis, ruhiger Minimalismus wie `app/ui`).

## Harte Regeln

1. **Nur im lokalen Netzwerk.** Die Apps funktionieren ausschließlich, wenn Handy und Computer im selben privaten Netz (WLAN/LAN) sind. Kein Cloud-Relay, kein Port-Forwarding, keine Tunnel, keine Telemetrie. Der Daemon lehnt Verbindungen von nicht-privaten Adressen ab (erlaubt: 10/8, 172.16/12, 192.168/16, 169.254/16, fc00::/7, fe80::/10 und Loopback).
2. **Opt-in und gesichert.** `jarvisd` lauscht heute nur auf `127.0.0.1:7777`. Der Zugriff aus dem Netz ist standardmäßig AUS, wird in den Einstellungen eingeschaltet und verlangt **Kopplung**: Der Computer zeigt einen QR-Code und eine 6-stellige PIN (läuft nach 2 Minuten ab, max. 5 Versuche). Die App speichert ein zufälliges Gerätetoken im Schlüsselbund (iOS Keychain) bzw. Android Keystore (EncryptedSharedPreferences). Jede Verbindung ohne gültiges Token wird getrennt. Gekoppelte Geräte lassen sich in den Einstellungen einzeln widerrufen. Tokens nur gehasht ablegen. Keine Passwörter, keine Schlüssel im Repo.
3. **Auffindbar per Bonjour/mDNS** (`_jarvis3._tcp`), mit manueller Eingabe von Adresse und Port als Rückfall. iOS: `NSLocalNetworkUsageDescription` und `NSBonjourServices` setzen, Berechtigungsablehnung freundlich erklären. Android: `NsdManager`, Berechtigungen `NEARBY_WIFI_DEVICES` bzw. `ACCESS_WIFI_STATE`/`CHANGE_WIFI_MULTICAST_STATE` je nach API-Stufe.
4. **Bestehendes nicht brechen.** Die lokale Weboberfläche und die Tauri-App funktionieren unverändert weiter. Das Mobil-Protokoll ist eine Erweiterung des vorhandenen WebSocket-Protokolls (`/ui`), nicht eine zweite Welt.
5. **Git:** Nie direkt auf `main`. Feature-Branch `feature/mobile-apps`, kleine Commits, am Ende Pull Request (deutsch, kurz) mit `gh pr create`. Nicht selbst mergen. Fremde, uncommittete Änderungen im Arbeitsordner nicht anfassen, nur eigene Dateien committen.
6. **Fehler-Log:** Fehler gehören ins zentrale Log (`docs/errors.md`); Fehler der Apps an `POST /errors` melden.

## Funktionsumfang (Version 1)

Beide Apps, gleicher Funktionsumfang, jeweils plattformtypisch umgesetzt:

1. **Verbinden:** Start-Bildschirm mit gefundenen Computern, Kopplung per QR-Scan (Kamera) oder PIN, automatische Wiederverbindung, klare Zustände (sucht, verbunden, Computer nicht erreichbar, nicht im selben Netz).
2. **Chat:** Chatliste (Verlauf wie in der Web-Oberfläche, Projekte/Ordner), Chat öffnen, Nachricht senden, Antwort **streamen** (Buchstabe für Buchstabe), Werkzeug-Schritte als einklappbare Zeilen, Markdown (Code, Listen, Links), Grafiken und Diagramme (`visualize_*`, Bilder von `/visual/<id>/<datei>`), Stopp-Knopf, Nachricht bearbeiten und erneut senden, neuer Chat. Modellwahl wie im Web.
3. **Vorschau:** Live-Bild des Tabs/Fensters, in dem Jarvis arbeitet (Frames aus dem `frame`-Ereignis), mit Tab-Auswahl. Nur ansehen, in Version 1 keine Steuerung.
4. **Live-Modus (Sprache):** Mikrofon des Handys an Jarvis, Antwort wird gesprochen. Dafür den Audio-Pfad klären und nutzen: Aufnahme am Handy (16 kHz mono) über WebSocket an den Sprach-Sidecar (`speech/`, siehe `docs/speech.md`), Wiedergabe der gesprochenen Antwort am Handy statt am Computer (in den Einstellungen wählbar). Wenn das mehr Umbau am Sidecar braucht als sinnvoll, zuerst Diktat (Handy-Mikro → Text → Chat) liefern und den Rest als dokumentierten Folgeauftrag in `docs/` festhalten.
5. **Steuerung:** Not-Aus (wie der globale Hotkey, `POST /stop`), Umschalter Browser/Computer-Steuerung, Einstellungen des Daemons (die wichtigsten aus der Web-Oberfläche, über die vorhandene Einstellungs-Nachricht).
6. **Benachrichtigung** (lokal, nur bei Verbindung): Wenn Jarvis eine lange Aufgabe beendet hat und die App im Hintergrund ist, lokale Mitteilung. Keine Push-Dienste von Apple/Google.

## Vibration (Haptik) auf dem Handy

Haptik ist ein Kernmerkmal. Auf dem Computer gibt es sie schon am Trackpad (`core/src/haptics.ts`: Arten `click`, `tool`, `think`, `tick`, Einstellungen `haptics*`, Stärken leicht/mittel/stark). Setze dasselbe Gefühl auf dem Handy um und halte die Arten und Einstellungen gleich:

- **Klick:** deutlicher Impuls, wenn Jarvis klickt.
- **Werkzeug:** je ein Impuls, wenn ein Werkzeugaufruf beginnt und wenn er endet.
- **Nachdenken:** sanfter Takt (ca. 0,9 s), nur solange Jarvis nachdenkt und kein Werkzeug läuft.
- **Schreiben:** schnelles gleichmäßiges Flirren, solange Antworttext hereinkommt, endet sofort mit dem Text (nie nachlaufend, unabhängig von der Textmenge), nicht im Sprachmodus.
- Nur vibrieren, wenn die App im Vordergrund ist. Haptik-Schalter, Einzelschalter je Art und Stärke in den App-Einstellungen.
- **iOS:** Core Haptics (`CHHapticEngine`, transiente und kontinuierliche Ereignisse) mit Rückfall auf `UIImpactFeedbackGenerator`; auf Geräten ohne Taptic Engine still bleiben.
- **Android (Pixel):** `VibratorManager`/`VibrationEffect.Composition` mit Primitives (`PRIMITIVE_CLICK`, `PRIMITIVE_TICK`, `PRIMITIVE_LOW_TICK`), Rückfall auf `VibrationEffect.createPredefined`/`createOneShot`, wenn Primitives fehlen; `Vibrator.areAllPrimitivesSupported` prüfen.
- Die Ereignisse dafür kommen vom Daemon (`delta`, `tool`, `action`, Klick-Hinweis). Falls dem Daemon ein Ereignis für „Klick“ fehlt, ergänze es rückwärtskompatibel.

## Aufgaben am Daemon (`core/`)

1. Einstellung `lanAccess` (Standard aus) und Kopplungs-Endpunkte: `POST /pair/start` (nur von Loopback, liefert PIN und QR-Daten: Adresse, Port, Zertifikats-Fingerabdruck falls TLS, Einmal-Geheimnis), `POST /pair/complete` (PIN → Token), `GET/DELETE /devices` (gekoppelte Geräte, nur Loopback). Geräte und gehashte Tokens in `~/.jarvis3/devices.json` (Rechte 0600).
2. Zweiter Listener auf der LAN-Adresse nur wenn `lanAccess` an ist, mit Prüfung der Quelladresse (siehe Regel 1) und Token-Pflicht (Header oder erste Nachricht) für `/ui`-WebSocket und die Visual-Dateien. Verschlüsselung: bevorzugt TLS mit selbst erzeugtem Zertifikat und Pinning über den QR-Code; wenn das den Umfang sprengt, zuerst Klartext im privaten Netz mit Token und das klar in `docs/` als Einschränkung festhalten.
3. mDNS-Ankündigung `_jarvis3._tcp` (macOS: `dns-sd`/Bonjour; Windows: eine geeignete leichte Lösung), nur bei aktivem `lanAccess`.
4. Einstellungs-UI in `app/ui`: Schalter „Handy-Zugriff“, Anzeige von QR-Code und PIN, Liste gekoppelter Geräte mit „Widerrufen“.
5. Protokoll-Erweiterungen in `docs/protocol.md` beschreiben (Kopplung, Token, Audio für den Live-Modus, Ereignisse für Haptik) und mit Tests (`bun test` in `core/`) absichern, inklusive: falsche PIN, abgelaufene PIN, fremde Quelladresse, widerrufenes Token.

## Projektstruktur und Bauen

- `mobile/ios/` (Xcode-Projekt, Swift Package Manager, Mindestversion iOS 17) und `mobile/android/` (Gradle Kotlin DSL, minSdk 31, targetSdk aktuell, Ziel Pixel). `mobile/README.md` mit Bau- und Startanleitung auf Deutsch.
- Gemeinsames Protokoll nicht doppelt erfinden: Nachrichtenformen kurz in `docs/protocol.md`, in beiden Apps als typisierte Modelle.
- Auf dem Mac bauen und testen: `xcodebuild` für den iOS-Simulator (Unit-Tests für Protokoll, Kopplung, Haptik-Logik; mindestens ein UI-Test für den Verbindungsablauf gegen einen Test-Daemon), Gradle `assembleDebug` und `testDebugUnitTest` für Android (falls das Android SDK fehlt: Einrichtung beschreiben und die Android-Tests, soweit möglich, als reine JVM-Tests schreiben).
- Test-Daemon auf eigenen Ports starten: `JARVIS_PORT=7787 JARVIS_OPENCODE_PORT=4097 JARVIS_NO_SIDECAR=1 bun run core/src/index.ts`. Nicht den laufenden Dienst auf Port 7777 anfassen oder neu starten.

## Abnahme

- **Kein UI-Murks:** Keine abgeschnittenen oder überlappenden Texte, keine Standard-Platzhalter, saubere Abstände und Ausrichtung, echte Leer-, Lade- und Fehlerzustände. Prüfe jede Hauptansicht in Hell und Dunkel, mit großer Schrift, im Querformat und auf kleinem sowie großem Gerät per Screenshot und überarbeite, bis sie wie von Apple bzw. Google gebaut aussieht.

- Beide Apps bauen ohne Fehler; Tests laufen durch; `bun test` in `core/` bleibt grün.
- Im Simulator/Emulator: koppeln, Chat öffnen, Frage senden, Antwort streamt, Vorschau zeigt Frames, Not-Aus wirkt. Screenshots der Hauptbildschirme beider Apps in der PR-Beschreibung.
- Nachweis, dass ohne Kopplung und von einer öffentlichen Quelladresse nichts durchkommt (Test).
- Ehrlich berichten, was nicht geprüft werden konnte (z. B. echte Vibration, echtes Pixel, Bonjour im echten WLAN, Spracherkennung über das Handy-Mikrofon).

Schreibe am Ende `docs/codex/result-mobile-apps.md` (kurz: was gebaut, was getestet, was offen, wie der Nutzer die Apps auf iPhone und Pixel installiert: Xcode-Signierung mit eigener Apple-ID, `adb install` bzw. Pixel mit Entwickleroptionen).
