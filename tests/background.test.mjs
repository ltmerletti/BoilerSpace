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
    runtime: { id: 'test', getURL: file => `moz-extension://test/${file}`, onMessage: { addListener: fn => { listener = fn; } } },
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
    const response = listener({ type: 'boilerspace-syllabus-access' }, { id: 'test', url: 'moz-extension://test/sidepanel.html' });
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

test('background data writes and privileged readers reject untrusted senders', async () => {
  const { handleMessage } = await import('../extension/lib/background-handlers.js');
  let tabs = 0, writes = 0;
  globalThis.chrome = {
    runtime: { id: 'test', getURL: file => `moz-extension://test/${file}` },
    tabs: { create: async () => { tabs++; throw new Error('Unexpected tab'); } },
    storage: { local: { set: async () => { writes++; } } },
  };
  try {
    for (const sender of [{}, { id: 'other', url: 'moz-extension://test/sidepanel.html' }, { id: 'test', url: 'https://untrusted.example/', tab: { id: 2 } }, { id: 'test', url: 'https://purdue.brightspace.com/d2l/home', tab: { id: 3 } }]) {
      for (const type of ['boilerspace-data', 'boilerspace-save-syllabus', 'boilerspace-open-syllabus-access', 'boilerspace-discussions', 'boilerspace-gradescope']) {
        assert.equal(handleMessage({ type, action: 'connect' }, sender, () => {}), false);
      }
    }
    assert.equal(tabs, 0);
    assert.equal(writes, 0);
    const sender = { id: 'test', url: 'moz-extension://test/sidepanel.html' };
    const request = message => new Promise(resolve => assert.equal(handleMessage({ type: 'boilerspace-syllabus', ...message }, sender, resolve), true));
    assert.match((await request({ origin: 'https://untrusted.example', phase: 'links', courseId: 1 })).error, /Unexpected syllabus site/);
    assert.match((await request({ phase: 'links', courseId: '../account' })).error, /Invalid syllabus course/);
    assert.match((await request({ phase: 'page', href: 'https://untrusted.example/d2l/home' })).error, /Unexpected syllabus page/);
    assert.match((await request({ phase: 'page', href: '/not-a-course' })).error, /Unexpected syllabus page/);
    assert.equal(tabs, 0);
  } finally { delete globalThis.chrome; }
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
