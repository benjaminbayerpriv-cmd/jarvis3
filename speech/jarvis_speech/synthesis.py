"""Warm local TTS, German text normalization and OS voice fallbacks."""

from dataclasses import dataclass
import logging
import os
from pathlib import Path
import platform
import re
import subprocess
import tempfile
import wave

import emoji
from markdown_it import MarkdownIt
import numpy as np

from .audio import resample
from .normalize import expand_numbers

LOG = logging.getLogger(__name__)
MARKDOWN = MarkdownIt("commonmark")
URL = re.compile(r"\b(?:https?://|ftp://|www\.)[^\s<>]+", re.IGNORECASE)
TAG = re.compile(r"</?[a-zA-Z][^>]*>")


def speakable(text):
    paragraphs = []
    for block in MARKDOWN.parse(text):
        if block.type != "inline":
            continue
        line = "".join(
            token.content if token.type in {"text", "code_inline"} else " "
            if token.type in {"softbreak", "hardbreak"} else ""
            for token in block.children
        )
        paragraphs.append(line)
    text = URL.sub(" ", TAG.sub(" ", " ".join(paragraphs)))
    return expand_numbers(" ".join(emoji.replace_emoji(text, replace=" ").split()))


@dataclass(frozen=True)
class Voice:
    voice: str = "F1"
    speed: float = 1.05
    lofi: bool = False


def fallback_name():
    return {"Darwin": "say", "Windows": "sapi"}.get(platform.system())


def native_voice(text, settings):
    engine = fallback_name()
    with tempfile.TemporaryDirectory(prefix="jarvis-speech-") as directory:
        path = Path(directory) / "speech.wav"
        if engine == "say":
            base = ["say", "-r", str(round(175 * settings.speed)), "--file-format=WAVE",
                    "--data-format=LEI16@24000", "-o", str(path), "-f", "-"]
            try:
                subprocess.run([*base, "-v", "Anna"], input=text, text=True, encoding="utf-8",
                               check=True, capture_output=True, timeout=30)
            except subprocess.CalledProcessError:
                subprocess.run(base, input=text, text=True, encoding="utf-8",
                               check=True, capture_output=True, timeout=30)
        elif engine == "sapi":
            script = (
                "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; "
                "Add-Type -AssemblyName System.Speech; "
                "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
                "try { "
                "$de = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and "
                "$_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq 'de' } | Select-Object -First 1; "
                "if ($de) { $s.SelectVoice($de.VoiceInfo.Name) }; "
                "$s.Rate = [int]$env:JARVIS_SAPI_RATE; "
                "$s.SetOutputToWaveFile($env:JARVIS_SAPI_WAV); "
                "$s.Speak([Console]::In.ReadToEnd()) "
                "} finally { $s.Dispose() }"
            )
            env = {**os.environ, "JARVIS_SAPI_WAV": str(path), "JARVIS_SAPI_RATE": str(round((settings.speed - 1) * 7))}
            subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
                           input=text, text=True, encoding="utf-8", check=True, capture_output=True, timeout=30, env=env)
        else:
            raise RuntimeError("Keine lokale Ersatzstimme verfügbar")

        with wave.open(str(path)) as audio:
            if audio.getsampwidth() != 2:
                raise RuntimeError("Ersatzstimme lieferte kein PCM16")
            samples = np.frombuffer(audio.readframes(audio.getnframes()), "<i2").astype(np.float32) / 32768
            return samples.reshape(-1, audio.getnchannels()).mean(axis=1), audio.getframerate()


class Synthesizer:
    def __init__(self):
        self.model = None
        self.styles = {}
        try:
            from supertonic import TTS

            # Keep worker counts bounded so synthesis leaves room for VAD and the audio callbacks.
            threads = max(1, min(6, (os.cpu_count() or 2) - 2))
            self.model = TTS(auto_download=True, intra_op_num_threads=threads, inter_op_num_threads=1)
            self.warmup = self.neural("Hallo, ich bin Jarvis und bin bereit.", Voice())
        except Exception:
            if not fallback_name():
                raise
            self.model = None
            LOG.exception("Supertonic konnte nicht starten. Verwende die Systemstimme.")
            self.warmup = native_voice("Hallo, ich bin Jarvis und bin bereit.", Voice())
        self.name = "supertonic" if self.model is not None else fallback_name()

    def neural(self, text, settings):
        if settings.voice not in self.styles:
            self.styles[settings.voice] = self.model.get_voice_style(voice_name=settings.voice)
        _, unsupported = self.model.model.text_processor.validate_text(text)
        for character in unsupported:
            text = text.replace(character, "")
        if not text.strip():
            return np.empty(0, dtype=np.float32), self.model.sample_rate
        samples, _ = self.model.synthesize(
            text=text, lang="de", voice_style=self.styles[settings.voice],
            speed=settings.speed, total_steps=2,
        )
        return np.asarray(samples, dtype=np.float32).reshape(-1), self.model.sample_rate

    def render(self, raw, settings, rate):
        text = speakable(raw)
        if not any(character.isalnum() for character in text):
            return np.empty(0, dtype=np.float32)
        if self.model is not None:
            try:
                samples, source = self.neural(text, settings)
            except Exception:
                if not fallback_name():
                    raise
                LOG.exception("Supertonic konnte den Satz nicht erzeugen. Verwende die Systemstimme.")
                samples, source = native_voice(text, settings)
        else:
            samples, source = native_voice(text, settings)

        audible = np.flatnonzero(np.abs(samples) > 0.002)
        if not len(audible):
            return np.empty(0, dtype=np.float32)
        # Remove generated lead-in so the first callback contains speech.
        lead = source // 250
        samples = samples[max(0, audible[0] - lead):]
        if settings.lofi:
            # Aliasing and sample-and-hold, intentionally yielding the lo-fi effect.
            levels = np.clip(np.rint(samples[::8] * 8), -8, 7) / 8
            samples = np.repeat(levels, 8)[:len(samples)]
        return resample(np.clip(samples, -1, 1), source, rate)
