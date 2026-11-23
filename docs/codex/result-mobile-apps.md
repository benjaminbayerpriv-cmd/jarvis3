# Jarvis auf dem Pixel und im Handy-Browser

Desktop, Pixel-App und Handy-Browser verwenden dieselben HTML-, CSS- und JavaScript-Dateien aus `app/ui`. Auf kleinen Bildschirmen wird die Seitenleiste zum Drawer. Die Vorschau und Einstellungen nutzen die verfügbare Bildschirmbreite. Android übernimmt Kopplung, Dialoge für Modellwahl und Chataktionen, Dateiauswahl, Diktat und Haptik. Der Handy-Zugriff ist in den Computer-Einstellungen standardmäßig ausgeschaltet. Nach dem Einschalten zeigt Jarvis eine lokale HTTPS-Adresse sowie QR-Code und PIN zur Kopplung. Der Computer kann gekoppelte Geräte einzeln widerrufen.

## Auf dem Pixel installieren

1. Das APK auf dem Pixel öffnen und die Installation aus dieser Quelle erlauben. Über USB ist bei eingeschaltetem USB-Debugging auch `adb install -r Jarvis-Pixel9.apk` möglich.
2. Am Computer **Einstellungen → Allgemein → Handy-Zugriff** einschalten und **Gerät koppeln** öffnen.
3. Auf dem Pixel den QR-Code scannen oder Adresse, PIN und Zertifikat-Fingerabdruck eingeben.

Die lokale HTTPS-Adresse öffnet im Handy-Browser den APK-Download und **Im Browser weiter**. Für den Download das APK auf dem Jarvis-Computer als `~/.jarvis3/mobile-downloads/Jarvis.apk` bereitstellen. Der Browser muss dem lokal erzeugten Jarvis-Zertifikat vertrauen. Die Android-App prüft den Fingerabdruck aus der Kopplung. Build und Einrichtung stehen in [mobile/README.md](../../mobile/README.md).

## Geprüft

- Android-Debug-APK gebaut und zwei JVM-Tests bestanden.
- Pixel-9-Emulator mit Android 16 gegen einen getrennten Test-Daemon. Gespeicherte Kopplung, Chatverlauf, Nachricht, gestreamte Antwort, Tab-Vorschau, Not-Aus, native Modellauswahl und Android-Dateiauswahl geprüft.
- Chromium mit Handy-Viewport. APK-Download, Browser-Einstieg, PIN-Kopplung, Chat, Vorschau und Not-Aus geprüft.
- 78 Core-Tests bestanden. Falsche und abgelaufene PIN sowie öffentliche Quelladressen sind durch Tests abgedeckt. Ein Integrationstest bestätigte Token-Pflicht, Trennung eines aktiven WebSockets beim Widerruf und Ablehnung des widerrufenen Tokens.

## Offen

- Ein echtes Pixel 9, QR-Kamera, Bonjour im WLAN, Mikrofon und Haptik auf dem Gerät stehen für den Praxistest aus.
- Android nutzt zunächst lokales Diktat. Mikrofonstream und Sprachausgabe über den Jarvis-Sidecar sind als [Folgeauftrag](../mobile-live-audio.md) dokumentiert.
- Die gemeinsame Handy-Oberfläche unterstützt Visualisierungen als Bilddateien. Interaktive HTML-Visualisierungen stehen aus.
- iOS ist zurückgestellt.
