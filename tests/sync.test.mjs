import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrightspace, installChrome, snapshotFixture } from './helpers.mjs';
import { createClient, syncCurrentCourses } from '../extension/lib/brightspace.js';
import { LOCK_STALE_MS, lockIsFresh, runSync } from '../extension/lib/sync-store.js';

const ORIGIN = 'https://purdue.brightspace.com';

test('read-only companions can sync course material without issuing any grade requests', async () => {
  const { fetchImpl, calls } = fakeBrightspace();
  const result = await syncCurrentCourses(createClient({ origin: ORIGIN, fetchImpl, xsrfToken: 'xsrf-123' }), {
    origin: ORIGIN, includeGrades: false, now: new Date('2026-10-12T16:00:00Z'),
  });
  assert.ok(result.data.length > 0);
  assert.ok(result.data.every(course => course.grades.length === 0));
  assert.equal(calls.some(call => /\/grades\//.test(call.path)), false);
});

test('a sync reports progress per course, saves the snapshot and frees the lock', async () => {
  const data = installChrome();
  const progress = [];
  const { fetchImpl } = fakeBrightspace();
  const client = createClient({ origin: ORIGIN, fetchImpl, xsrfToken: 'xsrf-123' });

  const result = await runSync('tab-a', (onProgress) =>
    syncCurrentCourses(client, {
      origin: ORIGIN,
      now: new Date('2026-10-12T16:00:00Z'),
      onProgress: (p) => {
        progress.push(p);
        return onProgress(p);
      },
    }),
  );

  assert.equal(result.ok, true);
  assert.deepEqual(progress.filter((p) => p.message.startsWith('Synced')).map((p) => `${p.done}/${p.total}`), ['1/3', '2/3', '3/3']);
  assert.equal(progress.find((p) => p.message === 'Saving…')?.done, 3);
  assert.ok(!progress.some((p) => /syllabus/.test(p.message)), 'syllabus discovery is separate from course sync');
  assert.ok(progress.some((p) => p.message.startsWith('Synced CS 25200')), 'courses are named by their short label');
  assert.equal(data.snapshot.courses.length, 28);
  assert.equal(data.syncMeta.ok, true);
  assert.equal(data.syncProgress.finished, true);
  assert.equal(data.syncLock, undefined);
});

test('a second sync waits for a live one, and a dead one stops blocking after its heartbeat goes stale', async () => {
  const data = installChrome();
  data.syncLock = { owner: 'tab-a', heartbeat: Date.now() };
  assert.equal((await runSync('tab-b', async () => assert.fail('should not run'))).skipped, true);

  data.syncLock = { owner: 'tab-a', heartbeat: Date.now() - LOCK_STALE_MS - 1 };
  assert.equal(lockIsFresh(data.syncLock), false);
  const failed = await runSync('tab-b', async () => {
    throw Object.assign(new Error('HTTP 500'), { path: '/d2l/api/versions/' });
  });
  assert.equal(failed.ok, false);
  assert.equal(data.syncMeta.ok, false);
  assert.equal(data.syncMeta.error, 'HTTP 500');
  assert.equal(data.syncProgress.failed, true);
  assert.equal(data.syncLock, undefined);
});

test('a quiet request keeps its sync lock beyond the old 30 second limit', async (t) => {
  const data = installChrome();
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  let finish;
  const running = runSync('slow-tab', () => new Promise((resolve) => { finish = resolve; }));
  while (!finish) await Promise.resolve();
  for (let i = 0; i < 4; i++) {
    t.mock.timers.tick(10_000);
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
  assert.equal(lockIsFresh(data.syncLock), true);
  assert.equal((await runSync('other-tab', () => assert.fail('a second sync must not start'))).skipped, true);
  finish({ data: [], courses: [], requestLog: [], errors: [], fetchedAt: new Date().toISOString() });
  assert.equal((await running).ok, true);
  assert.equal(data.syncProgress.finished, true);
  assert.equal(data.syncLock, undefined);
  t.mock.timers.tick(40_000);
  await Promise.resolve();
  assert.equal(data.syncLock, undefined, 'the heartbeat stops when the sync finishes');
});

test('ordinary sync recovers stale progress and preserves a previously discovered source', async () => {
  const data = installChrome();
  data.snapshot = snapshotFixture();
  data.snapshot.data[0].syllabusTab = { id: 'tab:77', title: 'Syllabus' };
  data.syncProgress = { finished: false, at: Date.now() - 40_000 };
  const { fetchImpl, calls } = fakeBrightspace();
  const result = await runSync('recovery', (onProgress) => syncCurrentCourses(createClient({ origin: ORIGIN, fetchImpl, xsrfToken: 'xsrf-123' }), {
    origin: ORIGIN, now: new Date('2026-10-12T16:00:00Z'), onProgress,
    readTab: { links: () => assert.fail('course sync must not open syllabus tabs') },
  }));
  assert.equal(result.ok, true);
  assert.equal(data.syncProgress.finished, true);
  assert.equal(data.snapshot.data.find((d) => d.courseId === 1600001).syllabusTab.id, 'tab:77');
  assert.equal(calls.some((call) => /\/d2l\/home\/|\/content\/\d+\/Home/.test(call.path)), false);
});

test('a displaced sync cannot overwrite the new owner or save its late result', async () => {
  const data = installChrome();
  const other = { owner: 'new-tab', heartbeat: Date.now() };
  const result = await runSync('old-tab', async (progress) => {
    data.syncLock = other;
    await progress({ message: 'A late update' });
    return snapshotFixture();
  });
  assert.equal(result.ok, false);
  assert.deepEqual(data.syncLock, other);
  assert.equal(data.snapshot, undefined);
});
