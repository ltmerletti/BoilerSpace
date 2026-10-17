# Discussion search and benchmark results

BoilerSpace uses **POTION retrieval 32M, compressed to int8, plus BM25** to search saved Ed and Piazza posts. It runs locally in a browser worker and needs no GPU, model account, model download or search server. Other course material retains its existing keyword search.

The production choice, measurements, comparisons and reproduction steps are collected here. [results.json](results.json) contains the public aggregate scores. Raw course posts, questions, expected answers, per-question reports and model research caches stay out of Git.

## Production choice

POTION int8 plus BM25 retrieved complete labeled evidence for **295 of 300 main questions (98.3%)** and **29 of 30 related challenges**. Replays through the actual extension tool in Chromium and Zen's Firefox engine returned the same evidence coverage. BM25 alone reached 289/300 on the same main questions.

The implementation fits the measured 20-200 MB additional search RAM target and the 50 ms warm-query target. The int8 weights occupy 32.6 MB; weights, tokenizer and tokenizer code together occupy about 34.1 MB before compression. Float16 retained the same complete-evidence score but used more memory. Model hashes and the conversion are in [the bundled model's provenance](../../extension/vendor/potion/PROVENANCE.md). The model uses MIT and the tokenizer uses Apache-2.0; their notices travel with the extension.

| Browser | Additional search RSS | Warm search p95 | Cold first search |
| --- | ---: | ---: | ---: |
| Chromium | 153.1-153.4 MB, two fresh runs | 0.7-0.8 ms | About 0.4 seconds |
| Zen 1.23.2b / Firefox engine | 102.2 MB | 2 ms | About 1.2 seconds |

These are local measurements, not limits guaranteed for every device or corpus size. RAM is the process-RSS increase after the same browser has loaded the raw corpus and BM25 index. It includes the model, tokenizer, worker index, vectors and query work. RSS can count shared pages more than once. Firefox's baseline was taken after startup settled, with normal process preloading retained. Cold startup includes integrity checking and indexing; warm search excludes LLM answer generation.

Search fuses the top 50 semantic and keyword candidates with equal-weight reciprocal rank fusion, k=10. Thread passages have at most 1,000 characters and overlap by 150. Ask receives at most 6,000 characters across twelve discussion passages, with original post links and available author-role labels. It can open the thread for more context.

The answering model uses the existing tools; POTION runs inside the search tool, rather than generating answers:

1. `list_discussions` identifies connected classes, their `source_id`, and import coverage. The system prompt also lists connected source IDs, so a model can search directly when the class is clear.
2. `search_course_material(query, source_id)` runs POTION plus BM25 over that class's saved public posts and replies. Each matching passage includes a `discussion_key` and `read_targets` pointing to the relevant post or reply and text offset.
3. `read_discussion(discussion_key, reply_id?, offset?, reply_offset?)` opens the evidence with author roles and stable citations. Post and reply text pages contain up to 12,000 characters; follow `next_offset` to continue. The reply list returns thirty 300-character previews per page; follow `next_reply_offset` to see more, or use a search result's pointer to open a later reply directly.
4. The answering model reads the evidence and returns its answer with links to the original Ed or Piazza post. Student replies and instructor replies remain distinguishable.

Capture preserves all public message text and available nested replies returned by the sites. Older captures are reread on the next full sync to recover text previously clipped by the beta's limits. Paging bounds each tool response without dropping the rest of a saved thread.

The worker reuses its index and terminates after 60 seconds idle or when its panel page unloads. Changed posts, replies, course links and disconnects invalidate cached evidence. Failed model loads, worker errors and ten-second stalls fall back to scoped BM25 with an explicit note. Failed workers terminate; later searches retry after a 30-second backoff. Search creates no separate persistent vector database or query log.

## What the benchmark measures

The frozen discussion corpus contains **1,448 threads and 1,637 passages** from two Ed classes and one Piazza class. There are 300 main questions on 300 previously unused evidence threads, 20 follow-ups, ten two-thread questions, and twelve unscored ambiguity/unsupported diagnostics. Main questions cover programming symptoms, false premises, policy exceptions, temporal qualifications, comparisons, procedures and paraphrases.

Each answerable question labels exact staff evidence in an original post or reply. A complete-evidence success requires every labeled span to reach the final bounded context. The benchmark supplies the correct discussion class and uses only user history. It does not measure the assistant's class selection, final-answer accuracy, resolution of contradictory updates or abstention on unsupported questions.

The questions are source-checked and assistant-authored, without independent human annotation. They are a purposive sample, not actual student traffic. Distinct threads can repeat facts; a sensitivity analysis uses 80 source/topic groups. Exact-span scoring can reject a useful partial answer or equivalent unlabeled duplicate. Related challenges are reported separately.

The original SSE/comparator configuration was sealed before evaluation. Later model comparisons and production selection were exploratory after earlier results were visible. Quantization uses only public weights, without calibration on private course text. The unchanged [frozen methodology](BENCHMARK_V2_PROTOCOL.md) remains available for hash-based reproduction.

## Discussion results

All rows use the same 300 main questions, 30 related challenges, class filter and context budget. "First" means the first result contains labeled evidence. "Complete" requires all evidence in the returned context. Full Hit@1/5/10, MRR, low-keyword-overlap results and paired comparisons are in [results.json](results.json).

<!-- discussion-results:start -->
| Method | Complete, main 300 | First | Complete, challenges |
| --- | ---: | ---: | ---: |
| **POTION int8 + BM25 (production)** | 295/300 (98.3%) | 69.7% | 29/30 |
| BM25 | 289/300 (96.3%) | 75.7% | 29/30 |
| BM25 + character trigrams | 290/300 (96.7%) | 75.0% | 28/30 |
| SSE float16, semantic only | 278/300 (92.7%) | 61.7% | 26/30 |
| SSE float16 + BM25 | 292/300 (97.3%) | 69.0% | 29/30 |
| POTION float32, semantic only | 281/300 (93.7%) | 63.0% | 24/30 |
| POTION float32 + BM25 | 295/300 (98.3%) | 69.3% | 29/30 |
| Mixedbread xsmall q4, semantic only | 294/300 (98.0%) | 72.3% | 27/30 |
| Mixedbread xsmall q4, hybrid | 296/300 (98.7%) | 79.3% | 29/30 |
| Mixedbread xsmall q8, semantic only | 294/300 (98.0%) | 72.7% | 27/30 |
| Mixedbread xsmall q8, hybrid | 296/300 (98.7%) | 79.0% | 28/30 |
| Jina v5 Nano q4, semantic only | 297/300 (99.0%) | 83.3% | 28/30 |
| Jina v5 Nano q4, hybrid | 298/300 (99.3%) | 82.7% | 28/30 |
| Jina v5 Nano q8, semantic only | 297/300 (99.0%) | 81.0% | 28/30 |
| Jina v5 Nano q8, hybrid | 298/300 (99.3%) | 82.0% | 28/30 |
| ColBERT keyword 20, MaxSim | 292/300 (97.3%) | 82.7% | 28/30 |
| ColBERT keyword 20, fused | 293/300 (97.7%) | 80.3% | 28/30 |
| ColBERT keyword + SSE, MaxSim | 295/300 (98.3%) | 82.7% | 28/30 |
| ColBERT keyword + SSE, fused | 294/300 (98.0%) | 80.0% | 29/30 |
| POTION float16 + BM25 | 295/300 (98.3%) | 69.3% | 29/30 |
<!-- discussion-results:end -->

Semantic-only encoders search the full class. ColBERT reranks candidates: "keyword 20" uses twenty lexical candidates; "keyword + SSE" unions up to fifty from each retriever. Transformer hybrids use their earlier development-selected BM25/character blend; SSE and POTION hybrids use equal semantic/BM25 weights and k=10.

Larger models have higher native quality scores in some comparisons, but those scores do not demonstrate a browser implementation within the RAM budget. The ColBERT browser prototype used about 467 MB additional RSS and failed the strict numerical-parity gate (cosine 0.99596-0.99914 versus a 0.9999 threshold). Its diagnostic 293/300 browser result is not a compatibility pass. Jina q4's browser CPU path could not load the tested quantized embedding operator; its WebGPU path does not establish the RAM target.

POTION trades some first-result ranking for broader evidence coverage: BM25 ranks the first answer better, so Ask must inspect several candidates. Five main questions and one challenge still miss complete evidence. The observed 98.3% is retrieval coverage on this bank, not correct-answer accuracy or a prediction for future traffic.

<details>
<summary>Candidate-budget controls and statistical checks</summary>

These ColBERT controls hold the candidate count fixed and use MaxSim ranking without final fusion. Mixed pools allocate half their initial slots to keyword candidates and half to SSE, deduplicate, then fill to the same cap.

| Candidates | Count | Complete evidence | First evidence | Candidate evidence ceiling |
| --- | ---: | ---: | ---: | ---: |
| Keyword | 50 | 293/300 | 248/300 | 296/300 |
| Keyword + semantic | 50 | 295/300 | 248/300 | 298/300 |
| Keyword | 100 | 294/300 | 248/300 | 297/300 |
| Keyword + semantic | 100 | 295/300 | 248/300 | 299/300 |

Semantic candidates recover some lexical misses at a matched budget, but paired completeness tests are nonsignificant (p=0.5 at fifty and p=1 at one hundred). The ceiling counts evidence anywhere in the pool, not in the returned context.

The prespecified SSE versus BM25/character contrast was 292 versus 290 successes, exact McNemar p=0.7266. Later Jina q4 hybrid versus BM25 improved completeness by three points (nine wins, no losses); raw p=0.00391 becomes 0.0664 after Holm correction across seventeen comparisons. Its first-result improvement has adjusted p=0.0203. These exploratory comparisons do not establish a corrected completeness winner. A gold-selected union ceiling of 299/300 is not an executable retrieval policy.

</details>

<details>
<summary>Earlier 65-question development checks</summary>

The earlier bank had 39 development and 26 validation questions, with shared evidence kept in one split. These checks helped select configurations; they are not independent confirmation of the later result.

SSE 512D float32 used 234-236 MB additional browser RSS. A 256D float32 prefix used about 173 MB, and 512D float16 used 176-177 MB. Each retrieved complete evidence for 64/65 questions. First-result coverage was 47/65 for both 512D variants and 45/65 for 256D. On the later 300-question bank, SSE float16 reached 292/300 at about 178.5 MB additional RSS, mean 1.51 ms and p95 2.40 ms.

The aggregate file also retains earlier Mixedbread q4/q8, 256-token cap, message-level chunking, Jina q4/q8 and SSE scores. Chunk sizes, overlap, title weights, character trigrams, query expansion, context packing and reranking were explored on the development bank. Production uses the fixed settings stated above.

</details>

<details>
<summary>Earlier course-material benchmark</summary>

This separate development benchmark used **3,350 documents, 4,065 passages and 128 answerable questions**, with 43 questions excluded because their passage labels did not match. Only two questions were discussion probes. Its scores do not establish Ed/Piazza accuracy and must not be compared directly with the discussion table.

<!-- course-results:start -->
| Configuration | Semantic Hit@1 | Hit@5 | Hit@10 | MRR@10 | Hybrid Hit@5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| BM25 wide | 33.6% | 60.2% | 73.4% | 0.454 | n/a |
| jina5-nano-bf16 | 39.1% | 75.8% | 82.8% | 0.545 | 71.9% |
| jina5-small-bf16 | 35.9% | 71.1% | 82.0% | 0.509 | 69.5% |
| harrier-270m-bf16 | 27.3% | 53.1% | 65.6% | 0.395 | 61.7% |
| harrier-600m-bf16 | 33.6% | 70.3% | 78.9% | 0.488 | 69.5% |
| qwen3-600m-bf16 | 31.3% | 57.0% | 67.2% | 0.423 | 61.7% |
| nemotron3-1b-bf16 | 45.3% | 76.6% | 85.9% | 0.591 | 75.0% |
| gemma2-bf16 | 32.0% | 63.3% | 73.4% | 0.443 | 70.3% |
| pplx-600m-bf16 | 34.4% | 65.6% | 77.3% | 0.487 | 69.5% |
| lfm25-350m-bf16 | 35.9% | 71.1% | 81.3% | 0.506 | 75.0% |
| gemma1-q8 | 34.4% | 66.4% | 73.4% | 0.477 | 68.8% |
| gemma1-q4 | 32.0% | 65.6% | 71.1% | 0.456 | 65.6% |
| jina5-nano-q8 | 39.1% | 75.0% | 82.8% | 0.545 | 72.7% |
| jina5-nano-q4 | 39.8% | 76.6% | 85.2% | 0.553 | 73.4% |
| granite-small-r2-q8 | 30.5% | 64.8% | 73.4% | 0.450 | 66.4% |
| arctic-xs-q8 | 24.2% | 58.6% | 68.8% | 0.378 | 60.9% |
| minilm-l6-q8 | 27.3% | 54.7% | 64.1% | 0.395 | 60.9% |
<!-- course-results:end -->

Hybrid results here use equal-weight RRF, k=60. An exploratory weighted Jina q4 blend (BM25 0.5, semantic 1, k=20) reached 42.2% Hit@1, 76.6% Hit@5 and MRR 0.566 on the same questions used to tune it. Large native models were quality references, not edge deployment choices. Four-question smoke tests and unavailable full runs are excluded.

Native process RSS is not incremental browser RAM. The visible Jina q4 WebGPU query probe averaged 45.9 ms, p95 58.9 ms; it did not establish a 50 ms end-to-end limit or the browser RAM target. Metal allocations overlap unified-memory RSS and must not be added to it. Jina's noncommercial weight license differs from the bundled POTION model's MIT license.

</details>

## Tests and merge readiness

The branch passed **206 unit tests**, **76 interface checks** and **27 chat streaming/control checks** locally on October 17, 2026. Streaming checks include multiple narration/tool rounds, folding narration when the final answer starts, pointer clicks held across streamed tokens, saved activity after reopening the panel, and recovery from Purdue’s explicit HTTP 400 rate-limit response. Seven additional synthetic checks passed in Zen for narration timing, live disclosure toggles and the thinking control. Interface checks also cover quiet background refreshes and recovery from saved-data read failures. Piazza reader tests verify reuse of class URLs with trailing slashes, retention of user-owned tabs, and inactive temporary readers.

CI covers Node 22/24 units, Chromium UI, incremental chat streaming, syllabus and discussion integration, restart/offline recovery, and retrieval-worker checks in Chromium and Firefox. The full 330-case extension-tool replay passed in Chromium and Zen. Live-site verification is separate from the credential-free CI fixtures.

A fresh signed-in Zen 1.23.3b profile completed both Ed histories (157 and 365 public posts) and the Piazza history (931 posts). A real Ask question for each source returned the expected original-site citation, and the model generated short chat titles. Native site prompts were approved by the account holder. Firefox now registers its waking listeners synchronously and returns a native message promise; short import batches preserve progress in throttled tabs. These checks use one account, not an independent multi-student sample.

A frozen **40-question Qwen3.8:27b answer check** adds thirty primary questions, four follow-up or multi-thread challenges, and six clarification or abstention probes. It uses a later saved snapshot of 1,452 public threads, separate from the 1,448-thread retrieval corpus. Selection was deterministic and balanced across the three discussion sources before answer generation. The corpus and exact source quotes were checked locally. Private prompts, posts, answers and per-case review remain outside Git.

| Answer check | Core answer correctness | Probe intent |
| --- | ---: | ---: |
| Initial full run | 32/34 | 6/6 |
| Full rerun after fixes | 33/34 | 6/6 |
| Targeted retest of the remaining failure | 1/1 | n/a |
| Final complete streamed release run | 34/34 | 6/6 |

Live import progress was incorrectly invalidating searches, and a real post change could be mistaken for an empty search. Search now ignores bookkeeping-only changes; an evidence change triggers one fresh Ask attempt without duplicating the question. The remaining case passed a targeted retest. The final release row was subsequently evaluated as a complete run of all forty unchanged questions, rather than combining targeted retests. One answer also incorrectly described a complete code template as truncated; a complete-message instruction corrected it on rerun.

Manual review accepted source-supported equivalent evidence and recorded a gold-label polarity error without changing the frozen bank. The final release run had no tool or unhandled provider errors. It used an isolated disposable extension profile, the frozen corpus and question hashes, streamed Qwen3.8:27b answers, and a five-second gap between questions. Earlier attempts in the shared test profile were disrupted by a scheduled sync or shared-account throttling; those reports are retained privately and are not treated as clean final runs. Purdue also returns explicit rate limits as HTTP 400, so requests now retry those responses as well as HTTP 429, honor Retry-After, and allow cancellation during backoff.

Core correctness and probe intent do not mean every sentence was grounded. A numeric-age answer still added an uncited causal explanation, an ambiguous-policy clarification remained verbose, and a future-exam answer confused semester scope and volunteered unrelated information. Source-grounding instructions reduce these behaviors but do not eliminate them. All answer reviews are assistant-authored, not independent human annotation; repeated runs of the same bank do not establish population accuracy.

Regression checks cover asset hashes, evidence budgets, class isolation, edited/deleted posts, disconnects, worker reuse, idle release, timeouts, retry backoff, corrupted-model fallback, sync recovery and Ask citations. Long-thread checks cover more than 100 replies, deep nesting, text beyond 40,000 characters, direct search-to-reply pointers, continuation without gaps, and one-time refresh of older captures. The synthetic Ask flow exercises source selection, reply-list paging, long-reply continuation and original-post citations for Ed, plus an unlinked Piazza class. CI uses synthetic sites without Purdue credentials; live-site verification is separate.

**Public-text discussion retrieval is released without the beta label.** The final 330-case replay matched the production scores in Chromium and Zen: 295/300 primary questions and 29/30 challenges. Real refreshes in both signed-in test profiles completed all three available histories without source errors. Live verification still uses one account; an independent multi-student trial has not been performed.

The supported scope is saved public post text and available replies. Attachments and images require opening the original site. Incomplete history, stale sessions and site changes can affect available evidence. Source selection and final-answer quality need ongoing real-user evaluation. RAM measurements cover the tested corpus, not arbitrary future import sizes.

## Run the checks

Follow [Contributing](../../CONTRIBUTING.md#unit-tests) once to install development dependencies and the pinned public Brightspace fixtures. Then, from the repository root:

```sh
export BOILERSPACE_FIXTURES_DIR=.verify-tmp/Brightspace-Bar/session-capture/tests/fixtures
npm test
npx playwright install chromium firefox
node scripts/verify-discussions.mjs ./node_modules/playwright/index.mjs
node scripts/verify-discussion-recovery.mjs
node scripts/verify-chat-streaming.mjs
node scripts/verify-discussion-search.mjs
VERIFY_BROWSER=firefox node scripts/verify-discussion-search.mjs
```

Normal extension use needs no Node/Python install or model download. Its runtime is entirely under `extension/`.

<details>
<summary>Optional research and reproduction</summary>

Private captures and labels are required to reproduce real-course metrics. They are not distributed. A clone can run synthetic regressions and the public course-runner fixture, but cannot recreate private scores from the aggregate file alone.

With the existing private capture and question bank present:

```sh
# Actual bundled worker and final extension-tool snippets.
node experiments/discussions/benchmark-production.mjs --worker
node experiments/discussions/verify-extension-search.mjs
# Export aggregate scores and update the two README tables.
node experiments/discussions/export-results.mjs --update-readme
```

Native comparisons use a separate optional runtime: `npm ci --prefix experiments/retrieval/modern-js --ignore-scripts`. Pinned models are in `models.json`; downloads, vectors and detailed reports stay under ignored `.verify-tmp/` and `bench/runs/`. `evaluate-expanded.mjs` checks frozen capture, model and code hashes. Preserve sealed inputs when rerunning historical experiments.

To regenerate bundled weights, download `model.safetensors` from the revision in the model provenance into `.verify-tmp/retrieval-models/potion-retrieval-32M/`, then run `node experiments/discussions/quantize-potion.mjs`. The source SHA-256 is checked and the output must reproduce the bundled hash. Asset updates require new integrity, quality and browser measurements.

The [earlier course-runner guide](../retrieval/README.md) covers its public fixture and optional native environments. No research runtime or fixture ships inside the extension.

</details>
