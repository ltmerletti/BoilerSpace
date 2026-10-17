"""Local GPU embedding worker. Only public model assets are downloaded."""
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

import numpy as np
import torch
from huggingface_hub import snapshot_download
from sentence_transformers import SentenceTransformer


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--cache", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()
    # All private files, including cached vectors, are owner-readable only.
    os.umask(0o077)
    model = json.loads(args.model)
    if model["repo"].startswith("nvidia/Nemotron-"):
        model["maskMode"] = "bidirectional"
    cache = Path(args.cache).resolve()
    cache.mkdir(parents=True, exist_ok=True)
    runtime = {p: importlib.metadata.version(p) for p in
               ["torch", "transformers", "sentence-transformers", "numpy"]}
    if model["device"] == "mps" and not torch.backends.mps.is_available():
        raise RuntimeError("This run requires Metal; CPU fallback would invalidate the timing.")
    started = time.perf_counter()
    # Download data files only. Remote Python code is never implicitly executed.
    location = snapshot_download(model["repo"], revision=model["revision"],
        cache_dir=cache / "huggingface", allow_patterns=["*.json", "*.safetensors", "*.model", "*.txt", "*.jinja",
                                                     *model.get("reviewedCode", {})],
        ignore_patterns=["onnx/*", "openvino/*"])
    for filename, expected in model.get("reviewedCode", {}).items():
        if hashlib.sha256((Path(location) / filename).read_bytes()).hexdigest() != expected:
            raise RuntimeError("Reviewed model code hash mismatch: " + filename)
    download_ms = (time.perf_counter() - started) * 1000
    started = time.perf_counter()
    encoder = SentenceTransformer(location, device=model["device"], local_files_only=True,
        trust_remote_code=bool(model.get("reviewedCode")),
        model_kwargs={"dtype": torch.bfloat16, "attn_implementation": "sdpa"},
        config_kwargs={"vision_config": None, "audio_config": None} if model.get("textOnly") else {})
    if model.get("name", "").startswith("lfm"):
        from transformers.models.lfm2.modeling_lfm2 import Lfm2ShortConv
        original_slow = Lfm2ShortConv.slow_forward
        def safe_slow(self, *args, **kwargs):
            kwargs.pop("seq_idx", None)
            return original_slow(self, *args, **kwargs)
        Lfm2ShortConv.slow_forward = safe_slow
    if model.get("maskMode") == "bidirectional":
        # Ministral's generic forward builds a causal mask despite this checkpoint's
        # is_causal=false metadata. An explicit pad-only mask preserves its training setup.
        def bidirectional_mask(module, positional, kwargs):
            mask = kwargs.get("attention_mask")
            if mask is not None and mask.ndim == 2:
                length = mask.shape[-1]
                expanded = torch.zeros((mask.shape[0], 1, length, length),
                                       dtype=torch.bfloat16, device=mask.device)
                kwargs["attention_mask"] = expanded.masked_fill(~mask[:, None, None, :].bool(),
                                                               torch.finfo(torch.bfloat16).min)
            return positional, kwargs
        encoder[0].auto_model.register_forward_pre_hook(bidirectional_mask, with_kwargs=True)
        # A suffix must influence the first token in a bidirectional encoder.
        inputs = encoder.tokenizer(["A student studies course policies."], return_tensors="pt").to(model["device"])
        changed = {k: v.clone() for k, v in inputs.items()}
        text_config = encoder[0].auto_model.config.get_text_config()
        changed["input_ids"][0, -2] = (changed["input_ids"][0, -2] + 100) % text_config.vocab_size
        with torch.inference_mode():
            first = encoder[0].auto_model(**inputs, use_cache=False).last_hidden_state[0, 0].float()
            second = encoder[0].auto_model(**changed, use_cache=False).last_hidden_state[0, 0].float()
        if torch.max(torch.abs(first - second)).item() < 1e-4:
            raise RuntimeError("Bidirectional attention check failed.")
        print("Bidirectional attention check passed.", flush=True)
    encoder.max_seq_length = model["maxTokens"]
    torch.mps.synchronize()
    load_ms = (time.perf_counter() - started) * 1000
    # Private course text is read only after all remote loading has finished.
    os.environ["HF_HUB_OFFLINE"] = "1"
    dataset = json.loads(Path(args.dataset).read_text())
    signature = hashlib.sha256(json.dumps({"schema": 1, "model": model, "runtime": runtime,
        "corpusHash": dataset["report"]["corpusHash"],
        "queries": [q["query"] for q in dataset["queries"]]}, sort_keys=True).encode()).hexdigest()
    destination = cache / (model["name"] + "-" + signature)
    destination.mkdir(exist_ok=True)

    def encode(texts, prompt, batch_size):
        result = encoder.encode(texts, prompt_name=prompt, batch_size=batch_size,
            normalize_embeddings=True, convert_to_numpy=True, show_progress_bar=False)
        torch.mps.synchronize()
        result = np.asarray(result, dtype="<f4")
        if result.ndim != 2 or not np.isfinite(result).all():
            raise ValueError("Invalid embedding output")
        norms = np.linalg.norm(result, axis=1)
        if np.any(norms < 0.99) or np.any(norms > 1.01):
            raise ValueError("Embedding normalization failed")
        return result

    vector_path = destination / "documents.f32"
    dimensions = encoder.get_embedding_dimension()
    from_cache = vector_path.exists() and vector_path.stat().st_size == len(dataset["texts"]) * dimensions * 4
    index_ms = 0
    if not from_cache:
        started = time.perf_counter()
        temporary = destination / "documents.partial"
        with temporary.open("wb") as stream:
            for start in range(0, len(dataset["texts"]), model["batchSize"]):
                batch = encode(dataset["texts"][start:start + model["batchSize"]],
                               model["documentPrompt"], model["batchSize"])
                if batch.shape[1] != dimensions:
                    raise ValueError("Unexpected embedding dimensions")
                stream.write(batch.tobytes())
                if start % (model["batchSize"] * 16) == 0:
                    print(f'{model["name"]}: {min(start + model["batchSize"], len(dataset["texts"]))}/{len(dataset["texts"])} passages', flush=True)
        temporary.replace(vector_path)
        index_ms = (time.perf_counter() - started) * 1000
    latencies, queries = [], []
    # Single queries measure interactive latency independently of indexing batch size.
    for query in dataset["queries"]:
        started = time.perf_counter()
        queries.append(encode([query["query"]], model["queryPrompt"], 1))
        latencies.append((time.perf_counter() - started) * 1000)
    query_path = destination / "queries.f32"
    np.concatenate(queries).tofile(query_path)
    metadata = {**model, "runtime": runtime, "signature": signature,
        "corpusHash": dataset["report"]["corpusHash"], "dimensions": dimensions,
        "documents": str(vector_path), "queries": str(query_path), "fromCache": from_cache,
        "downloadMs": round(download_ms), "loadMs": round(load_ms), "indexMs": round(index_ms),
        "meanQueryMs": round(float(np.mean(latencies)), 2), "medianQueryMs": round(float(np.median(latencies)), 2),
        "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "mpsAllocatedBytes": torch.mps.current_allocated_memory(),
        "mpsDriverBytes": torch.mps.driver_allocated_memory()}
    Path(args.out).write_text(json.dumps(metadata, indent=2))
    print(json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
