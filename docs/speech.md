# Sprach-Sidecar – Vertrag (speech/)

Python (uv, `speech/pyproject.toml`). Startbefehl: `uv run --project speech python -m jarvis_speech`.
Läuft als WebSocket-**Server** auf `ws://127.0.0.1:7778`. jarvisd verbindet sich als einziger Client.
Mikrofon und Lautsprecher gehören dem Sidecar (native Aufnahme, keine Browser-Audio-API).

## Modelle (entschieden per Benchmark, `speech/bench/`)
- STT: **Parakeet TDT 0.6b v3** über `parakeet-mlx` (Mac, Median 164 ms). Windows/Fallback: `faster-whisper` large-v3-turbo.
- VAD: **Silero VAD** (ONNX), 16 kHz, 32-ms-Frames.
- TTS: **Supertonic 1.3.1** (wie alter Jarvis, `speech/tts_old_reference.py`: Zahlen per `num2words`, Fallback `say`/SAPI).
  Optionaler „Low-Quality“-Filter: Bitcrush 4 Bit / Samplerate ÷8 (Einstellung `lofi`).

## Nachrichten Sidecar → jarvisd
| type | Felder | Bedeutung |
|---|---|---|
| `ready` | `stt`, `tts`, `devices` | Modelle geladen |
| `speech_start` | – | Nutzer fängt an zu sprechen (auch während Jarvis spricht → Barge-in) |
| `partial` | `text` | Zwischentext, ≥ alle 300 ms während des Sprechens |
| `final` | `text`, `ms` (STT-Dauer) | Satzende erkannt (VAD-Stille ~350 ms) |
| `level` | `mic`, `out` (0–1) | ~30× pro Sekunde, für die Orb-/Wellen-Animation |
| `say_start` / `say_end` | `id` | Beginn/Ende der Wiedergabe eines Satzes |
| `error` | `message` | |

## Nachrichten jarvisd → Sidecar
| type | Felder | Bedeutung |
|---|---|---|
| `mode` | `value`: `off` \| `ptt` \| `live` | aus / Push-to-talk / Dauergespräch |
| `ptt` | `down`: bool | Taste gedrückt/losgelassen |
| `say` | `id`, `text` | Satz in die Wiedergabe-Warteschlange (jarvisd schickt satzweise, sobald ein Satz fertig gestreamt ist) |
| `stop_speaking` | – | Warteschlange leeren, Wiedergabe sofort stoppen (< 100 ms) |
| `config` | `voice?`, `speed?`, `lofi?`, `input?`, `output?` | Einstellungen |

## Anforderungen
- Latenz: Satzende → `final` < 300 ms; erstes `say` → hörbarer Ton < 400 ms (Supertonic warm halten, Satz 1 sofort synthetisieren).
- Barge-in: Spricht der Nutzer während der Wiedergabe, sendet der Sidecar `speech_start` und stoppt selbst die Wiedergabe.
  Echo der eigenen Stimme darf kein Barge-in auslösen (Echo-Unterdrückung, z. B. macOS Voice Processing I/O oder Pegel-/Korrelations-Gate gegen das Ausgangssignal).
- Text aus dem Modell kann Markdown enthalten: vor TTS Markdown, URLs und Emojis entfernen.

## Überwachung des Sidecars (jarvisd)
- `core/src/sidecar.ts` startet den Sidecar (`uv run --project speech python -m jarvis_speech`, abgekoppelt, Log `~/.jarvis3/sidecar.log`), wenn Port 7778 nicht erreichbar ist, und startet ihn bei Bedarf neu. Mit `JARVIS_NO_SIDECAR=1` oder `JARVIS_SPEECH_URL` ist das aus.
- Wächter in `core/src/index.ts` (höchstens ein Neustart pro 30 s, mit Hinweis in der Oberfläche): (1) kommt nach dem Start des Zuhörens 7 s lang kein Mikro-Pegel, wird einmal pro Gespräch neu gestartet (liest die Audiogeräte frisch ein), danach nur noch ein Hinweis mit Gerätename; (2) bleiben die Pegel-Ereignisse (30 pro Sekunde) länger als 5 s aus, hängt der Sidecar; (3) wurde ein Satz geschickt und kam 12 s lang kein `say_start`, obwohl nichts gesprochen wird, hängt die Sprachausgabe.
