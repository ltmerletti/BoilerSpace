// Compare the actual shipping math and compressed tables, without tuning on the questions.
import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { chromium, firefox } from 'playwright';
import { loadDataset } from './dataset.mjs';
import { cosine } from '../retrieval/ranking.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { createHash } from 'node:crypto';

process.umask(0o077);
const root = process.cwd(), directory = '.verify-tmp/discussion-retrieval/production';
const variant = process.argv.includes('--f16') ? 'f16' : 'i8';
const browserName = process.argv.includes('--firefox') ? 'firefox' : 'chromium';
const useWorker = process.argv.includes('--worker');
const data = loadDataset(undefined, { casesPath: '.verify-tmp/discussion-retrieval/v2/cases.json', preservePartitions: true });
const routes = new Map([
  ['/tokenizers.mjs', 'experiments/retrieval/modern-js/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs'],
  ['/weights', `${directory}/potion-${variant}.safetensors`], ['/tokenizer.json', '.verify-tmp/retrieval-models/potion-retrieval-32M/tokenizer.json'],
]);
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/') return response.end('<!doctype html><title>Isolated production retrieval test</title>');
  const filename = routes.get(pathname) ?? (/^\/extension\/(?:lib\/[a-z-]+\.js|vendor\/potion\/(?:model-i8.safetensors|tokenizer.json)|vendor\/tokenizers\/tokenizers.mjs)$/.test(pathname) ? pathname.slice(1) : null);
  if (!filename) { response.writeHead(404); return response.end(); }
  response.setHeader('Content-Type', /\.m?js$/.test(pathname) ? 'text/javascript' : 'application/octet-stream');
  response.setHeader('Content-Length', statSync(filename).size); createReadStream(path.join(root, filename)).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser, timer, peakRss = 0;
try {
  console.log(`Starting ${browserName} ${variant}...`);
  browser = await (browserName === 'firefox' ? firefox : chromium).launch({ headless: true, ...(process.env.RETRIEVAL_FIREFOX_PATH && browserName === 'firefox' ? { executablePath: process.env.RETRIEVAL_FIREFOX_PATH } : {}) });
  console.log('Browser started.');
  const cdp = browserName === 'chromium' ? await browser.newBrowserCDPSession() : null;
  const sample = async () => {
    if (!cdp) return null;
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    return execFileSync('ps', ['-o', 'rss=', '-p', processInfo.map(p => p.id).join(',')], { encoding: 'utf8' }).trim().split(/\s+/).map(Number).reduce((a, b) => a + b, 0) * 1024;
  };
  const page = await browser.newPage(), blocked = [];
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); blocked.push(route.request().url()); return route.abort(); });
  await page.goto(origin);
  console.log('Local page loaded.');
  await page.evaluate(async data => {
    const { discussionIndex } = await import('/extension/lib/discussion-ranking.js');
    window.state = { ...data, index: discussionIndex(data.entries) };
  }, { entries: data.entries, texts: data.texts, queries: data.queries, scopes: data.cases.map(c => ({ sourceId: c.sourceId })) });
  const baselineSamples = []; for (let i = 0; i < 3; i++) baselineSamples.push(await sample());
  const baselineRss = cdp ? baselineSamples.reduce((a, b) => a + b, 0) / 3 : null;
  let sampling = false;
  timer = setInterval(async () => { if (sampling || !cdp) return; sampling = true; try { peakRss = Math.max(peakRss, await sample()); } catch { /* A process may exit between memory samples. */ } finally { sampling = false; } }, 50);
  if (useWorker) {
    const result = await page.evaluate(async () => {
      const { DiscussionSearchClient } = await import('/extension/lib/discussion-search.js');
      const s = window.state, client = new DiscussionSearchClient();
      const positions = new Map(s.entries.map((e, i) => [e.id + ':' + e.chunkIndex, i]));
      const start = performance.now();
      try {
        const first = await client.search(s.entries, 'benchmark-corpus', s.queries[0], s.scopes[0]);
        const coldMs = performance.now() - start, latencies = [], searchTimes = [], rankings = [];
        if (first.method !== 'potion-i8-bm25') throw new Error('Worker did not use the selected model.');
        for (let i = 0; i < s.queries.length; i++) {
          const start = performance.now(), result = await client.search(s.entries, 'benchmark-corpus', s.queries[i], s.scopes[i]);
          latencies.push(performance.now() - start); searchTimes.push(result.queryMs);
          rankings.push(result.results.map(e => ({ index: positions.get(e.id + ':' + e.chunkIndex), chars: e.text.length })));
        }
        window.benchmarkClient = client;
        return { coldMs, latencies, searchTimes, rankings };
      } catch (error) { client.dispose(); throw error; }
    });
    const afterRss = await sample(); peakRss = Math.max(peakRss, afterRss ?? 0);
    const rows = data.cases.map((item, i) => evaluateRanking(item, result.rankings[i].map(({ index, chars }) => ({ ...data.entries[index], text: data.entries[index].text.slice(0, chars) })), { budget: 6000, maxChunks: 12 }));
    const primaryIds = new Set(data.cases.filter(c => c.primary).map(c => c.id)), sorted = result.latencies.sort((a, b) => a - b);
    const report = { at: new Date().toISOString(), browser: browserName, variant: 'shipping-i8-worker', corpusHash: data.corpusHash, queryHash: data.queryHash,
      primary: summarize(rows.filter(r => primaryIds.has(r.id))), challenges: summarize(rows.filter(r => !primaryIds.has(r.id))),
      coldMs: result.coldMs, meanQueryMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95QueryMs: sorted[Math.ceil(sorted.length * .95) - 1],
      baselineRss, peakRss: cdp ? peakRss : null, afterRss, peakExtraRssBytes: cdp ? peakRss - baselineRss : null, blockedExternalRequests: blocked.length, rows };
    writeFileSync(`${directory}/${browserName}-worker.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
    await page.evaluate(() => window.benchmarkClient.dispose());
    process.exitCode = 0;
  } else {
  const probes = JSON.parse(readFileSync('.verify-tmp/discussion-retrieval/v2/potion-public-parity.json'));
  console.log('Keyword baseline prepared; loading compressed table.');
  const setup = await page.evaluate(async probes => {
    const { discussionEncoder } = await import('/extension/lib/discussion-embedding.js'), { Tokenizer } = await import('/tokenizers.mjs');
    const s = window.state, json = await (await fetch('/tokenizer.json')).json();
    const tokenizer = new Tokenizer(json, {}), buffer = await (await fetch('/weights')).arrayBuffer();
    s.encoder = discussionEncoder(tokenizer, buffer);
    const parity = probes.map(p => ({ ids: tokenizer.encode(p.text, { add_special_tokens: false }).ids.filter(id => id !== 1), vector: [...s.encoder.encode(p.text)] }));
    const start = performance.now();
    s.vectors = new Float32Array(s.texts.length * s.encoder.dimensions);
    for (let i = 0; i < s.texts.length; i++) s.vectors.set(s.encoder.encode(s.texts[i]), i * s.encoder.dimensions);
    return { parity, indexMs: performance.now() - start, vectorBytes: s.vectors.byteLength, weightBytes: buffer.byteLength };
  }, probes);
  const minimumCosine = Math.min(...probes.map((p, i) => {
    if (JSON.stringify(p.ids) !== JSON.stringify(setup.parity[i].ids)) throw new Error('Tokenizer parity failed.');
    return cosine(p.vector, setup.parity[i].vector);
  }));
  if (minimumCosine < (variant === 'f16' ? .999999 : .9999)) throw new Error('Quantization public parity failed: ' + minimumCosine);
  console.log('Document index and public parity passed; checking queries.');
  const result = await page.evaluate(() => {
    const s = window.state, latencies = [], positions = new Map(s.entries.map((e, i) => [e.id + ':' + e.chunkIndex, i]));
    const rankings = s.queries.map((query, i) => {
      const start = performance.now(), result = s.index.rank(query, s.scopes[i], s);
      latencies.push(performance.now() - start); return result.map(e => positions.get(e.id + ':' + e.chunkIndex));
    });
    return { latencies, rankings };
  });
  const afterRss = await sample(); peakRss = Math.max(peakRss, afterRss ?? 0);
  const rows = data.cases.map((item, i) => evaluateRanking(item, result.rankings[i].map(j => data.entries[j]), { budget: 6000, maxChunks: 12 }));
  const sorted = result.latencies.sort((a, b) => a - b), primaryIds = new Set(data.cases.filter(c => c.primary).map(c => c.id));
  const report = { at: new Date().toISOString(), browser: browserName, variant, corpusHash: data.corpusHash, queryHash: data.queryHash,
    weightHash: createHash('sha256').update(readFileSync(routes.get('/weights'))).digest('hex'),
    primary: summarize(rows.filter(r => primaryIds.has(r.id))), challenges: summarize(rows.filter(r => !primaryIds.has(r.id))),
    baselineRss, peakRss: cdp ? peakRss : null, afterRss, peakExtraRssBytes: cdp ? peakRss - baselineRss : null,
    minimumCosine, indexMs: setup.indexMs, vectorBytes: setup.vectorBytes, weightBytes: setup.weightBytes,
    meanQueryMs: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95QueryMs: sorted[Math.ceil(sorted.length * .95) - 1], blockedExternalRequests: blocked.length, rows };
  writeFileSync(`${directory}/${browserName}-${variant}.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...report, rows: undefined }, null, 2));
  }
} finally { clearInterval(timer); await browser?.close(); await new Promise(resolve => server.close(resolve)); }
