"""Prepare public SSE assets and parity probes. No private discussion data is read."""
import hashlib
import json
from pathlib import Path
from urllib.request import urlopen, urlretrieve

import torch
from safetensors.torch import load_file, save_file
from tokenizers import Tokenizer


repository = "RikkaBotan/stable-static-embedding-fast-retrieval-mrl-en-v2"
revision = "928b418b2741b7f7b1b557a53845ac88ad5054c4"
root = Path(__file__).resolve().parents[2]
directory = root / ".verify-tmp/discussion-retrieval/ram-research" / repository.replace("/", "--")
directory.mkdir(parents=True, exist_ok=True)
with urlopen(f"https://huggingface.co/api/models/{repository}/revision/{revision}?blobs=true") as response:
    metadata = json.load(response)
if metadata["sha"] != revision:
    raise ValueError("Revision mismatch")
files = {item["rfilename"]: item for item in metadata["siblings"]}
for name in ["tokenizer.json", "model.safetensors"]:
    destination = directory / name
    if not destination.exists():
        temporary = destination.with_suffix(".part")
        urlretrieve(f"https://huggingface.co/{repository}/resolve/{revision}/{name}", temporary)
        temporary.replace(destination)
    expected = files[name].get("lfs", {}).get("sha256")
    if expected and hashlib.sha256(destination.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Asset hash mismatch: {name}")
weights = load_file(str(directory / "model.safetensors"))
tokenizer = Tokenizer.from_file(str(directory / "tokenizer.json"))
for variant in ["f32", "256", "f16"]:
    if variant == "256":
        selected = {key: (value[:, :256] if key == "embedding.weight" else value[:256]).contiguous() for key, value in weights.items()}
    elif variant == "f16":
        selected = {key: value.half() if key == "embedding.weight" else value for key, value in weights.items()}
    else:
        selected = weights
    if variant != "f32":
        save_file(selected, str(directory / f"model-{variant}.safetensors"))
    probes = []
    for text in ["How do I submit an assignment?", "Can I use artificial intelligence for programming?", "The assignment is due next Friday."]:
        ids = tokenizer.encode(text, add_special_tokens=False).ids
        vector = selected["embedding.weight"][ids].float().mean(dim=0)
        vector = selected["dyt.beta"] * torch.tanh(selected["dyt.alpha"] * vector + selected["dyt.bias"])
        probes.append({"text": text, "ids": ids, "vector": torch.nn.functional.normalize(vector, dim=0).tolist()})
    name = "public-parity.json" if variant == "f32" else f"public-parity-{variant}.json"
    (directory / name).write_text(json.dumps(probes))
print(directory)
