// Run with: npm test
// Fixtures are real Purdue Brightspace responses recorded by Brightspace Bar (MIT).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyCourse,
  createClient,
  fileNameFromDisposition,
  flattenToc,
  normalizeAnnouncement,
  normalizeAssignment,
  normalizeEnrollment,
  normalizeQuiz,
  richText,
  syncCurrentCourses,
} from '../extension/lib/brightspace.js';
import { fakeBrightspace } from './helpers.mjs';

const FIXTURES = new URL('../../open-source-workbench/repos/Brightspace-Bar/session-capture/tests/fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
const ORIGIN = 'https://purdue.brightspace.com';
const NOW = new Date('2026-10-12T16:00:00Z');

test('enrollments normalize and classify', () => {
  const items = fixture('myenrollments-200.json').Items;
  const courses = items.map(normalizeEnrollment);
  assert.equal(courses.length, 27);

  const civics = courses.find((c) => c.id === 412690);
  assert.equal(civics.name, 'Purdue Civics Knowledge Test');
  assert.equal(civics.startDate, null);
  assert.deepEqual(classifyCourse(civics, NOW), { current: true, reason: 'no dates; opened in the last 120 days' });

  const pastTerm = courses.find((c) => c.id === 1092755);
  assert.equal(classifyCourse(pastTerm, NOW).current, false);
  assert.equal(classifyCourse({ ...pastTerm, canAccess: true }, NOW).reason, 'ended');

  const thisTerm = { ...pastTerm, canAccess: true, startDate: '2026-08-24T04:00:00Z', endDate: '2026-12-20T05:00:00Z' };
  assert.deepEqual(classifyCourse(thisTerm, NOW), { current: true, reason: 'course dates include today' });
});

test('assignments, quizzes and announcements normalize from recorded responses', () => {
  const [homework] = fixture('dropbox-folders-with-due-date.json').map((f) => normalizeAssignment(f, 1, ORIGIN));
  assert.equal(homework.title, 'Homework 3');
  assert.equal(homework.dueAt, '2026-03-01T04:59:00.000Z');
  assert.equal(homework.points, 100);
  assert.match(homework.url, /db=700001&ou=1$/);

  const [midterm] = fixture('quizzes-with-due-date.json').Objects.map((q) => normalizeQuiz(q, 1, ORIGIN));
  assert.equal(midterm.title, 'Midterm Exam');
  assert.equal(midterm.timeLimitMinutes, 50);
  assert.equal(midterm.attempts, 1);

  const [pledge] = fixture('quizzes-bare-array.json').map((q) => normalizeQuiz(q, 1, ORIGIN));
  assert.equal(pledge.dueAt, null);
  assert.equal(pledge.instructions, '');

  const [first] = fixture('news-412690.json').map((n) => normalizeAnnouncement(n, 412690, ORIGIN));
  assert.equal(first.title, 'Due Date Error Posting');
  assert.match(first.body, /^During course maintenance/);
  assert.equal(first.postedAt, '2025-07-17T18:02:00.000Z', 'StartDate, when students could first see it');
});

test('richText falls back from empty Text to Html', () => {
  assert.equal(richText({ Text: '', Html: '<p>Read&#160;chapter 3</p><p>Then quiz</p>' }), 'Read chapter 3\nThen quiz');
  assert.equal(richText({ Text: { Text: 'nested', Html: '' } }), 'nested');
  assert.equal(richText(null), '');
});

test('content TOC flattens with module paths and syllabus detection', () => {
  const toc = {
    Modules: [
      {
        Title: 'Start Here',
        Topics: [{ TopicId: 9, Title: 'Course Syllabus', TypeIdentifier: 'File' }],
        Modules: [{ Title: 'Week 1', Topics: [{ TopicId: 10, Title: 'Lecture 1 slides', TypeIdentifier: 'File' }], Modules: [] }],
      },
      { Title: 'Course Information', Topics: [{ TopicId: 11, Title: 'Grading', TypeIdentifier: 'Link' }], Modules: [] },
    ],
  };
  const topics = flattenToc(toc, 5, ORIGIN);
  assert.deepEqual(topics.map((t) => [t.id, t.modulePath.join(' > '), t.looksLikeSyllabus]), [
    [9, 'Start Here', true],
    [10, 'Start Here > Week 1', false],
    [11, 'Course Information', true],
  ]);
  assert.equal(topics[1].fileUrl, '/d2l/api/le/{le}/5/content/topics/10/file');
  assert.equal(topics[2].fileUrl, null);
});

test('full sync against a fake Brightspace', async () => {
  const { fetchImpl, calls } = fakeBrightspace();
  const client = createClient({ origin: ORIGIN, fetchImpl, xsrfToken: 'xsrf-123' });
  const result = await syncCurrentCourses(client, { origin: ORIGIN, now: NOW });

  assert.deepEqual(result.versions, { lp: '1.62', le: '1.96' });
  assert.equal(result.authMode, 'token');
  assert.equal(calls.filter((c) => c.path === '/d2l/lp/auth/oauth2/token').length, 1);
  assert.equal(result.user.firstName, 'Boiler');
  assert.equal(result.courses.length, 28, 'both enrollment pages were read');

  const current = result.courses.filter((c) => c.current).map((c) => c.id).sort((a, b) => a - b);
  assert.deepEqual(current, [412690, 440703, 1600001]);

  const cs252 = result.data.find((d) => d.courseId === 1600001);
  assert.equal(cs252.assignments.length, 3);
  assert.equal(cs252.quizzes[0].title, 'Midterm Exam');
  assert.equal(cs252.events[0].title, 'Midterm 1');
  assert.equal(cs252.grades[0].displayed, '9 / 10');
  assert.equal(cs252.content[0].looksLikeSyllabus, true);
  assert.equal(cs252.content[0].fileUrl, '/d2l/api/le/1.96/1600001/content/topics/77/file');

  assert.ok(result.errors.some((e) => e.courseId === 440703 && e.section === 'grades' && e.status === 403));
  assert.ok(calls.every((c) => c.method === 'GET' || c.path === '/d2l/lp/auth/oauth2/token'), 'only GETs plus the token request');
  const calendarCall = calls.find((c) => c.path.startsWith('/d2l/api/le/1.96/1600001/calendar/'));
  assert.match(calendarCall.path, /startDateTime=2026-10-05T16%3A00%3A00\.000Z&endDateTime=2027-03-11T16%3A00%3A00\.000Z/);
});

test('file downloads use the same auth fallback and keep the file name', async () => {
  const pdfBytes = new TextEncoder().encode('%PDF-1.4 fake');
  async function fetchImpl(url, init = {}) {
    const path = url.slice(ORIGIN.length);
    if (path === '/d2l/lp/auth/oauth2/token') return new Response(JSON.stringify({ access_token: 'jwt-abc' }), { headers: { 'Content-Type': 'application/json' } });
    if (init.headers?.Authorization !== 'Bearer jwt-abc') return new Response('{}', { status: 403 });
    return new Response(pdfBytes, {
      headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename*=UTF-8''CS%2025200%20Syllabus.pdf` },
    });
  }
  const client = createClient({ origin: ORIGIN, fetchImpl, xsrfToken: 'xsrf-123' });
  const file = await client.getFile('/d2l/api/le/1.96/1600001/content/topics/77/file');
  assert.equal(file.fileName, 'CS 25200 Syllabus.pdf');
  assert.equal(file.contentType, 'application/pdf');
  assert.deepEqual([...file.bytes.slice(0, 4)], [0x25, 0x50, 0x44, 0x46]);
  assert.equal(fileNameFromDisposition('inline; filename="Syllabus Fall 2026.docx"'), 'Syllabus Fall 2026.docx');
  assert.equal(fileNameFromDisposition(null), null);
});

test('an expired session reports clearly instead of parsing a sign-in page', async () => {
  const stub = readFileSync(new URL('session-expired-stub.html', FIXTURES), 'utf8');
  const fetchImpl = async () => new Response(stub, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const client = createClient({ origin: ORIGIN, fetchImpl });
  await assert.rejects(syncCurrentCourses(client, { origin: ORIGIN, now: NOW }), /session may have expired/);
});
