import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installChrome, snapshotFixture, SYLLABUS_PAGES, MODEL_OUTPUT } from './helpers.mjs';
import { chooseSyllabus, processCourse, processCurrentSyllabi } from '../extension/lib/syllabus.js';

const now = new Date('2026-10-15T19:00:00Z');
const missing = () => Object.assign(new Error('HTTP 404'), { status: 404 });
const available = { kind: 'pdf', pages: SYLLABUS_PAGES, fileName: 'Syllabus.pdf' };
function setup() {
  const stored = installChrome({ tabs: [{ id: 5, url: 'https://purdue.brightspace.com/d2l/home', status: 'complete' }] });
  stored.genai = { key: 'sk-test', model: 'qwen3.8:27b' };
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }] }), { headers: { 'Content-Type': 'application/json' } });
  const snapshot = snapshotFixture();
  const course = snapshot.data[1];
  course.overview = { text: 'Welcome! Please proceed to the course content.', hasAttachment: true, fileUrl: '/d2l/api/le/1.96/1600002/overview/attachment' };
  return { stored, snapshot, course };
}

test('a legacy overview 404 recovers automatically to missing and caches the completed search', async () => {
  const { stored, snapshot } = setup();
  stored.syllabi = { 1600002: { status: 'error', topicId: 'overview', error: 'HTTP 404', checkedAt: now.toISOString() } };
  let downloads = 0, searches = 0;
  const options = { now, openTab: false, download: async () => { downloads++; throw missing(); }, discover: async () => { searches++; return null; } };
  const record = await processCourse(snapshot, 1600002, options);
  assert.equal(record.status, 'none');
  assert.equal(record.topicId, undefined);
  assert.equal(downloads, 1);
  assert.equal(searches, 1, 'a missing overview does not establish that no syllabus exists');
  await processCourse(snapshot, 1600002, options);
  assert.equal(downloads, 1);
  assert.equal(searches, 1);
  await processCourse(snapshot, 1600002, { ...options, force: true });
  assert.equal(downloads, 2, 'manual retry bypasses the missing-file cache');
  assert.equal(searches, 2);
  await processCourse(snapshot, 1600002, { ...options, now: new Date(now.getTime() + 25 * 60 * 60_000) });
  assert.equal(downloads, 3, 'missing files are rechecked automatically after a day');
  assert.equal(searches, 3);
});

test('an unavailable overview falls through to the rendered navigation syllabus', async () => {
  const { snapshot } = setup();
  const requests = [];
  const record = await processCourse(snapshot, 1600002, { now, force: true,
    discover: async () => ({ id: 'tab:99', title: 'Syllabus', fileUrl: '/d2l/api/le/1.96/1600002/content/topics/99/file' }),
    download: async (path, options) => { requests.push({ path, options }); if (path.endsWith('/attachment')) throw missing(); return available; },
  });
  assert.equal(record.status, 'done', record.error);
  assert.equal(record.topicId, 'tab:99');
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.options.refresh), 'Read again requests fresh bytes');
});

test('a missing candidate falls through to another Content candidate before opening navigation', async () => {
  const { snapshot, course } = setup();
  course.content = [{ id: 99, title: 'Course information', modulePath: [], fileUrl: '/course-information' }];
  const record = await processCourse(snapshot, 1600002, { now,
    discover: async () => { assert.fail('a readable alternative does not need navigation discovery'); },
    download: async (path) => { if (path.endsWith('/attachment')) throw missing(); return available; },
  });
  assert.equal(record.status, 'done');
  assert.equal(record.topicId, 99);
});

test('permission errors and unfinished discovery remain failures and keep the previous syllabus', async () => {
  for (const status of [403, 404]) {
    const { stored, snapshot } = setup();
    const previous = { status: 'done', courseId: 1600002, topicId: 'overview', pages: SYLLABUS_PAGES, deadlines: [] };
    stored.syllabi = { 1600002: previous };
    let searches = 0;
    const record = await processCourse(snapshot, 1600002, { now, force: true,
      download: async () => { throw Object.assign(new Error(`HTTP ${status}`), { status }); },
      discover: async () => { searches++; throw new Error('The course navigation did not finish loading.'); },
    });
    assert.equal(record.status, 'error');
    assert.deepEqual(record.previous, previous);
    assert.equal(searches, status === 403 ? 0 : 1);
    assert.match(record.error, status === 403 ? /403/ : /did not finish loading/);
  }
});

test('an explicitly selected missing file is not silently replaced', async () => {
  const { snapshot, course } = setup();
  course.content = [{ id: 99, title: 'Chosen file', modulePath: [], fileUrl: '/chosen-file' }];
  await chooseSyllabus(1600002, '99');
  const record = await processCourse(snapshot, 1600002, { now, force: true,
    download: async () => { throw missing(); }, discover: async () => assert.fail('respect the explicit choice'),
  });
  assert.equal(record.status, 'error');
  assert.equal(record.chosen, true);
  assert.match(record.error, /selected file is no longer available/);
});

test('one automatic pass checks every current course and continues past a course without a syllabus', async () => {
  const { stored, snapshot } = setup();
  const searches = [];
  const statuses = [];
  const records = await processCurrentSyllabi(snapshot, { now, openTab: false,
    onStatus: (status) => statuses.push(status),
    download: async (path) => { if (path.endsWith('/attachment')) throw missing(); return available; },
    discover: async (courseId) => { searches.push(courseId); return null; },
  });
  assert.equal(records.length, 2);
  assert.equal(stored.syllabi[1600001].status, 'done');
  assert.equal(stored.syllabi[1600002].status, 'none');
  assert.deepEqual(searches, [1600002]);
  assert.ok(statuses.some((s) => /Syllabi 2 of 2/.test(s)));
  assert.equal(stored.syllabi[412690], undefined, 'inactive courses stay excluded');
});

test('a failed lookup for one current course does not prevent discovery of the next course', async () => {
  const { stored, snapshot } = setup();
  snapshot.data[0].content = [];
  snapshot.data[1].overview = null;
  const visited = [];
  await processCurrentSyllabi(snapshot, { now, openTab: false,
    discover: async (id) => { visited.push(id); if (id === 1600001) throw new Error('Navigation did not finish loading'); return { id: 'tab:99', title: 'Syllabus', text: SYLLABUS_PAGES.map((p) => p.text).join('\n') }; },
  });
  assert.deepEqual(visited, [1600001, 1600002]);
  assert.equal(stored.syllabi[1600001].status, 'error');
  assert.equal(stored.syllabi[1600002].status, 'done');
});

test('Read again refreshes a navigation syllabus before trying a weaker overview candidate', async () => {
  const { snapshot, course } = setup();
  course.syllabusTab = { id: 'tab:98', title: 'Syllabus', fileUrl: '/old-navigation-file' };
  const requests = [];
  const record = await processCourse(snapshot, 1600002, { now, force: true,
    discover: async () => ({ id: 'tab:99', title: 'Syllabus', fileUrl: '/current-navigation-file' }),
    download: async (path) => { requests.push(path); return available; },
  });
  assert.deepEqual(requests, ['/current-navigation-file']);
  assert.equal(record.topicId, 'tab:99');
});
