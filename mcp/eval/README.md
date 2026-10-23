# Retrieval checks

Run `npm run eval -- eval-local.json` from `mcp/`.

The suite indexes 22 synthetic documents across two courses, then runs 28 labelled questions through SQLite FTS5 BM25 and local hybrid retrieval. Questions include paraphrases, corrected deadlines, nearby excluded exam topics and answers that require several documents. Both methods use the same corpus, course filter and top-five result budget.

[`baseline.json`](baseline.json) records the dataset hash, environment, rankings, metrics and timings from one run. No course captures or model-generated answers are included.

| Metric | Meaning |
| --- | --- |
| Hit@1 / Hit@5 | At least one required document appears in the first result / first five results. |
| MRR | Reciprocal rank of the first required document, zero when absent from the first five. |
| Evidence recall@5 | Fraction of all required documents found in the first five, averaged across questions. |
| All evidence@5 | Fraction of questions for which every labelled required document was retrieved. |

On the recorded macOS arm64 run, hybrid Hit@1 was 27/28 and keyword Hit@1 was 25/28. Both retrieved every labelled document within five results. That is a useful regression baseline on a small, simple corpus. It does not establish production accuracy, measure whether answers are correct, or replace evaluation on independently labelled real courses. Query timings are warm measurements after indexing, without a model API call; they are not end-to-end answer latency.

CI uploads a fresh report on each run. It does not fail builds on tiny timing differences or treat these numbers as a statistical result. Unit tests separately assert course scoping, citation integrity, fallback behavior and index recovery.
