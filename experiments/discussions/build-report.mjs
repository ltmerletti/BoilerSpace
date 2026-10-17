import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const directory = path.resolve('bench/runs/discussions');
const load = (name) => JSON.parse(readFileSync(path.join(directory, name)));
const count = (score, key) => `${Math.round(score[key] * score.cases)}/${score.cases} (${(score[key] * 100).toFixed(1)}%)`;
const lexical = load('lexical-sweep.json'), packing = load('context-packing.json');
const nativeRows = [];
for (const name of ['mxbai-xsmall-q4', 'mxbai-xsmall-q8', 'mxbai-xsmall-q4-t256', 'jina5-nano-q4', 'jina5-nano-q8']) {
  const filename = `${name}-thread.json`;
  if (!existsSync(path.join(directory, filename))) continue;
  const report = load(filename), score = report.chosen.overall;
  nativeRows.push(`| ${name} | ${count(score, 'hitAt1')} | ${count(score, 'hitAt5')} | ${count(score, 'allEvidenceInContext')} | ${report.meanEncodeMs.toFixed(1)} ms | ${(report.peakRssBytes / 2 ** 20).toFixed(0)} MiB${report.fromCache ? ' (cached)' : ''} |`);
}
const browserRows = [];
for (const name of ['mxbai-xsmall-q8', 'mxbai-xsmall-q4', 'mxbai-xsmall-q4-t256']) {
  const filename = `browser-full-${name}-chromium.json`;
  if (!existsSync(path.join(directory, filename))) continue;
  const report = load(filename);
  if (report.status !== 'passed') continue;
  browserRows.push(`| ${name} | ${count(report.overall, 'hitAt1')} | ${count(report.overall, 'hitAt5')} | ${count(report.overall, 'allEvidenceInContext')} | ${report.modelAndSearchMeanMs.toFixed(1)} / ${report.modelAndSearchP95Ms.toFixed(1)} ms | ${(report.peakBrowserRssBytes / 1e9).toFixed(3)} GB |`);
}
const diagnostics = load('diagnostics.json');
const reference = diagnostics.results.find((r) => r.sourceScoped && r.queryMode === 'history' && r.method === 'bm25');
const reranker = load('ettin-17m-q8.json'), colbert = load('edge-colbert-17m-q8.json');
const lines = [
  '# Ed and Piazza retrieval results', '',
  `Generated ${new Date().toISOString()}. This report evaluates discussions only. No syllabus or course-file evidence is included.`, '',
  `The frozen capture contains ${lexical.threads.toLocaleString()} threads from ${lexical.sources.length} discussion classes. The evaluation has ${lexical.cases} manually authored answerable questions, with ${lexical.developmentCases} development and ${lexical.validationCases} validation questions. Connected answer threads stay in one partition. Parameters are chosen using development scores.`, '',
  'The discussion class is supplied as a source filter. Conversation history includes user messages only. Scores require complete exact labeled answer spans, including replies. Questions requiring multiple answers count as complete only when every required answer is present. The final context has a 6,000-character body-text budget. This is not a test of generated-answer accuracy, unanswerable questions, or independent unseen user questions.', '',
  '## Browser results', '',
  'These runs generate the full document index and query embeddings in Chromium CPU/WASM, with one thread and no SharedArrayBuffer. They include semantic, BM25, and character-trigram ranking. They pack up to 12 chunks within the same 6,000-character budget.', '',
  '| Model | Correct answer first | Any answer in top 5 | All evidence in context | Mean / p95 retrieval | Sampled browser RSS |',
  '| --- | ---: | ---: | ---: | ---: | ---: |', ...browserRows, '',
  'Retrieval timing excludes the extension UI and answer generation. RSS sums processes belonging to the isolated browser. It includes browser overhead and can count shared pages more than once. It is a conservative snapshot estimate, not a guarantee about physical memory on every student laptop. Index construction is separate from warm query latency. A run near or above 1 GB does not establish comfortable compliance with the memory budget.', '',
  'Firefox failed before loading a model. The headless test timed out with macOS sandbox/graphics errors; the visible test also failed to launch. Firefox model compatibility remains unverified.', '',
  '## Native model comparison', '',
  'These are CPU ONNX runs with four threads. They use six context chunks so the model comparisons share the original context limit. Query timing in this table is embedding only; it excludes search, packing, and UI. Native vectors and quantized browser vectors can differ.', '',
  '| Model | Correct answer first | Any answer in top 5 | All evidence in context | Mean embedding | Peak native RSS |',
  '| --- | ---: | ---: | ---: | ---: | ---: |', ...nativeRows, '',
  `The lexical-only reference with user history retrieves all evidence for ${count(reference.overall, 'allEvidenceInContext')} questions. The development-selected character hybrid reaches ${count(lexical.chosen.overall, 'allEvidenceInContext')} with six chunks.`, '',
  `Packing more short posts, without raising the character budget, raises the native compact hybrid to ${count(packing.chosen.overall, 'allEvidenceInContext')}. The selected cap is ${packing.chosen.maxChunks} chunks. The validation partition has only 26 questions and is not an independently collected test.`, '',
  `The 17M Ettin q8 reranker scores the top ${reranker.chosen.count} lexical candidates. It retrieves the correct first answer for ${count(reranker.chosen.overall, 'hitAt1')} and all evidence for ${count(reranker.chosen.overall, 'allEvidenceInContext')}. Mean reranking time is ${reranker.chosen.meanRerankMs.toFixed(1)} ms, excluding lexical retrieval. Scoring more candidates costs more time and did not improve complete-evidence retrieval in this run.`, '',
  `The 17M edge ColBERT q8 candidate retrieves all evidence for ${count(colbert.chosen.overall, 'allEvidenceInContext')}. Encoding and MaxSim over ${colbert.chosen.count} lexical candidates average ${colbert.chosen.meanQueryMs.toFixed(1)} ms, excluding lexical retrieval. Its token-vector index uses ${(colbert.indexBytes / 2 ** 20).toFixed(1)} MiB. Browser performance is unverified.`, '',
  '## Other methods tested', '',
  '- 800 lexical configurations varying thread/message chunking, 400-1,500-character chunks, overlap, paragraph boundaries, title weights, user history, synonym expansion, character trigrams, relevance feedback, question splitting, and thread diversity.',
  '- Weighted reciprocal-rank fusion of dense, BM25, and character rankings, with q4 and q8 compact embeddings.',
  '- Separate-message neural chunks with question context. They retrieved less complete evidence than preserving thread context in this sample.',
  '- A fixed-budget context-packing sweep and deterministic splitting of questions that contain multiple interrogative clauses. Splitting did not improve the best complete-evidence result.',
  '- Searches without a class filter. These diagnose retrieval across sources; they do not test the assistant\'s routing decisions.', '',
  'The remaining failures and every per-question score stay in the ignored JSON reports. Further selection needs a larger independent discussion-question set, including ambiguous class references, code errors, updates that supersede earlier replies, and unanswerable questions. No model or retrieval change has been deployed.', '',
];
const out = path.join(directory, 'RESULTS.md');
writeFileSync(out, lines.join('\n'), { mode: 0o600 });
console.log(out);
