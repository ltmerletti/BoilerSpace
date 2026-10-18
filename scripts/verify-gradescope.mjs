// Synthetic pages exercise the actual Gradescope reader without any student data.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = mkdtempSync(path.join(tmpdir(), 'boilerspace-gradescope-'));
const extension = path.join(temp, 'extension');
const out = process.env.VERIFY_OUT ?? path.join(temp, 'screenshots');
mkdirSync(out, { recursive: true });
cpSync(process.env.VERIFY_EXTENSION ?? path.join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions.push(...manifest.optional_host_permissions);
manifest.optional_host_permissions = [];
writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
  headless: true, channel: 'chromium', viewport: { width: 400, height: 880 }, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
let checks = 0, expired = false, offline = false, empty = false;
const requests = [], siteTabs = [], errors = [];
const check = (name, value) => { assert.ok(value, name); console.log(`PASS  ${name}`); checks++; };
const account = `<div class="courseList"><div class="courseList--term">Fall 2026</div><div class="courseList--coursesForTerm">
${[20, 21].map(id => `<a class="courseBox" href="/courses/${id}"><h3 class="courseBox--shortname">${id === 20 ? 'CS 25200' : 'STAT 10100'}</h3><div class="courseBox--name">${id === 20 ? 'Systems Programming' : 'Unlinked Statistics'}</div></a>`).join('')}</div></div>`;
const table = id => `<table id="assignments-student-table"><tbody>${empty ? '' : `
<tr><th><a href="/courses/${id}/assignments/51/submissions/SECRET_SUBMISSION">${id === 20 ? 'Lab 8' : 'Statistics worksheet'}</a></th><td class="submissionStatus"><div class="submissionStatus--score">SCORE_SENTINEL_64</div></td><td>
<time class="submissionTimeChart--dueDate" datetime="2026-10-19 17:30:00 -0400">Due</time><time class="submissionTimeChart--dueDate" aria-label="Late Due Date" datetime="2026-10-20 17:30:00 -0400">Late deadline</time></td></tr>
<tr><th>Checkpoint 3</th><td class="submissionStatus">SCORE_SENTINEL_64</td><td></td></tr>`}</tbody></table>`;
try {
  context.on('page', page => {
    page.on('pageerror', error => errors.push(error.message));
    page.on('framenavigated', frame => { if (frame === page.mainFrame() && frame.url().startsWith('https://www.gradescope.com')) siteTabs.push(frame.url()); });
  });
  await context.route('https://www.gradescope.com/**', route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    assert.equal(request.method(), 'GET');
    assert.ok(/^\/(account|courses\/\d+)$/.test(pathname), 'no submissions or grades endpoints');
    requests.push(pathname);
    if (offline) return route.fulfill({ status: 503, body: 'Temporary outage' });
    if (expired) return route.fulfill({ status: 401, body: '<h1>Sign in</h1>' });
    return route.fulfill({ contentType: 'text/html', body: pathname === '/account' ? account : table(Number(pathname.split('/').at(-1))) });
  });
  await context.route('https://purdue.brightspace.com/**', route => route.fulfill({ status: 404, body: '{}' }));
  await context.route('https://genai.rcac.purdue.edu/**', route => route.fulfill({ status: 404, body: '{}' }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  // Date is fixed for term selection and the visible agenda in this fixture.
  const freezeDate = () => { const RealDate = Date; globalThis.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-18T16:00:00Z'])); } static now() { return 1792339200000; } }; };
  await worker.evaluate(freezeDate);
  await context.addInitScript(freezeDate);
  await worker.evaluate(async snapshot => { await chrome.storage.local.set({ snapshot, syncMeta: { ok: true, lastSuccessAt: new Date().toISOString() }, syllabi: Object.fromEntries(snapshot.courses.filter(c => c.current).map(c => [c.id, { status: 'none', courseId: c.id, checkedAt: new Date().toISOString() }])) }); }, snapshotFixture());
  const panel = await context.newPage();
  const extensionOrigin = `${new URL(worker.url()).protocol}//${new URL(worker.url()).host}`;
  await panel.goto(`${extensionOrigin}/sidepanel.html`);
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.getByRole('button', { name: 'Connect Gradescope', exact: true }).click();
  await panel.locator('[data-platform="gradescope"]').getByText('2 courses · 4 assignments', { exact: true }).waitFor();
  check('Connect discovers current courses and imports assignment metadata', true);
  const data = await worker.evaluate(async () => (await chrome.storage.local.get('gradescope')).gradescope);
  check('Matching links the known course and keeps unknown courses separate', data.courses[0].courseId === 1600001 && data.courses[1].courseId === null);
  check('Score values and submission identifiers never enter storage', !/SCORE_SENTINEL|SECRET_SUBMISSION/.test(JSON.stringify(data)));
  check('Only course-list GET requests are made, without site tabs', requests.length === 3 && siteTabs.length === 0);
  await panel.locator('[data-platform="gradescope"] > details > summary').click();
  await panel.locator('[data-source-id="gradescope:20"] > details').first().locator('summary').click();
  await panel.locator('[data-source-id="gradescope:20"]').getByText('No due date published', { exact: true }).waitFor();
  check('The assignment list labels unknown dates without inventing a deadline', true);
  await panel.locator('[data-source-id="gradescope:20"]').getByText(/^Late deadline/).waitFor();
  check('Late and regular deadlines remain separate', true);
  await panel.getByRole('button', { name: 'Week', exact: true }).click();
  await panel.getByRole('link', { name: 'Lab 8', exact: true }).waitFor();
  await panel.getByRole('link', { name: 'Statistics worksheet', exact: true }).waitFor();
  check('Week includes dated assignments from linked and unlinked courses', true);
  await panel.getByRole('button', { name: 'Courses', exact: true }).click();
  await panel.getByRole('button', { name: /CS 25200/ }).first().click();
  await panel.getByRole('heading', { name: 'Gradescope', exact: true }).waitFor();
  check('Course details expose its connected Gradescope assignments', true);
  const tools = await panel.evaluate(async () => {
    const { createTools } = await import('./lib/agent.js');
    const { gradescope, snapshot } = await chrome.storage.local.get(['gradescope', 'snapshot']);
    const tools = createTools({ snapshot, gradescope });
    return { listing: await tools.run('list_gradescope_assignments', {}), search: await tools.run('search_course_material', { query: 'Statistics worksheet' }) };
  });
  check('Ask tools find unlinked course assignments and keep score data out', tools.listing.total === 4 && tools.search.results.some(r => r.item_key === 'gradescope:21:51') && !/SCORE_SENTINEL/.test(JSON.stringify(tools)));
  const run = (action = 'sync', extra = {}) => panel.evaluate(async ({ action, extra }) => (await import('./lib/gradescope.js')).gradescopeRequest(action, { force: true, ...extra }), { action, extra });
  offline = true;
  await run();
  const stale = await worker.evaluate(async () => (await chrome.storage.local.get('gradescope')).gradescope);
  check('Service outages preserve assignments without a reconnect warning', stale.status === 'error' && !stale.needsReconnect && stale.courses[0].assignments.length === 2);
  offline = false; expired = true;
  await run();
  for (const view of ['Week', 'Courses', 'Ask', 'Settings']) {
    await panel.getByRole('button', { name: view, exact: true }).click();
    await panel.getByRole('button', { name: 'Reconnect Gradescope connection', exact: true }).waitFor();
  }
  check('Expired sign-in shows the compact reminder on every view without opening tabs', siteTabs.length === 0);
  expired = false;
  await run('connect');
  await panel.locator('#connection-reminder').waitFor({ state: 'hidden' });
  check('A successful reconnect clears the reminder', true);
  await run('link', { sourceId: 'gradescope:21', courseId: 1600002 });
  await run();
  const linked = await worker.evaluate(async () => (await chrome.storage.local.get('gradescope')).gradescope);
  check('Manual course links survive later syncs', linked.courses[1].courseId === 1600002);
  await panel.getByRole('button', { name: 'Settings', exact: true }).click();
  await panel.setViewportSize({ width: 320, height: 880 });
  check('The connection layout fits a narrow panel', await panel.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await panel.screenshot({ path: path.join(out, 'gradescope-settings.png'), fullPage: true });
  empty = true;
  await run();
  check('A valid empty course table removes assignments deleted on the site', (await worker.evaluate(async () => (await chrome.storage.local.get('gradescope')).gradescope)).courses.every(c => c.assignments.length === 0));
  await run('disconnect');
  check('Disconnect removes the Gradescope cache', await worker.evaluate(async () => !(await chrome.storage.local.get('gradescope')).gradescope));
  check('No site tabs were created or navigated during automatic work', siteTabs.length === 0);
  check('The panel has no JavaScript errors', errors.length === 0);
  console.log(`${checks} Gradescope browser checks passed.`);
} finally {
  await context.close();
  rmSync(temp, { recursive: true, force: true });
}
