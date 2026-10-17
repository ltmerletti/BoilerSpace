# Local retrieval experiments

For Ed and Piazza search, use the [discussion-only experiments](../discussions/README.md). The course-corpus results below contain only two discussion probes and do not establish discussion retrieval accuracy.

For the expanded 2025-2026 model runs, quantized results, and browser checks, see [Modern model results](MODERN_RESULTS.md). The original three-model comparison below remains a useful baseline, but its Granite recommendation predates those additional runs.

This branch compares BoilerSpace's existing BM25 search with small embedding models and reciprocal rank fusion (RRF), which combines keyword and semantic rankings. These models find passages; Purdue GenAI Studio still generates answers. The experiment does not change the extension's default search or add a server.

## Run it

From the repository root:

```sh
npm ci --prefix experiments/retrieval
# Public synthetic fixture; no Purdue login or private capture needed.
node experiments/retrieval/compare.mjs --fixture
```

To use your own benchmark capture and optional normalized discussion export:

```sh
node experiments/retrieval/compare.mjs \
  --capture bench/data/capture.json \
  --cases bench/data/cases.json \
  --discussions .verify-tmp/retrieval-discussions.json
```

See [the benchmark guide](../../bench/README.md) for the capture and evidence-case formats. The discussion file has the shape `{ "discussions": { "sources": [...] } }`; a BoilerSpace data export can supply that key. The local benchmark files are excluded from Git.

Try an individual lookup and inspect the citations from all three methods:

```sh
node experiments/retrieval/compare.mjs --fixture \
  --model arctic-xs-q8 --query "Where can I meet a teaching assistant on Wednesday?"
```

`--course ID` limits the lookup to one linked Brightspace course. Without it, separate discussion courses are included. `--model` accepts `granite-small-r2-q8`, `arctic-xs-q8`, or `minilm-l6-q8`; omitting it runs all three. `--out PATH` chooses the JSON report. `--reindex` rebuilds vectors. `--batch-size` defaults to 1 to limit memory use. For separate process-memory measurements, run each model in its own command.

Optional `--probes PATH` adds discussion paraphrases. Supply a JSON array of `{ "id": "...", "key": "platform:course:post", "query": "...", "quote": "exact saved evidence" }`. Missing evidence is an error, rather than a successful retrieval test.

## What runs locally

The model repositories and revisions are pinned in `compare.mjs`:

- [IBM Granite Small English R2](https://huggingface.co/ibm-granite/granite-embedding-small-english-r2): approximately 47M parameters, 384 dimensions, CLS pooling, and no query prefix. Uses the pinned ONNX Community conversion at q8; the 512-token experiment limit keeps the same short-passage setup as Arctic.
- [Snowflake Arctic Embed XS](https://huggingface.co/Snowflake/snowflake-arctic-embed-xs): approximately 22.6 million parameters, 384 dimensions, CLS pooling, and the model's prescribed query prefix. The experiment uses its q8 ONNX weights.
- [MiniLM L6 v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2): 384 dimensions and mean pooling, using the [Xenova ONNX conversion](https://huggingface.co/Xenova/all-MiniLM-L6-v2) at q8.

All three models are Apache-2.0 licensed. The runner uses pinned Transformers.js 3.8.1 with native ONNX Runtime on the CPU. First use downloads model assets from Hugging Face; passage text and queries are processed locally. Remote model loading is disabled after pipeline creation, and no remote inference endpoint is called.

Model assets and vectors are cached under `.verify-tmp/retrieval-models`. The vector key includes the text hash, model revision, pooling, token limit, runtime version, and batch size. Reports default to `bench/runs/retrieval-comparison.json`. The cache, private captures, and reports are excluded from Git. Course text or quoted names can appear in interactive terminal output; keep that output private when using a real capture.

Arctic and MiniLM weights are about 22 MiB each; Granite q8 is about 50 MiB, including its external tensor file. Tokenizer and runtime files are additional. That is a download size, not a RAM claim. Browser packaging and browser inference have not been verified; these are Node CPU experiments.

## Evaluation and results

On October 16, 2026, the models were run against the same private local capture: **3,350 documents and 4,065 passages**, including completed Ed/Piazza imports. The evaluation used **128 answerable queries**: 126 existing course-evidence cases and two discussion paraphrases. Another 43 cases had no matching passage-level quote and were excluded. The four public fixture questions only check that the runner works; they are not this evaluation.

A hit means that a returned passage contains matching source evidence. Hit@5 counts evidence within the first five passages; MRR@10 rewards placing it near the top. For a fair wider-ranking comparison, BM25-wide uses the same 50-candidate budget as semantic search. The production-style row uses the current six-result limit and relative score cutoff.

| Method | Hit@1 | Hit@5 | Hit@10 | MRR@10 |
| --- | ---: | ---: | ---: | ---: |
| BM25, production settings | 33.6% | 60.2% | 64.8%* | 0.443 |
| BM25, wider candidate pool | 33.6% | 60.2% | 73.4% | 0.454 |
| Arctic XS, semantic only | 24.2% | 58.6% | 68.8% | 0.378 |
| Arctic XS + BM25, RRF | 28.1% | 60.9% | 77.3% | 0.431 |
| MiniLM, semantic only | 27.3% | 54.7% | 64.1% | 0.395 |
| MiniLM + BM25, RRF | 29.7% | 60.9% | 71.1% | 0.423 |
| Granite Small R2, semantic only | 30.5% | 64.8% | 73.4% | 0.450 |
| Granite Small R2 + BM25, RRF | 33.6% | 66.4% | 80.5% | 0.476 |

*The production-style search returns at most six passages, so this column cannot measure a full ten-result ranking for that row.*

With one passage per indexing batch, two CPU inference threads, and CPU memory arenas disabled, initial indexing took approximately **27 seconds for Arctic** and **29 seconds for MiniLM**. Mean warm query plus vector ranking time was about **3 ms** for each on this Mac. The vectors occupied **5.95 MiB per model**. Peak total Node process RSS was approximately **343 MiB for Arctic** and **373 MiB for MiniLM**; this includes the runtime and benchmark corpus. Granite indexing took about **73 seconds**, with **5 ms** mean query time and approximately **701 MiB** peak total Node RSS. It used the same 5.95 MiB vector storage. Those timings and memory values are local measurements, not browser or low-end-device guarantees. An earlier batch-16 run used substantially more memory; its timing also included a machine suspension, so it is not used here.

These are development retrieval results, not a held-out answer-quality evaluation. Every method indexed all captured file pages; production search normally only has file text that has already been opened. A hit on one required quote does not verify every fact in a multi-part answer. Unanswerable queries and rejection thresholds need a separate evaluation. The two discussion probes are too few to establish discussion-search quality.

**Keep BM25 as the default while the browser experiment is separate.** Granite Small R2 hybrid is the strongest candidate tested here: it improves Hit@5 and MRR while retaining BM25's Hit@1. Its larger memory footprint needs browser measurements before an opt-in feature ships. Arctic hybrid improved broader recall but lowered first-result accuracy. See [Recent model research](RECENT_MODELS.md) for newer candidates and matching public benchmark comparisons.

## Why no Elasticsearch service

Elasticsearch would provide an external index, operational APIs, and additional ranking options, but it requires its own running service and memory budget. This extension currently works inside the browser and already has BM25 search. At this corpus size, a direct vector scan is sufficient for the experiment, with no vector database or background server. See Elastic's [deployment guide](https://www.elastic.co/guide/en/elastic-stack/current/installing-elastic-stack.html) and [JVM memory guidance](https://www.elastic.co/docs/reference/elasticsearch/jvm-settings).

Before an optional browser embedding feature ships, verify packaged local model/runtime assets under Manifest V3, persistent vector invalidation, inference outside the panel's UI thread, cancellation, memory on lower-end devices, and both Chrome and Firefox behavior. The current experiment makes no additional browser permission requests.
