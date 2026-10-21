import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, snapshotFixture, SYLLABUS_PAGES, MODEL_OUTPUT } from './helpers.mjs';
import { clearLocalDataHere, dataEpoch, dataRequest, saveChatsHere } from '../extension/lib/data-lifecycle.js';
import { saveSyllabusEntry } from '../extension/lib/syllabus-store.js';
import { processCourse, processCurrentSyllabi, readUploadedSyllabus } from '../extension/lib/syllabus.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
};
const cancelled = error => error.code === 'data-cleared';
const available = { kind: 'pdf', pages: SYLLABUS_PAGES, fileName: 'Syllabus.pdf' };

test('an outdated background response asks for an extension reload instead of reporting a storage failure', async () => {
  const stored = installChrome();
  stored.genai = { key: 'synthetic-key' };
  chrome.runtime.sendMessage = async () => undefined;
  await assert.rejects(dataRequest('genai-read'), error => error.code === 'background-unavailable' && /Reload BoilerSpace/.test(error.message));
  assert.equal(stored.genai.key, 'synthetic-key');
});

test('clear is serialized with queued writes and rejects obsolete syllabus and chat saves', async () => {
  const stored = installChrome();
  const epoch = await dataEpoch();
  const first = saveSyllabusEntry('syllabi', 1, { status: 'done', pages: SYLLABUS_PAGES }, epoch);
  await clearLocalDataHere();
  await first;
  await assert.rejects(saveSyllabusEntry('syllabi', 1, { status: 'error', previous: available }, epoch), cancelled);
  await assert.rejects(saveSyllabusEntry('syllabusSources', 1, { topic: { text: 'Old source text' } }, epoch), cancelled);
  await assert.rejects(saveChatsHere([{ messages: ['Old question'] }], epoch), cancelled);
  assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
  assert.notEqual(await dataEpoch(), epoch);
  await saveSyllabusEntry('syllabi', 2, { status: 'none' });
  assert.equal(stored.syllabi[2].status, 'none', 'new work is allowed after clearing');
});

test('clear does not expose old legacy chat data under the new epoch to another panel', async () => {
  const stored = installChrome();
  stored.chat = [{ role: 'user', content: 'Old saved question' }];
  const migrations = [];
  chrome.storage.onChanged.addListener(changes => {
    if (changes._dataEpoch && stored.chat?.length) {
      // An open panel migrates legacy messages when it reloads local state.
      migrations.push(saveChatsHere([{ messages: structuredClone(stored.chat) }], stored._dataEpoch));
    }
  });
  await clearLocalDataHere();
  await Promise.all(migrations);
  assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
});

test('an upload held before reading its bytes keeps its original clear boundary', async () => {
  const stored = installChrome();
  const epoch = await dataEpoch();
  await clearLocalDataHere();
  await assert.rejects(readUploadedSyllabus(null, 1600001, available, { epoch }), cancelled);
  assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
});

for (const failure of [false, true]) {
  test(`a delayed syllabus download ${failure ? 'failure' : 'success'} cannot restore cleared pages`, async () => {
    const stored = installChrome();
    stored.syllabi = { 1600001: { status: 'done', pages: SYLLABUS_PAGES } };
    const started = deferred(), finish = deferred();
    const work = processCourse(snapshotFixture(), 1600001, { force: true, download: async () => {
      started.resolve();
      await finish.promise;
      if (failure) throw new Error('Failed to fetch');
      return available;
    } });
    const rejected = assert.rejects(work, cancelled);
    await started.promise;
    await clearLocalDataHere();
    finish.resolve();
    await rejected;
    assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
  });
}

test('a cancelled discovery cannot save its text or continue into other courses and retries', async () => {
  const stored = installChrome();
  const snapshot = snapshotFixture();
  snapshot.data.forEach(course => { course.content = []; });
  const started = deferred(), finish = deferred();
  let lookups = 0;
  const work = processCurrentSyllabi(snapshot, { discover: async () => {
    lookups++;
    started.resolve();
    await finish.promise;
    return { id: 'tab:old', title: 'Syllabus', text: 'Saved source text before clearing.' };
  } });
  const rejected = assert.rejects(work, cancelled);
  await started.promise;
  await clearLocalDataHere();
  finish.resolve();
  await rejected;
  assert.equal(lookups, 1);
  assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
});

test('an uploaded syllabus cannot restore pages when its model response arrives after clearing', async () => {
  const stored = installChrome();
  stored.genai = { key: 'synthetic-key', model: 'qwen3.8:27b' };
  const previousFetch = globalThis.fetch;
  const started = deferred(), finish = deferred();
  globalThis.fetch = async () => {
    started.resolve();
    await finish.promise;
    return Response.json({ choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }] });
  };
  try {
    const work = readUploadedSyllabus(snapshotFixture(), 1600001, available);
    const rejected = assert.rejects(work, cancelled);
    await started.promise;
    await clearLocalDataHere();
    finish.resolve();
    await rejected;
    assert.deepEqual(Object.keys(stored), ['_dataEpoch']);
  } finally { globalThis.fetch = previousFetch; }
});
