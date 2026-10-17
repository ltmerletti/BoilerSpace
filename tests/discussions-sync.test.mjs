import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDiscussionRequest } from '../extension/lib/discussions-sync.js';
import { snapshotFixture } from './helpers.mjs';

function setup(reader, granted = true) {
  const data = { snapshot: snapshotFixture() };
  const calls = [];
  globalThis.chrome = {
    storage: { local: {
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])),
      set: async (values) => Object.assign(data, structuredClone(values)),
    } },
    permissions: { contains: async () => granted },
    tabs: { query: async () => [{ id: 1, url: 'https://edstem.org/us/', status: 'complete' }], get: async () => ({ status: 'complete' }) },
    scripting: { executeScript: async ({ args }) => { calls.push(args[0]); return [{ result: await reader(args[0], data) }]; } },
  };
  return { data, calls };
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

test('a server repeating the same history page stops with a recoverable error', async () => {
  const { data } = setup(async ({ discover, remoteId, offset }) => discover ? { courses: [{ remoteId: '1' }] } : { ...feed(remoteId), nextOffset: offset + 1 });
  await connect();
  assert.equal(data.discussions.sources[0].status, 'error');
  assert.match(data.discussions.sources[0].error, /stopped advancing/);
  assert.equal(data.discussions.sources[0].threads.length, 1);
});

test('a failed temporary-tab navigation still closes the owned tab', async () => {
  setup(async () => { throw new Error('Must not inject before navigation'); });
  const removed = [];
  chrome.tabs.query = async () => [];
  chrome.tabs.create = async () => ({ id: 9 });
  chrome.tabs.update = async () => { throw new Error('Navigation failed'); };
  chrome.tabs.remove = async (id) => removed.push(id);
  await assert.rejects(handleDiscussionRequest({ action: 'connect', platform: 'ed' }), /Navigation failed/);
  assert.deepEqual(removed, [9]);
});
