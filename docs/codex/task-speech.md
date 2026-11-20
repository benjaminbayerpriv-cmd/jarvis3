Du arbeitest mit Claude zusammen an Jarvis3 (~/Documents/Jarvis3). Claude baut UI und Daemon, ein zweiter Codex baut die Tauri-Hülle. Deine Aufgabe: den Sprach-Sidecar in speech/, exakt nach docs/speech.md, als Paket speech/jarvis_speech (Start: uv run --project speech python -m jarvis_speech).

- Lies zuerst docs/speech.md und speech/tts_old_reference.py (Supertonic-Wrapper des alten Jarvis: Zahlennormalisierung und Fallbacks übernehmen). Benchmark-Ergebnisse stehen in speech/bench (Parakeet v3 Median 164 ms ist gesetzt). Starte die Benchmarks nicht erneut, der Nutzer hat sie abgebrochen.
- pyproject.toml und uv-Umgebung existieren schon. Ergänze Abhängigkeiten bei Bedarf (Silero VAD ONNX).
- Kernpunkte: Streaming-Endpointing mit VAD, Partials, sehr schnelles final, satzweise TTS-Warteschlange mit warmgehaltenem Supertonic, Barge-in mit Echo-Schutz (die eigene Stimme darf kein speech_start auslösen), level-Events für die Animation, optionaler Lofi-Bitcrush.
- Tests ohne Mikrofon: eine Testdatei, die WAVs aus speech/bench/audio als Mikrofon-Stream einspeist (Fake-Input), und ein WebSocket-Testclient. Miss Latenzen (Satzende → final, say → erster Ton) und schreib sie ins Readme. Benutze kein Computer Use und keine Bildschirmsteuerung.
- Ändere nichts außerhalb von speech/. Committe nur speech/ mit git add speech. Ein anderer Agent committet parallel. Bei index.lock warten und erneut versuchen.
- Am Ende: speech/README.md mit Start, Einstellungen, Messwerten und offenen Punkten.
