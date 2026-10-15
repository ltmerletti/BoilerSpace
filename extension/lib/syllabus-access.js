import * as store from './store.js';

export const SYLLABUS_SITE = 'https://purdue.simplesyllabus.com/*';
export const isSyllabusAccessError = (error) => /needs access to purdue\.simplesyllabus\.com/i.test(String(error ?? ''));

// Called in a privileged extension page or the background context, never the embedded frame.
export async function reportSyllabusAccess() {
  const granted = await chrome.permissions.contains({ origins: [SYLLABUS_SITE] });
  if ((await store.get(store.KEYS.syllabusAccess)) !== granted) await store.set(store.KEYS.syllabusAccess, granted);
  return granted;
}
