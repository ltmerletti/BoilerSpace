// Private-data replay through the actual extension tool, in a throwaway profile.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { loadDataset } from './dataset.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';

process.umask(0o077);
const root = process.cwd(), zen = process.argv.includes('--zen'), profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-search-'));
const dataset = loadDataset(undefined, { casesPath: '.verify-tmp/discussion-retrieval/v2/cases.json', preservePartitions: true });
const discussions = JSON.parse(readFileSync('.verify-tmp/retrieval-discussions.json')).discussions;
const input = { discussions, queries: dataset.queries, scopes: dataset.cases.map(c => c.sourceId) };
async function replay({ discussions, queries, scopes }) {
  const { createTools } = await import('./lib/agent.js');
  const tools = createTools({ snapshot: { courses: [], data: [] }, discussions, cachedFile: null });
  await globalThis.verificationBaseline?.();
  const results = [], times = [], methods = new Set();
  for (let i = 0; i < queries.length; i++) {
    const start = performance.now();
    const result = await tools.run('search_course_material', { query: queries[i], source_id: scopes[i] });
    times.push(performance.now() - start); methods.add(result.discussion_search);
    results.push(result.results.map(row => ({ key: row.discussion_key, chunk: row.chunk_index, text: row.snippet })));
  }
  return { results, times, methods: [...methods] };
}
let browser, context, panel, server, report, reportTimer, memoryTimer;
let baselineRss = null, peakRss = 0;
let baselineProcesses, finalProcesses;
const sampleFirefox = () => {
  const processes = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  const included = new Set([browser.process().pid]);
  for (let n = 0; n < processes.length; n++) {
    let added = false;
    for (const [pid, parent] of processes) if (included.has(parent) && !included.has(pid)) { included.add(pid); added = true; }
    if (!added) break;
  }
  finalProcesses = processes.filter(([pid]) => included.has(pid));
  return finalProcesses.reduce((sum, [, , rss]) => sum + rss * 1024, 0);
};
try {
  let base;
  if (zen) {
    // Firefox BiDi does not expose extension realms. A test-only module in a
    // disposable extension copy runs the same replay and reports over loopback.
    // The real agent, worker, tokenizer and weights are copied without changes.
    let resolveReport, rejectReport;
    const received = new Promise((resolve, reject) => { resolveReport = resolve; rejectReport = reject; });
    reportTimer = setTimeout(() => rejectReport(new Error('Firefox extension replay did not report within 30 seconds.')), 30000);
    server = createServer(async (request, response) => {
      if (request.method === 'OPTIONS') { response.setHeader('Access-Control-Allow-Origin', '*'); response.setHeader('Access-Control-Allow-Headers', 'content-type'); response.end(); return; }
      if (request.url === '/baseline') {
        await new Promise(resolve => setTimeout(resolve, 5000));
        baselineRss = sampleFirefox();
        baselineProcesses = finalProcesses;
        memoryTimer = setInterval(() => { try { peakRss = Math.max(peakRss, sampleFirefox()); } catch { /* A process may exit between memory samples. */ } }, 50);
        response.setHeader('Access-Control-Allow-Origin', '*'); response.end('ok'); return;
      }
      if (request.method !== 'POST' || request.url !== '/report') { response.writeHead(404); response.end(); return; }
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = JSON.parse(Buffer.concat(chunks));
      peakRss = Math.max(peakRss, sampleFirefox()); clearInterval(memoryTimer);
      response.setHeader('Access-Control-Allow-Origin', '*'); response.end('ok');
      if (result.error) rejectReport(new Error(result.error)); else resolveReport(result);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const temporaryExtension = path.join(profile, 'test-extension'); cpSync(path.join(root, 'extension'), temporaryExtension, { recursive: true });
    writeFileSync(path.join(temporaryExtension, 'verification-data.json'), JSON.stringify(input));
    writeFileSync(path.join(temporaryExtension, 'verification-driver.js'), `globalThis.verificationBaseline = () => fetch('http://127.0.0.1:${server.address().port}/baseline');\nconst replay = ${replay.toString()};\ntry { const result = await replay(await (await fetch('./verification-data.json')).json()); await fetch('http://127.0.0.1:${server.address().port}/report', { method: 'POST', body: JSON.stringify(result) }); } catch(error) { await fetch('http://127.0.0.1:${server.address().port}/report', { method: 'POST', body: JSON.stringify({error:error.message}) }); }`);
    appendFileSync(path.join(temporaryExtension, 'document.js'), "\nimport './verification-driver.js';\n");
    writeFileSync(path.join(temporaryExtension, 'verification-open.js'), "browser.tabs.create({url:browser.runtime.getURL('document.html')});\n");
    const manifestFile = path.join(temporaryExtension, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestFile));
    manifest.background.scripts.push('verification-open.js'); manifest.host_permissions.push('http://127.0.0.1/*');
    writeFileSync(manifestFile, JSON.stringify(manifest));
    const { default: puppeteer } = await import('../../.verify-tmp/firefox-driver/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js');
    browser = await puppeteer.launch({ browser: 'firefox', executablePath: process.env.FIREFOX_PATH ?? '/Applications/Zen.app/Contents/MacOS/zen', userDataDir: path.join(profile, 'browser'), headless: true, args: ['--no-remote', '--new-instance'], extraPrefsFirefox: { 'browser.aboutwelcome.enabled': false, 'browser.newtabpage.enabled': false }, timeout: 20000 });
    console.log('Started isolated ' + await browser.version());
    await browser.installExtension(temporaryExtension);
    report = await received;
  } else {
    context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', args: [`--disable-extensions-except=${root}/extension`, `--load-extension=${root}/extension`] });
    let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
    base = `chrome-extension://${new URL(worker.url()).host}/`;
    panel = await context.newPage();
  }
  if (!zen) { await panel.goto(base + 'document.html'); report = await panel.evaluate(replay, input); }
  assert.deepEqual(report.methods, ['potion-i8-bm25']);
  const entries = new Map(dataset.entries.map(e => [`${e.discussion_key}:${e.chunkIndex}`, e]));
  const rows = dataset.cases.map((item, i) => evaluateRanking(item, report.results[i].map(result => {
    const entry = entries.get(`${result.key}:${result.chunk}`);
    assert.ok(entry && entry.text.startsWith(result.text));
    return { ...entry, text: result.text };
  }), { budget: 6000, maxChunks: 12 }));
  const primaryIds = new Set(dataset.cases.filter(c => c.primary).map(c => c.id)), times = report.times.slice(1).sort((a, b) => a - b);
  const summary = { at: new Date().toISOString(), browser: zen ? 'Zen Firefox extension' : 'Chromium extension',
    corpusHash: dataset.corpusHash, queryHash: dataset.queryHash, primary: summarize(rows.filter(r => primaryIds.has(r.id))),
    challenges: summarize(rows.filter(r => !primaryIds.has(r.id))), coldToolMs: report.times[0], meanWarmToolMs: times.reduce((a, b) => a + b, 0) / times.length,
    p95WarmToolMs: times[Math.ceil(times.length * .95) - 1], method: report.methods[0],
    ...(zen ? { baselineRss, peakRss, peakExtraRssBytes: peakRss - baselineRss, baselineProcesses, finalProcesses } : {}), rows };
  writeFileSync(`.verify-tmp/discussion-retrieval/production/${zen ? 'zen' : 'chromium'}-extension.json`, JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...summary, rows: undefined }, null, 2));
} finally { clearTimeout(reportTimer); clearInterval(memoryTimer); await context?.close(); await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); rmSync(profile, { recursive: true, force: true }); }
