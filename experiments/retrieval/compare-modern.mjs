// Compare modern local embedding backends against exactly the existing lexical baseline.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fuseRanks, passageKey, rankingMetrics, vectorSearch } from './ranking.mjs';
import { readVectorFile } from './vector-file.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; };
const datasetFile = path.resolve(root, option('--dataset', '.verify-tmp/retrieval-modern-dataset.json'));
const dataset = JSON.parse(readFileSync(datasetFile));
const models = JSON.parse(readFileSync(new URL('./modern-models.json', import.meta.url)))
  .filter((m) => option('--model', '') ? option('--model', '').split(',').includes(m.name)
    : !m.referenceOnly || args.includes('--include-references'));
if (!models.length) throw new Error('No matching models.');
const cache = path.join(root, '.verify-tmp/retrieval-modern');
const out = path.resolve(root, option('--out', 'bench/runs/retrieval-modern.json'));
mkdirSync(cache, { recursive: true });
mkdirSync(path.dirname(out), { recursive: true });
const report = { ...dataset.report, at: new Date().toISOString(), models: [], failures: [] };
const measure = (rankings) => dataset.queries.map((q, i) => ({ id: q.id, group: q.group,
  rank: rankings[i].findIndex((e) => q.relevant.includes(passageKey(e))) + 1 }));
for (const model of models) {
  console.log(`Starting ${model.name}`);
  const metadataFile = path.join(cache, `${model.name}-${dataset.report.corpusHash}.json`);
  const processResult = spawnSync(model.backend === 'onnx' ? process.execPath : path.resolve(root, option('--python', '.verify-tmp/retrieval-venv/bin/python')),
    [fileURLToPath(new URL(model.backend === 'onnx' ? './modern-js/embed.mjs' : model.backend === 'mlx' ? './embed-mlx.py' : './embed-modern.py', import.meta.url)), '--dataset', datasetFile,
      '--model', JSON.stringify(model), '--cache', cache, '--out', metadataFile], { stdio: 'inherit' });
  if (processResult.status !== 0) {
    report.failures.push({ name: model.name, exitCode: processResult.status, signal: processResult.signal,
      error: processResult.error?.message });
  } else {
    const metadata = JSON.parse(readFileSync(metadataFile));
    if (metadata.corpusHash !== dataset.report.corpusHash) throw new Error('Corpus mismatch.');
    const vectors = readVectorFile(metadata.documents, dataset.entries.length, metadata.dimensions);
    const queryVectors = readVectorFile(metadata.queries, dataset.queries.length, metadata.dimensions);
    const semantic = dataset.queries.map((q, i) => vectorSearch(dataset.entries, vectors, queryVectors[i], { courseId: q.courseId }));
    const hybrid = semantic.map((ranks, i) => fuseRanks([dataset.baseline[i], ranks]));
    const semanticRows = measure(semantic), hybridRows = measure(hybrid);
    const row = { ...metadata, semantic: rankingMetrics(semanticRows), hybrid: rankingMetrics(hybridRows),
      discussionProbes: { semantic: rankingMetrics(semanticRows.filter((r) => r.group === 'discussion-probe')),
        hybrid: rankingMetrics(hybridRows.filter((r) => r.group === 'discussion-probe')) },
      rows: hybridRows.map((r, i) => ({ ...r, semanticRank: semanticRows[i].rank })) };
    report.models.push(row);
    console.log(model.name, JSON.stringify({ ...row, rows: undefined }));
  }
  writeFileSync(out, JSON.stringify(report, null, 2), { mode: 0o600 });
}
console.log(`Local report: ${out}`);
if (report.failures.length) process.exitCode = 1;
