# Semantic and keyword discussion retrieval

Evaluated October 16, 2026, local time. This extends the sealed 300-primary-question discussion benchmark with semantic-only systems, fixed hybrid blends, and ColBERT candidate-generation controls. It does not change production search.

## What changed in the evidence

The earlier conclusion about a small semantic gain applied to the SSE static embedder. Stronger semantic encoders improve this benchmark more substantially. BM25 remains a strong discussion baseline, and the hybrid tests support retaining both kinds of retrieval.

The older broad course-material benchmark had BM25 Hit@5 of 60.2% on 128 questions. The current discussion-only benchmark supplies the class, uses a different corpus and labels, and has BM25 Hit@5 of 94.0% on 300 questions. These percentages measure different tasks and cannot be interpreted as conflicting evaluations of the same setup.

## Fixed comparisons

All systems use the same sealed questions, source filters, user-only history, 1,000-character thread chunks, 150 overlap, and 6,000-character / 12-chunk context. Transformer hybrid weights were taken from the original 65-question development runs. SSE and POTION use equal semantic/BM25 weights and RRF k=10. No hyperparameter sweep was performed on the expanded set.

The extended plan was frozen before running these new models, after the SSE and lexical results had been observed. It is an exploratory extension, not an untouched confirmatory experiment. Public assets, inference code, cached vectors, and inputs are hash-checked. POTION inference was checked against public Python-tokenizer/NumPy-pooling references; SSE replay matched the frozen Chromium per-question ranks and completeness.

| Method | Complete labeled evidence, primary 300 | First result contains labeled evidence | Complete evidence on 30 related challenges |
| --- | ---: | ---: | ---: |
| BM25 | 289/300, 96.3% | 75.7% | 29/30 |
| BM25 + character search | 290/300, 96.7% | 75.0% | 28/30 |
| SSE float16, semantic only | 278/300, 92.7% | 61.7% | 26/30 |
| SSE float16 hybrid | 292/300, 97.3% | 69.0% | 29/30 |
| POTION 32M, semantic only | 281/300, 93.7% | 63.0% | 24/30 |
| POTION 32M hybrid | 295/300, 98.3% | 69.3% | 29/30 |
| Mixedbread xsmall q4, semantic only | 294/300, 98.0% | 72.3% | 27/30 |
| Mixedbread xsmall q4 hybrid | 296/300, 98.7% | 79.3% | 29/30 |
| Mixedbread xsmall q8, semantic only | 294/300, 98.0% | 72.7% | 27/30 |
| Mixedbread xsmall q8 hybrid | 296/300, 98.7% | 79.0% | 28/30 |
| Jina v5 Nano q4, semantic only | 297/300, 99.0% | 83.3% | 28/30 |
| Jina v5 Nano q4 hybrid | 298/300, 99.3% | 82.7% | 28/30 |
| Jina v5 Nano q8, semantic only | 297/300, 99.0% | 81.0% | 28/30 |
| Jina v5 Nano q8 hybrid | 298/300, 99.3% | 82.0% | 28/30 |
| ColBERT: keyword top 20, MaxSim ranking | 292/300, 97.3% | 82.7% | 28/30 |
| ColBERT: keyword top 20, fused with keyword ranking | 293/300, 97.7% | 80.3% | 28/30 |
| ColBERT: keyword + SSE candidate union, MaxSim ranking | 295/300, 98.3% | 82.7% | 28/30 |
| ColBERT: keyword + SSE candidate union, fused ranking | 294/300, 98.0% | 80.0% | 29/30 |

“Semantic only” means full source-scoped dense retrieval for the single-vector models. ColBERT always receives a candidate pool in these tests. “MaxSim ranking” means no final fusion with the candidate-generator ranking, not full-corpus ColBERT search. Candidate counts differ in the last four rows, so they do not isolate semantic candidate generation from reranking depth.

Jina q4 hybrid recovers nine of BM25's eleven primary misses and loses none of its successes. Mixedbread q4 hybrid recovers seven and loses none. POTION hybrid recovers eight but loses two. This complementarity supports testing a combined retriever rather than replacing keyword search wholesale. On the 75 questions with the lowest query/answer token Jaccard overlap, BM25 succeeds on 69, Mixedbread hybrids on 73, and Jina variants on 74. This is a diagnostic subset defined from the labels; it is not independent real-user validation.

The gold-selected upper bound across all methods is 299/300. It is not an executable routing policy and does not mean a fusion of every model will achieve that score. Jina's primary lead also does not extend to every challenge: it retrieves complete evidence for 28/30 related challenges versus BM25's 29/30.

## Matched candidate budgets

A follow-up plan fixed 50- and 100-candidate controls before evaluating them. All four variants use the same ColBERT model and pure MaxSim ranking. Mixed pools allocate half their initial slots to keyword results and half to SSE results, deduplicate, then fill to the same cap. These controls are exploratory because the earlier extended results were already visible.

| Candidate pool | Budget | Complete evidence | First evidence result | Candidate-pool evidence ceiling |
| --- | ---: | ---: | ---: | ---: |
| Keyword only | 50 | 293/300 | 248/300 | 296/300 |
| Keyword + semantic | 50 | 295/300 | 248/300 | 298/300 |
| Keyword only | 100 | 294/300 | 248/300 | 297/300 |
| Keyword + semantic | 100 | 295/300 | 248/300 | 299/300 |

At the same 50-candidate cap, semantic candidates add two complete-evidence successes with no regressions. At 100, they add one. The candidate ceiling tests whether all labeled evidence exists anywhere in the pool, before context selection. It is an upper bound, not returned-context accuracy. Equal-budget controls support the proposed mechanism, but their paired completeness tests are nonsignificant (p=0.5 and p=1).

## Uncertainty

Jina hybrid versus BM25 has an observed completeness difference of +3.0 percentage points, nine paired wins and zero losses, and exact McNemar p=0.00390625. The paired 95% bootstrap interval is +1.33 to +5.0 points; the source/topic cluster sensitivity interval is +1.34 to +4.76 points. However, Holm adjustment across the 17 method/BM25 comparisons gives p=0.0664. This exploratory family does not establish a corrected completeness winner at alpha 0.05.

Jina q4 hybrid first-result improvement is +7.0 points, Holm-adjusted p=0.0203 in the first-result comparison family. ColBERT MaxSim variants also improve first-result ranking, with adjusted p=0.0456. Those are different endpoints from complete evidence. Question construction, repeated facts, and conservative paragraph labels remain limitations documented in HOLDOUT_V2_RESULTS.md.

## Runtime and edge feasibility

Native query measurements include semantic encoding and search over cached document vectors. Native measurements are not browser deployment measurements. Jina q4 hybrid averaged about 20.9 ms, Mixedbread q4 hybrid 4.9 ms, and POTION hybrid 2.3 ms in these runs. The union-ColBERT timing sums measured ColBERT work and a separately measured mean SSE retrieval component; it is not a single browser wall-clock measurement. Native total peak RSS also includes asset-hash verification and setup allocations, so it is not a valid measure of additional browser search RAM.

The separate ColBERT browser characterization used ONNX Runtime Web WASM with one thread and the small tokenizer library. It built all 1,637 document token vectors in the browser and blocked external network requests. It used the original keyword-top-20 / MaxSim configuration.

- Public token IDs match native inference, including truncation. Quantized output cosine agreement is only 0.99596–0.99914, failing the strict 0.9999 numerical-parity gate. The installed native and Web runtimes are different versions (1.30.0 and 1.31.0 development). The exact cause is unresolved.
- A separately flagged diagnostic run measured the browser's own behavior rather than declaring compatibility: 293/300 complete evidence and 80.0% first-result accuracy, with one completeness disagreement from native inference.
- Mean query time was 7.86 ms, p95 10.29 ms. Building the complete token index took 38.8 seconds. The token vectors occupy 34.4 MB.
- Additional sampled browser RSS during search was about **467 MB**, above the requested 20–200 MB budget. The same browser was used to build and query the index, so retained indexing allocations are included. A separate indexing worker or more compact token index may reduce it, but that has not been established.

This ColBERT prototype is not ready for production. Jina's stronger native accuracy also does not establish a 200 MB browser implementation. The previously tested SSE float16 prototype remains the measured low-memory option at roughly 178 MB additional browser RSS, with 292/300 complete evidence on this set.

## Reproduction

All detailed reports, rankings, questions, public parity references, and plans are under the ignored `.verify-tmp/discussion-retrieval/v2/extended/` directory. The original sealed benchmark remains unchanged.

```sh
# Run prepare once to freeze the extended plan before any new model evaluation.
node experiments/discussions/evaluate-expanded.mjs prepare
node experiments/discussions/evaluate-expanded.mjs static
node experiments/discussions/evaluate-expanded.mjs mxbai-xsmall-q4
node experiments/discussions/evaluate-expanded.mjs mxbai-xsmall-q8
node experiments/discussions/evaluate-expanded.mjs jina5-nano-q4
node experiments/discussions/evaluate-expanded.mjs jina5-nano-q8
node experiments/discussions/evaluate-expanded.mjs colbert
node experiments/discussions/evaluate-expanded.mjs report

# Requires the separately frozen candidate-controls-plan.json.
node experiments/discussions/evaluate-colbert-controls.mjs

node experiments/discussions/benchmark-colbert-browser.mjs --prepare
# Strict mode currently fails numerical parity; keep that failure visible.
node experiments/discussions/benchmark-colbert-browser.mjs
# Optional characterization preserves diagnostic-only status when parity fails.
node experiments/discussions/benchmark-colbert-browser.mjs --characterize
```

All 160 unit tests pass, including the new candidate-union, MaxSim, and static-table inference checks. The strict ColBERT browser numerical-parity check fails independently of those unit tests; its diagnostic result is not a compatibility pass. No commit, push, or production retrieval change was made.
