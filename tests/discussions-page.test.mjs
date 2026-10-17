import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscussionSite } from '../extension/lib/discussions-page.js';

function site(platform, handler) {
  const calls = [], delays = [];
  const original = Object.fromEntries(['location', 'localStorage', 'document', 'window', 'fetch', 'setTimeout'].map((key) => [key, globalThis[key]]));
  globalThis.location = { hostname: platform === 'ed' ? 'edstem.org' : 'piazza.com', pathname: '/class/example' };
  globalThis.localStorage = { getItem: () => 'fixture-token' };
  globalThis.document = { querySelector: () => ({ content: 'fixture-csrf' }), getElementById: () => ({ textContent: 'Discussion course' }) };
  globalThis.window = {};
  globalThis.setTimeout = (callback, ms) => { delays.push(ms); callback(); return 0; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    const result = await handler(url, options);
    return new Response(JSON.stringify(result.body ?? result), { status: result.status ?? 200, headers: result.headers });
  };
  return { calls, delays, restore: () => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } } };
}
const user = { courses: [{ course: { id: 1, name: 'CS 25200', status: 'active' } }] };

test('Ed uses the requested offset, skips unchanged details and retries transient HTTP errors', async () => {
  let attempts = 0;
  const old = { id: 31, updated_at: 'v1', reply_count: 1 };
  const version = JSON.stringify(['v1', 1, null, null, null, null, null, null]);
  const fixture = site('ed', (url) => {
    if (url.endsWith('/user')) return user;
    if (url.includes('/courses/')) { assert.match(url, /offset=30/); return { threads: [old, { id: 32, updated_at: 'v2' }] }; }
    assert.ok(url.endsWith('/threads/32'), 'unchanged post must not be fetched again');
    if (++attempts === 1) return { status: 429, headers: { 'retry-after': '4' }, body: {} };
    return { thread: { id: 32 }, users: [{ id: 5, name: 'Do not return', course_role: 'staff' }] };
  });
  try {
    const page = await readDiscussionSite({ platform: 'ed', remoteId: '1', offset: 30, knownVersions: { 31: version } });
    assert.deepEqual(page.seenIds, ['31', '32']);
    assert.equal(page.nextOffset, 32);
    assert.equal(page.hasMore, true, 'short pages are not EOF');
    assert.equal(page.threads.length, 1);
    assert.equal(attempts, 2);
    assert.ok(fixture.delays.includes(4000));
    assert.ok(fixture.calls.every((c) => c.options.credentials === 'omit'));
    assert.ok(!JSON.stringify(page).includes('Do not return'));
  } finally { fixture.restore(); }
});

test('a failed post leaves the cursor at that post, preserving preceding successful reads', async () => {
  const fixture = site('ed', (url) => {
    if (url.endsWith('/user')) return user;
    if (url.includes('/courses/')) return { threads: [{ id: 1, number: 1 }, { id: 2, number: 2 }, { id: 3, number: 3 }] };
    if (url.endsWith('/threads/2')) return { status: 403, body: {} };
    return { thread: { id: 1 } };
  });
  try {
    const page = await readDiscussionSite({ platform: 'ed', remoteId: '1' });
    assert.equal(page.nextOffset, 1);
    assert.deepEqual(page.pageIds, ['1']);
    assert.equal(page.threads.length, 1);
    assert.match(page.errors[0], /Post #2: Sign into Ed/);
    assert.ok(!fixture.calls.some((c) => c.url.endsWith('/threads/3')));
  } finally { fixture.restore(); }
});

test('Piazza backs off on its JSON throttle response and continues the same history page', async () => {
  let attempts = 0;
  const fixture = site('piazza', (url, options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equal(options.headers['csrf-token'], 'fixture-csrf');
    if (method === 'network.get_my_feed') {
      assert.equal(params.offset, 30);
      return { result: { more: false, feed: [{ nr: 9, version: 1 }, { nr: 10, tags: ['private'] }] } };
    }
    assert.equal(method, 'content.get');
    if (++attempts === 1) return { error: 'Sorry, too fast -- please wait a second and try again.' };
    return { result: { nr: 9, history: [{ content: 'Staff clarification' }] } };
  });
  try {
    const page = await readDiscussionSite({ platform: 'piazza', remoteId: 'example', offset: 30 });
    assert.equal(page.nextOffset, 32);
    assert.equal(page.hasMore, false);
    assert.equal(page.errors.length, 0);
    assert.deepEqual(page.seenIds, ['9']);
    assert.equal(page.threads.length, 1);
    assert.ok(fixture.delays.includes(2000));
    assert.ok(fixture.delays.includes(1000));
    assert.ok(fixture.calls.every((c) => c.options.credentials === 'include'));
  } finally { fixture.restore(); }
});

test('an empty Ed history page ends pagination without issuing detail requests', async () => {
  const fixture = site('ed', (url) => url.endsWith('/user') ? user : { threads: [] });
  try {
    const page = await readDiscussionSite({ platform: 'ed', remoteId: '1', offset: 400 });
    assert.equal(page.nextOffset, 400);
    assert.equal(page.hasMore, false);
    assert.equal(fixture.calls.length, 2);
  } finally { fixture.restore(); }
});
