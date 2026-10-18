// Loads the unpacked extension in a throwaway Chromium profile, checks PDF reading with the real
// pdf.js, fills storage with sample data, fakes GenAI Studio, and screenshots each view.
// Nothing here talks to the real Brightspace or GenAI Studio.
//
// Run: node scripts/verify.mjs [path/to/playwright]

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fakeBrightspace, MODEL_OUTPUT, pdfWithPages, snapshotFixture, SYLLABUS_PAGES } from '../tests/helpers.mjs';
import { validateExtraction } from '../extension/lib/syllabus.js';

async function showSources(answer) {
  const details = answer.locator('[data-disclosure^="sources-"]');
  await details.waitFor({ state: 'attached', timeout: 20_000 });
  if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
}

const root = fileURLToPath(new URL('..', import.meta.url));
const playwrightPath = process.argv[2] ?? path.join(root, '../course-companion/node_modules/playwright/index.mjs');
const { chromium } = await import(pathToFileURL(playwrightPath).href);

const extensionPath = path.join(root, 'extension');
const outDir = process.env.VERIFY_OUT ?? path.join(root, 'verification');
mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(path.join(process.env.VERIFY_TMP ?? tmpdir(), 'boilerspace-verify-'));

function seed() {
  const snapshot = snapshotFixture();
  const now = new Date();
  const at = (days, hour, minute = 0) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const ma = snapshot.data.find((d) => d.courseId === 1600002);
  ma.assignments.push(
    { kind: 'assignment', id: 51, courseId: 1600002, title: 'WebWork 7', dueAt: at(2, 23, 59), instructions: 'Sections 3.1 to 3.3.', url: 'https://purdue.brightspace.com/a/51' },
    { kind: 'assignment', id: 52, courseId: 1600002, title: 'WebWork 8', dueAt: at(9, 23, 59), instructions: 'Sections 3.4 and 3.5.', url: 'https://purdue.brightspace.com/a/52' },
  );
  ma.quizzes.push({ kind: 'quiz', id: 53, courseId: 1600002, title: 'Quiz 4: Determinants', dueAt: at(0, 18, 0), instructions: 'Open during recitation.', url: 'https://purdue.brightspace.com/q/53' });
  ma.announcements.push({ kind: 'announcement', id: 54, courseId: 1600002, title: 'Exam 2 review session Thursday', body: 'Review in WALC 1055.', postedAt: at(-1, 9), url: 'https://purdue.brightspace.com/n/54' });

  const cs = snapshot.data[0];
  const calendar = cs.events.map((e) => ({ kind: 'event', id: e.id, title: e.title, dueAt: e.startAt }));
  const facts = validateExtraction(MODEL_OUTPUT, SYLLABUS_PAGES, { courseId: 1600001, brightspaceItems: [...cs.assignments, ...calendar] });
  const syllabi = {
    1600001: { status: 'done', courseId: 1600001, topicId: 77, updatedAt: '2026-08-20T00:00:00.000Z', title: 'CS 25200 Syllabus Fall 2026.pdf', url: 'https://purdue.brightspace.com/c/77', kind: 'pdf', pages: SYLLABUS_PAGES, extractedAt: now.toISOString(), ...facts },
    1600002: { status: 'none', courseId: 1600002, checkedAt: now.toISOString() },
  };
  return {
    snapshot: { ...snapshot, fetchedAt: now.toISOString() },
    syncMeta: { ok: true, at: now.toISOString(), lastSuccessAt: now.toISOString(), durationMs: 4200, authMode: 'cookie', requestCount: 31, failedCount: 1, errors: [{ courseId: 1600002, section: 'grades', status: 403, message: 'HTTP 403' }] },
    changes: [
      { id: 'c1', type: 'due-changed', courseId: 1600001, itemKey: 'assignment:12', kind: 'assignment', title: 'Project 2: Malloc', from: '2026-11-04T04:59:00.000Z', to: '2026-11-06T04:59:00.000Z', detectedAt: now.toISOString(), url: 'https://purdue.brightspace.com/a/12' },
      { id: 'c2', type: 'announcement', courseId: 1600001, itemKey: 'announcement:31', kind: 'announcement', title: 'Midterm room change', detectedAt: now.toISOString(), url: 'https://purdue.brightspace.com/n/31' },
    ],
    genai: { key: 'sk-fake-for-screenshots', model: 'gpt-oss:120b', name: 'Boiler Maker', created: false, linkedAt: now.toISOString() },
    syllabi,
    reviews: {},
    syllabusAccess: true,
  };
}

const toolCall = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

// Plays the model. "Due" questions list upcoming items; midterm questions have to open the syllabus file.
function fakeModel(body) {
  if (body.response_format) return { role: 'assistant', content: JSON.stringify(MODEL_OUTPUT) };
  const question = body.messages.findLast((m) => m.role === 'user').content;
  const results = body.messages.slice(body.messages.findLastIndex((m) => m.role === 'user')).filter((m) => m.role === 'tool').map((m) => JSON.parse(m.content));
  if (/midterm/i.test(question)) {
    if (results.length === 0) return toolCall('call_files', 'list_course_files', { course_id: 1600001, query: 'syllabus' });
    if (results.length === 1) return toolCall('call_read', 'read_course_file', { file_key: results[0].files.find((f) => f.can_open).file_key, query: 'midterm exam' });
    const hit = results[1].excerpts.find((e) => /Midterm exam/.test(e.text));
    return { role: 'assistant', content: `Your CS 25200 midterm is **Wednesday, October 21 at 7:00 PM** [${hit.source}].` };
  }
  if (results.length === 0) return toolCall('call_1', 'list_upcoming', { days: 7 });
  const items = results[0].items.slice(0, 4);
  const lines = items.map((i) => `- **${i.title}** (${i.course}), ${i.due_display} [${i.source}]`);
  return { role: 'assistant', content: `Here is what is due in the next 7 days:\n${lines.join('\n')}\nQuiz 5 has a 20 minute limit and one attempt.` };
}

function fakeModelResponse(body) {
  const message = fakeModel(body);
  if (!body.stream) return { contentType: 'application/json', body: JSON.stringify({ choices: [{ message }] }) };
  const thought = message.tool_calls
    ? `I should call ${message.tool_calls[0].function.name} to look this up.`
    : 'I have what I need. Answer with the exact dates and cite each one.';
  const reasoning = thought.match(/[\s\S]{1,12}/g).map((part) => ({ choices: [{ delta: { reasoning_content: part } }] }));
  const chunks = message.tool_calls
    ? [{ choices: [{ delta: { role: 'assistant', tool_calls: message.tool_calls.map((c, index) => ({ index, ...c })) } }] }]
    : (message.content.match(/[\s\S]{1,10}/g) ?? []).map((content) => ({ choices: [{ delta: { content } }] }));
  chunks.unshift(...reasoning);
  return { contentType: 'text/event-stream', body: chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n' };
}

// A stand-in Brightspace homepage with the same navbar structure as Purdue's (D2L Daylight).
const FAKE_HOME = `<!doctype html><html><head><meta charset="utf-8"><title>Homepage - Purdue University</title>
<style>
  body { margin: 0; font-family: Lato, Arial, sans-serif; background: #f1f2f3; color: #202122; }
  d2l-navigation { display: block; background: #fff; border-bottom: 1px solid #d3d9e3; }
  d2l-labs-navigation-main-header { display: flex; justify-content: space-between; align-items: center; height: 64px; padding: 0 24px; }
  .d2l-labs-navigation-header-right { display: flex; align-items: center; gap: 18px; height: 100%; }
  .icon { width: 24px; height: 24px; border-radius: 50%; background: #cdd5dc; }
  .links { background: #000; color: #fff; padding: 10px 24px; font-size: 14px; display: flex; gap: 28px; }
  main { padding: 28px 24px; } .card { background: #fff; border-radius: 8px; padding: 18px; max-width: 760px; margin-bottom: 16px; }
</style>
<script>localStorage.setItem('XSRF.Token', 'xsrf-123');</script></head>
<body><d2l-navigation><d2l-labs-navigation-main-header>
  <div slot="left"><strong>PURDUE</strong> Brightspace</div>
  <div slot="right" class="d2l-labs-navigation-header-right"><span class="icon"></span><span class="icon"></span><span class="icon"></span><span>Boiler Maker</span></div>
</d2l-labs-navigation-main-header><div class="links"><span>My Courses</span><span>Calendar</span><span>Resources</span></div></d2l-navigation>
<main><div class="card"><h2>My Courses</h2><p>CS 25200, Civics Knowledge Test, Scholarly Project Milestones</p></div><div class="card"><h2>Announcements</h2><p>Nothing new.</p></div></main>
</body></html>`;

const FAKE_API_DELAY_MS = 250;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
};

const context = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: process.env.VERIFY_HEADED !== '1',
  // Background scan tabs inherit this size. Match the Brightspace page so closing one
  // does not leave Chromium's emulated pointer coordinates at a different width.
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: process.env.CI ? 1 : 2,
  reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
if (process.env.CI) await context.tracing.start({ screenshots: true, snapshots: true, sources: true });

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  check('service worker starts', Boolean(extensionId), extensionId);

  const modelRequests = [];
  let holdNextResponse = false;
  let releaseHeldResponse;
  let holdToolResponse = false;
  let releaseToolResponse;
  await context.route('https://genai.rcac.purdue.edu/**', async (route) => {
    if (route.request().url().endsWith('/api/models')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-oss:120b' }, { id: 'qwen3.8:27b' }, { id: 'llama3.3:70b' }, { id: 'nomic-embed-text' }] }) });
    }
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (body.messages[0]?.content?.startsWith('Name this conversation')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Weekly deadlines' } }] }) });
    modelRequests.push(body);
    if (holdNextResponse) {
      holdNextResponse = false;
      await new Promise(resolve => { releaseHeldResponse = resolve; });
      await route.abort().catch(() => {});
      return;
    }
    if (holdToolResponse && body.messages.at(-1)?.role === 'tool') {
      holdToolResponse = false;
      await new Promise(resolve => { releaseToolResponse = resolve; });
    }
    await route.fulfill(fakeModelResponse(body));
  });
  let serveBrightspace = false;
  const brightspace = fakeBrightspace();
  const syllabusPdf = Buffer.from(pdfWithPages(SYLLABUS_PAGES.map((p) => p.text.replace(/\u2013/g, '-').split('\n'))));
  await context.route('https://purdue.brightspace.com/**', async (route) => {
    if (!serveBrightspace) return route.abort();
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (!pathname.startsWith('/d2l/api/') && !pathname.startsWith('/d2l/lp/auth/')) {
      return route.fulfill({ contentType: 'text/html', body: FAKE_HOME });
    }
    await sleep(FAKE_API_DELAY_MS);
    if (pathname.endsWith('/content/topics/77/file')) {
      return route.fulfill({ contentType: 'application/pdf', headers: { 'Content-Disposition': 'attachment; filename="CS 25200 Syllabus Fall 2026.pdf"' }, body: syllabusPdf });
    }
    const headers = request.headers();
    const res = await brightspace.fetchImpl(request.url(), {
      method: request.method(),
      headers: { Authorization: headers.authorization, 'X-Csrf-Token': headers['x-csrf-token'] },
      body: request.postData() ?? undefined,
    });
    return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') ?? 'application/json', body: Buffer.from(await res.arrayBuffer()) });
  });

  const page = await context.newPage();
  await page.setViewportSize({ width: 400, height: 1100 });
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
  await page.addInitScript(() => { window.syncLabels = []; new MutationObserver(() => { const text = document.querySelector('#sync-status')?.textContent; if (text) window.syncLabels.push(text); }).observe(document, { childList: true, characterData: true, subtree: true }); });
  await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await page.waitForSelector('.setup');
  await page.screenshot({ path: path.join(outDir, '0-first-run.png') });
  check('first run shows the two setup steps', await page.isVisible('text=Load my courses'));

  const pdfBytes = [...pdfWithPages([['CS 25200 Syllabus', 'Office hours: Tuesdays 2 PM'], ['Late policy: 10% off per day.']])];
  const pdf = await page.evaluate(async (bytes) => {
    const { extractText } = await import('./lib/extract.js');
    return extractText({ bytes: new Uint8Array(bytes), fileName: 'syllabus.pdf', contentType: 'application/pdf' });
  }, pdfBytes);
  check('pdf.js reads PDF text page by page', pdf.pages.length === 2 && /Late policy: 10% off per day/.test(pdf.pages[1].text), JSON.stringify(pdf.pages.map((p) => p.text)));

  await page.evaluate(async (data) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set(data);
  }, seed());
  await page.reload();
  await page.waitForSelector('.agenda');
  await page.screenshot({ path: path.join(outDir, '1-week.png') });
  check('opening a recently synced panel keeps cached syllabi without starting another pass', await page.evaluate(() => !window.syncLabels.some(text => text.includes('Reading syllabi'))));
  const cachedAgenda = await page.locator('.agenda').elementHandle();
  await page.evaluate(() => chrome.storage.local.set({ syncLock: { owner: 'synthetic-background', heartbeat: Date.now() }, syncProgress: { message: 'Reading courses', at: Date.now(), finished: false, done: 1, total: 5 } }));
  await page.waitForFunction(() => document.getElementById('sync-button').disabled);
  check('routine background refresh keeps cached content and hides progress animation', await cachedAgenda.evaluate(el => el.isConnected) && await page.locator('#status').isHidden() && !(await page.locator('#sync-button').getAttribute('class')).includes('spinning') && (await page.locator('#sync-status').innerText()).startsWith('Synced'));
  await page.evaluate(() => chrome.storage.local.remove(['syncLock', 'syncProgress']));
  check('the panel becomes visible only after its saved state is rendered', await page.evaluate(() => !document.documentElement.hasAttribute('data-panel-loading')));
  check('week shows today with items', (await page.locator('.day.today .item').count()) >= 1);
  check('the selected design uses Brightspace typography and a flat agenda', await page.evaluate(async () => {
    await document.fonts.ready;
    return getComputedStyle(document.body).fontFamily.startsWith('Lato') && getComputedStyle(document.body).fontSize === '19px' && getComputedStyle(document.querySelector('.agenda')).boxShadow === 'none';
  }));
  check('date conflicts are a quiet disclosure and routine confirmation buttons are absent', await page.isVisible('text=Syllabus date differences') && (await page.getByRole('button', { name: 'Looks right', exact: true }).count()) === 0);
  const migrated = (await page.evaluate(() => chrome.storage.local.get('genai'))).genai.model;
  check('older connections move to the Qwen default', migrated === 'qwen3.8:27b', migrated);

  await page.click('.tabs button[data-view="courses"]');
  check('syllabus status shows the saved check time', await page.locator('.syllabus-controls').innerText().then(text => /Syllabi last synced/.test(text)));
  await page.screenshot({ path: path.join(outDir, '2-courses.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.locator('.course-row').first().hover();
  check('dark-mode course hover uses link emphasis without filling the row', await page.locator('.course-row').first().evaluate(element => getComputedStyle(element).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(element.querySelector('.course-label')).textDecorationLine.includes('underline')));
  await page.screenshot({ path: path.join(outDir, '2b-course-hover-dark.png') });
  await page.emulateMedia({ colorScheme: 'light' });
  for (const width of [320, 720, 400]) {
    await page.setViewportSize({ width, height: 900 });
    check(`course layout fits a ${width}px panel`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.click('.course-row >> nth=0');
  await page.waitForSelector('.course-head');
  await page.screenshot({ path: path.join(outDir, '3-course-detail.png') });
  check('AI policy stays collapsed under the syllabus', !(await page.isVisible('text=AI tools are allowed with limits.')) && await page.locator('[data-disclosure^="ai-policy-"] > summary').isVisible());
  await page.locator('[data-disclosure^="ai-policy-"] > summary').click();
  check('the policy and source wording remain available on demand', await page.isVisible('text=AI tools are allowed with limits.'));
  check('back navigation has a directional control', await page.getByRole('button', { name: 'All courses', exact: true }).locator('svg').count() === 1);
  await page.click('text=All courses');
  await page.click('.course-row >> nth=1');
  await page.getByText('Add a syllabus', { exact: true }).click();
  check('a course without a syllabus offers upload', await page.isVisible('text=Upload the syllabus'));

  await page.click('.tabs button[data-view="ask"]');
  check('Ask navigation marks the correct view', await page.locator('.tabs [aria-current="page"]').getAttribute('data-view') === 'ask');
  check('the course selector sits inside the composer and the reminder is removed', await page.locator('.composer .scope-button').count() === 1 && !(await page.locator('body').innerText()).includes('Check important details in the cited sources.'));
  const scopeButton = page.locator('.scope-button');
  await scopeButton.focus();
  await page.keyboard.press('ArrowDown');
  check('the course picker opens with the current course focused', await page.getByRole('option', { selected: true }).evaluate(element => element === document.activeElement));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  check('keyboard course selection updates the question scope and returns focus', await scopeButton.evaluate(element => element === document.activeElement && element.getAttribute('aria-expanded') === 'false') && !(await scopeButton.innerText()).includes('All my courses'));
  await scopeButton.click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await scopeButton.click();
  await page.screenshot({ path: path.join(outDir, '4a-course-picker.png') });
  check('course choices use compact rows without overflowing the panel', await page.locator('.scope-options').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && [...element.children].every(option => option.getBoundingClientRect().height <= 40);
  }));
  await page.keyboard.press('Escape');
  check('Escape closes only the picker and restores its trigger', await scopeButton.evaluate(element => element === document.activeElement && element.getAttribute('aria-expanded') === 'false'));
  await scopeButton.click();
  await page.getByRole('heading', { name: 'Ask about your courses' }).click();
  check('clicking outside dismisses the course picker', await page.locator('.scope-options').evaluate(element => !element.matches(':popover-open')));
  await page.screenshot({ path: path.join(outDir, '4-ask-empty.png') });
  await page.getByLabel('Question', { exact: true }).fill('Keep this draft');
  await page.getByLabel('Question', { exact: true }).evaluate(element => element.setSelectionRange(5, 9));
  await page.evaluate(() => chrome.storage.local.set({ changes: [] }));
  await page.waitForTimeout(200);
  check('background updates preserve the question draft, focus and text selection', await page.getByLabel('Question', { exact: true }).evaluate(element => element.value === 'Keep this draft' && document.activeElement === element && element.selectionStart === 5 && element.selectionEnd === 9));
  await page.fill('.composer textarea', 'What do I have due this week?');
  holdToolResponse = true;
  await page.click('.composer button[type="submit"]');
  for (let attempt = 0; !releaseToolResponse && attempt < 100; attempt++) await sleep(50);
  if (!releaseToolResponse) throw new Error('The fixture did not reach the tool-result review phase.');
  check('live activity changes from thinking to reviewing tool results', await page.locator('.pending .trace-current').innerText() === 'Reviewing results');
  check('research starts with the work log open', await page.locator('.pending .trace').evaluate(element => element.open));
  await page.locator('.pending .tool-call > summary').click();
  await page.locator('.pending .trace-reasoning > summary').click();
  await page.locator('.pending .tool-call > summary').focus();
  const argumentSummary = await page.locator('.pending .tool-call > summary').elementHandle();
  await sleep(1100);
  check('elapsed-time updates preserve expanded details and keyboard focus', await argumentSummary.evaluate(element => element.isConnected && document.activeElement === element && element.parentElement.open) && await page.locator('.pending .trace-reasoning').evaluate(element => element.open));
  await page.screenshot({ path: path.join(outDir, '4b-tool-results-live.png') });
  releaseToolResponse();
  await showSources(page.locator('.message.assistant:not(.pending)').last());
  const citeCount = await page.locator('.message.assistant .sources a').count();
  check('ask streams through the tool loop and shows sources', modelRequests.length === 2 && modelRequests.every((r) => r.stream) && citeCount >= 1, `${modelRequests.length} model requests, ${citeCount} sources`);
  const traceSummary = await page.locator('.message.assistant:not(.pending) .trace > summary').textContent();
  await page.click('.message.assistant:not(.pending) .trace > summary');
  await page.screenshot({ path: path.join(outDir, '5-ask.png') });
  check('the activity log clearly names the tool and its result without a reasoning wall', /Used 1 tool/.test(traceSummary) && await page.getByText('Check upcoming work', { exact: true }).isVisible() && await page.locator('.tool-step.complete .tool-result').isVisible() && !(await page.locator('.thought-text').isVisible()) && !(await page.locator('.tool-call > code').isVisible()));
  await page.locator('.tool-call > summary').click();
  await page.locator('.trace-reasoning > summary').click();
  check('arguments and reasoning remain available on demand', await page.locator('.tool-call > code').innerText() === 'list_upcoming(days: 7)' && (await page.locator('.thought-text').innerText()).includes('I should call list_upcoming'));
  check('grades never reach the model', !JSON.stringify(modelRequests).includes('9 / 10'));

  await page.click('.ask-bar button[aria-label="New chat"]');
  check('new chat starts empty', await page.isVisible('.empty-chat'));
  await page.click('.ask-bar button[aria-label="Chats"]');
  await page.screenshot({ path: path.join(outDir, '5b-chats.png') });
  await page.locator('.chat-name').filter({ hasText: 'Weekly deadlines' }).waitFor({ timeout: 15000 });
  check('the chat list keeps the earlier chat', (await page.locator('.chat-row').count()) === 1 && (await page.isVisible('.chat-name >> text=Weekly deadlines')));
  await page.click('.chat-open');
  check('opening a chat brings its messages back', await page.isVisible('.message.user >> text=What do I have due this week?'));

  await page.locator('.message.assistant .message-actions button', { hasText: 'Retry' }).click();
  await showSources(page.locator('.message.assistant:not(.pending)').last());
  check('a completed answer can be retried without duplicating the question',
    modelRequests.length === 4 && (await page.locator('.message.user').count()) === 1 && (await page.locator('.message.assistant:not(.pending)').count()) === 1);
  await page.locator('.message.assistant [data-disclosure^="sources-"] > summary').click();
  await page.setViewportSize({ width: 400, height: 820 });
  await page.screenshot({ path: path.join(outDir, '5c-ask-compact.png') });

  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.copiedAnswer = text; } } }));
  await page.getByRole('button', { name: 'Copy answer', exact: true }).click();
  check('copy uses the current answer text', await page.evaluate(() => window.copiedAnswer.includes('Here is what is due')));
  for (const width of [320, 400]) {
    await page.setViewportSize({ width, height: 600 });
    const layout = await page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect(), messages = document.querySelector('.messages');
      return { fits: composer.bottom <= innerHeight + 1 && composer.top > 0 && document.documentElement.scrollWidth <= innerWidth, scrolls: messages.scrollHeight > messages.clientHeight };
    });
    check(`long conversations scroll while the composer stays visible at ${width}px`, layout.fits && layout.scrolls);
  }
  await page.setViewportSize({ width: 400, height: 900 });
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  holdNextResponse = true;
  await page.getByLabel('Question', { exact: true }).fill('What is due next?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  for (let attempt = 0; !releaseHeldResponse && attempt < 240; attempt++) await sleep(50);
  if (!releaseHeldResponse) throw new Error('The pending response did not reach the fixture.');
  check('pending requests show a single expanded research log', await page.locator('.pending .trace.live').count() === 1 && await page.locator('.pending .trace').evaluate(element => element.open) && await page.locator('.pending > .live-commentary').count() === 0);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('.message.stopped').waitFor();
  releaseHeldResponse();
  check('Stop ends a pending response and restores the composer', await page.getByRole('button', { name: 'Stop', exact: true }).count() === 0 && await page.getByRole('button', { name: 'Continue', exact: true }).isVisible());

  await page.click('.tabs button[data-view="settings"]');
  check('Settings keeps data tools in Advanced without the inline disclaimer panel', await page.getByText('Advanced', { exact: true }).isVisible() && await page.getByText('What is shared', { exact: true }).count() === 0);
  await page.locator('[data-disclosure="advanced-settings"] > summary').click();
  check('Advanced retains export and clear controls without putting them in the default view', await page.getByRole('button', { name: 'Export data', exact: true }).isVisible() && await page.getByRole('button', { name: 'Clear local data', exact: true }).isVisible());
  await page.locator('[data-disclosure="advanced-settings"] > summary').click();
  await page.screenshot({ path: path.join(outDir, '6-settings.png') });
  for (const width of [320, 720, 400]) {
    await page.setViewportSize({ width, height: 900 });
    check(`connection controls fit a ${width}px panel`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: path.join(outDir, '6-settings-dark.png') });
  check('dark mode uses the dark surface and remains within the panel', await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme === 'dark' && document.documentElement.scrollWidth <= innerWidth));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.locator('[data-disclosure="genai-details"] > summary').click();
  await page.waitForSelector('.field select option >> nth=2', { state: 'attached', timeout: 5000 });
  const options = await page.locator('.field select option').allTextContents();
  check('model picker lists GenAI Studio chat models', options.includes('qwen3.8:27b (recommended)') && options.includes('llama3.3:70b') && !options.some((o) => o.includes('embed')), options.join(', '));
  await page.selectOption('.field select', 'llama3.3:70b');
  await sleep(300);
  const picked = (await page.evaluate(() => chrome.storage.local.get('genai'))).genai;
  check('picking a model sticks', picked.model === 'llama3.3:70b' && picked.modelChosen === true);
  const ics = await page.evaluate(async () => {
    const { calendarEvents } = await import('./lib/planner.js');
    const { buildCalendar } = await import('./lib/ics.js');
    const all = await chrome.storage.local.get(null);
    return buildCalendar(calendarEvents(all.snapshot, all.syllabi, all.reviews));
  });
  writeFileSync(path.join(outDir, 'sample.ics'), ics);
  check('calendar export has events', (ics.match(/BEGIN:VEVENT/g) ?? []).length >= 4);

  // ---------- Inside Brightspace: navbar button, automatic sync with progress, in-page panel ----------
  const genai = seed().genai;
  await page.evaluate(async (connection) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({ genai: connection });
  }, genai);
  await page.close();
  serveBrightspace = true;
  modelRequests.length = 0;

  const bs = await context.newPage();
  bs.on('pageerror', (err) => consoleErrors.push(`brightspace: ${err.message}`));
  await bs.setViewportSize({ width: 1280, height: 860 });
  await bs.goto('https://purdue.brightspace.com/d2l/home');
  const navButton = bs.locator('.boilerspace-nav-item button');
  await navButton.waitFor({ timeout: 15_000 });
  check('BoilerSpace button sits in the Brightspace navbar', (await navButton.textContent()).includes('BoilerSpace'));
  await bs.screenshot({ path: path.join(outDir, '7-brightspace-navbar.png'), clip: { x: 0, y: 0, width: 1280, height: 120 } });

  await navButton.click();
  const panelFrame = async () => {
    for (let i = 0; i < 50; i++) {
      const frame = bs.frames().find((f) => f.url().includes('sidepanel.html'));
      if (frame) return frame;
      await sleep(100);
    }
    throw new Error('panel iframe did not load');
  };
  const frame = await panelFrame();
  const progressBar = frame.locator('#status:not([hidden]) .progress');
  await progressBar.waitFor({ timeout: 10_000 });
  await sleep(400);
  await bs.screenshot({ path: path.join(outDir, '8-brightspace-syncing.png') });
  const progressText = await frame.locator('#status span').textContent();
  check('panel shows sync progress', /Syncing|Reading|Checking|Starting/.test(progressText), progressText);
  const push = await bs.evaluate(() => ({ pushed: document.documentElement.classList.contains('boilerspace-pushed'), margin: getComputedStyle(document.documentElement).marginRight }));
  check('the panel pushes Brightspace over instead of covering it', push.pushed && push.margin === '400px', JSON.stringify(push));

  let meta = null;
  for (let i = 0; i < 300 && !meta?.ok; i++) {
    meta = (await worker.evaluate(() => chrome.storage.local.get('syncMeta'))).syncMeta;
    await sleep(200);
  }
  check('automatic sync finishes from the Brightspace page', Boolean(meta?.ok), meta ? `${meta.requestCount} requests, ${meta.authMode} auth` : 'no sync result');
  check('syllabus discovery does not show a stopped course-sync warning', !(await frame.locator('#status').textContent()).includes('The last sync stopped'));

  let syllabus = null;
  for (let i = 0; i < 100 && !['done', 'error', 'unreadable'].includes(syllabus?.status); i++) {
    syllabus = (await worker.evaluate(() => chrome.storage.local.get('syllabi'))).syllabi?.[1600001];
    await sleep(200);
  }
  check('syllabus is downloaded through the page and read', syllabus?.status === 'done' && syllabus.kind === 'pdf', syllabus?.error ?? `${syllabus?.deadlines?.length} dates`);
  check('grades never reach the model from the real sync', modelRequests.length > 0 && !JSON.stringify(modelRequests).includes('9 / 10'));
  await frame.locator('.agenda').waitFor();
  await sleep(300);
  await bs.screenshot({ path: path.join(outDir, '9-brightspace-panel.png') });

  // The panel inside Brightspace must not need tab APIs; it reaches the page directly.
  await frame.locator('.tabs button[data-view="ask"]').click();
  await frame.locator('.composer textarea').fill('When is my CS 25200 midterm?');
  await frame.locator('.composer button[type="submit"]').click();
  await showSources(frame.locator('.message.assistant:not(.pending)').last());
  await frame.locator('.message.assistant:not(.pending) .trace > summary').last().click();
  await sleep(200);
  await bs.screenshot({ path: path.join(outDir, '10-brightspace-ask.png') });
  const answer = await frame.locator('.message.assistant:not(.pending)').last().textContent();
  check('ask opens the syllabus file to answer a midterm question', /October 21 at 7:00 PM/.test(answer) && /opened CS 25200 Syllabus/i.test(answer), answer.slice(0, 160));
  const citeHref = await frame.locator('.message.assistant:not(.pending) .sources a').last().getAttribute('href');
  check('a syllabus citation opens the PDF at the cited page', /\/content\/enforced\/1600001-CS25200\/.+\.pdf#page=\d+$/.test(citeHref ?? ''), citeHref);

  // Brightspace links open in the same tab, and the panel comes back where it was.
  await frame.locator('.tabs button[data-view="week"]').click();
  const itemLink = frame.locator('.agenda a.item-title[href*="/d2l/"]').first();
  const itemHref = await itemLink.getAttribute('href');
  await itemLink.click();
  await bs.waitForURL(itemHref, { timeout: 10_000 });
  await sleep(500);
  const reopened = await panelFrame();
  await reopened.locator('.agenda').waitFor({ timeout: 10_000 });
  const otherTabs = bs.context().pages().filter((p) => p !== bs).map((p) => p.url());
  check('clicking an item opens it in Brightspace and keeps the panel open', bs.url() === itemHref && !otherTabs.some((u) => u.includes(itemHref)), `${itemHref}; other tabs: ${otherTabs.join(', ') || 'none'}`);
  await bs.screenshot({ path: path.join(outDir, '11-brightspace-followed-link.png') });

  await bs.locator('#boilerspace-root .collapse').click();
  await sleep(300);
  const closed = await bs.evaluate(() => ({
    open: document.getElementById('boilerspace-root').shadowRoot.querySelector('.drawer').classList.contains('open'),
    pushed: document.documentElement.classList.contains('boilerspace-pushed'),
  }));
  check('edge arrow hides the panel and gives the page its width back', !closed.open && !closed.pushed, JSON.stringify(closed));
  await bs.locator('#boilerspace-root button[aria-label="Open BoilerSpace"]').click();
  check('edge arrow reopens the panel', await bs.locator('#boilerspace-root .drawer.open').count() === 1);

  const noNavbar = await context.newPage();
  await noNavbar.route('https://purdue.brightspace.com/d2l/no-navbar', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main>Page without a navbar</main></body></html>' }));
  await noNavbar.goto('https://purdue.brightspace.com/d2l/no-navbar');
  await noNavbar.locator('#boilerspace-root').waitFor({ state: 'attached' });
  await sleep(16_000);
  check('no bottom-right launcher appears when the navbar is missing', await noNavbar.locator('#boilerspace-root .floating').count() === 0);
  await noNavbar.close();

  // Exercise the actual background reader with a slow JavaScript document inside a wrapper.
  const delayedText = 'Course syllabus. Midterm October 22. Attendance and grading policies. '.repeat(20);
  const delayedFile = '/content/enforced/999-test/syllabus.html';
  const delayedView = '/d2l/le/content/999/viewContent/1/View';
  await context.route(`https://purdue.brightspace.com${delayedFile}*`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><main id="document">Loading…</main><script>setTimeout(() => { document.getElementById('document').textContent = ${JSON.stringify(delayedText)}; }, 10000);</script></body></html>`,
  }));
  await context.route(`https://purdue.brightspace.com${delayedView}*`, (route) => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html><body><nav>${'Unrelated Brightspace navigation. '.repeat(100)}</nav><main><iframe src="${delayedFile}"></iframe></main></body></html>`,
  }));
  const probe = await context.newPage();
  await probe.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  let renderedDone = false;
  const scanOpened = context.waitForEvent('page', {
    predicate: (page) => page.waitForURL(`**${delayedView}*`, { timeout: 10_000 }).then(() => true, () => false),
    timeout: 15_000,
  });
  const rendered = probe.evaluate((href) => chrome.runtime.sendMessage({ type: 'boilerspace-syllabus', phase: 'page', href, origin: 'https://purdue.brightspace.com' }), delayedView)
    .then((result) => { renderedDone = true; return result; });
  rendered.catch(() => {});
  const scanTab = await scanOpened;
  const refreshed = await probe.evaluate(async () => (await import('./lib/sync.js')).syncNow());
  const duringScan = await probe.evaluate(() => chrome.storage.local.get(['syncMeta', 'syncProgress', 'syncLock']));
  check('course sync completes while a JavaScript syllabus is still loading', refreshed.ok && !renderedDone && duringScan.syncMeta.ok && duringScan.syncProgress.finished && !duringScan.syncLock);
  const renderedResult = await rendered;
  check('the rendered reader waits for the ten-second document and excludes the wrapper', renderedResult.text?.trim() === delayedText.trim(), renderedResult.error ?? `${renderedResult.text?.length} characters`);
  check('the background syllabus tab closes after reading', scanTab.isClosed());
  await probe.close();

  // Overview attachments have no direct fileHref. Their citations open the stored page,
  // and the original PDF remains available through the signed-in Brightspace page.
  const overviewLines = [
    ...Array.from({ length: 40 }, () => 'Course resources and preparation materials are posted in the course modules.'),
    'Midterm: in class, Wednesday October 21, 7:00 PM.',
    'There is no final exam.',
    'Make-ups are only for university-excused absences.',
  ];
  const overviewPages = SYLLABUS_PAGES.map((p) => p.page === 3 ? { ...p, text: overviewLines.join('\n') } : p);
  const overviewPdf = Buffer.from(pdfWithPages(overviewPages.map((p) => p.text.replace(/\u2013/g, '-').split('\n'))));
  await context.route('https://purdue.brightspace.com/d2l/api/le/1.96/1600001/overview/attachment', (route) => route.fulfill({ contentType: 'application/pdf', body: overviewPdf }));
  const viewerHref = await reopened.evaluate(async ({ pages }) => {
    const all = await chrome.storage.local.get(null);
    const data = all.snapshot.data.find((d) => d.courseId === 1600001);
    data.content = data.content.filter((t) => t.id !== 77);
    data.overview = { fileUrl: '/d2l/api/le/1.96/1600001/overview/attachment', text: '' };
    all.syllabi[1600001] = { ...all.syllabi[1600001], topicId: 'overview', updatedAt: null, kind: 'pdf', fileName: 'Course Syllabus.pdf', fileHref: null, title: 'Course overview attachment', url: 'https://purdue.brightspace.com/d2l/home/1600001', pages };
    const { locationUrl, syllabusFile } = await import('./lib/links.js');
    const href = locationUrl(syllabusFile(all.syllabi[1600001], all.snapshot), 'page 3');
    const chat = all.chats.find((c) => c.id === all.ui?.activeChatId) ?? all.chats[0];
    chat.messages = [
      { role: 'user', content: 'What does the syllabus say about make-ups?' },
      { role: 'assistant', content: 'Make-ups require an excused absence [1].', citations: [{ label: 'CS 25200 syllabus, page 3', url: href }] },
    ];
    await chrome.storage.local.set({ snapshot: all.snapshot, syllabi: all.syllabi, chats: all.chats });
    return href;
  }, { pages: overviewPages });
  await reopened.locator('.tabs button[data-view="ask"]').click();
  await showSources(reopened.locator('.message.assistant:not(.pending)').last());
  const viewerOpened = context.waitForEvent('page');
  await reopened.locator(`.sources a[href="${viewerHref}"]`).click();
  const viewer = await viewerOpened;
  viewer.on('pageerror', (err) => consoleErrors.push(`document: ${err.message}`));
  await viewer.locator('#page-text').filter({ hasText: 'university-excused absences' }).waitFor();
  check('an overview citation opens the complete saved page at page 3', new URL(viewer.url()).hash === '#page=3' && await viewer.locator('#page').inputValue() === '3' && (await viewer.locator('#page-text').textContent()) === overviewPages[2].text);
  await viewer.locator('#previous').click();
  await viewer.waitForURL('**#page=2');
  await viewer.waitForFunction((expected) => document.getElementById('page-text').textContent === expected, overviewPages[1].text);
  check('the document reader navigates between saved pages', await viewer.locator('#page-text').textContent() === overviewPages[1].text);
  await viewer.locator('#next').click();
  await viewer.waitForURL('**#page=3');
  await viewer.waitForFunction((expected) => document.getElementById('page-text').textContent === expected, overviewPages[2].text);
  await viewer.locator('#original').click();
  await viewer.locator('#pdf-page:not([hidden])').waitFor({ timeout: 15_000 });
  check('the overview reader can display the original PDF at the cited page', await viewer.locator('#page').inputValue() === '3' && await viewer.locator('#pdf-page').evaluate((canvas) => canvas.width > 0 && canvas.height > 0));
  await viewer.screenshot({ path: path.join(outDir, '12-cited-document.png') });
  await viewer.close();

  await bs.goto('https://purdue.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1600001');
  await sleep(2000);
  check('nothing is added on quiz attempt pages', (await bs.locator('#boilerspace-root, .boilerspace-nav-item').count()) === 0);

  await worker.evaluate(() => chrome.storage.local.set({ drawerOpen: false }));
  const legacy = await context.newPage();
  await legacy.route('https://purdue.brightspace.com/d2l/legacy-navbar', route => route.fulfill({ contentType: 'text/html', body: FAKE_HOME.replaceAll('d2l-labs-navigation-main-header', 'd2l-navigation-main-header').replaceAll('d2l-labs-navigation-header-right', 'd2l-navigation-s-header-right') }));
  await legacy.goto('https://purdue.brightspace.com/d2l/legacy-navbar');
  await legacy.locator('.boilerspace-nav-item button').waitFor();
  check('the older Brightspace header remains supported', await legacy.locator('.boilerspace-nav-item button').isVisible());
  await legacy.close();

  const reloaded = await context.newPage();
  const staleMarkup = '<style id="stale-layout">html.boilerspace-pushed { margin-right: 400px; }</style><div id="boilerspace-root" data-stale="true"></div><div class="boilerspace-nav-item" data-stale="true"></div>';
  await reloaded.route('https://purdue.brightspace.com/d2l/reloaded-navbar', route => route.fulfill({ contentType: 'text/html', body: FAKE_HOME.replace('</body>', staleMarkup + '</body>') }));
  await reloaded.goto('https://purdue.brightspace.com/d2l/reloaded-navbar');
  await reloaded.locator('.boilerspace-nav-item button').waitFor();
  check('reloading the extension replaces stale drawers, navbar controls and layout styles', await reloaded.locator('#boilerspace-root').count() === 1 && await reloaded.locator('.boilerspace-nav-item').count() === 1 && await reloaded.locator('[data-stale], #stale-layout').count() === 0);
  check('the panel host has no box in the Brightspace content flow', await reloaded.locator('#boilerspace-root').evaluate(el => { const r = el.getBoundingClientRect(); return getComputedStyle(el).position === 'fixed' && r.width === 0 && r.height === 0; }));
  await reloaded.close();

  const storageFailure = await context.newPage();
  storageFailure.on('pageerror', error => consoleErrors.push(error.message));
  await storageFailure.addInitScript(() => { chrome.storage.local.get = async () => { throw new Error('Synthetic storage failure'); }; });
  await storageFailure.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  await storageFailure.locator('#status').filter({ hasText: 'Synthetic storage failure' }).waitFor();
  check('a saved-data error is revealed instead of leaving the loading panel hidden', await storageFailure.locator('#status').isVisible() && await storageFailure.evaluate(() => !document.documentElement.hasAttribute('data-panel-loading')));
  await storageFailure.close();

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (error) {
  const pages = [];
  for (const [index, page] of context.pages().entries()) {
    const frames = [];
    for (const frame of page.frames()) {
      frames.push({ url: frame.url(), text: await frame.locator('body').innerText({ timeout: 2000 }).catch(() => '(unavailable)') });
    }
    pages.push({ url: page.url(), frames });
    await page.screenshot({ path: path.join(outDir, `failure-${index}.png`), timeout: 5000 }).catch(() => {});
  }
  writeFileSync(path.join(outDir, 'failure.json'), JSON.stringify({ error: error.message, pages }, null, 2));
  throw error;
} finally {
  if (process.env.CI) await context.tracing.stop({ path: path.join(outDir, 'trace.zip') });
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots are in ${path.relative(process.cwd(), outDir) || '.'}.`);
process.exit(failed.length ? 1 : 0);
