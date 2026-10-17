import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { localModel } from './local-model.mjs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { fuseRanks, passageKey } from '../retrieval/ranking.mjs';

process.umask(0o077);
const spec = { name: 'edge-colbert-17m-q8', repo: 'mixedbread-ai/mxbai-edge-colbert-v0-17m',
  revision: '592c6417c1c6687572043408ed1ae5196bce16b1', directory: '.verify-tmp/discussion-retrieval/models/mixedbread-ai/mxbai-edge-colbert-v0-17m',
  file: 'model_int8.onnx', maxTokens: 512 };
const config = JSON.parse(readFileSync(`${spec.directory}/onnx_config.json`));
const tokenizer = JSON.parse(readFileSync(`${spec.directory}/tokenizer.json`));
const skipped = new Set(config.skiplist_words.map((word) => tokenizer.model.vocab[word]).filter(Number.isInteger));
const model = await localModel(spec);
const dimensions = config.embedding_dim;
async function encode(text, query = false) {
  const prefix = query ? config.query_prefix : config.document_prefix;
  const tokens = await model.tokenize(prefix + (config.do_lower_case ? text.toLowerCase() : text), undefined,
    { max_length: query ? config.query_length : config.document_length });
  const tensor = (await model.run(tokens)).output;
  if (tensor.dims.at(-1) !== dimensions) throw new Error('Wrong ColBERT projection dimensions.');
  const vectors = [];
  for (let i = 0; i < tensor.dims[1]; i++) {
    if (!Number(tokens.attention_mask.data[i]) || (!query && skipped.has(Number(tokens.input_ids.data[i])))) continue;
    const vector = tensor.data.slice(i * dimensions, (i + 1) * dimensions);
    const norm = Math.hypot(...vector);
    if (!norm || !Number.isFinite(norm)) throw new Error('Invalid token embedding.');
    vectors.push(...Float32Array.from(vector, (v) => v / norm));
  }
  return Float32Array.from(vectors);
}
function maxSim(query, document) {
  let score = 0;
  for (let q = 0; q < query.length; q += dimensions) {
    let best = -Infinity;
    for (let d = 0; d < document.length; d += dimensions) {
      let dot = 0;
      for (let j = 0; j < dimensions; j++) dot += query[q + j] * document[d + j];
      best = Math.max(best, dot);
    }
    score += best;
  }
  return score;
}
const dataset = loadDataset();
const cache = `.verify-tmp/discussion-retrieval/colbert-${spec.revision}-schema1-${dataset.corpusHash}`;
let documents;
const startIndex = performance.now();
if (existsSync(cache + '.json') && existsSync(cache + '.f32')) {
  const offsets = JSON.parse(readFileSync(cache + '.json')), bytes = readFileSync(cache + '.f32');
  if (offsets.length !== dataset.entries.length || offsets.at(-1)[1] * 4 !== bytes.length) throw new Error('Invalid token-vector cache shape.');
  documents = offsets.map(([start, end]) => Float32Array.from({ length: end - start }, (_, i) => bytes.readFloatLE((start + i) * 4)));
}
else {
  documents = [];
  for (const [i, text] of dataset.texts.entries()) {
    documents.push(await encode(text));
    if (i % 256 === 0) console.log(`${spec.name}: ${i + 1}/${dataset.texts.length} passages`);
  }
  const offsets = [], flat = new Float32Array(documents.reduce((sum, v) => sum + v.length, 0));
  let through = 0;
  for (const vector of documents) {
    flat.set(vector, through); offsets.push([through, through + vector.length]); through += vector.length;
  }
  writeFileSync(cache + '.f32', Buffer.from(flat.buffer), { mode: 0o600 });
  writeFileSync(cache + '.json', JSON.stringify(offsets), { mode: 0o600 });
}
const indexMs = performance.now() - startIndex;
const indexBytes = documents.reduce((sum, v) => sum + v.byteLength, 0);
const lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const positions = new Map(dataset.entries.map((entry, i) => [passageKey(entry), i]));
await encode('When is the assignment due?', true);
const rankings = [], latencies = [];
for (const [i, item] of dataset.cases.entries()) {
  const query = dataset.queries[i], start = performance.now();
  const vector = await encode(query, true);
  const encodeMs = performance.now() - start;
  const scope = { sourceId: item.sourceId };
  const base = fuseRanks([lexical.search(query, scope), characters.search(query, scope)], { weights: [1, 0.5], k: 20 });
  const times = [], scored = [];
  for (const entry of base.slice(0, 50)) {
    const t = performance.now();
    scored.push({ ...entry, score: maxSim(vector, documents[positions.get(passageKey(entry))]) });
    times.push(performance.now() - t);
  }
  rankings.push({ base, scored }); latencies.push({ encodeMs, times });
}
const results = [];
for (const count of [10, 20, 50]) for (const originalWeight of [0, 0.25, 0.5, 1]) {
  const rows = dataset.cases.map((item, i) => {
    const { base, scored } = rankings[i];
    const reranked = scored.slice(0, count).sort((a, b) => b.score - a.score);
    const seen = new Set(reranked.map(passageKey));
    const ranking = originalWeight ? fuseRanks([reranked, base], { weights: [1, originalWeight], k: 20 }) : [...reranked, ...base.filter((e) => !seen.has(passageKey(e)))];
    return { ...evaluateRanking(item, ranking), partition: item.partition };
  });
  const times = latencies.map((r) => r.encodeMs + r.times.slice(0, count).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
  results.push({ count, originalWeight, meanQueryMs: times.reduce((a, b) => a + b, 0) / times.length, p95QueryMs: times[Math.ceil(times.length * 0.95) - 1],
    development: summarize(rows.filter((r) => r.partition === 'development')), validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows), rows });
}
results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10);
const report = { at: new Date().toISOString(), model: spec, modelBytes: model.modelBytes, indexBytes, indexMs,
  corpusHash: dataset.corpusHash, queryHash: dataset.queryHash, scope: 'Ed/Piazza only, known sourceId, user-only history',
  runtime: 'Native CPU ONNX, four threads. MaxSim over lexical candidates. Browser not verified.',
  peakRssBytes: process.resourceUsage().maxRSS * 1024, chosen: results[0], results };
mkdirSync('bench/runs/discussions', { recursive: true });
writeFileSync('bench/runs/discussions/edge-colbert-17m-q8.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, results: undefined, chosen: { ...report.chosen, rows: undefined } }, null, 2));
await model.close();
