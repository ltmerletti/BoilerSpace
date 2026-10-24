import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CookieJar } from 'tough-cookie';
import { ProviderSession, providerRequest } from '../lib/providers.mjs';

test('provider transports reject writes, score routes, foreign origins and disguised Piazza methods', () => {
  for (const [site, url, options] of [
    ['ed', 'https://us.edstem.org/api/threads/4', { method: 'POST', body: '{}' }],
    ['ed', 'https://other.invalid/api/user', {}],
    ['gradescope', 'https://www.gradescope.com/courses/4/assignments/5/submissions', {}],
    ['gradescope', 'https://www.gradescope.com/courses/4/grades', {}],
    ['piazza', 'https://piazza.com/logic/api?method=content.get', { method: 'POST', body: JSON.stringify({ method: 'content.update', params: {} }) }],
    ['piazza', 'https://piazza.com/logic/api?method=content.get', { method: 'POST', body: JSON.stringify({ method: 'content.get', params: { nid: 'x', cid: '4', content: 'write' } }) }],
  ]) assert.throws(() => providerRequest(site, url, options), { code: 'blocked-request' });
  assert.ok(providerRequest('gradescope', 'https://www.gradescope.com/courses/4'));
});

test('Piazza follows only whitelisted same-origin homepage redirects and never sends cookies elsewhere', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-provider-'));
  const calls = [];
  const session = new ProviderSession(directory, 'piazza', { fetchImpl: async (url, options) => {
    calls.push(url); assert.equal(options.headers.Cookie, 'session=synthetic');
    return url === 'https://piazza.com/' ? new Response(null, { status: 302, headers: { location: '/class' } }) : new Response('<meta name="csrf_token" content="synthetic">');
  } });
  try {
    await (await import('../lib/config.mjs')).privateDirectory(session.directory);
    session.jar = new CookieJar(); await session.jar.setCookie('session=synthetic; Secure; Path=/', 'https://piazza.com'); session.generation = 'fixture';
    await session.save({ login: true });
    assert.equal((await session.fetch('https://piazza.com/')).status, 200);
    assert.deepEqual(calls, ['https://piazza.com/', 'https://piazza.com/class']);
    session.fetchImpl = async () => new Response(null, { status: 302, headers: { location: 'https://other.invalid/' } });
    await assert.rejects(session.fetch('https://piazza.com/'), { code: 'sign-in-required' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('an expired Ed token renews without forwarding browser cookies and persists the replacement', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-ed-renew-'));
  const session = new ProviderSession(directory, 'ed', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://us.edstem.org/api/renew_token'); assert.equal(options.method, 'POST');
    assert.equal(options.headers['x-token'], 'expired-token'); assert.equal(options.headers.Cookie, undefined);
    return Response.json({ token: 'renewed-token' });
  } });
  try {
    await (await import('../lib/config.mjs')).privateDirectory(session.directory);
    session.jar = new CookieJar(); session.generation = 'fixture'; session.token = 'expired-token';
    await session.save({ login: true });
    assert.equal(await session.edToken(true), 'renewed-token');
    const reopened = new ProviderSession(directory, 'ed'); await reopened.load();
    assert.equal(reopened.token, 'renewed-token');
    await session.logout();
    await assert.rejects(reopened.load(), error => error.code === 'sign-in-required' && error.message.includes('--site ed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
