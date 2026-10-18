// Browser restarts and network faults against synthetic sites only. Never uses a signed-in profile.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';

const temp = mkdtempSync(path.join(tmpdir(), 'boilerspace-recovery-'));
const extension = path.join(temp, 'extension'), profile = path.join(temp, 'profile');
const out = process.env.VERIFY_OUT ?? '.verify-tmp/discussion-recovery';
mkdirSync(out, { recursive: true });
cpSync(process.env.VERIFY_EXTENSION ?? 'extension', extension, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions.push(...manifest.optional_host_permissions);
manifest.optional_host_permissions = [];
writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const checks = [], operations = [], errors = [], readerTabs = [];
let context, panel, offline = false, expired = false, revised = false, removed = false;
let holdAt = null, held, release;
const count = { ed: 135, piazza: 65 };
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log(`PASS  ${name}`); };
const until = async (read, name, timeout = 150000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Timed out: ${name}`);
};
const read = () => panel.evaluate(async () => (await chrome.storage.local.get('discussions')).discussions);
const request = (action, args = {}) => panel.evaluate(message => chrome.runtime.sendMessage({ type: 'boilerspace-discussions', ...message }), { action, ...args });
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', reducedMotion: 'reduce', args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    readerTabs.push(page);
  });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.protocol === 'chrome-extension:' || url.protocol === 'data:' || url.protocol === 'about:') return route.continue();
    if (!['edstem.org', 'us.edstem.org', 'piazza.com'].includes(url.hostname)) return route.abort();
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/logic/api')) return route.fulfill({ contentType: 'text/html', body: url.hostname === 'edstem.org' ? '<script>localStorage.setItem("authToken:us", "synthetic-token")</script><h1>Ed fixture</h1>' : '<meta name="csrf_token" content="synthetic-csrf"><a href="/class/recovery123">MA 26500</a><h1 id="topbar_current_class_number">MA 26500</h1>' });
    if (url.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
    operations.push({ site: url.hostname, path: url.pathname, at: Date.now() });
    if (offline) return route.abort('internetdisconnected');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-token' } });
    if (expired) return route.fulfill({ status: 401, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    let body;
    if (url.hostname === 'us.edstem.org') {
      if (url.pathname === '/api/renew_token') body = { token: 'synthetic-token' };
      else if (url.pathname === '/api/user') body = { courses: [{ course: { id: 20, code: 'CS 25200', name: 'CS 25200', status: 'active' } }] };
      else if (url.pathname.endsWith('/courses/20/threads')) {
        const offset = Number(url.searchParams.get('offset'));
        body = { threads: Array.from({ length: count.ed }, (_, n) => ({ id: 2000 + n, number: n + 1, updated_at: revised && n === 0 ? 'v2' : 'v1', is_private: removed && n === 1, deleted_at: removed && n === 2 ? '2026-10-17' : null })).slice(offset, offset + 30) };
      } else if (/\/threads\/\d+$/.test(url.pathname)) {
        const id = Number(url.pathname.split('/').at(-1));
        if (id === holdAt) { held = true; await new Promise(resolve => { release = resolve; }); }
        body = { users: [], thread: { id, course_id: 20, number: id - 1999, title: `Synthetic post ${id}`, content: revised && id === 2000 ? 'The office hours have moved to Friday.' : 'Office hours are Thursday.', updated_at: revised && id === 2000 ? '2026-10-17' : '2026-10-16' } };
      } else throw new Error(`Unexpected Ed route: ${url.pathname}`);
      return route.fulfill({ contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-token' }, body: JSON.stringify(body) }).catch(() => {});
    }
    const payload = req.postDataJSON();
    if (!payload) throw new Error(`Unexpected fixture request: ${req.method()} ${url.origin}${url.pathname} (${req.resourceType()})`);
    const { method, params } = payload;
    if (method === 'user.status') body = { result: { networks: [{ id: 'recovery123', course_number: 'MA 26500' }] } };
    else if (method === 'network.get_my_feed') {
      const feed = Array.from({ length: count.piazza }, (_, n) => ({ nr: n + 1, version: 1 })).slice(params.offset, params.offset + 30);
      body = { error: null, result: { feed, more: params.offset + feed.length < count.piazza } };
    } else {
      assert.equal(method, 'content.get');
      body = { error: null, result: { nr: Number(params.cid), history: [{ subject: `Synthetic Piazza ${params.cid}`, content: '<p>Check the notebook kernel.</p>' }], children: [] } };
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  let [worker] = context.serviceWorkers(); worker ??= await context.waitForEvent('serviceworker');
  const base = new URL('document.html', worker.url()).href;
  panel = await context.newPage(); await panel.goto(base);
  return base.replace('document.html', 'sidepanel.html');
}
async function connectEd() {
  const login = await context.newPage();
  await login.goto('https://edstem.org/us/');
  const result = await request('connect', { platform: 'ed' });
  await login.close();
  return result;
}
try {
  let sidepanel = await launch();
  await panel.evaluate(snapshot => chrome.storage.local.set({ snapshot, syncMeta: { lastSuccessAt: new Date().toISOString() } }), snapshotFixture());
  const connectedEd = await connectEd();
  assert.equal(connectedEd.ok, true, connectedEd.error);
  assert.equal((await request('connect', { platform: 'piazza' })).ok, true);
  await request('sync', { force: true, sourceId: 'ed:20' });
  check('a completed batch saves thirty posts and its resume cursor', (await read()).sources[0].threads.length === 30 && (await read()).sources[0].sync.offset === 30);
  holdAt = 2030;
  const inFlight = request('sync', { sourceId: 'ed:20' }).catch(() => {});
  await until(() => held, 'second batch started', 10000);
  const closing = context.close(); release(); await closing; await inFlight;
  holdAt = null; offline = true;
  sidepanel = await launch();
  check('browser restart retains completed batches without claiming a finished import', (await read()).sources[0].threads.length === 30 && (await read()).sources[0].sync.offset === 30 && !(await read()).sources[0].historyComplete);
  await panel.goto(sidepanel);
  await until(async () => (await read()).sources.every(source => source.status === 'error'), 'offline automatic resume');
  check('offline failures retain saved posts and the exact retry cursor', (await read()).sources[0].threads.length === 30 && (await read()).sources[0].sync.offset === 30);
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  check('a network failure offers Retry instead of asking to reconnect', await panel.getByRole('button', { name: 'Retry Ed sync', exact: true }).isVisible() && await panel.getByRole('button', { name: 'Retry Piazza sync', exact: true }).isVisible());
  check('temporary network errors do not show the reconnect reminder', await panel.locator('#connection-reminder').isHidden());
  offline = false;
  check('Ed connection survives browser restart without reconnecting', await panel.evaluate(async () => !!(await chrome.storage.local.get('discussionAuth')).discussionAuth?.ed));
  const recoveryReaders = readerTabs.length;
  await panel.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await read()).sources.some(source => source.status !== 'error'), 'network recovery starts automatically', 5000);
  await until(async () => (await read()).sources.every(source => source.status === 'done'), 'automatic recovery after network returns');
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await until(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'recovery cleanup finishes');
  const resumedReaders = readerTabs.slice(recoveryReaders);
  check('a multi-batch recovery creates no tabs', resumedReaders.length === 0);
  const complete = await read();
  check('network recovery automatically finishes both histories without a manual retry', complete.sources.find(source => source.platform === 'ed').threads.length === count.ed && complete.sources.find(source => source.platform === 'piazza').threads.length === count.piazza && complete.sources.every(source => source.historyComplete && !source.sync));
  const piazzaAttempt = complete.sources.find(source => source.platform === 'piazza').lastAttemptAt;
  const piazzaRequests = operations.filter(op => op.site === 'piazza.com').length;
  await panel.evaluate(async () => {
    const { discussions } = await chrome.storage.local.get('discussions');
    const source = discussions.sources.find(source => source.platform === 'ed');
    source.status = 'error'; source.error = 'Synthetic offline interruption';
    await chrome.storage.local.set({ discussions });
  });
  await panel.waitForTimeout(100);
  await panel.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await read()).sources.every(source => source.status === 'done'), 'targeted online recovery');
  await until(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'targeted recovery finishes');
  check('network recovery retries the affected source without rereading a completed Piazza history', (await read()).sources.find(source => source.platform === 'piazza').lastAttemptAt === piazzaAttempt && operations.filter(op => op.site === 'piazza.com').length === piazzaRequests);
  const detailReads = () => operations.filter(op => /\/threads\//.test(op.path)).length;
  const before = detailReads();
  revised = true; removed = true;
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await until(async () => (await read()).sources[0].threads.length === count.ed - 2, 'edited and removed posts');
  check('a later sweep updates old text and removes deleted or newly private posts', (await read()).sources[0].threads.find(thread => thread.id === '2000').text.includes('Friday') && !(await read()).sources[0].threads.some(thread => ['2001', '2002'].includes(thread.id)) && detailReads() === before + 1);
  await until(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'completed sweep');
  const beforeExpired = readerTabs.length;
  expired = true;
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await until(async () => (await read()).sources.every(source => source.status === 'error'), 'expired sessions');
  check('expired sessions preserve both saved histories with an actionable sign-in error', (await read()).sources.every(source => /Sign in/i.test(source.error) && source.threads.length > 0));
  check('an unrecoverable sign-in failure offers Reconnect', await panel.getByRole('button', { name: 'Reconnect Ed', exact: true }).isVisible() && await panel.getByRole('button', { name: 'Reconnect Piazza', exact: true }).isVisible());
  check('unrecoverable authentication shows a compact reminder near the sync controls', await panel.locator('#connection-reminder').isVisible() && (await panel.locator('#connection-reminder').innerText()).includes('Ed and Piazza'));
  for (const view of ['Week', 'Courses', 'Ask', 'Settings']) {
    await panel.getByRole('button', { name: view, exact: true }).click();
    check(`the reconnect reminder stays visible on ${view}`, await panel.locator('#connection-reminder').isVisible());
  }
  for (const width of [320, 400]) {
    await panel.setViewportSize({ width, height: 900 });
    check(`the reminder fits a ${width}px panel`, await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await panel.locator('.top').screenshot({ path: path.join(out, 'connection-reminder.png') });
  await panel.emulateMedia({ colorScheme: 'dark' });
  await panel.locator('.top').screenshot({ path: path.join(out, 'connection-reminder-dark.png') });
  await panel.emulateMedia({ colorScheme: 'light' });
  check('expired authentication never opens a tab', readerTabs.length === beforeExpired);
  expired = false;
  await panel.getByRole('button', { name: 'Reconnect Ed connection', exact: true }).click();
  await until(async () => (await read()).sources.every(source => source.status === 'done'), 'session recovery');
  check('the reminder reconnects directly and clears automatically after recovery', await panel.locator('#connection-reminder').isHidden());
  check('routine sync leaves no discussion tabs open', !context.pages().some(page => /^https:\/\/(edstem.org|piazza.com)/.test(page.url())));
  check('no browser page errors', errors.length === 0);
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ at: new Date().toISOString(), checks, operations: operations.length }, null, 2));
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, checks, state: await read().catch(() => null) }, null, 2));
  throw error;
} finally { release?.(); await context?.close(); rmSync(temp, { recursive: true, force: true }); }
