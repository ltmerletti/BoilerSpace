// Disposable extension UI checks with synthetic credentials, files, and responses.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const extension = path.resolve(process.env.VERIFY_EXTENSION ?? path.join(root, 'extension'));
const out = path.resolve(process.env.VERIFY_OUT ?? path.join(root, '.verify-tmp/fixes-data-lifecycle'));
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-lifecycle-'));
mkdirSync(out, { recursive: true });
const checks = [], errors = [], blockedRequests = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS  ${name}`); };
const emptySnapshot = { courses: [], data: [], fetchedAt: new Date().toISOString(), versions: { lp: '1.62', le: '1.96' } };
const connection = { key: 'synthetic-lifecycle-key', model: 'qwen3.8:27b', models: ['qwen3.8:27b', 'another-model'], name: 'Synthetic fixture', linkedAt: '2026-10-01T00:00:00Z' };
let context, worker, page, origin;

async function seed(extra = {}) {
  await page?.close();
  page = null;
  await worker.evaluate(async data => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(data);
  }, { snapshot: emptySnapshot, genai: connection, syncMeta: { ok: true, lastSuccessAt: new Date().toISOString() }, ui: { view: 'settings' }, ...extra });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    window.syntheticRequests = [];
    window.fetch = async (input, options) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://genai.rcac.purdue.edu/api/models') {
        window.syntheticRequests.push('models');
        return new Promise(resolve => {
          window.releaseSyntheticModels = () => {
            window.syntheticModelsReleased = true;
            resolve(Response.json({ data: [{ id: 'qwen3.8:27b' }, { id: 'another-model' }] }));
          };
        });
      }
      if (/^https?:/.test(url)) {
        window.syntheticRequests.push(`unexpected:${url}`);
        throw new Error(`External request blocked: ${url}`);
      }
      return originalFetch(input, options);
    };
  });
  await page.goto(`${origin}/sidepanel.html`);
  await page.waitForFunction(() => typeof window.releaseSyntheticModels === 'function');
}

const storage = () => worker.evaluate(() => chrome.storage.local.get(null));
async function releaseModels() {
  await page.evaluate(() => window.releaseSyntheticModels());
  // Drain the page-to-background request queue after the fetch continuation.
  await page.evaluate(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
    await chrome.runtime.sendMessage({ type: 'boilerspace-data', action: 'genai-read' });
  });
}

async function clearThroughUi() {
  const advanced = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Advanced$/ }) }).first();
  if (!(await advanced.evaluate(element => element.open))) await advanced.locator(':scope > summary').click();
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Clear local data', exact: true }).click();
  await page.waitForFunction(async () => {
    const all = await chrome.storage.local.get(null);
    return typeof all._dataEpoch === 'string' && !all.snapshot && !all.genai;
  });
  await page.getByRole('button', { name: 'Connect Purdue GenAI Studio', exact: true }).waitFor();
}

try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true, channel: 'chromium', viewport: { width: 520, height: 900 }, reducedMotion: 'reduce',
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  await context.route(/^https?:\/\//, route => {
    if (route.request().url() === 'https://purdue.brightspace.com/synthetic-lifecycle-auth') {
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic sender fixture</title><p>Local fixture</p>' });
    }
    blockedRequests.push(route.request().url());
    return route.abort();
  });
  worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  origin = `chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(() => {
    globalThis.fetch = async input => { throw new Error(`External background request blocked: ${String(input)}`); };
  });

  await seed();
  await page.locator('[data-platform="genai"] > details > summary').click();
  await page.locator('select[data-focus-key="model"]').selectOption('another-model');
  await page.waitForFunction(async () => (await chrome.storage.local.get('genai')).genai?.model === 'another-model');
  await releaseModels();
  let saved = await storage();
  check('a delayed UI model refresh preserves a newer model choice', saved.genai.model === 'another-model' && saved.genai.modelChosen === true);
  check('the model refresh still updates its model list through background messaging', JSON.stringify(saved.genai.models) === JSON.stringify(['another-model', 'qwen3.8:27b']));
  await page.screenshot({ path: path.join(out, 'model-selection.png'), fullPage: true });

  const untrustedPage = await context.newPage();
  await untrustedPage.goto('https://purdue.brightspace.com/synthetic-lifecycle-auth');
  const untrusted = await worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://purdue.brightspace.com/synthetic-lifecycle-auth' });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: async () => {
      try {
        const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-data', action: 'genai-unlink' });
        return { accepted: reply?.ok === true };
      } catch { return { accepted: false }; }
    } });
    return result.result;
  });
  check('the actual background rejects a Brightspace content script attempting a protected data mutation', !untrusted.accepted && (await storage()).genai?.key === connection.key);
  await untrustedPage.close();

  await seed();
  await page.locator('[data-platform="genai"] > details > summary').click();
  await page.getByRole('button', { name: 'Disconnect GenAI Studio', exact: true }).click();
  await page.waitForFunction(async () => !(await chrome.storage.local.get('genai')).genai);
  await releaseModels();
  check('a delayed UI model refresh cannot restore a disconnected key', !(await storage()).genai);
  await page.getByRole('button', { name: 'Connect Purdue GenAI Studio', exact: true }).waitFor();

  await seed();
  await clearThroughUi();
  await releaseModels();
  saved = await storage();
  check('clear through Settings invalidates a delayed model refresh', !saved.genai && !saved.snapshot && typeof saved._dataEpoch === 'string');
  check('the cleared model connection stays disconnected in the UI', await page.getByRole('button', { name: 'Connect Purdue GenAI Studio', exact: true }).isVisible());
  await page.screenshot({ path: path.join(out, 'cleared-model-refresh.png'), fullPage: true });

  const snapshot = {
    ...emptySnapshot,
    courses: [{ id: 1, name: 'Synthetic Course', code: 'SYN 10100', current: true }],
    data: [{ courseId: 1, content: [{ id: 4, title: 'Syllabus.pdf', modulePath: [], fileUrl: '/synthetic-syllabus.pdf', updatedAt: 'old' }], assignments: [], quizzes: [], announcements: [], events: [] }],
  };
  await seed({ snapshot, syllabi: { 1: { courseId: 1, topicId: 4, updatedAt: 'old', status: 'done', pages: [{ text: 'Synthetic previous syllabus text must stay deleted.' }], deadlines: [], policies: {} } } });
  await page.evaluate(async () => {
    const { processCourse } = await import('./lib/syllabus.js');
    const { snapshot } = await chrome.storage.local.get('snapshot');
    window.syntheticSyllabusResult = null;
    window.syntheticSyllabusWork = processCourse(snapshot, 1, {
      force: true,
      download: async () => new Promise((resolve, reject) => {
        window.releaseSyntheticDownload = () => reject(new Error('Synthetic download failure'));
      }),
    }).then(record => { window.syntheticSyllabusResult = { status: record?.status }; }, error => { window.syntheticSyllabusResult = { code: error.code, message: error.message }; });
  });
  await page.waitForFunction(() => typeof window.releaseSyntheticDownload === 'function');
  await clearThroughUi();
  await page.evaluate(async () => { window.releaseSyntheticDownload(); await window.syntheticSyllabusWork; });
  await releaseModels();
  const result = await page.evaluate(() => window.syntheticSyllabusResult);
  saved = await storage();
  check('a held syllabus download reports clear cancellation through the real background writer', result.code === 'data-cleared');
  check('late syllabus failure cannot restore previous pages or syllabus records', !saved.syllabi && !JSON.stringify(saved).includes('Synthetic previous syllabus text'));
  check('cleared course and connection data remain absent after both held operations finish', !saved.snapshot && !saved.genai && !saved.syllabusSources);
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  check('reopening Settings confirms course data and saved credentials stayed cleared', !(await storage()).snapshot && !(await storage()).genai && await page.getByRole('button', { name: 'Connect Purdue GenAI Studio', exact: true }).isVisible());
  await page.screenshot({ path: path.join(out, 'cleared-syllabus.png'), fullPage: true });
  check('no UI JavaScript errors occurred', errors.length === 0);
  check('no external requests reached the browser network', blockedRequests.length === 0);
} catch (error) {
  errors.push(error.stack ?? String(error));
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ checks, errors, blockedRequests, extension }, null, 2));
  await context?.close();
  rmSync(profile, { recursive: true, force: true });
}
if (errors.length) throw new Error(errors.join('\n'));
console.log(`Verified ${checks.length} data lifecycle checks. Report: ${path.join(out, 'report.json')}`);
