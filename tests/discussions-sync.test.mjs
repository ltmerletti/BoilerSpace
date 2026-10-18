import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDiscussionRequest } from '../extension/lib/discussions-sync.js';
import { snapshotFixture } from './helpers.mjs';
import { checkDiscussionReaderTab, sweepDiscussionReaders } from '../extension/lib/discussion-readers.js';

function setup(reader, granted = true) {
  const data = { snapshot: snapshotFixture() };
  const calls = [], session = {}, ownedTabs = new Map(), tabCalls = [];
  let nextId = 100;
  globalThis.chrome = {
    runtime: { getURL: file => `chrome-extension://fixture/${file}` },
    alarms: { create: async () => {}, clear: async () => {} },
    storage: { session: { get: async key => ({ [key]: structuredClone(session[key]) }), set: async values => Object.assign(session, structuredClone(values)) }, local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
      set: async (values) => Object.assign(data, structuredClone(values)),
    } },
    permissions: { contains: async () => granted },
    tabs: {
      query: async () => [{ id: 1, url: 'https://edstem.org/us/', status: 'complete' }, ...ownedTabs.values()],
      get: async id => ownedTabs.get(id) ?? (await chrome.tabs.query({})).find(tab => tab.id === id) ?? Promise.reject(new Error('No tab')),
      create: async options => { tabCalls.push(['create', options]); const tab = { id: nextId++, status: 'complete', ...options }; ownedTabs.set(tab.id, tab); return tab; },
      update: async (id, options) => { tabCalls.push(['update', id, options]); const tab = { ...ownedTabs.get(id), ...options }; ownedTabs.set(id, tab); return tab; },
      remove: async id => { tabCalls.push(['remove', id]); ownedTabs.delete(id); },
    },
    scripting: { executeScript: async ({ args }) => { calls.push(args[0]); return [{ result: await reader(args[0], data) }]; } },
  };
  return { data, calls, session, ownedTabs, tabCalls };
}

const feed = (remoteId, offset = 0) => ({ name: 'CS 25200', errors: [], hasMore: offset === 0,
  nextOffset: offset === 0 ? 1 : offset, pageIds: offset === 0 ? [String(Number(remoteId) + 100)] : [],
  seenIds: offset === 0 ? [String(Number(remoteId) + 100)] : [], versions: { [Number(remoteId) + 100]: 'v1' },
  threads: offset === 0 ? [{ users: [], thread: { id: Number(remoteId) + 100, course_id: Number(remoteId), number: 1, title: 'Staff clarification', content: 'Friday', updated_at: '2026-10-13T12:00:00Z' } }] : [] });

async function sync(force = false) {
  let result;
  for (let i = 0; i < 30; i++) {
    result = await handleDiscussionRequest({ action: 'sync', force });
    force = false;
    if (!result.pending) return result;
  }
  assert.fail('Discussion pagination did not finish');
}
async function connect() {
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  return sync(true);
}

test('a newly opened Firefox reader waits for the site URL after about:blank reports complete', async () => {
  setup(async () => ({ courses: [{ remoteId: '1', name: 'CS 25200' }] }));
  let polls = 0, removed = false, targetUrl;
  chrome.tabs.query = async () => [];
  chrome.tabs.create = async options => { assert.equal(options.active, false); return { id: 99 }; };
  chrome.tabs.update = async (id, options) => { targetUrl = options.url; return { id }; };
  chrome.tabs.get = async () => ({ id: 99, status: 'complete', active: false, url: !targetUrl || ++polls <= 2 ? 'about:blank' : targetUrl, pendingUrl: targetUrl && polls <= 2 ? targetUrl : undefined });
  chrome.tabs.remove = async id => { assert.equal(id, 99); removed = true; };
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async args => { assert.ok(polls >= 3, 'the site has committed before injection'); return execute(args); };
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  assert.ok(polls >= 3);
  assert.equal(removed, true);
});

test('Piazza reuses an existing class tab with a trailing slash and leaves it open', async () => {
  setup(async () => ({ courses: [{ remoteId: 'example123', name: 'CS 25200' }] }));
  chrome.tabs.query = async () => [{ id: 8, url: 'https://piazza.com/class/example123/?cid=12#discussion', active: false, status: 'complete' }];
  chrome.tabs.create = async () => assert.fail('The existing class tab should be reused');
  chrome.tabs.remove = async () => assert.fail('A user-owned class tab must stay open');
  const result = await handleDiscussionRequest({ action: 'connect', platform: 'piazza', url: 'https://piazza.com/class/example123' });
  assert.equal(result.sources[0].id, 'piazza:example123');
});

test('Ed connect discovers all active courses and refreshes them independently', async () => {
  const { data } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1', code: 'CS 25200', name: 'CS 25200' }, { remoteId: '2', code: 'MA 26500', name: 'MA 26500' }] } : remoteId === '2' ? Promise.reject(new Error('Temporary site error')) : feed(remoteId, offset));
  await connect();
  assert.deepEqual(data.discussions.sources.map((s) => [s.courseId, s.status]), [[1600001, 'done'], [1600002, 'error']]);
  assert.equal(data.discussions.sources[0].threads.length, 1);
  assert.equal(data.snapshot.data[0].assignments[0].title, 'Project 1: Shell');
});

test('discussion failure keeps the previous text and successful sources are not reread immediately', async () => {
  const { data, calls } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1', code: 'CS 25200', name: 'CS 25200' }] } : feed(remoteId, offset));
  await connect();
  const before = calls.length;
  await handleDiscussionRequest({ action: 'sync' });
  assert.equal(calls.length, before);
  chrome.scripting.executeScript = async () => { throw new Error('Session expired'); };
  await handleDiscussionRequest({ action: 'sync', force: true });
  assert.equal(data.discussions.sources[0].status, 'error');
  assert.equal(data.discussions.sources[0].threads[0].text, 'Friday');
});

test('site access is checked before injecting any reader', async () => {
  const { calls } = setup(async () => { throw new Error('Should not run'); }, false);
  await assert.rejects(handleDiscussionRequest({ action: 'connect', platform: 'ed' }), /Allow Ed access/);
  assert.equal(calls.length, 0);
});

test('clearing extension data during a read prevents a late sync from restoring it', async () => {
  const { data } = setup(async ({ discover, remoteId }, stored) => {
    if (discover) return { courses: [{ remoteId: '1', code: 'CS 25200', name: 'CS 25200' }] };
    delete stored.discussions;
    return feed(remoteId);
  });
  await assert.rejects(connect(), /saved data was cleared/);
  await sync();
  assert.equal(data.discussions, undefined);
});

test('linking and disconnecting one source leaves other course connections intact', async () => {
  const { data } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1', code: 'CS 25200', name: 'CS 25200' }, { remoteId: '2', code: 'MA 26500', name: 'MA 26500' }] } : feed(remoteId, offset));
  await connect();
  await handleDiscussionRequest({ action: 'link', sourceId: 'ed:1', courseId: null });
  assert.equal(data.discussions.sources[0].courseId, null);
  await sync(true);
  assert.equal(data.discussions.sources[0].courseId, null, 'a manual separate-course choice survives automatic matching');
  await assert.rejects(handleDiscussionRequest({ action: 'link', sourceId: 'ed:1', courseId: 999 }), /current Brightspace/);
  await handleDiscussionRequest({ action: 'remove', sourceId: 'ed:1' });
  assert.deepEqual(data.discussions.sources.map((s) => s.id), ['ed:2']);
});

test('history import crosses many pages, saves checkpoints, and resumes a failed batch', async () => {
  let fail = true;
  const { data, calls } = setup(async ({ discover, remoteId, offset }) => {
    if (discover) return { courses: [{ remoteId: '1', code: 'CS 25200', name: 'CS 25200' }] };
    if (offset === 2 && fail) throw new Error('Temporary read failure');
    const page = feed(remoteId, 0);
    const id = String(101 + offset);
    return { ...page, nextOffset: offset < 5 ? offset + 1 : offset, hasMore: offset < 5,
      pageIds: offset < 5 ? [id] : [], seenIds: offset < 5 ? [id] : [], versions: { [id]: 'v1' },
      threads: offset < 5 ? [{ ...page.threads[0], thread: { ...page.threads[0].thread, id: Number(id), title: `Page ${offset}` } }] : [] };
  });
  await connect();
  assert.equal(data.discussions.sources[0].sync.offset, 2);
  assert.equal(data.discussions.sources[0].threads.length, 2);
  assert.equal(data.discussions.sources[0].historyComplete, undefined);
  const before = calls.length;
  fail = false;
  await sync(true);
  assert.equal(calls[before].offset, 2, 'retry resumes rather than restarting');
  assert.equal(data.discussions.sources[0].threads.length, 5);
  assert.equal(data.discussions.sources[0].historyComplete, true);
  assert.equal(data.discussions.sources[0].sync, null);
  assert.equal(data.discussions.sources[0].checkedCount, 5);
});

test('a partial batch preserves successful posts before its failed post is retried', async () => {
  const { data } = setup(async ({ discover, remoteId }) => discover ? { courses: [{ remoteId: '1' }] } : { ...feed(remoteId), errors: ['Post #2: unavailable'] });
  await connect();
  assert.equal(data.discussions.sources[0].status, 'error');
  assert.equal(data.discussions.sources[0].threads.length, 1);
  assert.equal(data.discussions.sources[0].sync.offset, 1);
});

test('a fresh sweep supplies saved versions and removes posts no longer public', async () => {
  let empty = false;
  const { data, calls } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, empty ? 1 : offset));
  await connect();
  empty = true;
  await sync(true);
  assert.equal(calls.at(-1).knownVersions['101'], 'v1');
  assert.equal(data.discussions.sources[0].threads.length, 0);
});

test('older truncated captures are reread once even when the remote post version is unchanged', async () => {
  const { data, calls } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
  await connect();
  delete data.discussions.sources[0].threads[0].captureVersion;
  const before = calls.length;
  await sync(true);
  assert.deepEqual(calls[before].knownVersions, {});
  assert.equal(data.discussions.sources[0].threads[0].captureVersion, 2);
  const after = calls.length;
  await sync(true);
  assert.equal(calls[after].knownVersions['101'], 'v1');
});

test('courses connected before Brightspace is loaded are matched later without another history import', async () => {
  const { data, calls } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1', name: 'CS252' }] } : feed(remoteId, offset));
  data.snapshot = { courses: [], data: [] };
  await connect();
  assert.equal(data.discussions.sources[0].courseId, null);
  data.snapshot = snapshotFixture();
  const before = calls.length;
  await handleDiscussionRequest({ action: 'sync' });
  assert.equal(data.discussions.sources[0].courseId, 1600001);
  assert.equal(calls.length, before);
});

test('Piazza discovers courses without a pasted link and matches metadata returned during import', async () => {
  const { data } = setup(async ({ discover, offset }) => discover ? { courses: [{ remoteId: 'example', name: 'Piazza course' }] } : {
    name: 'CS252', errors: [], threads: [], seenIds: [], pageIds: [], versions: {}, nextOffset: offset, hasMore: false,
  });
  chrome.tabs.query = async () => [{ id: 1, url: 'https://piazza.com/class/example', status: 'complete' }];
  await handleDiscussionRequest({ action: 'connect', platform: 'piazza' });
  assert.equal(data.discussions.sources[0].courseId, null);
  await sync(true);
  assert.equal(data.discussions.sources[0].courseId, 1600001);
});

test('a pasted Piazza link verifies signed-in class access before saving the connection', async () => {
  const { data, calls } = setup(async ({ remoteId, discover }) => {
    assert.equal(remoteId, 'example');
    assert.equal(discover, true);
    return { courses: [{ remoteId: 'example', name: 'CS252' }] };
  });
  chrome.tabs.query = async () => [{ id: 1, url: 'https://piazza.com/class/example', status: 'complete' }];
  await handleDiscussionRequest({ action: 'connect', platform: 'piazza', url: 'https://piazza.com/class/example' });
  assert.equal(data.discussions.sources[0].courseId, 1600001);
  assert.equal(calls.length, 1);
  chrome.scripting.executeScript = async () => [{ result: { courses: [] } }];
  chrome.tabs.query = async () => [{ id: 1, url: 'https://piazza.com/class/unavailable', status: 'complete' }];
  await assert.rejects(handleDiscussionRequest({ action: 'connect', platform: 'piazza', url: 'https://piazza.com/class/unavailable' }), /Sign into Piazza/);
  assert.equal(data.discussions.sources.length, 1, 'unverified classes are not silently connected');
});

test('a server repeating the same history page stops with a recoverable error', async () => {
  const { data } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : { ...feed(remoteId), nextOffset: offset + 1 });
  await connect();
  assert.equal(data.discussions.sources[0].status, 'error');
  assert.match(data.discussions.sources[0].error, /stopped advancing/);
  assert.equal(data.discussions.sources[0].threads.length, 1);
});

test('a failed temporary-tab creation does not inject or leave a reader lease', async () => {
  const fixture = setup(async () => { throw new Error('Must not inject after creation fails'); });
  chrome.tabs.query = async () => [];
  chrome.tabs.create = async () => { throw new Error('Navigation failed'); };
  await assert.rejects(handleDiscussionRequest({ action: 'connect', platform: 'ed' }), /Navigation failed/);
  assert.deepEqual(fixture.session.discussionReaders, {});
});

test('multiple Ed courses share one inactive reader across all batches and close it once', async () => {
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }, { remoteId: '2' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
  await sync(true);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'create').length, 1);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'update').length, 1);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'remove').length, 1);
  assert.equal(fixture.calls.filter(c => !c.discover).length, 4);
  assert.ok(fixture.tabCalls.filter(c => c[0] === 'create').every(c => c[1].active === false));
  assert.deepEqual(fixture.session.discussionReaders, {});
});

test('equivalent pending scope requests share a single physical batch', async () => {
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }, { remoteId: '2' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  const a = handleDiscussionRequest({ action: 'sync', sourceId: 'ed:1' });
  const b = handleDiscussionRequest({ action: 'sync', sourceId: ['ed:1'], force: false });
  assert.equal(a, b);
  await a;
  assert.equal(fixture.calls.filter(c => !c.discover).length, 1);
  const c = handleDiscussionRequest({ action: 'sync', sourceId: ['ed:2', 'ed:1'] });
  const d = handleDiscussionRequest({ action: 'sync', sourceId: ['ed:1', 'ed:2', 'ed:1'] });
  assert.equal(c, d);
  await c;
});

test('a suspended worker recovers an owned tab created before its ID was saved', async () => {
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  const generation = fixture.data.discussions.generation;
  const url = 'https://edstem.org/us/#boilerspace-reader=interrupted';
  fixture.ownedTabs.set(99, { id: 99, url, active: false, status: 'complete' });
  fixture.session.discussionReaders = { ed: { generation, url, expiresAt: Date.now() + 60000 } };
  chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
  const restarted = await import(`../extension/lib/discussion-readers.js?restart=${crypto.randomUUID()}`);
  await restarted.sweepDiscussionReaders();
  await sync(true);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'create').length, 0);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'update').length, 0);
  assert.deepEqual(fixture.tabCalls.filter(c => c[0] === 'remove'), [['remove', 99]]);
});

test('reader cleanup preserves activated, navigated and unrelated user tabs', async () => {
  for (const takeover of ['activated', 'navigated']) {
    const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
    await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
    chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
    await handleDiscussionRequest({ action: 'sync', force: true });
    const entry = fixture.session.discussionReaders.ed;
    const tab = fixture.ownedTabs.get(entry.tabId);
    if (takeover === 'activated') tab.active = true;
    else tab.url = 'https://example.com/my-page';
    await checkDiscussionReaderTab(tab.id, takeover === 'activated');
    await sweepDiscussionReaders();
    assert.equal(fixture.ownedTabs.has(tab.id), true, takeover);
    assert.equal(fixture.tabCalls.filter(c => c[0] === 'remove').length, 0, takeover);
    assert.deepEqual(fixture.session.discussionReaders, {});
  }
});

test('expired, cancelled and identity-mismatched reader leases clean up safely', async () => {
  for (const reason of ['expired', 'cleared', 'different-tab']) {
    const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
    await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
    chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
    await handleDiscussionRequest({ action: 'sync', force: true });
    const entry = fixture.session.discussionReaders.ed;
    if (reason === 'expired') entry.expiresAt = Date.now() - 1;
    if (reason === 'cleared') delete fixture.data.discussions;
    if (reason === 'different-tab') fixture.ownedTabs.get(entry.tabId).url = 'https://edstem.org/us/#my-own-tab';
    await sweepDiscussionReaders();
    assert.equal(fixture.tabCalls.filter(c => c[0] === 'remove').length, reason === 'different-tab' ? 0 : 1, reason);
    assert.deepEqual(fixture.session.discussionReaders, {});
  }
});

test('failed reads and clearing data close an owned reader without restoring cancelled data', async () => {
  for (const cancelled of [false, true]) {
    const fixture = setup(async ({ discover, remoteId }, data) => {
      if (discover) return { courses: [{ remoteId: '1' }] };
      if (cancelled) { delete data.discussions; return feed(remoteId); }
      throw new Error('Session expired');
    });
    await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
    chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
    if (cancelled) await assert.rejects(sync(true), /saved data was cleared/);
    else assert.equal((await sync(true)).sources[0].status, 'error');
    assert.equal(fixture.tabCalls.filter(c => c[0] === 'remove').length, 1);
    assert.deepEqual(fixture.session.discussionReaders, {});
  }
});

test('initial site redirects settle into a stable identity, but later navigation is preserved', async () => {
  const { settleDiscussionReader } = await import('../extension/lib/discussion-readers.js');
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
  const update = chrome.tabs.update;
  chrome.tabs.update = async (id, options) => update(id, { ...options, url: 'https://edstem.org/us/dashboard' });
  await handleDiscussionRequest({ action: 'sync', force: true });
  const entry = fixture.session.discussionReaders.ed;
  assert.equal(entry.url, 'https://edstem.org/us/dashboard');
  assert.equal(entry.opening, false);
  const tab = fixture.ownedTabs.get(entry.tabId);
  tab.url = 'https://edstem.org/us/courses/1/discussion';
  await checkDiscussionReaderTab(tab.id);
  await settleDiscussionReader('ed', tab.id);
  assert.deepEqual(fixture.session.discussionReaders, {});
  assert.equal(fixture.ownedTabs.has(tab.id), true);
});

test('a worker resumes an about:blank reader whose ID was saved before navigation', async () => {
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  fixture.ownedTabs.set(99, { id: 99, active: false, status: 'complete' });
  fixture.session.discussionReaders = { ed: { tabId: 99, staging: true, opening: true, generation: fixture.data.discussions.generation,
    url: 'https://edstem.org/us/dashboard#boilerspace-reader=staged', expiresAt: Date.now() + 60000 } };
  chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
  const restarted = await import(`../extension/lib/discussion-readers.js?staged=${crypto.randomUUID()}`);
  await restarted.sweepDiscussionReaders();
  await sync(true);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'create').length, 0);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'update').length, 1);
  assert.deepEqual(fixture.tabCalls.filter(c => c[0] === 'remove'), [['remove', 99]]);
});

test('a site clearing the reader marker does not orphan the same owned page', async () => {
  const fixture = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : feed(remoteId, offset));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  chrome.tabs.query = async () => [...fixture.ownedTabs.values()];
  await handleDiscussionRequest({ action: 'sync', force: true });
  const entry = fixture.session.discussionReaders.ed;
  fixture.ownedTabs.get(entry.tabId).url = entry.url.split('#')[0] + '#';
  await checkDiscussionReaderTab(entry.tabId);
  assert.ok(fixture.session.discussionReaders.ed);
  await sync();
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'create').length, 1);
  assert.equal(fixture.tabCalls.filter(c => c[0] === 'remove').length, 1);
  assert.deepEqual(fixture.session.discussionReaders, {});
});

test('a page of previously seen pinned posts in a different order does not stop history import', async () => {
  const pages = { 0: [3, 2, 1], 3: [8, 7, 6], 6: [1, 2, 3], 9: [4], 10: [] };
  const fixture = setup(async ({ discover, remoteId, offset }) => {
    if (discover) return { courses: [{ remoteId: '1' }] };
    const ids = pages[offset];
    assert.ok(ids, `unexpected offset ${offset}`);
    return { name: 'Discussion course', errors: [], hasMore: ids.length > 0, nextOffset: offset + ids.length,
      pageIds: ids.map(String), seenIds: ids.map(String), versions: Object.fromEntries(ids.map(id => [id, 'v1'])),
      threads: ids.map(id => ({ users: [], thread: { id, course_id: Number(remoteId), number: id, title: `Post ${id}`, content: 'Instructor clarification' } })) };
  });
  const result = await connect();
  assert.equal(result.sources[0].status, 'done');
  assert.equal(result.sources[0].threads.length, 7);
  assert.equal(result.sources[0].checkedCount, 7);
  assert.deepEqual(fixture.calls.filter(call => !call.discover).map(call => call.offset), [0, 3, 6, 9, 10]);
});
