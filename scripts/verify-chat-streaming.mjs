// Real incremental SSE in a disposable extension page. No account or external requests.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-stream-'));
const out = process.env.VERIFY_OUT ?? '.verify-tmp/chat-streaming';
mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const check = (name, result) => { assert.ok(result, name); checks.push(name); console.log(`PASS  ${name}`); };
let context;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 400, height: 750 }, args: [`--disable-extensions-except=${path.resolve('extension')}`, `--load-extension=${path.resolve('extension')}`] });
  await context.route('https://**/*', route => route.abort());
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/document.html`);
  await page.evaluate(async snapshot => {
    const at = new Date().toISOString();
    const messages = Array.from({ length: 8 }, (_, index) => [
      { role: 'user', content: `Earlier question ${index}` },
      { role: 'assistant', content: 'Earlier course discussion. '.repeat(40) },
    ]).flat();
    await chrome.storage.local.set({ snapshot, genai: { key: 'synthetic', model: 'qwen3.8:27b' }, syncMeta: { ok: true, lastSuccessAt: at }, chats: [{ id: 'stream', title: 'Streaming test', titleGenerated: true, createdAt: at, updatedAt: at, messages }], ui: { view: 'ask', activeChatId: 'stream' } });
  }, snapshotFixture());
  await page.addInitScript(() => {
    const original = window.fetch;
    let streamTurn = 0;
    window.fetch = async (url, options) => {
      if (!String(url).includes('/api/chat/completions')) return original(url, options);
      const body = JSON.parse(options.body);
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Course review' } }] }), { headers: { 'content-type': 'application/json' } });
      const turn = ++streamTurn;
      const isFinal = turn === 4;
      const deltas = isFinal
        ? Array.from({ length: 70 }, (_, index) => ({ content: `\n\nParagraph ${index + 1}. These are the posted course dates and instructions, with context from the source.` }))
        : turn === 1
          ? [{ content: 'Let me find ' }, { content: 'the posted deadlines.' }]
          : turn === 2
            ? [{ content: 'I will check the upcoming course work.' }, { tool_calls: [{ index: 0, id: 'upcoming', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] }]
            : [{ content: 'I will check the saved assignments too.' }, { tool_calls: [{ index: 0, id: 'items', type: 'function', function: { name: 'list_items', arguments: '{}' } }] }];
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ async start(controller) {
        for (const delta of deltas) {
          await new Promise(resolve => setTimeout(resolve, isFinal ? 55 : 200));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await page.goto(`${origin}/sidepanel.html`);
  for (const width of [320, 400, 720]) {
    await page.setViewportSize({ width, height: 750 });
    await page.getByRole('button', { name: 'Thinking level', exact: true }).click();
    check(`thinking options fit a ${width}px panel`, await page.locator('.thinking-options').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight; }));
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 400, height: 750 });
  await page.getByRole('button', { name: 'Thinking level', exact: true }).click();
  await page.getByRole('slider', { name: 'Thinking level' }).press('ArrowRight');
  check('thinking slider selects Quick and reports its value accessibly', await page.getByRole('slider').getAttribute('aria-valuetext') === 'Quick');
  await page.keyboard.press('Escape');
  check('Escape dismisses the thinking popup', await page.locator('.thinking-options').evaluate(el => !el.matches(':popover-open')));
  await page.reload();
  check('thinking selection survives reopening the panel', await page.locator('.thinking-trigger').innerText() === 'Quick');
  await page.getByRole('button', { name: 'Thinking level', exact: true }).click();
  await page.getByRole('slider', { name: 'Thinking level' }).press('Home');
  await page.getByLabel('Question', { exact: true }).click();
  check('outside click dismisses the thinking popup', await page.locator('.thinking-options').evaluate(el => !el.matches(':popover-open')));
  await page.getByLabel('Question', { exact: true }).fill('Check the posted work.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#pending .trace-commentary').first().waitFor({ state: 'attached' });
  check('interim narration stays inside the collapsed activity block', !(await page.locator('#pending').innerText()).includes('Let me find') && await page.locator('#pending > .live-commentary').count() === 0);
  await page.locator('#pending .trace > summary').click();
  check('opening activity reveals narration from a separate assistant turn', await page.locator('#pending .trace-commentary').first().innerText() === 'Let me find the posted deadlines.');
  await page.waitForFunction(() => (document.querySelector('.streaming-answer')?.textContent.length ?? 0) > 700);
  check('multiple narration rounds remain interleaved with their tools during generation', JSON.stringify(await page.locator('#pending .trace-steps > li').evaluateAll(elements => elements.map(element => element.dataset.tool ?? element.textContent))) === JSON.stringify(['Let me find the posted deadlines.', 'I will check the upcoming course work.', 'list_upcoming', 'I will check the saved assignments too.', 'list_items']));
  const messages = page.locator('.messages');
  await messages.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(150);
  const before = await messages.evaluate(el => el.scrollTop);
  await page.waitForTimeout(700);
  const after = await messages.evaluate(el => el.scrollTop);
  check('scrolling up stays at the chosen position while tokens arrive', Math.abs(after - before) < 3);
  await messages.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(200);
  check('returning to the bottom resumes following the live answer', await messages.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 5));
  await page.locator('#pending').waitFor({ state: 'detached' });
  const answer = page.locator('.message.assistant').last();
  check('interim commentary is collapsed with the work log after the final answer', !(await answer.locator('.trace-commentary').first().isVisible()) && !(await answer.innerText()).includes('I will check'));
  await answer.locator('.trace > summary').click();
  check('saved activity retains all narration before the tools that followed it', JSON.stringify(await answer.locator('.trace-commentary').allTextContents()) === JSON.stringify(['Let me find the posted deadlines.', 'I will check the upcoming course work.', 'I will check the saved assignments too.']));
  await answer.locator('.tool-call > summary').first().click();
  check('expanded tool details include a readable result preview', await answer.locator('.tool-preview').first().innerText().then(text => /Quiz 5|Project|Midterm/.test(text)));
  await page.reload();
  const restored = page.locator('.message.assistant').last();
  await restored.locator('.trace > summary').click();
  check('narration remains in saved activity after reopening the panel', await restored.locator('.trace-commentary').count() === 3 && !(await restored.locator(':scope > p').allTextContents()).some(text => text.includes('I will check')));
  check('no browser page errors', errors.length === 0);
  await page.screenshot({ path: path.join(out, 'chat-streaming.png') });
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
} finally { await context?.close(); rmSync(profile, { recursive: true, force: true }); }
