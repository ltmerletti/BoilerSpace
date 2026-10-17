import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscussionUrl, matchDiscussionCourse, reconcileDiscussionCourse, normalizeEdThread, normalizePiazzaThread, discussionDocuments } from '../extension/lib/discussions.js';
import { createTools } from '../extension/lib/agent.js';
import { snapshotFixture } from './helpers.mjs';

const source = { ...parseDiscussionUrl('https://edstem.org/us/courses/123/discussion/456'), name: 'CS 25200', courseId: 1600001 };
const edPayload = () => ({
  users: [{ id: 1, name: 'Private Student Name', email: 'student@example.test', course_role: 'student' }, { id: 2, name: 'Private Staff Name', course_role: 'staff' }],
  thread: { id: 456, course_id: 123, user_id: 1, number: 7, title: 'Project clarification', content: '<document><paragraph>When is the report due?</paragraph></document>', created_at: '2026-10-12T12:00:00Z', updated_at: '2026-10-13T12:00:00Z', answers: [
    { id: 11, user_id: 2, content: '<paragraph>The report is due Friday.</paragraph>', is_endorsed: true, comments: [{ id: 12, user_id: 1, content: 'Thanks.' }, { id: 13, is_private: true, content: 'Private reply' }] },
  ], comments: [{ id: 14, deleted_at: '2026-10-12', content: 'Deleted reply' }] },
});

test('discussion URLs are canonical and reject unrelated sites and schemes', () => {
  assert.equal(source.url, 'https://edstem.org/us/courses/123/discussion');
  assert.deepEqual(parseDiscussionUrl('https://piazza.com/class/course123?cid=5#x'), { id: 'piazza:course123', platform: 'piazza', remoteId: 'course123', url: 'https://piazza.com/class/course123' });
  for (const url of ['http://piazza.com/class/x', 'https://piazza.com.evil.test/class/x', 'https://edstem.org/au/courses/1', 'https://someone@piazza.com/class/x', 'javascript:alert(1)']) assert.throws(() => parseDiscussionUrl(url));
});

test('Ed course codes match only one current Brightspace course', () => {
  const courses = snapshotFixture().courses;
  assert.equal(matchDiscussionCourse({ code: 'wl.202710.CS.25200.LE1', name: 'Discussion' }, courses), 1600001);
  assert.equal(matchDiscussionCourse({ name: 'Fall 2026 MA 26500 - Merge' }, courses), 1600002);
  assert.equal(matchDiscussionCourse({ name: 'CS 18000' }, courses), null, 'archived enrollments are not linked');
  assert.equal(matchDiscussionCourse({ name: 'TDM 10100-10200 (2025-26)' }, courses), null);
  assert.equal(matchDiscussionCourse({ name: 'CS 25200' }, [...courses, { ...courses[0], id: 999 }]), null, 'ambiguous mappings stay unlinked');
});

test('Ed normalization retains staff replies but omits author identities and private content', () => {
  const thread = normalizeEdThread(edPayload(), source);
  assert.equal(thread.url, 'https://edstem.org/us/courses/123/discussion/456');
  assert.equal(thread.text, 'When is the report due?');
  assert.deepEqual(thread.replies.map((r) => r.role), ['instructor', 'student']);
  assert.equal(thread.replies[0].endorsed, true);
  assert.ok(!/Private|example.test|user_id|Deleted reply/.test(JSON.stringify(thread)));
  assert.equal(normalizeEdThread({ ...edPayload(), thread: { ...edPayload().thread, course_id: 999 } }, source), null);
  assert.equal(normalizeEdThread({ ...edPayload(), thread: { ...edPayload().thread, is_private: true } }, source), null);
});

test('course matching recognizes compact codes and unique fuzzy titles while refusing old terms and ambiguous sections', () => {
  const courses = [
    { id: 1, current: true, code: 'wl.202620.CS.25000.LE1', name: 'Fall 2026 CS 25000 Computer Architecture' },
    { id: 2, current: true, code: 'wl.202620.CS.25100.LE1', name: 'Fall 2026 CS 25100 Data Structures' },
  ];
  for (const name of ['CS250', 'CS_25000', 'CS-250', 'Computer architecture', 'Computer architectre']) assert.equal(matchDiscussionCourse({ name }, courses), 1, name);
  assert.equal(matchDiscussionCourse({ name: 'CS251 discussion' }, courses), 2);
  for (const name of ['Fall 2025 CS250', 'CS250 2025', 'Spring 2026 CS250', 'Computer', 'CS259', 'CS250 / CS251']) assert.equal(matchDiscussionCourse({ name }, courses), null, name);
  assert.equal(matchDiscussionCourse({ name: 'Computer architecture' }, [...courses, { ...courses[0], id: 3 }]), null);
  const manual = { name: 'CS250', courseId: null, linkOrigin: 'manual' };
  reconcileDiscussionCourse(manual, courses);
  assert.equal(manual.courseId, null, 'explicitly separate courses stay separate');
  const automatic = { name: 'Piazza course', courseId: null, linkOrigin: 'automatic' };
  reconcileDiscussionCourse(automatic, courses);
  automatic.name = 'CS250';
  reconcileDiscussionCourse(automatic, courses);
  assert.equal(automatic.courseId, 1, 'newly discovered metadata repairs an earlier unmatched connection');
});

test('Piazza normalization separates instructor and student answers and preserves source links', () => {
  const piazza = { ...parseDiscussionUrl('https://piazza.com/class/example123'), name: 'Separate course', courseId: null };
  const thread = normalizePiazzaThread({ nr: 5, id: 'post5', created: '2026-10-12T12:00:00Z', tags: ['instructor-note'], history: [{ subject: 'Office hours', content: '<p>Moved to Friday.</p>', uid: 'private-user' }], children: [
    { id: 'a1', type: 'i_answer', history: [{ content: '<p>At 2 PM.</p>' }] },
    { id: 'a2', type: 's_answer', tag_good: ['student-like'], history: [{ content: 'I think 3 PM.' }] },
    { id: 'a3', is_private: true, history: [{ content: 'Private message' }] },
  ] }, piazza);
  assert.equal(thread.role, 'instructor');
  assert.equal(thread.url, 'https://piazza.com/class/example123?cid=5');
  assert.deepEqual(thread.replies.map((r) => r.role), ['instructor', 'student']);
  assert.equal(thread.replies[1].endorsed, false, 'student likes are not instructor endorsements');
  assert.ok(!JSON.stringify(thread).includes('private-user'));
  assert.ok(!JSON.stringify(thread).includes('Private message'));
});

test('discussion search respects course links and full reads cite the instructor reply', async () => {
  const thread = normalizeEdThread(edPayload(), source);
  const discussions = { sources: [{ ...source, status: 'done', threads: [thread] }, { ...source, id: 'piazza:old', platform: 'piazza', name: 'Older separate course', courseId: null, threads: [{ ...thread, key: 'piazza:old:1', title: 'Separate discussion', text: 'Notebook downtime', replies: [] }] }] };
  assert.equal(discussionDocuments(discussions).length, 2);
  const tools = createTools({ snapshot: snapshotFixture(), discussions });
  const hit = await tools.run('search_course_material', { query: 'report Friday', course_id: 1600001 });
  assert.ok(hit.results.some(result => result.discussion_key === thread.key));
  const wrongCourse = await tools.run('search_course_material', { query: 'Notebook downtime', course_id: 1600002 });
  assert.equal(wrongCourse.results.length, 0);
  const all = await tools.run('list_discussions', {});
  assert.equal(all.courses.length, 2);
  assert.deepEqual(all.courses.map(course => course.source_id), ['ed:123', 'piazza:old']);
  const read = await tools.run('read_discussion', { discussion_key: thread.key });
  assert.equal(read.replies[0].author_role, 'instructor');
  assert.equal(tools.sources.get(read.replies[0].source).url, thread.url);
  assert.ok(!JSON.stringify(read).includes('Private Staff Name'));
});

test('both readers preserve long messages, more than 100 replies and deeply nested public comments', () => {
  const long = 'complete message '.repeat(3000);
  let edNested = { id: 'deep', content: 'Deep public Ed reply' };
  let piazzaNested = { id: 'deep', content: 'Deep public Piazza reply' };
  for (let i = 0; i < 20; i++) {
    edNested = { id: `nested-${i}`, content: 'Public comment', comments: [edNested] };
    piazzaNested = { id: `nested-${i}`, content: 'Public comment', children: [piazzaNested] };
  }
  const payload = edPayload();
  payload.thread.content = long;
  payload.thread.answers = Array.from({ length: 120 }, (_, i) => ({ id: i, content: i === 119 ? long : `Reply ${i}` }));
  payload.thread.comments = [edNested, { id: 'private-parent', is_private: true, comments: [{ id: 'hidden-child', content: 'Hidden descendant' }] }];
  const ed = normalizeEdThread(payload, source);
  assert.equal(ed.text, long.trim());
  assert.equal(ed.replies.length, 141);
  assert.equal(ed.replies[119].text, long.trim());
  assert.equal(ed.replies.at(-1).text, 'Deep public Ed reply');
  assert.ok(!JSON.stringify(ed).includes('Hidden descendant'));
  const piazza = normalizePiazzaThread({ nr: 1, history: [{ content: long }], children: [
    ...Array.from({ length: 120 }, (_, i) => ({ id: i, content: i === 119 ? long : `Reply ${i}` })),
    piazzaNested, { status: 'private', children: [{ content: 'Hidden descendant' }] },
  ] }, { ...source, platform: 'piazza' });
  assert.equal(piazza.text, long.trim());
  assert.equal(piazza.replies.length, 141);
  assert.equal(piazza.replies[119].text, long.trim());
  assert.equal(piazza.replies.at(-1).text, 'Deep public Piazza reply');
  assert.ok(!JSON.stringify(piazza).includes('Hidden descendant'));
});

test('discussion reads page every reply and continue long messages without gaps or changing citations', async () => {
  const thread = { ...normalizeEdThread(edPayload(), source), text: 'Post text. '.repeat(4000),
    replies: Array.from({ length: 105 }, (_, i) => ({ id: String(i), role: 'instructor', text: `Reply ${i}. `.repeat(5000), endorsed: i === 104 })) };
  const tools = createTools({ snapshot: snapshotFixture(), discussions: { sources: [{ ...source, threads: [thread] }] } });
  const read = (args = {}) => tools.run('read_discussion', { discussion_key: thread.key, ...args });
  let page = await read(), text = page.text;
  const postSource = page.source;
  assert.equal(page.next_reply_offset, 30);
  assert.ok(JSON.stringify(page).length < 32_000, 'long replies do not inflate the tool response');
  while (page.next_offset !== null) {
    page = await read({ offset: page.next_offset });
    assert.equal(page.source, postSource);
    assert.equal(page.replies, undefined, 'post continuations do not repeat the reply previews');
    text += page.text;
  }
  assert.equal(text, thread.text);
  const ids = [];
  page = await read();
  while (true) {
    ids.push(...page.replies.map(reply => reply.reply_id));
    if (page.next_reply_offset === null) break;
    page = await read({ reply_offset: page.next_reply_offset });
    assert.equal(page.text, undefined, 'reply pages do not repeat the original post');
  }
  assert.deepEqual(ids, thread.replies.map(reply => reply.id));
  const preview = page.replies.at(-1);
  assert.equal(preview.endorsed, true);
  text = preview.text;
  let next = preview.next_offset;
  while (next !== null) {
    const reply = await read({ reply_id: preview.reply_id, offset: next });
    assert.equal(reply.source, preview.source);
    assert.equal(reply.author_role, 'instructor');
    text += reply.text;
    next = reply.next_offset;
  }
  assert.equal(text, thread.replies.at(-1).text);
  assert.equal(tools.sources.get(preview.source).url, thread.url);
  assert.equal((await read({ reply_offset: 105 })).next_reply_offset, null);
  assert.equal((await read({ offset: thread.text.length })).next_offset, null);
});

test('discussion read continuations reject invalid offsets and unknown replies', async () => {
  const thread = normalizeEdThread(edPayload(), source);
  const tools = createTools({ snapshot: snapshotFixture(), discussions: { sources: [{ ...source, threads: [thread] }] } });
  for (const args of [{ offset: -1 }, { offset: 1.5 }, { offset: '0' }, { offset: thread.text.length + 1 }, { reply_offset: 100 }, { reply_id: 'missing' }, { reply_id: 11 }, { reply_id: '11', reply_offset: 0 }, { offset: 1, reply_offset: 1 }]) {
    assert.ok((await tools.run('read_discussion', { discussion_key: thread.key, ...args })).error, JSON.stringify(args));
  }
});
