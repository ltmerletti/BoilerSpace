# Optional course-material research runners

The production choice and all aggregate results are in the [discussion search README](../discussions/README.md). This directory contains the earlier course-material comparison tools. They are optional development tools and are not imported by the extension.

## Public smoke test

From the repository root:

```sh
npm ci --prefix experiments/retrieval
node experiments/retrieval/compare.mjs --fixture
```

The four synthetic questions verify that the runner works. They do not reproduce the private 128-question course benchmark or the later discussion benchmark. The runner pins Granite R2, Arctic XS and MiniLM checkpoints; `--model`, `--query`, `--course`, `--reindex` and `--out` select a model, lookup, scope, rebuild and output path.

## Private benchmark reproduction

Use your own capture and evidence labels as described in the [benchmark guide](../../bench/README.md). Captures and reports stay in ignored directories. Text and queries are embedded locally; first use downloads public model assets.

```sh
node experiments/retrieval/compare.mjs \
  --capture bench/data/capture.json --cases bench/data/cases.json \
  --export-dataset .verify-tmp/retrieval-modern-dataset.json
npm ci --prefix experiments/retrieval/modern-js
node experiments/retrieval/compare-modern.mjs --model jina5-nano-q4 \
  --out bench/runs/retrieval-jina-q4.json
```

Optional `--probes PATH` adds discussion paraphrases with exact saved evidence; missing evidence is an error. Omitting the two local probes changes the historical question count. Report that difference rather than comparing unlike datasets.

The modern model registry pins revisions, prompts and backends. Python reference models use the optional `requirements-modern.txt` environment; ONNX models use `modern-js/`. Vectors, weights and reports stay under `.verify-tmp/` and `bench/runs/`. Interactive lookup output can contain private course text and should not be published.

`benchmark-browser.mjs` checks cached models in an isolated browser, blocks external requests, and distinguishes query-only probes from full-index runs. `build-dashboard.mjs` can create an optional local dashboard from complete aggregate reports. Native inference, WebGPU probes and model file sizes do not establish incremental browser RAM compliance.

[Recent model research](RECENT_MODELS.md) retains the external model-card and leaderboard sources used to shortlist candidates. Benchmark scores and the current production decision are maintained in the single discussion README.
