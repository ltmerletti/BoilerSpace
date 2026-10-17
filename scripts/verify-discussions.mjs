// Synthetic, signed-in discussion sites exercise the real extension reader and UI.
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotFixture } from '../tests/helpers.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const { chromium } = await import(pathToFileURL(path.resolve(process.argv[2] ?? './node_modules/playwright/index.mjs')));
const temp = mkdtempSync(path.join(tmpdir(), 'boilerspace-discussions-'));
const extension = path.join(temp, 'extension');
const out = process.env.VERIFY_OUT ?? path.join(temp, 'screenshots');
mkdirSync(out, { recursive: true });
cpSync(path.join(root, 'extension'), extension, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(extension, 'manifest.json')));
// The fixture browser pre-grants hosts; the UI still calls the real permission API.
manifest.host_permissions.push(...manifest.optional_host_permissions);
manifest.optional_host_permissions = [];
writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const context = await chromium.launchPersistentContext(path.join(temp, 'profile'), {
  headless: true, channel: 'chromium', viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce',
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS  ${name}`); };
const poll = async (read, label) => {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
};

let piazzaSignedIn = true;
let edSignedIn = false;
let revisedOldPost = false;
let piazzaThrottled = false;
let updateProgressDuringAsk = true;
let updateEvidenceDuringPiazzaAsk = true;
const operations = [];
const errors = [];
const siteDocuments = [];
try {
  context.on('page', (page) => page.on('pageerror', (error) => errors.push({ message: error.message, stack: error.stack, url: page.url() })));
  context.on('response', response => {
    if (response.request().resourceType() === 'document' && /^https:\/\/(edstem\.org|piazza\.com)\//.test(response.url())) siteDocuments.push({ url: response.url(), fixture: response.headers()['x-boilerspace-fixture'] === '1' });
  });
  await context.route('https://edstem.org/**', (route) => route.fulfill({ contentType: 'text/html', headers: { 'x-boilerspace-fixture': '1' }, body: `${edSignedIn ? '<script>localStorage.setItem("authToken:us","fixture-ed-token")</script>' : ''}<h1>Ed fixture</h1>` }));
  await context.route('https://us.edstem.org/api/**', (route) => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'x-token' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    assert.equal(request.headers()['x-token'], 'fixture-ed-token');
    operations.push(`Ed ${request.method()} ${url.pathname}`);
    let data;
    if (url.pathname === '/api/user') data = { user: { name: 'Do not persist this name' }, push_key: 'do-not-persist', courses: [
      { course: { id: 20, code: 'CS 25200', name: 'CS 25200', status: 'active' } },
      { course: { id: 21, code: 'MA 26500', name: 'MA 26500', status: 'active' } },
      { course: { id: 22, code: 'CS 18000', name: 'Archived course', status: 'archived' } },
    ] };
    else if (/\/courses\/\d+\/threads$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/')[3]);
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const posts = Array.from({ length: id === 20 ? 35 : 33 }, (_, n) => ({ id: id * 100 + n, number: n + 7, updated_at: revisedOldPost && id === 20 && n === 34 ? 'v2' : 'v1', reply_count: 1 }));
      posts.push({ id: id * 100 + 90, is_private: true });
      // Deliberately cap pages below the requested size: a short page is not EOF.
      data = { threads: posts.slice(offset, offset + 15) };
    } else if (/\/threads\/\d+$/.test(url.pathname)) {
      const id = Number(url.pathname.split('/').at(-1));
      data = { users: [{ id: 1, name: 'Secret Student', course_role: 'student' }, { id: 2, name: 'Secret Instructor', course_role: 'staff' }], thread: { id, number: 7, course_id: Math.floor(id / 100), user_id: 1, title: id % 100 === 0 ? 'Project deadline clarification' : `Older discussion ${id}`, content: revisedOldPost && id === 2034 ? '<p>An older clarification has been revised.</p>' : '<document><paragraph>When is the report due?</paragraph></document>', created_at: '2026-10-12T12:00:00Z', updated_at: '2026-10-13T12:00:00Z', answers: [{ id: 99, user_id: 2, content: '<paragraph>The report deadline is Friday at 5 PM.</paragraph>', is_endorsed: true, comments: [] }], comments: [] } };
      if (id === 2000) data.thread.answers = Array.from({ length: 105 }, (_, i) => ({ id: 1000 + i, user_id: i === 104 ? 2 : 1,
        content: i === 104 ? 'Receipt context. '.repeat(1000) + 'The appendixreceipt report deadline is Friday at 5 PM.' : `Earlier student comment ${i}.`,
        is_endorsed: i === 104, comments: [] }));
    } else throw new Error(`Unexpected Ed route: ${url.pathname}`);
    return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });
  });
  await context.route('https://piazza.com/**', (route) => {
    const request = route.request();
    if (!request.url().includes('/logic/api')) return route.fulfill({ contentType: 'text/html', headers: { 'x-boilerspace-fixture': '1' }, body: piazzaSignedIn ? '<meta name="csrf_token" content="fixture-csrf"><h1 id="topbar_current_class_number">Earlier discussion course</h1>' : '<h1>Sign in to Piazza</h1>' });
    if (!piazzaSignedIn) return route.fulfill({ status: 403, body: '{}' });
    assert.equal(request.headers()['csrf-token'], 'fixture-csrf');
    const { method, params } = request.postDataJSON();
    assert.ok(['network.get_my_feed', 'content.get'].includes(method), 'only read methods are allowed');
    operations.push(`Piazza ${method}`);
    if (method === 'content.get' && params.cid === '7' && !piazzaThrottled) {
      piazzaThrottled = true;
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: 'Sorry, too fast -- please wait a second and try again.' }) });
    }
    const result = method === 'network.get_my_feed' ? { more: params.offset === 0, feed: [{ nr: 5, version: 1 }, { nr: 6, version: 1 }, { nr: 7, version: 1 }].slice(params.offset, params.offset + 2) } : {
      nr: Number(params.cid), id: `post-${params.cid}`, tags: ['instructor-note'], created: '2026-10-12T12:00:00Z',
      history: [{ subject: `Notebook notice ${params.cid}`, content: '<p>Notebook maintenance is on Saturday.</p>', uid: 'do-not-persist' }],
      children: [{ id: 'reply', type: 'i_answer', history: [{ content: '<p>The deadline is extended to Monday.</p>' }] }],
    };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ error: null, result }) });
  });
  await context.route('https://purdue.brightspace.com/**', (route) => route.fulfill({ status: 404, body: '{}' }));
  await context.route('https://genai.rcac.purdue.edu/**', async (route) => {
    if (route.request().method() === 'GET') {
      const pathname = new URL(route.request().url()).pathname;
      const data = pathname === '/api/v1/auths/' ? { name: 'Synthetic student' } : pathname === '/api/v1/auths/api_key' ? { api_key: 'fixture-model-key' } : { data: [{ id: 'qwen3.8:27b' }] };
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    }
    const body = route.request().postDataJSON();
    if (body.messages[0]?.content?.startsWith('Name this conversation')) return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Discussion deadline' } }] }) });
    if (updateProgressDuringAsk) {
      updateProgressDuringAsk = false;
      await context.serviceWorkers()[0].evaluate(async () => {
        const { discussions } = await chrome.storage.local.get('discussions');
        discussions.sources[0].checkedCount = (discussions.sources[0].checkedCount ?? 0) + 1;
        discussions.sources[0].lastAttemptAt = new Date().toISOString();
        await chrome.storage.local.set({ discussions });
      });
    }
    const lastQuestion = body.messages.findLastIndex((message) => message.role === 'user');
    const toolResults = body.messages.slice(lastQuestion + 1).filter((m) => m.role === 'tool');
    const piazzaQuestion = body.messages[lastQuestion].content.includes('Piazza');
    if (piazzaQuestion && !toolResults.length && updateEvidenceDuringPiazzaAsk) {
      updateEvidenceDuringPiazzaAsk = false;
      await context.serviceWorkers()[0].evaluate(async () => {
        const { discussions } = await chrome.storage.local.get('discussions');
        discussions.sources.find(source => source.platform === 'piazza').threads[0].text += '\nA newly saved clarification.';
        await chrome.storage.local.set({ discussions });
      });
    }
    const call = (name, args) => ({ tool_calls: [{ index: 0, id: `call-${toolResults.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const result = toolResults.length ? JSON.parse(toolResults.at(-1).content) : null;
    let delta;
    if (!toolResults.length) delta = call('list_discussions', {});
    else if (toolResults.length === 1) {
      const source = result.courses.find(course => course.platform === (piazzaQuestion ? 'Piazza' : 'Ed'));
      assert.ok(source);
      delta = call('search_course_material', { query: piazzaQuestion ? 'Notebook maintenance deadline' : 'appendixreceipt report deadline', source_id: source.source_id });
    } else if (toolResults.length === 2) {
      assert.equal(result.discussion_search, 'potion-i8-bm25', 'Ask uses the bundled semantic worker, rather than falling back silently');
      const hit = result.results.find(hit => piazzaQuestion || hit.discussion_key === 'ed:20:2000');
      assert.ok(hit?.read_targets?.length, 'search exposes direct read targets');
      delta = call('read_discussion', { discussion_key: hit.discussion_key });
    } else if (piazzaQuestion) {
      assert.equal(result.replies[0].author_role, 'instructor');
      delta = { content: `The instructor extended the deadline to Monday [${result.replies[0].source}].` };
    } else if (toolResults.length === 3) {
      assert.equal(result.saved_reply_count, 105);
      assert.equal(result.next_reply_offset, 30);
      delta = call('read_discussion', { discussion_key: 'ed:20:2000', reply_offset: result.next_reply_offset });
    } else if (toolResults.length === 4) {
      assert.equal(result.reply_offset, 30);
      const search = JSON.parse(toolResults[1].content);
      const target = search.results.find(hit => hit.snippet.includes('appendixreceipt')).read_targets.find(target => target.reply_id === '1104');
      assert.ok(target, 'a late reply can be opened without paging through every preview');
      delta = call('read_discussion', { discussion_key: 'ed:20:2000', reply_id: target.reply_id });
    } else if (result.next_offset !== null) {
      delta = call('read_discussion', { discussion_key: 'ed:20:2000', reply_id: result.reply_id, offset: result.next_offset });
    } else {
      assert.ok(result.text.includes('appendixreceipt report deadline is Friday at 5 PM.'));
      assert.equal(result.author_role, 'instructor');
      delta = { content: `The instructor clarified that the report deadline is Friday at 5 PM [${result.source}].` };
    }
    return route.fulfill({ contentType: 'text/event-stream', body: `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n` });
  });
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const id = new URL(worker.url()).host;
  const edPage = await context.newPage();
  await edPage.goto('https://edstem.org/us/');
  const piazzaPage = await context.newPage();
  await piazzaPage.goto('https://piazza.com/class/example123');
  const now = new Date().toISOString();
  await worker.evaluate(async ({ snapshot, now }) => chrome.storage.local.set({ snapshot, syncMeta: { ok: true, at: now, lastSuccessAt: now }, syllabi: { 1600001: { status: 'none', checkedAt: now }, 1600002: { status: 'none', checkedAt: now } }, ui: { view: 'settings' } }), { snapshot: snapshotFixture(), now });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  const read = () => worker.evaluate(async () => (await chrome.storage.local.get('discussions')).discussions);
  await panel.evaluate(() => {
    const request = chrome.permissions.request.bind(chrome.permissions);
    chrome.permissions.request = () => { chrome.permissions.request = request; return Promise.resolve(false); };
  });
  await panel.getByRole('button', { name: 'Connect Ed', exact: true }).click();
  await panel.getByRole('alert').filter({ hasText: 'Site access was not allowed' }).waitFor();
  check('declined site access leaves a retryable connection without opening sign-in', !context.pages().some(page => page !== edPage && page.url() === 'https://edstem.org/us/'));
  await panel.getByRole('button', { name: 'Connect Ed', exact: true }).click();
  const signIn = await poll(() => context.pages().find(page => page !== edPage && page.url() === 'https://edstem.org/us/'), 'Ed sign-in handoff');
  edSignedIn = true;
  await signIn.reload();
  await poll(async () => (await read())?.sources.filter(source => source.platform === 'ed').length === 2 && (await read()).sources.every(source => source.historyComplete), 'one-click Ed connection and import');
  check('Ed connection resumes automatically after sign-in and closes only its own sign-in tab', signIn.isClosed() && !edPage.isClosed());
  check('the browser sidebar connects Ed directly without an extra setup page', !context.pages().some(page => page.url().includes('discussions-access=ed')));
  let saved = await read();
  check('Ed discovers two active courses, excludes the archive, and links both Brightspace courses', saved.sources.length === 2 && saved.sources[0].courseId === 1600001 && saved.sources[1].courseId === 1600002);
  check('Ed imports more than 30 posts across short pages, with instructor replies and private posts excluded', saved.sources.every((s) => s.threads.length === (s.remoteId === '20' ? 35 : 33) && s.historyComplete && s.threads.every((t) => t.replies.some(reply => reply.role === 'instructor'))));
  check('Ed retains more than 100 replies in a busy thread', saved.sources[0].threads.find(thread => thread.id === '2000').replies.length === 105);
  check('discussion storage excludes session tokens, user profiles and author names', !/fixture-ed-token|fixture-csrf|Secret Student|Secret Instructor|do-not-persist/.test(JSON.stringify(saved)));
  await panel.locator('[data-disclosure="piazza-link"] > summary').click();
  await panel.getByLabel('Piazza class URL', { exact: true }).fill('https://piazza.com/class/draft123');
  await panel.evaluate(() => chrome.storage.local.set({ changes: [] }));
  await panel.waitForTimeout(200);
  check('background updates preserve open setup controls and the typed class link', await panel.getByLabel('Piazza class URL', { exact: true }).evaluate(element => element.value.endsWith('/draft123') && document.activeElement === element && element.closest('details').open));
  await panel.getByLabel('Piazza class URL', { exact: true }).fill('');
  await panel.locator('[data-disclosure="piazza-link"] > summary').click();
  await panel.getByRole('button', { name: 'Connect Piazza', exact: true }).click();
  await poll(async () => (await read()).sources.some(source => source.platform === 'piazza' && source.historyComplete), 'Piazza discovery and import without pasting a URL');
  saved = await read();
  const piazza = saved.sources.find((s) => s.platform === 'piazza');
  check('Piazza follows all feed pages and reads instructor answers using the signed-in page CSRF token', piazza.threads.length === 3 && piazza.threads[0].replies[0].role === 'instructor');
  check('Piazza automatically backs off and retries a rate-limited post', piazzaThrottled && piazza.status === 'done');
  check('an older Piazza class stays separate from current Brightspace courses', piazza.courseId === null);
  check('Piazza citations link to the original numbered post', piazza.threads[0].url === 'https://piazza.com/class/example123?cid=5');
  const detailReads = () => operations.filter((op) => /Ed GET \/api\/threads\//.test(op) || op === 'Piazza content.get').length;
  const beforeRefresh = detailReads();
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await poll(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'incremental refresh');
  check('incremental refresh scans history without reopening unchanged posts', detailReads() === beforeRefresh);
  revisedOldPost = true;
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await poll(async () => (await read()).sources[0].threads.some((t) => t.text.includes('older clarification has been revised')), 'older post revision');
  await poll(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'revision refresh');
  check('a changed post beyond the first page is reread on the next sync', detailReads() === beforeRefresh + 1);
  await edPage.close();
  await piazzaPage.close();
  piazzaSignedIn = false;
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await poll(async () => (await read()).sources.find((s) => s.platform === 'piazza').status === 'error', 'expired Piazza session');
  saved = await read();
  check('an expired discussion session preserves cached posts and does not fail Ed', saved.sources.find((s) => s.platform === 'piazza').threads.length === 3 && saved.sources.filter((s) => s.platform === 'ed').every((s) => s.status === 'done'));
  await panel.getByRole('button', { name: 'Reconnect Piazza', exact: true }).click();
  await panel.getByText(/Finish signing in to Piazza/).waitFor({ timeout: 30_000 });
  const piazzaSignIn = await poll(() => context.pages().find(page => page.url().startsWith('https://piazza.com/class/')), 'Piazza sign-in handoff');
  piazzaSignedIn = true;
  await piazzaSignIn.reload();
  await poll(async () => (await read()).sources.every((s) => s.status === 'done'), 'automatic retry after Piazza sign-in');
  check('Piazza reconnect verifies class access and resumes the import after sign-in without another retry click', true);
  check('background readers close only their own temporary site tabs', !context.pages().some((p) => /^https:\/\/(edstem.org|piazza.com)/.test(p.url())));
  await panel.getByRole('button', { name: 'Connect Purdue GenAI Studio', exact: true }).click();
  await poll(() => worker.evaluate(async () => Boolean((await chrome.storage.local.get('genai')).genai?.key)), 'one-click GenAI connection');
  check('GenAI connects from the same screen using the existing account key', (await worker.evaluate(async () => (await chrome.storage.local.get('genai')).genai)).created === false);
  await panel.locator('.tabs button[data-view="ask"]').click();
  await panel.getByLabel('Question', { exact: true }).fill('What did the instructor clarify about the report deadline on Ed?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const answer = panel.locator('.message.assistant:not(.pending)');
  await answer.locator('[data-disclosure^="sources-"] > summary').click({ timeout: 90_000 });
  await answer.locator('.sources a').waitFor();
  check('Ask selects the Ed source, searches, pages replies, continues a long staff answer and cites its original post', (await answer.innerText()).includes('Friday at 5 PM') && (await answer.locator('.sources a').first().getAttribute('href')).includes('https://edstem.org/us/courses/20/discussion/2000'));
  await panel.getByLabel('Question', { exact: true }).fill('What did the instructor say about the deadline on Piazza?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const piazzaAnswer = panel.locator('.message.assistant:not(.pending)').nth(1);
  await piazzaAnswer.locator('[data-disclosure^="sources-"] > summary').click({ timeout: 90_000 });
  await piazzaAnswer.locator('.sources a').waitFor();
  check('Ask searches an unlinked Piazza course by source_id and cites the instructor reply', (await piazzaAnswer.innerText()).includes('Monday') && (await piazzaAnswer.locator('.sources a').first().getAttribute('href')).startsWith('https://piazza.com/class/example123?cid='));
  check('a post update during Ask retries automatically without duplicating the question or treating invalidation as no matches', !updateEvidenceDuringPiazzaAsk && await panel.locator('.message.user').count() === 2 && await panel.locator('.message.assistant:not(.pending)').count() === 2);
  await panel.locator('.tabs button[data-view="settings"]').click();
  await panel.locator('[data-disclosure="manage-ed"] > summary').click();
  const edSource = panel.locator('[data-source-id="ed:20"]');
  check('the class title opens the original site and disconnect is tucked under Options', await edSource.locator('.discussion-class-link').getAttribute('href') === 'https://edstem.org/us/courses/20/discussion' && !(await edSource.getByRole('button', { name: 'Disconnect class', exact: true }).isVisible()));
  await edSource.locator('[data-disclosure^="source-options-"] > summary').click();
  await edSource.getByLabel('Brightspace course', { exact: true }).selectOption('');
  await poll(async () => (await read()).sources.find(source => source.id === 'ed:20').courseId === null, 'manual course unlink');
  check('Options preserves explicit course-link overrides', (await read()).sources.find(source => source.id === 'ed:20').linkOrigin === 'manual');
  await edSource.getByLabel('Brightspace course', { exact: true }).selectOption('1600001');
  await poll(async () => (await read()).sources.find(source => source.id === 'ed:20').courseId === 1600001, 'manual course relink');
  await edSource.getByRole('button', { name: 'Disconnect class', exact: true }).click();
  await poll(async () => (await read()).sources.length === 2, 'disconnect');
  check('disconnect removes one source and keeps the other connections', !(await read()).sources.some((s) => s.id === 'ed:20'));
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'boilerspace-discussions', action: 'remove', sourceId: 'ed:21' }));
  const embedded = await context.newPage();
  await embedded.goto(`chrome-extension://${id}/sidepanel.html?embedded=1`);
  await embedded.locator('.tabs button[data-view="settings"]').click();
  await embedded.getByRole('button', { name: 'Connect Ed', exact: true }).click();
  const access = await poll(() => context.pages().find(page => page.url().includes('discussions-access=ed')), 'embedded permission handoff');
  await access.getByRole('button', { name: 'Allow Ed and connect', exact: true }).click();
  await access.getByRole('heading', { name: 'Ed connected', exact: true }).waitFor();
  await access.close();
  await embedded.close();
  await poll(async () => (await read()).sources.filter(source => source.platform === 'ed').length === 2 && (await read()).sources.filter(source => source.platform === 'ed').every(source => source.historyComplete), 'import continues after permission tab closes');
  check('embedded connection uses one permission handoff and the open panel continues the import after it closes', true);
  check('site requests use only the observed read methods', operations.every((op) => !/POST|PATCH|DELETE/.test(op) || op.startsWith('Piazza')));
  check('every Ed and Piazza document, including sign-in tabs, is served by a fixture', siteDocuments.length > 0 && siteDocuments.every(document => document.fixture));
  check('no browser page errors', errors.length === 0);
  await panel.screenshot({ path: path.join(out, 'discussion-settings.png') });
} catch (error) {
  const pages = [];
  for (const [i, page] of context.pages().entries()) {
    pages.push({ url: page.url(), text: await page.locator('body').innerText({ timeout: 2000 }).catch(() => '') });
    await page.screenshot({ path: path.join(out, `failure-${i}.png`), timeout: 3000 }).catch(() => {});
  }
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, pages, errors, operations, siteDocuments }, null, 2));
  throw error;
} finally {
  await context.close();
  rmSync(temp, { recursive: true, force: true });
}
