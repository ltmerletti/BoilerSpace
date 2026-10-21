// Panels share the same course maps. Serialize their writes in the background context.
import * as store from './store.js';
import { assertDataEpoch, dataEpoch, serializeDataWrite } from './data-lifecycle.js';

export function saveSyllabusEntryHere(key, courseId, entry, epoch) {
  if (![store.KEYS.syllabi, store.KEYS.syllabusSources].includes(key) || !Number.isSafeInteger(courseId) || courseId <= 0) {
    return Promise.reject(new Error('Invalid syllabus storage entry.'));
  }
  return serializeDataWrite(async () => {
    await assertDataEpoch(epoch);
    return store.update(key, (all) => {
      const current = all[courseId];
      const previous = current?.status === 'done' ? current : current?.previous;
      const saved = key === store.KEYS.syllabi && entry.status === 'error' && !entry.previous && previous ? { ...entry, previous } : entry;
      return { ...all, [courseId]: saved };
    }, {});
  });
}

export async function saveSyllabusEntry(key, courseId, entry, epoch) {
  epoch ??= await dataEpoch();
  const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-save-syllabus', key, courseId, entry, epoch });
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'The syllabus result could not be saved.'), { code: reply?.code });
}
