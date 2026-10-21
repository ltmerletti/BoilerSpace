import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleGenaiDataRequest } from '../extension/lib/genai-store.js';

async function fixture(responses, { abortDuringWait = false, streamTimers = false } = {}) {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout', 'clearTimeout'].map(key => [key, globalThis[key]]));
  const originalNow = Date.now;
  let now = 1_800_000_000_000;
  const calls = [], delays = [], controller = new AbortController();
  Date.now = () => now;
  globalThis.chrome = { storage: { local: { get: async () => ({ genai: { key: 'synthetic', model: 'qwen3.8:27b' } }) } } };
  chrome.runtime = { sendMessage: async message => ({ ok: true, data: await handleGenaiDataRequest(message) }) };
  globalThis.fetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return responses[Math.min(calls.length - 1, responses.length - 1)](options);
  };
  globalThis.setTimeout = (callback, ms) => {
    if (streamTimers && ms >= 50_000) return saved.setTimeout(callback, ms);
    delays.push(ms);
    queueMicrotask(() => { now += ms; if (abortDuringWait) controller.abort(); callback(); });
    return 1;
  };
  globalThis.clearTimeout = timer => saved.clearTimeout(timer);
  const { chatCompletion } = await import(`../extension/lib/genai.js?request-test=${crypto.randomUUID()}`);
  return { calls, delays, controller, complete: (body, options = {}) => chatCompletion(body, { signal: controller.signal, ...options }), restore() {
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

test('a failed request does not poison the queue for the next question', async () => {
  const f = await fixture([() => new Response('', { status: 503 }), ok]);
  try {
    await assert.rejects(f.complete(request), /HTTP 503/);
    assert.equal((await f.complete(request)).content, 'Ready');
  } finally { f.restore(); }
});

const started = async f => {
  for (let i = 0; i < 50 && !f.calls.length; i++) await Promise.resolve();
  assert.equal(f.calls.length, 1);
};

test('a queued question can be cancelled before the earlier request finishes', { timeout: 1000 }, async () => {
  const f = await fixture([() => new Promise(() => {}), ok]);
  const first = new AbortController();
  const firstReply = f.complete(request, { signal: first.signal });
  const firstStopped = assert.rejects(firstReply, error => error.name === 'AbortError');
  try {
    await started(f);
    const queued = f.complete(request);
    const stopped = assert.rejects(queued, error => error.name === 'AbortError');
    f.controller.abort();
    await stopped;
    assert.equal(f.calls.length, 1, 'the cancelled question never reaches the server');
  } finally {
    first.abort();
    await firstStopped;
    f.restore();
  }
});

test('cancelling a stalled fetch releases the queue even if the transport never settles', { timeout: 1000 }, async () => {
  const f = await fixture([() => new Promise(() => {}), ok]);
  const first = new AbortController();
  try {
    const reply = f.complete(request, { signal: first.signal });
    const stopped = assert.rejects(reply, error => error.name === 'AbortError');
    await started(f);
    first.abort();
    await stopped;
    assert.equal((await f.complete(request)).content, 'Ready');
  } finally { first.abort(); f.restore(); }
});

for (const kind of ['JSON', 'SSE', 'HTTP 400']) {
  test(`the total timeout covers a stalled ${kind} body, and the next request succeeds`, async t => {
    const timeout = new AbortController();
    const nativeTimeout = AbortSignal.timeout;
    let first = true;
    t.mock.method(AbortSignal, 'timeout', ms => {
      if (!first) return nativeTimeout(ms);
      first = false;
      return timeout.signal;
    });
    let cancelled = false;
    const f = await fixture([() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: kind === 'HTTP 400' ? 400 : 200,
      headers: { 'content-type': kind === 'SSE' ? 'text/event-stream' : 'application/json' },
    }), ok], { streamTimers: kind === 'SSE' });
    try {
      const reply = f.complete(request, kind === 'SSE' ? { onDelta() {} } : {});
      const failed = assert.rejects(reply, error => error.code === 'request-timeout');
      await started(f);
      // Let headers arrive and body reading begin before the deadline expires.
      for (let i = 0; i < 20; i++) await Promise.resolve();
      timeout.abort(new DOMException('Timed out', 'TimeoutError'));
      await failed;
      assert.equal((await f.complete(request)).content, 'Ready');
      if (kind === 'SSE') assert.equal(cancelled, true);
    } finally { f.restore(); }
  });
}
