import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('a cold background registers waking listeners before loading asynchronous dependencies', () => {
  const listeners = {}, opened = [];
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  const chrome = {
    runtime: { id: 'test', getURL: file => `moz-extension://test/${file}`, onMessage: event('message') },
    action: { onClicked: event('action') },
    permissions: { onAdded: event('added'), onRemoved: event('removed') },
    tabs: { create: async tab => { opened.push(tab); return { id: 1 }; } },
  };
  runInNewContext(readFileSync(new URL('../extension/background-firefox.js', import.meta.url), 'utf8'), {
    chrome, browser: { runtime: chrome.runtime, sidebarAction: { toggle() {} } }, URL,
  });
  assert.deepEqual(Object.keys(listeners).sort(), ['action', 'added', 'message', 'removed']);
  assert.equal(listeners.message({ type: 'unknown' }, {}, () => {}), false);
  assert.deepEqual(opened, []);
});

test('Firefox keeps the native message promise pending until the shared handler responds', async () => {
  let listener, finish;
  const values = {};
  globalThis.chrome = {
    runtime: { onMessage: { addListener: fn => { listener = fn; } } },
    action: { onClicked: { addListener() {} } },
    permissions: {
      contains: () => new Promise(resolve => { finish = resolve; }),
      onAdded: { addListener() {} }, onRemoved: { addListener() {} },
    },
    storage: { local: {
      get: async key => ({ [key]: values[key] }),
      set: async data => Object.assign(values, data),
    } },
  };
  globalThis.browser = { runtime: chrome.runtime };
  try {
    await import('../extension/background-firefox.js');
    assert.equal(listener({ type: 'unrelated' }, {}), false);
    const response = listener({ type: 'boilerspace-syllabus-access' }, {});
    assert.ok(response instanceof Promise, 'Firefox tracks the asynchronous response itself');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 1));
    let settled = false;
    response.then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, false);
    finish(true);
    assert.deepEqual(await response, { ok: true, granted: true });
  } finally {
    delete globalThis.chrome;
    delete globalThis.browser;
  }
});

test('revoking Ed site access clears its session credential', async () => {
  const { onSiteAccessChanged } = await import('../extension/lib/background-handlers.js');
  let removed;
  const cleared = new Promise(resolve => { removed = resolve; });
  globalThis.chrome = {
    permissions: { contains: async () => false },
    storage: { local: { get: async () => ({ discussionAuth: { ed: 'fixture' } }), remove: async key => { assert.equal(key, 'discussionAuth'); } },
      session: { remove: async key => { assert.equal(key, 'discussionAuth'); removed(); } } },
  };
  try {
    onSiteAccessChanged({ origins: ['https://edstem.org/*'] });
    await cleared;
  } finally { delete globalThis.chrome; }
});
