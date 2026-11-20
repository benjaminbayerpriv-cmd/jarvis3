"""STT-Vergleich: Latenz und Wortfehlerrate auf deutschen Testsätzen.

uv run python bench/stt_bench.py [engine ...]
"""
import re
import sys
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
SENTENCES = (HERE / "sentences.txt").read_text().strip().splitlines()
FILES = sorted((HERE / "audio").glob("*.wav"), key=lambda p: int(p.stem))


def load(path: Path) -> np.ndarray:
    with wave.open(str(path)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), np.int16).astype(np.float32) / 32768


def words(s: str) -> list[str]:
    return re.sub(r"[^\wäöüß ]", " ", s.lower()).split()


def wer(ref: str, hyp: str) -> float:
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
    return d[len(h)] / max(1, len(r))


def engine_parakeet():
    from parakeet_mlx import from_pretrained
    model = from_pretrained("mlx-community/parakeet-tdt-0.6b-v3")
    return lambda path: model.transcribe(str(path)).text


def engine_mlx_whisper():
    import mlx_whisper
    repo = "mlx-community/whisper-large-v3-turbo"
    return lambda path: mlx_whisper.transcribe(str(path), path_or_hf_repo=repo, language="de")["text"]


def engine_faster_whisper():
    # Referenz: das STT des alten Jarvis
    from faster_whisper import WhisperModel
    model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8")
    return lambda path: " ".join(s.text for s in model.transcribe(str(path), language="de", beam_size=1)[0])


ENGINES = {"parakeet": engine_parakeet, "mlx-whisper": engine_mlx_whisper, "faster-whisper": engine_faster_whisper}

for name in sys.argv[1:] or ENGINES:
    t = time.perf_counter()
    run = ENGINES[name]()
    run(FILES[0])  # aufwärmen
    load_s = time.perf_counter() - t
    times, errors = [], []
    for path, ref in zip(FILES, SENTENCES):
        audio_s = len(load(path)) / 16000
        t = time.perf_counter()
        hyp = run(path).strip()
        times.append(time.perf_counter() - t)
        errors.append(wer(ref, hyp))
        print(f"  {name:15} {times[-1]*1000:6.0f} ms  WER {errors[-1]:.2f}  ({audio_s:.1f}s) {hyp}")
    print(f"== {name}: Median {np.median(times)*1000:.0f} ms, WER {np.mean(errors):.3f}, Laden {load_s:.1f}s\n")
