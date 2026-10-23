import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { BrightspaceSession } from '../lib/session.mjs';
import { ORIGIN, allowedPath, atomicJson } from '../lib/config.mjs';
import { publicError } from '../lib/errors.mjs';

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-session-'));
  const jar = new CookieJar();
  await jar.setCookie('session=fixture-secret; Secure; HttpOnly; Path=/', ORIGIN);
  const file = path.join(directory, 'session.json');
  const stored = { origin: ORIGIN, cookies: await jar.serialize(), xsrf: 'fixture-xsrf', generation: 'first' };
  await atomicJson(file, stored);
  return { directory, file, stored, session: new BrightspaceSession(directory, options), close: () => rm(directory, { recursive: true, force: true }) };
}

test('the transport pins credentials to read-only Purdue endpoints and refuses redirects', async () => {
  let calls = 0;
  const f = await fixture({ fetchImpl: async (url, options) => {
    calls++;
    assert.ok(url.startsWith(ORIGIN));
    assert.equal(options.headers.Cookie, 'session=fixture-secret');
    assert.equal(options.redirect, 'manual');
    return new Response('', { status: 302, headers: { location: 'https://example.invalid/' } });
  } });
  try {
    const client = await f.session.client();
    for (const route of ['https://example.invalid/d2l/api/versions/', `${ORIGIN}/d2l/api/le/1.96/101/grades/values/myGradeValues/`, `${ORIGIN}/d2l/api/le/1.96/101/dropbox/folders/1/submissions/`, '//example.invalid/content/notes']) assert.throws(() => allowedPath(route), { code: 'blocked-request' });
    await assert.rejects(client.getJson('/d2l/api/versions/'), { code: 'sign-in-required' });
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(publicError(new Error('Cookie: fixture-secret'))).includes('fixture-secret'));
  } finally { await f.close(); }
});

test('HTML sign-in responses, revoked sessions and expired API credentials return actionable errors', async () => {
  const f = await fixture({ fetchImpl: async () => new Response('<html>Sign in</html>', { headers: { 'content-type': 'text/html' } }) });
  try {
    const client = await f.session.client();
    await assert.rejects(client.getJson('/d2l/api/versions/'), { code: 'sign-in-required' });
    await f.session.logout();
    await assert.rejects(client.getJson('/d2l/api/versions/'), { code: 'sign-in-required' });
  } finally { await f.close(); }
});

test('response limits are enforced while reading chunked downloads, not just after buffering', async () => {
  let cancelled = false;
  const f = await fixture({ responseByteLimit: 10, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; },
  })) });
  try {
    const client = await f.session.client();
    await assert.rejects(client.getFile('/d2l/api/le/1.96/101/content/topics/7/file'), { code: 'file-too-large' });
    assert.equal(cancelled, true);
  } finally { await f.close(); }
});

test('download bounds use the shared Office/PDF limits after inspecting the streamed signature', async () => {
  const f = await fixture({ fetchImpl: async url => new Response(new Uint8Array(url.includes('topics/7/') ? [0x50, 0x4b] : [0x25, 0x50]), {
    headers: { 'content-length': '150000000', 'content-type': 'application/octet-stream' },
  }) });
  try {
    const client = await f.session.client();
    assert.equal((await client.getFile('/d2l/api/le/1.96/101/content/topics/7/file')).bytes.length, 2);
    await assert.rejects(client.getFile('/d2l/api/le/1.96/101/content/topics/8/file'), { code: 'file-too-large' });
  } finally { await f.close(); }
});

test('new CLI login is detected without restarting MCP, and an old process cannot overwrite its credentials', async () => {
  const f = await fixture({ fetchImpl: async () => Response.json({ ok: true }) });
  try {
    const old = await f.session.client();
    await atomicJson(f.file, { ...f.stored, generation: 'new-login' });
    await f.session.save();
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).generation, 'new-login');
    await assert.rejects(old.getJson('/d2l/api/versions/'), { code: 'sign-in-changed' });
    const current = await f.session.client();
    assert.deepEqual(await current.getJson('/d2l/api/versions/'), { ok: true });
    if (process.platform !== 'win32') assert.equal((await stat(f.file)).mode & 0o777, 0o600);
  } finally { await f.close(); }
});

test('concurrent credential writers cannot restore an older login or recreate credentials after logout', async () => {
  const f = await fixture();
  try {
    await f.session.load();
    const replacement = new BrightspaceSession(f.directory);
    await replacement.load(); replacement.generation = 'replacement';
    await Promise.all([replacement.save({ login: true }), f.session.save()]);
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).generation, 'replacement');
    await Promise.all([replacement.logout(), f.session.save()]);
    await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('bearer minting is the only allowed POST and never leaks the credential in tool results', async () => {
  let minted = false;
  const f = await fixture({ fetchImpl: async (url, options) => {
    if (options.method === 'POST') {
      assert.equal(url, `${ORIGIN}/d2l/lp/auth/oauth2/token`);
      assert.equal(options.headers['X-Csrf-Token'], 'fixture-xsrf');
      minted = true;
      return Response.json({ access_token: 'fixture-bearer' });
    }
    if (!minted) return new Response('', { status: 403 });
    assert.equal(options.headers.Authorization, 'Bearer fixture-bearer');
    return Response.json({ ok: true });
  } });
  try {
    assert.deepEqual(await (await f.session.client()).getJson('/d2l/api/versions/'), { ok: true });
    assert.equal(minted, true);
  } finally { await f.close(); }
});

test('optional HTML error pages retain HTTP status and expired bearer credentials get one renewal', async () => {
  let attempts = 0;
  const f = await fixture({ fetchImpl: async (url, options) => {
    if (url.endsWith('/overview')) return new Response('<title>Not found</title>', { status: 404, headers: { 'content-type': 'text/html' } });
    if (options.method === 'POST') return Response.json({ access_token: 'renewed' });
    if (++attempts === 1) return new Response('', { status: 401 });
    return Response.json({ ok: true });
  } });
  try {
    const client = await f.session.client();
    await assert.rejects(client.getJson('/d2l/api/le/1.96/101/overview'), { status: 404 });
    assert.deepEqual(await client.getJson('/d2l/api/versions/'), { ok: true });
    assert.equal(attempts, 2);
  } finally { await f.close(); }
});
