"""Silero VAD and the two local transcription engines."""

from pathlib import Path
import logging
import platform

import numpy as np
import onnxruntime as ort

RATE = 16000
FRAME = 512
FRAME_MS = FRAME * 1000 // RATE
LOG = logging.getLogger(__name__)


class Silero:
    def __init__(self):
        options = ort.SessionOptions()
        options.inter_op_num_threads = 1
        options.intra_op_num_threads = 1
        model = Path(__file__).with_name("models") / "silero_vad.onnx"
        self.session = ort.InferenceSession(str(model), sess_options=options, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self):
        self.state = np.zeros((2, 1, 128), dtype=np.float32)
        self.context = np.zeros(64, dtype=np.float32)

    def probability(self, frame):
        samples = np.concatenate((self.context, frame))
        result, self.state = self.session.run(None, {
            "input": samples[None, :], "state": self.state, "sr": np.asarray(RATE, dtype=np.int64),
        })
        self.context = samples[-64:]
        return float(result[0, 0])


class Parakeet:
    name = "parakeet-tdt-0.6b-v3"

    def __init__(self):
        import mlx.core as mx
        import mlx.nn as nn
        from parakeet_mlx import from_pretrained
        from parakeet_mlx.audio import get_logmel

        self.mx = mx
        self.model = from_pretrained("mlx-community/" + self.name)
        # Keep the v3 checkpoint and reduce the bandwidth of its linear layers.
        nn.quantize(self.model, group_size=64, bits=8, class_predicate=lambda _, layer:
                    isinstance(layer, nn.Linear) and layer.weight.shape[-1] % 64 == 0)
        mx.eval(self.model.parameters())
        self.get_logmel = get_logmel

    def decode(self, samples):
        mel = self.get_logmel(self.mx.array(samples), self.model.preprocessor_config)
        return self.model.generate(mel)[0].text.strip()


class Whisper:
    name = "faster-whisper-large-v3-turbo"

    def __init__(self):
        from faster_whisper import WhisperModel

        self.model = WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=4)

    def decode(self, samples):
        segments, _ = self.model.transcribe(
            samples, language="de", beam_size=1, condition_on_previous_text=False, without_timestamps=True,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


def load_recognizer():
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        try:
            model = Parakeet()
            model.decode(np.zeros(RATE // 2, dtype=np.float32))
            return model
        except Exception:
            LOG.exception("Parakeet konnte nicht starten. Verwende faster-whisper.")
    model = Whisper()
    model.decode(np.zeros(RATE // 2, dtype=np.float32))
    return model
