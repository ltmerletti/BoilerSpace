// Panels share the same course maps. Serialize their writes in the background context.
import * as store from './store.js';

let pending = Promise.resolve();

export function saveSyllabusEntryHere(key, courseId, entry) {
  if (![store.KEYS.syllabi, store.KEYS.syllabusSources].includes(key) || !Number.isSafeInteger(courseId) || courseId <= 0) {
    return Promise.reject(new Error('Invalid syllabus storage entry.'));
  }
  const write = pending.catch(() => {}).then(() => store.update(key, (all) => ({ ...all, [courseId]: entry }), {}));
  pending = write;
  return write;
}

export async function saveSyllabusEntry(key, courseId, entry) {
  const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-save-syllabus', key, courseId, entry });
  if (!reply?.ok) throw new Error(reply?.error || 'The syllabus result could not be saved.');
}
