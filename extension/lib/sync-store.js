// Storage side of syncing, shared by the Brightspace page (which runs the sync) and the panel (which shows it).
// The lock carries a heartbeat that every progress update refreshes, so a sync cut off by leaving the
// page frees the lock within LOCK_STALE_MS.

import * as store from './store.js';
import { diffSnapshots, mergeChanges } from './changes.js';

export const AUTO_SYNC_INTERVAL_MS = 20 * 60_000;
export const LOCK_STALE_MS = 30_000;

export const lockIsFresh = (lock, now = Date.now()) => Boolean(lock?.heartbeat && now - lock.heartbeat < LOCK_STALE_MS);

export async function isSyncDue() {
  const meta = await store.get(store.KEYS.syncMeta);
  return !meta?.lastSuccessAt || Date.now() - Date.parse(meta.lastSuccessAt) > AUTO_SYNC_INTERVAL_MS;
}

async function acquireLock(owner) {
  if (lockIsFresh(await store.get(store.KEYS.syncLock))) return false;
  await store.set(store.KEYS.syncLock, { owner, heartbeat: Date.now() });
  return (await store.get(store.KEYS.syncLock))?.owner === owner;
}

async function releaseLock(owner) {
  if ((await store.get(store.KEYS.syncLock))?.owner === owner) await store.remove(store.KEYS.syncLock);
}

function progressReporter(owner, startedAt) {
  return (progress) =>
    chrome.storage.local
      .set({
        [store.KEYS.syncLock]: { owner, heartbeat: Date.now() },
        [store.KEYS.syncProgress]: { ...progress, owner, startedAt, at: Date.now(), finished: false },
      })
      .catch(() => {});
}

export async function saveSyncResult(result) {
  const previous = await store.get(store.KEYS.snapshot);
  const changes = diffSnapshots(previous, result);
  await store.set(store.KEYS.snapshot, result);
  await store.update(store.KEYS.changes, (existing) => mergeChanges(existing ?? [], changes), []);
  await store.set(store.KEYS.syncMeta, {
    ok: true,
    at: result.fetchedAt,
    lastSuccessAt: result.fetchedAt,
    durationMs: result.durationMs,
    authMode: result.authMode,
    versions: result.versions,
    requestCount: result.requestLog.length,
    failedCount: result.requestLog.filter((r) => r.status >= 400).length,
    errors: result.errors,
    newChanges: changes.length,
  });
  return changes;
}

export async function saveSyncFailure(err) {
  const previous = await store.get(store.KEYS.syncMeta);
  await store.set(store.KEYS.syncMeta, { ...(previous ?? {}), ok: false, at: new Date().toISOString(), error: err.message, errorPath: err.path ?? null });
}

// run(onProgress) does the Brightspace work and resolves to a sync result.
export async function runSync(owner, run) {
  if (!(await acquireLock(owner))) return { ok: true, skipped: true };
  const startedAt = Date.now();
  const onProgress = progressReporter(owner, startedAt);
  try {
    await onProgress({ message: 'Starting…', done: 0, total: null });
    const result = await run(onProgress);
    const changes = await saveSyncResult(result);
    await store.set(store.KEYS.syncProgress, { message: 'Done', done: 1, total: 1, owner, startedAt, at: Date.now(), finished: true });
    return { ok: true, newChanges: changes.length };
  } catch (err) {
    await saveSyncFailure(err);
    await store.set(store.KEYS.syncProgress, { message: err.message, owner, startedAt, at: Date.now(), finished: true, failed: true });
    return { ok: false, error: err.message, status: err.status ?? null, path: err.path ?? null };
  } finally {
    await releaseLock(owner);
  }
}
