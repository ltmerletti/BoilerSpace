// Record narration/tool transitions in a disposable profile, with no live model requests.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { snapshotFixture } from '../tests/helpers.mjs';

const baseOut = path.resolve(process.env.VERIFY_OUT ?? '.verify-tmp/narration-video/verification');
const extension = path.resolve(process.env.VERIFY_EXTENSION ?? 'extension');
async function verifyNarration(pauseReader, out) {
  const profile = mkdtempSync(path.join(tmpdir(), 'boilerspace-narration-'));
  mkdirSync(out, { recursive: true });
  const observations = [], errors = [];
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: true, viewport: { width: 480, height: 850 },
      recordVideo: { dir: out, size: { width: 480, height: 850 } },
      args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
    });
    await context.route(/^https?:/, route => route.abort());
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
    const origin = `chrome-extension://${new URL(worker.url()).host}`;
    await worker.evaluate(async snapshot => {
      const at = new Date().toISOString();
      await chrome.storage.local.set({ snapshot, genai: { key: 'synthetic', model: 'qwen3.8:27b' },
        syllabi: Object.fromEntries(snapshot.courses.map(course => [course.id, { status: 'none' }])),
        syncMeta: { ok: true, lastSuccessAt: at }, ui: { view: 'ask' } });
    }, snapshotFixture());
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const original = window.fetch;
      let turn = 0;
      window.releaseNarrationTools = {};
      window.narrationObservations = [];
      window.fetch = async (url, options) => {
        if (!String(url).endsWith('/api/chat/completions')) return original(url, options);
        const body = JSON.parse(options.body);
        if (!body.stream) return Response.json({ choices: [{ message: { content: 'Course review' } }] });
        const round = ++turn;
        const encoder = new TextEncoder();
        const narration = round === 1
          ? 'Let me find the course information and check which materials are relevant. I will compare the upcoming assignments with the posted quizzes so the answer uses the right dates.\n\nI will start by finding the course, then look through its saved assignments and announcements.'
          : 'I found the course. Let me check the upcoming work and its instructions before putting together the review list.\n\nI also need to verify the quiz deadline and the topics mentioned in the assignment descriptions. I will keep the course sources together while checking those details.';
        return new Response(new ReadableStream({ async start(controller) {
          const send = delta => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
          if (round <= 2) {
            window.narrationStage = `reasoning-${round}`;
            send({ reasoning_content: 'Compare the saved course information and posted work.' });
            await new Promise(resolve => setTimeout(resolve, 1200));
            window.narrationStage = `narration-${round}`;
            for (const content of narration.match(/.{1,18}|\n/g)) {
              send({ content });
              await new Promise(resolve => setTimeout(resolve, 65));
            }
            window.narrationStage = `waiting-${round}`;
            await new Promise(resolve => { window.releaseNarrationTools[round] = resolve; });
            send({ tool_calls: [{ index: 0, id: `narration-${round}`, type: 'function', function: { name: round === 1 ? 'list_courses' : 'list_upcoming', arguments: round === 1 ? '{}' : '{"days":7}' } }] });
          } else {
            window.narrationStage = 'final';
            const final = '**Review topics**\n\n- Processes and signals\n- Project instructions and the required submission files\n- The posted quiz topics\n\nThe next quiz covers processes and signals. Review those concepts, then revisit the project instructions for the submission requirements.\n\n' + 'The saved course sources distinguish deadlines from the topics you are expected to review. '.repeat(10);
            for (const content of final.match(/.{1,18}|\n/g)) {
              send({ content });
              await new Promise(resolve => setTimeout(resolve, 65));
            }
          }
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        } }), { headers: { 'Content-Type': 'text/event-stream' } });
      };
      setInterval(() => {
        const scroller = document.querySelector('.messages'), trace = document.querySelector('#pending > .trace');
        if (!scroller || !trace) return;
        window.narrationObservations.push({ at: performance.now(), stage: window.narrationStage,
          open: trace.open, top: scroller.scrollTop, height: scroller.scrollHeight,
          summaryY: trace.querySelector('summary').getBoundingClientRect().top,
          candidateLength: document.querySelector('.streaming-answer')?.textContent.length ?? 0 });
      }, 50);
    });
    await page.goto(`${origin}/sidepanel.html`);
    await page.getByLabel('Question', { exact: true }).fill('What should I review for the upcoming quiz?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    for (const round of [1, 2]) {
      await page.waitForFunction(round => window.narrationStage === `waiting-${round}`, round);
      assert.ok(await page.locator('#pending > .trace').evaluate(el => el.open), 'narration does not automatically collapse the work log');
      await page.screenshot({ path: path.join(out, `narration-${round}.png`) });
      observations.push(await page.evaluate(() => window.narrationObservations.at(-1)));
      if (round === 2 && pauseReader) {
        const trace = page.locator('#pending > .trace');
        if (!await trace.evaluate(el => el.open)) await trace.locator(':scope > summary').click();
        await trace.locator('.tool-call > summary').first().click();
        await page.locator('.messages').hover();
        await page.mouse.wheel(0, -100);
        await page.waitForTimeout(300);
      }
      await page.evaluate(({ round, close }) => {
        if (close) document.querySelector('#pending > .trace > summary').click();
        window.releaseNarrationTools[round]();
      }, { round, close: pauseReader && round === 1 });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(out, `tool-${round}.png`) });
      assert.equal(await page.locator('#pending > .trace').evaluate(el => el.open), !(pauseReader && round === 1), 'tool transitions preserve a disclosure click made at the same time');
      if (pauseReader && round === 1) await page.locator('#pending > .trace > summary').click();
    }
    await page.locator('#pending').waitFor({ state: 'detached', timeout: 30000 });
    assert.equal(await page.locator('.message.assistant > .trace').last().evaluate(el => el.open), pauseReader,
      pauseReader ? 'finishing preserves the open research log for a paused reader' : 'the confirmed final answer folds research for a following reader');
    if (pauseReader) assert.ok(await page.locator('.message.assistant .tool-call').first().evaluate(el => el.open), 'open tool details survive the final-answer transition');
    const video = page.video();
    const metrics = await page.evaluate(() => window.narrationObservations);
    await page.screenshot({ path: path.join(out, 'finished.png') });
    await page.close();
    await video.saveAs(path.join(out, 'narration.webm'));
    writeFileSync(path.join(out, 'observations.json'), JSON.stringify({ observations, metrics, errors, pauseReader }, null, 2));
    assert.deepEqual(errors, []);
    console.log(`Recorded ${metrics.length} narration samples: ${path.join(out, 'narration.webm')}`);
  } finally { await context?.close(); rmSync(profile, { recursive: true, force: true }); }
}

if (process.env.VERIFY_PAUSED_READER !== undefined) await verifyNarration(process.env.VERIFY_PAUSED_READER !== '0', baseOut);
else for (const paused of [false, true]) await verifyNarration(paused, path.join(baseOut, paused ? 'paused' : 'following'));
