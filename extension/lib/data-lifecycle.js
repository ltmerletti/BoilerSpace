import * as store from './store.js';

export const DATA_EPOCH_KEY = '_dataEpoch';
let pending = Promise.resolve();

// Clear and protected writes share one queue in the background context.
export function serializeDataWrite(write) {
  const next = pending.catch(() => {}).then(write);
  pending = next;
  return next;
}

export function dataEpoch() {
  return store.get(DATA_EPOCH_KEY, 'initial');
}

export async function assertDataEpoch(epoch) {
  if (typeof epoch !== 'string' || epoch !== await dataEpoch()) {
    throw Object.assign(new Error('Local data was cleared. This operation was cancelled.'), { code: 'data-cleared' });
  }
}

export function clearLocalDataHere() {
  return serializeDataWrite(async () => {
    const epoch = crypto.randomUUID();
    await chrome.storage.session.remove('discussionAuth');
    await chrome.storage.local.clear();
    // The queue prevents writes between clearing and publishing the new epoch.
    await store.set(DATA_EPOCH_KEY, epoch);
  });
}

export function saveChatsHere(chats, epoch) {
  return serializeDataWrite(async () => {
    await assertDataEpoch(epoch);
    if (!Array.isArray(chats)) throw new Error('Invalid chats.');
    await store.set(store.KEYS.chats, chats);
  });
}

export function chooseSyllabusHere(courseId, choice, epoch) {
  return serializeDataWrite(async () => {
    await assertDataEpoch(epoch);
    if (!Number.isSafeInteger(courseId) || courseId <= 0) throw new Error('Invalid syllabus course.');
    await store.update(store.KEYS.syllabusChoice, all => {
      const next = { ...all };
      if (choice === null) delete next[courseId];
      else next[courseId] = choice;
      return next;
    }, {});
  });
}

export async function dataRequest(action, fields = {}) {
  const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-data', ...fields, action });
  if (!reply) throw Object.assign(new Error('Reload BoilerSpace from your browser’s extension manager, then refresh this page.'), { code: 'background-unavailable' });
  if (!reply?.ok) throw Object.assign(new Error(reply?.error || 'Local data could not be updated.'), { code: reply?.code });
  return reply.data;
}
