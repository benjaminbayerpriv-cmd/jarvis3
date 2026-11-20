"""32 ms endpointing with speculative transcription of the completed prefix."""

import asyncio
from collections import deque
from dataclasses import dataclass, field
import logging
import time

import numpy as np

from .audio import rms
from .recognition import FRAME, FRAME_MS, RATE, Silero

LOG = logging.getLogger(__name__)

PRE_ROLL = 16  # ~0,5 s Vorlauf: der Start wird beim Sprechen der KI später erkannt (8 Bilder), der Satzanfang darf nicht fehlen
END_SILENCE = 9
FAST_END_SILENCE = 7
SPECULATION_SILENCE = 1
PARTIAL_EVERY = 9
MAX_FRAMES = 20 * 1000 // FRAME_MS


@dataclass
class Utterance:
    frames: list = field(default_factory=list)
    last_voice: int = 0
    clear_silence: int = 0
    last_request: int = 0
    last_partial: int = 0
    text: str = ""
    candidate: tuple | None = None
    latest_decode: tuple | None = None
    closed: bool = False


class Endpoint:
    def __init__(self, loop, decode, executor, emit, on_start):
        self.loop = loop
        self.decode = decode
        self.executor = executor
        self.emit = emit
        self.on_start = on_start
        self.vad = Silero()
        self.generation = 0
        self.tasks = set()
        self.future = None
        self.reset()

    def reset(self):
        self.generation += 1
        self.pre_roll = deque(maxlen=PRE_ROLL)
        self.utterance = None
        self.start_run = 0
        self.vad.reset()
        for task in self.tasks:
            task.cancel()
        if self.future is not None:
            self.future.cancel()
        self.future = None

    def feed(self, samples, echo, auto_finish=True):
        probability = self.vad.probability(samples)
        level = rms(samples)
        if self.utterance is None:
            self.pre_roll.append(samples)
            # Während Jarvis spricht (echo): nur klare, ca. 250 ms lange Sprache unterbricht. Husten, Tastatur
            # und Reste der eigenen Stimme (vorher 3 Bilder = ~100 ms) brachen die Ausgabe zu früh ab.
            threshold = 0.75 if echo else 0.55
            floor = 0.012 if echo else 0.008
            self.start_run = self.start_run + 1 if probability >= threshold and level >= floor else 0
            if self.start_run >= (8 if echo else 2):
                self.utterance = Utterance(frames=list(self.pre_roll), last_voice=len(self.pre_roll))
                self.pre_roll.clear()
                self.on_start()
            return

        current = self.utterance
        current.frames.append(samples)
        if probability >= 0.35 and level >= 0.003:
            current.last_voice = len(current.frames)
        quiet = len(current.frames) - current.last_voice
        current.clear_silence = current.clear_silence + 1 if quiet and (level < 0.003 or probability < 0.2) else 0

        if (auto_finish and self.at_end(current, quiet)) or len(current.frames) >= MAX_FRAMES:
            self.finish()
            return
        if quiet < END_SILENCE and len(current.frames) - current.last_partial >= PARTIAL_EVERY:
            self.emit("partial", text=current.text)
            current.last_partial = len(current.frames)
        if quiet >= SPECULATION_SILENCE and not (
            current.candidate and current.candidate[0] == current.last_voice
        ):
            # Compute final-quality text while the remaining VAD silence elapses.
            self.request(current, current.last_voice, speculative=True)
        elif quiet < SPECULATION_SILENCE and len(current.frames) - current.last_request >= PARTIAL_EVERY:
            self.request(current, len(current.frames))

    def at_end(self, utterance, quiet):
        if quiet >= END_SILENCE:
            return True
        if quiet < FAST_END_SILENCE or utterance.clear_silence < 6 or not utterance.candidate:
            return False
        # A completed, punctuated decode and sustained clear silence can end
        # early. Ambiguous pauses stay on the full VAD timeout.
        end, future = utterance.candidate
        if end != utterance.last_voice or not future.done() or future.cancelled() or future.exception():
            return False
        text, _ = future.result()
        return text.endswith((".", "!", "?", "…"))

    def request(self, utterance, end, speculative=False):
        if self.future is not None and not self.future.done():
            if not speculative:
                return
            # Ein Zwischendecode beim Sprechen darf die finale Spekulation nicht
            # blockieren: Sein Ergebnis wäre veraltet und verzögert `final`.
            self.future.cancel()
            utterance.latest_decode = None
        # A little real quiet audio at the end helps pronounce trailing consonants.
        padding = 2 if speculative else 0
        sample_count = min(len(utterance.frames), end + padding)
        samples = np.concatenate(utterance.frames[:sample_count])
        future = self.loop.run_in_executor(self.executor, self.run_decode, samples)
        self.future = future
        utterance.last_request = len(utterance.frames)
        utterance.latest_decode = (sample_count, future)
        if speculative:
            utterance.candidate = (end, future)
        generation = self.generation

        def publish(done):
            if done.cancelled() or generation != self.generation:
                return
            error = done.exception()
            if error is not None:
                if not utterance.closed and not speculative:
                    self.emit("error", message=str(error))
                return
            if not utterance.closed:
                text, _ = done.result()
                if not speculative or end == utterance.last_voice:
                    utterance.text = text
                    if text and len(utterance.frames) > utterance.last_partial:
                        self.emit("partial", text=text)
                        utterance.last_partial = len(utterance.frames)

        future.add_done_callback(publish)

    def run_decode(self, samples):
        start = time.perf_counter()
        text = self.decode(samples)
        elapsed = round((time.perf_counter() - start) * 1000)
        LOG.debug("STT %.2f s PCM in %d ms", len(samples) / RATE, elapsed)
        return text, elapsed

    def finish(self):
        current, self.utterance = self.utterance, None
        self.start_run = 0
        self.pre_roll.clear()
        self.vad.reset()
        if current is None:
            return
        current.closed = True
        if current.candidate and current.candidate[0] == current.last_voice:
            future = current.candidate[1]
        elif current.latest_decode and current.latest_decode[0] >= current.last_voice + 1:
            future = current.latest_decode[1]
        else:
            samples = np.concatenate(current.frames[:current.last_voice + 2])
            future = self.loop.run_in_executor(self.executor, self.run_decode, samples)
        self.future = future
        task = self.loop.create_task(self.publish_final(future))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def publish_final(self, future):
        try:
            text, elapsed = await future
        except Exception as error:
            self.emit("error", message=str(error))
        else:
            self.emit("final", text=text, ms=elapsed)
