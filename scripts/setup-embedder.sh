#!/bin/bash
# setup-embedder.sh — one-time setup for semantic_code_search's local embedder.
#
# Creates ~/.pi/agent/embed-venv with what extensions/lib/embed_worker.py needs,
# then downloads EmbeddingGemma 2 (about 1.5 GB) so the first search does not.
# Re-running is safe: it upgrades in place.
#
#   PI_EMBED_VENV=/some/where scripts/setup-embedder.sh   # a different location
#   (then export PI_EMBED_PYTHON=/some/where/bin/python for pi)
set -euo pipefail

VENV="${PI_EMBED_VENV:-$HOME/.pi/agent/embed-venv}"
MODEL="${PI_EMBED_MODEL:-google/embeddinggemma-2}"

if ! command -v uv >/dev/null 2>&1; then
    echo "uv is required (https://docs.astral.sh/uv/): brew install uv" >&2
    exit 1
fi

[ -x "$VENV/bin/python" ] || uv venv --python 3.12 "$VENV"
# pillow is not optional: the model's processor imports it even with the vision
# encoder switched off, and fails at load without it.
uv pip install --python "$VENV/bin/python" -U \
    "sentence-transformers[image]" transformers torch numpy pillow

echo "downloading $MODEL and checking it loads (text-only)..."
"$VENV/bin/python" - "$MODEL" <<'PY'
import sys
import torch
from sentence_transformers import SentenceTransformer

device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
m = SentenceTransformer(sys.argv[1], device=device,
                        config_kwargs={"vision_config": None, "audio_config": None},
                        model_kwargs={"torch_dtype": torch.float32})
v = m.encode(["def add(a, b): return a + b"], normalize_embeddings=True)
print(f"ok: {sys.argv[1]} on {device}, {v.shape[1]} dimensions")
PY
echo "embedder ready at $VENV"
