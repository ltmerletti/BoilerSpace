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
  d2l-navigation-main-header { display: flex; justify-content: space-between; align-items: center; height: 64px; padding: 0 24px; }
  .d2l-navigation-s-header-right { display: flex; align-items: center; gap: 18px; height: 100%; }
  .icon { width: 24px; height: 24px; border-radius: 50%; background: #cdd5dc; }
  .links { background: #000; color: #fff; padding: 10px 24px; font-size: 14px; display: flex; gap: 28px; }
  main { padding: 28px 24px; } .card { background: #fff; border-radius: 8px; padding: 18px; max-width: 760px; margin-bottom: 16px; }
</style>
<script>localStorage.setItem('XSRF.Token', 'xsrf-123');</script></head>
<body><d2l-navigation><d2l-navigation-main-header>
  <div slot="left"><strong>PURDUE</strong> Brightspace</div>
  <div slot="right" class="d2l-navigation-s-header-right"><span class="icon"></span><span class="icon"></span><span class="icon"></span><span>Boiler Maker</span></div>
</d2l-navigation-main-header><div class="links"><span>My Courses</span><span>Calendar</span><span>Resources</span></div></d2l-navigation>
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
  headless: true,
  viewport: { width: 400, height: 1100 },
  deviceScaleFactor: 2,
  args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});

try {
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const extensionId = new URL(worker.url()).host;
  check('service worker starts', Boolean(extensionId), extensionId);

  const modelRequests = [];
  await context.route('https://genai.rcac.purdue.edu/**', async (route) => {
    if (route.request().url().endsWith('/api/models')) {
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'gpt-oss:120b' }, { id: 'qwen3.8:27b' }, { id: 'llama3.3:70b' }, { id: 'nomic-embed-text' }] }) });
    }
    const body = JSON.parse(route.request().postData() ?? '{}');
    modelRequests.push(body);
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
  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(err.message));
  page.on('console', (msg) => msg.type() === 'error' && consoleErrors.push(msg.text()));
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
  check('week shows today with items', (await page.locator('.day.today .item').count()) >= 1);
  check('syllabus dates wait for review', await page.isVisible('text=Check these syllabus dates'));
  const migrated = (await page.evaluate(() => chrome.storage.local.get('genai'))).genai.model;
  check('older connections move to the Qwen default', migrated === 'qwen3.8:27b', migrated);

  await page.click('.tabs button[data-view="courses"]');
  await page.screenshot({ path: path.join(outDir, '2-courses.png') });
  await page.click('.course-row >> nth=0');
  await page.waitForSelector('.course-head');
  await page.screenshot({ path: path.join(outDir, '3-course-detail.png') });
  check('course page shows the AI policy', await page.isVisible('text=AI tools are allowed with limits.'));
  await page.click('text=All courses');
  await page.click('.course-row >> nth=1');
  check('a course without a syllabus offers upload', await page.isVisible('text=Upload the syllabus'));

  await page.click('.tabs button[data-view="ask"]');
  await page.screenshot({ path: path.join(outDir, '4-ask-empty.png') });
  await page.fill('.composer textarea', 'What do I have due this week?');
  await page.click('.composer button[type="submit"]');
  await page.waitForSelector('.message.assistant:not(.pending) .sources', { timeout: 20_000 });
  const citeCount = await page.locator('.message.assistant .sources a').count();
  check('ask streams through the tool loop and shows sources', modelRequests.length === 2 && modelRequests.every((r) => r.stream) && citeCount >= 1, `${modelRequests.length} model requests, ${citeCount} sources`);
  const traceSummary = await page.locator('.message.assistant:not(.pending) .trace summary').textContent();
  await page.click('.message.assistant:not(.pending) .trace summary');
  await page.screenshot({ path: path.join(outDir, '5-ask.png') });
  const toolShown = await page.isVisible('.trace-steps >> text=list_upcoming(days: 7)');
  const thoughts = await page.locator('.trace-steps .thought-text').allTextContents();
  check('the work log shows the reasoning and each tool call', /Used 1 tool/.test(traceSummary) && toolShown && thoughts.some((t) => t.includes('I should call list_upcoming')), `${traceSummary}; ${thoughts.length} thoughts`);
  check('grades never reach the model', !JSON.stringify(modelRequests).includes('9 / 10'));

  await page.click('.ask-bar button[aria-label="New chat"]');
  check('new chat starts empty', await page.isVisible('.empty-chat'));
  await page.click('.ask-bar button[aria-label="Chats"]');
  await page.screenshot({ path: path.join(outDir, '5b-chats.png') });
  check('the chat list keeps the earlier chat', (await page.locator('.chat-row').count()) === 1 && (await page.isVisible('.chat-name >> text=What do I have due this week?')));
  await page.click('.chat-open');
  check('opening a chat brings its messages back', await page.isVisible('.message.user >> text=What do I have due this week?'));

  await page.click('.tabs button[data-view="settings"]');
  await page.waitForSelector('.field select option >> nth=2', { state: 'attached', timeout: 5000 });
  await page.screenshot({ path: path.join(outDir, '6-settings.png') });
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
  const navButton = bs.locator('.d2l-navigation-s-header-right .boilerspace-nav-item button');
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
  for (let i = 0; i < 100 && !meta?.ok; i++) {
    meta = (await worker.evaluate(() => chrome.storage.local.get('syncMeta'))).syncMeta;
    await sleep(200);
  }
  check('automatic sync finishes from the Brightspace page', Boolean(meta?.ok), meta ? `${meta.requestCount} requests, ${meta.authMode} auth` : 'no sync result');

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
  await frame.locator('.message.assistant:not(.pending) .sources').waitFor({ timeout: 20_000 });
  await frame.locator('.message.assistant:not(.pending) .trace summary').last().click();
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

  await bs.goto('https://purdue.brightspace.com/d2l/lms/quizzing/user/attempt/quiz_start_frame_auto.d2l?ou=1600001');
  await sleep(2000);
  check('nothing is added on quiz attempt pages', (await bs.locator('#boilerspace-root, .boilerspace-nav-item').count()) === 0);

  check('no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await context.close();
  rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed. Screenshots are in ${path.relative(process.cwd(), outDir) || '.'}.`);
process.exit(failed.length ? 1 : 0);
