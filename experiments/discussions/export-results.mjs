// Publish aggregate measurements only. Never copy rows, questions or source text.
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const read = file => JSON.parse(readFileSync(file, 'utf8'));
const expanded = '.verify-tmp/discussion-retrieval/v2/extended/';
const shipping = '.verify-tmp/discussion-retrieval/production/';
const summary = read(expanded + 'summary.json');
const controls = read(expanded + 'candidate-controls.json');
const scores = value => Object.fromEntries(['cases', 'hitAt1', 'hitAt5', 'hitAt10', 'mrrAt10', 'allEvidenceAt5', 'allEvidenceInContext', 'evidenceRecallInContext', 'meanContextChars']
  .filter(key => Number.isFinite(value?.[key])).map(key => [key, value[key]]));
const checkDiscussion = report => {
  assert.equal(report.corpusHash, summary.corpusHash, 'Discussion corpora differ.');
  assert.equal(report.queryHash, summary.queryHash, 'Discussion questions differ.');
};
const publicMethod = method => ({ name: method.name, primary: scores(method.primary), challenges: scores(method.challenges),
  ...(method.lowOverlap ? { lowLexicalOverlap: scores(method.lowOverlap) } : {}) });
const methods = summary.methods.map(publicMethod);
for (const [name, file] of [['potion-f16-hybrid', 'chromium-f16.json'], ['potion-i8-hybrid', 'chromium-extension.json']]) {
  const report = read(shipping + file); checkDiscussion(report);
  methods.push(publicMethod({ name, ...report }));
}
const browserRuns = ['chromium-worker-1.json', 'chromium-worker.json', 'zen-extension.json'].map(file => {
  const report = read(shipping + file); checkDiscussion(report);
  return { engine: file.startsWith('zen') ? 'Zen Firefox' : 'Chromium', extraRssBytes: report.peakExtraRssBytes,
    coldMs: report.coldMs ?? report.coldToolMs, p95WarmMs: report.p95QueryMs ?? report.p95WarmToolMs };
});
const contrasts = summary.contrasts.map(item => ({ method: item.method,
  completeEvidence: { difference: item.completeness.difference.estimate, wins: item.completeness.mcnemar.candidateOnly,
    losses: item.completeness.mcnemar.referenceOnly, exactP: item.completeness.mcnemar.p, holmP: item.holmCompletenessP,
    pairedCI95: [item.completeness.difference.low, item.completeness.difference.high],
    sourceTopicCI95: [item.completeness.sourceTopicSensitivity.low, item.completeness.sourceTopicSensitivity.high] },
  firstResult: { difference: item.firstResult.difference.estimate, exactP: item.firstResult.mcnemar.p, holmP: item.holmFirstResultP } }));
checkDiscussion(controls);

const courseFiles = ['retrieval-modern-core.json', 'retrieval-modern-remaining.json', 'retrieval-modern-quantized.json',
  'retrieval-granite-r2.json', 'retrieval-arctic.json', 'retrieval-minilm.json'];
const courseReports = courseFiles.map(file => read('bench/runs/' + file));
const courseReference = courseReports[0], courseModels = new Map();
for (const report of courseReports) {
  assert.equal(report.corpusHash, courseReference.corpusHash, 'Course corpora differ.');
  assert.equal(report.evaluatedCases, 128, 'Exclude smoke tests from the published comparison.');
  for (const model of report.models) {
    assert.equal(model.semantic.cases, 128);
    courseModels.set(model.name, { name: model.name, semantic: scores(model.semantic), hybrid: scores(model.hybrid) });
  }
}
const early = ['mxbai-xsmall-q4-thread', 'mxbai-xsmall-q8-thread', 'mxbai-xsmall-q4-t256-thread', 'jina5-nano-q4-thread', 'jina5-nano-q8-thread',
  'mxbai-xsmall-q8-message', 'browser-static-sse-v2-f32', 'browser-static-sse-v2-256', 'browser-static-sse-v2-f16'].map(name => {
  const report = read(`bench/runs/discussions/${name}.json`), selected = report.chosen;
  assert.equal(selected.overall.cases, 65);
  return { name, overall: scores(selected.overall), development: scores(selected.development), validation: scores(selected.validation) };
});
const output = {
  schemaVersion: 1, evaluatedOn: '2026-10-16', productionMethod: 'potion-i8-hybrid',
  discussions: { corpusHash: summary.corpusHash, queryHash: summary.queryHash, threads: 1448, passages: 1637,
    primaryQuestions: 300, relatedChallenges: 30, unscoredDiagnostics: 12, sourceTopicGroups: 80,
    representation: { unit: 'thread', chunkChars: 1000, overlapChars: 150 }, context: { maxChars: 6000, maxPassages: 12 },
    scope: 'Known discussion source; user-only history; exact labeled source-span coverage.', methods, browserRuns, contrasts,
    candidateControls: controls.methods.map(method => ({ ...publicMethod(method), candidateEvidenceCeiling: controls.ceilings[method.name] })),
    earlierDevelopment: { questions: 65, development: 39, validation: 26, methods: early } },
  earlierCourseMaterial: { documents: 3350, passages: 4065, questions: 128, excludedQuestions: 43,
    scope: 'Development course-material retrieval; only two discussion probes. Not comparable to the discussion benchmark.',
    bm25SixResults: scores(courseReference.bm25Production), bm25Wide: scores(courseReference.bm25Wide), models: [...courseModels.values()] },
};
const target = new URL('./results.json', import.meta.url);
writeFileSync(target, JSON.stringify(output, null, 2) + '\n');
if (process.argv.includes('--update-readme')) {
  const titles = { bm25: 'BM25', 'bm25-character': 'BM25 + character trigrams',
    'potion-i8-hybrid': '**POTION int8 + BM25 (production)**', 'potion-f16-hybrid': 'POTION float16 + BM25',
    'potion-32m-pure': 'POTION float32, semantic only', 'potion-32m-hybrid': 'POTION float32 + BM25',
    'sse-f16-pure': 'SSE float16, semantic only', 'sse-f16-hybrid': 'SSE float16 + BM25',
    'colbert-lexical-pure': 'ColBERT keyword 20, MaxSim', 'colbert-lexical-hybrid': 'ColBERT keyword 20, fused',
    'colbert-union-pure': 'ColBERT keyword + SSE, MaxSim', 'colbert-union-hybrid': 'ColBERT keyword + SSE, fused' };
  for (const quant of ['q4', 'q8']) for (const [family, title] of [['mxbai-xsmall', 'Mixedbread xsmall'], ['jina5-nano', 'Jina v5 Nano']]) {
    titles[`${family}-${quant}-pure`] = `${title} ${quant}, semantic only`;
    titles[`${family}-${quant}-hybrid`] = `${title} ${quant}, hybrid`;
  }
  const percent = value => (value * 100).toFixed(1) + '%';
  const count = (value, key = 'allEvidenceInContext') => `${Math.round(value[key] * value.cases)}/${value.cases}`;
  const ordered = [methods.find(method => method.name === output.productionMethod), ...methods.filter(method => method.name !== output.productionMethod)];
  const discussionTable = ['| Method | Complete, main 300 | First | Complete, challenges |', '| --- | ---: | ---: | ---: |',
    ...ordered.map(method => `| ${titles[method.name]} | ${count(method.primary)} (${percent(method.primary.allEvidenceInContext)}) | ${percent(method.primary.hitAt1)} | ${count(method.challenges)} |`)].join('\n');
  const courseTable = ['| Configuration | Semantic Hit@1 | Hit@5 | Hit@10 | MRR@10 | Hybrid Hit@5 |', '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| BM25 wide | ${percent(output.earlierCourseMaterial.bm25Wide.hitAt1)} | ${percent(output.earlierCourseMaterial.bm25Wide.hitAt5)} | ${percent(output.earlierCourseMaterial.bm25Wide.hitAt10)} | ${output.earlierCourseMaterial.bm25Wide.mrrAt10.toFixed(3)} | n/a |`,
    ...output.earlierCourseMaterial.models.map(model => `| ${model.name} | ${percent(model.semantic.hitAt1)} | ${percent(model.semantic.hitAt5)} | ${percent(model.semantic.hitAt10)} | ${model.semantic.mrrAt10.toFixed(3)} | ${percent(model.hybrid.hitAt5)} |`)].join('\n');
  const file = new URL('./README.md', import.meta.url);
  let markdown = readFileSync(file, 'utf8');
  for (const [name, table] of [['discussion-results', discussionTable], ['course-results', courseTable]]) {
    const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
    assert.equal(markdown.split(start).length, 2); assert.equal(markdown.split(end).length, 2);
    const from = markdown.indexOf(start) + start.length, to = markdown.indexOf(end);
    markdown = markdown.slice(0, from) + '\n' + table + '\n' + markdown.slice(to);
  }
  writeFileSync(file, markdown);
}
console.log(`Published ${methods.length} discussion methods and ${courseModels.size} earlier course configurations; aggregate metrics only.`);
