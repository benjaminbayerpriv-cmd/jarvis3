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

from .langdetect import detect_lang

LOG = logging.getLogger(__name__)
MARKDOWN = MarkdownIt("commonmark")
URL = re.compile(r"\b(?:https?://|ftp://)[^\s<>]+", re.IGNORECASE)
TAG = re.compile(r"</?[a-zA-Z][^>]*>")
# Domainnamen wie news.ycombinator.com ("news Punkt ycombinator Punkt com"), sonst werden sie verschluckt
DOMAIN = re.compile(r"\b(?:[A-Za-z0-9-]+\.)+(?:com|de|org|net|io|dev|ai|app|eu|tv|co|uk|at|ch|info|me)\b", re.IGNORECASE)


def speakable(text, lang="de"):
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
    text = re.sub(r"\bwww\.", "", text, flags=re.IGNORECASE)
    text = DOMAIN.sub(lambda m: m.group(0).replace(".", " Punkt "), text)
    text = " ".join(emoji.replace_emoji(text, replace=" ").split())
    return expand_numbers(text) if lang == "de" else text  # deutsche Zahlwörter nur für deutsche Sätze


@dataclass(frozen=True)
class Voice:
    # Vom Nutzer gewählt (Hörprobe): männliche Stimme M1, 5 Diffusionsschritte, schnelleres Tempo.
    voice: str = "M1"
    speed: float = 1.25
    lofi: bool = False
    steps: int = 5


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

    def neural(self, text, settings, lang="de"):
        if settings.voice not in self.styles:
            self.styles[settings.voice] = self.model.get_voice_style(voice_name=settings.voice)
        _, unsupported = self.model.model.text_processor.validate_text(text)
        for character in unsupported:
            text = text.replace(character, "")
        if not text.strip():
            return np.empty(0, dtype=np.float32), self.model.sample_rate
        samples, _ = self.model.synthesize(
            text=text, lang=lang, voice_style=self.styles[settings.voice],
            speed=settings.speed, total_steps=settings.steps,
        )
        return np.asarray(samples, dtype=np.float32).reshape(-1), self.model.sample_rate

    def render(self, raw, settings, rate):
        lang = detect_lang(raw)
        text = speakable(raw, lang)
        if not any(character.isalnum() for character in text):
            return np.empty(0, dtype=np.float32)
        if self.model is not None:
            try:
                samples, source = self.neural(text, settings, lang)
            except Exception:
                if not fallback_name():
                    raise
                LOG.exception("Supertonic konnte den Satz nicht erzeugen. Verwende die Systemstimme.")
                samples, source = native_voice(text, settings)
        else:
            samples, source = native_voice(text, settings)

        # Weiche Wortanfänge liegen unter 0.002: niedrige Schwelle und ~30 ms Vorlauf behalten.
        audible = np.flatnonzero(np.abs(samples) > 0.0005)
        if not len(audible):
            return np.empty(0, dtype=np.float32)
        # Remove generated lead-in so the first callback contains speech.
        lead = source // 33
        # Die Synthese hängt ca. 0,5 s Stille an jeden Schnipsel. Das machte mitten im Satz (Teilung am Komma) eine
        # halbe Sekunde Pause. Ende auf ~300 ms nach dem letzten hörbaren Sample kürzen (Platz zum Ausklingen), nur die Stille davor/darin ausblenden.
        end = min(len(samples), audible[-1] + source * 300 // 1000)
        samples = samples[max(0, audible[0] - lead):end].copy()
        fade = min(len(samples), source * 80 // 1000)
        if fade > 1:
            samples[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        if settings.lofi:
            # Aliasing and sample-and-hold, intentionally yielding the lo-fi effect.
            levels = np.clip(np.rint(samples[::8] * 8), -8, 7) / 8
            samples = np.repeat(levels, 8)[:len(samples)]
        return resample(np.clip(samples, -1, 1), source, rate)
