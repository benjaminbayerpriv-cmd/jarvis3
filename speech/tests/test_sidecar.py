"""Exercise the real models and WebSocket protocol without using audio hardware."""

import asyncio
import json
from collections import deque
from pathlib import Path
import logging
import os
import platform
import statistics
import time
import unittest
import wave

import numpy as np
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from jarvis_speech.audio import Playback, resample
from jarvis_speech.recognition import RATE
from jarvis_speech.server import Sidecar
from jarvis_speech.synthesis import Voice, native_voice, speakable
from ws_client import Client

FIXTURES = Path(__file__).resolve().parents[1] / "bench" / "audio"


def wav(number):
    with wave.open(str(FIXTURES / f"{number}.wav")) as stream:
        assert stream.getsampwidth() == 2
        pcm = np.frombuffer(stream.readframes(stream.getnframes()), "<i2").astype(np.float32) / 32768
        return resample(pcm.reshape(-1, stream.getnchannels()).mean(axis=1), stream.getframerate(), RATE)


class FakeAudio:
    output_rate = 48000
    period = 0.01

    def __init__(self, loop, capture, playback):
        self.loop = loop
        self.capture = capture
        self.playback = playback
        self.input_enabled = False
        self.loopback = False
        self.signal = None
        self.first_sound = {}
        self.last_sound = {}
        self.echo_path = deque(maxlen=12)
        self.rng = np.random.default_rng(42)
        self.task = loop.create_task(self.clock())

    def devices(self):
        return {kind: [{"id": 0, "name": f"Fake {kind}", "default": True}] for kind in ("input", "output")}

    def set_input(self, device, enabled):
        self.input_enabled = enabled

    def set_output(self, device):
        pass

    def close(self):
        self.task.cancel()

    def feed(self, pcm):
        assert self.signal is None, "a WAV is already being injected"
        last = int(np.flatnonzero(np.abs(pcm) >= 0.007)[-1])
        end = self.loop.create_future()
        drained = self.loop.create_future()
        self.signal = (pcm, 0, last, end, drained)
        return end, drained

    async def clock(self):
        due = time.monotonic()
        step = round(RATE * self.period)
        while True:
            await asyncio.sleep(max(0, due - time.monotonic()))
            stamp = time.monotonic()
            audio_stamp = due
            playback = np.empty(round(self.output_rate * self.period), dtype=np.float32)
            clip = self.playback.clip
            self.playback.render(playback, audio_stamp, self.output_rate)
            if clip is not None:
                audible = np.flatnonzero(np.abs(playback) > 0.001)
                if len(audible):
                    self.first_sound.setdefault(clip.id, stamp + audible[0] / self.output_rate)
                    self.last_sound[clip.id] = stamp + audible[-1] / self.output_rate

            self.echo_path.append(resample(playback, self.output_rate, RATE))
            mic = np.zeros(step, dtype=np.float32)
            if self.loopback and len(self.echo_path) >= 10:
                mic += 0.62 * self.echo_path[-8] + 0.14 * self.echo_path[-10]
                mic += self.rng.normal(0, 0.0015, step).astype(np.float32)
            if self.signal is not None:
                pcm, offset, last, end, drained = self.signal
                chunk = pcm[offset:offset + step]
                mic[:len(chunk)] += chunk
                if offset <= last < offset + step:
                    end.set_result(stamp + (last - offset) / RATE)
                if offset + step >= len(pcm):
                    self.signal = None
                    drained.set_result(None)
                else:
                    self.signal = (pcm, offset + step, last, end, drained)
            if self.input_enabled:
                self.capture(mic, audio_stamp, RATE)
            due += self.period


class SpeechTests(unittest.IsolatedAsyncioTestCase):
    def test_preroll_wakes_device_after_pause(self):
        """Nach einer Pause läuft erst ein unhörbarer Vorlauf (Bluetooth-Aufwecken), dann die Sprache."""
        async def run(idle):
            loop = asyncio.get_running_loop()
            events, refs = [], []
            playback = Playback(loop, lambda kind, id=None, **_: events.append(kind), lambda *args: refs.append(args))
            playback.last_active = time.monotonic() - idle
            playback.play(1, np.full(4800, 0.3, dtype=np.float32))  # 0,1 s Sprache bei 48 kHz
            blocks = []
            for _ in range(40):  # 0,4 s
                out = np.zeros(480, dtype=np.float32)
                playback.render(out, 0.0, 48000)
                blocks.append(out)
            await asyncio.sleep(0.01)
            return np.concatenate(blocks), events

        pcm, events = asyncio.run(run(idle=10))
        preroll, speech = pcm[:14400], pcm[14400:19200]  # 0,3 s Vorlauf, danach Sprache
        self.assertGreater(float(np.abs(preroll).max()), 0.0)       # Signal liegt an, Gerät wacht auf
        self.assertLess(float(np.abs(preroll).max()), 0.001)         # unhörbar und unter der say_start-Schwelle
        self.assertTrue(np.allclose(speech, 0.3))                    # Sprache beginnt vollständig, nichts abgeschnitten
        self.assertEqual(events.count("say_start"), 1)

        pcm, events = asyncio.run(run(idle=0.2))                     # mitten im Gespräch: kein Vorlauf
        self.assertTrue(np.allclose(pcm[:4800], 0.3))

    def test_normalization(self):
        self.assertEqual(
            speakable("**Am 3. Oktober** um 14:30 Uhr: 16,3°C [Info](https://example.test) 😄"),
            "Am dritten Oktober um vierzehn Uhr dreißig: sechzehn Komma drei Grad Info",
        )
        self.assertEqual(speakable("Besuch https://example.test 🛸\n\n```py\nprint(42)\n```"), "Besuch")

    @unittest.skipUnless(platform.system() == "Darwin", "macOS system voice")
    def test_mac_fallback_pcm(self):
        pcm, rate = native_voice("Das ist ein Test.", Voice())
        self.assertEqual(rate, 24000)
        self.assertGreater(float(np.max(np.abs(pcm))), 0.01)

    @unittest.skipUnless(platform.system() == "Windows", "Windows system voice")
    def test_windows_fallback_pcm(self):
        pcm, rate = native_voice("Das ist ein Test.", Voice())
        self.assertGreater(rate, 8000)
        self.assertGreater(float(np.max(np.abs(pcm))), 0.01)

    async def test_real_models_and_protocol(self):
        sidecar = Sidecar(FakeAudio)
        final_ms, stt_ms, say_ms = [], [], []
        try:
            await sidecar.start()
            async with sidecar.serve(port=0) as server:
                url = f"ws://127.0.0.1:{server.sockets[0].getsockname()[1]}"
                async with connect(url) as socket:
                    client = Client(socket)
                    try:
                        await self.exercise(client, sidecar.audio, url, final_ms, stt_ms, say_ms)
                    except Exception:
                        print([m for _, m in client.messages if m["type"] != "level"], flush=True)
                        raise
                    finally:
                        await client.close()
        finally:
            await sidecar.close()
            print(f"Final nach WAV-Stimmende (ms): {final_ms}; STT (ms): {stt_ms}; say bis erster PCM-Ton (ms): {say_ms}")
        print(f"Median Final: {statistics.median(final_ms):.0f} ms; Median TTS: {statistics.median(say_ms):.0f} ms")

    async def exercise(self, client, audio, url, final_ms, stt_ms, say_ms):
        now, ready = await client.wait("ready")
        self.assertIn(ready["stt"], {"parakeet-tdt-0.6b-v3", "faster-whisper-large-v3-turbo"})
        self.assertIn(ready["tts"], {"supertonic", "sapi", "say"})
        self.assertEqual(ready["devices"], audio.devices())
        _, level = await client.wait("level", now)
        self.assertEqual((level["mic"], level["out"]), (0, 0))
        await client.send("mode", value="off")
        _, drained = audio.feed(wav(4))
        await drained
        self.assertFalse(any(message["type"] == "speech_start" for _, message in client.messages))

        error_at = await client.send("config", speed=20)
        await client.wait("error", error_at)
        await client.send("config", voice="F1", speed=1.05, lofi=False, input=0, output=0)
        await client.send("mode", value="live")
        await asyncio.sleep(0.05)

        for number, expected in [(4, "bildschirm"), (3, "nachricht"), (6, "timer")]:
            since = time.monotonic()
            voice_end, drained = audio.feed(wav(number))
            await client.wait("speech_start", since)
            _, partial = await client.wait("partial", since)
            final_at, final = await client.wait("final", since)
            await drained
            self.assertIsInstance(partial["text"], str)
            if number == 3:
                self.assertTrue(any(t < final_at and t >= since and m["type"] == "partial" and m["text"]
                                    for t, m in client.messages), "no interim text during the long WAV")
            self.assertIn(expected, final["text"].casefold())
            self.assertGreater(final["ms"], 0)
            final_ms.append(round((final_at - await voice_end) * 1000))
            stt_ms.append(final["ms"])

        await client.send("mode", value="ptt")
        await asyncio.sleep(0.03)
        since = await client.send("ptt", down=True)
        _, drained = audio.feed(wav(4))
        await client.wait("speech_start", since)
        await drained
        await client.send("ptt", down=False)
        _, final = await client.wait("final", since)
        self.assertIn("bildschirm", final["text"].casefold())
        await client.send("mode", value="live")
        await asyncio.sleep(0.03)

        audio.loopback = True
        for i, text in enumerate(["Dabei helfe ich dir.", "Der Timer wurde gestartet.", "Guten Abend, ich bin bereit."]):
            start = await client.send("say", id=i, text=text)
            await client.wait("say_start", start, id=i)
            say_ms.append(round((audio.first_sound[i] - start) * 1000))
            end, _ = await client.wait("say_end", start, id=i)
            self.assertFalse(any(t >= start and t <= end and msg["type"] == "speech_start" for t, msg in client.messages),
                             "the sidecar heard its own voice")
        await asyncio.sleep(0.4)
        self.assertFalse(any(t >= start and msg["type"] == "speech_start" for t, msg in client.messages),
                         "reverberant output tail caused barge-in")

        await client.send("config", lofi=True)
        since = await client.send("say", id="interrupted", text="Ich spreche jetzt etwas länger, damit dieser Satz bewusst unterbrochen werden kann.")
        await client.send("say", id="discarded", text="Das soll nicht abgespielt werden.")
        await client.wait("say_start", since, id="interrupted")
        await asyncio.sleep(0.42)
        _, drained = audio.feed(wav(4))
        barge, _ = await client.wait("speech_start", since)
        stopped, _ = await client.wait("say_end", since, id="interrupted")
        self.assertLess(stopped - barge, 0.1)
        self.assertLess(audio.last_sound["interrupted"] - barge, 0.1)
        _, final = await client.wait("final", barge)
        self.assertIn("bildschirm", final["text"].casefold())
        await drained
        self.assertFalse(any(msg.get("id") == "discarded" for _, msg in client.messages))

        since = await client.send("say", id="manual", text="Diese Wiedergabe wird durch den Daemon gestoppt.")
        await client.wait("say_start", since, id="manual")
        stop = await client.send("stop_speaking")
        stopped, _ = await client.wait("say_end", since, id="manual")
        self.assertLess(stopped - stop, 0.1)
        self.assertLess(audio.last_sound["manual"] - stop, 0.1)

        first = await client.send("say", id="first", text="Der erste Satz.")
        await client.send("say", id="second", text="Der zweite Satz.")
        ended, _ = await client.wait("say_end", first, id="first")
        started, _ = await client.wait("say_start", first, id="second")
        self.assertGreaterEqual(started, ended)
        await client.wait("say_end", first, id="second")
        self.assertTrue(any(m["type"] == "level" and m["mic"] > 0 for _, m in client.messages))
        self.assertTrue(any(m["type"] == "level" and m["out"] > 0 for _, m in client.messages))

        # Neue Daemon-Verbindung ersetzt die alte (auch eine tote), statt abgelehnt zu werden.
        async with connect(url) as other:
            ready = json.loads(await asyncio.wait_for(other.recv(), 5))
            self.assertEqual(ready["type"], "ready")


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("JARVIS_TEST_LOG", "WARNING"))
    unittest.main()
