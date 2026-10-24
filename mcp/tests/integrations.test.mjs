import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseDatabase } from '../lib/database.mjs';
import { CourseService, sourcesFromSnapshot } from '../lib/service.mjs';
import { Integrations } from '../lib/integrations.mjs';
import { readDiscussionSite } from '../../extension/lib/discussions-api.js';
import { Retrieval } from '../lib/retrieval.mjs';
import { seed, noSemantics, waitJob } from './fixtures.mjs';

function fixture() {
  const database = new CourseDatabase(':memory:');
  const snapshot = seed(database);
  snapshot.courses[0].name = 'Fall 2026 CS 25000'; snapshot.courses[0].code = 'wl.202710.CS.25000.LE1';
  database.publish(snapshot, sourcesFromSnapshot(snapshot));
  let expired = false, version = 1, removed = false;
  const calls = [];
  const ed = { edToken: async () => 'synthetic-token', logout: async () => {}, fetch: async value => {
    const url = new URL(value); calls.push(url.pathname + url.search);
    if (expired) return Response.json({}, { status: 401 });
    if (url.pathname === '/api/user') return Response.json({ courses: [{ course: { id: 9, code: 'CS 250', name: 'CS 250', status: 'active' } }] });
    if (url.pathname.includes('/threads?') || url.pathname.includes('/courses/')) {
      const offset = Number(url.searchParams.get('offset'));
      const all = Array.from({ length: 75 }, (_, index) => ({ id: index + 1, number: index + 1, title: `Thread ${index + 1}`, updated_at: `version-${version}`, is_private: index === 74 }));
      return Response.json({ threads: all.filter(thread => !removed || thread.id !== 1).slice(offset, offset + 30) });
    }
    const id = Number(url.pathname.split('/').at(-1));
    return Response.json({ thread: { id, course_id: 9, number: id, title: `Thread ${id}`, content: id === 1 ? 'long public text '.repeat(1000) + 'END_OF_POST' : `Public topic ${id}`, user_id: 2,
      updated_at: `version-${version}`, answers: id === 1 ? Array.from({ length: 35 }, (_, index) => ({ id: index + 100, content: `Instructor reply ${index} calibrationmarker`, user_id: 2, is_endorsed: true })) : [], comments: [] },
      users: [{ id: 2, course_role: 'admin', email: 'EXCLUDED_ACCOUNT_EMAIL' }] });
  } };
  const integrations = new Integrations(database, '/unused', { sessions: { ed }, reader: (args, dependencies) => readDiscussionSite(args, { ...dependencies, sleep: async () => {} }) });
  const service = new CourseService(database, {}, { integrations, retrieval: noSemantics });
  return { database, service, integrations, calls, snapshot, expire: value => { expired = value; }, change: () => { version++; removed = true; },
    close: async () => { await service.close(); database.close(); } };
}

test('the standalone imports every public Ed page, retains reply roles, and exposes all text through continuations', async () => {
  const f = fixture();
  try {
    const job = await waitJob(f.database, f.service.connectIntegration({ platform: 'ed' }).id);
    assert.equal(job.state, 'completed');
    const source = f.database.get('discussions').sources[0];
    assert.equal(source.courseId, 101);
    assert.equal(source.threads.length, 74);
    assert.equal(source.historyComplete, true);
    assert.ok(f.calls.some(url => url.includes('offset=60')));
    assert.equal(source.threads[0].role, 'instructor');
    assert.equal(source.threads.find(thread => thread.id === '1').replies.length, 35);
    assert.ok(!JSON.stringify(f.database.get('discussions')).includes('EXCLUDED_ACCOUNT_EMAIL'));
    const { callTool, toolRegistry } = await import('../lib/tools.mjs');
    const tools = toolRegistry(f.service);
    const first = await callTool(tools, 'read_discussion', { discussion_key: 'ed:9:1' });
    assert.equal(first.text_truncated, true);
    assert.equal(first.replies.length, 30);
    const lastText = await callTool(tools, 'read_discussion', { discussion_key: 'ed:9:1', offset: first.next_offset });
    assert.match(lastText.text, /END_OF_POST/);
    const lastReplies = await callTool(tools, 'read_discussion', { discussion_key: 'ed:9:1', reply_offset: first.next_reply_offset });
    assert.equal(lastReplies.replies.length, 5);
    const reply = await callTool(tools, 'read_discussion', { discussion_key: 'ed:9:1', reply_id: '134' });
    assert.equal(reply.author_role, 'instructor'); assert.equal(reply.endorsed, true);
    assert.ok(reply.sources.every(source => source.url.startsWith('https://edstem.org/us/courses/9/discussion/')));
    const retrieval = new Retrieval(f.database, { enabled: false });
    f.service.retrieval = retrieval;
    const result = await callTool(tools, 'search_course_material', { query: 'calibrationmarker', source_id: 'ed:9', course_id: 101 });
    assert.ok(result.results.length > 0);
    assert.ok(result.results.every(hit => hit.discussion_key === 'ed:9:1'));
    assert.ok(result.results.some(hit => hit.read_targets[0].reply_id !== null));
  } finally { await f.close(); }
});

test('authentication failure keeps posts, then a resumed import updates and removes withdrawn evidence', async () => {
  const f = fixture();
  try {
    await waitJob(f.database, f.service.connectIntegration({ platform: 'ed' }).id);
    const before = f.database.search('END_OF_POST')[0];
    assert.ok(before);
    f.expire(true);
    const failed = await waitJob(f.database, f.service.connectIntegration({ platform: 'ed', sourceIds: ['ed:9'] }).id);
    assert.equal(failed.state, 'failed'); assert.equal(failed.error.code, 'sign-in-required');
    assert.equal(f.database.get('discussions').sources[0].threads.length, 74);
    f.expire(false); f.change();
    assert.equal((await waitJob(f.database, f.service.retry(failed.id).id)).state, 'completed');
    assert.equal(f.database.get('discussions').sources[0].threads.length, 73);
    assert.equal(f.database.source(before.source.sourceId), null);
    assert.equal(f.database.search('END_OF_POST').length, 0);
    await f.integrations.disconnect('ed');
    assert.equal(f.database.sources(null, 'discussion').length, 0);
  } finally { await f.close(); }
});

test('Gradescope imports only names and dates, keeps late deadlines separate, and joins upcoming work', async () => {
  const f = fixture();
  const account = '<div class="courseList"><div class="courseList--term">Fall 2026</div><div class="courseList--coursesForTerm"><a class="courseBox" href="/courses/19"><span class="courseBox--shortname">CS 250</span><span class="courseBox--name">Architecture</span></a></div></div>';
  const assignments = `<table id="assignments-student-table"><tbody><tr><th><a href="/courses/19/assignments/44">Cache lab</a></th><td class="submissionStatus"><div class="submissionStatus--score">EXCLUDED_SCORE</div>EXCLUDED_SUBMISSION</td><td>
    <time class="submissionTimeChart--dueDate" datetime="2026-10-30 18:00:00 -0400"></time><time aria-label="Late" datetime="2026-11-01 18:00:00 -0400"></time></td></tr></tbody></table>`;
  f.integrations.sessions.gradescope = { fetch: async url => new Response(url.endsWith('/account') ? account : assignments), logout: async () => {} };
  try {
    assert.equal((await waitJob(f.database, f.service.connectIntegration({ platform: 'gradescope' }).id)).state, 'completed');
    const { callTool, toolRegistry } = await import('../lib/tools.mjs');
    const tools = toolRegistry(f.service);
    const result = await callTool(tools, 'list_gradescope_assignments', { course_id: 101 });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].title, 'Cache lab');
    assert.ok(!JSON.stringify([result, f.database.get('gradescope'), f.database.search('Cache')]).includes('EXCLUDED_'));
    const saved = f.database.get('gradescope').courses[0].assignments[0];
    assert.notEqual(saved.dueAt, saved.lateDueAt);
    const upcoming = await callTool(tools, 'list_upcoming', { days: 120 });
    assert.ok(upcoming.items.some(item => item.platform === 'Gradescope' && item.title === 'Cache lab'));
    await f.integrations.link({ platform: 'gradescope', sourceId: 'gradescope:19', courseId: null });
    const unlinked = await callTool(tools, 'list_gradescope_assignments', {});
    assert.equal(unlinked.items.length, 1); assert.equal(unlinked.courses[0].brightspace_course_id, null);
  } finally { await f.close(); }
});

test('unlinked discussion courses remain searchable by their source and survive Brightspace refresh', async () => {
  const f = fixture();
  try {
    await waitJob(f.database, f.service.connectIntegration({ platform: 'ed' }).id);
    await f.integrations.link({ platform: 'ed', sourceId: 'ed:9', courseId: null });
    f.database.publish(f.snapshot, sourcesFromSnapshot(f.snapshot));
    assert.equal(f.database.sources(null, 'discussion').length, 74);
    assert.equal(f.database.search('calibrationmarker', { integrationId: 'ed:9' }).length, 10);
    assert.equal(f.database.search('calibrationmarker', { courseId: 101 }).length, 0);
    assert.equal(f.database.search('calibrationmarker', { integrationId: 'piazza:other' }).length, 0);
  } finally { await f.close(); }
});

test('Piazza imports all feed pages through its read-only POST API and excludes private replies', async () => {
  const f = fixture(), calls = [];
  let throttled = false;
  f.integrations.sessions.piazza = { logout: async () => {}, fetch: async (url, options = {}) => {
    if (!options.body) return new Response('<meta name="csrf_token" content="synthetic-csrf">');
    const { method, params } = JSON.parse(options.body); calls.push({ method, ...params });
    if (method === 'user.status') return Response.json({ result: { networks: [{ id: 'synthetic250', course_number: 'CS 250' }] } });
    if (method === 'network.get_my_feed') return Response.json({ result: { more: params.offset + params.limit < 65,
      feed: Array.from({ length: 65 }, (_, nr) => ({ nr: nr + 1, version: 1 })).slice(params.offset, params.offset + params.limit) } });
    assert.equal(method, 'content.get');
    if (!throttled) { throttled = true; return Response.json({ error: 'too fast, please wait' }); }
    return Response.json({ result: { nr: Number(params.cid), tags: ['instructor-note'], history: [{ subject: `Post ${params.cid}`, content: 'Public Piazza clarification', uid: 'EXCLUDED_USER' }],
      children: [{ id: 'answer', type: 'i_answer', history: [{ content: 'Instructor evidence' }] }, { id: 'private', is_private: true, history: [{ content: 'EXCLUDED_PRIVATE' }] }] } });
  } };
  try {
    assert.equal((await waitJob(f.database, f.service.connectIntegration({ platform: 'piazza' }).id)).state, 'completed');
    const source = f.database.get('discussions').sources[0];
    assert.equal(source.threads.length, 65); assert.equal(source.historyComplete, true);
    assert.ok(calls.some(call => call.method === 'network.get_my_feed' && call.offset === 60));
    assert.ok(source.threads.every(thread => thread.replies.length === 1 && thread.replies[0].role === 'instructor'));
    assert.ok(!JSON.stringify(source).includes('EXCLUDED_'));
    assert.equal(f.database.search('clarification', { integrationId: 'piazza:synthetic250' }).length, 10);
  } finally { await f.close(); }
});

test('workers serialize the shared discussion checkpoint while allowing a separate Gradescope import', () => {
  const database = new CourseDatabase(':memory:');
  try {
    const ed = database.enqueue('integration', { platform: 'ed' });
    const piazza = database.enqueue('integration', { platform: 'piazza' });
    const gradescope = database.enqueue('integration', { platform: 'gradescope' });
    assert.equal(database.claim('one').id, ed.id);
    assert.equal(database.claim('two').id, gradescope.id);
    assert.equal(database.claim('three'), null);
    database.finish(ed.id, 'one', 'completed');
    assert.equal(database.claim('three').id, piazza.id);
  } finally { database.close(); }
});

test('an old import cannot overwrite a changed integration or restore it after disconnect', async () => {
  const f = fixture();
  try {
    await waitJob(f.database, f.service.connectIntegration({ platform: 'ed' }).id);
    const old = f.database.get('discussions');
    await f.integrations.link({ platform: 'ed', sourceId: 'ed:9', courseId: null });
    await assert.rejects(f.integrations.storage.compareAndSet('discussions', old.generation, old), { code: 'integration-changed' });
    assert.equal(f.database.get('discussions').sources[0].courseId, null);
    const linked = f.database.get('discussions');
    await f.integrations.disconnect('ed');
    await assert.rejects(f.integrations.storage.compareAndSet('discussions', linked.generation, linked), { code: 'integration-changed' });
    assert.equal(f.database.sources(null, 'discussion').length, 0);
  } finally { await f.close(); }
});
