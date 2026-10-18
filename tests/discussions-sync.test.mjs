import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDiscussionSync } from '../extension/lib/discussions-sync.js';
import { snapshotFixture } from './helpers.mjs';
let handleDiscussionRequest;

function setup(reader, granted = true) {
  const data = { snapshot: snapshotFixture() };
  const calls = [], session = {};
  globalThis.chrome = {
    storage: { session: { remove: async key => { delete session[key]; } }, local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values)),
    } },
  };
  handleDiscussionRequest = createDiscussionSync(async args => {
    if (!granted) throw new Error('Allow discussion site access by reconnecting in Settings.');
    calls.push(args);
    return reader(args, data);
  });
  return { data, calls, session };
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
  handleDiscussionRequest = createDiscussionSync(async () => { throw new Error('Session expired'); });
  await handleDiscussionRequest({ action: 'sync', force: true });
  assert.equal(data.discussions.sources[0].status, 'error');
  assert.equal(data.discussions.sources[0].threads[0].text, 'Friday');
});

test('site access is checked before reading discussion data', async () => {
  const { calls } = setup(async () => { throw new Error('Should not run'); }, false);
  await assert.rejects(handleDiscussionRequest({ action: 'connect', platform: 'ed' }), /Allow discussion site access/);
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
  await handleDiscussionRequest({ action: 'connect', platform: 'piazza', url: 'https://piazza.com/class/example' });
  assert.equal(data.discussions.sources[0].courseId, 1600001);
  assert.equal(calls.length, 1);
  handleDiscussionRequest = createDiscussionSync(async () => ({ courses: [] }));
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

test('clearing data while a batch is in flight does not restore cancelled posts', async () => {
  const { data } = setup(async ({ discover, remoteId }, data) => {
    if (discover) return { courses: [{ remoteId: '1' }] };
    delete data.discussions;
    return feed(remoteId);
  });
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  await assert.rejects(sync(true), /saved data was cleared/);
  assert.equal(data.discussions, undefined);
});

test('disconnecting the final Ed source clears its session credential', async () => {
  const { session } = setup(async () => ({ courses: [{ remoteId: '1' }] }));
  await handleDiscussionRequest({ action: 'connect', platform: 'ed' });
  session.discussionAuth = { ed: 'fixture-token' };
  await handleDiscussionRequest({ action: 'remove', sourceId: 'ed:1' });
  assert.equal(session.discussionAuth, undefined);
});
