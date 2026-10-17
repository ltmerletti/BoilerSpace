# Discussion benchmark expansion protocol

Written before evaluating the new questions, October 16, 2026.

## Scope and sampling

Use the frozen local Ed/Piazza capture. Keep the original 65 questions as development material. New test questions must cite threads absent from every original question's expected evidence. Do not run retrieval on new questions until authorship and evidence checks are complete and the test manifest is sealed.

Target 300 primary questions from distinct new threads, with approximate quotas of 60 from Ed CS 250, 100 from Ed CS 251, and 140 from Piazza. Review candidate threads in seeded hash order. Use purposive topic coverage within those quotas, recording exclusions for evidence quality, redundant topics, or coverage quotas, never observed retrieval performance. This is not probability sampling. Exclude empty, acknowledgement-only, external-link-only answers and repetitive event approvals. Avoid personal information in questions.

Author a natural question requiring the supported answer. Use task descriptions, paraphrases, code/error symptoms, exceptions, explicit time qualifiers, and plausible false premises where the source supports a correction. Do not copy the post title as the query. Preserve identifying assignment numbers when needed to make the question answerable. Check the entire source conversation, not a retrieved snippet. Record exact evidence spans, the supported answer, question type, topic, and a brief annotation rationale.

Add separate conversational follow-ups and multi-thread questions after the primary set. They may reuse primary threads but do not create independent statistical samples. Add ambiguity/unsupported diagnostics in a separate file. Do not count empty evidence arrays as successful retrieval, and do not count unsupported questions in an answerable-retrieval denominator.

The result is a source-checked, single-author synthetic holdout, not a human-validated or independently authored sample of real user traffic. It estimates performance on this capture and question construction process. It does not establish general production accuracy.

## Frozen retrieval configurations

All systems use thread chunks of 1,000 characters with 150 overlap, title text, user-only conversation history, known discussion sourceId, and a 6,000-character / 12-chunk context limit.

- Primary candidate: SSE v2, 512 dimensions, float16 table storage. Reciprocal rank fusion of semantic ranking and BM25, weights 1 and 1, k=10.
- Primary comparator: BM25 plus character-trigram search. RRF weights 1 and 0.5, k=20.
- Secondary reference: plain BM25.
- Optional secondary model comparison: the previously selected Mixedbread q4 configuration, without selecting new parameters on the expanded set.

No threshold, fusion weight, chunking choice, or model may be selected using expanded-test results. A later tuning run must treat this set as development and collect a new holdout.

## Endpoints and uncertainty

The primary endpoint is retrieval of every labeled answer span in the fixed context budget on the primary one-question-per-thread set. Report correct-first retrieval, at-least-one answer at five, MRR@10, and breakdowns by source and question type as secondary metrics.

Report 95% Wilson intervals for success proportions, paired differences, exact McNemar tests on the primary independent thread questions, and paired bootstrap intervals. For combined questions, bootstrap connected groups of evidence threads so repeated questions and multi-thread links are resampled together. Report the number of questions and independent groups separately. Check for duplicate questions and repeated/near-duplicate evidence. Treat independence and representativeness as limitations, not guarantees.

Before evaluation, add a conservative dependence sensitivity check: also cluster by source and topic. Distinct threads may repeat the same fact, so the thread-level McNemar result alone is insufficient to claim an improvement robust to those dependencies. Short quoted anchors expand to their containing staff paragraph when it is at most 900 characters; this preserves qualifications rather than labeling a bare yes/no. Exact source-span coverage is a conservative retrieval proxy, not a grade of the generated answer or semantic equivalence to unlabeled duplicate answers.

Use a two-sided alpha of 0.05 for the one prespecified primary candidate/comparator contrast. Secondary contrasts are exploratory; report unadjusted p-values and Holm-adjusted p-values if making several simultaneous claims. Do not claim equivalence from a nonsignificant difference. Statistical significance depends on paired disagreements and effect size, not question count alone.

References: [NIST proportion confidence intervals](https://www.itl.nist.gov/div898/handbook/prc/section2/prc241.htm), [statsmodels exact McNemar test](https://www.statsmodels.org/dev/generated/statsmodels.stats.contingency_tables.mcnemar.html), [SciPy paired bootstrap](https://docs.scipy.org/doc/scipy/reference/generated/scipy.stats.bootstrap.html).

## Audit and privacy

Keep real post text, questions, expected answers, candidate decisions, and per-question reports in ignored directories. Seal the source capture hash, question hash, annotation version, and frozen configurations before evaluation. Publish only generic tools, synthetic regression fixtures, methodology, and aggregate findings unless separately authorized.
