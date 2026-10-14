import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeBrightspace, installChrome } from './helpers.mjs';
import { createClient, syncCurrentCourses } from '../extension/lib/brightspace.js';
import { LOCK_STALE_MS, lockIsFresh, runSync } from '../extension/lib/sync-store.js';

const ORIGIN = 'https://purdue.brightspace.com';

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
  assert.deepEqual(progress.filter((p) => p.total).map((p) => `${p.done}/${p.total}`), ['0/3', '1/3', '2/3', '3/3']);
  assert.match(progress.find((p) => p.total)?.message, /\(1 of 3\)/);
  assert.ok(progress.some((p) => p.message.startsWith('Syncing CS 25200')), 'courses are named by their short label');
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
