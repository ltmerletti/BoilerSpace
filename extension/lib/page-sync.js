// Runs inside a purdue.brightspace.com page (loaded by content.js), so requests use the student's session.

import { runInPage, syllabusHrefsInDocument } from './brightspace.js';
import { isSyncDue, runSync } from './sync-store.js';

export const syllabusHrefsHere = () => syllabusHrefsInDocument(globalThis.document);

export function syncHere({ xsrfToken = null, pageLinks = syllabusHrefsHere() } = {}) {
  const owner = `${location.pathname}#${Math.random().toString(36).slice(2, 10)}`;
  return runSync(owner, async (onProgress) => {
    const response = await runInPage('sync', { xsrfToken, pageLinks }, { onProgress });
    if (!response.ok) throw Object.assign(new Error(response.error), { status: response.status, path: response.path });
    return response.result;
  });
}

export async function autoSyncIfDue(options) {
  if (!(await isSyncDue())) return { ok: true, skipped: true };
  return syncHere(options);
}

export function readQuizHere({ xsrfToken = null, courseId, quizId, dueAt = null, endAt = null } = {}) {
  return runInPage('read-quiz', { xsrfToken, courseId, quizId, dueAt, endAt });
}

export function downloadHere(path, { xsrfToken = null, seeImages = false, location = null } = {}) {
  return runInPage('download', { path, xsrfToken, seeImages, location });
}
