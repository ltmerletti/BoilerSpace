// Persistent Ask view checks in a disposable Chrome profile. All data and traffic are synthetic.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';
import { installSelectionStream } from '../tests/text-selection-browser.mjs';
import { updateAskMetadata, checkAskBackgroundUpdates } from '../tests/ask-updates-browser.mjs';

const extension = path.resolve(process.env.VERIFY_EXTENSION ?? 'extension');
const out = process.env.VERIFY_OUT ?? '.verify-tmp/ask-updates';
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-ask-updates-'));
mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (name, pass) => { assert.ok(pass, name); checks.push(name); console.log(`PASS  ${name}`); };
let context, page;
try {
  context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 400, height: 850 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https?:/, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic page</title>' }));
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  await worker.evaluate(async snapshot => {
    const at = new Date().toISOString();
    const messages = [{ id: 'u1', role: 'user', content: 'Explain the course topics.' }, { id: 'a1', role: 'assistant', content: 'A saved explanation.\n\nMore course details.', citations: [] }];
    await chrome.storage.local.set({ snapshot, genai: { key: 'synthetic', model: 'qwen3.8:27b' }, syllabusAccess: true,
      syllabi: Object.fromEntries(snapshot.courses.filter(course => course.current).map(course => [course.id, { status: 'none', courseId: course.id, checkedAt: at }])),
      syncMeta: { ok: true, lastSuccessAt: at }, chats: [{ id: 'updates', title: 'Ask updates', titleGenerated: true, createdAt: at, updatedAt: at, messages }],
      discussions: { sources: [{ id: 'ed:synthetic', platform: 'ed', name: 'Systems', courseId: 1600001, status: 'done', lastAttemptAt: at, lastSyncedAt: at, threads: [] }] }, ui: { view: 'ask', activeChatId: 'updates' } });
  }, snapshotFixture());
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/sidepanel.html`);
  await page.getByLabel('Question', { exact: true }).waitFor();
  await page.evaluate(updateAskMetadata);
  const metadataChecks = await page.evaluate(checkAskBackgroundUpdates);
  for (const result of metadataChecks) check(result.name, result.pass);

  const question = page.getByLabel('Question', { exact: true });
  await question.fill('');
  await question.pressSequentially('Draft question');
  await question.press('ControlOrMeta+z');
  check('native undo removes typed text before a background update', await question.inputValue() === '');
  await question.pressSequentially('Draft question');
  await page.evaluate(updateAskMetadata);
  await question.press('ControlOrMeta+z');
  check('native undo still removes typed text after a background update', await question.inputValue() === '');
  check('new messages from another panel append without remounting saved history', await page.evaluate(async () => {
    const saved = [...document.querySelectorAll('.message')];
    const input = document.querySelector('textarea');
    const { chats } = await chrome.storage.local.get('chats');
    chats[0].messages.push({ id: 'remote-user', role: 'user', content: 'A question from another panel.' }, { id: 'remote-answer', role: 'assistant', content: 'An answer from another panel.' });
    await window.updateAskMetadata({ chats });
    return saved.every(node => node.isConnected) && input === document.querySelector('textarea') && document.querySelector('.message:last-child').textContent.includes('An answer from another panel.');
  }));
  check('a model change updates thinking controls without replacing the composer', await page.evaluate(async () => {
    const input = document.querySelector('textarea');
    const { genai } = await chrome.storage.local.get('genai');
    await window.updateAskMetadata({ genai: { ...genai, model: 'llama3.3:70b', modelChosen: true } });
    const hidden = !document.querySelector('.thinking-picker');
    await window.updateAskMetadata({ genai });
    return hidden && !!document.querySelector('.thinking-picker') && input === document.querySelector('textarea');
  }));
  check('changed course options reach the selector without replacing the composer', await page.evaluate(async () => {
    const input = document.querySelector('textarea');
    const { snapshot, syllabi } = await chrome.storage.local.get(['snapshot', 'syllabi']);
    snapshot.courses.push({ id: 999999, name: 'CS 25300', code: 'CS 25300', current: true });
    snapshot.data.push({ courseId: 999999, content: [], assignments: [], quizzes: [], announcements: [], events: [] });
    syllabi[999999] = { status: 'none', courseId: 999999, checkedAt: new Date().toISOString() };
    await window.updateAskMetadata({ snapshot, syllabi });
    return input === document.querySelector('textarea') && document.querySelector('.scope-options').textContent.includes('CS 25300');
  }));

  await page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = message => message.type === 'boilerspace-discussions' && message.action === 'sync'
      ? new Promise(resolve => { window.finishDiscussionRefresh = () => resolve({ ok: true, data: { pending: false } }); }) : send(message);
  });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await page.waitForFunction(() => typeof window.finishDiscussionRefresh === 'function');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await page.evaluate(installSelectionStream);
  await question.fill('Explain the course material.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => window.writeSelectionChunk && document.querySelector('#pending .streaming-answer p'));
  await question.pressSequentially('Draft follow-up');
  await page.evaluate(() => {
    window.askNodes = { input: document.querySelector('textarea'), list: document.querySelector('.messages'), saved: [...document.querySelectorAll('.message:not(#pending)')], pending: document.querySelector('#pending'), paragraph: document.querySelector('#pending .streaming-answer p') };
    window.askStatusUpdates = 0;
    new MutationObserver(() => window.askStatusUpdates++).observe(document.querySelector('#status'), { childList: true });
    window.finishDiscussionRefresh();
  });
  await page.waitForFunction(() => window.askStatusUpdates >= 2);
  check('a discussion refresh finishing during generation retains every conversation element', await page.evaluate(() => askNodes.input === document.querySelector('textarea') && askNodes.list === document.querySelector('.messages') && askNodes.saved.every(node => node.isConnected) && askNodes.pending === document.querySelector('#pending')));
  await page.evaluate(() => { window.writeSelectionChunk('More details.'); window.finishSelectionStream(); });
  await page.locator('#pending').waitFor({ state: 'detached' });
  check('answer completion retains the composer, saved history, active message and streamed paragraph', await page.evaluate(() => askNodes.input === document.querySelector('textarea') && askNodes.saved.every(node => node.isConnected) && askNodes.pending.isConnected && askNodes.paragraph.isConnected));
  await question.press('ControlOrMeta+z');
  check('a follow-up draft keeps native undo through generation, sync completion and answer saving', await question.inputValue() === '' && await page.getByRole('button', { name: 'Send', exact: true }).isDisabled());
  await question.fill('The next question');
  check('the retained composer enables its current Send button after completion', await page.getByRole('button', { name: 'Send', exact: true }).isEnabled());

  const tab = await context.newPage();
  await tab.goto('https://purdue.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1600001');
  await page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: 'https://purdue.brightspace.com/d2l/lms/quizzing/user/attempt/*' });
    await chrome.tabs.update(tab.id, { active: true });
  });
  await page.getByText('Ask is off during quizzes', { exact: true }).waitFor();
  check('quiz locking removes the mounted conversation immediately', await page.locator('.messages').count() === 0);
  await tab.close();
  await page.bringToFront();
  await question.waitFor();
  await page.evaluate(() => { delete window.writeSelectionChunk; });
  await question.fill('A question interrupted by disconnect.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => window.writeSelectionChunk && !!document.querySelector('#pending'));
  await page.evaluate(() => chrome.storage.local.remove('genai'));
  await page.waitForFunction(() => !document.querySelector('.composer'));
  check('disconnecting GenAI during generation removes the conversation and shows setup', await page.locator('.setup').count() > 0 && await page.locator('.message').count() === 0);
  await page.waitForFunction(async () => (await chrome.storage.local.get('chats')).chats[0].messages.at(-1)?.stopped === true);
  check('disconnecting stops the active model request', true);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: 'boilerspace-data', action: 'clear' }));
  await page.waitForFunction(() => !document.querySelector('.message'));
  check('clear local data removes saved conversations', await worker.evaluate(async () => !(await chrome.storage.local.get('chats')).chats));
  check('there are no browser page errors', errors.length === 0);
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors }, null, 2));
  await page?.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
  throw error;
} finally { await context?.close(); rmSync(profile, { recursive: true, force: true }); }
