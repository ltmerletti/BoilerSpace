import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readDiscussionSite } from '../extension/lib/discussions-api.js';

function site(platform, handler) {
  const calls = [], delays = [];
  const original = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((key) => [key, globalThis[key]]));
  const session = { discussionAuth: { ed: 'fixture-token' } };
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: { session: {
      get: async key => ({ [key]: session[key] }),
      set: async values => Object.assign(session, values),
      remove: async key => { delete session[key]; },
    } },
    tabs: { query: async () => [] },
  };
  globalThis.setTimeout = (callback, ms) => { delays.push(ms); callback(); return 0; };
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.startsWith('https://piazza.com/') && !url.includes('/logic/api')) return new Response('<meta name="csrf_token" content="fixture-csrf">');
    const result = await handler(url, options);
    return new Response(JSON.stringify(result.body ?? result), { status: result.status ?? 200, headers: result.headers });
  };
  return { calls, delays, session, restore: () => { for (const [key, value] of Object.entries(original)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } } };
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

test('Piazza discovery returns only course metadata from the signed-in account', async () => {
  const fixture = site('piazza', (url, options) => {
    assert.equal(JSON.parse(options.body).method, 'user.status');
    return { result: { name: 'Do not persist', email: 'private@example.test', networks: [
      { id: 'course250', course_number: 'CS250', name: 'Architecture', profs: ['private'] },
      { id: 'course251', course_number: 'CS251' },
    ] } };
  });
  try {
    const result = await readDiscussionSite({ platform: 'piazza', discover: true });
    assert.deepEqual(result.courses, [{ remoteId: 'course250', name: 'CS250' }, { remoteId: 'course251', name: 'CS251' }]);
    assert.ok(!JSON.stringify(result).includes('private'));
  } finally { fixture.restore(); }
});

test('long API batches checkpoint a partial feed rather than leaving a long batch uncommitted', async () => {
  const originalNow = Date.now;
  let clock = 0;
  const fixture = site('ed', url => {
    if (url.endsWith('/user')) return user;
    if (url.includes('/courses/')) return { threads: Array.from({ length: 30 }, (_, n) => ({ id: n + 1 })) };
    clock += 4000;
    return { thread: { id: Number(url.split('/').at(-1)) } };
  });
  Date.now = () => clock;
  try {
    const page = await readDiscussionSite({ platform: 'ed', remoteId: '1' });
    assert.equal(page.threads.length, 3);
    assert.equal(page.nextOffset, 3);
    assert.equal(page.hasMore, true);
    assert.deepEqual(page.pageIds, ['1', '2', '3']);
  } finally { Date.now = originalNow; fixture.restore(); }
});

test('Piazza preserves the connected course name without rendering its class page', async () => {
  const fixture = site('piazza', () => ({ result: { feed: [], more: false } }));
  try {
    const page = await readDiscussionSite({ platform: 'piazza', remoteId: 'example', name: 'Discussion course' });
    assert.equal(page.name, 'Discussion course');
  } finally { fixture.restore(); }
});

test('routine Ed refresh uses session auth without touching tabs or injecting scripts', async () => {
  const fixture = site('ed', url => url.endsWith('/user') ? user : { threads: [] });
  chrome.tabs = new Proxy({}, { get() { assert.fail('Routine sync must not access tabs'); } });
  chrome.scripting = new Proxy({}, { get() { assert.fail('Routine sync must not inject'); } });
  try { assert.equal((await readDiscussionSite({ platform: 'ed', remoteId: '1' })).hasMore, false); }
  finally { fixture.restore(); }
});

test('missing or expired Ed authentication asks for reconnect without creating a tab', async () => {
  for (const missing of [true, false]) {
    const fixture = site('ed', () => ({ status: 401, body: {} }));
    if (missing) delete fixture.session.discussionAuth;
    chrome.tabs = new Proxy({}, { get() { assert.fail('Automatic auth recovery must not access tabs'); } });
    try {
      const result = await readDiscussionSite({ platform: 'ed', remoteId: '1' });
      assert.match(result.error, /reconnect in Settings/);
      assert.equal(fixture.session.discussionAuth, undefined);
    } finally { fixture.restore(); }
  }
});

test('Ed connection captures an existing signed-in page only into session storage', async () => {
  const fixture = site('ed', () => user);
  delete fixture.session.discussionAuth;
  chrome.tabs = { query: async () => [{ id: 3, url: 'https://edstem.org/us/dashboard' }] };
  chrome.scripting = { executeScript: async ({ target, world }) => {
    assert.equal(target.tabId, 3); assert.equal(world, 'MAIN');
    return [{ result: 'fixture-token' }];
  } };
  try {
    const result = await readDiscussionSite({ platform: 'ed', discover: true });
    assert.equal(result.courses.length, 1);
    assert.equal(fixture.session.discussionAuth.ed, 'fixture-token');
    assert.ok(!JSON.stringify(result).includes('fixture-token'));
  } finally { fixture.restore(); }
});

test('a signed-out Piazza HTML page fails without calling APIs or opening tabs', async () => {
  const fixture = site('piazza', () => assert.fail('No API request without CSRF'));
  globalThis.fetch = async () => new Response('<h1>Sign in</h1>');
  try { assert.match((await readDiscussionSite({ platform: 'piazza', remoteId: 'example' })).error, /reconnect in Settings/); }
  finally { fixture.restore(); }
});

test('revoked site access stops before reading credentials or making a request', async () => {
  const fixture = site('ed', () => assert.fail('No request without site access'));
  chrome.permissions.contains = async () => false;
  chrome.storage.session.get = async () => assert.fail('No credential access without site access');
  try { assert.match((await readDiscussionSite({ platform: 'ed', remoteId: '1' })).error, /Allow discussion site access/); }
  finally { fixture.restore(); }
});
