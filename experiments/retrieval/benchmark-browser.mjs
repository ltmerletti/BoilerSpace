// Load cached public assets over loopback to measure browser WASM without an external service.
import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';
import { readVectorFile } from './vector-file.mjs';
import { cosine } from './ranking.mjs';
import { loadDataset as discussionDataset } from '../discussions/dataset.mjs';
import { evaluateRanking, summarize } from '../discussions/corpus.mjs';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
const name = option('--model', 'jina5-nano-q4');
const browserName = option('--browser', 'chromium');
const threads = Number(option('--threads', '1'));
const isolated = args.includes('--isolated');
const device = option('--device', 'wasm');
const headless = !args.includes('--headed');
const discussions = args.includes('--discussions');
const fullIndex = args.includes('--full-index');
if (fullIndex && !discussions) throw new Error('--full-index currently requires --discussions.');
const registry = discussions ? new URL('../discussions/models.json', import.meta.url) : new URL('./modern-models.json', import.meta.url);
const registered = JSON.parse(readFileSync(registry)).find((m) => m.name === name);
const spec = discussions && registered ? { ...registered, backend: 'onnx', dtype: registered.file.includes('q4') ? 'q4' : 'q8' } : registered;
if (!spec || spec.backend !== 'onnx') throw new Error('Choose an ONNX model.');
if (![1, 2, 4].includes(threads)) throw new Error('Threads must be 1, 2 or 4.');
const discussionData = discussions ? discussionDataset() : null;
const dataset = discussions ? { report: { corpusHash: discussionData.corpusHash }, queries: discussionData.queries.map((query) => ({ query })) }
  : JSON.parse(readFileSync(path.join(root, '.verify-tmp/retrieval-modern-dataset.json')));
const metadata = discussions ? { corpusHash: discussionData.corpusHash, dimensions: spec.dimensions,
  queries: path.join(root, `.verify-tmp/discussion-retrieval/vectors/${name}-${discussionData.queryHash}.f32`) }
  : JSON.parse(readFileSync(path.join(root, `.verify-tmp/retrieval-modern/${name}.json`)));
if (metadata.corpusHash !== dataset.report.corpusHash) throw new Error('Corpus mismatch.');
const reference = readVectorFile(metadata.queries, dataset.queries.length, metadata.dimensions);
const modelAssets = discussions ? path.resolve(root, spec.directory) : path.join(root, '.verify-tmp/retrieval-modern/onnx', spec.repo, spec.revision);
const modules = path.join(root, 'experiments/retrieval/modern-js/node_modules');
const routes = [
  ['/runtime/', path.join(modules, '@huggingface/transformers/dist')],
  ['/ort/', path.join(modules, 'onnxruntime-web/dist')],
  [`/models/${spec.repo}/`, modelAssets],
];
const sourceAllowed = (pathname) => /^\/source\/(?:extension\/lib\/[a-z-]+\.js|experiments\/discussions\/lexical\.mjs|experiments\/retrieval\/ranking\.mjs)$/.test(pathname);
const server = createServer((req, res) => {
  if (isolated) {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Local embedding benchmark</title><script type="importmap">{"imports":{"onnxruntime-web/webgpu":"/ort/ort.webgpu.bundle.min.mjs","onnxruntime-common":"/ort/ort.webgpu.bundle.min.mjs"}}</script>');
    return;
  }
  const route = routes.find(([prefix]) => pathname.startsWith(prefix));
  const source = sourceAllowed(pathname);
  if (!route && !source) { res.writeHead(404); res.end(); return; }
  const directory = source ? path.resolve(root) : route[1];
  const filename = path.resolve(directory, pathname.slice(source ? '/source/'.length : route[0].length));
  if (!filename.startsWith(directory + path.sep)) { res.writeHead(403); res.end(); return; }
  try {
    const size = statSync(filename).size;
    res.setHeader('Content-Type', filename.endsWith('.wasm') ? 'application/wasm' : /\.m?js$/.test(filename) ? 'text/javascript' : 'application/octet-stream');
    res.setHeader('Content-Length', size);
    createReadStream(filename).pipe(res);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
let memoryTimer, peakBrowserRssBytes = 0;
try {
  browser = await (browserName === 'firefox' ? firefox : chromium).launch({ headless, timeout: 30000,
    ...(option('--executable', null) ? { executablePath: option('--executable') } : {}) });
  const page = await browser.newPage();
  if (browserName === 'chromium' && fullIndex) {
    const cdp = await browser.newBrowserCDPSession();
    let sampling = false;
    memoryTimer = setInterval(async () => {
      if (sampling) return;
      sampling = true;
      try {
        const info = await cdp.send('SystemInfo.getProcessInfo');
        const ids = info.processInfo.map((p) => String(p.id));
        const rss = execFileSync('ps', ['-o', 'rss=', '-p', ids.join(',')], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
        peakBrowserRssBytes = Math.max(peakBrowserRssBytes, rss.reduce((a, b) => a + b, 0) * 1024);
      } catch { /* A process can exit between the CDP and ps snapshots. */ }
      finally { sampling = false; }
    }, 500);
  }
  page.on('response', (response) => { if (response.status() >= 400) console.error('Missing local asset:', new URL(response.url()).pathname); });
  await page.route('**/*', (route) => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
  page.on('console', (message) => {
    if (message.type() === 'error') console.error('Browser:', message.text());
    else if (message.text().startsWith('Discussion index:')) console.log(message.text());
  });
  await page.goto(origin);
  const blend = fullIndex ? JSON.parse(readFileSync(path.join(root, `bench/runs/discussions/${name}-thread.json`))).chosen : null;
  const evaluation = page.evaluate(async ({ spec, queries, threads, origin, device, fullIndex, texts, entries, sourceIds, blend }) => {
    const { env, AutoModel, AutoTokenizer } = await import(`${origin}/runtime/transformers.web.js`);
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = '/models/';
    env.useBrowserCache = false;
    env.backends.onnx.wasm.wasmPaths = `${origin}/ort/`;
    env.backends.onnx.wasm.numThreads = threads;
    const started = performance.now();
    const tokenizer = await AutoTokenizer.from_pretrained(spec.repo);
    const model = await AutoModel.from_pretrained(spec.repo, { dtype: spec.dtype, device });
    const loadMs = performance.now() - started;
    const encode = async (query, prefix = spec.queryPrefix) => {
      const inputs = await tokenizer(prefix + query, { truncation: true, max_length: spec.maxTokens });
      const output = await model(inputs);
      const vector = output.sentence_embedding?.tolist()[0];
      if (!vector || !vector.every(Number.isFinite)) throw new Error('Invalid browser embedding.');
      return vector;
    };
    // Warm-up is excluded from steady-state latency and reported separately.
    const warmStart = performance.now();
    await encode(queries[0]);
    const firstQueryMs = performance.now() - warmStart;
    let documents, lexical, characters, cosine, fuseRanks, passageKey, positions, indexMs;
    if (fullIndex) {
      const indexing = performance.now();
      const search = await import('/source/experiments/discussions/lexical.mjs');
      ({ cosine, fuseRanks, passageKey } = await import('/source/experiments/retrieval/ranking.mjs'));
      documents = [];
      for (const [i, text] of texts.entries()) {
        documents.push(await encode(text, spec.documentPrefix));
        if (i % 256 === 0) console.log(`Discussion index: ${i + 1}/${texts.length}`);
      }
      lexical = search.lexicalIndex(entries); characters = search.lexicalIndex(entries, { characters: true });
      positions = new Map(entries.map((entry, i) => [passageKey(entry), i]));
      indexMs = performance.now() - indexing;
    }
    const vectors = [], latencies = [], rankings = [], totalLatencies = [];
    for (const [i, query] of queries.entries()) {
      const start = performance.now();
      const vector = await encode(query);
      vectors.push(vector);
      latencies.push(performance.now() - start);
      if (fullIndex) {
        const scope = { sourceId: sourceIds[i] };
        const semantic = entries.flatMap((entry, j) => entry.sourceId === sourceIds[i] ? [{ ...entry, score: cosine(documents[j], vector) }] : [])
          .sort((a, b) => b.score - a.score).slice(0, 50);
        const ranking = fuseRanks([semantic, lexical.search(query, scope), characters.search(query, scope)],
          { weights: [1, blend.lexicalWeight, blend.characterWeight], k: blend.k });
        rankings.push(ranking.map((entry) => positions.get(passageKey(entry))));
        totalLatencies.push(performance.now() - start);
      }
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    await model.dispose();
    return { loadMs, firstQueryMs, vectors, latencies, rankings, totalLatencies, indexMs,
      meanQueryMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      medianQueryMs: sorted[Math.floor(sorted.length / 2)], p95QueryMs: sorted[Math.ceil(sorted.length * 0.95) - 1],
      crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      userAgent: navigator.userAgent };
  }, { spec, queries: dataset.queries.map((q) => q.query), threads, origin, device, fullIndex,
    texts: fullIndex ? discussionData.texts : null, entries: fullIndex ? discussionData.entries : null,
    sourceIds: fullIndex ? discussionData.cases.map((c) => c.sourceId) : null, blend });
  let timer;
  const result = await Promise.race([evaluation, new Promise((_, reject) => {
    const timeoutMs = fullIndex ? 600000 : 180000;
    timer = setTimeout(() => reject(new Error(`Browser embedding benchmark exceeded ${timeoutMs / 1000} seconds.`)), timeoutMs);
  })]).finally(() => clearTimeout(timer));
  const similarities = result.vectors.map((v, i) => cosine(v, reference[i]));
  const rows = fullIndex ? discussionData.cases.map((item, i) => ({ ...evaluateRanking(item,
    result.rankings[i].map((index) => discussionData.entries[index]), { maxChunks: 12, budget: 6000 }), partition: item.partition })) : null;
  const totals = [...result.totalLatencies].sort((a, b) => a - b);
  const report = { status: 'passed', at: new Date().toISOString(), name, browser: browserName, device, threads, isolated, headless,
    corpusHash: metadata.corpusHash, scope: discussions ? 'Ed/Piazza discussions' : 'Course-material development benchmark', queries: dataset.queries.length, ...result, vectors: undefined, rankings: undefined,
    ...(fullIndex ? { fullIndex, modelAndSearchMeanMs: totals.reduce((a, b) => a + b, 0) / totals.length,
      modelAndSearchP95Ms: totals[Math.ceil(totals.length * 0.95) - 1], peakBrowserRssBytes,
      memoryNote: 'Sampled sum of browser-process RSS, including browser overhead and shared pages counted more than once. Excludes this Node harness. Upper-bound snapshot estimate, not a portable memory guarantee.',
      overall: summarize(rows), development: summarize(rows.filter((r) => r.partition === 'development')),
      validation: summarize(rows.filter((r) => r.partition === 'validation')), rows } : {}),
    minCosineVsNative: Math.min(...similarities), meanCosineVsNative: similarities.reduce((a, b) => a + b, 0) / similarities.length,
    note: fullIndex ? 'Browser-generated document and query embeddings plus hybrid ranking. Known sourceId, user-only history, 6,000-character / 12-chunk context budget. Excludes extension UI and answer generation.'
      : 'Browser query embedding only. Excludes lexical/vector ranking and extension UI overhead; memory budget is not validated by this measurement.' };
  const out = path.resolve(root, option('--out', `bench/runs/retrieval-browser-${name}-${browserName}-${device}-${threads}.json`));
  writeFileSync(out, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, latencies: undefined }, null, 2));
} catch (error) {
  const failure = { status: 'failed', at: new Date().toISOString(), name, browser: browserName, device, threads, isolated, headless,
    error: error.message, corpusHash: metadata.corpusHash };
  writeFileSync(path.resolve(root, option('--out', `bench/runs/retrieval-browser-${name}-${browserName}-${device}-${threads}.json`)), JSON.stringify(failure, null, 2), { mode: 0o600 });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  clearInterval(memoryTimer);
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
