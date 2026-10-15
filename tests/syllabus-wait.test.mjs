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

test('a rendered Syllabus link to a course file is discovered inside shadow DOM', () => {
  const href = '/content/enforced/6824-template/syllabus.html';
  const link = { getAttribute: (name) => ({ href, text: 'Syllabus' })[name], textContent: '' };
  const nav = { getAttribute: () => null, shadowRoot: { querySelectorAll: () => [link] } };
  const doc = { location: { origin: 'https://purdue.brightspace.com' }, querySelectorAll: (selector) => selector === '*' ? [nav] : [], querySelector: () => null };
  assert.deepEqual(snapshotSyllabus(1631466, doc).hrefs, [href]);
  link.getAttribute = (name) => ({ href: 'https://example.com/content/enforced/6824-template/syllabus.html', text: 'Syllabus' })[name];
  assert.deepEqual(snapshotSyllabus(1631466, doc).hrefs, []);
});

test('the real LTI Syllabus link is discoverable and stays scoped to its course', () => {
  const href = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=lti&rcode=resource-12707056&srcou=6824&launchFramed=1&framedName=Syllabus';
  const link = { getAttribute: (name) => ({ href, text: 'Syllabus' })[name] };
  const doc = { location: { origin: 'https://purdue.brightspace.com' }, querySelectorAll: (selector) => selector === '*' ? [link] : [], querySelector: () => null };
  assert.deepEqual(snapshotSyllabus(1631469, doc).hrefs, [href]);
  assert.deepEqual(snapshotSyllabus(1631466, doc).hrefs, []);
});

test('Simple Syllabus reads its document components, excluding the larger navigation wrapper', () => {
  const sections = [{ innerText: 'CS 25100 Fall 2026. '.repeat(40) }, { innerText: 'Assignments and course policies. '.repeat(40) }];
  const doc = { location: { origin: 'https://purdue.simplesyllabus.com', pathname: '/en-US/doc/example' }, readyState: 'complete',
    body: { innerText: 'Navigation login and site footer. '.repeat(1000) },
    querySelectorAll: (selector) => selector === '.content-component' ? sections : [],
    querySelector: (selector) => selector.includes('main') ? { querySelector: () => null } : null,
  };
  const result = snapshotSyllabus(null, doc);
  assert.equal(result.text, sections.map((s) => s.innerText).join(' ').replace(/\s+/g, ' ').trim());
  assert.equal(result.contentReady, true);
  doc.querySelectorAll = () => [];
  assert.equal(snapshotSyllabus(null, doc).text, '', 'a loading wrapper never counts as a syllabus');
});

test('the actual Simple Syllabus missing-section response is a completed absence', async () => {
  const doc = {
    location: { origin: 'https://purdue.simplesyllabus.com', pathname: '/en-US/sso-redirect' }, readyState: 'complete',
    body: { innerText: "Sorry, we could not locate this section in Simple Higher Ed. More Details Currently enrolled sections" },
    querySelectorAll: () => [], querySelector: () => null,
  };
  const shot = snapshotSyllabus(null, doc);
  assert.equal(shot.notFound, true);
  assert.equal(shot.text, '', 'the enrollment list is not read as a syllabus');
  const timer = clock();
  assert.equal((await waitForSyllabus(async () => shot, { phase: 'page', ...timer })).notFound, true);
  assert.ok(timer.now() < 45_000);
  doc.location.origin = 'https://purdue.brightspace.com';
  assert.equal(snapshotSyllabus(null, doc).notFound, false, 'only the syllabus service can report this result');
});
