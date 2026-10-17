"""Cache pinned public assets. This script never reads discussion captures or labels."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen, urlretrieve


root = Path(__file__).resolve().parents[2]
models = json.loads((root / "experiments/discussions/models.json").read_text())
models += [
    {
        "repo": "cross-encoder/ettin-reranker-17m-v1",
        "revision": "9e4aa35321a6dd1a43ca313f500c4b4f7cfb5cc6",
        "directory": ".verify-tmp/discussion-retrieval/models/cross-encoder/ettin-reranker-17m-v1",
        "file": "onnx/model_qint8_arm64.onnx",
        "extra": ["2_Dense/model.safetensors", "3_LayerNorm/model.safetensors", "4_Dense/model.safetensors"],
    },
    {
        "repo": "mixedbread-ai/mxbai-edge-colbert-v0-17m",
        "revision": "592c6417c1c6687572043408ed1ae5196bce16b1",
        "directory": ".verify-tmp/discussion-retrieval/models/mixedbread-ai/mxbai-edge-colbert-v0-17m",
        "file": "model_int8.onnx",
        "extra": ["onnx_config.json"],
    },
]
for model in models:
    repository, revision = model["repo"], model["revision"]
    with urlopen(f"https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true") as response:
        metadata = json.load(response)
    if metadata["sha"] != revision:
        raise ValueError("Model revision mismatch")
    available = {item["rfilename"]: item for item in metadata["siblings"]}
    files = [model["file"], *model.get("extra", [])]
    files += [name for name in ["config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "config_sentence_transformers.json", "README.md", "LICENSE"] if name in available]
    # The tested exports use one external tensor file with this suffix.
    if model["file"] + "_data" in available:
        files.append(model["file"] + "_data")
    directory = root / model["directory"]
    manifest = directory / "provenance.json"
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    if previous and (previous.get("repo") != repository or previous.get("revision") != revision):
        raise ValueError(f"Cache directory belongs to another model revision: {directory}")
    provenance = dict(previous.get("files", {}))
    for name in files:
        destination = directory / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.exists():
            temporary = destination.with_suffix(destination.suffix + ".part")
            urlretrieve(f"https://huggingface.co/{repository}/resolve/{revision}/{name}", temporary)
            temporary.replace(destination)
        digest = hashlib.sha256()
        blob_digest = hashlib.sha1(f"blob {destination.stat().st_size}\0".encode())
        with destination.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
                blob_digest.update(block)
        remote = available[name]
        expected = remote.get("lfs", {}).get("sha256")
        if expected and digest.hexdigest() != expected:
            raise ValueError(f"Cached asset does not match pinned weights: {destination}")
        if not expected and remote.get("blobId") and blob_digest.hexdigest() != remote["blobId"]:
            raise ValueError(f"Cached asset does not match pinned revision: {destination}")
        provenance[name] = {"bytes": destination.stat().st_size, "sha256": digest.hexdigest()}
    manifest.write_text(json.dumps({"repo": repository, "revision": revision, "files": provenance}, indent=2))
    print(repository, model["file"], flush=True)
