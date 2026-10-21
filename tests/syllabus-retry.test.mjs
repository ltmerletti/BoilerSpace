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
  await processCurrentSyllabi(snapshot, { now, openTab: false, wait: async () => {},
    discover: async (id) => { visited.push(id); if (id === 1600001) throw new Error('Navigation did not finish loading'); return { id: 'tab:99', title: 'Syllabus', text: SYLLABUS_PAGES.map((p) => p.text).join('\n') }; },
  });
  assert.deepEqual(visited, [1600001, 1600002, 1600001], 'other courses finish before the failed course retries once');
  assert.equal(stored.syllabi[1600001].status, 'error');
  assert.equal(stored.syllabi[1600002].status, 'done');
});

test('an automatic pass recovers a temporary discovery failure without rereading a successful course', async () => {
  for (const message of ['NetworkError when attempting to fetch resource.', 'The syllabus document did not finish loading.', 'The syllabus tab was closed before it finished loading.', 'Could not establish connection. Receiving end does not exist.']) {
    const { stored, snapshot, course } = setup();
    course.overview = null;
    let searches = 0, downloads = 0;
    const records = await processCurrentSyllabi(snapshot, { now, openTab: false, wait: async () => {},
      discover: async () => {
        if (++searches === 1) throw new Error(message);
        return { id: 'tab:1600002:lti', title: 'Syllabus', text: SYLLABUS_PAGES.map((p) => p.text).join('\n') };
      },
      download: async () => { downloads++; return available; },
    });
    assert.ok(records.every((r) => r.status === 'done'), message);
    assert.equal(searches, 2, 'the retry bypasses the failed discovery cache');
    assert.equal(downloads, 1, 'the first course is not downloaded again');
    assert.equal(stored.syllabusSources[1600002].error, undefined);
    assert.equal(stored.syllabi[1600002].status, 'done');
  }
});

test('automatic and manual recovery both resolve a failed navigation source again', async () => {
  for (const force of [false, true]) {
    const { stored, snapshot, course } = setup();
    course.syllabusTab = { id: 'tab:old:lti', title: 'Syllabus', text: 'Stale source text.', updatedAt: null };
    stored.syllabi = { 1600002: { courseId: 1600002, status: 'error', topicId: 'tab:old:lti', error: 'Failed to fetch', updatedAt: null, checkedAt: now.toISOString() } };
    stored.syllabusSources = { 1600002: { topic: course.syllabusTab, readerVersion: 3, checkedAt: now.toISOString() } };
    let lookups = 0;
    const record = await processCourse(snapshot, 1600002, { force, now, openTab: false,
      discover: async () => { lookups++; return { id: 'tab:current:lti', title: 'Syllabus', text: SYLLABUS_PAGES.map((p) => p.text).join('\n') }; },
    });
    assert.equal(lookups, 1, `force=${force}: cached text is not a fresh navigation read`);
    assert.equal(record.status, 'done');
    assert.equal(record.topicId, 'tab:current:lti');
  }
});

test('a fresh automatic attempt bypasses a failed lookup and download just like Check again', async () => {
  const { stored, snapshot, course } = setup();
  course.overview = null;
  stored.syllabusSources = { 1600002: { error: 'Could not establish connection. Receiving end does not exist.', readerVersion: 3, checkedAt: now.toISOString() } };
  stored.syllabi = { 1600002: { status: 'error', topicId: 'tab:99', error: 'Failed to fetch', checkedAt: now.toISOString() } };
  let lookups = 0;
  const requests = [];
  const record = await processCourse(snapshot, 1600002, { now, openTab: false,
    discover: async () => { lookups++; return { id: 'tab:99', title: 'Syllabus', fileUrl: '/current-syllabus' }; },
    download: async (path, options) => { requests.push({ path, options }); return available; },
  });
  assert.equal(record.status, 'done');
  assert.equal(lookups, 1);
  assert.deepEqual(requests, [{ path: '/current-syllabus', options: { open: false, refresh: true, fileName: 'Syllabus' } }]);
});

test('an automatic download retry requests fresh bytes and bypasses the recent error record', async () => {
  const { snapshot } = setup();
  const requests = [];
  let failed = false;
  const records = await processCurrentSyllabi(snapshot, { now, openTab: false, wait: async () => {},
    discover: async () => null,
    download: async (path, options) => {
      requests.push({ path, options });
      if (path.endsWith('/attachment') && !failed) { failed = true; throw Object.assign(new Error('HTTP 503'), { status: 503 }); }
      return available;
    },
  });
  assert.ok(records.every((r) => r.status === 'done'));
  assert.equal(requests.length, 3);
  assert.equal(requests[2].options.refresh, true);
  assert.ok(requests[2].path.endsWith('/attachment'));
});

test('a temporary extraction failure retries once while successful courses keep their extracted facts', async () => {
  const { snapshot, stored } = setup();
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls === 1) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(MODEL_OUTPUT) } }] }));
  };
  const records = await processCurrentSyllabi(snapshot, { now, openTab: false, wait: async () => {}, download: async () => available });
  assert.ok(records.every((r) => r.status === 'done'));
  assert.equal(calls, 3, 'one failed model call, one other course, then the failed course succeeds');
  assert.equal(stored.syllabi[1600001].error, undefined);
});

test('automatic recovery is bounded and does not retry missing syllabi, permissions, or invalid model output', async () => {
  for (const message of [null, 'BoilerSpace needs access to purdue.simplesyllabus.com to read this syllabus.', 'HTTP 403', 'The model returned something that was not valid JSON.', 'NetworkError when attempting to fetch resource.']) {
    const { snapshot, course } = setup();
    snapshot.data[0].content = [];
    course.overview = null;
    let calls = 0;
    await processCurrentSyllabi(snapshot, { now, courseId: 1600002, openTab: false, wait: async () => {},
      discover: async () => { calls++; if (message) throw new Error(message); return null; },
    });
    assert.equal(calls, message?.startsWith('NetworkError') ? 2 : 1, message ?? 'no syllabus');
  }
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

test('the fixed reader automatically rechecks missing results cached by the old reader', async () => {
  const { stored, snapshot, course } = setup();
  course.overview = null;
  stored.syllabusSources = { 1600002: { topic: null, checkedAt: now.toISOString() } };
  stored.syllabi = { 1600002: { courseId: 1600002, status: 'none', checkedAt: now.toISOString() } };
  let lookups = 0;
  const options = { now, openTab: false, discover: async () => { lookups++; return { id: 'tab:1600002:lti', title: 'Syllabus', text: SYLLABUS_PAGES.map((p) => p.text).join('\n') }; } };
  assert.equal((await processCourse(snapshot, 1600002, options)).status, 'done');
  assert.equal(lookups, 1);
  assert.equal(stored.syllabusSources[1600002].readerVersion, 3);
  await processCourse(snapshot, 1600002, options);
  assert.equal(lookups, 1);
});
