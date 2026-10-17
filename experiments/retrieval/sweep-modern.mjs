// Development-set tuning only. Use held-out questions before adopting a setting.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readVectorFile } from './vector-file.mjs';
import { vectorSearch, fuseRanks, passageKey, rankingMetrics } from './ranking.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const read = (filename) => JSON.parse(readFileSync(path.resolve(root, filename)));
const dataset = read(option('--dataset', '.verify-tmp/retrieval-modern-dataset.json'));
const model = option('--model', 'jina5-nano-q4');
const metadata = read(`.verify-tmp/retrieval-modern/${model}.json`);
if (metadata.corpusHash !== dataset.report.corpusHash) throw new Error('Corpus mismatch.');
const vectors = readVectorFile(metadata.documents, dataset.entries.length, metadata.dimensions);
const queries = readVectorFile(metadata.queries, dataset.queries.length, metadata.dimensions);
const dense = dataset.queries.map((q, i) => vectorSearch(dataset.entries, vectors, queries[i], { courseId: q.courseId }));
const rows = [];
for (const k of [10, 20, 40, 60]) for (const bm25Weight of [0, 0.25, 0.5, 0.75, 1, 1.5, 2]) {
  const rankings = dense.map((ranking, i) => fuseRanks([dataset.baseline[i], ranking], { k, weights: [bm25Weight, 1] }));
  const ranks = dataset.queries.map((q, i) => ({ id: q.id, rank: rankings[i].findIndex((r) => q.relevant.includes(passageKey(r))) + 1 }));
  rows.push({ k, bm25Weight, semanticWeight: 1, ...rankingMetrics(ranks) });
}
const report = { model, corpusHash: metadata.corpusHash, at: new Date().toISOString(),
  note: 'Parameters are tuned and scored on the same development questions. These results are not held-out validation.',
  rows: rows.sort((a, b) => b.mrrAt10 - a.mrrAt10) };
const target = rows.find((r) => r.k === 20 && r.bm25Weight === 0.5);
console.log(JSON.stringify({ target, bestByDevelopmentMRR: report.rows[0], note: report.note }, null, 2));
writeFileSync(path.resolve(root, option('--out', 'bench/runs/retrieval-modern-sweep.json')), JSON.stringify(report, null, 2), { mode: 0o600 });
