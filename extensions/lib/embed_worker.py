"""Local embedding worker for semantic_code_search: EmbeddingGemma 2, text-only, on this machine.

Speaks JSON lines. One `{"ready": true, ...}` line on stdout once the model is loaded, then one
response line per request line on stdin:

    {"id": 1, "kind": "document" | "query", "texts": [...], "dims": 512}
    -> {"id": 1, "vectors": [[...], ...]}   or   {"id": 1, "error": "..."}

Stdout carries protocol lines only; everything else goes to stderr.

The shape of this file is mostly memory management, and each rule below was a failed run first
(measured on a 64 GB M4 Max, indexing a 4,491-chunk repository):

  * Memory per token is far higher than a 270M model suggests. Like Gemma 4, it projects every
    token once per layer. Batching 16 documents by COUNT with a 4096-token cap held 32 GB of GPU
    memory and pushed the machine into swap. So batches are sized by a TOKEN BUDGET, and the cap
    is 2048 tokens (a 120-line chunk is well under it).
  * PyTorch's MPS allocator keeps its high-water mark. Release it after wide batches, and run
    under PYTORCH_MPS_HIGH_WATERMARK_RATIO so a mistake fails instead of swapping. That ceiling
    counts every process's GPU memory, so a model server loaded next to this can use most of it:
    an out-of-memory batch is retried at half the size rather than failing the request.
  * A few files are one enormous line (one tokenised to ~37k tokens). Padded into a batch that
    overflows an MPS kernel outright. The length cap handles it.
  * float16 silently degrades this model (its card says so); float32 only.
"""

import json
import os
import sys

MODEL = os.environ.get("PI_EMBED_MODEL", "google/embeddinggemma-2")
MAX_TOKENS = 2048
CAP_CHARS = MAX_TOKENS * 4  # ~4 chars per token for code; anything past the cap is truncated anyway
BUDGET_CHARS = int(os.environ.get("PI_EMBED_BATCH_TOKENS", "4000")) * 4
MAX_BATCH = 48
NATIVE_DIMS = 768


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def send(obj):
    sys.stdout.write(json.dumps(obj, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def as_document(text):
    """`path:start-end\\nbody` (what the index stores) -> the model's titled-document format.

    The card's code-retrieval layout is `title: {filename} | text: {code}`. The line range stays
    out of the title: it is noise to the model and changes whenever code above it moves.
    """
    head, sep, body = text.partition("\n")
    if not sep:
        return f"title: none | text: {text}"
    path = head.rsplit(":", 1)[0] if ":" in head else head
    return f"title: {path} | text: {body}"


def main():
    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer

    device = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    model = SentenceTransformer(
        MODEL,
        device=device,
        config_kwargs={"vision_config": None, "audio_config": None},  # text-only: 270M
        model_kwargs={"torch_dtype": torch.float32},
    )
    model.max_seq_length = MAX_TOKENS

    def release():
        if device == "mps":
            torch.mps.empty_cache()

    def encode(batch, kind):
        if kind == "query":
            return model.encode(batch, prompt_name="CodeRetrieval", batch_size=len(batch),
                                normalize_embeddings=True, show_progress_bar=False)
        return model.encode(batch, batch_size=len(batch), normalize_embeddings=True, show_progress_bar=False)

    def encode_resilient(batch, kind):
        """Halve on out-of-memory; a single document that still does not fit is a real error."""
        try:
            return encode(batch, kind)
        except RuntimeError as exc:
            if "out of memory" not in str(exc).lower() or len(batch) == 1:
                raise
            release()
            mid = len(batch) // 2
            return np.concatenate([encode_resilient(batch[:mid], kind), encode_resilient(batch[mid:], kind)])

    def embed(texts, kind, dims):
        docs = [as_document(t) for t in texts] if kind == "document" else list(texts)
        out = np.zeros((len(docs), NATIVE_DIMS), dtype=np.float32)
        order = sorted(range(len(docs)), key=lambda i: len(docs[i]))  # ascending: last sets the width
        i = 0
        while i < len(order):
            idx = [order[i]]
            width = min(len(docs[order[i]]), CAP_CHARS)
            while i + len(idx) < len(order) and len(idx) < MAX_BATCH:
                w = min(len(docs[order[i + len(idx)]]), CAP_CHARS)
                if w * (len(idx) + 1) > BUDGET_CHARS:
                    break
                idx.append(order[i + len(idx)])
                width = w
            out[idx] = encode_resilient([docs[j] for j in idx], kind)
            i += len(idx)
            if width > 3000:
                release()
        if dims and dims < NATIVE_DIMS:
            # Matryoshka: keep the leading dimensions, then re-normalise. A sliced unit vector is
            # no longer unit length, and cosine scores are wrong until it is.
            out = out[:, :dims]
            out = out / np.maximum(np.linalg.norm(out, axis=1, keepdims=True), 1e-12)
        return out

    send({"ready": True, "model": MODEL, "device": device, "dims": NATIVE_DIMS})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            texts = req["texts"]
            if not isinstance(texts, list) or not all(isinstance(t, str) for t in texts):
                raise ValueError("texts must be a list of strings")
            kind = req.get("kind", "document")
            if kind not in ("document", "query"):
                raise ValueError(f"unknown kind {kind!r}")
            vecs = embed(texts, kind, int(req.get("dims") or NATIVE_DIMS))
            send({"id": rid, "vectors": [[round(float(x), 6) for x in row] for row in vecs]})
        except Exception as exc:  # report and keep serving; one bad request must not kill the worker
            log(f"embed_worker: request {rid} failed: {type(exc).__name__}: {exc}")
            send({"id": rid, "error": f"{type(exc).__name__}: {exc}"[:500]})
            release()


if __name__ == "__main__":
    try:
        main()
    except (KeyboardInterrupt, BrokenPipeError):
        pass
