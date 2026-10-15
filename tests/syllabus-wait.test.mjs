import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForSyllabus } from '../extension/lib/syllabus-wait.js';
import { snapshotSyllabus } from '../extension/lib/syllabus-scan.js';

function clock() {
  let time = 0;
  return { now: () => time, wait: async (ms) => { time += ms; } };
}

test('waits for a syllabus inserted by JavaScript after ten seconds', async () => {
  const timer = clock();
  const text = 'Course syllabus, assessment dates and attendance policy. '.repeat(30);
  const shot = await waitForSyllabus(async () => ({
    hrefs: [], text: timer.now() >= 10_000 ? text : '', contentReady: timer.now() >= 10_000,
  }), { phase: 'page', ...timer });
  assert.equal(shot.text, text);
  assert.ok(timer.now() >= 12_000);
});

test('a shorter replacement document has to stabilize too', async () => {
  const timer = clock();
  const final = 'Actual syllabus content. '.repeat(30);
  const shot = await waitForSyllabus(async () => ({
    text: timer.now() >= 11_600 ? final : 'Outdated document. '.repeat(100), contentReady: true,
  }), { phase: 'page', ...timer });
  assert.equal(shot.text, final);
  assert.ok(timer.now() >= 13_600);
});

test('a loaded course with no Syllabus link is an ordinary missing result', async () => {
  const timer = clock();
  const result = await waitForSyllabus(async () => ({ hrefs: [], text: '', navReady: true }), { phase: 'links', ...timer });
  assert.deepEqual(result.hrefs, []);
  assert.ok(timer.now() >= 12_000 && timer.now() < 30_000);
});

test('an unloaded navigation or document reports a loading failure, not no syllabus', async () => {
  for (const phase of ['links', 'page']) {
    const timer = clock();
    await assert.rejects(waitForSyllabus(async () => ({ hrefs: [], text: 'Course navigation text. '.repeat(100), contentReady: false, navReady: false }), {
      phase, timeoutMs: 15_000, ...timer,
    }), /did not finish loading/);
  }
});

test('extracts the document frame rather than a longer course wrapper', () => {
  const frame = {
    location: { pathname: '/content/enforced/1/syllabus.html' }, readyState: 'complete',
    body: { innerText: 'Actual syllabus and course schedule. '.repeat(30) }, querySelectorAll: () => [],
  };
  const doc = {
    location: { origin: 'https://purdue.brightspace.com', pathname: '/d2l/le/content/1/viewContent/2/View' },
    readyState: 'complete', body: { innerText: 'Brightspace navigation and unrelated items. '.repeat(200) },
    querySelector: () => null,
    querySelectorAll: (selector) => selector === 'iframe, frame' ? [{ contentDocument: frame }] : [],
  };
  const result = snapshotSyllabus(null, doc);
  assert.equal(result.text, frame.body.innerText.trim());
  assert.equal(result.contentReady, true);
  frame.body.innerText = 'Loading…';
  assert.equal(snapshotSyllabus(null, doc).text, '');
});
