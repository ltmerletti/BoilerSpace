# Ed and Piazza retrieval experiments

The extension now uses **POTION int8 plus BM25** for saved Ed/Piazza posts. See the [production decision, browser measurements and validation](PRODUCTION_RETRIEVAL.md). The experiments below document how that choice was evaluated.

For the 20-200 MB incremental browser-memory target, the earlier [low-RAM retrieval research](LOW_RAM_RESEARCH.md) includes the tested static SSE float16 prototype.

The expanded source-checked question bank and frozen 300-question comparison are documented in [holdout v2 results](HOLDOUT_V2_RESULTS.md) and the [pre-evaluation protocol](BENCHMARK_V2_PROTOCOL.md). It adds 30 related challenges and 12 unscored diagnostics. The larger set does not show a statistically significant completeness gain from SSE over BM25/character search. The [extended semantic comparison](EXTENDED_HOLDOUT_RESULTS.md) tests stronger q4/q8 encoders, POTION, and ColBERT candidate pools; its best observed primary completeness is 298/300, with important browser-memory and multiple-comparison qualifications.

These experiments search discussion threads and replies. They do not evaluate syllabi or course-file retrieval. Their research dependencies remain separate from the bundled production model.

The deployment target is local browser inference, 20-200 MB additional search RAM and 50 ms per warm query on student laptops. Native ONNX measurements shortlist candidates. They do not establish browser compatibility or performance. Models with 1B or 8B parameters are outside this experiment.

## Evaluation

The private capture is `.verify-tmp/retrieval-discussions.json`, with a top-level `discussions.sources` array. Each source contains its Ed or Piazza threads and replies. The private questions are `.verify-tmp/discussion-retrieval/cases.json`.

Each question labels exact answer evidence, rather than a relevant title. A question can require several replies or threads. Labels use this shape.

```json
{
  "id": "example",
  "sourceId": "ed:example-class",
  "query": "Where should I submit the assignment?",
  "history": [{"role": "user", "content": "For the data structures class"}],
  "expected": [{"threadKey": "ed:example-class:1", "messageId": "reply-1", "quote": "Use the course portal"}]
}
```

Use `messageId: "root"` for evidence in the original post. Quotes must match their labeled messages exactly. Character offsets keep labels independent of chunk size. Truncating an answer in the selected context does not count as a success.

The main measurements are top-five retrieval of at least one complete labeled span, and retrieval of **all** required spans within the final context. These measure evidence retrieval, not answer correctness. The context budget stays at 6,000 characters. The packing experiment compares caps of 6, 8, 12, and 20 chunks within that same budget.

Questions that share an expected thread stay in the same development/validation partition, including connected groups of questions requiring multiple threads. Parameters are selected on development questions. The current questions are manually authored paraphrases, so the validation partition is not an independently collected user-question test. Unanswerable questions, conflicting updates, deleted/private posts, and answer generation need separate evaluation.

Most runs supply the discussion `sourceId`. This measures search within a known class, including Piazza classes without a Brightspace course ID. `diagnostics.mjs` also searches without that filter. Neither test establishes the reliability of the assistant's course-routing tool calls.

## Run locally

From the repository root, install the isolated model runtime once.

```sh
cd experiments/retrieval/modern-js
npm ci --ignore-scripts
cd ../../..
```

Keep captures, labels, model weights, vectors, and detailed results in the ignored directories. Model inference disables remote model loading. `fetch-models.py` obtains public assets at the exact revisions in `models.json` and records their hashes. The compact reranker and ColBERT scripts also pin their public model revisions. Model weights have their own licenses.

```sh
python3 experiments/discussions/fetch-models.py
node experiments/discussions/sweep-lexical.mjs
node experiments/discussions/diagnostics.mjs
node experiments/discussions/compare-dense.mjs mxbai-xsmall-q4
node experiments/discussions/compare-dense.mjs mxbai-xsmall-q8
node experiments/discussions/compare-dense.mjs mxbai-xsmall-q4-t256
node experiments/discussions/compare-dense.mjs jina5-nano-q4
node experiments/discussions/compare-dense.mjs jina5-nano-q8
node experiments/discussions/pack-context.mjs
node experiments/discussions/compare-planning.mjs
node experiments/discussions/rerank.mjs
node experiments/discussions/compare-colbert.mjs
```

Use `--messages` with `compare-dense.mjs` for separate-message chunks with question context. Lexical sweeps also vary chunk size, overlap, paragraph boundaries, title weight, conversation history, character trigrams, synonym expansion, relevance feedback, and question splitting.

Use `--reindex` when comparing peak process memory. Cached vector replays omit document inference, and the report marks that difference.

The reranker uses the published ONNX encoder plus its pooling and dense scoring head. A public-pair parity check compared the JavaScript head with PyTorch to within `1e-5`. ColBERT uses the publisher's query/document markers, length caps, punctuation skiplist, 48-dimensional token projection, normalization, and MaxSim scoring over lexical candidates. It remains experimental.

The `mxbai-xsmall-q4-t256` variant uses the same q4 weights with a 256-token input cap. It tests memory savings without increasing the returned-context budget.

For a browser check, run the full local index in an isolated browser. External requests are blocked. Browser embeddings generate both the document index and query vectors.

```sh
node experiments/retrieval/benchmark-browser.mjs --discussions --full-index \
  --model mxbai-xsmall-q8 --browser chromium --device wasm --threads 1 \
  --out bench/runs/discussions/browser-full-mxbai-xsmall-q8-chromium.json
```

Drop `--full-index` for query-embedding compatibility and latency only. `--browser firefox` tests the Firefox runtime, if its local test binary launches. An inability to launch a test browser is an environment failure, not evidence that the model itself is incompatible.

Reports go to `bench/runs/discussions/`, which is excluded from Git. Browser memory sampling sums process RSS, including browser overhead and shared pages counted more than once. This is a conservative snapshot estimate, not a portable memory guarantee. The extension UI and answer generation are excluded from retrieval latency.

## Public regression checks

```sh
node --test tests/discussion-retrieval.test.mjs
```

These synthetic checks verify character coverage, reply attribution, strict evidence completeness, context truncation, conversation-history isolation, grouped splits, source filtering, and question interleaving. They do not require private course data or model downloads.
