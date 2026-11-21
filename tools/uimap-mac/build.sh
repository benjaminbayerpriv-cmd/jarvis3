#!/bin/sh
# Baut tools/uimap-mac/bin/uimap (macOS, Xcode-Kommandozeilenwerkzeuge nötig). Danach jarvisd neu starten.
set -e
cd "$(dirname "$0")"
mkdir -p bin
swiftc -O Sources/*.swift -o bin/uimap
echo "gebaut: $(pwd)/bin/uimap"
