import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { loadDataset } from './dataset.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { cosine, fuseRanks } from '../retrieval/ranking.mjs';
import { createHash } from 'node:crypto';
import { comparePaired, holm } from './statistics.mjs';
import { validateBenchmark } from './validate-benchmark.mjs';

process.umask(0o077);
const root = process.cwd();
const sealedArgument = process.argv.indexOf('--sealed');
const sealedDirectory = sealedArgument < 0 ? null : process.argv[sealedArgument + 1];
if (sealedArgument >= 0 && !sealedDirectory) throw new Error('--sealed requires a benchmark directory.');
const seal = sealedDirectory ? JSON.parse(readFileSync(path.join(sealedDirectory, 'sealed.json'))) : null;
if (seal) {
  for (const [file, digest] of Object.entries(seal.hashes)) {
    if (createHash('sha256').update(readFileSync(file)).digest('hex') !== digest) throw new Error(`Sealed benchmark changed: ${file}`);
  }
  if (!process.argv.includes('--f16')) throw new Error('The sealed primary comparison requires --f16.');
}
const dataset = loadDataset(undefined, seal ? { casesPath: path.join(sealedDirectory, 'cases.json'), preservePartitions: true } : {});
if (seal) validateBenchmark(JSON.parse(readFileSync('.verify-tmp/retrieval-discussions.json')).discussions, dataset.cases,
  { development: JSON.parse(readFileSync('.verify-tmp/discussion-retrieval/cases.json')), primaryCount: seal.primaryQuestions });
const assets = path.join(root, '.verify-tmp/discussion-retrieval/ram-research/RikkaBotan--stable-static-embedding-fast-retrieval-mrl-en-v2');
const model = { repo: 'RikkaBotan/stable-static-embedding-fast-retrieval-mrl-en-v2', revision: '928b418b2741b7f7b1b557a53845ac88ad5054c4' };
const variant = process.argv.includes('--f16') ? 'f16' : process.argv.includes('--256') ? '256' : 'f32';
model.variant = variant;
const routes = new Map([
  ['/tokenizers.mjs', path.join(root, 'experiments/retrieval/modern-js/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs')],
  ['/weights', path.join(assets, variant === 'f32' ? 'model.safetensors' : `model-${variant}.safetensors`)], ['/tokenizer.json', path.join(assets, 'tokenizer.json')],
]);
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') { response.end('<!doctype html><title>Local static retrieval experiment</title>'); return; }
  const allowed = /^\/source\/(?:extension\/lib\/[a-z-]+\.js|experiments\/discussions\/(?:lexical|static-embedding)\.mjs|experiments\/retrieval\/ranking\.mjs)$/.test(pathname);
  const filename = routes.get(pathname) ?? (allowed ? path.join(root, pathname.slice('/source/'.length)) : null);
  if (!filename) { response.writeHead(404); response.end(); return; }
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', pathname.endsWith('.mjs') || pathname.endsWith('.js') ? 'text/javascript' : 'application/octet-stream');
  response.setHeader('Content-Length', statSync(filename).size);
  createReadStream(filename).pipe(response);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, timer, peakRss = 0;
try {
  browser = await chromium.launch({ headless: true });
  const cdp = await browser.newBrowserCDPSession();
  const sample = async () => {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const text = execFileSync('ps', ['-o', 'rss=', '-p', processInfo.map((p) => p.id).join(',')], { encoding: 'utf8' });
    return text.trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0) * 1024;
  };
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  await page.goto(origin);
  await page.evaluate(async ({ entries, texts, queries, sourceIds }) => {
    const { lexicalIndex } = await import('/source/experiments/discussions/lexical.mjs');
    const ranking = await import('/source/experiments/retrieval/ranking.mjs');
    window.experiment = { entries, texts, queries, sourceIds, lexicalIndex, ...ranking, lexical: lexicalIndex(entries) };
  }, { entries: dataset.entries, texts: dataset.texts, queries: dataset.queries, sourceIds: dataset.cases.map((c) => c.sourceId) });
  // The baseline already contains the discussion corpus and keyword index.
  const baselineSamples = [];
  for (let i = 0; i < 3; i++) baselineSamples.push(await sample());
  const baselineRss = baselineSamples.reduce((a, b) => a + b, 0) / baselineSamples.length;
  let sampling = false;
  timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try { peakRss = Math.max(peakRss, await sample()); } catch { /* Browser process snapshots can race exits. */ }
    finally { sampling = false; }
  }, 50);
  const probeFile = variant === 'f32' ? 'public-parity.json' : `public-parity-${variant}.json`;
  const first = await page.evaluate(async ({ probes }) => {
    const state = window.experiment, { Tokenizer } = await import('/tokenizers.mjs');
    const { staticEncoder } = await import('/source/experiments/discussions/static-embedding.mjs');
    const tokenizer = new Tokenizer(await (await fetch('/tokenizer.json')).json(), {});
    state.encoder = staticEncoder(tokenizer, await (await fetch('/weights')).arrayBuffer());
    const parity = probes.map((p) => ({ ids: tokenizer.encode(p.text, { add_special_tokens: false }).ids, vector: [...state.encoder.encode(p.text)] }));
    const start = performance.now();
    state.documents = state.texts.map((text) => state.encoder.encode(text));
    state.characters = state.lexicalIndex(state.entries, { characters: true });
    const indexMs = performance.now() - start;
    state.retrieve = (i, blend = null) => {
      const query = state.queries[i], sourceId = state.sourceIds[i], vector = state.encoder.encode(query);
      const semantic = state.entries.flatMap((entry, j) => entry.sourceId === sourceId ? [{ ...entry, score: state.cosine(state.documents[j], vector) }] : [])
        .sort((a, b) => b.score - a.score).slice(0, 50);
      const bm25 = state.lexical.search(query, { sourceId }), character = state.characters.search(query, { sourceId });
      if (!blend) return [semantic, bm25, character].map((rows) => rows.map((r) => state.positions.get(state.passageKey(r))));
      return state.fuseRanks([semantic, bm25, character], { weights: [1, blend.lexicalWeight, blend.characterWeight], k: blend.k })
        .map((entry) => state.positions.get(state.passageKey(entry)));
    };
    state.positions = new Map(state.entries.map((e, i) => [state.passageKey(e), i]));
    return { parity, indexMs, weightBytes: state.encoder.weightBytes, dimensions: state.encoder.dimensions,
      rankings: state.queries.map((_, i) => state.retrieve(i)), vectorBytes: state.documents.reduce((sum, v) => sum + v.byteLength, 0) };
  }, { probes: JSON.parse(readFileSync(path.join(assets, probeFile))) });
  const probes = JSON.parse(readFileSync(path.join(assets, probeFile)));
  for (const [i, probe] of probes.entries()) {
    if (JSON.stringify(probe.ids) !== JSON.stringify(first.parity[i].ids) || cosine(probe.vector, first.parity[i].vector) < 0.999999) throw new Error('Static inference differs from the PyTorch public-pair reference.');
  }
  const results = [];
  const blends = seal ? [seal.configurations.sse] : [0.25, 0.5, 1, 2].flatMap(lexicalWeight => [0, 0.25, 0.5]
    .flatMap(characterWeight => [10, 20, 60].map(k => ({ lexicalWeight, characterWeight, k }))));
  for (const { lexicalWeight, characterWeight, k } of blends) {
    const rows = dataset.cases.map((item, i) => {
      const lists = first.rankings[i].map((ranking) => ranking.map((index) => dataset.entries[index]));
      return { ...evaluateRanking(item, fuseRanks(lists, { weights: [1, lexicalWeight, characterWeight], k }), { budget: 6000, maxChunks: 12 }), partition: item.partition };
    });
    results.push({ lexicalWeight, characterWeight, k, development: summarize(rows.filter((r) => r.partition === 'development')),
      validation: summarize(rows.filter((r) => r.partition === 'validation')), overall: summarize(rows) });
  }
  if (!seal) results.sort((a, b) => b.development.allEvidenceInContext - a.development.allEvidenceInContext || b.development.mrrAt10 - a.development.mrrAt10);
  const final = await page.evaluate(({ blend }) => {
    const state = window.experiment, latencies = [], rankings = [];
    for (let i = 0; i < state.queries.length; i++) {
      const start = performance.now(); rankings.push(state.retrieve(i, blend)); latencies.push(performance.now() - start);
    }
    return { latencies, rankings };
  }, { blend: results[0] });
  const afterRss = await sample(); peakRss = Math.max(peakRss, afterRss);
  const rows = dataset.cases.map((item, i) => ({ ...evaluateRanking(item, final.rankings[i].map((index) => dataset.entries[index]), { budget: 6000, maxChunks: 12 }), partition: item.partition }));
  let frozen = null;
  if (seal) {
    const evaluate = rankingFor => dataset.cases.map((item, i) => evaluateRanking(item, rankingFor(i), { budget: 6000, maxChunks: 12 }));
    const lists = first.rankings.map(rankings => rankings.map(indices => indices.map(index => dataset.entries[index])));
    const characterConfig = seal.configurations.character;
    const characterRows = evaluate(i => fuseRanks([lists[i][1], lists[i][2]], { weights: characterConfig.weights, k: characterConfig.k }));
    const bm25Rows = evaluate(i => lists[i][1]);
    const primary = dataset.cases.filter(c => c.primary), primaryIds = new Set(primary.map(c => c.id));
    const primaryOnly = items => items.filter(r => primaryIds.has(r.id));
    const compare = reference => comparePaired(primary, primaryOnly(rows), primaryOnly(reference));
    const primaryContrast = compare(characterRows), secondaryContrast = compare(bm25Rows);
    const familywise = holm([primaryContrast.mcnemar.p, secondaryContrast.mcnemar.p]);
    const methods = Object.fromEntries([['sse', rows], ['bm25-character', characterRows], ['bm25', bm25Rows]].map(([name, methodRows]) => [name,
      { primary: summarize(primaryOnly(methodRows)), challenges: summarize(methodRows.filter(r => !primaryIds.has(r.id))),
        bySource: Object.fromEntries([...new Set(primary.map(c => c.sourceId))].map(source => [source, summarize(primaryOnly(methodRows).filter(r => r.sourceId === source))])), rows: methodRows }]));
    frozen = { seal, methods, primaryContrast, secondaryContrast,
      exploratoryTwoContrastHolm: familywise, combinedContrast: comparePaired(dataset.cases, rows, characterRows),
      note: 'No search, model, chunking, or fusion settings were selected using these questions. Only the prespecified SSE/BM25-character contrast is primary.' };
  }
  const sorted = [...final.latencies].sort((a, b) => a - b);
  const report = { at: new Date().toISOString(), model, runtime: 'Chromium pure JavaScript, tokenizers.js 0.2.0, no ONNX or transformer runtime',
    corpusHash: dataset.corpusHash, queryHash: dataset.queryHash, scope: 'Ed/Piazza, known sourceId, user-only history, 6,000-character / 12-chunk context',
    baselineRss, baselineSamples, peakRss, afterRss, peakExtraRssBytes: peakRss - baselineRss, afterExtraRssBytes: afterRss - baselineRss,
    memoryNote: 'Increment over the same isolated browser after discussion corpus and BM25 index load. Includes tokenizer, static weights, vectors, character index, and query work. RSS can double-count shared pages; process allocation and GC cause noise. Not a per-device guarantee.',
    weightBytes: first.weightBytes, vectorBytes: first.vectorBytes, indexMs: first.indexMs,
    publicParityMinimumCosine: Math.min(...probes.map((p, i) => cosine(p.vector, first.parity[i].vector))),
    meanQueryMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95QueryMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
    chosen: { ...results[0], overall: summarize(rows) }, results, rows, frozen };
  const output = seal ? path.join(sealedDirectory, 'frozen-results.json') : `bench/runs/discussions/browser-static-sse-v2-${variant}.json`;
  writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, results: undefined, rows: undefined, frozen: frozen ? { ...frozen,
    methods: Object.fromEntries(Object.entries(frozen.methods).map(([k,v])=>[k,{...v,rows:undefined}])), seal: undefined } : undefined }, null, 2));
} finally {
  clearInterval(timer); await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
