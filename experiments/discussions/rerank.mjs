import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { localModel, loadRerankerHead } from './local-model.mjs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { fuseRanks, passageKey } from '../retrieval/ranking.mjs';

process.umask(0o077);
const spec = { name: 'ettin-17m-q8', repo: 'cross-encoder/ettin-reranker-17m-v1',
  revision: '9e4aa35321a6dd1a43ca313f500c4b4f7cfb5cc6',
  directory: '.verify-tmp/discussion-retrieval/models/cross-encoder/ettin-reranker-17m-v1',
  file: 'onnx/model_qint8_arm64.onnx', maxTokens: 512 };
const model = await localModel(spec), head = loadRerankerHead(spec.directory);
const scorePair = async (query, text) => head((await model.forward(query, text)).last_hidden_state.data);
const probe = await model.forward('Which planet is red?', 'Mars is called the red planet.');
mkdirSync('.verify-tmp/discussion-retrieval', { recursive: true });
writeFileSync('.verify-tmp/discussion-retrieval/head-parity.json', JSON.stringify({ hidden: [...probe.last_hidden_state.data.slice(0, 256)], score: head(probe.last_hidden_state.data) }));
if (process.argv.includes('--probe')) {
  console.log('Public reranker probe score:', head(probe.last_hidden_state.data));
  await model.close();
} else {
  const dataset = loadDataset(), lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
  const rankings = [], pairTimings = [];
  for (const [i, item] of dataset.cases.entries()) {
    const query = dataset.queries[i], scope = { sourceId: item.sourceId };
    const base = fuseRanks([lexical.search(query, scope), characters.search(query, scope)], { weights: [1, 0.5], k: 20 });
    const scored = [], latencies = [];
    for (const entry of base.slice(0, 40)) {
      const start = performance.now();
      scored.push({ ...entry, score: await scorePair(query, `${entry.title}\n${entry.text}`) });
      latencies.push(performance.now() - start);
    }
    rankings.push({ base, scored }); pairTimings.push(latencies);
    if (i % 10 === 0) console.log(`Reranked ${i + 1}/${dataset.cases.length} discussion questions`);
  }
  const results = [];
  for (const count of [5, 10, 20, 40]) for (const originalWeight of [0, 0.25, 0.5, 1]) {
    const rows = dataset.cases.map((item, i) => {
      const { base, scored } = rankings[i];
      const reranked = scored.slice(0, count).sort((a, b) => b.score - a.score);
      let ranking;
      if (originalWeight) ranking = fuseRanks([reranked, base], { weights: [1, originalWeight], k: 20 });
      else {
        const seen = new Set(reranked.map(passageKey));
        ranking = [...reranked, ...base.filter((e) => !seen.has(passageKey(e)))];
      }
      return { ...evaluateRanking(item, ranking), partition: item.partition };
    });
    const latencies = pairTimings.map((row) => row.slice(0, count).reduce((a, b) => a + b, 0)).sort((a, b) => a - b);
    results.push({ count, originalWeight, meanRerankMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95RerankMs: latencies[Math.ceil(latencies.length * 0.95) - 1], development: summarize(rows.filter((r) => r.partition === 'development')),
      validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows), rows });
  }
  results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10);
  const report = { at: new Date().toISOString(), model: spec, modelBytes: model.modelBytes,
    runtime: 'Native CPU ONNX, four threads. Sequential pairs, excluding initial lexical search. Browser not verified.',
    scope: 'Ed/Piazza only, known sourceId, user-only conversation history', corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, chosen: results[0], results };
  mkdirSync('bench/runs/discussions', { recursive: true });
  writeFileSync('bench/runs/discussions/ettin-17m-q8.json', JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, results: undefined, chosen: { ...report.chosen, rows: undefined } }, null, 2));
  await model.close();
}
