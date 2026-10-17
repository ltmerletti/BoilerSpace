# Expanded discussion benchmark

October 16, 2026. Retrieval only; production search is unchanged.

The new question bank contains 300 primary questions from 300 previously unused threads, 20 conversational follow-ups, 10 questions requiring two threads, and 12 unscored ambiguity/unsupported diagnostics. Primary coverage is 60 CS 250 Ed questions, 100 CS 251 Ed questions, and 140 Piazza questions. No expected thread overlaps the original 65-question development set.

Questions cover 48 code symptoms, 65 false premises, 57 policy exceptions, 40 temporal qualifications, 32 comparisons, 41 procedural questions, and 17 other paraphrases. Each answerable question includes a supported answer, exact staff evidence, topic, question type, and annotation rationale. The source review included later replies and corrections. One near-duplicate paragraph pair was flagged: two different project announcements reused wording, but the questions ask different facts. There are no repeated exact evidence strings across primary cases.

This is a source-checked, assistant-authored, purposively selected sample. It has not been independently validated by human annotators and is not a probability sample of student traffic. Distinct threads can repeat facts. Inference therefore includes both thread-level pairing and a conservative source/topic sensitivity check with 80 clusters.

## Frozen comparison

The capture, cases, annotations, protocol, runtime code, model assets, and configurations were hashed before the first retrieval evaluation. The original settings were retained: 1,000-character thread chunks, 150 overlap, known source, user-only history, and a 6,000-character / 12-chunk context. The static model is SSE v2, 512 dimensions, float16 storage, fused with BM25 at equal weights and RRF k=10. No settings were tuned on the expanded questions.

| Method | Complete labeled evidence in context | 95% Wilson interval | First result contains complete labeled span | At least one labeled span in top five |
| --- | ---: | ---: | ---: | ---: |
| SSE float16 + BM25 | 292/300, 97.3% | 94.8–98.6% | 207/300, 69.0% | 281/300, 93.7% |
| BM25 + character trigrams | 290/300, 96.7% | 94.0–98.2% | 225/300, 75.0% | 280/300, 93.3% |
| BM25 | 289/300, 96.3% | 93.6–97.9% | 227/300, 75.7% | 282/300, 94.0% |

The prespecified primary contrast, SSE versus BM25/character search, differs by **+0.67 percentage points**. Five questions favor SSE and three favor the comparator; exact paired McNemar p=0.7265625. The paired 95% bootstrap interval for the difference is **−1.33 to +2.67 points**. The source/topic cluster sensitivity interval is **−0.96 to +2.21 points**. Neither supports a statistically significant completeness improvement. Nonsignificance does not establish equivalence. The lexical systems have better first-result ranking on this set.

The exploratory SSE/plain-BM25 contrast is +1.0 point, exact paired p=0.5078125. Treating both contrasts as a family gives Holm-adjusted p=1 for each. The primary contrast was the only prespecified confirmatory test.

SSE retrieved all labeled evidence for 29/30 challenges: all 20 follow-ups and nine of ten two-thread questions. Combined cases are not 330 independent samples: shared evidence links them into 290 thread groups, or 77 source/topic-connected groups. Diagnostics were not evaluated as answerable retrieval and do not have an abstention score.

## Browser measurement and failure review

The isolated Chromium run uses cached assets and blocks external requests. The complete corpus contains 1,448 discussion threads represented by 1,637 chunks. Query retrieval averaged 1.51 ms, p95 2.40 ms; the sampled additional process RSS was 178.5 MB over the same browser with its discussion corpus and BM25 index already loaded. This includes the static model, tokenizer, vector index, character index, and query work. RSS can count shared pages more than once and varies with allocation and garbage collection; this single expanded run is not a portable device limit. Previous fresh-browser repetitions are documented in LOW_RAM_RESEARCH.md.

The frozen run has eight primary misses and one challenge miss. A local replay reproduced their browser ranks and completeness flags. Five involve a missing or clipped continuation of an answer; the remaining four do not select the labeled answer in the context. Two long paragraph labels include elaboration beyond the central fact requested, so strict-span scoring can mark a useful answer as incomplete. Equivalent answers in other, unlabeled posts can also be penalized. These observations are recorded without changing the sealed labels or inflating the score. A separate annotation adjudication is appropriate before treating the metric as a precise measure of answer sufficiency.

Retrieval completeness is not generated-answer correctness. This run does not measure Qwen, factual synthesis, resolution of conflicting updates in the final answer, or refusal/clarification behavior.

## Reproduction and review

The private bank, audit, manifest, reports, and review page are in the ignored `.verify-tmp/discussion-retrieval/v2/` directory. The review page filters by source, primary/challenge/diagnostic set, and SSE outcome, and reveals supported answers with exact evidence. It was checked in Chromium for correct counts, filters, search, and evidence disclosure.

```sh
node experiments/discussions/benchmark-static-browser.mjs --f16 \
  --sealed .verify-tmp/discussion-retrieval/v2
node experiments/discussions/build-question-review.mjs \
  .verify-tmp/discussion-retrieval/v2
npm test
```

The runner rejects changes to sealed input/code hashes. It evaluates one frozen blend instead of sweeping configurations. Preserve this set for external evaluation; any later tuning on its failures makes it development material and requires another holdout for a new performance claim.

All 157 unit tests pass, including new tests for evidence leakage, empty-label rejection, paired alignment, confidence intervals, exact McNemar, connected clusters, deterministic bootstrap, and Holm adjustment. No private course capture, question, answer, or per-question report was added to tracked files. No commit or push was made.
