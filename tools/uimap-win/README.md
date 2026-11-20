# uimap für Windows

Windows-Port des Jarvis3-Bildschirmmarkers. Grundlage für Zielauswahl und Bedienung ist die Mac-Version 1.0. Der JSON-Vertrag steht in [docs/protocol.md](../../docs/protocol.md).

## Build in PowerShell

Voraussetzungen sind Windows 10 ab Build 19041 oder Windows 11 und das .NET-8-SDK. Die veröffentlichte x64-Version benötigt die **.NET 8 Desktop Runtime x64**. Alle Dateien aus `bin` gehören beim Kopieren zusammen.

```powershell
Set-Location "$env:USERPROFILE\Documents\Jarvis3\tools\uimap-win"
dotnet publish .\uimap.csproj -c Release -r win-x64 --self-contained false -o .\bin
.\bin\uimap.exe --help
```

`jarvisd` startet `tools/uimap-win/bin/uimap.exe serve`. Für ein Paket mit .NET-Runtime stattdessen `--self-contained true` verwenden. Für Windows ARM64 `-r win-arm64` einsetzen.

## CLI und JSON-Zeilen

```powershell
$uimap = '.\bin\uimap.exe'
& $uimap scan --app notepad.exe
& $uimap scan --app 'Editor' --screen --text
& $uimap scan --app notepad.exe --overlay
& $uimap displays
& $uimap serve --app notepad.exe
```

In `serve` gehen die folgenden Nachrichten einzeln über stdin. Die Beispiel-IDs durch IDs aus derselben Sitzung ersetzen.

```jsonl
{"cmd":"scan","all":true,"text":true,"rid":1}
{"cmd":"focus","id":4,"rid":2}
{"cmd":"type","id":4,"text":"Hallo Windows","rid":3}
{"cmd":"read","id":4,"rid":4}
{"cmd":"click","id":5,"rid":5}
{"cmd":"scroll","id":4,"dy":3,"rid":6}
{"cmd":"scroll","dy":-3,"rid":7}
{"cmd":"read","rect":[100,100,300,80],"rid":8}
{"cmd":"shot","rect":[100,100,600,400],"marks":true,"rid":9}
{"cmd":"displays","rid":10}
```

- Ohne `--app` scannt das Programm den Hauptmonitor. Mit `--app` wählt es ein sichtbares Fenster anhand von EXE oder Fenstertitel. `--screen` scannt den Monitor des gewählten Fensters. `--display N` wählt den Monitor für den Bildschirmmodus. Index und Koordinaten liefert `displays`.
- `rect` verwendet physische Bildschirmpixel im Format `[x,y,w,h]`. Monitore links oder oberhalb des Hauptmonitors können negative Koordinaten haben.
- Das normale `scan` schreibt `{ok,targets,ms}`, `scan --text` nur die Kurzliste und der JSON-Befehl `{"cmd":"scan","text":true}` beides. Diagnosemeldungen gehen an stderr.
- In `serve` lebt der letzte Scan im Prozess. Für einzeln gestartete CLI-Befehle läuft derselbe Vertrag über einen lokalen Snapshot unter `%LOCALAPPDATA%\Jarvis\uimap`, getrennt nach Windows-Sitzung. Der nächste Scan macht die vorherigen IDs ungültig.
- `shot` speichert auf Anfrage ein PNG im Windows-Temp-Verzeichnis und liefert den Pfad. `marks:true` zeichnet die aktuellen IDs; der Aufrufer kann das PNG nach Verwendung löschen. `--overlay` zeigt für bis zu 20 Sekunden ein Debug-Fenster mit Rahmen und IDs.
- `type` ersetzt den Inhalt eines UIA-Edit-Felds über ein schreibbares `ValuePattern` und verlangt einen bestätigten Nicht-Passwortstatus. Erkannte Passwortfelder tragen immer das Label `Passwortfeld`. `read` und `type` auf ihrer ID werden abgelehnt. Für Bildschirm-OCR werden überlappende geschützte Bereiche abgelehnt, für Screenshots schwarz abgedeckt. Bei unvollständiger Prüfung bricht die Aufnahme mit Fehler ab. Die Prüfung stützt sich auf UI Automation und native Win32-Passwort-Edits. Ein als gewöhnlicher Text gezeichnetes Geheimnis ohne Sicherheitssignal kann Windows davon nicht unterscheiden.
- Der visuelle Scan verwendet Windows Graphics Capture und dieselbe Graustufen-Kontrastprüfung wie die Swift-Referenz. Rechtecke werden in Windows über zusammenhängende Kanten gesucht. Die geometrischen Treffer sind Heuristiken. `read` löst OCR separat aus, mit `Windows.Media.Ocr` und bei verweigertem WinRT-Zugriff mit demselben OCR-Dienst über Windows PowerShell 5.1. Der OCR-Fallback hängt vom installierten Sprachpaket und dem Windows-Host ab.
- Ein Maus-Fallback braucht einen sichtbaren Trefferpunkt. Bei rein visuellen Treffern aktiviert `focus` das zugehörige Fenster. Windows kann die Aktivierung je nach Vordergrundsitzung verweigern. Geschützte Oberflächen wie UAC, manche erhöhte Anwendungen und gesperrte Desktops lassen sich aus einer normalen Benutzersitzung nicht bedienen.

### Einzelne Aktionen aus PowerShell

```powershell
& $uimap click 5
& $uimap focus 4
& $uimap type 4 'Hallo Windows'
& $uimap scroll 4 3
& $uimap read 4
& $uimap read --rect 100 100 300 80
& $uimap shot --marks
```

## Tower einschalten und vorbereiten

1. Tower einschalten, mit dem selben LAN wie den Mac verbinden und dort in Windows anmelden. Den Desktop für den Test entsperrt lassen. Es muss ein aktiver physischer oder virtueller Monitor vorhanden sein.
2. In einer **Administrator-PowerShell auf dem Tower** prüfen, ob OpenSSH Server installiert und TCP 22 vom LAN erreichbar ist. Fehlt der Dienst, die OpenSSH-Server-Komponente installieren. Bei geändertem Netzwerkanschluss oder IP prüfen, ob `tower` noch zum Rechner auflöst.

   ```powershell
   Get-WindowsCapability -Online -Name 'OpenSSH.Server*'
   # Nur falls der Status NotPresent lautet
   Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
   Set-Service -Name sshd -StartupType Automatic
   Start-Service sshd
   Get-NetFirewallRule -Name OpenSSH-Server-In-TCP
   Get-NetTCPConnection -LocalPort 22 -State Listen
   ```

   Die Firewallregel muss TCP 22 im aktiven LAN-Profil zulassen. Hilfe zur Einrichtung bietet die [Microsoft-Dokumentation zu OpenSSH](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse).
3. Vom Mac aus Verbindung und Toolchain prüfen. Die Windows-Befehle laufen in PowerShell auf dem Tower.

   ```sh
   ssh tower 'powershell -NoProfile -Command "hostname; dotnet --list-sdks; query session"'
   ```

4. Build und Dateitransfer können über SSH laufen. Die eigentlichen Desktop-Tests müssen im entsperrten Desktop des angemeldeten Benutzers laufen, direkt in PowerShell oder via [interaktiver geplanter Aufgabe](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element), die von SSH gestartet wird.
5. Falls OCR kein Sprachmodell findet, unter **Einstellungen → Zeit und Sprache** für Deutsch oder Englisch die optische Zeichenerkennung installieren. Die verfügbaren OCR-Sprachen lassen sich in Windows PowerShell 5.1 prüfen. [Microsoft PowerToys-Dokumentation zu OCR-Sprachen](https://learn.microsoft.com/en-us/windows/powertoys/text-extractor#supported-languages).

   ```powershell
   $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
   [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
   ```

## Abnahme auf Windows

| Test | Erwartetes Ergebnis |
| --- | --- |
| Namen und EXE | `scan --app notepad.exe` und ein eindeutiger Fenstertitel liefern Ziele aus dem gewählten sichtbaren Fenster. |
| JSON-Zeilen | Eine Antwort pro Zeile, `rid` unverändert, Schema nach Protokoll. Fehlerhafte JSON-Zeile mit einer gültigen Anfrage danach prüfen. |
| ID-Lebensdauer | Eine ID funktioniert für mehrere Aktionen im selben `serve` vor dem nächsten Scan. Die alte ID danach wird abgewiesen. Auch zwei getrennte CLI-Aufrufe für Scan und Aktion prüfen. |
| UI Automation | Schaltfläche mit `InvokePattern` betätigen. Normales Win32-Textfeld fokussieren, einen Unicode-Testwert setzen und per `read` mit `via:"ax"` zurücklesen. Deaktivierte Schaltfläche testen. |
| Scrollen | In einer längeren Liste mit `id` und am Mauszeiger ohne `id` scrollen. Positive und negative Werte prüfen. |
| Passwort | Testseite mit einem Dummy-Passwort verwenden. Label `Passwortfeld`, `type` und `read` nach ID abgelehnt, `read` nach überlappendem Rechteck abgelehnt, Passwortfeld im PNG schwarz. |
| Visueller Fallback | Kontrastreiche, selbst gezeichnete Schaltfläche ohne UIA-Knoten erscheint als `source:"visual"`. Klick und Deduplizierung mit einer echten UIA-Schaltfläche prüfen. |
| OCR | Sichtbaren Text im Bild per `read` mit Rechteck und `via:"ocr"` prüfen. Deutsch, Englisch und auf dem entpackten Build den OCR-Aufruf aus Windows PowerShell 5.1 prüfen. |
| Screenshot und Overlay | PNG-Ausschnitt mit und ohne IDs öffnen. Overlay-Zahlen mit Scan vergleichen und einen Klick durch das Overlay hindurch testen. |
| DPI und Monitore | 100 % und 150 % Skalierung sowie einen Monitor links vom Hauptmonitor prüfen. Rahmen, Treffer, Crop und Anzeigenindex müssen übereinstimmen. |

Der Windows-x64-Build wurde vom Mac veröffentlicht. Das JSON-Zeilenprotokoll wurde lokal mit simuliertem Desktop und die Kantenerkennung mit synthetischen Bildern geprüft. Der Tower war über SSH nicht erreichbar, daher stehen die Windows-Laufzeittests der Tabelle aus.
