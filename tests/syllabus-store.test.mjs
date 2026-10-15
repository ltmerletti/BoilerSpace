import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers.mjs';
import { saveSyllabusEntry, saveSyllabusEntryHere } from '../extension/lib/syllabus-store.js';

test('concurrent panel writes retain every course result and discovered source', async () => {
  const stored = installChrome();
  await Promise.all(Array.from({ length: 20 }, (_, index) => Promise.all([
    saveSyllabusEntry('syllabi', index + 1, { status: 'done' }),
    saveSyllabusEntry('syllabusSources', index + 1, { topic: { id: `tab:${index}` } }),
  ])));
  assert.equal(Object.keys(stored.syllabi).length, 20);
  assert.equal(Object.keys(stored.syllabusSources).length, 20);
});

test('the syllabus writer refuses unrelated storage keys', async () => {
  const stored = installChrome();
  await assert.rejects(saveSyllabusEntryHere('genai', 1, {}), /Invalid syllabus/);
  await assert.rejects(saveSyllabusEntryHere('syllabi', -1, {}), /Invalid syllabus/);
  assert.equal(stored.genai, undefined);
  await saveSyllabusEntry('syllabi', 1, { status: 'none' });
  assert.equal(stored.syllabi[1].status, 'none');
});

test('a late failure from another panel preserves an extraction saved while it was reading', async () => {
  const stored = installChrome();
  const done = { courseId: 1, status: 'done', pages: [{ text: 'The saved syllabus.' }], deadlines: [] };
  await saveSyllabusEntry('syllabi', 1, done);
  await saveSyllabusEntry('syllabi', 1, { courseId: 1, status: 'error', error: 'Failed to fetch', previous: null });
  assert.deepEqual(stored.syllabi[1].previous, done);
});
