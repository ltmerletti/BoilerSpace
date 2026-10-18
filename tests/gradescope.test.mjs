import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentGradescopeCourse, gradescopeAssignments, gradescopeDate, gradescopeDocuments, linkGradescopeCourse, parseGradescopeAssignments, parseGradescopeCourses } from '../extension/lib/gradescope.js';
import { createGradescopeSync, fetchGradescopePage } from '../extension/lib/gradescope-sync.js';
import { agendaItems, calendarEvents } from '../extension/lib/planner.js';
import { ask, createTools } from '../extension/lib/agent.js';
import { snapshotFixture } from './helpers.mjs';

const NOW = new Date('2026-10-18T16:00:00Z');
const account = `<div class="courseList"><div class="courseList--term">Fall 2026</div><div class="courseList--coursesForTerm">
<a class="courseBox" href="/courses/20"><h3 class="courseBox--shortname">CS 25200</h3><div class="courseBox--name">Systems Programming</div><div class="courseBox--grades">SCORE_SECRET_84</div></a>
<a class="courseBox" href="/courses/21"><h3 class="courseBox--shortname">OTHER 10100</h3><div class="courseBox--name">Independent course</div></a>
</div><div class="courseList--term">Fall 2025</div><div class="courseList--coursesForTerm"><a class="courseBox" href="/courses/19"><h3 class="courseBox--shortname">Old course</h3></a></div></div>`;
const assignments = `<table id="assignments-student-table"><thead><tr><th>Name</th><th>Status</th><th>Due</th></tr></thead><tbody>
<tr><th><a href="/courses/20/assignments/51/submissions/PRIVATE_SUBMISSION_ID">Lab 8</a></th><td class="submissionStatus"><div class="submissionStatus--score">SCORE_SECRET_84 / 100</div><script>privateScore = 'SCORE_SECRET_84'</script></td><td>
<time class="submissionTimeChart--releaseDate" datetime="2026-10-14 09:30:00 -0400">Released</time>
<time class="submissionTimeChart--dueDate" datetime="2026-10-19 17:30:00 -0400">Due</time>
<time class="submissionTimeChart--dueDate" aria-label="Late Due Date at October 20" datetime="2026-10-20 17:30:00 -0400">Late deadline</time></td></tr>
<tr><th>Checkpoint 3</th><td class="submissionStatus"><div class="submissionStatus--score">SCORE_SECRET_84</div></td><td></td></tr>
</tbody></table>`;
const course = linkGradescopeCourse(parseGradescopeCourses(account)[0], snapshotFixture().courses);
const saved = () => ({ generation: 'fixture', status: 'done', courses: [{ ...course, assignments: parseGradescopeAssignments(assignments, course) }] });

function installStorage() {
  const data = { snapshot: snapshotFixture() };
  globalThis.chrome = {
    permissions: { contains: async () => true },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => Object.assign(data, structuredClone(values)),
      remove: async key => { delete data[key]; },
    } },
    tabs: { create: () => { throw new Error('No automatic tabs'); } },
  };
  return data;
}

test('Gradescope parsing reads only names, canonical links and correctly zoned dates', () => {
  const courses = parseGradescopeCourses(account);
  assert.equal(courses.length, 3);
  assert.equal(courses[0].term, 'Fall 2026');
  const items = parseGradescopeAssignments(assignments, course);
  assert.equal(items[0].key, 'gradescope:20:51');
  assert.equal(items[0].url, 'https://www.gradescope.com/courses/20/assignments/51');
  assert.equal(items[0].dueAt, '2026-10-19T21:30:00.000Z');
  assert.equal(items[0].lateDueAt, '2026-10-20T21:30:00.000Z');
  assert.equal(items[1].dueAt, null);
  assert.ok(!JSON.stringify([courses, items]).includes('SCORE_SECRET'));
  assert.ok(!JSON.stringify(items).includes('PRIVATE_SUBMISSION_ID'));
  assert.equal(gradescopeDate('2026-11-08 23:59:00 -0500'), '2026-11-09T04:59:00.000Z');
  assert.equal(gradescopeDate('Oct 8 at 5 PM'), null);
  assert.equal(gradescopeDate('2026-02-30 15:00:00 -0400'), null);
});

test('missing tables fail rather than silently replacing saved data with an empty list', () => {
  assert.throws(() => parseGradescopeCourses('<h1>Sign in</h1>'), /course list/);
  assert.throws(() => parseGradescopeAssignments('<h1>Unavailable</h1>', course), /Saved assignments/);
  assert.deepEqual(parseGradescopeAssignments('<table id="assignments-student-table"><tbody><tr><td class="dataTables_empty">No assignments</td></tr></tbody></table>', course), []);
});

test('course matching uses codes, preserves overrides and limits term imports', () => {
  assert.equal(course.courseId, 1600001);
  const manual = { ...course, courseId: null, linkOrigin: 'manual' };
  assert.equal(linkGradescopeCourse(manual, snapshotFixture().courses).courseId, null);
  assert.ok(currentGradescopeCourse(course, [], NOW));
  assert.ok(!currentGradescopeCourse({ ...course, term: 'Fall 2025' }, [], NOW));
});

test('agenda includes Gradescope dates, leaves missing dates out and deduplicates only exact matches', () => {
  const snapshot = snapshotFixture(), data = saved();
  assert.equal(agendaItems(snapshot, {}, {}, data).filter(item => item.source === 'gradescope').length, 1);
  snapshot.data[0].assignments.push({ ...data.courses[0].assignments[0], id: 999, kind: 'assignment', courseId: 1600001 });
  assert.equal(agendaItems(snapshot, {}, {}, data).filter(item => item.title === 'Lab 8').length, 1);
  snapshot.data[0].assignments.at(-1).dueAt = '2026-10-19T22:30:00.000Z';
  assert.equal(agendaItems(snapshot, {}, {}, data).filter(item => item.title === 'Lab 8').length, 2);
  data.courses[0].courseId = null;
  const unlinked = agendaItems(snapshot, {}, {}, data).find(item => item.source === 'gradescope');
  assert.equal(unlinked.courseName, 'CS 25200');
  assert.ok(calendarEvents(snapshot, {}, {}, data).some(event => event.title.startsWith('CS 25200: Lab 8')));
});

test('Ask lists, searches and cites Gradescope metadata without scores or submissions', async () => {
  const snapshot = snapshotFixture(), gradescope = saved();
  const tools = createTools({ snapshot, gradescope, now: NOW });
  const listing = await tools.run('list_gradescope_assignments', {});
  assert.equal(listing.total, 2);
  assert.match(listing.items[0].due_display, /Mon, Oct 19, 2026/);
  assert.equal(listing.items[1].due_display, null);
  assert.match(listing.items[0].late_due_display, /Tue, Oct 20/);
  assert.equal((await tools.run('get_item', { item_key: listing.items[0].item_key })).title, 'Lab 8');
  const search = await tools.run('search_course_material', { query: 'Lab 8', course_id: 1600001 });
  assert.ok(search.results.some(item => item.item_key === 'gradescope:20:51'));
  assert.ok(!JSON.stringify([listing, search, gradescopeDocuments(gradescope)]).includes('SCORE_SECRET'));
  let turn = 0;
  const result = await ask({ question: 'When is Lab 8 due on Gradescope?', snapshot, syllabi: {}, reviews: {}, gradescope, now: NOW,
    complete: async request => {
      if (!turn++) return { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'list_gradescope_assignments', arguments: '{}' } }] };
      assert.ok(!JSON.stringify(request.messages).includes('SCORE_SECRET'));
      return { role: 'assistant', content: 'Lab 8 is due Monday, October 19, at 5:30 PM ET. [S1]' };
    },
  });
  assert.equal(result.citations[0].url, 'https://www.gradescope.com/courses/20/assignments/51');
});

test('a complete sync stores only sanitized metadata and survives a background restart', async () => {
  const data = installStorage();
  try {
    const read = async path => path === '/account' ? account : assignments;
    await createGradescopeSync(read, () => NOW)({ action: 'connect' });
    assert.equal(data.gradescope.courses.length, 2);
    assert.equal(data.gradescope.courses[0].courseId, 1600001);
    assert.equal(data.gradescope.status, 'done');
    assert.ok(!JSON.stringify(data.gradescope).includes('SCORE_SECRET'));
    await createGradescopeSync(read, () => NOW)({ action: 'sync', force: true });
    assert.equal(data.gradescope.courses[0].assignments.length, 2);
  } finally { delete globalThis.chrome; }
});

test('transient course failures preserve assignments without asking for another sign-in', async () => {
  const data = installStorage(); data.gradescope = saved();
  try {
    const run = createGradescopeSync(async path => { if (path === '/account') return account; throw new Error('Temporary server failure'); }, () => NOW);
    await run({ action: 'sync', force: true });
    assert.equal(data.gradescope.status, 'error');
    assert.equal(data.gradescope.needsReconnect, false);
    assert.equal(data.gradescope.courses[0].assignments.length, 2);
  } finally { delete globalThis.chrome; }
});

test('authentication failure preserves saved assignments and marks reconnection', async () => {
  const data = installStorage(); data.gradescope = saved();
  try {
    await createGradescopeSync(async () => { throw Object.assign(new Error('Sign in'), { needsReconnect: true }); }, () => NOW)({ action: 'sync', force: true });
    assert.equal(data.gradescope.needsReconnect, true);
    assert.equal(data.gradescope.courses[0].assignments.length, 2);
  } finally { delete globalThis.chrome; }
});

test('a slow sync cannot resurrect data cleared during its request', async () => {
  const data = installStorage(); data.gradescope = saved();
  try {
    const run = createGradescopeSync(async () => { delete data.gradescope; return account; }, () => NOW);
    await assert.rejects(run({ action: 'sync', force: true }), /cancelled/);
    assert.equal(data.gradescope, undefined);
  } finally { delete globalThis.chrome; }
});

test('disconnect works after permission is revoked and refreshes deduplicate', async () => {
  const data = installStorage();
  try {
    let calls = 0;
    const run = createGradescopeSync(async path => { calls++; return path === '/account' ? account : assignments; }, () => NOW);
    const first = run({ action: 'connect' });
    assert.equal(first, run({ action: 'connect' }));
    await first;
    assert.equal(calls, 3);
    await run({ action: 'sync' });
    assert.equal(calls, 3, 'opening the panel again does not refetch fresh lists');
    chrome.permissions.contains = async () => false;
    await run({ action: 'disconnect' });
    assert.equal(data.gradescope, undefined);
  } finally { delete globalThis.chrome; }
});

test('Gradescope transport only makes read requests and recognizes login without exposing page content', async () => {
  const requests = [];
  await fetchGradescopePage('/account', async (url, init) => { requests.push([url, init]); return new Response(account); });
  assert.equal(requests[0][1].credentials, 'include');
  assert.equal(requests[0][1].method, undefined);
  await assert.rejects(fetchGradescopePage('/courses/20/assignments/51/submissions/999'), /Only Gradescope course lists/);
  await assert.rejects(fetchGradescopePage('/account', async () => new Response('', { status: 401 })), error => error.needsReconnect === true);
  await assert.rejects(fetchGradescopePage('/account', async () => new Response('<form id="new_user" action="/login"></form>')), error => error.needsReconnect === true);
  await assert.rejects(fetchGradescopePage('/courses/20', async () => new Response('', { status: 403 })), error => !error.needsReconnect);
});


test('revoked access marks reconnect without losing saved assignments', async () => {
  const data = installStorage(); data.gradescope = saved();
  try {
    chrome.permissions.contains = async () => false;
    await assert.rejects(createGradescopeSync()({ action: 'sync' }), error => error.needsReconnect === true);
    assert.equal(data.gradescope.needsReconnect, true);
    assert.equal(data.gradescope.courses[0].assignments.length, 2);
  } finally { delete globalThis.chrome; }
});

test('Gradescope tool pagination covers long lists without dropping unlinked courses', async () => {
  const gradescope = saved(), source = gradescope.courses[0];
  source.courseId = null;
  source.assignments = Array.from({ length: 95 }, (_, index) => ({ ...source.assignments[0], key: `gradescope:20:${index}`, title: `Task ${index}` }));
  const tools = createTools({ snapshot: snapshotFixture(), gradescope });
  const first = await tools.run('list_gradescope_assignments', {});
  const second = await tools.run('list_gradescope_assignments', { offset: first.next_offset });
  const last = await tools.run('list_gradescope_assignments', { offset: second.next_offset });
  assert.equal(first.items.length, 40);
  assert.equal(second.items.length, 40);
  assert.equal(last.items.length, 15);
  assert.equal(last.next_offset, undefined);
  assert.equal(new Set([...first.items, ...second.items, ...last.items].map(item => item.item_key)).size, 95);
});


test('an uncited Gradescope answer gets one rewrite using only retrieved source ids', async () => {
  let calls = 0;
  const result = await ask({ question: 'When is Lab 8 due on Gradescope?', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, gradescope: saved(), now: NOW,
    complete: async request => {
      calls++;
      if (calls === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'list_gradescope_assignments', arguments: '{"query":"Lab 8"}' } }] };
      if (calls === 2) return { role: 'assistant', content: 'Lab 8 is due October 19 at 5:30 PM ET.' };
      assert.match(request.messages.at(-1).content, /no valid source citation/);
      assert.match(request.messages.at(-1).content, /Available Gradescope source ids: S1\./);
      return { role: 'assistant', content: 'Lab 8 is due October 19 at 5:30 PM ET. [S1]' };
    },
  });
  assert.equal(calls, 3);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0].url, 'https://www.gradescope.com/courses/20/assignments/51');
  assert.equal(result.trace.filter(entry => entry.type === 'commentary').length, 1, 'the superseded draft stays inside the work log');
});

test('citation repair is bounded and never fabricates a citation the model did not use', async () => {
  let calls = 0;
  const result = await ask({ question: 'When is Lab 8 due on Gradescope?', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, gradescope: saved(), now: NOW,
    complete: async () => ++calls === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'list_gradescope_assignments', arguments: '{}' } }] }
      : { role: 'assistant', content: 'Lab 8 is due October 19 at 5:30 PM ET.' },
  });
  assert.equal(calls, 3);
  assert.deepEqual(result.citations, []);
});

test('an empty Gradescope search does not trigger a citation rewrite', async () => {
  let calls = 0;
  const result = await ask({ question: 'When is the unavailable assignment due?', snapshot: snapshotFixture(), syllabi: {}, reviews: {}, gradescope: saved(), now: NOW,
    complete: async () => ++calls === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'list_gradescope_assignments', arguments: '{"query":"unavailable"}' } }] }
      : { role: 'assistant', content: 'No matching assignment is in the saved Gradescope list.' },
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.citations, []);
});
