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
    # The GPU is shared with the resident LLM (LM Studio often holds most of the
    # VRAM). Slice attention/VAE so a batch of portraits can't push allocation
    # over the cliff — a failed cudaMalloc there used to wedge the driver and
    # leave the sidecar answering /health "ready" while every /generate hung.
    # (guarded: the slicing helpers aren't exposed by every diffusers build)
    for enable in ("enable_attention_slicing", "enable_vae_slicing"):
        fn = getattr(pipe, enable, None)
        if callable(fn):
            try:
                fn()
            except Exception as e:
                print(f"[image] {enable} skipped: {e}", flush=True)
    _pipe = pipe
    print(f"[image] model loaded in {time.time() - t0:.1f}s on {device}", flush=True)
    STATUS["status"] = "ready"


def free_vram():
    """Release torch's cached blocks after a render so the next one reuses memory
    instead of growing the CUDA arena until it collides with the LLM."""
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

def generate(req: dict):
    global _pipe
    if _pipe is None:
        raise RuntimeError("pipeline not ready")
    import torch
    from PIL import Image

    raw_prompt = req.get("prompt", "")
    if not isinstance(raw_prompt, str):
        raise ValueError("prompt must be a string")
    prompt = raw_prompt.strip()
    if not prompt:
        raise ValueError("prompt is required")
    if len(prompt) > 2000:
        raise ValueError("prompt too long (max 2000 chars)")
    raw_negative = req.get("negative", None)
    if raw_negative is None:
        negative = (
            "worst quality, low quality, lowres, bad anatomy, bad hands, missing fingers, extra digits, "
            "fewer digits, extra limbs, mutated hands and fingers, deformed, disfigured, blurry, out of focus, "
            "ugly, duplicate, monochrome, text, watermark, signature, logo, jpeg artifacts, frame, border"
        )
    elif not isinstance(raw_negative, str):
        raise ValueError("negative must be a string")
    else:
        negative = raw_negative[:2000]
    try:
        steps = int(req.get("steps", 28))
        cfg = float(req.get("cfg", 7.0))
        width = int(req.get("width", 768))
        height = int(req.get("height", 1152))
        seed = int(req.get("seed", -1))
    except (TypeError, ValueError):
        raise ValueError("steps/cfg/width/height/seed must be numbers")
    import math
    if not 8 <= steps <= 60:
        raise ValueError("steps must be between 8 and 60")
    if not math.isfinite(cfg) or not 1 <= cfg <= 20:
        raise ValueError("cfg must be between 1 and 20")
    if (width, height) not in ((512, 512), (768, 768), (768, 1152), (1152, 768), (832, 1216), (1216, 832)):
        raise ValueError("unsupported width/height")
    if not -1 <= seed <= 2**32 - 1:
        raise ValueError("seed out of range")
    if seed < 0:
        seed = int(uuid.uuid4().int % (2**32))
    generator = torch.Generator(device="cpu").manual_seed(seed)
    t0 = time.time()
    # img2img: an optional base64 init image (character portrait ref) + strength
    init_b64 = req.get("init_image") or ""
    if init_b64 and len(init_b64) > 15 * 1024 * 1024:
        raise ValueError("init_image too large (max ~11 MB)")
    try:
        strength = float(req.get("strength", 0.6))
    except (TypeError, ValueError):
        raise ValueError("strength must be a number")
    import math as _math
    if not _math.isfinite(strength):
        raise ValueError("strength must be a number")
    kwargs = {}
    if init_b64:
        try:
            init_img = Image.open(io.BytesIO(base64.b64decode(init_b64, validate=True))).convert("RGB")
            kwargs["image"] = init_img
            kwargs["strength"] = max(0.05, min(1.0, strength))
        except Exception as e:
            raise ValueError(f"invalid init_image: {e}")
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
                try:
                    return await asyncio.to_thread(generate, body)
                finally:
                    # free cached VRAM after every render (success or failure)
                    free_vram()
        except ValueError as e:
            return JSONResponse({"error": str(e)}, status_code=400)
        except RuntimeError as e:
            return JSONResponse({"error": str(e)}, status_code=503)
        except Exception as e:
            print(f"[image] generate failed: {e}", flush=True)
            return JSONResponse({"error": "generation failed"}, status_code=500)

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