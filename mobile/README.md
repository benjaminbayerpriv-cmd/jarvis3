# Jarvis auf dem Pixel und im Handy-Browser

Die Pixel-App und der Handy-Browser verwenden das HTML, CSS und JavaScript der Desktop-Oberfläche aus `app/ui`. Der APK-Build übernimmt diese Dateien direkt. Ein responsives Layout passt Seitenleiste, Einstellungen, Chat und Vorschau an kleine Bildschirme an. Android stellt Kopplung, Dialoge für Modellwahl und Chataktionen, Dateiauswahl, Diktat und Vibration über System-APIs bereit. Beide verbinden sich im selben privaten Netz mit Jarvis. Am Computer unter **Einstellungen → Allgemein → Handy-Zugriff** den Zugriff einschalten. „Gerät koppeln“ zeigt URL, QR-Code, PIN und Zertifikat-Fingerabdruck.

## Android-App bauen und installieren

Voraussetzungen sind JDK 21, Android SDK Platform 37 und Build-Tools 36.0.0. Der Gradle-Wrapper liegt im Projekt.

```sh
cd mobile/android
export JAVA_HOME="$(/usr/libexec/java_home -v 21)"
export ANDROID_HOME="$HOME/Library/Android/sdk"
./gradlew :app:assembleDebug :app:testDebugUnitTest
```

Auf dem Pixel **Entwickleroptionen → USB-Debugging** einschalten, USB verbinden und den Computer am Pixel bestätigen. Anschließend aus `mobile/android` ausführen:

```sh
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Die App kann den Jarvis-QR-Code scannen. Für die manuelle Kopplung die private IP-Adresse mit Port, die PIN und den Zertifikat-Fingerabdruck vom Computer übernehmen. Auf Android 17 wird der Zugriff aufs lokale Netz separat angefragt. Diktat verwendet die auf dem Gerät installierte Spracherkennung. Falls sie fehlt, muss die passende Sprache in Android für lokale Erkennung bereitgestellt werden.

## APK im lokalen Browser anbieten

Nach dem Build auf dem Jarvis-Computer aus der Repo-Wurzel:

```sh
mkdir -p "$HOME/.jarvis3/mobile-downloads"
cp mobile/android/app/build/outputs/apk/debug/app-debug.apk "$HOME/.jarvis3/mobile-downloads/Jarvis.apk"
```

Die unter Handy-Zugriff angezeigte HTTPS-Adresse im Handy-Browser öffnen. Der große Download lädt das APK direkt vom Computer. Android fragt beim Öffnen des APK je nach Geräteeinstellung nach der Erlaubnis für Installationen aus dieser Quelle. „Im Browser weiter“ öffnet die Handy-Webseite. Dort erfolgt die Kopplung per PIN. Das APK ist ein Debug-Build für die lokale Installation. Für eine Veröffentlichung ist eine eigene Release-Signierung erforderlich.

Der Browser verwendet seine eigene Zertifikatsprüfung. Beim selbst erzeugten Jarvis-Zertifikat ist das bewusste Vertrauen in dieses Zertifikat im Browser erforderlich. Die Pixel-App prüft den Fingerabdruck direkt aus der Kopplung. Beim Wechsel der IP-Adresse kann im Browser ein neuer Adresshinweis erscheinen. Der Computer zeigt seine aktuellen Adressen in den Einstellungen an.

## Separater Daemon für Entwicklung

Für einen zweiten Daemon eigene Ports und eigene Datenpfade verwenden. Auch die Sprachverbindung auf einen separaten, unbenutzten Port legen, damit sich der Test nicht an den produktiven Sidecar hängt.

```sh
jarvis_test_dir="$(mktemp -d)"
JARVIS_PORT=17887 JARVIS_OPENCODE_PORT=18097 JARVIS_NO_SIDECAR=1 \
JARVIS_SPEECH_URL=ws://127.0.0.1:17998 JARVIS_DATA_DIR="$jarvis_test_dir" \
JARVIS_EXTENSIONS="$jarvis_test_dir/extensions.json" JARVIS_ERRORS_DIR="$jarvis_test_dir/errors" \
JARVIS_USAGE_FILE="$jarvis_test_dir/usage.jsonl" JARVIS_VISUALS="$jarvis_test_dir/visuals" \
bun run core/src/index.ts
```

Der Handy-Listener nutzt in diesem Beispiel Port 17897. Im Android-Emulator erreicht die App den Mac über `10.0.2.2:17897`. Haptik und Benachrichtigungen hängen vom Gerät ab. Benachrichtigungen werden lokal ausgelöst, wenn eine längere Aufgabe endet, während die App im Hintergrund noch mit Jarvis verbunden ist.
