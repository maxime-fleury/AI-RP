#!/usr/bin/env python3
"""
Breeze TTS 2 sidecar (PyTorch + CUDA).

Spawned by the Bun server; collects the streaming output of the official
breeze-tts inference runtime into a single WAV and returns it.

Endpoints:
  GET  /health                -> {"status": "loading"|"ready"|"error", "device": "cuda:0", "sample_rate": N}
  POST /generate              -> {"wav_base64", "sample_rate", "duration_ms", "ms"}
       body: {"text", "instruction", "seed"?}

Voice "presets" are just text instructions (voice design) — no reference
audio is used here, mirroring how the app exposes Breeze voices as editable
descriptions.
"""
import argparse
import base64
import io
import os
import sys
import time
import uuid
from pathlib import Path

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(ROOT, "models")
DEFAULT_MODEL = os.path.join(MODELS, "Breeze-TTS-2")

STATUS = {"status": "loading", "device": "cpu", "sample_rate": 0, "error": ""}
_runtime = None


def load_runtime(model_dir: str):
    global _runtime, STATUS
    import torch
    from breeze_infer.runtime import (
        load_runtime as _load,
        resolve_device,
        set_all_seeds,
        update_generation_config_for_breeze,
    )
    from models.fast_streaming import FastBreezeStreamingRuntime, FastStreamingConfig

    device = resolve_device()
    STATUS["device"] = device
    t0 = time.time()
    tokenizer, model, audio_tokenizer = _load(
        Path(model_dir), device=device, attn_implementation="eager"
    )
    update_generation_config_for_breeze(model)
    config = FastStreamingConfig(
        max_new_tokens=1500,
        max_seq_len=2048,
        fast_all=False,
        repetition_penalty=1.1,
    )
    runtime = FastBreezeStreamingRuntime(
        model, audio_tokenizer, config, tokenizer=tokenizer
    )
    sample_rate = runtime.sample_rate
    print(f"[breeze] model loaded in {time.time() - t0:.1f}s on {device} ({sample_rate} Hz)", flush=True)
    STATUS["sample_rate"] = sample_rate
    _runtime = {"runtime": runtime, "tokenizer": tokenizer, "audio_tokenizer": audio_tokenizer}
    STATUS["status"] = "ready"


def _wav_bytes(pcm, sample_rate: int) -> bytes:
    import numpy as np
    pcm16 = (np.clip(pcm, -1.0, 1.0) * 32767.0).astype("<i2")
    data = pcm16.tobytes()
    header = io.BytesIO()
    header.write(b"RIFF")
    header.write((36 + len(data)).to_bytes(4, "little"))
    header.write(b"WAVE")
    header.write(b"fmt ")
    header.write((16).to_bytes(4, "little"))
    header.write((1).to_bytes(2, "little"))
    header.write((1).to_bytes(2, "little"))
    header.write(sample_rate.to_bytes(4, "little"))
    header.write((sample_rate * 2).to_bytes(4, "little"))
    header.write((2).to_bytes(2, "little"))
    header.write((16).to_bytes(2, "little"))
    header.write(b"data")
    header.write(len(data).to_bytes(4, "little"))
    return header.getvalue() + data


def generate(req: dict):
    global _runtime
    if _runtime is None:
        raise RuntimeError("runtime not ready")
    import numpy as np
    from breeze_infer.templates import get_template, prepare_inputs
    from breeze_infer.runtime import set_all_seeds
    from models.stream_runtime import (
        MultiRequestStreamRuntime,
        QwenStreamRuntimeConfig,
    )  # noqa: F401  (ensures codec import path is warm)

    runtime = _runtime["runtime"]
    tokenizer = _runtime["tokenizer"]
    audio_tokenizer = _runtime["audio_tokenizer"]
    model = runtime.model

    text = (req.get("text") or "").strip()
    if not text:
        raise ValueError("empty text")
    instruction = (req.get("instruction") or "Speak clearly and naturally.").strip()
    seed = int(req.get("seed", 42))

    request_id = f"api-{uuid.uuid4().hex}"
    request = {
        "id": request_id,
        "text": text,
        "instruction": instruction,
        "speaker": "S0",
    }
    set_all_seeds(seed)
    inputs = prepare_inputs(
        tokenizer,
        audio_tokenizer,
        model,
        [request],
        get_template("tts_instruction"),
        guidance_scale=float(req.get("cfg_scale", 1.0)),
        guidance_scale_ref=None,
        guidance_scale_ins=None,
    )
    t0 = time.time()
    chunks = []
    for chunk in runtime.iter_audio_chunks(inputs, request_id=request_id):
        chunks.append(chunk.audio)
    if not chunks:
        raise RuntimeError("no audio produced")
    pcm = np.concatenate(chunks)
    ms = int((time.time() - t0) * 1000)
    sample_rate = runtime.sample_rate
    wav = _wav_bytes(pcm, sample_rate)
    return {
        "wav_base64": base64.b64encode(wav).decode("ascii"),
        "sample_rate": sample_rate,
        "duration_ms": int(round(len(pcm) / sample_rate * 1000)),
        "ms": ms,
    }


def main(port: int, model: str):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    import uvicorn

    app = FastAPI()

    @app.get("/health")
    def health():
        return STATUS

    @app.post("/generate")
    async def do_generate(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if _runtime is None:
            return JSONResponse({"error": "not ready"}, status_code=503)
        try:
            return generate(body)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    try:
        load_runtime(model)
    except Exception as e:
        print(f"[breeze] FATAL: {e}", file=sys.stderr, flush=True)
        STATUS["status"] = "error"
        STATUS["error"] = str(e)
    print(f"[breeze] listening on 127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8771)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    args = ap.parse_args()
    main(args.port, args.model)
