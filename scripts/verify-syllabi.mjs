// Exercises automatic discovery and the real retry buttons in a throwaway browser.
// All Brightspace and GenAI requests are intercepted locally.
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotFixture, pdfWithPages, SYLLABUS_PAGES, MODEL_OUTPUT } from '../tests/helpers.mjs';
import { validateExtraction } from '../extension/lib/syllabus.js';
const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(pathToFileURL(process.argv[2] ?? path.join(root, '../course-companion/node_modules/playwright/index.mjs')));
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-syllabi-'));
const outDir = process.env.VERIFY_OUT ?? path.join(tmpdir(), 'boilerspace-syllabi-verification');
mkdirSync(outDir, { recursive: true });
const extension = process.env.VERIFY_EXTENSION ?? path.join(root, 'extension');
const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 860 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const check = (name, ok, detail = '') => { if (!ok) throw new Error(`${name}: ${detail}`); console.log(`PASS  ${name}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const home = '<!doctype html><html><head><script>localStorage.setItem("XSRF.Token", "xsrf-test");</script></head><body><d2l-navigation><d2l-navigation-main-header><div slot="right" class="d2l-navigation-s-header-right">Purdue</div></d2l-navigation-main-header></d2l-navigation><main>Course home</main></body></html>';
try {
  // Client navigation keeps the destination mocked; Playwright routes an HTTP redirect chain only once.
  const navigation = [];
  let mathLaunches = 0, civicsLaunches = 0, redirectLaunches = 0;
  context.on('page', (page) => {
    page.on('framenavigated', (frame) => {
      if (frame.url().includes('simplesyllabus.com')) navigation.push(frame.url());
      const url = new URL(frame.url());
      if (frame === page.mainFrame() && url.pathname.endsWith('/quickLink.d2l') && url.searchParams.get('ou') === '1600004' && mathLaunches === 1) page.close().catch(() => {});
    });
    page.on('pageerror', (error) => console.log('PAGE ERROR', error.message));
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  let civicsDownloads = 0, overviewDownloads = 0;
  let revision = 'First syllabus revision.';
  const overviewPath = '/d2l/api/le/1.96/1600001/overview/attachment';
  const ltiPath = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1600002&type=lti&rcode=resource-12707056&srcou=6824&launchFramed=1&framedName=Syllabus';
  const cs250Text = `CS 25000 syllabus. ${SYLLABUS_PAGES.map((p) => p.text).join(' ')} ${'Course policies and expectations. '.repeat(30)}`;
  await context.route('https://genai.rcac.purdue.edu/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }] }) }));
  await context.route('https://purdue.brightspace.com/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === overviewPath) { overviewDownloads++; return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(pdfWithPages([[revision], ...SYLLABUS_PAGES.map((p) => p.text.replace(/\u2013/g, '-').split('\n'))])) }); }
    if (pathname === '/d2l/api/le/1.96/1438550/overview/attachment') { civicsDownloads++; return route.fulfill({ status: 404, body: '{}' }); }
    if (pathname.endsWith('/quickLink.d2l')) {
      if (new URL(route.request().url()).searchParams.get('ou') === '1438550') {
        civicsLaunches++;
        return route.fulfill({ contentType: 'text/html', body: '<iframe src="https://purdue.simplesyllabus.com/en-US/sso-redirect"></iframe>' });
      }
      if (new URL(route.request().url()).searchParams.get('ou') === '1600004') {
        mathLaunches++;
        return route.fulfill({ contentType: 'text/html', body: '<iframe src="https://purdue.simplesyllabus.com/en-US/doc/math"></iframe>' });
      }
      if (new URL(route.request().url()).searchParams.get('ou') === '1600003') { redirectLaunches++; return route.fulfill({ contentType: 'text/html', body: '<script>location.replace("https://purdue.simplesyllabus.com/en-US/doc/cs251");</script>' }); }
      return route.fulfill({ contentType: 'text/html', body: `<html><body><nav>${'Unrelated Brightspace navigation. '.repeat(1000)}</nav><iframe src="https://purdue.simplesyllabus.com/en-US/doc/cs250"></iframe></body></html>` });
    }

    if (pathname === '/d2l/home/1600002') return route.fulfill({ contentType: 'text/html', body: home.replace('</body>', `<script>setTimeout(() => { const link = document.createElement('d2l-navigation-link'); link.setAttribute('text', 'Syllabus'); link.setAttribute('href', ${JSON.stringify(ltiPath)}); document.querySelector('d2l-navigation').append(link); }, 10000);</script></body>`) });
    if (pathname === '/d2l/home/1600004') return route.fulfill({ contentType: 'text/html', body: home.replace('</body>', `<d2l-navigation-link text="Syllabus" href="${ltiPath.replace('ou=1600002', 'ou=1600004')}"></d2l-navigation-link></body>`) });
    if (pathname === '/d2l/home/1438550') return route.fulfill({ contentType: 'text/html', body: home.replace('</body>', `<d2l-navigation-link text="Syllabus" href="${ltiPath.replace('ou=1600002', 'ou=1438550')}"></d2l-navigation-link></body>`) });
    if (pathname.startsWith('/d2l/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ contentType: 'text/html', body: home });
  });
  await context.route('https://purdue.simplesyllabus.com/**', (route) => route.fulfill({ contentType: 'text/html', body: new URL(route.request().url()).pathname === '/en-US/sso-redirect' ? '<main>Sorry, we could not locate this section in Simple Higher Ed.<p>Currently enrolled sections</p></main>' : `<!doctype html><html><body><nav>${'Simple Syllabus navigation. '.repeat(1000)}</nav><main class="content-full-page">Loading…</main><script>setTimeout(() => { document.querySelector('main').innerHTML = '<div class="component-wrapper"><div class="content-component"></div></div>'; document.querySelector('.content-component').textContent = ${JSON.stringify(cs250Text)}; }, 10000);</script></body></html>` }));
  const snapshot = snapshotFixture();
  const facts = validateExtraction(MODEL_OUTPUT, SYLLABUS_PAGES, { courseId: 1600001 });
  snapshot.data[0].content = [];
  snapshot.data[0].overview = { fileUrl: overviewPath, text: '', hasAttachment: true };
  snapshot.courses[1].code = 'wl.202710.CS.25000.LE1';
  snapshot.courses[1].name = 'Fall 2026 CS 25000';
  snapshot.courses.push({ id: 1438550, name: 'Purdue Civics Literacy', code: 'wl.nc.civics.2', current: true, homeUrl: 'https://purdue.brightspace.com/d2l/home/1438550' });
  snapshot.data.push({ courseId: 1438550, assignments: [], quizzes: [], announcements: [], events: [], content: [], grades: [], overview: { hasAttachment: true, text: 'Welcome to Civics Literacy.', fileUrl: '/d2l/api/le/1.96/1438550/overview/attachment' } });
  snapshot.courses.push({ id: 1600004, name: 'Fall 2026 MA 16200', code: 'wl.202710.MA.16200', current: true, homeUrl: 'https://purdue.brightspace.com/d2l/home/1600004' });
  snapshot.data.push({ courseId: 1600004, assignments: [], quizzes: [], announcements: [], events: [], content: [], grades: [] });
  await worker.evaluate(() => {
    const contains = chrome.permissions.contains.bind(chrome.permissions);
    chrome.permissions.contains = async (query) => query.origins?.includes('https://purdue.simplesyllabus.com/*') ? (await chrome.storage.local.get('testSimpleGranted')).testSimpleGranted === true : contains(query);
  });
  const seed = { syllabusSources: { 1600002: { topic: null, checkedAt: new Date().toISOString() } }, snapshot, syncMeta: { ok: true, at: new Date().toISOString(), lastSuccessAt: new Date().toISOString() }, genai: { key: 'sk-fake', model: 'qwen3.8:27b' }, syllabi: {
    1600001: { courseId: 1600001, status: 'done', topicId: 'overview', title: 'Course overview attachment', updatedAt: null, kind: 'pdf', pages: SYLLABUS_PAGES, ...facts },
    1600002: { courseId: 1600002, status: 'none' },
    1438550: { courseId: 1438550, status: 'error', topicId: 'overview', error: 'HTTP 404', checkedAt: new Date().toISOString() },
  } };
  await worker.evaluate((data) => chrome.storage.local.set(data), seed);
  const bs = await context.newPage();
  const errors = [];
  bs.on('pageerror', (error) => errors.push(error.message));
  await bs.goto('https://purdue.brightspace.com/d2l/home');
  await bs.locator('.boilerspace-nav-item button').click();
  let panel;
  for (let i = 0; i < 100 && !panel; i++) { panel = bs.frames().find((f) => f.url().includes('sidepanel.html')); if (!panel) await pause(100); }
  if (!panel) throw new Error('Panel did not open');
  const poll = async (test, label, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    let all;
    while (Date.now() < deadline) { all = await worker.evaluate(() => chrome.storage.local.get(null)); if (test(all)) return all; await pause(200); }
    throw new Error(`${label}: ${JSON.stringify(Object.fromEntries(Object.entries(all.syllabi ?? {}).map(([id, r]) => [id, { status: r.status, error: r.error, pages: r.pages?.length }])) )}`);
  };
  const allow = panel.getByRole('button', { name: 'Allow Simple Syllabus access', exact: true });
  await allow.waitFor();
  await allow.click();
  let accessPage;
  for (let i = 0; i < 100 && !accessPage; i++) {
    accessPage = context.pages().find((page) => page.url().includes('sidepanel.html?syllabus-access=1'));
    if (!accessPage) await pause(100);
  }
  if (!accessPage) throw new Error('The permission page did not open');
  await accessPage.waitForLoadState();
  await accessPage.evaluate(() => {
    chrome.permissions.request = async (request) => {
      window.requestedSyllabusAccess = request.origins;
      await chrome.storage.local.set({ testSimpleGranted: true });
      return true;
    };
  });
  await accessPage.getByRole('button', { name: 'Allow Simple Syllabus access', exact: true }).click();
  await accessPage.getByText('Access is allowed.', { exact: false }).waitFor();
  check('the embedded panel opens a permission page that requests only Purdue Simple Syllabus', JSON.stringify(await accessPage.evaluate(() => window.requestedSyllabusAccess)) === JSON.stringify(['https://purdue.simplesyllabus.com/*']));
  const all = await poll((all) => all.syllabi[1438550]?.status === 'none' && all.syllabi[1600002]?.status === 'done' && all.syllabi[1600004]?.status === 'done', 'Automatic course pass', 100_000);
  check('automatic pass handles missing Civics and reads a ten-second CS 250 LTI iframe despite an old missing cache without opening course details', all.syllabi[1600002].pages.some((p) => p.text.includes('CS 25000 syllabus')) && civicsDownloads === 1);
  check('the real missing-section response is saved as no syllabus rather than a loading failure', all.syllabi[1438550].status === 'none' && civicsLaunches === 1);
  check('a closed Math syllabus tab recovers in the automatic pass without clicking a retry button', mathLaunches === 2 && all.syllabi[1600004].pages.length > 0, `Math launches: ${mathLaunches}`);
  await panel.locator('.tabs button[data-view="courses"]').click();
  const allButton = panel.getByRole('button', { name: 'Check again', exact: true });
  await allButton.waitFor();
  for (let i = 0; i < 100 && !(await allButton.isEnabled()); i++) await pause(100);
  check('one batch retry control covers all current courses', await allButton.isEnabled());
  await panel.locator('.course-row').filter({ hasText: 'CS 25000' }).click();
  await panel.getByText('Choose a different syllabus', { exact: true }).click();
  check('CS 250 offers Read again after automatic discovery', await panel.getByRole('button', { name: 'Read again', exact: true }).isEnabled());
  await worker.evaluate(async () => { const { syllabi } = await chrome.storage.local.get('syllabi'); syllabi[1600002] = { courseId: 1600002, status: 'error', error: 'The course navigation did not finish loading.' }; await chrome.storage.local.set({ syllabi }); });
  const retry = panel.getByRole('button', { name: 'Check again', exact: true });
  await retry.waitFor();
  check('a discovery error without a topic exposes a retry button', await retry.isEnabled());
  await retry.click();
  await poll((all) => all.syllabi[1600002]?.status === 'done', 'Retry after discovery error');
  await panel.getByRole('button', { name: 'All courses', exact: true }).click();
  await panel.locator('.course-row').filter({ hasText: 'Civics' }).click();
  check('missing Civics is an ordinary result with optional syllabus controls', (await panel.locator('.view').textContent()).includes('No syllabus was found') && await panel.getByText('Add a syllabus', { exact: true }).isVisible());
  await panel.getByRole('button', { name: 'All courses', exact: true }).click();
  await panel.locator('.course-row').filter({ hasText: 'CS 25200' }).click();
  for (const text of ['First syllabus revision.', 'Second syllabus revision.']) {
    revision = text;
    const before = overviewDownloads;
    const picker = panel.locator('[data-disclosure="syllabus-file-1600001"]');
    if (!(await picker.evaluate(element => element.open))) await picker.locator('summary').first().click();
    await panel.getByRole('button', { name: 'Read again', exact: true }).click();
    await poll((all) => all.syllabi[1600001]?.status === 'done' && all.syllabi[1600001].pages?.[0]?.text.includes(text), 'Read again latest bytes');
    check(`Read again downloads ${text}`, overviewDownloads === before + 1);
    check('syllabus controls stay open after the background update', await picker.evaluate(element => element.open));
  }
  await bs.screenshot({ path: path.join(outDir, 'syllabus-retry.png') });
  const [redirected, shared] = await panel.evaluate((href) => Promise.all(Array.from({ length: 2 }, () => chrome.runtime.sendMessage({ type: 'boilerspace-syllabus', phase: 'page', href, origin: 'https://purdue.brightspace.com' }))), ltiPath.replace('ou=1600002', 'ou=1600003'));
  if (redirected.error) console.log('Redirect diagnostics', JSON.stringify({ navigation, error: redirected.error }));
  check('the reader also handles an LTI launch that navigates the entire tab to Simple Syllabus', redirected.text?.includes('CS 25000 syllabus') && !redirected.text.includes('Simple Syllabus navigation'), redirected.error);
  check('simultaneous readers share one browser tab and receive the same document', redirectLaunches === 1 && shared.text === redirected.text);

  const other = await context.newPage();
  await other.goto(`chrome-extension://${new URL(worker.url()).host}/document.html`);
  await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? other : panel).evaluate(async (id) => {
    const { saveSyllabusEntry } = await import('./lib/syllabus-store.js');
    await saveSyllabusEntry('syllabi', id, { courseId: id, status: 'none' });
  }, 90000 + index)));
  const concurrent = await worker.evaluate(() => chrome.storage.local.get('syllabi'));
  check('concurrent extension pages retain all twenty course writes', Array.from({ length: 20 }, (_, i) => concurrent.syllabi[90000 + i]).every(Boolean));
  await other.close();

  check('no page errors', errors.length === 0, errors.join(' | '));
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}
