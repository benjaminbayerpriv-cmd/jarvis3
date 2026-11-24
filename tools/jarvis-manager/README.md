# Jarvis Manager

Im Repository `Jarvis Manager.command` (macOS) bzw. `Jarvis Manager.bat` (Windows) starten. Python 3 ist erforderlich. Auf macOS läuft die Oberfläche direkt im Terminal: Aktionen sind per Maus oder mit Pfeiltasten und Eingabe bedienbar, Protokolle per Mausrad oder Pfeiltasten durchsuchbar. Das Terminal muss Mausmeldungen unterstützen. Auf Windows erfolgt die Auswahl über Zahlen. Über „Web-Manager“ ist dieselbe Verwaltung lokal im Browser erreichbar. Der Web-Manager ist nur an `127.0.0.1` gebunden und läuft, solange der Manager geöffnet ist.

„Jarvis starten“ startet den lokalen Daemon, der das Sprachmodul selbst startet. Bereits laufende Instanzen werden erkannt. „Jarvis beenden“ beendet aus Sicherheitsgründen nur den Daemon, den dieser Manager selbst gestartet hat. Ein separat gestarteter Sprachdienst kann weiterlaufen. „Voraussetzungen installieren“ installiert die Projektabhängigkeiten über `bun install` und `uv sync`; dabei können größere Downloads entstehen. Bun, uv und OpenCode müssen zuvor installiert und im PATH verfügbar sein. Offizielle Installationsanleitungen: https://bun.sh/docs/installation, https://docs.astral.sh/uv/getting-started/installation/, https://opencode.ai/docs/.

Protokolle: `~/.jarvis3/manager.log`, `sidecar.log` und `voice.log`. Diese können persönliche Inhalte enthalten.
