import { test } from 'node:test';
import assert from 'node:assert/strict';

async function fixture(responses, { abortDuringWait = false } = {}) {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  const calls = [], delays = [], controller = new AbortController();
  Date.now = () => now;
  globalThis.chrome = { storage: { local: { get: async () => ({ genai: { key: 'synthetic', model: 'qwen3.8:27b' } }) } } };
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return responses[Math.min(calls.length - 1, responses.length - 1)]();
  };
  globalThis.setTimeout = (callback, ms) => {
    delays.push(ms);
    queueMicrotask(() => { now += ms; if (abortDuringWait) controller.abort(); callback(); });
    return 1;
  };
  globalThis.clearTimeout = () => {};
  const { chatCompletion } = await import(`../extension/lib/genai.js?request-test=${crypto.randomUUID()}`);
  return { calls, delays, controller, complete: body => chatCompletion(body, { signal: controller.signal }), restore() {
    Date.now = originalNow;
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  } };
}
const ok = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready' } }] });
const limited = () => Response.json({ detail: 'Rate limit exceeded. Please try again later.' }, { status: 400 });
const request = { messages: [{ role: 'user', content: 'Hello' }] };

test('Purdue HTTP 400 rate limits retry the same request and respect Retry-After', async () => {
  const f = await fixture([() => Response.json({ detail: 'Rate limit exceeded. Please try again later.' }, { status: 400, headers: { 'retry-after': '2' } }), ok]);
  try {
    assert.equal((await f.complete(request)).content, 'Ready');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(f.calls[0], f.calls[1]);
    assert.ok(f.delays.includes(2000));
  } finally { f.restore(); }
});

test('HTTP 429 accepts a Retry-After HTTP date', async () => {
  const f = await fixture([() => new Response('', { status: 429, headers: { 'retry-after': new Date(Date.now() + 5000).toUTCString() } }), ok]);
  try { assert.equal((await f.complete(request)).content, 'Ready'); assert.ok(f.delays.includes(5000)); }
  finally { f.restore(); }
});

test('an ordinary HTTP 400 is not treated as a transient rate limit', async () => {
  const f = await fixture([() => Response.json({ detail: 'Invalid model parameter' }, { status: 400 })]);
  try { await assert.rejects(f.complete(request), /HTTP 400/); assert.equal(f.calls.length, 1); }
  finally { f.restore(); }
});

test('persistent rate limits stop after bounded retries with an actionable error', async () => {
  const f = await fixture([limited]);
  try {
    await assert.rejects(f.complete(request), error => error.code === 'rate-limited' && /Wait a minute/.test(error.message));
    assert.equal(f.calls.length, 4);
    assert.deepEqual(f.delays, [15000, 30000, 60000]);
  } finally { f.restore(); }
});

test('cancelling during a rate-limit wait prevents another request', async () => {
  const f = await fixture([limited, ok], { abortDuringWait: true });
  try { await assert.rejects(f.complete(request), error => error.name === 'AbortError'); assert.equal(f.calls.length, 1); }
  finally { f.restore(); }
});
