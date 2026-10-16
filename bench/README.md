# BoilerSpace Assistant Benchmark

Offline and live evaluation suite for the course assistant (`ask()` in `extension/lib/agent.js`).

## Files

- `bench/load.mjs`: Builds `{ snapshot, syllabi, readFile }` from `bench/data/capture.json`.
- `bench/data/cases.json`: Benchmark cases with fixed `now` timestamps, verified evidence quotes, and deterministic grading expectations (gitignored alongside `bench/data/capture.json`).
- `bench/score.mjs`: Grades `{ text, citations, trace }` against `expect` (`mustInclude`, `mustNotInclude`, `citeTopicIds`, `notFound`) and computes pass rates by category.
- `bench/retrieval.mjs`: Offline recall check for passages returned by `read_course_file`.
- `bench/run.mjs`: CLI runner supporting `--check` mode (offline validation + scripted plumbing check) and live runs against Purdue GenAI Studio.

## Offline Validation (`--check`)

This suite requires both `bench/data/capture.json` and `bench/data/cases.json`. They contain private course material and are gitignored, so a fresh clone does not include the inputs. A benchmark export creates a capture; it does not create the separate evaluation cases. Use `npm test` with the fixture setup in [CONTRIBUTING.md](../CONTRIBUTING.md#unit-tests) for the public unit suite.

Validate the schema of `bench/data/cases.json`, verify that every evidence quote appears in `bench/data/capture.json`, and run a scripted plumbing check through `ask()` and `readEventStream()` with no network calls:

```bash
node bench/run.mjs --check
```

## Running Live Benchmarks

Live runs require a Purdue GenAI Studio API key in `GENAI_STUDIO_KEY`. Requests stream via `https://genai.rcac.purdue.edu/api/chat/completions`, are spaced at least 3.1 seconds apart (≤ 20 requests/minute), and automatically retry HTTP 429 responses.

```bash
# Run all benchmark cases with the default model (qwen3.8:27b)
GENAI_STUDIO_KEY=your_key_here node bench/run.mjs

# Choose a specific model
GENAI_STUDIO_KEY=your_key_here node bench/run.mjs --model gpt-oss:120b

# Filter by category, case IDs, or limit count
GENAI_STUDIO_KEY=your_key_here node bench/run.mjs --category due_dates,policies --limit 10
GENAI_STUDIO_KEY=your_key_here node bench/run.mjs --cases case-id-1,case-id-2
```

Each live run writes a full report (answers, citations, tool traces, request counts, latency, and per-case scores) to `bench/runs/<timestamp>.json`, updating it as each case finishes, and prints a summary table by category. Cases run three at a time by default (`--concurrency N`); the request spacing is shared, so this only overlaps model latency.

The summary table also shows average model requests (`Reqs`) and seconds (`Secs`) per case, so a change that keeps the pass rate but needs fewer lookups still shows up.

## Passage Retrieval (`bench/retrieval.mjs`)

An offline check of `read_course_file` passage selection. For every case whose evidence sits in a course file, it replays the queries the model sent for that file in the saved runs (plus the case question) and reports how often the evidence quote comes back, along with the average result size. It makes no network calls, so it is the quick way to try ranking changes before a live run:

```bash
node bench/retrieval.mjs --verbose
```

`bench/data/` comes from the Settings tab's "Save benchmark data" button. Copy the downloaded file to `bench/data/capture.json`.

Keep captures, cases built from private material, and live run reports out of public issues and pull requests. The export scrubs email addresses and phone numbers and omits grade records, but course identifiers, document text, and questions can still identify people or courses. See [PRIVACY.md](../PRIVACY.md).
