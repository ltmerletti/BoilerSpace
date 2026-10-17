import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { discussionCorpus, effectiveQuery, evaluateRanking, partitionCases, resolveCases, summarize } from './corpus.mjs';
import { lexicalIndex, feedbackQuery } from './lexical.mjs';
import { fuseRanks } from '../retrieval/ranking.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const discussions = JSON.parse(readFileSync(path.join(root, '.verify-tmp/retrieval-discussions.json'))).discussions;
const cases = partitionCases(resolveCases(discussions, JSON.parse(readFileSync(path.join(root, '.verify-tmp/discussion-retrieval/cases.json')))));
const variants = [];
for (const unit of ['thread', 'message']) for (const size of [400, 700, 1000, 1500]) {
  for (const overlap of [0, Math.min(150, Math.floor(size / 4))]) variants.push({ unit, size, overlap, questionChars: 240 });
}
for (const questionChars of [0, 500]) variants.push({ unit: 'message', size: 700, overlap: 150, questionChars });
for (const size of [700, 1000]) variants.push({ unit: 'message', size, overlap: 150, questionChars: 240, paragraphs: true });
const results = [];
for (const representation of variants) {
  const entries = discussionCorpus(discussions, representation);
  for (const titleWeight of [1, 3]) {
    const lexical = lexicalIndex(entries, { titleWeight });
    const characters = lexicalIndex(entries, { characters: true, titleWeight });
    for (const queryMode of ['raw', 'history']) {
      const rankings = Object.fromEntries(['bm25', 'expanded', 'character-hybrid', 'feedback', 'subquestions'].map((key) => [key, []]));
      const latencies = Object.fromEntries(Object.keys(rankings).map((key) => [key, []]));
      for (const item of cases) {
        const query = effectiveQuery(item, queryMode), scope = { sourceId: item.sourceId };
        let started = performance.now();
        const base = lexical.search(query, scope);
        rankings.bm25.push(base); latencies.bm25.push(performance.now() - started);
        started = performance.now();
        rankings.expanded.push(fuseRanks([base, lexical.search(query, { ...scope, expand: true })], { weights: [1, 0.5], k: 20 }));
        latencies.expanded.push(latencies.bm25.at(-1) + performance.now() - started);
        started = performance.now();
        rankings['character-hybrid'].push(fuseRanks([base, characters.search(query, scope)], { weights: [1, 0.5], k: 20 }));
        latencies['character-hybrid'].push(latencies.bm25.at(-1) + performance.now() - started);
        started = performance.now();
        rankings.feedback.push(fuseRanks([base, lexical.search(feedbackQuery(query, base), scope)], { weights: [1, 0.5], k: 20 }));
        latencies.feedback.push(latencies.bm25.at(-1) + performance.now() - started);
        started = performance.now();
        const pieces = query.split(/\band\b(?=\s+(?:what|how|which|where|are|is|can|do|does|why|when|am|should))/i);
        rankings.subquestions.push(pieces.length > 1 ? fuseRanks(pieces.map((part) => lexical.search(part, scope)), { k: 20 }) : base);
        latencies.subquestions.push(latencies.bm25.at(-1) + performance.now() - started);
      }
      for (const [method, ranking] of Object.entries(rankings)) for (const diversify of [false, true]) {
        const rows = cases.map((item, i) => ({ ...evaluateRanking(item, ranking[i], { diversify }), partition: item.partition }));
        results.push({ representation, titleWeight, queryMode, method, diversify, entries: entries.length,
          meanQueryMs: latencies[method].reduce((sum, n) => sum + n, 0) / cases.length,
          development: summarize(rows.filter((r) => r.partition === 'development')),
          validation: summarize(rows.filter((r) => r.partition === 'validation')),
          overall: summarize(rows), rows });
      }
    }
  }
  console.log('Completed', JSON.stringify(representation), entries.length, 'passages.');
}
// Choose using development questions. The displayed validation metrics do not choose parameters.
results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10);
const report = { at: new Date().toISOString(), scope: 'Ed/Piazza only', threads: discussions.sources.reduce((sum, s) => sum + s.threads.length, 0),
  sources: discussions.sources.map((s) => ({ id: s.id, threads: s.threads.length, historyComplete: s.historyComplete })),
  cases: cases.length, developmentCases: cases.filter((c) => c.partition === 'development').length,
  validationCases: cases.filter((c) => c.partition === 'validation').length,
  note: 'Manually authored paraphrases of captured discussions. The discussion sourceId is supplied; course routing is not tested. Split by connected expected threads. Validation is separate for parameter selection, not an independently collected unseen test. Metrics require complete labeled answer spans and fixed 6,000-character / six-chunk context budgets.',
  chosen: results[0], results };
mkdirSync(path.join(root, 'bench/runs/discussions'), { recursive: true });
writeFileSync(path.join(root, 'bench/runs/discussions/lexical-sweep.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ cases: report.cases, development: report.developmentCases, validation: report.validationCases,
  configurations: results.length, chosen: { ...report.chosen, rows: undefined } }, null, 2));
