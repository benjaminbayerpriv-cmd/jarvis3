"""Native PortAudio devices, the playback buffer, and an output-referenced echo gate."""

import asyncio
from collections import deque
from dataclasses import dataclass
from math import gcd
import threading
import time

import numpy as np
from scipy import signal

from .recognition import RATE


def rms(samples):
    return float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0


def resample(samples, source, target):
    if source == target:
        return samples
    factor = gcd(source, target)
    return signal.resample_poly(samples, target // factor, source // factor).astype(np.float32, copy=False)


class EchoGate:
    """Find delayed/reverberant copies of the DAC signal and subtract them before VAD."""

    delay = round(0.320 * RATE)
    lead = round(0.032 * RATE)

    def __init__(self):
        self.reference = deque()

    def record(self, start, samples):
        self.trim(start - 0.6)
        self.reference.append((start, samples))

    def trim(self, before):
        while self.reference and self.reference[0][0] < before:
            self.reference.popleft()

    def clean(self, start, frame):
        self.trim(start - 0.45)
        if not self.reference:
            return frame, False
        first = start - self.delay / RATE
        reference = np.zeros(self.delay + len(frame) + self.lead, dtype=np.float32)
        for when, samples in self.reference:
            offset = round((when - first) * RATE)
            left, right = max(0, offset), min(len(reference), offset + len(samples))
            if right > left:
                reference[left:right] = samples[left - offset:right - offset]
        peak = float(np.max(np.abs(reference)))
        if peak < 0.003:
            return frame, False

        # Projection onto the best aligned copies also removes strong early reflections.
        energy = np.concatenate(([0.0], np.cumsum(reference * reference, dtype=np.float64)))
        energy = np.maximum(energy[len(frame):] - energy[:-len(frame)], 1e-6)
        residual = frame.copy()
        matched = False
        for _ in range(3):
            power = float(residual @ residual)
            if power < 1e-5:
                break
            products = signal.correlate(reference, residual, mode="valid", method="fft")
            scores = np.abs(products) / np.sqrt(energy * power)
            offset = int(np.argmax(scores))
            if scores[offset] < (0.30 if matched else 0.38):
                break
            gain = float(np.clip(products[offset] / energy[offset], -1.6, 1.6))
            residual -= gain * reference[offset:offset + len(frame)]
            matched = True

        # Unmodelled room/device distortion tends to be quiet relative to playback.
        floor = max(0.006, peak * (0.028 if matched else 0.055))
        if rms(residual) < floor:
            residual.fill(0)
        return residual, True


@dataclass
class Clip:
    id: int | str
    pcm: np.ndarray
    done: asyncio.Future
    offset: int = 0
    started: bool = False


class Playback:
    """A single clip shared by the event loop and the audio callback thread."""

    def __init__(self, loop, emit, reference):
        self.loop = loop
        self.emit = emit
        self.reference = reference
        self.lock = threading.Lock()
        self.clip = None

    def play(self, ident, pcm):
        clip = Clip(ident, pcm, self.loop.create_future())
        with self.lock:
            if self.clip is not None:
                raise RuntimeError("Audioausgabe ist bereits belegt")
            self.clip = clip
        return clip.done

    def stop(self):
        with self.lock:
            clip, self.clip = self.clip, None
            if clip is not None:
                self.loop.call_soon(self.finish, clip)

    def finish(self, clip):
        if not clip.done.done():
            if clip.started:
                self.emit("say_end", id=clip.id)
            clip.done.set_result(None)

    def render(self, out, start, rate):
        out.fill(0)
        with self.lock:
            clip = self.clip
            if clip is None:
                return
            length = min(len(out), len(clip.pcm) - clip.offset)
            out[:length] = clip.pcm[clip.offset:clip.offset + length]
            if not clip.started and np.any(np.abs(out) > 0.001):
                clip.started = True
                self.loop.call_soon_threadsafe(self.emit, "say_start", clip.id)
            self.loop.call_soon_threadsafe(self.reference, start, out.copy(), rate)
            clip.offset += length
            if clip.offset >= len(clip.pcm):
                self.clip = None
                self.loop.call_soon_threadsafe(self.finish, clip)


class NativeAudio:
    def __init__(self, loop, capture, playback):
        import sounddevice as sd

        self.sd = sd
        self.loop = loop
        self.capture = capture
        self.playback = playback
        self.input = None
        self.output = None
        self.input_device = None
        self.output_device = None
        self.output_rate = RATE

    def devices(self):
        devices = self.sd.query_devices()
        return {
            side: [{"id": i, "name": info["name"], "default": i == self.sd.default.device[index]}
                   for i, info in enumerate(devices) if info["max_" + side + "_channels"]]
            for index, side in enumerate(("input", "output"))
        }

    def set_input(self, device, enabled):
        if not enabled and self.input is None:
            self.input_device = device
            return
        if enabled and self.input is not None and device == self.input_device:
            return
        if not enabled:
            self.input.close()
            self.input = None
            self.input_device = device
            return
        # Ask PortAudio for 16 kHz first. Some Windows hardware needs its native rate.
        info = self.sd.query_devices(device, "input")
        rate = RATE
        try:
            self.sd.check_input_settings(device=device, channels=1, samplerate=rate, dtype="float32")
        except self.sd.PortAudioError:
            rate = round(info["default_samplerate"])
        token = object()

        def receive(indata, frames, timing, status):
            start = time.monotonic() + timing.inputBufferAdcTime - timing.currentTime
            self.loop.call_soon_threadsafe(deliver, indata[:, 0].copy(), start, bool(status.input_overflow))

        def deliver(samples, start, overflow):
            if getattr(self, "_input_token", None) is token and self.input is not None:
                self.capture(samples, start, rate, overflow)

        stream = self.sd.InputStream(device=device, samplerate=rate, blocksize=round(rate * 0.010),
                                     channels=1, dtype="float32", latency="low", callback=receive)
        try:
            stream.start()
        except BaseException:
            stream.close()
            raise
        if self.input is not None:
            self.input.close()
        self.input, self.input_device, self._input_token = stream, device, token

    def set_output(self, device):
        if self.output is not None and device == self.output_device:
            return
        info = self.sd.query_devices(device, "output")
        rate = round(info["default_samplerate"])

        def send(outdata, frames, timing, status):
            start = time.monotonic() + timing.outputBufferDacTime - timing.currentTime
            self.playback.render(outdata[:, 0], start, rate)
            outdata[:, 1:] = outdata[:, :1]

        channels = min(2, info["max_output_channels"])
        stream = self.sd.OutputStream(device=device, samplerate=rate, blocksize=round(rate * 0.010),
                                      channels=channels, dtype="float32", latency="low", callback=send)
        try:
            stream.start()
        except BaseException:
            stream.close()
            raise
        if self.output is not None:
            self.output.close()
        self.output, self.output_device, self.output_rate = stream, device, rate

    def close(self):
        if self.input is not None:
            self.input.close()
        if self.output is not None:
            self.output.close()
