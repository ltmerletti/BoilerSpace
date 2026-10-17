// Compare context packing at one character budget. More short posts can fit without a larger prompt.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { cosine, fuseRanks } from '../retrieval/ranking.mjs';
import { readVectorFile } from '../retrieval/vector-file.mjs';

const dataset = loadDataset(), lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const rankings = new Map();
rankings.set('lexical-character', dataset.cases.map((item, i) => {
  const scope = { sourceId: item.sourceId };
  return fuseRanks([lexical.search(dataset.queries[i], scope), characters.search(dataset.queries[i], scope)], { weights: [1, 0.5], k: 20 });
}));
for (const name of ['mxbai-xsmall-q4', 'mxbai-xsmall-q8', 'jina5-nano-q4', 'jina5-nano-q8']) {
  const spec = JSON.parse(readFileSync('experiments/discussions/models.json')).find((m) => m.name === name);
  const report = JSON.parse(readFileSync(`bench/runs/discussions/${name}-thread.json`));
  if (report.corpusHash !== dataset.corpusHash || report.queryHash !== dataset.queryHash) throw new Error('Model/corpus mismatch.');
  const documents = readVectorFile(`.verify-tmp/discussion-retrieval/vectors/${name}-${dataset.corpusHash}.f32`, dataset.entries.length, spec.dimensions);
  const queries = readVectorFile(`.verify-tmp/discussion-retrieval/vectors/${name}-${dataset.queryHash}.f32`, dataset.queries.length, spec.dimensions);
  rankings.set(name, dataset.cases.map((item, i) => {
    const vector = dataset.entries.flatMap((entry, j) => entry.sourceId === item.sourceId ? [{ ...entry, score: cosine(documents[j], queries[i]) }] : []).sort((a, b) => b.score - a.score).slice(0, 50);
    const scope = { sourceId: item.sourceId }, selected = report.chosen;
    return fuseRanks([vector, lexical.search(dataset.queries[i], scope), characters.search(dataset.queries[i], scope)],
      { weights: [1, selected.lexicalWeight, selected.characterWeight], k: selected.k });
  }));
}
const results = [];
for (const [method, ranking] of rankings) for (const maxChunks of [6, 8, 12, 20]) for (const diversify of [false, true]) {
  const rows = dataset.cases.map((item, i) => ({ ...evaluateRanking(item, ranking[i], { budget: 6000, maxChunks, diversify }), partition: item.partition }));
  results.push({ method, maxChunks, budget: 6000, diversify, development: summarize(rows.filter((r) => r.partition === 'development')),
    validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows), rows });
}
results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10 || a.maxChunks - b.maxChunks);
const report = { scope: 'Ed/Piazza only, known sourceId, user-only history', corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
  note: 'Same 6,000-character context budget as the first sweep. Larger chunk caps pack more short posts. Choose on development questions only.', chosen: results[0], results };
writeFileSync('bench/runs/discussions/context-packing.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, results: undefined, chosen: { ...report.chosen, rows: undefined } }, null, 2));
