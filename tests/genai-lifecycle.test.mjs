import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MODEL, getConnection, linkAccount, refreshModels, setModel, unlink } from '../extension/lib/genai.js';
import { handleGenaiDataRequest } from '../extension/lib/genai-store.js';
import { clearLocalDataHere } from '../extension/lib/data-lifecycle.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(finish => { resolve = finish; });
  return { promise, resolve };
};
const originalConnection = () => ({ key: 'synthetic-old-key', model: DEFAULT_MODEL, models: [DEFAULT_MODEL, 'another-model'], linkedAt: '2026-10-01T00:00:00Z' });
const modelsResponse = () => Response.json({ data: [{ id: DEFAULT_MODEL }, { id: 'another-model' }] });

function fixture() {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const values = { genai: originalConnection() };
  globalThis.chrome = {
    storage: { local: {
      get: async key => key === null ? structuredClone(values) : { [key]: structuredClone(values[key]) },
      set: async next => Object.assign(values, structuredClone(next)),
      remove: async key => { delete values[key]; },
      clear: async () => { for (const key of Object.keys(values)) delete values[key]; },
    }, session: { remove: async () => {} } },
    runtime: { sendMessage: async message => {
      try { return { ok: true, data: await handleGenaiDataRequest(message) }; }
      catch (error) { return { ok: false, error: error.message, code: error.code }; }
    } },
  };
  return { values, restore() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  } };
}

function pauseModels() {
  const started = deferred(), response = deferred();
  globalThis.fetch = async url => {
    assert.equal(url, 'https://genai.rcac.purdue.edu/api/models');
    started.resolve();
    return response.promise;
  };
  return { started: started.promise, finish: () => response.resolve(modelsResponse()) };
}

test('a delayed model refresh preserves a model chosen while it was fetching', async () => {
  const f = fixture(), request = pauseModels();
  try {
    const refresh = refreshModels();
    await request.started;
    await setModel('another-model');
    request.finish();
    await refresh;
    assert.equal(f.values.genai.model, 'another-model');
    assert.equal(f.values.genai.modelChosen, true);
    assert.deepEqual(f.values.genai.models, ['another-model', DEFAULT_MODEL]);
  } finally { f.restore(); }
});

test('disconnecting while models are fetching cannot restore the saved key', async () => {
  const f = fixture(), request = pauseModels();
  try {
    const refresh = refreshModels();
    await request.started;
    await unlink();
    request.finish();
    await refresh;
    assert.equal(f.values.genai, undefined);
  } finally { f.restore(); }
});

test('an old model refresh cannot overwrite a newer connection', async () => {
  const f = fixture(), request = pauseModels();
  try {
    const refresh = refreshModels();
    await request.started;
    const attempt = await handleGenaiDataRequest({ action: 'genai-link-begin' });
    await handleGenaiDataRequest({ action: 'genai-link-finish', ...attempt, connection: { key: 'synthetic-new-key', model: 'new-model', models: ['new-model'] } });
    request.finish();
    await refresh;
    assert.equal(f.values.genai.key, 'synthetic-new-key');
    assert.equal(f.values.genai.model, 'new-model');
    assert.deepEqual(f.values.genai.models, ['new-model']);
  } finally { f.restore(); }
});

test('clearing data invalidates a delayed refresh even when an identical connection is added later', async () => {
  const f = fixture(), request = pauseModels();
  try {
    const refresh = refreshModels();
    await request.started;
    await clearLocalDataHere();
    await chrome.storage.local.set({ genai: originalConnection() });
    request.finish();
    await refresh;
    assert.deepEqual(f.values.genai, originalConnection());
  } finally { f.restore(); }
});

test('connection migration and model selection serialize with disconnect', async () => {
  const f = fixture();
  try {
    f.values.genai = { key: 'synthetic', model: 'old-model' };
    await Promise.all([getConnection(), setModel('another-model'), unlink()]);
    assert.equal(f.values.genai, undefined);
  } finally { f.restore(); }
});

function pauseLinkModels() {
  const started = deferred(), response = deferred();
  globalThis.fetch = async url => {
    if (url.endsWith('/api/v1/auths/')) return Response.json({ name: 'Synthetic user' });
    if (url.endsWith('/api/v1/auths/api_key')) return Response.json({ api_key: 'synthetic-linked-key' });
    assert.equal(url, 'https://genai.rcac.purdue.edu/api/models');
    started.resolve();
    return response.promise;
  };
  return { started: started.promise, finish: () => response.resolve(modelsResponse()) };
}

test('a completed account link saves its connection and removes the attempt marker', async () => {
  const f = fixture(), request = pauseLinkModels();
  try {
    const linking = linkAccount();
    await request.started;
    request.finish();
    const connection = await linking;
    assert.equal(connection.key, 'synthetic-linked-key');
    assert.equal(connection.model, DEFAULT_MODEL);
    assert.equal(typeof connection.generation, 'string');
    assert.deepEqual(f.values.genai, connection);
    assert.equal(f.values.genaiLinkAttempt, undefined);
  } finally { f.restore(); }
});

test('an obsolete link cannot remove the marker for a newer pending link', async () => {
  const f = fixture(), request = pauseLinkModels();
  try {
    const linking = linkAccount();
    await request.started;
    const newer = await handleGenaiDataRequest({ action: 'genai-link-begin' });
    request.finish();
    await assert.rejects(linking, error => error.code === 'link-cancelled');
    assert.equal(f.values.genaiLinkAttempt.id, newer.attemptId);
    await handleGenaiDataRequest({ action: 'genai-link-finish', ...newer, connection: { key: 'newer-key', model: DEFAULT_MODEL } });
    assert.equal(f.values.genai.key, 'newer-key');
  } finally { f.restore(); }
});

for (const interruption of ['disconnect', 'clear', 'newer-link']) {
  test(`a delayed account link cannot finish after ${interruption}`, async () => {
    const f = fixture(), request = pauseLinkModels();
    try {
      const linking = linkAccount();
      await request.started;
      if (interruption === 'disconnect') await unlink();
      else if (interruption === 'clear') await clearLocalDataHere();
      else {
        const attempt = await handleGenaiDataRequest({ action: 'genai-link-begin' });
        await handleGenaiDataRequest({ action: 'genai-link-finish', ...attempt, connection: { key: 'newer-key', model: 'new-model' } });
      }
      request.finish();
      await assert.rejects(linking, error => error.code === (interruption === 'clear' ? 'data-cleared' : 'link-cancelled'));
      assert.equal(f.values.genai?.key, interruption === 'newer-link' ? 'newer-key' : undefined);
      assert.equal(f.values.genaiLinkAttempt, undefined);
    } finally { f.restore(); }
  });
}
