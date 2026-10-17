import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { localModel } from './local-model.mjs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { cosine, fuseRanks } from '../retrieval/ranking.mjs';

process.umask(0o077);
const name = process.argv[2];
const spec = JSON.parse(readFileSync('experiments/discussions/models.json')).find((m) => m.name === name);
if (!spec) throw new Error('Specify a model from experiments/discussions/models.json.');
const representation = process.argv.includes('--messages') ? { unit: 'message', size: 700, overlap: 150, questionChars: 240 } : undefined;
const dataset = loadDataset(representation);
const model = await localModel(spec);
const directory = '.verify-tmp/discussion-retrieval/vectors';
mkdirSync(directory, { recursive: true });
const docsFile = `${directory}/${name}-${dataset.corpusHash}.f32`;
const queriesFile = `${directory}/${name}-${dataset.queryHash}.f32`;
const out = `bench/runs/discussions/${name}-${dataset.representation.unit}.json`;
const previous = existsSync(out) ? JSON.parse(readFileSync(out)) : null;
const compatibleCache = previous && JSON.stringify(previous.model) === JSON.stringify(spec) && previous.corpusHash === dataset.corpusHash;
const fromCache = existsSync(docsFile) && compatibleCache && !process.argv.includes('--reindex');
const decode = (filename, count) => {
  const bytes = readFileSync(filename);
  if (bytes.length !== count * spec.dimensions * 4) throw new Error('Cached vector shape mismatch.');
  return Array.from({ length: count }, (_, i) => Float32Array.from({ length: spec.dimensions }, (_, j) => bytes.readFloatLE((i * spec.dimensions + j) * 4)));
};
const save = (filename, vectors) => writeFileSync(filename, Buffer.from(Float32Array.from(vectors.flatMap((v) => [...v])).buffer), { mode: 0o600 });
const indexing = performance.now();
let documents;
if (fromCache) documents = decode(docsFile, dataset.texts.length);
else {
  documents = [];
  for (const [i, text] of dataset.texts.entries()) {
    documents.push(await model.embed(text, spec.documentPrefix));
    if (i % 256 === 0) console.log(`${name}: ${i + 1}/${dataset.texts.length} discussion passages`);
  }
  save(docsFile, documents);
}
const indexMs = performance.now() - indexing;
await model.embed('When is the assignment due?', spec.queryPrefix);
const queries = [], latencies = [];
for (const query of dataset.queries) {
  const start = performance.now();
  queries.push(await model.embed(query, spec.queryPrefix));
  latencies.push(performance.now() - start);
}
save(queriesFile, queries);
const lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const timings = [], rankings = dataset.cases.map((item, i) => {
  const start = performance.now();
  const vector = dataset.entries.flatMap((entry, j) => entry.sourceId === item.sourceId ? [{ ...entry, score: cosine(documents[j], queries[i]) }] : []).sort((a, b) => b.score - a.score).slice(0, 50);
  const bm25 = lexical.search(dataset.queries[i], { sourceId: item.sourceId });
  const character = characters.search(dataset.queries[i], { sourceId: item.sourceId });
  timings.push(performance.now() - start);
  return { vector, bm25, character };
});
const results = [];
for (const lexicalWeight of [0, 0.25, 0.5, 1, 2]) for (const characterWeight of [0, 0.25, 0.5]) for (const k of [10, 20, 60]) {
  const rows = dataset.cases.map((item, i) => ({ ...evaluateRanking(item,
    fuseRanks([rankings[i].vector, rankings[i].bm25, rankings[i].character], { weights: [1, lexicalWeight, characterWeight], k })), partition: item.partition }));
  results.push({ lexicalWeight, characterWeight, k, development: summarize(rows.filter((r) => r.partition === 'development')),
    validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows), rows });
}
results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10);
const sorted = [...latencies].sort((a, b) => a - b);
const report = { at: new Date().toISOString(), model: spec, corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
  scope: 'Ed/Piazza discussions, known sourceId, user-only conversation history', representation: dataset.representation,
  cases: dataset.cases.length, passages: dataset.entries.length, modelBytes: model.modelBytes, indexMs, fromCache: Boolean(fromCache),
  meanEncodeMs: latencies.reduce((a, b) => a + b, 0) / latencies.length, p95EncodeMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
  meanSearchMs: timings.reduce((a, b) => a + b, 0) / timings.length, peakRssBytes: process.resourceUsage().maxRSS * 1024,
  runtime: 'Native CPU ONNX, four threads. Browser performance/memory is not established by this run.',
  memoryNote: fromCache ? 'Cached document vectors; peak RSS excludes document inference.' : 'Includes document inference and query evaluation.',
  chosen: results[0], results };
mkdirSync('bench/runs/discussions', { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ out, ...report, results: undefined, chosen: { ...report.chosen, rows: undefined } }, null, 2));
await model.close();
