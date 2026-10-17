// Local-only comparison. Hugging Face supplies model files; inference never sends it course text.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline, env } from '@huggingface/transformers';
import { buildIndex, search, documentsFromSnapshot } from '../../extension/lib/search.js';
import { discussionDocuments } from '../../extension/lib/discussions.js';
import { buildCaptureEnv } from '../../bench/load.mjs';
import { quoteFound } from '../../bench/retrieval.mjs';
import { fuseRanks, passageKey, rankingMetrics, uniqueDocuments, vectorSearch } from './ranking.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const batchSize = Number(option('--batch-size', '1'));
if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error('Batch size must be between 1 and 32.');
const read = (name) => JSON.parse(readFileSync(path.resolve(root, name), 'utf8'));
const cacheDir = path.join(root, '.verify-tmp/retrieval-models');
const out = path.resolve(root, option('--out', 'bench/runs/retrieval-comparison.json'));
mkdirSync(path.dirname(out), { recursive: true });
mkdirSync(cacheDir, { recursive: true });
env.cacheDir = cacheDir;
env.allowLocalModels = false;
const models = [
  { name: 'granite-small-r2-q8', repo: 'onnx-community/granite-embedding-small-english-r2-ONNX', revision: '1dc7835ba0cb9c76a3618d0bf0c427c97671b3c8', pooling: 'cls', maxTokens: 512, prefix: '' },
  { name: 'arctic-xs-q8', repo: 'Snowflake/snowflake-arctic-embed-xs', revision: 'd8c86521100d3556476a063fc2342036d45c106f', pooling: 'cls', maxTokens: 512, prefix: 'Represent this sentence for searching relevant passages: ' },
  { name: 'minilm-l6-q8', repo: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9', pooling: 'mean', maxTokens: 256, prefix: '' },
].filter((m) => !option('--model', '') || m.name === option('--model', ''));
if (!models.length) throw new Error('Unknown model; use granite-small-r2-q8, arctic-xs-q8, or minilm-l6-q8.');

const capture = read(option('--capture', args.includes('--fixture') ? 'experiments/retrieval/fixtures/capture.json' : 'bench/data/capture.json'));
const captured = buildCaptureEnv(capture);
const files = (capture.files ?? []).filter((f) => !f.error).map((f) => ({ ...f, id: f.topicId, key: f.topicId === 'overview' ? `overview:${f.courseId}` : `content:${f.topicId}`, url: f.fileHref }));
const discussionPath = option('--discussions', '.verify-tmp/retrieval-discussions.json');
const discussions = !args.includes('--fixture') && existsSync(path.resolve(root, discussionPath)) ? read(discussionPath).discussions : { sources: [] };
const docs = [...documentsFromSnapshot(captured.snapshot, captured.syllabi, { files }), ...discussionDocuments(discussions)];
const index = buildIndex(docs);
const entries = index.entries.map(({ tf, ...entry }) => entry);
const texts = entries.map((entry) => `${entry.title}\n${entry.text}`);
const corpusHash = createHash('sha256').update(JSON.stringify(texts)).digest('hex');
const rawCases = read(option('--cases', args.includes('--fixture') ? 'experiments/retrieval/fixtures/cases.json' : 'bench/data/cases.json'));
const tests = [];
let skippedNoEvidence = 0;
for (const item of rawCases) {
  const relevant = entries.filter((entry) => (!item.scopeCourseId || entry.courseId === item.scopeCourseId) && (item.evidence ?? []).some((e) => {
    const fileKey = e.topicId === 'overview' ? `overview:${item.scopeCourseId}` : e.topicId != null ? `content:${e.topicId}` : null;
    const matchesSource = fileKey ? entry.file_key === fileKey : e.itemKey ? entry.item_key === e.itemKey : false;
    return matchesSource && quoteFound(e.quote, [entry.text]);
  }));
  if (!relevant.length) { skippedNoEvidence++; continue; }
  tests.push({ id: item.id, query: item.question, courseId: item.scopeCourseId ?? null, relevant: new Set(relevant.map(passageKey)), group: 'course-evidence' });
}
// Optional private discussion probes use the same {id, key, query, quote} shape for any course.
const probePath = option('--probes', null);
for (const probe of probePath ? read(probePath) : []) {
  const relevant = entries.filter((e) => e.discussion_key === probe.key && quoteFound(probe.quote, [e.text]));
  if (relevant.length) tests.push({ id: probe.id, query: probe.query, courseId: relevant[0].courseId, relevant: new Set(relevant.map(passageKey)), group: 'discussion-probe' });
  else throw new Error(`Discussion probe has no matching saved evidence: ${probe.id}`);
}
const question = option('--query', null);
const queryCourse = option('--course', null);
const queries = question ? [{ id: 'interactive', query: question, courseId: queryCourse ? Number(queryCourse) : null, relevant: new Set() }] : tests;
if (!queries.length) throw new Error('No queries have matching passage evidence.');
console.log(`${docs.length} documents, ${entries.length} passages, ${tests.length} answerable queries (${skippedNoEvidence} cases without matching passage evidence excluded).`);
const baseline = queries.map((q) => search(index, q.query, { courseId: q.courseId, limit: 50, cutoff: 0 }));
// The production baseline uses a relative cutoff; compare it separately from a wider lexical candidate pool.
const production = queries.map((q) => search(index, q.query, { courseId: q.courseId, limit: 6 }));
const measure = (rankings) => queries.map((q, i) => ({ id: q.id, group: q.group, rank: rankings[i].findIndex((entry) => q.relevant.has(passageKey(entry))) + 1 }));
const report = { at: new Date().toISOString(), node: process.version, platform: `${process.platform}/${process.arch}`, corpusHash,
  documents: docs.length, passages: entries.length, excludedCases: skippedNoEvidence, evaluatedCases: tests.length,
  note: 'Retrieval-only development comparison on answerable cases. All captured file pages are indexed for every method. This is not a held-out answer-quality or unanswerable-question evaluation.',
  bm25Production: rankingMetrics(measure(production)), bm25Wide: rankingMetrics(measure(baseline)), models: [] };
console.log('BM25 production', JSON.stringify(report.bm25Production));
console.log('BM25 wide', JSON.stringify(report.bm25Wide));

// Export exactly the same passages, labels and lexical rankings for other local runtimes.
// The export contains private course material and belongs under an ignored directory.
if (option('--export-dataset', null)) {
  const target = path.resolve(root, option('--export-dataset'));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, JSON.stringify({ report, texts, entries,
    queries: queries.map((q) => ({ ...q, relevant: [...q.relevant] })), baseline, production }), { mode: 0o600 });
  console.log(`Local dataset: ${target}`);
  process.exit(0);
}

for (const model of models) {
  env.allowRemoteModels = true;
  const rssBeforeLoad = process.memoryUsage().rss;
  const started = performance.now();
  const extractor = await pipeline('feature-extraction', model.repo, { revision: model.revision, dtype: 'q8', device: 'cpu', session_options: { intraOpNumThreads: 2, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false } });
  // Models are loaded before reading any private text into inference. No remote inference endpoint is used.
  env.allowRemoteModels = false;
  const loadMs = performance.now() - started;
  const signature = createHash('sha256').update(JSON.stringify({ schema: 1, corpusHash, ...model, dtype: 'q8', runtime: '3.8.1', batchSize })).digest('hex');
  const vectorFile = path.join(cacheDir, `${model.name}-${signature}.f32`);
  let vectors, indexMs = 0, fromCache = false;
  const options = { pooling: model.pooling, normalize: true, truncation: true, max_length: model.maxTokens };
  if (existsSync(vectorFile) && !args.includes('--reindex')) {
    const bytes = readFileSync(vectorFile);
    if (bytes.length !== entries.length * 384 * 4) throw new Error('Embedding cache has an unexpected size.');
    const flat = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    vectors = entries.map((_, i) => flat.subarray(i * 384, (i + 1) * 384));
    fromCache = true;
  } else {
    const indexing = performance.now();
    vectors = [];
    for (let start = 0; start < texts.length; start += batchSize) {
      const result = await extractor(texts.slice(start, start + batchSize), options);
      const batch = result.tolist();
      if (batch.some((v) => v.length !== 384)) throw new Error('Unexpected embedding dimensions.');
      vectors.push(...batch.map((v) => Float32Array.from(v)));
      if (start % 256 === 0) console.log(`${model.name}: embedded ${Math.min(start + batchSize, texts.length)}/${texts.length}`);
    }
    indexMs = performance.now() - indexing;
    const flat = new Float32Array(vectors.length * 384);
    vectors.forEach((v, i) => flat.set(v, i * 384));
    writeFileSync(vectorFile, Buffer.from(flat.buffer), { mode: 0o600 });
  }
  const semantic = [], hybrid = [], latencies = [];
  for (const [i, q] of queries.entries()) {
    const queryStart = performance.now();
    const tensor = await extractor(`${model.prefix}${q.query}`, options);
    const dense = vectorSearch(entries, vectors, tensor.tolist()[0], { courseId: q.courseId });
    semantic.push(dense);
    hybrid.push(fuseRanks([baseline[i], dense]));
    latencies.push(performance.now() - queryStart);
  }
  const semanticRows = measure(semantic), hybridRows = measure(hybrid), productionRows = measure(production);
  const row = { name: model.name, batchSize, repo: model.repo, revision: model.revision, dtype: 'q8', dimensions: 384, loadMs: Math.round(loadMs),
    indexMs: Math.round(indexMs), fromCache, vectorBytes: entries.length * 384 * 4,
    rssBeforeLoad, rssAfterRun: process.memoryUsage().rss, processPeakRssKiB: process.resourceUsage().maxRSS,
    meanQueryMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    semantic: rankingMetrics(semanticRows), hybrid: rankingMetrics(hybridRows),
    discussionProbes: { bm25: rankingMetrics(productionRows.filter((r) => r.group === 'discussion-probe')), semantic: rankingMetrics(semanticRows.filter((r) => r.group === 'discussion-probe')), hybrid: rankingMetrics(hybridRows.filter((r) => r.group === 'discussion-probe')) },
    rows: hybridRows.map((r, i) => ({ ...r, bm25Rank: productionRows[i].rank, semanticRank: semanticRows[i].rank })) };
  report.models.push(row);
  console.log(model.name, JSON.stringify({ ...row, rows: undefined }));
  if (question) for (const [method, ranks] of [['bm25', baseline[0]], ['semantic', semantic[0]], ['hybrid', hybrid[0]]]) {
    console.log(`\n${method} (${model.name})`);
    for (const hit of uniqueDocuments(ranks)) console.log(JSON.stringify({ label: hit.label, url: hit.url, snippet: hit.text.slice(0, 500) }));
  }
  await extractor.dispose();
  writeFileSync(out, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(`Local report: ${out}`);
