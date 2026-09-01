"""Download the Breeze-TTS-2 model snapshot into the app models dir."""
import sys
from pathlib import Path

from huggingface_hub import snapshot_download

dest = Path(__file__).resolve().parent.parent.parent / "models" / "Breeze-TTS-2"
print(f"downloading to {dest}", flush=True)
try:
    snapshot_download(
        repo_id="BreezeBlue/Breeze-TTS-2",
        local_dir=str(dest),
        max_workers=8,
    )
    print("DONE", flush=True)
except Exception as e:
    print(f"ERROR: {e}", flush=True)
    sys.exit(1)
