# Recent embedding models and benchmarks

Research checked on October 16, 2026. MiniLM (2021) and Arctic XS (2024) remain useful small baselines, but the first comparison should not be read as a survey of current embedding models.

## Matching benchmark columns

The [official English MTEB v2 leaderboard](https://leaderboard.mteb.org/benchmark/MTEB%28eng%2C%20v2%29) covers 41 tasks. Its overall score includes classification, clustering, semantic similarity and other tasks. The Retrieval column is the mean of its ten retrieval tasks, using nDCG@10. Retrieval scores below come from the official leaderboard API snapshot, rather than mixing old MTEB v1 scores with v2 model-card numbers.

| Model | Model generation | Parameters | English v2 overall | English v2 retrieval | Weight license |
| --- | --- | ---: | ---: | ---: | --- |
| MiniLM L6 v2 | 2021 | ~23M | 59.03 | 42.92 | Apache-2.0 |
| Arctic Embed XS | 2024 | ~23M | 59.77 | 52.65 | Apache-2.0 |
| Granite Small English R2 | 2025 | ~47M | 61.07 | 53.93 | Apache-2.0 |
| EmbeddingGemma 300M | September 2025 | ~308M | 69.67 | 55.69 | Gemma terms |
| Jina v5 Text Nano | February 2026 | 239M* | 71.11 | 58.80 | CC BY-NC 4.0 |
| Qwen3 Embedding 0.6B | June 2025 | ~596M | 70.47 | 61.83 | Apache-2.0 |

*Jina's model card reports 239M parameters, while the leaderboard metadata reports 212M. The score comparison uses the canonical model row; its parameter count needs care when estimating storage.*

The overall score and retrieval score tell different stories: Jina beats Qwen on the former, while Qwen beats Jina on the latter. Reported full-precision benchmark scores do not establish the quality of an ONNX q8 or q4 conversion.

The API used for this snapshot is documented at [MTEB's public OpenAPI schema](https://mteb-leaderboard-backend.hf.space/openapi.json): `GET /v1/benchmarks/{name}/scores`, with `name=MTEB(eng, v2)`. All six models above had all 41 task scores. Scores, model metadata, and coverage can change as the leaderboard updates.

## Candidates worth considering

**Granite Small English R2 is the most compact newer candidate validated here.** It is based on ModernBERT, retains 384-dimensional vectors, and supports 8K input tokens. The existing runner can use its ONNX conversion with the current runtime. The q8 graph and external tensors total about 50 MiB. We tested it on the same short passages as the earlier comparison, with a 512-token cap. [IBM model card](https://huggingface.co/ibm-granite/granite-embedding-small-english-r2), [ONNX conversion](https://huggingface.co/onnx-community/granite-embedding-small-english-r2-ONNX)

**EmbeddingGemma 2 is the newest substantial candidate in this shortlist.** Google released it on October 6, 2026. Its text component is 270M parameters; the advertised 740M includes separate vision and audio encoders. It is Apache-2.0 licensed. Google's model card reports 68.46 English-v2 overall and 78.68 on Code MTEB v1. The canonical model had no row in the retrieved English leaderboard snapshot, so those vendor-reported scores are kept separate from the table above. [Google release history](https://ai.google.dev/gemma/docs/releases), [model card](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)

For a text-only deployment, unused encoders must be disabled explicitly: the default feature-extraction pipeline loads all modalities. The published ONNX conversion lists about 175 MB for the q4 text model and 314 MB at q8; these are download sizes, not total runtime RAM. It also supports shorter vectors, down to 128 dimensions. The experiment's pinned Transformers.js 3.8.1 runtime does not support its `embedding_gemma2` architecture, so running it needs a separate runtime upgrade and correct query/document prefixes. The expanded experiment tests its BF16 text-only path with an isolated Transformers 5.20 runtime. Measured results are in the [benchmark summary](../discussions/README.md). [ONNX usage and selective loading](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX)

**Jina v5 Text Nano is a strong 2026 quality candidate.** Its model card dates the release to February 18 and reports 768-dimensional outputs with shorter supported dimensions. Its noncommercial weight license makes it a different distribution choice from the Apache-licensed models. The expanded experiment tests BF16, q8 and q4 variants. Its q4 native result is strong, but the tested browser CPU/WASM runtime cannot load its quantized embedding-table operator. See the [benchmark summary](../discussions/README.md). [Model card and license](https://huggingface.co/jinaai/jina-embeddings-v5-text-nano)

**Microsoft Harrier OSS 270M is another current, MIT-licensed option.** It was released in March 2026 and uses 640-dimensional vectors. Its reported 66.5 score is multilingual MTEB, not the English overall score. The English leaderboard snapshot contained only 21 of 41 task scores for the canonical model, so it is omitted from the comparable table. [Model card](https://huggingface.co/microsoft/harrier-oss-v1-270m), [leaderboard metadata](https://leaderboard.mteb.org/models/microsoft/harrier-oss-v1-270m)

**Potion / Model2Vec is a speed alternative, with a retrieval tradeoff.** The 8M model uses static embeddings and has very low computation requirements. Its own comparison reports retrieval 31.11 versus MiniLM's 42.92, even though its broader aggregate looks closer. That comparison is an older benchmark suite and is not folded into the v2 table. It does not look like the best next quality upgrade for this application. [Model card](https://huggingface.co/minishlab/potion-base-8M)

## Local Granite results

The public four-question fixture passed, followed by the same private development evaluation used for the earlier models: 3,350 documents, 4,065 passages, and 128 answerable queries. The capture and evidence labels were unchanged; the existing exclusions and evaluation limitations still apply.

| Method | Hit@1 | Hit@5 | Hit@10 | MRR@10 |
| --- | ---: | ---: | ---: | ---: |
| BM25, wider candidate pool | 33.6% | 60.2% | 73.4% | 0.454 |
| Arctic XS + BM25 | 28.1% | 60.9% | 77.3% | 0.431 |
| Granite Small R2, semantic only | 30.5% | 64.8% | 73.4% | 0.450 |
| Granite Small R2 + BM25 | 33.6% | 66.4% | 80.5% | 0.476 |

Granite hybrid found the relevant evidence within five results for eight more queries than BM25, without lowering Hit@1. Both discussion paraphrases reached its top five, but two probes are too few to establish discussion-specific quality.

Single-passage q8 CPU indexing took approximately 73 seconds; mean warm query and vector-ranking time was 5 ms. Peak total Node process RSS was approximately 701 MiB, including the runtime and corpus. That is a memory cost relative to the earlier small baselines, and it is not a browser measurement. Vectors still occupied 5.95 MiB.

Run the additional candidate from the repository root:

```sh
node experiments/retrieval/compare.mjs --model granite-small-r2-q8 \
  --probes .verify-tmp/retrieval-probes.json \
  --out bench/runs/retrieval-granite-r2.json
```

Use `--fixture` without `--probes` for a public smoke test. The optional private probes file is not committed. The actual private development report is `bench/runs/retrieval-granite-r2.json`, also excluded from Git.

## How to use RTEB

[RTEB English](https://leaderboard.mteb.org/benchmark/RTEB%28eng%2C%20beta%29) is a useful second view focused on retrieval in code, legal, finance, and healthcare tasks. Its current coverage is uneven across these models: the retrieved snapshot had 20/21 scores for Granite, 14/21 for Jina Nano, 8/21 for Qwen 0.6B, and 5/21 for Arctic XS. An overall ranking made from different subsets would be misleading.

The leaderboard's private-score column was temporarily removed in January 2026. Private tasks still exist, but a visible row should not be described as a complete independent held-out test. See the [MTEB maintainers' decision](https://github.com/embeddings-benchmark/mteb/issues/3934).

For this app, use matching English retrieval tasks to shortlist, then compare quantized models on source-grounded questions with browser latency and memory measured separately. The [benchmark summary](../discussions/README.md) collects the measured comparisons and explains the production POTION choice. Native quality and speed do not by themselves establish the browser deployment budget.
