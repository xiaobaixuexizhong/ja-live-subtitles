"""Local Japanese and English audio to Chinese subtitle service."""

import asyncio
import audioop
import io
import json
import os
import re
import subprocess
import time
import wave
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from starlette.websockets import WebSocketDisconnect


ROOT = Path(__file__).resolve().parent
BIN = ROOT / "bin" / "whisper-1.8.4-windows-x64" / "whisper-server.exe"
MODEL = ROOT / "models" / "ggml-small.bin"
if not MODEL.is_file() or MODEL.stat().st_size != 487601967:
    MODEL = ROOT / "models" / "ggml-tiny.bin"
WHISPER_URL = "http://127.0.0.1:8766/v1/audio/transcriptions"
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434").rstrip("/")
OLLAMA_URL = f"{OLLAMA_BASE_URL}/api/chat"
TRANSLATION_MODEL = "hy-mt2:7b-q6_k"
ENGLISH_TRANSLATION_MODEL = "hy-mt2-fixed:1.8b-q8_0"
SAMPLE_RATE = 16000
MIN_CHUNK_SECONDS = 2
MAX_CHUNK_SECONDS = 10
SILENCE_SECONDS = 0.5
FRAME_BYTES = SAMPLE_RATE * 2 // 10
QUIET_RMS = 250
MAX_QUEUE = 2
TRANSLATION_BATCH_MAX_SEGMENTS = 12
TRANSLATION_BATCH_MAX_SOURCE_CHARS = 2800
TRANSLATION_MODEL_CONTEXT_TOKENS = 8192
TRANSLATION_MODEL_MIN_OUTPUT_TOKENS = 512
TRANSLATION_MODEL_MAX_OUTPUT_TOKENS = 2048
OLLAMA_KEEP_ALIVE = "30m"
OLLAMA_REQUEST_TIMEOUT_SECONDS = 90
OLLAMA_WARMUP_TIMEOUT_SECONDS = 15
OLLAMA_RETRY_DELAYS_SECONDS = (1.0, 3.0)

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"(?:chrome|chrome-extension|moz-extension|ms-browser-extension)://.*",
    allow_methods=["POST"],
    allow_headers=["Authorization", "Content-Type"],
)
whisper_process = None
translation_lock = asyncio.Lock()
subtitle_clients: set[WebSocket] = set()
latest_subtitle = None
latest_subtitle_time = 0.0


def pcm_to_wav(pcm: bytes) -> bytes:
    output = io.BytesIO()
    with wave.open(output, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(SAMPLE_RATE)
        target.writeframes(pcm)
    return output.getvalue()


def build_translation_prompt(source_text: str, context: dict) -> str:
    """Give the local model recent subtitle context without asking it to retranslate it."""
    current = str(source_text or "").strip()
    previous_source = str(context.get("previousSource") or "").strip()[-2400:]
    previous_translation = str(context.get("previousTranslation") or "").strip()[-2400:]
    if not previous_source and not previous_translation:
        return current
    lines = ["前文语境（仅供理解，不要翻译前文）："]
    if previous_source:
        lines.append(f"日文前文：{previous_source}")
    if previous_translation:
        lines.append(f"中文参考：{previous_translation}")
    lines.extend([
        "",
        "当前需要翻译的字幕（只输出这一段的中文）：",
        current,
    ])
    return "\n".join(lines)


def split_translation_segments(segments: list[dict]) -> list[list[dict]]:
    """Keep model requests small enough for context while preserving subtitle order."""
    batches: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for segment in segments:
        text = str(segment.get("text") or "").strip()
        segment_chars = len(text)
        exceeds_count = len(current) >= TRANSLATION_BATCH_MAX_SEGMENTS
        exceeds_chars = current and current_chars + segment_chars > TRANSLATION_BATCH_MAX_SOURCE_CHARS
        if current and (exceeds_count or exceeds_chars):
            batches.append(current)
            current = []
            current_chars = 0
        current.append(segment)
        current_chars += segment_chars
    if current:
        batches.append(current)
    return batches


def build_batch_translation_prompt(segments: list[dict], context: dict, source_name: str) -> str:
    """Give the model neighboring subtitles while requiring an index-preserving JSON result."""
    previous_source = str(context.get("previousSource") or "").strip()[-2400:]
    previous_translation = str(context.get("previousTranslation") or "").strip()[-2400:]
    glossary = str(context.get("glossary") or "").strip()[:4000]
    next_source = str(context.get("nextSource") or "").strip()[:2400]
    current = json.dumps([
        {"i": int(segment["i"]), "text": str(segment.get("text") or "").strip()}
        for segment in segments
    ], ensure_ascii=False)
    lines = [
        f"将当前{source_name}字幕翻译成自然、简洁的简体中文字幕。",
        '只返回合法 JSON 对象：{"items":[{"i":0,"text":"译文"}]}。',
        "items 必须与当前字幕条目数量完全一致，i 必须保持原值和顺序。",
        "只翻译当前字幕，不要翻译或重复前文语境，不要解释。",
    ]
    if previous_source or previous_translation:
        lines.append("前文语境（只用于理解指代和省略）：")
        if previous_source:
            lines.append(f"日文前文：{previous_source}")
        if previous_translation:
            lines.append(f"中文参考：{previous_translation}")
    if glossary:
        lines.append("固定术语（优先采用右侧译法）：")
        lines.append(glossary)
    if next_source:
        lines.append("后文语境（只用于理解当前字幕，不要翻译后文）：")
        lines.append(next_source)
    lines.extend([
        "当前字幕条目：",
        current,
    ])
    return "\n".join(lines)


def parse_batch_translation_response(content: str, expected_segments: list[dict]) -> list[dict]:
    """Validate model output before it reaches the extension alignment code."""
    cleaned = re.sub(r"<think>.*?</think>", "", str(content or ""), flags=re.DOTALL).strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()
    payload = json.loads(cleaned)
    raw_items = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(raw_items, list) or len(raw_items) != len(expected_segments):
        raise ValueError("translation model returned an unexpected item count")
    expected_indexes = [int(segment["i"]) for segment in expected_segments]
    items = []
    for expected_index, item in zip(expected_indexes, raw_items, strict=True):
        if not isinstance(item, dict) or item.get("i") != expected_index:
            raise ValueError("translation model returned an unexpected subtitle index")
        text = str(item.get("text") or "").strip()
        if not text:
            raise ValueError(f"empty translation for segment {expected_index}")
        items.append({"i": expected_index, "text": text})
    return items


def translation_output_tokens(segments: list[dict]) -> int:
    source_chars = sum(len(str(segment.get("text") or "")) for segment in segments)
    return max(
        TRANSLATION_MODEL_MIN_OUTPUT_TOKENS,
        min(TRANSLATION_MODEL_MAX_OUTPUT_TOKENS, max(1, source_chars) * 2),
    )


async def request_ollama_translation_batch(
    client: httpx.AsyncClient,
    model: str,
    segments: list[dict],
    context: dict,
    source_name: str,
) -> list[dict]:
    if not segments:
        return []
    last_error: Exception | None = None
    for attempt in range(len(OLLAMA_RETRY_DELAYS_SECONDS) + 1):
        try:
            response = await client.post(
                OLLAMA_URL,
                json={
                    "model": model,
                    "stream": False,
                    "messages": [
                        {
                            "role": "system",
                            "content": (
                                f"你是专业字幕翻译器。将当前{source_name}字幕翻译成自然、简洁的简体中文字幕。"
                                "只输出要求的 JSON，不要 Markdown、解释或额外字段。"
                            ),
                        },
                        {
                            "role": "user",
                            "content": build_batch_translation_prompt(segments, context, source_name),
                        },
                    ],
                    "options": {
                        "num_ctx": TRANSLATION_MODEL_CONTEXT_TOKENS,
                        "num_predict": translation_output_tokens(segments),
                        "temperature": 0.1,
                    },
                    "keep_alive": OLLAMA_KEEP_ALIVE,
                },
                timeout=OLLAMA_REQUEST_TIMEOUT_SECONDS,
            )
            response.raise_for_status()
            return parse_batch_translation_response(
                response.json().get("message", {}).get("content", ""),
                segments,
            )
        except ValueError as exc:
            # Malformed model output is handled by the split-batch fallback
            # below; repeating the same invalid response is not useful.
            last_error = exc
            break
        except httpx.HTTPError as exc:
            last_error = exc
            if not is_retryable_ollama_error(exc) or attempt >= len(OLLAMA_RETRY_DELAYS_SECONDS):
                break
            await warmup_ollama_model(client, model)
            await asyncio.sleep(OLLAMA_RETRY_DELAYS_SECONDS[attempt])

    error = last_error or RuntimeError("unknown Ollama translation failure")
    if len(segments) <= 1:
        raise ValueError(f"translation model failed for segment {segments[0]['i']}: {error}") from error
    midpoint = max(1, len(segments) // 2)
    left, right = await asyncio.gather(
        request_ollama_translation_batch(client, model, segments[:midpoint], context, source_name),
        request_ollama_translation_batch(client, model, segments[midpoint:], context, source_name),
    )
    return left + right


def is_retryable_ollama_error(error: httpx.HTTPError) -> bool:
    if isinstance(error, httpx.TimeoutException) or isinstance(error, httpx.TransportError):
        return True
    if isinstance(error, httpx.HTTPStatusError):
        status = int(error.response.status_code or 0)
        return status in (408, 425, 429) or status >= 500
    return False


async def warmup_ollama_model(client: httpx.AsyncClient, model: str) -> None:
    """Force Ollama to reload an evicted model before retrying the real request."""
    try:
        response = await client.post(
            f"{OLLAMA_BASE_URL}/api/generate",
            json={
                "model": model,
                "prompt": "",
                "stream": False,
                "keep_alive": OLLAMA_KEEP_ALIVE,
                "options": {"num_predict": 1},
            },
            timeout=OLLAMA_WARMUP_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
    except httpx.HTTPError:
        # The following translation attempt will report the useful error if
        # Ollama is still unavailable.
        return


@app.on_event("startup")
async def start_whisper():
    global whisper_process
    async with httpx.AsyncClient(timeout=2) as client:
        try:
            response = await client.get("http://127.0.0.1:8766/")
            if response.status_code < 500:
                return
        except httpx.HTTPError:
            pass
    if not BIN.is_file() or not MODEL.is_file():
        raise RuntimeError("Whisper binary or multilingual model is missing")
    whisper_process = subprocess.Popen(
        [
            str(BIN), "--host", "127.0.0.1", "--port", "8766",
            "--inference-path", "/v1/audio/transcriptions",
            "-m", str(MODEL), "-l", "ja", "-dev", "0", "-t", "4",
        ],
        cwd=ROOT,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    ready = False
    async with httpx.AsyncClient(timeout=2) as client:
        for _ in range(50):
            if whisper_process.poll() is not None:
                raise RuntimeError("Whisper server exited during startup")
            try:
                response = await client.get("http://127.0.0.1:8766/")
                if response.status_code < 500:
                    ready = True
                    break
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.2)
    if not ready:
        stop_whisper()
        raise RuntimeError("Whisper server did not become ready")
@app.on_event("shutdown")
def stop_whisper():
    if whisper_process is not None and whisper_process.poll() is None:
        whisper_process.terminate()
        try:
            whisper_process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            whisper_process.kill()


@app.get("/")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/worklet.js")
def worklet():
    return FileResponse(ROOT / "worklet.js", media_type="text/javascript")


@app.get("/health")
def health():
    try:
        asr_ready = httpx.get("http://127.0.0.1:8766/", timeout=2).status_code < 500
    except httpx.HTTPError:
        asr_ready = False
    try:
        ollama_ready = httpx.get(f"{OLLAMA_BASE_URL}/api/tags", timeout=2).status_code < 500
    except httpx.HTTPError:
        ollama_ready = False
    return {
        "ready": asr_ready and ollama_ready,
        "asr_model": MODEL.name,
        "translation_models": [TRANSLATION_MODEL, ENGLISH_TRANSLATION_MODEL],
        "asr_ready": asr_ready,
        "translation_ready": ollama_ready,
    }


@app.post("/v1/chat/completions")
async def translate_subtitle_batch(body: dict):
    """Bridge the extension's batch format to a selected local translation model."""
    model = str(body.get("model") or TRANSLATION_MODEL).strip()
    if not re.fullmatch(r"[A-Za-z0-9_./:-]{1,120}", model):
        raise HTTPException(400, "invalid local translation model name")
    messages = body.get("messages")
    if not isinstance(messages, list):
        raise HTTPException(400, "messages must be an array")
    user_message = next((item for item in reversed(messages)
                         if isinstance(item, dict) and item.get("role") == "user"), None)
    try:
        request = json.loads(user_message["content"])
        segments = request["segments"]
        context = request.get("context") or {}
        source_language = str(context.get("sourceLanguage") or "").lower()
        if source_language not in ("ja", "en"):
            source_language = "en" if model == ENGLISH_TRANSLATION_MODEL else "ja"
        source_name = "英语" if source_language == "en" else "日语"
        if request["targetLanguage"]["code"] != "zh-CN":
            raise ValueError("target language must be zh-CN")
        if not isinstance(segments, list) or not 1 <= len(segments) <= 60:
            raise ValueError("segments must contain 1 to 60 items")
        if any(not isinstance(item, dict) or item.get("i") != index or
               not isinstance(item.get("text"), str) or len(item["text"]) > 1000
               for index, item in enumerate(segments)):
            raise ValueError("segments must have ordered indices and text")
    except (TypeError, KeyError, ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(400, f"invalid subtitle batch: {exc}") from exc

    items = []
    try:
        async with translation_lock:
            async with httpx.AsyncClient(timeout=90) as client:
                for batch in split_translation_segments(segments):
                    non_empty = [segment for segment in batch if segment["text"].strip()]
                    empty = [{"i": int(segment["i"]), "text": ""} for segment in batch if not segment["text"].strip()]
                    translated = await request_ollama_translation_batch(
                        client,
                        model,
                        non_empty,
                        context,
                        source_name,
                    ) if non_empty else []
                    items.extend(translated + empty)
                items.sort(key=lambda item: int(item["i"]))
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(502, f"local translation failed: {exc}") from exc

    return {
        "id": "chatcmpl-local-subtitles",
        "object": "chat.completion",
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": json.dumps({"items": items}, ensure_ascii=False)}, "finish_reason": "stop"}],
    }


async def transcribe_and_translate(client: httpx.AsyncClient, pcm: bytes) -> tuple[str, str, int, int]:
    if audioop.rms(pcm, 2) < 180:
        return "", "", 0, 0
    started = time.perf_counter()
    response = await client.post(
        WHISPER_URL,
        files={"file": ("clip.wav", pcm_to_wav(pcm), "audio/wav")},
        data={"response_format": "json", "language": "ja"},
        timeout=45,
    )
    response.raise_for_status()
    japanese = response.json().get("text", "").strip()
    asr_ms = round((time.perf_counter() - started) * 1000)
    if not japanese:
        return "", "", asr_ms, 0
    started = time.perf_counter()
    response = await client.post(
        OLLAMA_URL,
        json={
            "model": TRANSLATION_MODEL,
            "stream": False,
            "messages": [
                {"role": "system", "content": "将日语翻译为简体中文。只输出中文译文，不要解释。"},
                {"role": "user", "content": japanese},
            ],
            "options": {
                "num_ctx": TRANSLATION_MODEL_CONTEXT_TOKENS,
                "num_predict": max(
                    TRANSLATION_MODEL_MIN_OUTPUT_TOKENS,
                    min(TRANSLATION_MODEL_MAX_OUTPUT_TOKENS, len(japanese) * 3),
                ),
                "temperature": 0.1,
            },
            "keep_alive": "30m",
        },
        timeout=45,
    )
    response.raise_for_status()
    chinese = response.json().get("message", {}).get("content", "").strip()
    chinese = re.sub(r"<think>.*?</think>", "", chinese, flags=re.DOTALL).strip()
    return japanese, chinese, asr_ms, round((time.perf_counter() - started) * 1000)


async def broadcast(message: dict):
    for client in tuple(subtitle_clients):
        try:
            await client.send_json(message)
        except (RuntimeError, WebSocketDisconnect):
            subtitle_clients.discard(client)


@app.websocket("/subtitles")
async def subtitle_socket(ws: WebSocket):
    origin = ws.headers.get("origin", "")
    if origin and not origin.startswith("chrome-extension://"):
        await ws.close(code=1008)
        return
    await ws.accept()
    subtitle_clients.add(ws)
    try:
        if latest_subtitle and time.monotonic() - latest_subtitle_time < 7:
            await ws.send_json(latest_subtitle)
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        subtitle_clients.discard(ws)


@app.websocket("/ws")
async def audio_socket(ws: WebSocket):
    global latest_subtitle, latest_subtitle_time
    await ws.accept()
    queue: asyncio.Queue[tuple[float, bytes] | None] = asyncio.Queue(MAX_QUEUE)
    pending = bytearray()
    received_samples = 0
    quiet_samples = 0

    def enqueue_chunk():
        nonlocal received_samples, quiet_samples
        chunk = bytes(pending)
        pending.clear()
        start = received_samples / SAMPLE_RATE
        received_samples += len(chunk) // 2
        quiet_samples = 0
        if queue.full():
            queue.get_nowait()
        queue.put_nowait((start, chunk))

    async def worker():
        global latest_subtitle, latest_subtitle_time
        async with httpx.AsyncClient() as client:
            while True:
                item = await queue.get()
                if item is None:
                    return
                start, pcm = item
                try:
                    japanese, chinese, asr_ms, mt_ms = await transcribe_and_translate(client, pcm)
                    if chinese:
                        subtitle = {
                            "type": "subtitle", "start": start,
                            "end": start + len(pcm) / (SAMPLE_RATE * 2),
                            "ja": japanese, "zh": chinese,
                            "asr_ms": asr_ms, "mt_ms": mt_ms,
                        }
                        latest_subtitle = subtitle
                        latest_subtitle_time = time.monotonic()
                        await ws.send_json(subtitle)
                        await broadcast(subtitle)
                except (httpx.HTTPError, ValueError, KeyError) as exc:
                    await ws.send_json({"type": "error", "message": str(exc)})

    task = asyncio.create_task(worker())
    try:
        await ws.send_json({"type": "ready", "max_chunk_seconds": MAX_CHUNK_SECONDS})
        while True:
            pcm = await ws.receive_bytes()
            for offset in range(0, len(pcm), FRAME_BYTES):
                frame = pcm[offset:offset + FRAME_BYTES]
                pending.extend(frame)
                quiet_samples = quiet_samples + len(frame) // 2 if audioop.rms(frame, 2) < QUIET_RMS else 0
                seconds = len(pending) / (SAMPLE_RATE * 2)
                if seconds >= MAX_CHUNK_SECONDS or (
                    seconds >= MIN_CHUNK_SECONDS and quiet_samples >= SILENCE_SECONDS * SAMPLE_RATE
                ):
                    enqueue_chunk()
    except WebSocketDisconnect:
        pass
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
        latest_subtitle = None
        await broadcast({"type": "clear"})
