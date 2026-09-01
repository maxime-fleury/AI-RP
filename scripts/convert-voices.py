#!/usr/bin/env python3
"""
Download the official per-language Pocket-TTS voice states (kyutai
pocket-tts-without-voice-cloning) and convert them to the raw .bin + .json
pair format the Bun engine reads.

Usage:
  python scripts/convert-voices.py french_24l alba azelma cosette eponine fantine javert jean marius
  python scripts/convert-voices.py english_2026-04 alba azelma cosette eponine fantine javert jean marius
"""
import json
import os
import struct
import sys
import urllib.request
from pathlib import Path

import numpy as np

REPO = "kyutai/pocket-tts-without-voice-cloning"
BASE = f"https://huggingface.co/{REPO}/resolve/main/languages"
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "models" / "Pocket-tts"


def dtype_name(dtype: np.dtype) -> str:
    if dtype == np.dtype("int64"):
        return "int64"
    if dtype == np.dtype("int32"):
        return "int32"
    if dtype == np.dtype("float16"):
        return "float16"
    return "float32"


def tensor_to_bytes(arr) -> bytes:
    if arr.dtype == np.dtype("int64"):
        return struct.pack("<" + "q" * arr.size, *[int(x) for x in arr.reshape(-1)])
    if arr.dtype == np.dtype("int32"):
        return struct.pack("<" + "i" * arr.size, *[int(x) for x in arr.reshape(-1)])
    if arr.dtype == np.dtype("float16"):
        return struct.pack("<" + "e" * arr.size, *[float(x) for x in arr.reshape(-1)])
    return struct.pack("<" + "f" * arr.size, *[float(x) for x in arr.reshape(-1)])


def convert(language: str, names: list[str]) -> None:
    dest_dir = OUT / language / "voices"
    dest_dir.mkdir(parents=True, exist_ok=True)
    for name in names:
        url = f"{BASE}/{language}/embeddings/{name}.safetensors"
        safetp = dest_dir / f"{name}.safetensors"
        if not safetp.exists():
            print(f"  downloading {name} …", flush=True)
            urllib.request.urlretrieve(url, safetp)
        import safetensors  # lazy import

        blobs: list[dict] = []
        offset = 0
        with safetensors.safe_open(safetp, framework="numpy") as f:
            keys = f.keys()
            for key in sorted(keys):  # deterministic order
                module, k = key.split("/", 1)
                arr = f.get_tensor(key)
                raw = tensor_to_bytes(arr)
                blobs.append(
                    {
                        "source_key": key,
                        "name": key,
                        "module": module,
                        "key": k,
                        "dtype": dtype_name(arr.dtype),
                        "offset": offset,
                        "nbytes": len(raw),
                        "shape": list(arr.shape),
                    }
                )
                offset += len(raw)
        jsonp = dest_dir / f"{name}.json"
        binp = dest_dir / f"{name}.bin"
        jsonp.write_text(json.dumps({"tensors": blobs}, indent=2))
        with open(binp, "wb") as fh:
            with safetensors.safe_open(safetp, framework="numpy") as f:
                for b in blobs:
                    arr = f.get_tensor(b["name"])
                    fh.write(tensor_to_bytes(arr))
        (dest_dir / f"{name}.safetensors").unlink(missing_ok=True)
        print(f"  {name}: {len(blobs)} tensors, {offset} bytes", flush=True)


if __name__ == "__main__":
    language = sys.argv[1]
    names = sys.argv[2:]
    if not names:
        names = ["alba", "azelma", "cosette", "eponine", "fantine", "javert", "jean", "marius"]
    convert(language, names)
    print(f"done: {language} -> {OUT / language / 'voices'}")