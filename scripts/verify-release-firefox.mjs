// Install the unmodified release archive in official Firefox. All site/model
// traffic is synthetic; no Purdue login or real course data is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { getInstalledBrowsers } from '@puppeteer/browsers';
import { fakeBrightspace, pdfWithPages, pdfWithJpxImage, snapshotFixture } from '../tests/helpers.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = process.env.VERIFY_OUT ?? path.join(root, '.verify-tmp/release-firefox');
const version = JSON.parse(readFileSync(path.join(root, 'package.json'))).version;
const archive = path.join(root, 'dist', `boilerspace-${version}-firefox.zip`);
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-release-firefox-'));
mkdirSync(out, { recursive: true });
let browser;
const checks = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); console.log(`PASS  ${name}`); };
const wait = async read => {
  const until = Date.now() + 45_000;
  while (Date.now() < until) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Packaged Firefox check timed out.');
};
async function reloadAfterInstall(page) {
  // Leave the old extension frames before loading the reinstalled add-on.
  // Reloading their parent during replacement can strand Firefox's BiDi waiter.
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' });
  await page.goto('https://purdue.brightspace.com/d2l/home', { waitUntil: 'domcontentloaded' });
}
try {
  const executablePath = process.env.FIREFOX_PATH ?? (await getInstalledBrowsers({ cacheDir: path.join(root, '.verify-tmp/browsers') })).find(browser => browser.browser === 'firefox')?.executablePath;
  assert.ok(executablePath, 'Set FIREFOX_PATH or install Firefox with: npx @puppeteer/browsers install firefox@stable --path .verify-tmp/browsers');
  if (process.platform === 'darwin') {
    // macOS 27 can deny Firefox its app-data directory on direct exec, even
    // with --profile. LaunchServices avoids that upstream startup bug.
    const socket = createServer();
    await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port;
    await new Promise(resolve => socket.close(resolve));
    const app = executablePath.slice(0, executablePath.indexOf('.app/') + 4);
    assert.ok(app.endsWith('.app'), 'FIREFOX_PATH must point inside a Firefox app on macOS');
    execFileSync('open', ['-n', '-a', app, '--args', '--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${port}`, 'about:blank']);
    browser = await wait(async () => {
      try { return await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${port}/session`, protocol: 'webDriverBiDi' }); }
      catch { return null; }
    });
  } else {
    browser = await puppeteer.launch({ browser: 'firefox', executablePath, userDataDir: profile, headless: true, args: ['--no-remote', '--new-instance'] });
  }
  const browserVersion = await browser.version();
  const errors = [];
  const openedSites = [];
  browser.on('targetcreated', target => { if (/^https:\/\/(?:[^/]+\.)?(?:edstem.org|piazza.com|gradescope.com)\//.test(target.url())) openedSites.push(target.url()); });
  let legacyPage;
  if (process.env.VERIFY_UPGRADE_FROM) {
    await browser.installExtension(path.resolve(process.env.VERIFY_UPGRADE_FROM));
    legacyPage = await browser.newPage();
    await legacyPage.setRequestInterception(true);
    legacyPage.on('request', request => !/^https?:/.test(request.url()) ? request.continue() : request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Upgrade fixture</title><main>Upgrade fixture</main>' }));
    await legacyPage.goto('https://purdue.brightspace.com/d2l/home');
    await legacyPage.waitForSelector('#boilerspace-root');
    await legacyPage.evaluate(() => document.querySelector('#boilerspace-root').shadowRoot.querySelector('button').click());
    const legacyPanel = await wait(async () => {
      for (const frame of legacyPage.frames().filter(frame => frame.parentFrame())) {
        if (await frame.evaluate(() => !!globalThis.chrome?.runtime?.id).catch(() => false)) return frame;
      }
    });
    await legacyPanel.evaluate(async snapshot => {
      const at = new Date().toISOString();
      await chrome.storage.local.set({ snapshot, syncMeta: { ok: true, lastSuccessAt: at }, syllabi: {}, theme: 'dark', ui: { view: 'ask', activeChatId: 'legacy' }, chats: [{ id: 'legacy', title: 'Retained conversation', createdAt: at, updatedAt: at, messages: [{ role: 'user', content: 'Retain this draft conversation.' }] }] });
    }, snapshotFixture());
  }
  const id = await browser.installExtension(archive);
  check('the unmodified Firefox ZIP installs', id === 'boilerspace@lukem.dev');
  if (legacyPage) {
    await reloadAfterInstall(legacyPage);
    const upgraded = await wait(async () => {
      for (const frame of legacyPage.frames().filter(frame => frame.parentFrame())) {
        const value = await frame.evaluate(async () => globalThis.chrome?.runtime?.id ? { version: chrome.runtime.getManifest().version, data: await chrome.storage.local.get(['theme', 'snapshot', 'chats']) } : null).catch(() => null);
        if (value?.version === version) return value;
      }
    });
    check('upgrading the previous package retains courses, theme and conversations', upgraded.data.theme === 'dark' && upgraded.data.snapshot.courses.length === snapshotFixture().courses.length && upgraded.data.chats[0].messages[0].content === 'Retain this draft conversation.');
    for (const frame of legacyPage.frames().filter(frame => frame.parentFrame())) await frame.evaluate(async () => { if (globalThis.chrome?.runtime?.id) await chrome.storage.local.clear(); }).catch(() => {});
    await legacyPage.close();
  }
  const page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const fake = fakeBrightspace({ requireToken: false });
  await page.setRequestInterception(true);
  page.on('request', async request => {
    if (!/^https?:/.test(request.url())) return request.continue();
    if (request.url() === 'https://purdue.brightspace.com/d2l/home') return request.respond({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Packaged Firefox test</title><d2l-navigation-main-header><div slot="right"></div></d2l-navigation-main-header><main>Release verification</main>' });
    if (request.url().startsWith('https://purdue.brightspace.com/d2l/api/')) {
      const response = await fake.fetchImpl(request.url());
      return request.respond({ status: response.status, contentType: 'application/json', body: await response.text() });
    }
    return request.respond({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto('https://purdue.brightspace.com/d2l/home');
  await page.waitForSelector('#boilerspace-root');
  check('the packaged Brightspace content script starts', true);
  await page.evaluate(() => document.querySelector('#boilerspace-root').shadowRoot.querySelector('button').click());
  // Firefox BiDi can report about:blank for an extension frame even when its
  // document is loaded. Inspect the frame document instead of its URL cache.
  const panel = await wait(async () => {
    for (const frame of page.frames().filter(frame => frame.parentFrame())) {
      if (await frame.evaluate(() => document.title === 'BoilerSpace' && !!document.querySelector('[data-view]')).catch(() => false)) return frame;
    }
  });
  check('the unmodified packaged panel opens beside Brightspace', true);
  const metadata = await panel.evaluate(() => ({ manifest: chrome.runtime.getManifest() }));
  assert.equal(metadata.manifest.version, version);
  assert.ok(metadata.manifest.background.scripts[0].endsWith('background-firefox.js'), JSON.stringify(metadata.manifest.background));
  assert.ok(!metadata.manifest.background.service_worker);
  assert.ok(metadata.manifest.browser_specific_settings.gecko.data_collection_permissions.required.includes('websiteContent'), JSON.stringify(metadata.manifest.browser_specific_settings));
  check('Firefox runs its event-page entry point and native consent declaration', true);
  await wait(() => panel.evaluate(async () => (await chrome.storage.local.get('snapshot')).snapshot?.courses?.length > 0));
  check('course sync crosses the real embedded-page bridge', fake.calls.some(call => call.path.includes('myenrollments')));
  check('the native Firefox background message returns a syllabus permission response', (await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'boilerspace-syllabus-access' })))?.ok);

  await panel.evaluate(async snapshot => {
    const at = new Date().toISOString();
    await chrome.storage.local.set({ snapshot, syncMeta: { ok: true, lastSuccessAt: at }, syllabi: Object.fromEntries(snapshot.courses.filter(course => course.current).map(course => [course.id, { status: 'none', courseId: course.id, checkedAt: at }])), genai: { key: 'synthetic', model: 'qwen3.8:27b' }, gradescope: { generation: 'release-fixture', status: 'done', lastAttemptAt: at, lastSyncedAt: at, courses: [{ id: 'gradescope:20', remoteId: '20', name: 'CS 25200', courseId: 1600001, assignments: [{ key: 'gradescope:20:51', id: '51', title: 'Lab 8', courseId: 1600001, dueAt: '2026-10-21T21:30:00Z', lateDueAt: '2026-10-22T21:30:00Z', url: 'https://www.gradescope.com/courses/20/assignments/51' }] }] } });
  }, snapshotFixture());
  const pdf = await panel.evaluate(async bytes => (await import('./lib/extract.js')).extractText({ bytes: new Uint8Array(bytes), fileName: 'release.pdf', contentType: 'application/pdf' }), [...pdfWithPages([['Packaged PDF reading works.']])]);
  check('bundled PDF.js and its worker read a real PDF under the release CSP', pdf.pages[0].text.includes('Packaged PDF reading works'));
  const pixels = await panel.evaluate(async bytes => {
    const picture = await (await import('./lib/extract.js')).pagePicture(new Uint8Array(bytes), 'page 1');
    const image = await createImageBitmap(await (await fetch(`data:${picture.mediaType};base64,${picture.data}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height), ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return [Array.from(ctx.getImageData(image.width / 4, image.height / 2, 1, 1).data), Array.from(ctx.getImageData(image.width * 3 / 4, image.height / 2, 1, 1).data)];
  }, [...pdfWithJpxImage()]);
  check('JPEG2000 image pages render their actual pixels using bundled codecs', pixels[0][0] > 180 && pixels[0][2] < 70 && pixels[1][2] > 180 && pixels[1][0] < 70);
  const semantic = await panel.evaluate(async () => {
    const { createDiscussionSearch, DiscussionSearchClient } = await import('./lib/discussion-search.js');
    const client = new DiscussionSearchClient();
    try { return await createDiscussionSearch({ sources: [{ id: 'ed:1', name: 'Systems', courseId: 1600001, threads: [{ key: 'ed:1:1', title: 'Kernel restart', text: 'Restarting the notebook kernel clears variables from memory.', role: 'instructor', number: 1, url: 'https://edstem.org/us/courses/1/discussion/1', replies: [] }] }] }, { searchClient: client })('Why did my notebook forget its variables?', { courseId: 1600001 }); }
    finally { client.dispose(); }
  });
  check('the packaged semantic worker uses the bundled model', semantic.method === 'potion-i8-bm25' && semantic.results.length === 1);
  await panel.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/chat/completions')) return original(url, options);
      const body = JSON.parse(options.body);
      let delta;
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Lab 8 deadlines' } }] }), { headers: { 'Content-Type': 'application/json' } });
      const tool = body.messages.findLast(message => message.role === 'tool');
      if (!tool) delta = { tool_calls: [{ index: 0, id: 'release-assignments', type: 'function', function: { name: 'list_gradescope_assignments', arguments: '{"query":"Lab 8"}' } }] };
      else {
        const item = JSON.parse(tool.content).items[0];
        delta = { content: `Lab 8 is due ${item.due_display}. Its late deadline is ${item.late_due_display} [${item.source}].` };
      }
      return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    };
    document.querySelector('[data-view="ask"]').click();
  });
  await wait(() => panel.evaluate(() => !!document.querySelector('textarea[aria-label="Question"]')));
  await panel.evaluate(() => {
    const input = document.querySelector('textarea[aria-label="Question"]');
    input.value = 'What are the regular and late deadlines for Lab 8 on Gradescope?';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
  });
  const answer = await wait(() => panel.evaluate(async () => (await chrome.storage.local.get('chats')).chats?.[0]?.messages.findLast(message => message.role === 'assistant' && message.content && !message.error)));
  check('Ask runs a metadata tool and saves a source citation in Firefox', answer.trace.some(step => step.name === 'list_gradescope_assignments') && answer.citations.some(source => source.url === 'https://www.gradescope.com/courses/20/assignments/51'));
  check('the final answer renders the original assignment link', await panel.evaluate(() => !!document.querySelector('.message.assistant a[href="https://www.gradescope.com/courses/20/assignments/51"]')));
  const missingAccess = await panel.evaluate(async () => {
    const reply = await chrome.runtime.sendMessage({ type: 'boilerspace-gradescope', action: 'sync', force: true });
    const { gradescope } = await chrome.storage.local.get('gradescope');
    return { reply, cached: gradescope.courses[0].assignments.length };
  });
  check('revoked or missing optional access reports reconnection and retains cached work', missingAccess.reply.needsReconnect && missingAccess.cached === 1);
  await page.reload();
  const reopened = await wait(async () => {
    for (const frame of page.frames().filter(frame => frame.parentFrame())) {
      if (await frame.evaluate(() => document.title === 'BoilerSpace' && !!document.querySelector('[data-view]')).catch(() => false)) return frame;
    }
  });
  check('a page reload restores the panel and saved chat', await reopened.evaluate(async () => (await chrome.storage.local.get('chats')).chats[0].messages.some(message => message.role === 'assistant' && message.citations?.length)));

  // Hold tokens and DONE separately so upward scrolling is tested both during
  // streaming and at the transition to the saved answer.
  await reopened.evaluate(() => {
    const original = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith('/api/chat/completions')) return original(url, options);
      const body = JSON.parse(options.body);
      if (!body.stream) return Response.json({ choices: [{ message: { content: 'Scroll regression' } }] });
      // Complete the required lookup before holding the final answer. Otherwise
      // DONE starts another model turn instead of completing the conversation.
      if (!body.messages.some(message => message.role === 'tool')) {
        const delta = { tool_calls: [{ index: 0, id: 'scroll-courses', type: 'function', function: { name: 'list_courses', arguments: '{}' } }] };
        return new Response(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
      }
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({ start(controller) {
        const write = text => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
        write(Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}. ${'Synthetic course explanation for checking the reader position. '.repeat(3)}\n\n`).join(''));
        window.nextScrollChunk = () => write('Another synthetic explanation. '.repeat(30));
        window.finishScrollAnswer = () => { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); };
      } }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    document.querySelector('[data-view="ask"]').click();
    const input = document.querySelector('textarea[aria-label="Question"]');
    input.value = 'Explain the course concepts for a local scroll regression.';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button[aria-label="Send"]').click();
  });
  const scrollMetrics = () => reopened.evaluate(() => {
    const el = document.querySelector('.messages');
    return { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight, pending: !!document.querySelector('#pending') };
  });
  await wait(async () => await reopened.evaluate(() => !!window.nextScrollChunk && document.querySelector('#pending .streaming-answer')?.textContent.length > 1000) && (await scrollMetrics()).gap <= 1);
  const messages = await reopened.$('.messages');
  await messages.hover();
  await page.mouse.wheel({ deltaY: -5 });
  await wait(async () => (await scrollMetrics()).gap > 0);
  await new Promise(resolve => setTimeout(resolve, 200));
  const paused = await scrollMetrics();
  check('a small real Firefox wheel scroll moves away from the answer bottom', paused.gap > 0 && paused.gap < 12);
  await reopened.evaluate(() => window.nextScrollChunk());
  await wait(async () => (await scrollMetrics()).gap > paused.gap + 20);
  check('streaming tokens do not pull a paused Firefox reader back down', Math.abs((await scrollMetrics()).top - paused.top) < 2);
  await page.mouse.wheel({ deltaY: 100000 });
  await wait(async () => (await scrollMetrics()).gap <= 1);
  await new Promise(resolve => setTimeout(resolve, 200));
  await page.mouse.wheel({ deltaY: -40 });
  await wait(async () => (await scrollMetrics()).gap > 20);
  await new Promise(resolve => setTimeout(resolve, 200));
  const beforeDone = await scrollMetrics();
  check('the Firefox reader is paused within the old eighty-pixel completion threshold', beforeDone.gap > 20 && beforeDone.gap < 80);
  await reopened.evaluate(() => window.finishScrollAnswer());
  await wait(async () => !(await scrollMetrics()).pending);
  check('finishing an answer preserves the paused Firefox reader position', Math.abs((await scrollMetrics()).top - beforeDone.top) < 2);

  await browser.installExtension(archive);
  await reloadAfterInstall(page);
  const retained = await wait(async () => {
    for (const frame of page.frames().filter(frame => frame.parentFrame())) {
      const value = await frame.evaluate(async () => typeof chrome !== 'undefined' && chrome.runtime?.id ? { version: chrome.runtime.getManifest().version, chats: (await chrome.storage.local.get('chats')).chats } : null).catch(() => null);
      if (value?.chats?.length) return value;
    }
  });
  check('reloading the packaged extension retains its saved conversations', retained.version === version && retained.chats[0].messages.some(message => message.role === 'assistant' && message.citations?.length));
  check('routine work opens no Ed, Piazza or Gradescope tabs', openedSites.length === 0);
  check('the Brightspace page has no JavaScript errors', errors.length === 0);
  writeFileSync(path.join(out, 'report.json'), JSON.stringify({ browser: browserVersion, version, checks }, null, 2) + '\n');
  console.log(`${checks.length} packaged Firefox checks passed (${browserVersion}).`);
} finally {
  await browser?.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
