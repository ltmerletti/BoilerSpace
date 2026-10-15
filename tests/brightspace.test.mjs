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
  contentTargetFromHref,
  fileByteLimit,
  findSyllabusTab,
  questionsFromReviewHtml,
  quizStillOpen,
  readQuiz,
  syllabusHrefInDocument,
  syllabusHrefsInDocument,
  syllabusNavLinks,
  syncCurrentCourses,
  toBase64,
  visibleQuizQuestions,
} from '../extension/lib/brightspace.js';
import { snapshotSyllabus } from '../extension/lib/syllabus-scan.js';
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
  assert.equal(cs252.syllabusTab, undefined, 'course sync does not run syllabus discovery');
  assert.ok(!calls.some((c) => c.path === '/d2l/home/412690'), 'a course with no syllabus does not delay course sync');

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

test('the Syllabus tab points at a content file that is not in the table of contents', async () => {
  const quick = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&amp;type=content&amp;code=354644E0-4CD8-419D-A32F-4E78DB778E5C-12707056&amp;srcou=6824&amp;launchFramed=1&amp;framedName=Syllabus';
  const page = `<a href="/d2l/home/1631469">Course Home</a><a class="d2l-navigation-s-link" href="${quick}">Syllabus</a>`;
  const custom = `<d2l-navigation-link href="${quick}"></d2l-navigation-link>`;
  assert.equal(syllabusNavLinks(custom)[0].href, syllabusNavLinks(page)[0].href);
  assert.equal(syllabusNavLinks(page)[0].text, 'Syllabus');
  assert.deepEqual(contentTargetFromHref(syllabusNavLinks(page)[0].href), { topicId: 12707056, orgUnitId: 1631469, sourceOrgUnitId: 6824 });

  const topic = {
    Id: 12707056,
    Title: 'Data Structures And Algorithms',
    TopicType: 1,
    Url: '/content/enforced/6824-template/syllabus.html',
    LastModifiedDate: '2026-10-12T23:39:00.000Z',
  };
  const client = {
    async getText(path) {
      if (path === '/d2l/home/1631469') return page;
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
    async getJson(path) {
      assert.equal(path, '/d2l/api/le/1.96/6824/content/topics/12707056');
      return topic;
    },
  };
  const tab = await findSyllabusTab(client, { courseId: 1631469, le: '1.96', origin: ORIGIN });
  assert.equal(tab.id, 'tab:12707056');
  assert.equal(tab.title, 'Syllabus');
  assert.equal(tab.fileUrl, '/d2l/api/le/1.96/6824/content/topics/12707056/file');
  assert.equal(tab.fileHref, '/content/enforced/6824-template/syllabus.html');
  assert.equal(tab.updatedAt, '2026-10-12T23:39:00.000Z');
});

test('a Syllabus link already on the open page is used without fetching the homepage', async () => {
  const href = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=content&code=354644E0-4CD8-419D-A32F-4E78DB778E5C-12707056&srcou=6824&framedName=Syllabus';
  const paths = [];
  const client = {
    async getText(path) {
      paths.push(path);
      if (path === '/content/enforced/6824-template/syllabus.html') return `<html><body>${'Quizzes follow recent lectures. '.repeat(40)}</body></html>`;
      throw new Error(`unexpected fetch ${path}`);
    },
    async getJson(path) {
      assert.equal(path, '/d2l/api/le/1.96/6824/content/topics/12707056');
      return { Id: 12707056, Title: 'Syllabus', TopicType: 1, Url: '/content/enforced/6824-template/syllabus.html', LastModifiedDate: '2026-10-12T23:39:00.000Z' };
    },
  };
  const tab = await findSyllabusTab(client, {
    courseId: 1631469,
    le: '1.96',
    origin: ORIGIN,
    pageLinks: [href],
    readTab: { page: async () => { throw new Error('the rendered page is only needed when the file itself cannot be read'); } },
  });
  assert.deepEqual(paths, ['/content/enforced/6824-template/syllabus.html']);
  assert.equal(tab.fileUrl, '/d2l/api/le/1.96/6824/content/topics/12707056/file');
  assert.match(tab.text, /Quizzes follow recent lectures/);
  assert.equal(tab.textLabel, 'page 1');
});

test('each course can be opened when the homepage HTML does not include the Syllabus tab', async () => {
  const href = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=content&code=354644E0-4CD8-419D-A32F-4E78DB778E5C-12707056&srcou=6824&framedName=Syllabus';
  const body = 'Checkpoint quizzes cover the most recent topics. '.repeat(30);
  const opened = [];
  const client = {
    async getText(path) {
      if (path === '/d2l/home/1631469' || path === '/d2l/le/content/1631469/Home') return '<html><body>Course Home</body></html>';
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
    async getJson() {
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
  };
  const tab = await findSyllabusTab(client, {
    courseId: 1631469,
    le: '1.96',
    origin: ORIGIN,
    readTab: {
      async links(courseId) {
        assert.equal(courseId, 1631469);
        return [href];
      },
      async page(url) {
        opened.push(url);
        return body;
      },
    },
  });
  assert.deepEqual(opened, [href]);
  assert.equal(tab.id, 'tab:12707056');
  assert.equal(tab.title, 'Syllabus');
  assert.equal(tab.text, body);
  assert.equal(tab.fileUrl, '/d2l/api/le/1.96/6824/content/topics/12707056/file');
});

test('a syllabus on the course template is read when Content and the homepage do not list it', async () => {
  const html = `<html><body>${'Each checkpoint covers the most recent topics. '.repeat(20)}</body></html>`;
  const toc = {
    Modules: [{
      Title: 'Course Information',
      Topics: [
        { TopicId: 4, Title: 'Lecture 1', TypeIdentifier: 'File', Url: '/content/enforced/6824-template/lecture1.pptx' },
        { TopicId: 12707056, Title: 'Syllabus', TypeIdentifier: 'File', Url: '/content/enforced/6824-template/syllabus.html', LastModifiedDate: '2026-10-12T23:39:00.000Z' },
      ],
      Modules: [],
    }],
  };
  const paths = [];
  const client = {
    async getText(path) {
      paths.push(path);
      if (path === '/content/enforced/6824-template/syllabus.html') return html;
      throw new Error(`unexpected fetch ${path}`);
    },
    async getJson(path) {
      paths.push(path);
      if (path === '/d2l/api/lp/1.62/courses/1631469') return { CourseTemplate: { Identifier: '6824', Name: 'CS 25100 template', Code: 'template' } };
      if (path === '/d2l/api/le/1.96/6824/content/toc') return toc;
      throw new Error(`unexpected fetch ${path}`);
    },
  };
  const tab = await findSyllabusTab(client, {
    courseId: 1631469,
    le: '1.96',
    lp: '1.62',
    origin: ORIGIN,
    readTab: { links: async () => { throw new Error('the course page does not need to be opened'); } },
  });
  assert.equal(tab.id, 'tab:12707056');
  assert.equal(tab.title, 'Syllabus');
  assert.equal(tab.fileUrl, '/d2l/api/le/1.96/6824/content/topics/12707056/file');
  assert.match(tab.text, /Each checkpoint covers the most recent topics/);
  assert.equal(paths.some((path) => path.startsWith('/d2l/home/')), false);

  const missed = await findSyllabusTab({
    async getText() {
      return '<html><body>Course Home</body></html>';
    },
    async getJson(path) {
      if (path === '/d2l/api/lp/1.62/courses/99') return { CourseTemplate: null };
      if (path === '/d2l/api/lp/1.62/orgstructure/99/parents') {
        return [{ Identifier: '50', Type: { Code: 'Course Template', Name: 'Course Template' } }];
      }
      if (path === '/d2l/api/le/1.96/50/content/toc') {
        return { Modules: [{ Title: 'Syllabus', Topics: [{ TopicId: 3, Title: 'Lecture 1', TypeIdentifier: 'File' }], Modules: [] }] };
      }
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
  }, { courseId: 99, le: '1.96', lp: '1.62', origin: ORIGIN });
  assert.equal(missed, null, 'a template module named Syllabus is not the syllabus unless a file in it is');
});

test('a linked PDF uses the file reader without opening a rendered syllabus tab', async () => {
  const file = '/content/enforced/9-template/syllabus.pdf';
  const tab = await findSyllabusTab({ getText: () => assert.fail('a PDF should not be fetched as HTML') }, {
    courseId: 9, le: '1.96', origin: ORIGIN, pageLinks: [file],
    readTab: { page: () => assert.fail('a PDF does not need a viewer tab') },
  });
  assert.equal(tab.fileUrl, file);
  assert.equal(tab.id, 'tab:9:file');
});

test('an HTML template that initially shows Loading is read after rendering', async () => {
  const file = '/content/enforced/9-template/syllabus.html';
  const text = 'Course syllabus and assessment schedule. '.repeat(30);
  const calls = [];
  const tab = await findSyllabusTab({ getText: async () => `<html><body><p>Loading…</p><script src="syllabus.js"></script>${' '.repeat(800)}</body></html>` }, {
    courseId: 9, le: '1.96', origin: ORIGIN, pageLinks: [file],
    readTab: { page: async (href) => { calls.push(href); return text; } },
  });
  assert.deepEqual(calls, [file]);
  assert.equal(tab.text, text);
});

test('an ordinary content page is not treated as the Syllabus tab', () => {
  const href = `${ORIGIN}/d2l/le/content/1631469/viewContent/123456/View`;
  const doc = { location: { href }, querySelectorAll: () => [] };
  assert.deepEqual(syllabusHrefsInDocument(doc), []);
  assert.equal(syllabusHrefInDocument(doc, 1631469), null);
  doc.location.href = `${ORIGIN}/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=content&code=12707056&framedName=Syllabus`;
  assert.deepEqual(syllabusHrefsInDocument(doc), [doc.location.href]);
});

test('a Syllabus link inside the open course navbar is used', () => {
  const href = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=content&code=354644E0-4CD8-419D-A32F-4E78DB778E5C-12707056&srcou=6824&framedName=Syllabus';
  const link = {
    getAttribute: (name) => (name === 'href' ? href : null),
    href,
    textContent: '',
    shadowRoot: null,
  };
  const shadow = { querySelectorAll: () => [link] };
  const host = { getAttribute: () => null, href: '', textContent: '', shadowRoot: shadow };
  const doc = { location: { pathname: '/d2l/home/1631469', search: '' }, querySelectorAll: () => [host] };
  assert.equal(syllabusHrefInDocument(doc, 1631469), href);
  assert.equal(syllabusHrefInDocument(doc, 1632050), null);

  const page = {
    location: { origin: 'https://purdue.brightspace.com', pathname: '/content/enforced/6824-template/syllabus.html' },
    readyState: 'complete',
    body: { innerText: 'Each checkpoint covers the most recent topics. '.repeat(20) },
    querySelectorAll: () => [host],
  };
  const shot = snapshotSyllabus(1631469, page);
  assert.deepEqual(shot.hrefs, [href]);
  assert.match(shot.text, /Each checkpoint covers the most recent topics/);
  assert.deepEqual(snapshotSyllabus(1632050, page).hrefs, []);
});

test('a finished quiz returns its questions and leaves out the score and the answer key', async () => {
  assert.equal(quizStillOpen({ dueAt: '2026-09-21T03:59:00.000Z' }, new Date('2026-10-15T16:00:00Z')), false);
  assert.equal(quizStillOpen({ dueAt: '2026-10-20T03:59:00.000Z' }, new Date('2026-10-15T16:00:00Z')), true);
  const calls = [];
  const client = {
    async getJson(path) {
      calls.push(path);
      if (path.endsWith('/attempts/')) {
        return { Objects: [{ AttemptId: 9, Completed: '2026-09-21T04:00:00.000Z', Score: 8 }] };
      }
      if (path.endsWith('/attempts/9/questions/')) {
        return {
          Objects: [{
            Points: 1,
            QuestionInfo: {
              QuestionText: { Text: 'A stack removes the most recent item first.' },
              IsTrue: true,
              Answers: [
                { Answer: { Text: 'True' }, Weight: 100 },
                { Answer: { Text: 'False' }, Weight: 0 },
              ],
            },
          }],
        };
      }
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
    async getText() {
      throw Object.assign(new Error('HTTP 404'), { status: 404 });
    },
  };
  const result = await readQuiz(client, { courseId: 5, quizId: 21, le: '1.96', dueAt: '2026-09-21T03:59:00.000Z', now: new Date('2026-10-15T16:00:00Z') });
  assert.equal(result.questions[0].text, 'A stack removes the most recent item first.');
  assert.deepEqual(result.questions[0].choices, ['True', 'False']);
  assert.equal(JSON.stringify(result).includes('100'), false);
  assert.equal(JSON.stringify(result).includes('Score'), false);
  assert.equal(calls.some((path) => path.endsWith('/questions/') && !path.includes('/attempts/')), false);

  const openCalls = [];
  const open = await readQuiz({
    async getJson(path) {
      openCalls.push(path);
      return { Objects: [] };
    },
    async getText() {
      return '';
    },
  }, { courseId: 5, quizId: 22, le: '1.96', dueAt: '2026-10-20T03:59:00.000Z', now: new Date('2026-10-15T16:00:00Z') });
  assert.match(open.note, /can still be taken/);
  assert.equal(openCalls.some((path) => path.endsWith('/questions/')), false);

  const reviewed = questionsFromReviewHtml('<div class="d2l-quiz-question-text">Which sort is stable?</div><div>Score: 9 / 10</div>');
  assert.equal(reviewed[0].text, 'Which sort is stable?');
  assert.equal(JSON.stringify(reviewed).includes('9 / 10'), false);
  assert.deepEqual(visibleQuizQuestions({ Objects: [] }), []);
});

test('a slide deck may be larger than a pdf because its pictures stay packed', () => {
  assert.equal(fileByteLimit(Uint8Array.from([0x50, 0x4b, 0, 0])), 200_000_000);
  assert.equal(fileByteLimit(Uint8Array.from([0x25, 0x50, 0x44, 0x46])), 100_000_000);
});

test('file bytes are encoded without slicing the typed array', () => {
  const raw = new Uint8Array(40_000);
  for (let i = 0; i < raw.length; i++) raw[i] = i % 256;
  const hostile = {
    length: raw.length,
    subarray() {
      throw new Error('Permission denied to access property "constructor"');
    },
  };
  for (let i = 0; i < raw.length; i++) hostile[i] = raw[i];
  assert.equal(Buffer.from(toBase64(hostile), 'base64').equals(Buffer.from(raw)), true);
});

test('an expired session reports clearly instead of parsing a sign-in page', async () => {
  const stub = readFileSync(new URL('session-expired-stub.html', FIXTURES), 'utf8');
  const fetchImpl = async () => new Response(stub, { status: 200, headers: { 'Content-Type': 'text/html' } });
  const client = createClient({ origin: ORIGIN, fetchImpl });
  await assert.rejects(syncCurrentCourses(client, { origin: ORIGIN, now: NOW }), /session may have expired/);
});

test('a direct file on another open course is not used as this course syllabus', async () => {
  const paths = [];
  const tab = await findSyllabusTab({
    async getText(path) { paths.push(path); return '<nav>Course Home</nav>'; },
  }, { courseId: 1631466, le: '1.96', origin: ORIGIN,
    pageLinks: ['/content/enforced/1632050-eaps/syllabus.pdf'],
    readTab: { links: async () => [] },
  });
  assert.equal(tab, null);
  assert.deepEqual(paths, ['/d2l/home/1631466', '/d2l/le/content/1631466/Home']);
});

test('a direct template file in the requested course rendered navbar is accepted', async () => {
  const path = '/content/enforced/6824-template/syllabus.html';
  const text = 'Syllabus for this course. Assessment policies and schedule. '.repeat(30);
  const tab = await findSyllabusTab({
    async getText(url) { return url === path ? `<html><body>${text}</body></html>` : '<nav>Course Home</nav>'; },
  }, { courseId: 1631466, le: '1.96', origin: ORIGIN,
    readTab: { links: async (id) => { assert.equal(id, 1631466); return [path]; } },
  });
  assert.equal(tab.fileUrl, path);
  assert.match(tab.text, /Assessment policies/);
});

const LTI_SYLLABUS = '/d2l/common/dialogs/quickLink/quickLink.d2l?ou=1631469&type=lti&rcode=354644E0-4CD8-419D-A32F-4E78D8778E5C-12707056&srcou=6824&launchFramed=1&framedName=Syllabus';
test('the real Purdue LTI Syllabus link launches the rendered reader instead of a Content file API', async () => {
  const target = contentTargetFromHref(LTI_SYLLABUS);
  assert.equal(target.launchHref, LTI_SYLLABUS);
  assert.equal(target.topicId, null, 'an LTI resource code is not a Content topic id');
  const text = 'CS 25100 Data Structures And Algorithms. '.repeat(30);
  const tab = await findSyllabusTab({
    getJson: async () => assert.fail('do not resolve an LTI resource through the Content API'),
    getText: async () => assert.fail('the live navbar already contains the launch link'),
  }, { courseId: 1631469, le: '1.99', origin: ORIGIN, pageLinks: [LTI_SYLLABUS], readTab: { page: async (href) => { assert.equal(href, LTI_SYLLABUS); return text; } } });
  assert.equal(tab.id, 'tab:1631469:lti');
  assert.equal(tab.text, text);
  assert.equal(tab.fileUrl, null);
  assert.match(tab.url, /type=lti/);
});

test('an LTI reader failure is an error rather than a missing syllabus', async () => {
  await assert.rejects(findSyllabusTab({}, { courseId: 1631469, le: '1.99', origin: ORIGIN, pageLinks: [LTI_SYLLABUS], readTab: { page: async () => { throw new Error('Simple Syllabus is still loading'); } } }), /still loading/);
});

test('an explicit Simple Syllabus missing section is not a loading failure', async () => {
  const tab = await findSyllabusTab({}, { courseId: 1631469, le: '1.99', origin: ORIGIN, pageLinks: [LTI_SYLLABUS], readTab: { page: async () => ({ notFound: true }) } });
  assert.equal(tab, null);
});
