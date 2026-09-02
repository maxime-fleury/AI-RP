#!/usr/bin/env python3
"""
Koji image generation sidecar (SD 1.5-based anime checkpoint).
Spawned by the Bun server; listens on 127.0.0.1:8770 by default.

Endpoints:
  GET  /health    -> {"status": "loading" | "ready", "device": "cuda:0"}
  POST /generate  -> {"image_base64", "seed", "ms"}

Koji v2.1 is a single-file LDM checkpoint (model.diffusion_model / first_stage_model /
cond_stage_model) whose UNet is SD 1.5-scale (859M params, cross_attention_dim=768,
no CLIP-G, no add embeddings). diffusers' StableDiffusionPipeline handles it natively.
"""
import argparse
import asyncio
import base64
import io
import os
import sys
import time
import uuid

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MODELS = os.path.join(ROOT, "models")

STATUS = {"status": "loading", "device": "cpu", "error": ""}
_pipe = None


def load_pipeline():
    global _pipe
    import torch
    from diffusers import StableDiffusionPipeline, EulerAncestralDiscreteScheduler

    device = "cuda" if torch.cuda.is_available() else "cpu"
    STATUS["device"] = device
    ckpt = os.path.join(MODELS, "koji", "koji_v21.safetensors")

    # fp16 is a CUDA-only optimisation — on CPU many ops lack Half kernels and
    # inference either errors out or crawls; keep fp32 there
    torch_dtype = torch.float16 if device == "cuda" else torch.float32
    t0 = time.time()
    pipe = StableDiffusionPipeline.from_single_file(
        ckpt,
        torch_dtype=torch_dtype,
        safety_checker=None,
        requires_safety_checker=False,
    )
    pipe.scheduler = EulerAncestralDiscreteScheduler.from_config(pipe.scheduler.config)
    pipe.to(device)
    _pipe = pipe
    print(f"[image] model loaded in {time.time() - t0:.1f}s on {device}", flush=True)
    STATUS["status"] = "ready"


def generate(req: dict):
    global _pipe
    if _pipe is None:
        raise RuntimeError("pipeline not ready")
    import torch
    from PIL import Image

    prompt = req.get("prompt", "").strip()
    negative = req.get("negative") or (
        "worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers, extra digits, "
        "fewer digits, extra limbs, mutated hands and fingers, deformed, disfigured, blurry, out of focus, "
        "ugly, duplicate, monochrome, text, watermark, signature, logo, jpeg artifacts, frame, border"
    )
    steps = int(req.get("steps", 28))
    cfg = float(req.get("cfg", 7.0))
    width = int(req.get("width", 768))
    height = int(req.get("height", 1152))
    seed = int(req.get("seed", -1))
    if seed < 0:
        seed = int(uuid.uuid4().int % (2**32))
    generator = torch.Generator(device="cpu").manual_seed(seed)
    t0 = time.time()
    # img2img: an optional base64 init image (character portrait ref) + strength
    init_b64 = req.get("init_image") or ""
    strength = float(req.get("strength", 0.6))
    kwargs = {}
    if init_b64:
        try:
            init_img = Image.open(io.BytesIO(base64.b64decode(init_b64))).convert("RGB")
            kwargs["image"] = init_img
            kwargs["strength"] = max(0.05, min(1.0, strength))
        except Exception as e:
            print(f"[image] init_image ignored: {e}", flush=True)
    image = _pipe(
        prompt=prompt,
        negative_prompt=negative,
        num_inference_steps=steps,
        guidance_scale=cfg,
        width=width,
        height=height,
        generator=generator,
        **kwargs,
    ).images[0]
    ms = int((time.time() - t0) * 1000)
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return {"image_base64": b64, "seed": seed, "ms": ms}


def main(port: int):
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse
    import uvicorn

    app = FastAPI()

    @app.get("/health")
    def health():
        return {"status": STATUS["status"], "device": STATUS["device"], "error": STATUS["error"]}

    # One pipeline, one GPU: diffusers is not thread-safe and two concurrent
    # renders would race it / double VRAM usage. Requests therefore serialize on
    # an asyncio lock while the CPU/GPU work runs off the event loop, so health
    # checks stay responsive even when a generation is queued behind another.
    gen_lock = asyncio.Lock()

    @app.post("/generate")
    async def do_generate(request: Request):
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "invalid JSON"}, status_code=400)
        if _pipe is None:
            return JSONResponse({"error": "pipeline not ready"}, status_code=503)
        try:
            async with gen_lock:
                return await asyncio.to_thread(generate, body)
        except Exception as e:
            return JSONResponse({"error": str(e)}, status_code=500)

    # load the model before serving so /health reflects readiness
    try:
        load_pipeline()
    except Exception as e:
        print(f"[image] FATAL: {e}", file=sys.stderr, flush=True)
        STATUS["status"] = "error"
        STATUS["error"] = str(e)
    print(f"[image] listening on 127.0.0.1:{port}", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8770)
    args = ap.parse_args()
    main(args.port)