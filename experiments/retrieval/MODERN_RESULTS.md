# Modern model comparison

For the current Ed/Piazza task, see the [discussion-only experiments](../discussions/README.md). This report is a course-material reference and must not be used to select a discussion retriever.

The October 16, 2026 experiment compares newer embedding models on the same frozen course corpus used by the original MiniLM, Arctic XS, and Granite R2 runs. It does not change BoilerSpace's runtime search or add an inference service.

## Scope

Every full evaluation uses 3,350 documents, 4,065 passages, and 128 answerable questions. Of those questions, 126 have existing course-material evidence labels and two are discussion paraphrases. Another 43 cases have no matching passage-level evidence and are excluded. No model receives a different corpus or course filter.

These are development retrieval results. They do not measure answer correctness, rejection of unanswerable questions, or held-out generalization. A hit means at least one expected passage appears within the first results. It does not establish every fact in a multipart answer.

The evaluated families include Jina v5 Nano and Small, Harrier 270M and 600M, Qwen3, Nemotron 3, EmbeddingGemma 1 and 2, Perplexity Embed v1, and Liquid LFM2.5. Jina Nano and EmbeddingGemma 1 also have q4/q8 ONNX trials. The registry pins each checkpoint revision and its query/document prompts. The runners retain custom pooling and bidirectional attention behavior, including a public suffix-influence check for Nemotron and a short-convolution compatibility adjustment for Liquid.

## Main findings

| Configuration | Semantic Hit@1 | Semantic Hit@5 | Semantic Hit@10 | Semantic MRR@10 | Equal-RRF Hit@5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25 wide | 33.6% | 60.2% | 73.4% | 0.454 | n/a |
| Granite Small R2 q8 | 30.5% | 64.8% | 73.4% | 0.450 | 66.4% |
| Jina v5 Nano BF16 | 39.1% | 75.8% | 82.8% | 0.545 | 71.9% |
| Jina v5 Nano q8 | 39.1% | 75.0% | 82.8% | 0.545 | 72.7% |
| Jina v5 Nano q4 | 39.8% | 76.6% | 85.2% | 0.553 | 73.4% |
| Jina v5 Small BF16 | 35.9% | 71.1% | 82.0% | 0.509 | 69.5% |
| Harrier 270M BF16 | 27.3% | 53.1% | 65.6% | 0.395 | 61.7% |
| Harrier 600M BF16 | 33.6% | 70.3% | 78.9% | 0.488 | 69.5% |
| Qwen3 600M BF16 | 31.3% | 57.0% | 67.2% | 0.423 | 61.7% |
| Nemotron 3 1B BF16 | 45.3% | 76.6% | 85.9% | 0.591 | 75.0% |
| EmbeddingGemma 2 BF16 | 32.0% | 63.3% | 73.4% | 0.443 | 70.3% |
| EmbeddingGemma 1 q8 | 34.4% | 66.4% | 73.4% | 0.477 | 68.8% |
| EmbeddingGemma 1 q4 | 32.0% | 65.6% | 71.1% | 0.456 | 65.6% |
| Perplexity 600M BF16 | 34.4% | 65.6% | 77.3% | 0.487 | 69.5% |
| Liquid LFM2.5 350M BF16 | 35.9% | 71.1% | 81.3% | 0.506 | 75.0% |

Equal RRF uses two top-50 candidate lists, unit weights, and k=60. It can reduce quality for a strong semantic model. The newer or larger checkpoint does not always win on this corpus.

An exploratory Jina q4 sweep reproduces the proposed blend with BM25 weight 0.5, semantic weight 1, and k=20. It reaches 42.2% Hit@1, 76.6% Hit@5, 83.6% Hit@10, and MRR@10 0.566. Semantic search alone reaches 85.2% Hit@10, so the blend trades some broader recall for better first results. These settings were tuned and evaluated on the same 128 questions. A separate question set is needed before selecting them as defaults.

## Browser deployment constraints

The target is entirely client-side search, less than 1 GB of RAM, and less than 50 ms per query on student laptops. Native process results only shortlist candidates for those limits.

Jina q4's initial native ONNX trial used about 131 MiB of graph/tensor files, 688 MB peak process RSS, and 19.3 ms mean query-embedding time. A clean-install cached-vector rerun reproduced every accuracy score but averaged 37.8 ms on the same Mac during other local work. Neither timing includes vector ranking or extension UI overhead. A cached rerun also excludes corpus indexing from peak-memory measurements.

The isolated Chromium CPU/WASM test cannot create the Jina q4 or q8 inference session. The pinned browser runtime lacks a CPU implementation of `GatherBlockQuantized`, which these exports use for their embedding table. Native ONNX success does not establish browser CPU compatibility.

The Jina q4 WebGPU trial passes in a visible Chromium 145 window on the M4 Pro. Across all 128 queries, it averages 45.9 ms with a median of 44.4 ms and p95 of 58.9 ms. Its cold first query takes about 513 ms. Query vectors match native output with minimum cosine similarity above 0.99999999999. This proves that the tested WebGPU path runs; it does not establish the requested end-to-end latency or browser-memory budget. A headless Chromium run could not acquire a GPU adapter. The Firefox test launch is recorded separately and cannot be counted as a model compatibility pass.

PyTorch process RSS does not include all Metal allocations. For example, Liquid's process peak is about 932 MB, while its end-of-run Metal driver allocation is about 2.19 GB. Those unified-memory quantities overlap and must not be added, but the RSS number alone does not prove a sub-1-GB deployment. GPU reference models are not proposed for bundling into the extension.

Jina's weights use [CC BY-NC 4.0](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano-retrieval). Keep that distribution condition separate from BoilerSpace's GPLv3 code license. The model is a promising quality candidate, not an approved production default.

## Reproduce the runs

Install the optional experiment environments from the repository root. These packages are separate from the extension.

```sh
uv venv --python 3.13 .verify-tmp/retrieval-venv
uv pip install --python .verify-tmp/retrieval-venv/bin/python \
  -r experiments/retrieval/requirements-modern.txt
npm ci --prefix experiments/retrieval
npm ci --prefix experiments/retrieval/modern-js
```

Export the common dataset. Omit `--probes` if the local discussion probes are unavailable; that changes the evaluated question count and should be reported.

```sh
node experiments/retrieval/compare.mjs \
  --probes .verify-tmp/retrieval-probes.json \
  --export-dataset .verify-tmp/retrieval-modern-dataset.json
node experiments/retrieval/compare-modern.mjs --model jina5-nano-q4 \
  --out bench/runs/retrieval-jina-q4.json
node experiments/retrieval/sweep-modern.mjs --model jina5-nano-q4
```

For a public smoke test, export with `--fixture` to a separate dataset path and pass that path to `compare-modern.mjs --dataset`. Fixture results are not full benchmark results. Metadata filenames include the corpus hash so a fixture run cannot replace a full-run pointer.

Browser measurements use a loopback server only as a test fixture for cached assets. All external browser requests are blocked. The test adds no server dependency to BoilerSpace.

```sh
node experiments/retrieval/benchmark-browser.mjs --browser chromium
node experiments/retrieval/benchmark-browser.mjs --browser chromium \
  --device webgpu --headed
node experiments/retrieval/benchmark-browser.mjs --browser firefox
node experiments/retrieval/build-dashboard.mjs
```

Reports and cached vectors stay under ignored `bench/runs` and `.verify-tmp` directories. The dashboard generator embeds aggregate metrics only. It rejects mixed corpora and excludes four-question smoke tests from its leaderboard. It also keeps process RSS and Metal allocations separate.
