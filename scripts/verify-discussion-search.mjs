// Exercise bundled retrieval in real browser workers with synthetic, public-safe data.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, createReadStream, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url)), engine = process.env.VERIFY_BROWSER ?? 'chromium';
let brokenModel = false;
const server = createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Content-Security-Policy', "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'");
  if (pathname === '/') return response.end('<!doctype html><title>Discussion search verification</title>');
  if (!/^\/extension\/(?:lib\/[a-z-]+\.js|vendor\/potion\/(?:model-i8.safetensors|tokenizer.json)|vendor\/tokenizers\/tokenizers.mjs)$/.test(pathname)) {
    response.writeHead(404); return response.end();
  }
  if (brokenModel && pathname.endsWith('/model-i8.safetensors')) return response.end('corrupt model fixture');
  const file = path.join(root, pathname.slice(1));
  response.setHeader('Content-Type', /\.m?js$/.test(pathname) ? 'text/javascript' : 'application/octet-stream');
  response.setHeader('Content-Length', statSync(file).size); createReadStream(file).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await (engine === 'firefox' ? firefox : chromium).launch({ headless: true, timeout: 20000 });
  const page = await browser.newPage(), blocked = [], errors = [];
  await page.route('**/*', route => { if (route.request().url().startsWith(origin + '/')) return route.continue(); blocked.push(route.request().url()); return route.abort(); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const results = await page.evaluate(async () => {
    const { createDiscussionSearch, DiscussionSearchClient } = await import('/extension/lib/discussion-search.js');
    const client = new DiscussionSearchClient({ idleMs: 30 });
    const source = (id, courseId, text) => ({ id, name: id, courseId, threads: [{ key: `${id}:1`, title: 'Computing session', text, role: 'instructor', number: 1, url: 'https://example.test/post/1', replies: [] }] });
    const data = { sources: [source('ed:1', 101, 'Restarting the notebook kernel clears every variable from memory.'), source('piazza:old', null, 'Restarting the notebook kernel does not clear variables in this old exercise.')] };
    const retrieve = createDiscussionSearch(data, { searchClient: client });
    try {
      const cold = await retrieve('Why did my notebook forget its variables?', { sourceId: 'ed:1' });
      const warm = await retrieve('notebook', { courseId: 101 });
      const unlinked = await retrieve('notebook', { sourceId: 'piazza:old' });
      const originalWorker = client.worker;
      const revised = structuredClone(data); revised.sources[0].threads[0].text = 'Notebook sessions now preserve variables after a kernel restart.';
      const updated = await createDiscussionSearch(revised, { searchClient: client })('notebook', { sourceId: 'ed:1' });
      const removed = await createDiscussionSearch({ sources: [data.sources[1]] }, { searchClient: client })('notebook', { sourceId: 'ed:1' });
      const sameWorker = client.worker === originalWorker;
      await new Promise(resolve => setTimeout(resolve, 100));
      const idleReleased = client.worker === null;
      const restarted = await retrieve('notebook', { sourceId: 'ed:1' });
      const blank = await retrieve('   ', {});
      const invalidatedSearch = createDiscussionSearch(data, { searchClient: client });
      client.revision++; client.dispose();
      let invalidated;
      try { await invalidatedSearch('notebook', {}); }
      catch (error) { invalidated = { code: error.code }; }
      return { cold, warm, unlinked, updated, removed, sameWorker, idleReleased, restarted, blank, invalidated };
    } finally { client.dispose(); }
  });
  assert.equal(results.cold.method, 'potion-i8-bm25'); assert.ok(results.cold.indexed);
  assert.equal(results.warm.indexed, false); assert.ok(results.warm.results.every(r => r.courseId === 101));
  assert.ok(results.unlinked.results.length && results.unlinked.results.every(r => r.sourceId === 'piazza:old'));
  assert.ok(results.updated.indexed && results.updated.results[0].text.includes('now preserve variables'));
  assert.equal(results.removed.results.length, 0); assert.ok(results.sameWorker);
  assert.ok(results.idleReleased && results.restarted.indexed); assert.equal(results.blank.results.length, 0);
  assert.equal(results.invalidated.code, 'discussion-data-changed');
  console.log(`PASS  ${engine}: cold/warm worker, course/source isolation, edited posts, removed sources, idle release/restart and invalidation`);
  brokenModel = true;
  await page.reload();
  const fallback = await page.evaluate(async () => {
    const { createDiscussionSearch, DiscussionSearchClient } = await import('/extension/lib/discussion-search.js');
    const client = new DiscussionSearchClient();
    try { return await createDiscussionSearch({ sources: [{ id: 'ed:1', courseId: 101, name: 'Test', threads: [{ key: 'ed:1:1', title: 'Deadline', text: 'The deadline is Friday.', role: 'instructor' }] }] }, { searchClient: client })('deadline Friday', { sourceId: 'ed:1' }); }
    finally { client.dispose(); }
  });
  assert.equal(fallback.method, 'bm25'); assert.match(fallback.note, /keyword/); assert.ok(fallback.results[0].text.includes('Friday'));
  assert.equal(blocked.length, 0); assert.deepEqual(errors, []);
  console.log(`PASS  ${engine}: damaged-model fallback, no external requests and no browser errors`);
  const out = process.env.VERIFY_OUT;
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(path.join(out, `discussion-search-${engine}.json`), JSON.stringify({ engine, passed: true, blockedExternalRequests: 0, checks: 12 }, null, 2)); }
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
