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
const extension = path.join(root, 'extension');
const context = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 860 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const check = (name, ok, detail = '') => { if (!ok) throw new Error(`${name}: ${detail}`); console.log(`PASS  ${name}`); };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const home = '<!doctype html><html><head><script>localStorage.setItem("XSRF.Token", "xsrf-test");</script></head><body><d2l-navigation><d2l-navigation-main-header><div slot="right" class="d2l-navigation-s-header-right">Purdue</div></d2l-navigation-main-header></d2l-navigation><main>Course home</main></body></html>';
try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  let civicsDownloads = 0, overviewDownloads = 0;
  let revision = 'First syllabus revision.';
  const overviewPath = '/d2l/api/le/1.96/1600001/overview/attachment';
  const cs250Text = `CS 25000 syllabus. ${SYLLABUS_PAGES.map((p) => p.text).join(' ')} ${'Course policies and expectations. '.repeat(30)}`;
  await context.route('https://genai.rcac.purdue.edu/**', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }] }) }));
  await context.route('https://purdue.brightspace.com/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === overviewPath) { overviewDownloads++; return route.fulfill({ contentType: 'application/pdf', body: Buffer.from(pdfWithPages([[revision], ...SYLLABUS_PAGES.map((p) => p.text.replace(/\u2013/g, '-').split('\n'))])) }); }
    if (pathname === '/d2l/api/le/1.96/1438550/overview/attachment') { civicsDownloads++; return route.fulfill({ status: 404, body: '{}' }); }
    if (pathname === '/content/enforced/1600002-CS250/syllabus.html') return route.fulfill({ contentType: 'text/html', body: `<html><body>${cs250Text}</body></html>` });
    if (pathname === '/d2l/home/1600002') return route.fulfill({ contentType: 'text/html', body: home.replace('</body>', `<script>setTimeout(() => { const link = document.createElement('d2l-navigation-link'); link.setAttribute('text', 'Syllabus'); link.setAttribute('href', '/content/enforced/1600002-CS250/syllabus.html'); document.querySelector('d2l-navigation').append(link); }, 10000);</script></body>`) });
    if (pathname.startsWith('/d2l/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ contentType: 'text/html', body: home });
  });
  const snapshot = snapshotFixture();
  const facts = validateExtraction(MODEL_OUTPUT, SYLLABUS_PAGES, { courseId: 1600001 });
  snapshot.data[0].content = [];
  snapshot.data[0].overview = { fileUrl: overviewPath, text: '', hasAttachment: true };
  snapshot.courses[1].code = 'wl.202710.CS.25000.LE1';
  snapshot.courses[1].name = 'Fall 2026 CS 25000';
  snapshot.courses.push({ id: 1438550, name: 'Purdue Civics Literacy', code: 'wl.nc.civics.2', current: true, homeUrl: 'https://purdue.brightspace.com/d2l/home/1438550' });
  snapshot.data.push({ courseId: 1438550, assignments: [], quizzes: [], announcements: [], events: [], content: [], grades: [], overview: { hasAttachment: true, text: 'Welcome to Civics Literacy.', fileUrl: '/d2l/api/le/1.96/1438550/overview/attachment' } });
  const seed = { snapshot, syncMeta: { ok: true, at: new Date().toISOString(), lastSuccessAt: new Date().toISOString() }, genai: { key: 'sk-fake', model: 'qwen3.8:27b' }, syllabi: {
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
  const all = await poll((all) => all.syllabi[1438550]?.status === 'none' && all.syllabi[1600002]?.status === 'done', 'Automatic course pass');
  check('automatic pass handles missing Civics and finds a ten-second CS 250 navbar without opening course details', all.syllabi[1600002].pages.some((p) => p.text.includes('CS 25000 syllabus')) && civicsDownloads === 1);
  await panel.locator('.tabs button[data-view="courses"]').click();
  const allButton = panel.getByRole('button', { name: 'Check all syllabi', exact: true });
  await allButton.waitFor();
  for (let i = 0; i < 100 && !(await allButton.isEnabled()); i++) await pause(100);
  check('one batch retry control covers all current courses', await allButton.isEnabled());
  await panel.locator('.course-row').filter({ hasText: 'CS 25000' }).click();
  await panel.getByText('Wrong file?', { exact: true }).click();
  check('CS 250 offers Read again after automatic discovery', await panel.getByRole('button', { name: 'Read again', exact: true }).isEnabled());
  await worker.evaluate(async () => { const { syllabi } = await chrome.storage.local.get('syllabi'); syllabi[1600002] = { courseId: 1600002, status: 'error', error: 'The course navigation did not finish loading.' }; await chrome.storage.local.set({ syllabi }); });
  const retry = panel.getByRole('button', { name: 'Check again', exact: true });
  await retry.waitFor();
  check('a discovery error without a topic exposes a retry button', await retry.isEnabled());
  await retry.click();
  await poll((all) => all.syllabi[1600002]?.status === 'done', 'Retry after discovery error');
  await panel.getByRole('button', { name: 'All courses', exact: true }).click();
  await panel.locator('.course-row').filter({ hasText: 'Civics' }).click();
  check('missing Civics is an ordinary result with Check again', (await panel.locator('.view').textContent()).includes('No syllabus was found') && await panel.getByRole('button', { name: 'Check again', exact: true }).isEnabled());
  await panel.getByRole('button', { name: 'All courses', exact: true }).click();
  await panel.locator('.course-row').filter({ hasText: 'CS 25200' }).click();
  for (const text of ['First syllabus revision.', 'Second syllabus revision.']) {
    revision = text;
    const before = overviewDownloads;
    await panel.getByText('Wrong file?', { exact: true }).click();
    await panel.getByRole('button', { name: 'Read again', exact: true }).click();
    await poll((all) => all.syllabi[1600001]?.status === 'done' && all.syllabi[1600001].pages?.[0]?.text.includes(text), 'Read again latest bytes');
    check(`Read again downloads ${text}`, overviewDownloads === before + 1);
  }
  await bs.screenshot({ path: path.join(outDir, 'syllabus-retry.png') });
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
