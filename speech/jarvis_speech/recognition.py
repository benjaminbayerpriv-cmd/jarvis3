"""Silero VAD and the two local transcription engines."""

import ctypes
from pathlib import Path
import logging
import os
import platform

import numpy as np
import onnxruntime as ort

RATE = 16000
FRAME = 512
FRAME_MS = FRAME * 1000 // RATE
LOG = logging.getLogger(__name__)


def register_cuda_dlls():
    """Windows: cuBLAS liegt im pip-Paket, nicht auf PATH – vor dem Laden von ctranslate2 registrieren."""
    if platform.system() != "Windows" or not hasattr(os, "add_dll_directory"):
        return
    try:
        import nvidia.cublas.bin

        directory = Path(nvidia.cublas.bin.__file__).resolve().parent
        os.add_dll_directory(str(directory))
        # ctranslate2 ruft LoadLibrary("cublas64_12.dll") ohne User-Directory auf.
        # Ein explizites Laden legt die DLL unter diesem Namen in den Prozess.
        ctypes.WinDLL(str(directory / "cublas64_12.dll"))
    except Exception:
        LOG.debug("nvidia-cublas-Paket nicht registrierbar", exc_info=True)


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


class MlxWhisper:
    """Whisper large-v3-turbo auf der Apple-GPU (mlx-whisper). Mit fester Sprache oder eigener Spracherkennung
    (language=None): ~0,7 s für 5 s Audio mit fester Sprache, ~1,3 s mit Erkennung. Parakeet ist deutlich schneller (~0,1 s),
    rät die Sprache aber pro Äußerung selbst und verwechselt Deutsch und Englisch oft."""
    name = "mlx-whisper-large-v3-turbo"
    repo = "mlx-community/whisper-large-v3-turbo"

    def __init__(self):
        import mlx_whisper

        self.mw = mlx_whisper

    def decode(self, samples, language=None, prompt=None):
        result = self.mw.transcribe(samples, path_or_hf_repo=self.repo, language=language, temperature=0.0,
                                    condition_on_previous_text=False, initial_prompt=prompt or None)
        return result["text"].strip()


class Whisper:
    name = "faster-whisper-large-v3-turbo"

    def __init__(self, device=None, compute_type=None):
        if device == "cuda":
            register_cuda_dlls()
        from faster_whisper import WhisperModel

        if device is None:
            device, compute_type = self.preferred_device()
        self.device = device
        self.compute_type = compute_type
        options = {"device": device, "compute_type": compute_type}
        if device == "cpu":
            options["cpu_threads"] = 4
        self.model = WhisperModel("large-v3-turbo", **options)
        LOG.info("faster-whisper: %s / %s", device, compute_type)

    @staticmethod
    def preferred_device():
        """CUDA nutzen, wenn ctranslate2 ein Gerät meldet – sonst CPU mit int8."""
        try:
            register_cuda_dlls()
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                return "cuda", "int8_float16"
        except Exception:
            LOG.exception("CUDA konnte nicht abgefragt werden. Verwende die CPU.")
        return "cpu", "int8"

    def decode(self, samples, language="de", prompt=None):
        segments, _ = self.model.transcribe(
            samples, language=language, initial_prompt=prompt or None, beam_size=1, condition_on_previous_text=False, without_timestamps=True,
        )
        return " ".join(segment.text.strip() for segment in segments).strip()


def warm(model):
    """Erste Inferenz erzwingen: Sie lädt Kernel und prüft das Rechenwerk."""
    model.decode(np.zeros(RATE // 2, dtype=np.float32))
    return model


def load_accurate():
    """Genauere Erkennung mit Spracheinstellung: mlx-whisper auf dem Mac, sonst None (dann dient faster-whisper selbst)."""
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        try:
            return warm(MlxWhisper())
        except Exception:
            LOG.exception("mlx-whisper konnte nicht starten. Es bleibt bei Parakeet.")
    return None


def load_recognizer():
    if platform.system() == "Darwin" and platform.machine() == "arm64":
        try:
            return warm(Parakeet())
        except Exception:
            LOG.exception("Parakeet konnte nicht starten. Verwende faster-whisper.")
    try:
        return warm(Whisper())
    except Exception:
        LOG.exception("faster-whisper konnte nicht auf der bevorzugten Einheit starten. Verwende CPU/int8.")
        return warm(Whisper("cpu", "int8"))
