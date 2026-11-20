# Jarvis3 Sprach-Sidecar

Aus dem Repo starten:

```sh
uv run --project speech python -m jarvis_speech
```

Der Sidecar wärmt die Modelle auf und lauscht dann auf `ws://127.0.0.1:7778`. `jarvisd` ist der einzige Client und erhält beim Verbinden `ready` mit Modellnamen und Audiogeräten. Beim ersten Start können Parakeet beziehungsweise faster-whisper und Supertonic ihre Gewichte herunterladen. Silero VAD v6.2.1 wird mit dem Paket ausgeliefert. [Silero-Modell und Lizenz](https://github.com/snakers4/silero-vad/tree/v6.2.1)

Der Sidecar verwendet auf Apple Silicon Parakeet TDT 0.6b v3 über MLX mit 8-Bit-Quantisierung der dafür geeigneten linearen Schichten. Unter Windows und bei einem Ladefehler von Parakeet übernimmt faster-whisper large-v3-turbo (CUDA/`int8_float16` bei vorhandener GPU, sonst CPU/`int8`). Supertonic 1.3.1 erzeugt deutsche Sprache mit Stimme M1, 5 Syntheseschritten und Tempo 1,25. Bei Fehlern übernimmt unter macOS `say` und unter Windows SAPI. Texte werden vor der Wiedergabe von Markdown, URLs und Emojis bereinigt. Zahlen, Zeiten, Daten und Einheiten folgen den deutschen Regeln aus `tts_old_reference.py`.

## Einstellungen

Einstellungen gelten für den laufenden Sidecar. Audio wird über die nativen Ein- und Ausgänge aufgenommen und wiedergegeben. Je nach Betriebssystem muss Mikrofonzugriff freigegeben werden.

| Nachricht | Wirkung |
| --- | --- |
| `{"type":"mode","value":"off"}` | Startzustand. Der Mikrofoneingang ist geschlossen. |
| `{"type":"mode","value":"live"}` | Silero erkennt fortlaufend den Beginn und das Ende einer Äußerung in 32-ms-Frames. |
| `{"type":"mode","value":"ptt"}` | Spracherkennung nur bei gedrückter Taste. `{"type":"ptt","down":true}` beginnt und `{"type":"ptt","down":false}` finalisiert die Aufnahme. |
| `{"type":"config","voice":"F1","speed":1.05,"lofi":false}` | Standardwerte. Stimmen `F1`–`F5` und `M1`–`M5`, Tempo `0.5`–`2.0`. `lofi:true` aktiviert 4-Bit-Quantisierung und hält je acht Samples auf demselben Wert. |
| `{"type":"config","input":4,"output":2}` | Geräte-ID oder exakter Gerätename aus `ready.devices.input` bzw. `ready.devices.output`. `null` wählt das Systemstandardgerät. |
| `{"type":"say","id":1,"text":"Der Timer läuft."}` | Einen Satz einreihen. Der nächste Satz wird während der laufenden Ausgabe vorbereitet. |
| `{"type":"stop_speaking"}` | Wiedergabe stoppen und wartende Sätze verwerfen. |

Das Protokoll steht in [docs/speech.md](../docs/speech.md). `level` liefert etwa 30 Aktualisierungen pro Sekunde. `partial` liefert während der Aufnahme ungefähr alle 288 ms den aktuellen Erkennungsstand. Bis zum ersten Decoder-Ergebnis kann der Text leer sein. Bei Stille beginnt die finale Dekodierung bereits 32 ms nach dem letzten Sprachframe. Nach 224 ms kann ein fertiger, punktierter Satz bei eindeutiger Stille finalisiert werden. Für die übrigen Fälle gilt das 288-ms-Fenster. `final.ms` enthält nur die Dekodierzeit. Bei Barge-in vergleicht der Sidecar das Mikrofonsignal mit zeitversetzten Kopien der tatsächlich ausgegebenen PCM-Daten, bevor das Signal Silero erreicht.

## Tests und Latenzen

```sh
uv run --project speech python speech/tests/test_sidecar.py -v
uv run --project speech python speech/tests/ws_client.py
```

Der erste Befehl speist WAV-Dateien aus `bench/audio/` im Echtzeittakt in den Sidecar und arbeitet mit einem simulierten Lautsprecher-Ausgang. Der Test prüft WS-Protokoll, Partials, finales Transkript, Echo mit zwei Verzögerungen plus Rauschen, Barge-in, beide Stop-Pfade, Wiedergabereihenfolge und den macOS-Sprachfallback. Der zweite Befehl ist ein interaktiver WebSocket-Client für einen separat gestarteten Sidecar. Er nimmt eine JSON-Nachricht pro Zeile an.

Die bereits ermittelte Parakeet-Referenz beträgt 164 ms Median für die STT-Inferenz. Die Modellbenchmarks wurden für diese Arbeit nicht erneut ausgeführt.

## Windows (RTX 3060 Ti, Treiber 616.92)

`uv sync --project speech` installiert auf Windows weder `parakeet-mlx` noch `mlx-whisper` (Platform-Marker). faster-whisper nutzt automatisch CUDA mit `int8_float16`, wenn `ctranslate2` ein Gerät meldet, sonst CPU/`int8`. Die CUDA-DLLs werden über `nvidia-cublas-cu12` mitgeliefert und vor dem Laden von `ctranslate2` registriert – ohne dieses Paket scheitert der CUDA-Start trotz erkannter GPU an `cublas64_12.dll`. Supertonic 1.3.1 läuft auf Windows ebenfalls; SAPI (Microsoft Hedda, de-DE) ist nur Ersatzstimme. PortAudio meldet die JLAB- und USB-Camera-Geräte mehrfach (MME/WASAPI/WDM-KS); Geräte können in `config` wahlweise per ID oder exaktem Namen gewählt werden. Einige WDM-KS-Eingänge lassen sich nicht gleichzeitig mit WASAPI-Ausgängen öffnen.

Gemessen auf dem MacBook Pro M1 Pro mit warmen Modellen und laufendem WebSocket-Client:

| Messung | Einzelwerte in ms | Median | Ziel |
| --- | --- | ---: | --- |
| Letztes WAV-Sample mit Betrag ≥ 0,007 → empfangenes `final` | 199, 322, 279 | **279 ms** | < 300 ms, zwei von drei Läufen |
| `final.ms` für dieselben Äußerungen | 134, 143, 91 | **134 ms** | STT-Dekodierung |
| Gesendetes warmes `say` → erster nichtstiller PCM-Frame (2 Schritte, alt) | 327, 278, 394 | **327 ms** | < 400 ms |
| dasselbe mit Stimme M1, 8 Schritten und Teilung am ersten Komma (aktuell) | 985, 788, 818 | **818 ms** | Qualität vor Tempo |

Bei Barge-in und explizitem Stopp endeten die simulierte Ausgabe und das zugehörige `say_end` jeweils innerhalb von 100 ms. Der native Start des PortAudio-Ausgangs wurde zusätzlich mit 48 kHz und geschlossenem Mikrofoneingang geprüft.

Gemessen auf Windows mit demselben Test (CUDA/`int8_float16`, Supertonic M1/5 Schritte/Tempo 1,25; fünf Läufe):

| Messung | Bereich in ms | Median | Ziel |
|---|---|---:| --- |
| Letztes WAV-Sample → `final` | 261–493 | ca. 390 | < 400 ms, erreichbar aber streuend |
| `final.ms` (STT large-v3-turbo auf GPU) | 209–256 | ca. 225 | Dekodierzeit |
| Gesendetes warmes `say` → erster PCM-Ton | 286–410 | ca. 340 | < 400 ms |

Mit echter Hardware (JLAB-Headset als Mikrofon und Lautsprecher, Sidecar per `uv run --project speech python -m jarvis_speech`) wurden zusätzlich geprüft: Gerätewahl per Namen, `say` → erster Ton nach 286 ms, kein `speech_start` während und nach der Wiedergabe (Echo-Schutz), `stop_speaking` → `say_end` nach 1 ms, `mode live` ohne Sprechen ohne Fehlalarm.

## Offene Punkte

- Die Abnahmemessung mit **menschlicher** Stimme, wechselnden Raum- und Bluetooth-Latenzen steht aus. Der Agent kann nicht selbst sprechen; ein akustischer Ersatzaufbau mit SAPI-Schallquelle war nicht aussagekräftig, weil die verfügbaren Mikrofone im Leerlauf nur ~0,0005 RMS (JLAB/USB-Camera, MME) bzw. ~0,008 RMS (WDM-KS, kollidiert mit Ausgabestreams) liefern. Bitte Mikrofon freigeben/positionieren und die zehn Sätze selbst sprechen.
- Die drei WAV-Fixtures und die Windows-Einzelnachweise belegen Echo-Schutz und Unterbrechung; echte Bluetooth-Headset-Paare wurden nicht durchgesagt.
- Nach einem Stop kann eine laufende Modellinferenz noch GPU-/CPU-Zeit belegen. Ihre PCM-Ausgabe wird verworfen. Bereits an den Audiotreiber übergebene Frames unterliegen dessen Pufferlatenz.

### Übergabe an Daemon und UI

Der Sidecar spricht die Nachrichten aus `docs/speech.md` direkt. Für die UI-Weiterleitung in `core/src/index.ts` muss das Daemon-Envelope `type: "speech"` behalten. Im geprüften Stand überschreibt `...e` am Ende des Objekts den Typ mit dem Sidecar-Ereignis. `app/ui/app.js` prüft beim Empfang auf `type: "speech"`. `broadcast({ ...e, type: "speech", event: e.type })` erhält beide Typen.
