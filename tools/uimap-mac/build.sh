#!/bin/sh
# Baut tools/uimap-mac/bin/uimap (Bedienelemente, Eingaben) und bin/Jarvis Bildschirm.app (Aufnahme-Dienst mit eigener
# Bildschirmaufnahme-Freigabe für verdeckte Fenster und das Live-Bild). Xcode-Kommandozeilenwerkzeuge nötig.
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O Sources/*.swift -o bin/uimap
APP="bin/Jarvis Bildschirm.app"
# macOS bindet die Bildschirmaufnahme-Freigabe an die Signatur der App. Ohne festes Zertifikat (ad-hoc) ist jeder Neubau eine
# "neue" App und die erteilte Freigabe gilt nicht mehr. Darum die App nur bauen, wenn sie fehlt oder ausdrücklich --app.
if [ -x "$APP/Contents/MacOS/uimap" ] && [ "$1" != "--app" ]; then
  echo "gebaut: $(pwd)/bin/uimap (Jarvis Bildschirm.app unverändert, Freigabe bleibt gültig; neu bauen mit --app)"
  exit 0
fi
mkdir -p "$APP/Contents/MacOS"
cp bin/uimap "$APP/Contents/MacOS/uimap"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>de.jarvis3.bildschirm</string>
  <key>CFBundleName</key><string>Jarvis Bildschirm</string>
  <key>CFBundleExecutable</key><string>uimap</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSUIElement</key><true/>
  <key>NSScreenCaptureUsageDescription</key><string>Jarvis nimmt das Fenster auf, das es für dich bedient – auch wenn es verdeckt ist.</string>
</dict></plist>
PLIST
# Feste Signatur: macOS bindet die Bildschirmaufnahme-Freigabe an die Signatur. Mit dem lokalen Zertifikat "Jarvis Local Code Signing"
# (falls bereits im Schlüsselbund vorhanden) bleibt die Freigabe auch nach einem Neubau gültig; ohne Zertifikat ad-hoc (Freigabe danach neu setzen).
IDENTITY="Jarvis Local Code Signing"
if security find-identity -p codesigning 2>/dev/null | grep -q "$IDENTITY"; then
  codesign --force --sign "$IDENTITY" --identifier de.jarvis3.bildschirm "$APP" >/dev/null 2>&1 || codesign --force --sign - "$APP" >/dev/null 2>&1 || true
else
  codesign --force --sign - "$APP" >/dev/null 2>&1 || true
fi
echo "gebaut: $(pwd)/bin/uimap und $(pwd)/$APP"
