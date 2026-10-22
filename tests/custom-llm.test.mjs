import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome } from './helpers.mjs';
import { apiPermission, customConnection, normalizeApiBase } from '../extension/lib/llm-config.js';
import { chatCompletion, getConnection, refreshModels, saveCustomConnection, setModel, setProvider, unlink } from '../extension/lib/genai.js';
import { getExportData } from '../extension/lib/store.js';
import { clearLocalDataHere } from '../extension/lib/data-lifecycle.js';

const values = { baseUrl: 'https://models.example/v1', key: 'synthetic-custom-secret', model: 'reasoning-model' };
const request = { messages: [{ role: 'user', content: 'What is due?' }], tools: [{ type: 'function', function: { name: 'list_upcoming', parameters: { type: 'object', properties: {} } } }], temperature: 0.2 };
const response = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Ready.' } }] });

function fixture() {
  const previous = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  const stored = installChrome();
  stored.genai = { key: 'synthetic-purdue-secret', model: 'qwen3.8:27b' };
  let allowed = true;
  const permissions = [];
  chrome.permissions = {
    contains: async () => allowed,
    request: async permission => { permissions.push(permission); return allowed; },
  };
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, ...options }); return response(); };
  return { stored, calls, permissions, deny() { allowed = false; }, restore() {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  } };
}

test('API base URLs normalize a trailing slash or a complete chat endpoint', () => {
  assert.equal(normalizeApiBase(' https://models.example/v1/chat/completions/ '), values.baseUrl);
  assert.equal(normalizeApiBase('http://localhost:1234/v1/'), 'http://localhost:1234/v1');
  assert.equal(apiPermission('http://127.0.0.1:1234/v1'), 'http://127.0.0.1/*');
  for (const url of ['http://models.example/v1', 'file:///tmp/api', 'javascript:alert(1)', 'https://key@models.example/v1', 'https://models.example/v1?key=secret', 'https://models.example/v1#secret', 'https://*/v1', 'https://*.example.com/v1']) assert.throws(() => normalizeApiBase(url));
  assert.throws(() => customConnection({ ...values, key: '' }), /API key/);
  assert.equal(customConnection({ ...values, baseUrl: 'http://localhost:1234/v1', key: '' }).key, '');
  assert.throws(() => customConnection({ ...values, model: '' }), /model ID/);
  assert.throws(() => customConnection({ ...values, key: 'key\nheader' }), /whitespace/);
});

test('saving a custom API requests only its host and retains the Purdue connection', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    assert.deepEqual(f.permissions, [{ origins: ['https://models.example/*'] }]);
    assert.equal((await getConnection()).provider, 'custom');
    assert.equal(f.stored.genai.key, 'synthetic-purdue-secret');
    assert.equal(f.calls.length, 0, 'saving does not spend tokens or send course data');
    await setProvider('purdue');
    assert.equal((await getConnection()).key, 'synthetic-purdue-secret');
    await setProvider('custom');
    assert.equal((await getConnection()).model, values.model, 'custom model is never migrated to the Purdue default');
  } finally { f.restore(); }
});

test('permission denial does not save a custom key or change the active provider', async () => {
  const f = fixture();
  try {
    f.deny();
    await assert.rejects(saveCustomConnection(values), /not allowed/);
    assert.equal(f.stored.customLlm, undefined);
    assert.equal((await getConnection()).key, 'synthetic-purdue-secret');
  } finally { f.restore(); }
});

test('custom requests send only the selected secret and reject redirects', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    assert.equal((await chatCompletion(request)).content, 'Ready.');
    const call = f.calls[0], body = JSON.parse(call.body);
    assert.equal(call.url, `${values.baseUrl}/chat/completions`);
    assert.equal(call.headers.Authorization, `Bearer ${values.key}`);
    assert.equal(call.credentials, 'omit');
    assert.equal(call.redirect, 'error');
    assert.equal(body.model, values.model);
    assert.deepEqual(body.tools, request.tools);
    assert.equal(body.temperature, undefined);
    assert.equal(body.store, false);
    assert.ok(!JSON.stringify(call).includes('synthetic-purdue-secret'));
    f.deny();
    await assert.rejects(chatCompletion(request), error => error.code === 'site-access');
    assert.equal(f.calls.length, 1, 'revocation prevents sending the key or course content');
  } finally { f.restore(); }
});

test('an embedded panel without the permissions API checks API access through the background', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    const send = chrome.runtime.sendMessage;
    let checked = false;
    chrome.runtime.sendMessage = message => {
      if (message.action !== 'genai-api-access') return send(message);
      checked = true;
      return Promise.resolve({ ok: true, data: true });
    };
    delete chrome.permissions;
    assert.equal((await chatCompletion(request)).content, 'Ready.');
    assert.equal(checked, true);
  } finally { f.restore(); }
});

test('custom model discovery uses the configured path and a missing model endpoint does not block chat', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    globalThis.fetch = async url => {
      assert.equal(url, `${values.baseUrl}/models`);
      return Response.json({ data: [{ id: 'new-model' }, { id: 'embedding-only' }] });
    };
    assert.deepEqual(await refreshModels(), ['new-model']);
    globalThis.fetch = async () => new Response('', { status: 404 });
    await assert.rejects(refreshModels(), /enter a model ID/);
    globalThis.fetch = async () => response();
    assert.equal((await chatCompletion(request)).content, 'Ready.');
  } finally { f.restore(); }
});

test('a local API can list models and answer without an Authorization header', async () => {
  const f = fixture();
  try {
    await saveCustomConnection({ ...values, baseUrl: 'http://localhost:1234/v1', key: '' });
    globalThis.fetch = async (url, options) => {
      assert.equal(options.headers.Authorization, undefined);
      return url.endsWith('/models') ? Response.json({ data: [{ id: 'local-model' }] }) : response();
    };
    assert.deepEqual(await refreshModels(), ['local-model']);
    assert.equal((await chatCompletion(request)).content, 'Ready.');
  } finally { f.restore(); }
});

test('API secrets are omitted from exports and disconnect cannot fall back to Purdue silently', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    assert.ok(!JSON.stringify(await getExportData()).includes('secret'));
    await unlink();
    assert.equal(f.stored.customLlm, undefined);
    assert.equal(await getConnection(), null);
    await assert.rejects(chatCompletion(request), error => error.code === 'not-linked');
    assert.equal(f.calls.length, 0);
    await setProvider('purdue');
    assert.equal((await getConnection()).key, 'synthetic-purdue-secret');
    await saveCustomConnection(values);
    await clearLocalDataHere();
    assert.equal(f.stored.customLlm, undefined);
    assert.equal(f.stored.genai, undefined);
  } finally { f.restore(); }
});

test('clearing data or choosing another provider invalidates a pending custom permission prompt', async () => {
  for (const interrupt of [() => clearLocalDataHere(), () => setProvider('purdue')]) {
    const f = fixture();
    let grant;
    chrome.permissions.request = () => new Promise(resolve => { grant = resolve; });
    try {
      const saving = saveCustomConnection(values);
      const rejected = assert.rejects(saving, error => ['link-cancelled', 'data-cleared'].includes(error.code));
      // The begin action enters the serialized queue before the interruption.
      await interrupt();
      grant(true);
      await rejected;
      assert.equal(f.stored.customLlm, undefined);
    } finally { f.restore(); }
  }
});

test('a stale Purdue disconnect control cannot delete the active custom connection', async () => {
  const f = fixture();
  try {
    await saveCustomConnection(values);
    await unlink('purdue');
    assert.equal(f.stored.genai, undefined);
    assert.equal((await getConnection()).key, values.key);
    await assert.rejects(setModel('stale-purdue-model', 'purdue'), /provider changed/);
    assert.equal((await getConnection()).model, values.model);
  } finally { f.restore(); }
});
