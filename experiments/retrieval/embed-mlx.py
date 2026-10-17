"""Qwen embedding inference using a pinned quantized MLX checkpoint on Metal."""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import time

os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
import mlx.core as mx
from mlx_lm import load
import numpy as np
from huggingface_hub import snapshot_download

parser = argparse.ArgumentParser()
for name in ["dataset", "model", "cache", "out"]:
    parser.add_argument("--" + name, required=True)
args = parser.parse_args()
os.umask(0o077)
spec = json.loads(args.model)
cache = Path(args.cache).resolve()
cache.mkdir(parents=True, exist_ok=True)
runtime = {p: importlib.metadata.version(p) for p in ["mlx", "mlx-lm", "transformers", "numpy"]}
start = time.perf_counter()
location = snapshot_download(spec["repo"], revision=spec["revision"], cache_dir=cache / "huggingface",
                             allow_patterns=["*.safetensors", "*.json", "*.txt", "*.model"])
download_ms = (time.perf_counter() - start) * 1000
start = time.perf_counter()
model, tokenizer = load(location)
mx.eval(model.parameters())
load_ms = (time.perf_counter() - start) * 1000
os.environ["HF_HUB_OFFLINE"] = "1"
dataset = json.loads(Path(args.dataset).read_text())
signature_data = {"schema": 1, "model": spec, "runtime": runtime,
    "corpusHash": dataset["report"]["corpusHash"], "queries": [q["query"] for q in dataset["queries"]]}
previous_signature = hashlib.sha256(json.dumps(signature_data, sort_keys=True).encode()).hexdigest()
signature_data.update(schema=2, indexingOrder="length-sorted")
signature = hashlib.sha256(json.dumps(signature_data, sort_keys=True).encode()).hexdigest()
destination = cache / (spec["name"] + "-" + signature)
destination.mkdir(exist_ok=True)
dimensions = spec["dimensions"]


def encode_batch(texts, prefix):
    sequences = [tokenizer.encode(prefix + text, add_special_tokens=True)[:spec["maxTokens"]] for text in texts]
    lengths = [len(ids) for ids in sequences]
    longest = max(lengths)
    ids = [tokens + [tokenizer.eos_token_id] * (longest - len(tokens)) for tokens in sequences]
    # Call the transformer body, bypassing the language-model vocabulary projection.
    # Right padding lies strictly in the causal future of every retained token.
    # Pool the last real token for each row; none can attend to the padded suffix.
    outputs = model.model(mx.array(ids))
    hidden = outputs[mx.arange(len(texts)), mx.array(lengths) - 1, :].astype(mx.float32)
    vector = hidden / mx.maximum(mx.linalg.norm(hidden, axis=-1, keepdims=True), 1e-12)
    mx.eval(vector)
    result = np.asarray(vector, dtype="<f4")
    if result.shape != (len(texts), dimensions) or not np.isfinite(result).all():
        raise ValueError("Invalid MLX embedding")
    return result


public_probes = ["A course policy about permitted assistance.", "Where are office hours?"]
batched = encode_batch(public_probes, spec["documentPrefix"])
separate = np.concatenate([encode_batch([text], spec["documentPrefix"]) for text in public_probes])
batch_cosines = (batched * separate).sum(axis=1)
if float(batch_cosines.min()) < 0.999:
    raise RuntimeError("MLX batch pooling differs from single-sequence inference.")
print(f"MLX batch equivalence passed: min cosine {batch_cosines.min():.6f}", flush=True)


documents = destination / "documents.f32"
from_cache = documents.exists() and documents.stat().st_size == len(dataset["texts"]) * dimensions * 4
index_ms = 0
resumed_documents = 0
if not from_cache:
    start = time.perf_counter()
    temporary = destination / "documents.sorted.partial"
    vectors = np.memmap(temporary, dtype="<f4", mode="w+", shape=(len(dataset["texts"]), dimensions))
    previous_partial = cache / (spec["name"] + "-" + previous_signature) / "documents.partial"
    if previous_partial.exists() and previous_partial.stat().st_size % (dimensions * 4) == 0:
        previous = np.fromfile(previous_partial, dtype="<f4").reshape(-1, dimensions)
        if len(previous) <= len(vectors) and np.isfinite(previous).all():
            resumed_documents = len(previous)
            vectors[:resumed_documents] = previous
    pending = sorted(range(resumed_documents, len(dataset["texts"])), key=lambda i:
        len(tokenizer.encode(spec["documentPrefix"] + dataset["texts"][i], add_special_tokens=True)[:spec["maxTokens"]]))
    print(f'Resumed {resumed_documents} passages; indexing the rest in length order.', flush=True)
    for start_at in range(0, len(pending), spec["batchSize"]):
        indices = pending[start_at:start_at + spec["batchSize"]]
        vectors[indices] = encode_batch([dataset["texts"][i] for i in indices], spec["documentPrefix"])
        if start_at % 256 == 0:
            print(f'{spec["name"]}: {resumed_documents + start_at + len(indices)}/{len(dataset["texts"])} passages', flush=True)
    vectors.flush()
    del vectors
    temporary.replace(documents)
    index_ms = (time.perf_counter() - start) * 1000
queries, latencies = [], []
for query in dataset["queries"]:
    start = time.perf_counter()
    queries.append(encode_batch([query["query"]], spec["queryPrefix"]))
    latencies.append((time.perf_counter() - start) * 1000)
query_file = destination / "queries.f32"
np.concatenate(queries).tofile(query_file)
metadata = {**spec, "runtime": runtime, "signature": signature,
    "corpusHash": dataset["report"]["corpusHash"], "dimensions": dimensions,
    "documents": str(documents), "queries": str(query_file), "fromCache": from_cache,
    "downloadMs": round(download_ms), "loadMs": round(load_ms), "indexMs": round(index_ms),
    "meanQueryMs": round(float(np.mean(latencies)), 2), "medianQueryMs": round(float(np.median(latencies)), 2),
    "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
    "mlxPeakBytes": mx.get_peak_memory(), "mlxActiveBytes": mx.get_active_memory()}
metadata["batchEquivalenceMinCosine"] = float(batch_cosines.min())
metadata["resumedDocuments"] = resumed_documents
metadata["indexingOrder"] = "length-sorted"
metadata["indexTimingNote"] = "Excludes any work completed before a resumed run." if resumed_documents else "Complete indexing in this run."
Path(args.out).write_text(json.dumps(metadata, indent=2))
print(json.dumps(metadata), flush=True)
