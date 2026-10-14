// Runs inside a purdue.brightspace.com page (loaded by content.js), so requests use the student's session.

import { runInPage } from './brightspace.js';
import { isSyncDue, runSync } from './sync-store.js';

export function syncHere({ xsrfToken = null } = {}) {
  const owner = `${location.pathname}#${Math.random().toString(36).slice(2, 10)}`;
  return runSync(owner, async (onProgress) => {
    const response = await runInPage('sync', { xsrfToken }, { onProgress });
    if (!response.ok) throw Object.assign(new Error(response.error), { status: response.status, path: response.path });
    return response.result;
  });
}

export async function autoSyncIfDue(options) {
  if (!(await isSyncDue())) return { ok: true, skipped: true };
  return syncHere(options);
}

export function downloadHere(path, { xsrfToken = null } = {}) {
  return runInPage('download', { path, xsrfToken });
}
