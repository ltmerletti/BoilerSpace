# Discussion search with 20-200 MB of extra RAM

Research and local checks on October 16, 2026. The target is incremental browser RAM during Ed/Piazza search, rather than downloadable weights or total browser RSS.

## Best finding

[SSE Retrieval MRL v2](https://huggingface.co/RikkaBotan/stable-static-embedding-fast-retrieval-mrl-en-v2), released in [May 2026](https://huggingface.co/blog/RikkaBotan/stable-static-embedding-v2-technical-report), is a credible candidate. It has 15.6M parameters. Inference uses a token-vector lookup table, mean pooling, and a separable nonlinear transform. The prototype uses pure JavaScript and the small [Hugging Face tokenizer library](https://github.com/huggingface/tokenizers.js), without ONNX, PyTorch, or transformer inference in the browser.

The publisher reports NanoBEIR nDCG@10 of 0.5159 at 512 dimensions and 0.5036 at 256 dimensions. These are author-reported retrieval scores, not expected Ed/Piazza accuracy. The model's architecture supports a smaller coordinate prefix. We also tested float16 storage for the embedding table while retaining float32 transform parameters. The browser reads half-precision table entries directly through a small lookup table, without expanding the whole matrix to float32.

## Measured browser results

All variants use the same frozen 1,448-thread corpus, 65 authored questions, source filters, user-only history, development-selected weighted fusion with BM25, and 6,000-character / 12-chunk context limit as the discussion experiment. Validation remains 26 questions; development has 39. This is exploratory selection on a small question set, not an independently collected user-question test.

| SSE variant | Resident weight table | Extra sampled browser RSS | Mean / p95 retrieval | Correct answer first | All required evidence |
| --- | ---: | ---: | ---: | ---: | ---: |
| 512D float32 | 62.5 MB | 234-236 MB | 1.6 / 2.7 ms | 47/65, 72.3% | 64/65, 98.5% |
| 256D prefix, float32 | 31.3 MB | 173 MB | 1.2 / 2.0 ms | 45/65, 69.2% | 64/65, 98.5% |
| 512D float16 storage | 31.3 MB | 176-177 MB | 1.6 / 2.6 ms | 47/65, 72.3% | 64/65, 98.5% |

Float16 and full-precision memory checks were repeated in fresh isolated Chromium instances. The main float16 advantage is lower memory while preserving the full 512D representation. The 256D prefix was slightly faster but had weaker first-result ranking. The earlier Mixedbread q4 hybrid retrieved all evidence for the same number of questions, but placed the correct answer first on 53/65 questions, or 81.5%.

The measured memory difference starts after the browser has loaded the discussion corpus and BM25 index. It includes the tokenizer, static weights, new vectors, character index used during exploration, and query work. RSS sums the isolated browser's processes and can count shared pages more than once. Allocation and garbage collection add noise. These are local feasibility measurements, not guarantees for every browser or device. They must not be compared directly with the earlier total-browser RSS figures.

The float16 document-vector index is still float32 and occupies 3.35 MB for 1,637 passages. Indexing plus the character index took less than one second in the local checks. Query timing excludes extension UI and answer generation. Firefox remains unverified because the local test binary cannot launch.

Public-text tokenizer IDs and normalized output vectors were checked against a PyTorch reference. Minimum cosine agreement exceeded 0.999999 across all variants. The publisher's remote Python module was inspected as source, not executed. The preparation script implements the published pooling and transform directly.

## Other candidates from the research

| Candidate | Why it is relevant | What remains unknown |
| --- | --- | --- |
| [Sentence Transformers static-retrieval-mrl-en-v1](https://huggingface.co/sentence-transformers/static-retrieval-mrl-en-v1) | Established static retrieval baseline with supported dimensional prefixes. Published NanoBEIR results allow comparison with SSE. | Local discussion accuracy and incremental RAM after compact storage. Its full float32 table is about 125 MB, so the full model is not automatically within a 200 MB runtime budget. |
| [POTION retrieval 32M](https://huggingface.co/minishlab/potion-retrieval-32M) | Retrieval-specific Model2Vec model. It avoids transformer inference and has a lightweight lookup-based execution path. | Its full float32 table is about 129 MB. Smaller storage or a dimensional prefix may be needed. The author's MTEB retrieval score is below MiniLM, so similar local hybrid accuracy cannot be assumed. |
| [POTION code 16M v2](https://huggingface.co/minishlab/potion-code-16M-v2) | A small static model specialized for code retrieval. Potentially useful for programming questions in CS discussions. | Performance on mixed prose/code posts and incremental browser RAM. It is a specialized challenger, not an established replacement for the general discussion retriever. |
| [Mixedbread edge ColBERT 32M](https://huggingface.co/mixedbread-ai/mxbai-edge-colbert-v0-32m) | A stronger small late-interaction quality candidate than the tested 17M version. | Published q8 file size is about 33 MB, but runtime and token-index memory still need measurement. It is not proven to fit the requested extra-RAM limit. |

[Sentence Transformers' current multi-vector comparison](https://www.sbert.net/docs/multi_vector_encoder/pretrained_models.html) reports NanoBEIR 0.6524 for edge ColBERT 32M versus 0.6407 for 17M. It also cautions that NanoBEIR is a small proxy and does not replace testing on the application corpus. Static and multi-vector scores should not be interpreted as a promise of equivalent local hybrid accuracy.

## Reproduce

The optional Python research environment prepares public weights and public-text parity probes. It is not part of browser inference. No private discussion capture is read or sent by the preparation step.

```sh
.verify-tmp/retrieval-venv/bin/python experiments/discussions/prepare-static.py
node experiments/discussions/benchmark-static-browser.mjs
node experiments/discussions/benchmark-static-browser.mjs --256
node experiments/discussions/benchmark-static-browser.mjs --f16
node --test tests/static-embedding.test.mjs
```

The pinned model revision is `928b418b2741b7f7b1b557a53845ac88ad5054c4`. The preparation script verifies published weight hashes and saves derived tables locally. Private questions and detailed reports remain in ignored directories. Browser network access is restricted to the loopback fixture server.

Results are `bench/runs/discussions/browser-static-sse-v2-{f32,256,f16}.json`. This work is a prototype. Production retrieval has not changed.
