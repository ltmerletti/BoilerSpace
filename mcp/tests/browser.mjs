// A signed-in synthetic Purdue page exercises the real separate-browser login.
// All network requests are intercepted; there is no personal profile or SSO.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrightspaceSession } from '../lib/session.mjs';
import { ORIGIN } from '../lib/config.mjs';

const directory = await mkdtemp(path.join(tmpdir(), 'boilerspace-browser-'));
const requests = [];
const session = new BrightspaceSession(directory);
let context;
try {
  const result = await session.login({ timeout: 15000, launch: async (profile, options) => {
    context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
    await context.route('**/*', async route => {
      const request = route.request();
      assert.ok(request.url().startsWith(ORIGIN), 'no other site is contacted');
      requests.push(new URL(request.url()).pathname);
      const pathname = new URL(request.url()).pathname;
      if (pathname === '/d2l/home') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fixture Brightspace</title><script>window.D2L={LP:{Web:{Authentication:{Xsrf:{GetXsrfToken:()=>"synthetic-xsrf"}}}}};</script><button onclick="document.cookie=\'fixture=connected; Secure; Path=/\'">Fixture sign in</button>' });
      if (!request.headers().cookie?.includes('fixture=connected')) return route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
      if (pathname === '/d2l/lp/auth/oauth2/token') {
        assert.equal(request.headers()['x-csrf-token'], 'synthetic-xsrf');
        return route.fulfill({ contentType: 'application/json', body: '{"access_token":"synthetic-bearer"}' });
      }
      if (!request.headers().authorization) return route.fulfill({ status: 403, contentType: 'application/json', body: '{}' });
      return route.fulfill({ contentType: 'application/json', body: '{"Identifier":"synthetic"}' });
    });
    const page = context.pages()[0];
    page.on('domcontentloaded', () => {
      if (page.url() === `${ORIGIN}/d2l/home`) page.getByRole('button', { name: 'Fixture sign in' }).click().catch(() => {});
    });
    return context;
  } });
  assert.equal(result.connected, true);
  assert.ok(requests.includes('/d2l/lp/auth/oauth2/token'));
  const stored = JSON.parse(await readFile(path.join(directory, 'session.json'), 'utf8'));
  assert.equal(stored.origin, ORIGIN);
  assert.equal(stored.xsrf, 'synthetic-xsrf');
  assert.ok(!JSON.stringify(stored).includes('synthetic-bearer'), 'the short-lived bearer is not persisted');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(directory, 'session.json'))).mode & 0o777, 0o600);
  await session.logout();
  await assert.rejects(readFile(path.join(directory, 'session.json')));
  console.log('PASS Separate-browser login, verified bearer exchange, private cookie persistence and logout.');
} finally { await context?.close(); await rm(directory, { recursive: true, force: true }); }
