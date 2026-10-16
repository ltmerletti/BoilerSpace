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
  headless: true, channel: 'chromium', viewport: { width: 1100, height: 900 },
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
let revisedOldPost = false;
let piazzaThrottled = false;
const operations = [];
const errors = [];
try {
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('https://edstem.org/**', (route) => route.fulfill({ contentType: 'text/html', body: '<script>localStorage.setItem("authToken:us","fixture-ed-token")</script><h1>Ed fixture</h1>' }));
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
    } else throw new Error(`Unexpected Ed route: ${url.pathname}`);
    return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(data) });
  });
  await context.route('https://piazza.com/**', (route) => {
    const request = route.request();
    if (!request.url().includes('/logic/api')) return route.fulfill({ contentType: 'text/html', body: '<meta name="csrf_token" content="fixture-csrf"><h1 id="topbar_current_class_number">Earlier discussion course</h1>' });
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
  await context.route('https://genai.rcac.purdue.edu/**', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'qwen3.8:27b' }] }) });
    const body = route.request().postDataJSON();
    const toolResults = body.messages.filter((m) => m.role === 'tool');
    let delta;
    if (!toolResults.length) delta = { tool_calls: [{ index: 0, id: 'search', type: 'function', function: { name: 'search_course_material', arguments: JSON.stringify({ query: 'report deadline Friday', course_id: 1600001 }) } }] };
    else if (toolResults.length === 1) {
      const result = JSON.parse(toolResults[0].content);
      delta = { tool_calls: [{ index: 0, id: 'read', type: 'function', function: { name: 'read_discussion', arguments: JSON.stringify({ discussion_key: result.results[0].discussion_key }) } }] };
    } else {
      const result = JSON.parse(toolResults.at(-1).content);
      delta = { content: `The instructor clarified that the report deadline is Friday at 5 PM [${result.replies[0].source}].` };
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
  await panel.getByRole('button', { name: 'Connect Ed courses', exact: true }).click();
  const access = await poll(() => context.pages().find((p) => p.url().includes('discussions-access=ed')), 'Ed permission page');
  await access.getByRole('button', { name: 'Allow Ed and connect', exact: true }).click();
  await access.getByText('Ed is connected.', { exact: false }).waitFor();
  const read = () => worker.evaluate(async () => (await chrome.storage.local.get('discussions')).discussions);
  let saved = await read();
  check('Ed discovers two active courses, excludes the archive, and links both Brightspace courses', saved.sources.length === 2 && saved.sources[0].courseId === 1600001 && saved.sources[1].courseId === 1600002);
  check('Ed imports more than 30 posts across short pages, with instructor replies and private posts excluded', saved.sources.every((s) => s.threads.length === (s.remoteId === '20' ? 35 : 33) && s.historyComplete && s.threads.every((t) => t.replies[0].role === 'instructor')));
  check('discussion storage excludes session tokens, user profiles and author names', !/fixture-ed-token|fixture-csrf|Secret Student|Secret Instructor|do-not-persist/.test(JSON.stringify(saved)));
  await access.close();
  await panel.getByLabel('Piazza class URL', { exact: true }).fill('https://piazza.com/class/example123');
  await panel.getByRole('button', { name: 'Connect Piazza class', exact: true }).click();
  const piAccess = await poll(() => context.pages().find((p) => p.url().includes('discussions-access=piazza')), 'Piazza permission page');
  await piAccess.getByRole('button', { name: 'Allow Piazza and connect', exact: true }).click();
  await piAccess.getByText('Piazza is connected.', { exact: false }).waitFor();
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
  await piAccess.close();
  await edPage.close();
  await piazzaPage.close();
  piazzaSignedIn = false;
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await poll(async () => (await read()).sources.find((s) => s.platform === 'piazza').status === 'error', 'expired Piazza session');
  saved = await read();
  check('an expired discussion session preserves cached posts and does not fail Ed', saved.sources.find((s) => s.platform === 'piazza').threads.length === 3 && saved.sources.filter((s) => s.platform === 'ed').every((s) => s.status === 'done'));
  piazzaSignedIn = true;
  await poll(() => panel.getByRole('button', { name: 'Sync discussions now', exact: true }).isEnabled(), 'sync button');
  await panel.getByRole('button', { name: 'Sync discussions now', exact: true }).click();
  await poll(async () => (await read()).sources.every((s) => s.status === 'done'), 'manual retry');
  check('manual retry restores the expired source', true);
  check('background readers close only their own temporary site tabs', !context.pages().some((p) => /^https:\/\/(edstem.org|piazza.com)/.test(p.url())));
  await worker.evaluate(() => chrome.storage.local.set({ genai: { key: 'fixture-model-key', model: 'qwen3.8:27b', modelChosen: true } }));
  await panel.locator('.tabs button[data-view="ask"]').click();
  await panel.getByLabel('Question', { exact: true }).fill('What did the instructor clarify about the report deadline on Ed?');
  await panel.getByRole('button', { name: 'Send', exact: true }).click();
  const answer = panel.locator('.message.assistant:not(.pending)');
  await answer.locator('.sources a').waitFor();
  check('Ask searches discussion text, reads staff replies and renders a direct Ed citation', (await answer.innerText()).includes('Friday at 5 PM') && (await answer.locator('.sources a').first().getAttribute('href')).includes('https://edstem.org/us/courses/20/discussion/2000'));
  await panel.locator('.tabs button[data-view="settings"]').click();
  await panel.locator('[data-source-id="ed:20"]').getByRole('button', { name: 'Disconnect', exact: true }).click();
  await poll(async () => (await read()).sources.length === 2, 'disconnect');
  check('disconnect removes one source and keeps the other connections', !(await read()).sources.some((s) => s.id === 'ed:20'));
  check('site requests use only the observed read methods', operations.every((op) => !/POST|PATCH|DELETE/.test(op) || op.startsWith('Piazza')));
  check('no browser page errors', errors.length === 0);
  await panel.screenshot({ path: path.join(out, 'discussion-settings.png') });
} catch (error) {
  const pages = [];
  for (const [i, page] of context.pages().entries()) {
    pages.push({ url: page.url(), text: await page.locator('body').innerText({ timeout: 2000 }).catch(() => '') });
    await page.screenshot({ path: path.join(out, `failure-${i}.png`), timeout: 3000 }).catch(() => {});
  }
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, pages, errors, operations }, null, 2));
  throw error;
} finally {
  await context.close();
  rmSync(temp, { recursive: true, force: true });
}
