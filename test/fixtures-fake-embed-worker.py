"""Stand-in for embed_worker.py: same protocol, no model. Used by local-embedder.test.ts."""
import json
import os
import sys

mode = os.environ.get("FAKE_WORKER_MODE", "ok")
if mode == "die-on-start":
    print("boom: cannot load model", file=sys.stderr)
    sys.exit(3)
print("a library printed this to stdout")  # must be ignored, not parsed
print(json.dumps({"ready": True, "model": "fake", "dims": 4}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    if mode == "die-on-request":
        sys.exit(4)
    if any(t == "FAIL" for t in req["texts"]):
        print(json.dumps({"id": req["id"], "error": "ValueError: bad text"}), flush=True)
        continue
    dims = req.get("dims") or 4
    tag = 1.0 if req.get("kind") == "query" else 0.0
    vecs = [[float(len(t)), tag] + [0.0] * (dims - 2) for t in req["texts"]]
    if mode == "short":
        vecs = vecs[:-1]
    print(json.dumps({"id": req["id"], "vectors": vecs}), flush=True)
