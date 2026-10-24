// A signed-in synthetic Purdue page exercises the real separate-browser login.
// All network requests are intercepted; there is no personal profile or SSO.
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { BrightspaceSession } from '../lib/session.mjs';
import { ORIGIN } from '../lib/config.mjs';
import { ProviderSession, SITES } from '../lib/providers.mjs';

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

for (const site of Object.keys(SITES)) {
  const directory = await mkdtemp(path.join(tmpdir(), `boilerspace-${site}-browser-`));
  const session = new ProviderSession(directory, site);
  const account = '<script>window.gon={page_context:{user_trn:"synthetic-user"}};</script><div class="courseList"></div>';
  let context;
  try {
    const result = await session.login({ timeout: 10000,
      verificationRequest: { get: async () => ({ ok: () => true, json: async () => ({ user: { id: 'synthetic-user' } }), text: async () => account }),
        post: async () => ({ json: async () => ({ result: { id: 'synthetic-user', networks: [] } }) }) },
      launch: async (profile, options) => {
        context = await chromium.launchPersistentContext(profile, { ...options, headless: true });
        await context.route('**/*', route => {
          assert.ok(SITES[site].cookies.includes(new URL(route.request().url()).origin), 'no real SSO site is contacted');
          return route.fulfill({ contentType: 'text/html', body: site === 'gradescope' ? account : `<meta name="csrf_token" content="synthetic-csrf"><script>localStorage.setItem('authToken:us','synthetic-ed-token');</script>` });
        });
        return context;
      },
    });
    assert.equal(result.connected, true);
    const stored = JSON.parse(await readFile(path.join(session.directory, 'session.json'), 'utf8'));
    assert.equal(stored.origin, SITES[site].origin);
    assert.equal(stored.accountKey.length, 64);
    if (site === 'ed') assert.equal(stored.token, 'synthetic-ed-token');
    await session.logout();
    await assert.rejects(readFile(path.join(session.directory, 'session.json')));
    console.log(`PASS Independent ${site} browser sign-in, account binding and logout.`);
  } finally { await context?.close(); await rm(directory, { recursive: true, force: true }); }
}

// Exercise the real cross-origin portal renderer, including its route guard.
{
  const { syllabusBrowser } = await import('../lib/syllabus-browser.mjs');
  const { CookieJar } = await import('tough-cookie');
  const calls = [], contexts = [], jar = new CookieJar();
  await jar.setCookie('fixture=connected; Secure; Path=/', ORIGIN);
  const launchHref = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=101&type=lti&framedName=Syllabus';
  let saves = 0;
  const renderer = syllabusBrowser({ load: async () => {}, jar, save: async () => { saves++; } }, { launch: async (profile, options) => {
    assert.equal(profile, '', 'renderer never takes the sign-in profile lock');
    assert.equal(options.headless, true);
    assert.equal(options.serviceWorkers, 'block');
    const context = await chromium.launchPersistentContext(profile, options); contexts.push(context);
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url()); calls.push(url);
      assert.ok(!request.headers()['user-agent'].includes('HeadlessChrome/'));
      if (url.pathname === '/d2l/home/101') return route.fulfill({ contentType: 'text/html', body: `<nav><a href="${launchHref}">Syllabus</a></nav>` });
      if (url.pathname === '/d2l/api/oslo/batch') {
        assert.deepEqual(request.postDataJSON(), { resources: ['@d2l\\lti-components\\lti-components'] });
        return route.fulfill({ contentType: 'application/json', body: '{}' });
      }
      if (url.origin === ORIGIN) return route.fulfill({ contentType: 'text/html', body: '<iframe src="https://purdue.simplesyllabus.com/en-US/doc/fixture"></iframe><script>fetch("/d2l/api/oslo/batch",{method:"POST",body:JSON.stringify({resources:["@d2l\\\\lti-components\\\\lti-components"]})});fetch("/d2l/api/oslo/batch",{method:"POST",body:JSON.stringify({resources:["arbitrary-operation"]})}).catch(()=>{});fetch("/d2l/api/le/1.96/101/grades/values/myGradeValues/").catch(()=>{});fetch("https://untrusted.invalid/private").catch(()=>{});</script>' });
      assert.equal(url.origin, 'https://purdue.simplesyllabus.com');
      assert.ok(!request.headers().cookie?.includes('fixture=connected'), 'Purdue cookie is never forwarded to the portal');
      return route.fulfill({ contentType: 'text/html', body: `<main class="content-full-page"><div class="content-component">${'Synthetic syllabus evidence. '.repeat(40)}</div></main>` });
    });
    return context;
  } });
  try {
    assert.deepEqual(await renderer.links(101), [launchHref]);
    assert.match(await renderer.page(launchHref), /Synthetic syllabus evidence/);
    assert.equal(saves, 2);
    assert.ok(!calls.some(url => /grades|untrusted/.test(url.href)), 'forbidden requests are blocked before reaching transport');
    await assert.rejects(renderer.page('https://untrusted.invalid/'), { code: 'blocked-request' });
    assert.ok(contexts.every(context => context.pages().length === 0), 'renderers close after reading');
    console.log('PASS Isolated cross-origin syllabus rendering, desktop headers, route guards and cleanup.');
  } finally { for (const context of contexts) await context.close(); }
}
