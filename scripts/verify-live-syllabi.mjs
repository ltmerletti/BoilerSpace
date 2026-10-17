// Uses real Purdue pages and GenAI Studio in a separate, persistent test profile.
// Sign in and connect GenAI Studio in that browser when prompted. No requests are mocked.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS  ${name}`); };

async function until(read, label, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    if (Date.now() - lastLog > 20_000) { console.log(`WAIT  ${label}`); lastLog = Date.now(); }
    await pause(1000);
  }
  throw new Error(`Timed out: ${label}`);
}

export async function verifyLiveSyllabi(context, { fresh = false, outDir = '/tmp/boilerspace-live-verification' } = {}) {
  const [worker] = context.serviceWorkers();
  let extensionId = worker && new URL(worker.url()).host;
  if (!extensionId) {
    const extensions = await context.newPage();
    await extensions.goto('chrome://extensions');
    const card = extensions.locator('extensions-item').filter({ hasText: 'BoilerSpace' });
    await card.waitFor();
    extensionId = await card.getAttribute('id');
    const enabled = card.locator('#enableToggle');
    if ((await enabled.getAttribute('checked')) === null) await enabled.click();
    await extensions.close();
  }
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html?syllabus-access=1`);
  if (fresh) {
    // Clear only syllabus caches in this test profile; keep the sign-ins and course snapshot.
    await panel.evaluate(async () => {
      await chrome.storage.local.remove(['syllabi', 'syllabusSources']);
      const { ui } = await chrome.storage.local.get('ui');
      await chrome.storage.local.set({ ui: { ...ui, view: 'courses', courseId: null } });
    });
  }
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  console.log('Use Connect in the test browser if GenAI Studio is not connected yet.');
  await until(() => panel.evaluate(async () => Boolean((await chrome.storage.local.get('genai')).genai)), 'GenAI Studio connection');
  const courses = await panel.evaluate(async () => (await chrome.storage.local.get('snapshot')).snapshot.courses.filter((c) => c.current));
  assert.ok(courses.length, 'The test profile needs a signed-in course sync.');
  const read = () => panel.evaluate(async () => (await chrome.storage.local.get('syllabi')).syllabi ?? {});
  const finished = async () => {
    const records = await read();
    if (!(await panel.locator('#status').isHidden()) || !courses.every((c) => records[c.id])) return false;
    return records;
  };
  const automatic = await until(finished, 'automatic syllabus pass');
  console.log('Automatic results:', courses.map((c) => ({ id: c.id, status: automatic[c.id].status, error: automatic[c.id].error })));
  check('automatic pass finishes every current course without a failed check', courses.every((c) => ['done', 'none'].includes(automatic[c.id].status)));
  check('every read syllabus has saved text and verified facts', courses.every((c) => automatic[c.id].status !== 'done' || automatic[c.id].pages?.some((p) => p.text) && automatic[c.id].policies));

  await panel.locator('.tabs button[data-view="courses"]').click();
  await mkdir(outDir, { recursive: true });
  await panel.screenshot({ path: path.join(outDir, 'automatic-courses.png') });
  await panel.getByRole('button', { name: 'Check again', exact: true }).click();
  const manual = await until(async () => {
    const records = await finished();
    return records && courses.every((c) => records[c.id].source === 'upload' || records[c.id].checkedAt !== automatic[c.id].checkedAt) ? records : false;
  }, 'manual syllabus pass');
  console.log('Manual results:', courses.map((c) => ({ id: c.id, status: manual[c.id].status, error: manual[c.id].error })));
  check('Check all syllabi and automatic scanning produce the same course outcomes', courses.every((c) => manual[c.id].status === automatic[c.id].status));
  check('both passes read the same document text', courses.every((c) => manual[c.id].status !== 'done' || manual[c.id].hash === automatic[c.id].hash));
  await verifyReloadAndReadAgain(panel, courses, manual);

  const cs251 = courses.find((c) => /\bCS\s*25100\b/i.test(c.name));
  if (cs251) {
    await panel.locator('.tabs button[data-view="ask"]').click();
    const before = await panel.locator('.message.assistant:not(.pending)').count();
    await panel.locator('.composer textarea').fill('What does the CS 25100 syllabus say about AI use?');
    await panel.locator('.composer button[type="submit"]').click();
    await until(async () => (await panel.locator('.message.assistant:not(.pending)').count()) > before, 'CS 251 syllabus answer');
    const answer = panel.locator('.message.assistant:not(.pending)').last();
    const sources = answer.locator('[data-disclosure^="sources-"]');
    await sources.waitFor({ state: 'attached' });
    if (!(await sources.evaluate(element => element.open))) await sources.locator('summary').click();
    const citations = await answer.locator('.sources a').evaluateAll((links) => links.map((a) => a.href));
    check('the CS 251 answer cites its actual syllabus', citations.some((href) => new URL(href).searchParams.get('ou') === String(cs251.id) || href.includes(`/home/${cs251.id}`)));
    await panel.screenshot({ path: path.join(outDir, 'cs251-ai-answer.png') });
  }
  return { panel, automatic, manual };
}

export async function verifyReloadAndReadAgain(panel, courses, records) {
  const sources = await panel.evaluate(async () => (await chrome.storage.local.get('syllabusSources')).syllabusSources ?? {});
  await panel.reload();
  await panel.getByRole('button', { name: 'Check again', exact: true }).waitFor();
  await pause(1500);
  await until(() => panel.locator('#status').isHidden(), 'cached automatic pass after reload');
  const reloaded = await panel.evaluate(() => chrome.storage.local.get(['syllabi', 'syllabusSources']));
  check('reloading retains successful reads and the confirmed missing syllabus', courses.every((c) => reloaded.syllabi[c.id].status === records[c.id].status && (records[c.id].status === 'done' ? reloaded.syllabi[c.id].checkedAt === records[c.id].checkedAt : reloaded.syllabusSources?.[c.id]?.checkedAt === sources[c.id]?.checkedAt)));
  const cs250 = courses.find((c) => /\bCS\s*25000\b/i.test(c.name));
  if (cs250) {
    await panel.locator('.tabs button[data-view="courses"]').click();
    await panel.locator('.course-row').filter({ hasText: 'CS 25000' }).click();
    await panel.getByText('Wrong file?', { exact: true }).click();
    await panel.getByRole('button', { name: 'Read again', exact: true }).click();
    const reread = await until(async () => {
      const r = await panel.evaluate(async (id) => (await chrome.storage.local.get('syllabi')).syllabi[id], cs250.id);
      return r?.checkedAt !== records[cs250.id].checkedAt && await panel.locator('#status').isHidden() ? r : false;
    }, 'CS 250 Read again');
    check('the course Read again button reads the same syllabus as the automatic pass', reread.status === 'done' && reread.hash === records[cs250.id].hash);
    await panel.getByRole('button', { name: 'All courses', exact: true }).click();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const playwrightPath = path.resolve(process.env.PLAYWRIGHT_PATH ?? path.join(root, '../course-companion/node_modules/playwright/index.mjs'));
  const { chromium } = await import(pathToFileURL(playwrightPath));
  const context = await chromium.launchPersistentContext(path.join(root, '.verify-tmp/live-profile'), {
    headless: false, viewport: null,
    args: [`--disable-extensions-except=${path.join(root, 'extension')}`, `--load-extension=${path.join(root, 'extension')}`],
  });
  try {
    const home = context.pages()[0] ?? await context.newPage();
    await home.goto('https://purdue.brightspace.com/d2l/home', { waitUntil: 'domcontentloaded' });
    console.log('Sign into Brightspace in the test browser if prompted.');
    await until(() => !home.url().includes('/d2l/login') && home.url().includes('purdue.brightspace.com/d2l/'), 'Brightspace sign-in');
    await verifyLiveSyllabi(context, { fresh: process.argv.includes('--fresh') });
  } finally {
    await context.close();
  }
}
