"""Whisper-compatible API for the local ChickenRice Japanese models."""

from io import BytesIO
import logging
import os
from pathlib import Path
from threading import Lock
import time

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from faster_whisper import WhisperModel, decode_audio
from faster_whisper.feature_extractor import FeatureExtractor
from faster_whisper.transcribe import restore_speech_timestamps
from faster_whisper_transwithai_chickenrice.vad_manager import get_speech_timestamps_onnx
import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parent
MODE = os.environ.get("CHICKENRICE_MODE", "asr")
if MODE not in {"asr", "translation"}:
    raise RuntimeError(f"Invalid ChickenRice mode: {MODE}")

MODEL_DIR = ROOT / "models" / (
    "chickenrice-ja-asr" if MODE == "asr" else "chickenrice-ja-audio-translation"
)
MODEL_ID = "chickenrice-ja-asr" if MODE == "asr" else "chickenrice-ja-audio-translation"
VAD_DIR = ROOT / "models" / "chickenrice-vad"
logger = logging.getLogger("uvicorn.error")
app = FastAPI(title=f"Local ChickenRice {MODE} API")
inference_lock = Lock()
whisper_model = None
vad_model = None


class ChickenRiceVad:
    frame_duration_ms = 20
    chunk_samples = 30 * 16000

    def __init__(self):
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(VAD_DIR / "whisper_vad.onnx"),
                                            sess_options=options,
                                            providers=["CPUExecutionProvider"])
        self.input_name = self.session.get_inputs()[0].name
        self.output_name = self.session.get_outputs()[0].name
        self.extractor = FeatureExtractor(feature_size=80)

    def reset_states(self):
        pass

    def audio_forward(self, audio, sampling_rate=16000):
        if sampling_rate != 16000:
            raise ValueError("VAD requires 16 kHz audio")
        probabilities = []
        for offset in range(0, len(audio), self.chunk_samples):
            window = audio[offset:offset + self.chunk_samples]
            padded = np.pad(window, (0, self.chunk_samples - len(window)))
            features = self.extractor(padded)[..., :3000][None, :, :].astype(np.float32)
            logits = self.session.run([self.output_name], {self.input_name: features})[0][0]
            probabilities.append(1 / (1 + np.exp(-logits)))
        frames = (len(audio) + 319) // 320
        return np.concatenate(probabilities)[:frames] if probabilities else np.array([])


@app.on_event("startup")
def load_model():
    global whisper_model
    if not (MODEL_DIR / "model.bin").is_file():
        raise RuntimeError(f"Model is missing: {MODEL_DIR}")
    compute_type = "bfloat16" if MODE == "asr" else "float16"
    whisper_model = WhisperModel(str(MODEL_DIR), device="cuda", compute_type=compute_type,
                                 cpu_threads=4, num_workers=1)
    logger.info("Loaded %s on AMD/HIP (%s)", MODEL_ID, compute_type)


@app.get("/health")
def health():
    return {"ready": whisper_model is not None, "model": MODEL_ID,
            "mode": MODE, "enhanced_vad_available": (VAD_DIR / "whisper_vad.onnx").is_file()}


def speech_intervals(audio):
    global vad_model
    if vad_model is None:
        vad_model = ChickenRiceVad()
    return get_speech_timestamps_onnx(
        audio, vad_model, sampling_rate=16000, threshold=0.5,
        min_speech_duration_ms=100, min_silence_duration_ms=160, speech_pad_ms=800,
        return_seconds=False,
    )


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...), model: str = Form(""), language: str = Form("ja"),
               response_format: str = Form("verbose_json"), vad_filter: bool = Form(False)):
    if model and model != MODEL_ID:
        raise HTTPException(400, f"This service only runs {MODEL_ID}")
    if language and language != "ja":
        raise HTTPException(400, "ChickenRice models only support Japanese source audio")
    if response_format not in {"json", "verbose_json"}:
        raise HTTPException(400, "Use json or verbose_json response format")
    data = file.file.read(64 * 1024 * 1024 + 1)
    if not data or len(data) > 64 * 1024 * 1024:
        raise HTTPException(400, "Audio must be between 1 byte and 64 MB")
    try:
        audio = decode_audio(BytesIO(data), sampling_rate=16000)
    except Exception as exc:
        raise HTTPException(400, f"Cannot decode audio: {exc}") from exc
    if len(audio) == 0:
        raise HTTPException(400, "Audio is empty")

    started = time.perf_counter()
    with inference_lock:
        intervals = speech_intervals(audio) if vad_filter else None
        if intervals is not None:
            logger.info("VAD retained %d intervals (%.2fs of %.2fs)", len(intervals),
                        sum(item["end"] - item["start"] for item in intervals) / 16000,
                        len(audio) / 16000)
        if vad_filter and not intervals:
            logger.info("VAD found no speech in %.2f seconds", len(audio) / 16000)
            return {"text": "", "language": "ja", "segments": []}
        speech_audio = np.concatenate([
            audio[item["start"]:item["end"]] for item in intervals
        ]) if intervals else audio
        segments, _ = whisper_model.transcribe(
            speech_audio, language="ja", task="transcribe" if MODE == "asr" else "translate",
            beam_size=5, temperature=0, condition_on_previous_text=False,
            word_timestamps=True, vad_filter=False,
        )
        if intervals:
            segments = restore_speech_timestamps(segments, intervals, 16000)
        result = [
            {"id": index, "start": round(float(segment.start), 3),
             "end": round(float(segment.end), 3), "text": segment.text.strip()}
            for index, segment in enumerate(segments) if segment.text.strip()
        ]
    logger.info("%s %.2fs audio, VAD=%s, %d segments, %.2fs processing",
                MODEL_ID, len(audio) / 16000, vad_filter, len(result), time.perf_counter() - started)
    return {"text": "".join(item["text"] for item in result), "language": "ja",
            "duration": round(len(audio) / 16000, 3), "segments": result}
