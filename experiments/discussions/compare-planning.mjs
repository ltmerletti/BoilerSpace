import { readFileSync, writeFileSync } from 'node:fs';
import { loadDataset } from './dataset.mjs';
import { localModel } from './local-model.mjs';
import { lexicalIndex } from './lexical.mjs';
import { questionParts, interleave } from './query-planning.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { cosine, fuseRanks } from '../retrieval/ranking.mjs';
import { readVectorFile } from '../retrieval/vector-file.mjs';

process.umask(0o077);
const name = 'mxbai-xsmall-q8';
const spec = JSON.parse(readFileSync('experiments/discussions/models.json')).find((m) => m.name === name);
const dataset = loadDataset(), model = await localModel(spec);
const previous = JSON.parse(readFileSync(`bench/runs/discussions/${name}-thread.json`));
if (previous.corpusHash !== dataset.corpusHash || previous.queryHash !== dataset.queryHash) throw new Error('Model/corpus mismatch.');
const documents = readVectorFile(`.verify-tmp/discussion-retrieval/vectors/${name}-${dataset.corpusHash}.f32`, dataset.entries.length, spec.dimensions);
const queries = readVectorFile(`.verify-tmp/discussion-retrieval/vectors/${name}-${dataset.queryHash}.f32`, dataset.queries.length, spec.dimensions);
const lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const retrieve = (text, vector, sourceId) => {
  const semantic = dataset.entries.flatMap((entry, i) => entry.sourceId === sourceId ? [{ ...entry, score: cosine(documents[i], vector) }] : []).sort((a, b) => b.score - a.score).slice(0, 50);
  return fuseRanks([semantic, lexical.search(text, { sourceId }), characters.search(text, { sourceId })],
    { weights: [1, previous.chosen.lexicalWeight, previous.chosen.characterWeight], k: previous.chosen.k });
};
await model.embed('When is the assignment due?', spec.queryPrefix);
const rankings = [], timings = [];
for (const [i, item] of dataset.cases.entries()) {
  const started = performance.now(), parts = questionParts(item);
  const base = retrieve(dataset.queries[i], queries[i], item.sourceId), separate = [];
  if (parts.length > 1) for (const text of parts) separate.push(retrieve(text, await model.embed(text, spec.queryPrefix), item.sourceId));
  rankings.push({ base, separate }); timings.push(performance.now() - started);
}
const results = [];
for (const method of ['unchanged', 'subquestions-rrf', 'subquestions-interleave']) for (const maxChunks of [6, 12]) {
  const rows = dataset.cases.map((item, i) => {
    const { base, separate } = rankings[i];
    const ranking = !separate.length || method === 'unchanged' ? base : method === 'subquestions-rrf' ? fuseRanks([base, ...separate], { k: 20 }) : interleave(separate);
    return { ...evaluateRanking(item, ranking, { budget: 6000, maxChunks }), partition: item.partition };
  });
  results.push({ method, maxChunks, budget: 6000, development: summarize(rows.filter((r) => r.partition === 'development')),
    validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows), rows });
}
results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10 || a.maxChunks - b.maxChunks);
const report = { at: new Date().toISOString(), model: spec, corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
  scope: 'Ed/Piazza, known sourceId, user-only history, no model-generated query rewrites',
  runtime: 'Native CPU ONNX. Timing excludes the cached original query embedding; includes extra subqueries and ranking.',
  meanPlanningAndSearchMs: timings.reduce((a, b) => a + b, 0) / timings.length, chosen: results[0], results };
writeFileSync('bench/runs/discussions/query-planning.json', JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...report, results: undefined, chosen: { ...report.chosen, rows: undefined } }, null, 2));
await model.close();
