import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { MODEL_OUTPUT, snapshotFixture, SYLLABUS_PAGES } from '../tests/helpers.mjs';
import { checkCustomLlm } from '../tests/custom-llm-browser.mjs';

const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-custom-llm-'));
const out = process.env.VERIFY_OUT ?? '.verify-tmp/custom-llm';
mkdirSync(out, { recursive: true });
const extension = path.resolve(process.env.VERIFY_EXTENSION ?? 'extension');
let context, page;
const errors = [];
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 400, height: 880 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('https://**/*', route => route.abort());
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/document.html`);
  await page.evaluate(async snapshot => {
    const at = new Date().toISOString();
    await chrome.storage.local.set({ snapshot, genai: { key: 'synthetic-purdue', model: 'qwen3.8:27b' }, syncMeta: { ok: true, lastSuccessAt: at }, syllabi: Object.fromEntries(snapshot.courses.filter(course => course.current).map(course => [course.id, { status: 'none', checkedAt: at }])) });
  }, snapshotFixture());
  await page.goto(`${origin}/sidepanel.html?llm-setup=1`);
  await page.getByRole('combobox', { name: 'Model provider' }).waitFor();
  await page.exposeFunction('customLlmSubmit', () => page.locator('.custom-api-form button[type="submit"]').click());
  const checks = await page.evaluate(checkCustomLlm, { modelOutput: MODEL_OUTPUT, pages: SYLLABUS_PAGES });
  for (const check of checks) console.log(`PASS  ${check.name}`);
  assert.equal(errors.length, 0, errors.join('\n'));
  await page.evaluate(async () => chrome.storage.local.set({ customLlm: { provider: 'custom', baseUrl: 'https://genai.rcac.purdue.edu/synthetic/v1', key: 'synthetic-screenshot-key', model: 'custom-browser-model', generation: 'screenshot' }, llmProvider: 'custom' }));
  await page.locator('.custom-api-form input[type="password"]').waitFor();
  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 880 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `API settings fit ${width}px`);
  }
  await page.screenshot({ path: path.join(out, 'settings.png') });
  await page.evaluate(() => chrome.storage.local.set({ theme: 'dark' }));
  await page.screenshot({ path: path.join(out, 'settings-dark.png') });
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, errors, body: await page?.locator('body').innerText().catch(() => '') }, null, 2));
  throw error;
} finally { await context?.close(); rmSync(profile, { recursive: true, force: true }); }
