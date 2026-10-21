import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
import { localModel } from './local-model.mjs';
import { loadDataset } from './dataset.mjs';
import { cosine } from '../retrieval/ranking.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';

process.umask(0o077);
const directory = '.verify-tmp/discussion-retrieval/v2', root = process.cwd();
const json = file => JSON.parse(readFileSync(file));
const plan = json(`${directory}/extended/plan.json`);
for (const [file, expected] of Object.entries({ ...json(`${directory}/sealed.json`).hashes, ...plan.hashes })) {
  if (createHash('sha256').update(readFileSync(file)).digest('hex') !== expected) throw new Error(`Changed benchmark input: ${file}`);
}
const assets = '.verify-tmp/discussion-retrieval/models/mixedbread-ai/mxbai-edge-colbert-v0-17m';
const config = json(`${assets}/onnx_config.json`);
const spec = { directory: assets, file: 'model_int8.onnx', maxTokens: 512 };
const probeFile = `${directory}/extended/colbert-public-parity.json`;
const characterize = process.argv.includes('--characterize');
if (process.argv.includes('--prepare')) {
  const model = await localModel(spec), probes = [];
  try {
    for (const [text, query] of [['When can I submit the assignment?', true], ['The submission deadline moved to Friday.', false], ['notebook variables '.repeat(50), true]]) {
      const tokens = await model.tokenize((query ? config.query_prefix : config.document_prefix) + text.toLowerCase(), undefined,
        { max_length: query ? config.query_length : config.document_length });
      const result = (await model.run(tokens)).output;
      probes.push({ text, query, ids: [...tokens.input_ids.data].map(Number), raw: [...result.data] });
    }
  } finally { await model.close(); }
  writeFileSync(probeFile, JSON.stringify(probes), { mode: 0o600 });
  console.log('Prepared three public native ONNX probes, including truncation.'); process.exit(0);
}
const data = loadDataset(undefined, { casesPath: `${directory}/cases.json`, preservePartitions: true });
const runtimeDirectory = 'experiments/retrieval/modern-js/node_modules/onnxruntime-web/dist';
const routes = new Map([
  ['/tokenizers.mjs', 'experiments/retrieval/modern-js/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs'],
  ...['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map(f => [`/ort/${f}`, `${runtimeDirectory}/${f}`]),
  ['/model.onnx', `${assets}/model_int8.onnx`], ['/tokenizer.json', `${assets}/tokenizer.json`], ['/tokenizer_config.json', `${assets}/tokenizer_config.json`],
]);
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin'); response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  response.setHeader('Cache-Control', 'no-store');
  if (pathname === '/') { response.end('<!doctype html><title>Isolated ColBERT browser test</title>'); return; }
  const allowed = /^\/source\/(?:extension\/lib\/[a-z-]+\.js|experiments\/discussions\/(?:lexical|semantic-methods)\.mjs|experiments\/retrieval\/ranking\.mjs)$/.test(pathname);
  const filename = routes.get(pathname) ?? (allowed ? pathname.slice('/source/'.length) : null);
  if (!filename) { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(pathname) ? 'text/javascript' : 'application/octet-stream');
  response.setHeader('Content-Length', statSync(filename).size); createReadStream(path.join(root, filename)).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, timer, peakRss = 0;
try {
  browser = await chromium.launch({ headless: true });
  const cdp = await browser.newBrowserCDPSession();
  const sample = async () => {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    return execFileSync('ps', ['-o', 'rss=', '-p', processInfo.map(p => p.id).join(',')], { encoding: 'utf8' }).trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0) * 1024;
  };
  const page = await browser.newPage(), blocked = [];
  page.on('console', message => { if (message.text().startsWith('ColBERT benchmark:')) console.log(message.text()); });
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); blocked.push(route.request().url()); return route.abort(); });
  await page.goto(origin);
  await page.evaluate(async ({ entries, texts, queries, sourceIds }) => {
    const { lexicalIndex } = await import('/source/experiments/discussions/lexical.mjs');
    window.experiment = { entries, texts, queries, sourceIds, lexicalIndex, lexical: lexicalIndex(entries) };
  }, { entries: data.entries, texts: data.texts, queries: data.queries, sourceIds: data.cases.map(c => c.sourceId) });
  const baselineSamples = []; for (let i = 0; i < 3; i++) baselineSamples.push(await sample());
  const baselineRss = baselineSamples.reduce((a, b) => a + b, 0) / 3;
  let sampling = false;
  timer = setInterval(async () => { if (sampling) return; sampling = true; try { peakRss = Math.max(peakRss, await sample()); } catch { /* Process lists can race exits. */ } finally { sampling = false; } }, 75);
  const probes = json(probeFile);
  const setup = await page.evaluate(async ({ config, probes, characterize }) => {
    const s = window.experiment, ort = await import('/ort/ort.wasm.min.mjs'), { Tokenizer } = await import('/tokenizers.mjs');
    const { maxSim, rerankCandidates } = await import('/source/experiments/discussions/semantic-methods.mjs');
    const { fuseRanks, passageKey, cosine } = await import('/source/experiments/retrieval/ranking.mjs');
    ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; ort.env.wasm.wasmPaths = location.origin + '/ort/';
    const tokenizerData = await (await fetch('/tokenizer.json')).json();
    const tokenizer = new Tokenizer(tokenizerData, await (await fetch('/tokenizer_config.json')).json());
    const session = await ort.InferenceSession.create('/model.onnx', { executionProviders: ['wasm'] });
    const skip = new Set(config.skiplist_words.map(w => tokenizerData.model.vocab[w]).filter(Number.isInteger));
    const cls = tokenizerData.post_processor.special_tokens['[CLS]'].ids[0], sep = tokenizerData.post_processor.special_tokens['[SEP]'].ids[0];
    s.encode = async (text, query = false, raw = false) => {
      const max = query ? config.query_length : config.document_length;
      const content = tokenizer.encode((query ? config.query_prefix : config.document_prefix) + text.toLowerCase(), { add_special_tokens: false }).ids;
      // Match Transformers.js: its single-sequence truncation follows template
      // processing, so a truncated sequence can omit the final separator.
      const ids = [cls, ...content, sep].slice(0, max);
      const feeds = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
        attention_mask: new ort.Tensor('int64', BigInt64Array.from(ids, () => 1n), [1, ids.length]) };
      const tensor = (await session.run(feeds)).output;
      if (raw) return { ids, raw: [...tensor.data] };
      const values = [];
      for (let i = 0; i < ids.length; i++) {
        if (!query && skip.has(ids[i])) continue;
        const vector = tensor.data.slice(i * config.embedding_dim, (i + 1) * config.embedding_dim), norm = Math.hypot(...vector);
        for (const value of vector) values.push(value / norm);
      }
      return Float32Array.from(values);
    };
    const parity = [];
    for (const p of probes) {
      const result = await s.encode(p.text, p.query, true);
      const idsMatch = JSON.stringify(p.ids) === JSON.stringify(result.ids), agreement = cosine(p.raw, result.raw);
      console.log('ColBERT benchmark: public parity ' + JSON.stringify({ idsMatch, cosine: agreement, tokens: p.ids.length }));
      if (!idsMatch || !Number.isFinite(agreement) || (!characterize && agreement < .9999)) throw new Error('Browser/native public parity failed before indexing.');
      parity.push(result);
    }
    console.log('ColBERT benchmark: tokenizer verified; ' + (characterize ? 'diagnostic characterization, numeric parity may have failed.' : 'numeric parity passed.'));
    s.documents = []; const start = performance.now();
    for (const [i, text] of s.texts.entries()) {
      s.documents.push(await s.encode(text));
      if ((i + 1) % 256 === 0) console.log('ColBERT benchmark: indexed ' + (i + 1) + '/' + s.texts.length);
    }
    const indexMs = performance.now() - start;
    s.characters = s.lexicalIndex(s.entries, { characters: true });
    s.positions = new Map(s.entries.map((e, i) => [passageKey(e), i]));
    s.retrieve = async i => {
      const start = performance.now(), scope = { sourceId: s.sourceIds[i] }, query = s.queries[i];
      const base = fuseRanks([s.lexical.search(query, scope), s.characters.search(query, scope)], { weights: [1, 0.5], k: 20 });
      const vector = await s.encode(query, true);
      const ranking = rerankCandidates(base, base, e => maxSim(vector, s.documents[s.positions.get(passageKey(e))], config.embedding_dim), { count: 20, originalWeight: 0 });
      return { ranking: ranking.map(e => s.positions.get(passageKey(e))), ms: performance.now() - start };
    };
    return { parity, indexMs, vectorBytes: s.documents.reduce((sum, v) => sum + v.byteLength, 0) };
  }, { config, probes, characterize });
  const cosines = probes.map((p, i) => {
    if (JSON.stringify(p.ids) !== JSON.stringify(setup.parity[i].ids)) throw new Error('Browser tokenizer differs from native tokenizer, including truncation.');
    return cosine(p.raw, setup.parity[i].raw);
  });
  if (!characterize && Math.min(...cosines) < .9999) throw new Error('WASM/native public embedding parity failed.');
  const afterIndexRss = await sample();
  const results = await page.evaluate(async () => {
    const state = window.experiment, rows = [];
    for (let i = 0; i < state.queries.length; i++) rows.push(await state.retrieve(i)); return rows;
  });
  const afterSearchRss = await sample(); peakRss = Math.max(peakRss, afterIndexRss, afterSearchRss);
  const rows = data.cases.map((item, i) => evaluateRanking(item, results[i].ranking.map(j => data.entries[j]), { budget: 6000, maxChunks: 12 }));
  const primaryIds = new Set(data.cases.filter(c => c.primary).map(c => c.id)), sorted = results.map(r => r.ms).sort((a, b) => a - b);
  const reference = json(`${directory}/extended/colbert.json`).methods.find(m => m.name === 'colbert-lexical-pure').rows;
  const report = { at: new Date().toISOString(), status: Math.min(...cosines) < .9999 ? 'numeric_parity_failed_diagnostic_only' : 'passed',
    model: { repo: 'mixedbread-ai/mxbai-edge-colbert-v0-17m', revision: plan.colbert.revision, quant: 'int8' },
    method: 'BM25/character top 20, ColBERT rerank, no score fusion; 6000 characters / 12 chunks.',
    runtime: 'Chromium, ONNX Runtime Web WASM, one thread; standalone tokenizers.js; browser builds every document token vector.',
    primary: summarize(rows.filter(r => primaryIds.has(r.id))), challenges: summarize(rows.filter(r => !primaryIds.has(r.id))),
    baselineRss, baselineSamples, peakRss, afterIndexRss, afterSearchRss,
    peakExtraRssBytes: peakRss - baselineRss, searchExtraRssBytes: afterSearchRss - baselineRss,
    meanQueryMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95QueryMs: sorted[Math.ceil(sorted.length * .95) - 1],
    indexMs: setup.indexMs, vectorBytes: setup.vectorBytes, publicParityMinimumCosine: Math.min(...cosines),
    completenessDisagreementsWithNative: rows.filter((r, i) => r.allEvidenceInContext !== reference[i].allEvidenceInContext).map(r => r.id),
    note: 'RSS increment over corpus plus BM25. Includes ONNX/WASM, tokenizer, model, token vectors and character index. RSS can double-count shared pages; results are device-specific. This is the lexical-candidate variant, not SSE-union memory.', blockedExternalRequests: blocked.length, rows };
  writeFileSync(`${directory}/extended/colbert-browser${characterize ? '-diagnostic' : ''}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
} finally {
  clearInterval(timer); await browser?.close(); await new Promise(resolve => server.close(resolve));
}
