import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiscussionUrl, matchDiscussionCourse, normalizeEdThread, normalizePiazzaThread, discussionDocuments } from '../extension/lib/discussions.js';
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
  assert.equal(hit.results[0].discussion_key, thread.key);
  const wrongCourse = await tools.run('search_course_material', { query: 'Notebook downtime', course_id: 1600002 });
  assert.equal(wrongCourse.results.length, 0);
  const all = await tools.run('list_discussions', {});
  assert.equal(all.courses.length, 2);
  const read = await tools.run('read_discussion', { discussion_key: thread.key });
  assert.equal(read.replies[0].author_role, 'instructor');
  assert.equal(tools.sources.get(read.replies[0].source).url, thread.url);
  assert.ok(!JSON.stringify(read).includes('Private Staff Name'));
});
