"""Jarvis's single-client WebSocket protocol and realtime audio orchestration."""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import logging
import math
import time

import numpy as np
from websockets.asyncio.server import serve
from websockets.exceptions import ConnectionClosed

from .audio import EchoGate, NativeAudio, Playback, resample, rms
from .endpoint import Endpoint
from .recognition import FRAME, RATE, load_recognizer
from .synthesis import Synthesizer, Voice

LOG = logging.getLogger(__name__)


class SpeechOutput:
    def __init__(self, loop, executor, synth, audio, playback, emit):
        self.loop = loop
        self.executor = executor
        self.synth = synth
        self.audio = audio
        self.playback = playback
        self.emit = emit
        self.generation = 0
        self.jobs = asyncio.Queue(maxsize=128)
        self.worker = loop.create_task(self.run())

    def say(self, ident, text, voice):
        try:
            self.jobs.put_nowait((self.generation, ident, text, voice))
        except asyncio.QueueFull:
            raise ValueError("Sprachausgabe-Warteschlange ist voll") from None

    def stop(self):
        self.generation += 1
        self.playback.stop()
        while not self.jobs.empty():
            self.jobs.get_nowait()

    async def run(self):
        active = None
        while True:
            generation, ident, text, voice = await self.jobs.get()
            try:
                # Prepare the next sentence during playback of the current one.
                pcm = await self.loop.run_in_executor(
                    self.executor, self.synth.render, text, voice, self.audio.output_rate,
                )
                if active is not None:
                    await active
                if generation != self.generation:
                    continue
                if len(pcm):
                    active = self.playback.play(ident, pcm)
            except Exception as error:
                if generation == self.generation:
                    self.emit("error", message=f"Sprachausgabe: {error}")


class Sidecar:
    def __init__(self, audio_factory=NativeAudio):
        self.audio_factory = audio_factory
        self.loop = asyncio.get_running_loop()
        self.recognition_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="stt")
        self.synthesis_thread = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")
        self.echo = EchoGate()
        self.playback = Playback(self.loop, self.emit, self.rendered)
        self.mode = "off"
        self.pressed = False
        self.input_device = None
        self.output_device = None
        self.voice = Voice()
        self.buffer = np.empty(0, dtype=np.float32)
        self.buffer_start = 0.0
        self.mic = self.out = 0.0
        self.mic_at = self.out_at = 0.0
        self.client = None
        self.events = None
        self.endpoint = self.speech = self.level_task = self.audio = None

    async def start(self):
        self.stt, self.tts = await asyncio.gather(
            self.loop.run_in_executor(self.recognition_thread, load_recognizer),
            self.loop.run_in_executor(self.synthesis_thread, Synthesizer),
        )
        pcm, rate = self.tts.warmup
        warm = resample(pcm, rate, RATE)
        for frames in (9, 18, 36, 72):
            await self.loop.run_in_executor(self.recognition_thread, self.stt.decode, warm[:frames * FRAME])
        del self.tts.warmup
        self.audio = self.audio_factory(self.loop, self.capture, self.playback)
        self.audio.set_output(self.output_device)
        self.endpoint = Endpoint(self.loop, self.stt.decode, self.recognition_thread, self.emit, self.speech_start)
        self.speech = SpeechOutput(self.loop, self.synthesis_thread, self.tts, self.audio, self.playback, self.emit)
        self.level_task = self.loop.create_task(self.levels())

    async def close(self):
        if self.endpoint is not None:
            self.endpoint.reset()
        tasks = [task for task in [self.level_task, self.speech and self.speech.worker] if task is not None]
        if self.speech is not None:
            self.speech.stop()
        for task in tasks:
            task.cancel()
        if self.audio is not None:
            self.audio.close()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.recognition_thread.shutdown(wait=False, cancel_futures=True)
        self.synthesis_thread.shutdown(wait=False, cancel_futures=True)

    def emit(self, kind, id=None, **fields):
        if self.events is None:
            return
        if id is not None:
            fields["id"] = id
        if kind == "level" and self.events.qsize() >= 2:
            return
        try:
            self.events.put_nowait({"type": kind, **fields})
        except asyncio.QueueFull:
            self.loop.create_task(self.client.close(1013, "Event queue full"))

    async def levels(self):
        while True:
            now = time.monotonic()
            mic = self.mic if now - self.mic_at < 0.08 else 0.0
            out = self.out if now - self.out_at < 0.05 else 0.0
            self.emit("level", mic=round(min(1.0, 5 * mic), 3), out=round(min(1.0, 5 * out), 3))
            await asyncio.sleep(1 / 30)

    def rendered(self, start, pcm, rate):
        self.out = rms(pcm)
        self.out_at = start
        if self.out >= 0.001:
            self.echo.record(start, resample(pcm, rate, RATE))

    def listening(self):
        return self.mode == "live" or (self.mode == "ptt" and self.pressed)

    def capture(self, pcm, start, rate, overflow=False):
        if not self.listening():
            return
        if overflow:
            self.clear_capture()
            self.emit("error", message="Mikrofonpuffer übergelaufen")
        self.mic = rms(pcm)
        self.mic_at = time.monotonic()
        if len(self.buffer) == 0:
            self.buffer_start = start
        self.buffer = np.concatenate((self.buffer, resample(pcm, rate, RATE)))
        while len(self.buffer) >= FRAME:
            frame, self.buffer = self.buffer[:FRAME], self.buffer[FRAME:]
            cleaned, has_reference = self.echo.clean(self.buffer_start, frame)
            self.buffer_start += FRAME / RATE
            self.endpoint.feed(cleaned, has_reference, auto_finish=self.mode == "live")

    def clear_capture(self):
        self.buffer = np.empty(0, dtype=np.float32)
        self.endpoint.reset()
        self.mic = 0.0

    def finish_ptt(self):
        if len(self.buffer):
            frame = np.pad(self.buffer, (0, FRAME - len(self.buffer)))
            self.buffer = np.empty(0, dtype=np.float32)
            cleaned, has_reference = self.echo.clean(self.buffer_start, frame)
            self.endpoint.feed(cleaned, has_reference, auto_finish=self.mode == "live")
        self.endpoint.finish()
        self.mic = 0.0

    def speech_start(self):
        self.emit("speech_start")
        self.speech.stop()

    def set_mode(self, value):
        if value not in ("off", "ptt", "live"):
            raise ValueError("mode.value erwartet off, ptt oder live")
        if value == self.mode:
            return
        self.audio.set_input(self.input_device, value != "off")
        self.clear_capture()
        self.mode = value
        self.pressed = False

    def configure(self, request):
        settings = {}
        if "voice" in request:
            voice = request["voice"]
            if not isinstance(voice, str) or voice not in {f"{prefix}{i}" for prefix in ("F", "M") for i in range(1, 6)}:
                raise ValueError("config.voice erwartet F1–F5 oder M1–M5")
            settings["voice"] = voice
        if "speed" in request:
            speed = request["speed"]
            if type(speed) not in (int, float) or not math.isfinite(speed) or not 0.5 <= speed <= 2.0:
                raise ValueError("config.speed erwartet eine Zahl zwischen 0.5 und 2.0")
            settings["speed"] = speed
        if "lofi" in request:
            if type(request["lofi"]) is not bool:
                raise ValueError("config.lofi erwartet true oder false")
            settings["lofi"] = request["lofi"]

        def select(side):
            device = request[side]
            if device is None:
                return None
            for entry in self.audio.devices()[side]:
                if (type(device) is int and device == entry["id"]) or device == entry["name"]:
                    return entry["id"]
            raise ValueError(f"Unbekanntes {side}-Audiogerät")

        devices = {side: select(side) for side in ("input", "output") if side in request}
        if "output" in devices and devices["output"] != self.output_device:
            self.speech.stop()
            self.audio.set_output(devices["output"])
            self.output_device = devices["output"]
        if "input" in devices and devices["input"] != self.input_device:
            self.audio.set_input(devices["input"], self.mode != "off")
            self.input_device = devices["input"]
            self.clear_capture()
        self.voice = replace(self.voice, **settings)

    def command(self, data):
        request = json.loads(data)
        if not isinstance(request, dict):
            raise ValueError("JSON-Objekt erwartet")
        match request.get("type"):
            case "mode":
                self.set_mode(request.get("value"))
            case "ptt":
                down = request.get("down")
                if type(down) is not bool:
                    raise ValueError("ptt.down erwartet true oder false")
                if self.mode == "ptt" and down != self.pressed:
                    self.pressed = down
                    if not down:
                        self.finish_ptt()
            case "say":
                ident, text = request.get("id"), request.get("text")
                if type(ident) not in (int, str) or not isinstance(text, str) or len(text) > 5000:
                    raise ValueError("say erwartet id und text mit maximal 5000 Zeichen")
                self.speech.say(ident, text, self.voice)
            case "stop_speaking":
                self.speech.stop()
            case "config":
                self.configure(request)
            case _:
                raise ValueError("Unbekannter Sprachbefehl")

    async def send_events(self, client, events):
        while True:
            await client.send(json.dumps(await events.get(), ensure_ascii=False))

    async def connection(self, client):
        if self.client is not None:
            await client.close(1013, "Jarvis-Daemon bereits verbunden")
            return
        self.client = client
        self.events = asyncio.Queue(maxsize=256)
        self.emit("ready", stt=self.stt.name, tts=self.tts.name, devices=self.audio.devices())
        sender = self.loop.create_task(self.send_events(client, self.events))
        try:
            async for message in client:
                try:
                    self.command(message)
                except Exception as error:
                    self.emit("error", message=str(error))
        except ConnectionClosed:
            pass
        finally:
            self.events = None
            try:
                self.speech.stop()
                self.set_mode("off")
            finally:
                self.client = None
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)

    def serve(self, port=7778):
        # The local daemon uses a native client without a browser Origin.
        return serve(self.connection, "127.0.0.1", port, origins=[None], max_size=64 * 1024)
