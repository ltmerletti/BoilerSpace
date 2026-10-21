// Real incremental SSE in a disposable extension page. No account or external requests.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';
import { installSelectionStream, selectionCoordinates, selectionState } from '../tests/text-selection-browser.mjs';
import { checkChatRecovery } from '../tests/chat-recovery-browser.mjs';
const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-stream-'));
const out = process.env.VERIFY_OUT ?? '.verify-tmp/chat-streaming';
mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const extension = path.resolve(process.env.VERIFY_EXTENSION ?? 'extension');
const check = (name, result) => { assert.ok(result, name); checks.push(name); console.log(`PASS  ${name}`); };
let context, page;
try {
  context = await chromium.launchPersistentContext(profile, { headless: true, channel: 'chromium', viewport: { width: 400, height: 750 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route('https://**/*', route => route.abort());
  let [worker] = context.serviceWorkers();
  worker ??= await context.waitForEvent('serviceworker');
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  page = await context.newPage();
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
    window.syntheticRateLimits = 0;
    window.syntheticModelRequests = 0;
    window.fetch = async (url, options) => {
      if (!String(url).includes('/api/chat/completions')) return original(url, options);
      const body = JSON.parse(options.body);
      if (!body.stream) return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Course review' } }] }), { headers: { 'content-type': 'application/json' } });
      window.syntheticModelRequests++;
      if (window.syntheticStopRequest) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }));
      if (!window.syntheticRateLimits) {
        window.syntheticRateLimits++;
        return new Response(JSON.stringify({ detail: 'Rate limit exceeded. Please try again later.' }), { status: 400, headers: { 'content-type': 'application/json', 'retry-after': '0.01' } });
      }
      const turn = ++streamTurn;
      const isFinal = turn === 4;
      if (turn === 1) await new Promise(resolve => { window.releaseStart = resolve; });
      if (turn === 2) await new Promise(resolve => { window.releaseSecondTurn = resolve; });
      if (turn === 3) await new Promise(resolve => { window.releaseThirdTurn = resolve; });
      const deltas = isFinal
        ? Array.from({ length: 180 }, (_, index) => ({ content: `\n\nParagraph ${index + 1}. These are the posted course dates and instructions, with context from the source.` }))
        : turn === 1
          ? [{ content: 'Let me find ' }, { content: 'the posted deadlines.' }]
          : turn === 2
            ? [{ content: 'I will check the upcoming course work.' }, { tool_calls: [{ index: 0, id: 'upcoming', type: 'function', function: { name: 'list_upcoming', arguments: '{"days":7}' } }] }]
            : [{ reasoning_content: 'Checking the saved assignments.' }, { content: 'I will check the saved assignments too.' }, { tool_calls: [{ index: 0, id: 'items', type: 'function', function: { name: 'list_items', arguments: '{}' } }] }];
      const encoder = new TextEncoder();
      const stream = new ReadableStream({ async start(controller) {
        if (isFinal) await new Promise(resolve => { window.releaseFinal = resolve; });
        for (const [index, delta] of deltas.entries()) {
          if (turn === 2 && delta.tool_calls) await new Promise(resolve => { window.releaseToolCall = resolve; });
          if (turn === 3 && index === 1) await new Promise(resolve => { window.releaseThirdText = resolve; });
          await new Promise(resolve => setTimeout(resolve, isFinal ? 55 : 200));
          while (isFinal && window.syntheticPauseFinal) await new Promise(resolve => setTimeout(resolve, 10));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
        }
        if (isFinal) await new Promise(resolve => { window.releaseDone = resolve; });
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
    check(`thinking options fit a ${width}px panel without wrapping their labels`, await page.locator('.thinking-options').evaluate(el => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight && [...el.querySelectorAll('.thinking-stops span')].every(label => label.getBoundingClientRect().height < 25 && label.getBoundingClientRect().right <= r.right - 8); }));
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 400, height: 750 });
  await page.getByRole('button', { name: 'Thinking level', exact: true }).click();
  await page.getByRole('slider', { name: 'Thinking level' }).press('ArrowRight');
  check('thinking slider selects Quick and reports its value accessibly', await page.getByRole('slider').getAttribute('aria-valuetext') === 'Quick');
  await page.locator('.thinking-options').screenshot({ path: path.join(out, 'thinking-slider.png') });
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
  await page.waitForFunction(() => typeof window.releaseStart === 'function');
  check('a Purdue-style HTTP 400 rate limit retries before streaming the first narration', await page.evaluate(() => window.syntheticRateLimits === 1 && window.syntheticModelRequests >= 2));
  check('a new question starts with the work log expanded', await page.locator('#pending > .trace').evaluate(el => el.open));
  await page.evaluate(() => window.releaseStart());
  await page.waitForFunction(() => typeof window.releaseSecondTurn === 'function');
  check('interim narration appears once inside the expanded work log', await page.locator('#pending .trace-commentary').count() === 1 && await page.locator('#pending .trace-commentary').first().isVisible() && await page.locator('#pending > .live-commentary').count() === 0);
  await page.locator('#pending > .trace > summary').click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  check('a full render preserves a manually closed research log', !(await page.locator('#pending > .trace').evaluate(el => el.open)));
  await page.locator('#pending > .trace > summary').click();
  await page.evaluate(() => window.releaseSecondTurn());
  await page.waitForFunction(() => typeof window.releaseToolCall === 'function');
  check('candidate writing leaves the research log open instead of collapsing it each round', await page.locator('#pending > .trace').evaluate(el => el.open) && await page.locator('.streaming-answer').isVisible());
  await page.evaluate(() => window.releaseToolCall());
  await page.waitForFunction(() => typeof window.releaseThirdTurn === 'function');
  check('a candidate followed by a tool becomes commentary without changing the research disclosure', await page.locator('#pending > .trace').evaluate(el => el.open) && await page.locator('#pending .trace-commentary').count() === 2 && await page.locator('.streaming-answer').count() === 0);
  await page.locator('#pending > .trace > summary').click();
  await page.evaluate(() => window.releaseThirdTurn());
  await page.waitForFunction(() => typeof window.releaseThirdText === 'function');
  check('more reasoning preserves a manually closed research log', !(await page.locator('#pending > .trace').evaluate(el => el.open)));
  await page.evaluate(() => window.releaseThirdText());
  await page.waitForFunction(() => typeof window.releaseFinal === 'function');
  check('subsequent tools preserve a manually closed work log without standalone narration copies', !(await page.locator('#pending > .trace').evaluate(el => el.open)) && await page.locator('#pending > .live-commentary').count() === 0);
  check('multiple narration rounds remain interleaved with their tools during generation', JSON.stringify(await page.locator('#pending .trace-steps > li').evaluateAll(elements => elements.map(element => element.dataset.tool ?? element.textContent))) === JSON.stringify(['Let me find the posted deadlines.', 'I will check the upcoming course work.', 'list_upcoming', 'I will check the saved assignments too.', 'list_items']));
  await page.evaluate(() => window.releaseFinal());
  await page.waitForFunction(() => (document.querySelector('.streaming-answer')?.textContent.length ?? 0) > 100);
  const messages = page.locator('.messages');
  const position = () => messages.evaluate(el => ({ top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight }));
  const pauseTokens = async () => {
    await page.evaluate(() => { window.syntheticPauseFinal = true; });
    await page.waitForTimeout(100);
  };
  const advanceTokens = async () => {
    const length = await page.locator('.streaming-answer').evaluate(el => el.textContent.length);
    await page.evaluate(() => { window.syntheticPauseFinal = false; });
    await page.waitForFunction(length => document.querySelector('.streaming-answer').textContent.length > length + 180, length);
    await pauseTokens();
  };
  await pauseTokens();
  await page.locator('#pending > .trace > summary').click();
  const disclosureTop = (await position()).top;
  await advanceTokens();
  check('opening a visible activity block pauses following without moving its summary away', Math.abs((await position()).top - disclosureTop) < 1 && await page.locator('#pending > .trace').evaluate(el => el.open));
  await page.locator('#pending > .trace > summary').click();
  await page.evaluate(() => { window.syntheticPauseFinal = false; });
  await page.waitForFunction(() => (document.querySelector('.streaming-answer')?.textContent.length ?? 0) > 700);
  check('final-answer text preserves a manually closed activity block with all prior narration inside it', !(await page.locator('#pending > .trace').evaluate(el => el.open)) && await page.locator('#pending > .live-commentary').count() === 0 && !(await page.locator('#pending .trace-commentary').first().isVisible()));
  const heldClick = async locator => {
    await locator.scrollIntoViewIfNeeded();
    const element = await locator.elementHandle();
    const box = await locator.boundingBox();
    await page.mouse.move(box.x + 8, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(250);
    check('a disclosure summary remains attached through streamed token updates', await element.evaluate(el => el.isConnected));
    await page.mouse.up();
    await page.waitForTimeout(80);
  };
  await heldClick(page.locator('#pending .trace > summary'));
  check('the activity block opens while tokens arrive', await page.locator('#pending .trace').evaluate(el => el.open));
  await heldClick(page.locator('#pending .tool-call > summary').first());
  check('tool details open while tokens arrive', await page.locator('#pending .tool-call').first().evaluate(el => el.open));
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  check('full renders preserve manual root and nested disclosure choices while writing', await page.locator('#pending > .trace').evaluate(el => el.open) && await page.locator('#pending .tool-call').first().evaluate(el => el.open));
  await heldClick(page.locator('#pending .tool-call > summary').first());
  check('tool details close while tokens arrive', !(await page.locator('#pending .tool-call').first().evaluate(el => el.open)));
  await heldClick(page.locator('#pending .trace > summary'));
  check('the activity block closes while tokens arrive', !(await page.locator('#pending .trace').evaluate(el => el.open)));
  await pauseTokens();
  await messages.hover();
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(120);
  check('a deliberate downward wheel can return to the bottom', (await position()).gap < 1);
  await page.mouse.wheel(0, -5);
  await page.waitForTimeout(120);
  const smallScroll = await position();
  check('a small upward wheel actually moves the conversation before more tokens', smallScroll.gap >= 4 && smallScroll.gap <= 6);
  await advanceTokens();
  check('a five-pixel upward gesture stays paused while tokens arrive', Math.abs((await position()).top - smallScroll.top) < 1);
  await messages.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
  await page.waitForTimeout(80);
  const programmaticTop = (await position()).top;
  await advanceTokens();
  check('programmatic scrolling to the bottom does not resume paused following', Math.abs((await position()).top - programmaticTop) < 1 && (await position()).gap > 5);
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(120);
  await advanceTokens();
  check('a deliberate downward return resumes following the live answer', (await position()).gap < 1);
  await messages.evaluate(el => { el.tabIndex = -1; el.focus({ preventScroll: true }); });
  await messages.press('ArrowUp');
  await page.waitForTimeout(300);
  const keyboardTop = (await position()).top;
  await advanceTokens();
  check('upward keyboard navigation pauses following while tokens arrive', Math.abs((await position()).top - keyboardTop) < 1);
  await messages.press('End');
  await page.waitForTimeout(400);
  await advanceTokens();
  check('End deliberately resumes following after keyboard navigation', (await position()).gap < 1);
  await page.mouse.wheel(0, -5);
  await page.waitForTimeout(120);
  await messages.evaluate(el => { el.scrollTop = el.scrollHeight - el.clientHeight - 400; });
  await page.setViewportSize({ width: 720, height: 750 });
  await page.waitForTimeout(120);
  const resized = await position();
  check('widening the panel clamps the paused reading position to the new bottom', resized.gap < 1);
  await advanceTokens();
  check('a resize that clamps the reading position cannot resume following', Math.abs((await position()).top - resized.top) < 1);
  await page.setViewportSize({ width: 400, height: 750 });
  await page.waitForTimeout(120);
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(120);
  await messages.hover();
  await page.mouse.wheel(0, -500);
  await page.waitForTimeout(150);
  const before = await messages.evaluate(el => el.scrollTop);
  await advanceTokens();
  const after = await messages.evaluate(el => el.scrollTop);
  check('scrolling up stays at the chosen position while tokens arrive', Math.abs(after - before) < 3);
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(120);
  await advanceTokens();
  check('returning to the bottom resumes following the live answer', await messages.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 5));
  await page.evaluate(() => { window.syntheticPauseFinal = false; });
  await page.waitForFunction(() => typeof window.releaseDone === 'function');
  await messages.hover();
  await page.mouse.wheel(0, -40);
  await page.waitForTimeout(120);
  const completionTop = (await position()).top;
  check('the reader is above the bottom before completion', (await position()).gap >= 39 && (await position()).gap <= 41);
  await page.evaluate(() => window.releaseDone());
  await page.locator('#pending').waitFor({ state: 'detached' });
  check('completion preserves an explicitly paused reading position within eighty pixels of the bottom', Math.abs((await position()).top - completionTop) < 1);
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
  await page.evaluate(() => { window.syntheticStopRequest = true; });
  await page.getByLabel('Question', { exact: true }).fill('Another question.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  check('a consecutive question starts expanded regardless of the previous saved disclosure', await page.locator('#pending > .trace').evaluate(el => el.open));
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.locator('#pending').waitFor({ state: 'detached' });
  check('a stopped request saves a resumable message', await page.getByRole('button', { name: 'Continue', exact: true }).count() === 1);
  await page.evaluate(installSelectionStream);
  await page.getByLabel('Question', { exact: true }).fill('Explain the course material.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => window.writeSelectionChunk && document.querySelector('#pending .streaming-answer p'));
  const coordinates = await page.evaluate(selectionCoordinates);
  await page.mouse.move(coordinates.end.x, coordinates.end.y);
  await page.mouse.down();
  await page.mouse.move(coordinates.start.x, coordinates.start.y, { steps: 12 });
  const selected = await page.evaluate(selectionState);
  check('mouse dragging backwards selects the actual answer text', selected.text === 'Select this' && selected.backward);
  await page.evaluate(() => window.writeSelectionChunk('More details keep arriving in the same paragraph. '));
  await page.waitForFunction(() => document.querySelector('#pending .streaming-answer p').textContent.includes('More details'));
  check('an active mouse selection survives a token appended to its text node', (await page.evaluate(selectionState)).text === selected.text);
  await page.mouse.up();
  await page.evaluate(() => window.writeSelectionChunk('\n\n' + 'Another paragraph makes the answer longer. '.repeat(30)));
  await page.waitForFunction(() => document.querySelectorAll('#pending .streaming-answer p').length === 2);
  const growing = await page.evaluate(selectionState);
  check('selection direction and scroll position survive further streamed paragraphs', growing.text === selected.text && growing.backward && Math.abs(growing.top - selected.top) < 1);
  await page.evaluate(() => window.finishSelectionStream());
  await page.locator('#pending').waitFor({ state: 'detached' });
  const completed = await page.evaluate(selectionState);
  check('saving the completed answer preserves selected text and direction', completed.text === selected.text && completed.backward);
  await page.evaluate(async () => {
    const { chats } = await chrome.storage.local.get('chats');
    chats[0].title = 'Updated chat title';
    await chrome.storage.local.set({ chats });
  });
  await page.waitForFunction(() => document.querySelector('.chat-title')?.textContent === 'Updated chat title');
  check('a background chat update preserves selection through a full panel redraw', (await page.evaluate(selectionState)).text === selected.text);
  for (const result of await page.evaluate(checkChatRecovery)) check(result.name, result.pass);
  check('no browser page errors', errors.length === 0);
  await page.screenshot({ path: path.join(out, 'chat-streaming.png') });
  writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, errors }, null, 2));
} catch (error) {
  const layout = await page?.evaluate(() => {
    const el = document.querySelector('.messages');
    return { top: el?.scrollTop, height: el?.scrollHeight, viewport: el?.clientHeight,
      activeElement: document.activeElement?.tagName, traceOpen: document.querySelector('#pending > .trace')?.open };
  }).catch(() => null);
  writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.stack, checks, errors, layout }, null, 2));
  await page?.screenshot({ path: path.join(out, 'failure.png'), timeout: 5000 }).catch(() => {});
  throw error;
} finally { await context?.close(); rmSync(profile, { recursive: true, force: true }); }
