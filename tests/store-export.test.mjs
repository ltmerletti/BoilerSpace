import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getExportData } from '../extension/lib/store.js';

test('user data exports omit both connection credentials while keeping course data', async () => {
  const original = globalThis.chrome;
  const data = { discussionAuth: { ed: 'private-ed-token' }, genai: { key: 'private-model-key' }, _dataEpoch: 'internal', genaiLinkAttempt: { id: 'internal' },
    discussions: { sources: [{ id: 'ed:1', threads: [{ text: 'Saved instructor answer' }] }] }, snapshot: { courses: [] }, ui: { view: 'ask' } };
  globalThis.chrome = { storage: { local: { get: async () => structuredClone(data) } } };
  try {
    const exported = await getExportData();
    assert.equal(exported.discussionAuth, undefined);
    assert.equal(exported.genai, undefined);
    assert.equal(exported.ui, undefined);
    assert.equal(exported._dataEpoch, undefined);
    assert.equal(exported.genaiLinkAttempt, undefined);
    assert.deepEqual(exported.discussions, data.discussions);
    assert.ok(!JSON.stringify(exported).includes('private-'));
    assert.equal(data.discussionAuth.ed, 'private-ed-token');
  } finally { globalThis.chrome = original; }
});
