import { writeFileSync } from 'node:fs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { effectiveQuery, evaluateRanking, summarize } from './corpus.mjs';
import { questionParts, interleave } from './query-planning.mjs';
import { fuseRanks } from '../retrieval/ranking.mjs';

const dataset = loadDataset(), lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const results = [];
for (const sourceScoped of [true, false]) for (const queryMode of ['raw', 'history']) for (const method of ['bm25', 'character-hybrid', 'subquestions-rrf', 'subquestions-interleave']) {
  const latencies = [];
  const rows = dataset.cases.map((item) => {
    const start = performance.now(), scope = sourceScoped ? { sourceId: item.sourceId } : {};
    const query = effectiveQuery(item, queryMode);
    const retrieve = (text) => fuseRanks([lexical.search(text, scope), characters.search(text, scope)], { weights: [1, 0.5], k: 20 });
    let ranking = method === 'bm25' ? lexical.search(query, scope) : retrieve(query);
    const parts = queryMode === 'history' ? questionParts(item) : questionParts({ ...item, history: [] });
    if (parts.length > 1 && method.startsWith('subquestions-')) {
      const rankings = parts.map(retrieve);
      ranking = method === 'subquestions-rrf' ? fuseRanks([ranking, ...rankings], { k: 20 }) : interleave(rankings);
    }
    latencies.push(performance.now() - start);
    return { ...evaluateRanking(item, ranking), partition: item.partition };
  });
  results.push({ sourceScoped, queryMode, method, meanQueryMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    development: summarize(rows.filter((r) => r.partition === 'development')), validation: summarize(rows.filter((r) => r.partition === 'validation')),
    overall: summarize(rows), bySource: Object.fromEntries([...new Set(rows.map((r) => r.sourceId))].map((id) => [id, summarize(rows.filter((r) => r.sourceId === id))])), rows });
}
writeFileSync('bench/runs/discussions/diagnostics.json', JSON.stringify({ scope: 'Ed/Piazza only', corpusHash: dataset.corpusHash, queryHash: dataset.queryHash, results }, null, 2), { mode: 0o600 });
console.log(JSON.stringify(results.map((r) => ({ ...r, rows: undefined, bySource: undefined })), null, 2));
