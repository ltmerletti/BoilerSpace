import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { saveSyllabusEntryHere } from '../extension/lib/syllabus-store.js';

const ORIGIN = 'https://purdue.brightspace.com';
export const FIXTURES = process.env.BOILERSPACE_FIXTURES_DIR
  ? pathToFileURL(resolve(process.env.BOILERSPACE_FIXTURES_DIR) + sep)
  : new URL('../../open-source-workbench/repos/Brightspace-Bar/session-capture/tests/fixtures/', import.meta.url);
const fixture = (name) => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

// A small stand-in for the chrome.* APIs the libraries use, so pipelines can run under Node.

export function installChrome({ executeScript = async () => [{ result: null }], sendMessage = async () => undefined, tabs = [] } = {}) {
  const data = {};
  const listeners = [];
  globalThis.chrome = {
    runtime: {
      getURL: (path) => new URL(`../extension/${path}`, import.meta.url).href,
      sendMessage: async (message) => {
        if (message.type !== 'boilerspace-save-syllabus') return;
        await saveSyllabusEntryHere(message.key, message.courseId, message.entry);
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(key) {
          if (key === null) return structuredClone(data);
          return key in data ? { [key]: structuredClone(data[key]) } : {};
        },
        async set(values) {
          Object.assign(data, structuredClone(values));
          for (const fn of listeners) fn(values, 'local');
        },
        async remove(key) {
          delete data[key];
        },
        async clear() {
          for (const key of Object.keys(data)) delete data[key];
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    tabs: {
      query: async () => tabs,
      get: async (id) => tabs.find((t) => t.id === id),
      create: async () => {
        throw new Error('tests do not open tabs');
      },
      sendMessage,
    },
    scripting: { executeScript },
  };
  return data;
}

export function snapshotFixture() {
  return {
    fetchedAt: '2026-10-13T12:00:00.000Z',
    versions: { lp: '1.62', le: '1.96' },
    user: { firstName: 'Boiler' },
    courses: [
      { id: 1600001, name: 'Fall 2026 CS 25200-LE1 LEC', code: 'wl.202620.CS.25200.LE1', current: true, startDate: '2026-08-24T04:00:00.000Z', endDate: '2026-12-20T04:59:00.000Z', homeUrl: 'https://purdue.brightspace.com/d2l/home/1600001' },
      { id: 1600002, name: 'Fall 2026 MA 26500-240 LEC', code: 'wl.202620.MA.26500.240', current: true, homeUrl: 'https://purdue.brightspace.com/d2l/home/1600002' },
      { id: 412690, name: 'Fall 2024 CS 18000-BLK - Merge', code: 'wl.202510.CS.18000.BLK', current: false, reason: 'ended' },
    ],
    data: [
      {
        courseId: 1600001,
        assignments: [
          { kind: 'assignment', id: 11, courseId: 1600001, title: 'Project 1: Shell', dueAt: '2026-10-16T03:59:00.000Z', instructions: 'Write a Unix shell in C. Submit shell.c through Gradescope and the report here.', url: 'https://purdue.brightspace.com/a/11', points: 100 },
          { kind: 'assignment', id: 12, courseId: 1600001, title: 'Project 2: Malloc', dueAt: '2026-11-06T04:59:00.000Z', instructions: 'Implement malloc and free.', url: 'https://purdue.brightspace.com/a/12' },
        ],
        quizzes: [{ kind: 'quiz', id: 21, courseId: 1600001, title: 'Quiz 5', dueAt: '2026-10-14T15:00:00.000Z', instructions: 'Covers processes and signals.', timeLimitMinutes: 20, attempts: 1, url: 'https://purdue.brightspace.com/q/21' }],
        announcements: [{ kind: 'announcement', id: 31, courseId: 1600001, title: 'Midterm room change', body: 'The midterm on October 21 is in ELLT 116, not WALC.', postedAt: '2026-10-12T14:00:00.000Z', url: 'https://purdue.brightspace.com/n/31' }],
        content: [
          { id: 77, courseId: 1600001, title: 'CS 25200 Syllabus Fall 2026.pdf', modulePath: ['Start Here'], type: 'File', fileUrl: '/d2l/api/le/1.96/1600001/content/topics/77/file', url: 'https://purdue.brightspace.com/c/77', updatedAt: '2026-08-20T00:00:00.000Z', isHidden: false },
          { id: 78, courseId: 1600001, title: 'Lecture 12 slides.pdf', modulePath: ['Week 7'], type: 'File', fileUrl: '/d2l/api/le/1.96/1600001/content/topics/78/file', url: 'https://purdue.brightspace.com/c/78', isHidden: false },
        ],
        events: [{ kind: 'event', id: 41, courseId: 1600001, title: 'Midterm 1', startAt: '2026-10-21T23:00:00.000Z', endAt: '2026-10-22T01:00:00.000Z', isAllDay: false, location: 'ELLT 116', linkedTo: null }],
        grades: [{ name: 'Quiz 4', displayed: '9 / 10' }],
      },
      { courseId: 1600002, assignments: [], quizzes: [], announcements: [], content: [], events: [], grades: [] },
    ],
    errors: [],
    requestLog: [],
  };
}

export const SYLLABUS_PAGES = [
  {
    page: 1,
    label: 'page 1',
    text: 'CS 25200: Systems Programming, Fall 2026\nInstructor office hours: Tuesdays 2:00\u20133:30 PM in LWSN 3133, or by appointment.\nAttendance is not required, but lectures are not recorded.',
  },
  {
    page: 2,
    label: 'page 2',
    text: 'Grading: Projects 50%, Midterm 20%, Final exam 25%, Quizzes 5%.\nLate policy: Each project may be submitted up to 2 days late with a 10% penalty per day.\nGenerative AI: You may use AI tools to understand concepts, but you may not submit any code written by an AI tool. Disclose any use in your report.',
  },
  {
    page: 3,
    label: 'page 3',
    text: 'Important dates\nMidterm exam: Wednesday, October 21, 7:00 PM\nProject 1 due Thursday, October 15 at 11:59 PM\nFinal project demo: Friday, December 4 (in lab)\nFinal exam: TBA during finals week',
  },
];

export function pdfWithPages(pageTexts) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pageTexts.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pageTexts.length} >>`);
  const fontId = 3 + pageTexts.length * 2;
  pageTexts.forEach((lines, i) => {
    const stream = lines.map((line, j) => `BT /F1 12 Tf 72 ${720 - j * 16} Td (${line.replace(/[()\\]/g, '\\$&')}) Tj ET`).join('\n');
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

// A synthetic 8x8 red/blue JPEG2000 image, encoded losslessly with Pillow and
// OpenJPEG 2.5.4. No downloaded document or course content is used.
export function pdfWithJpxImage() {
  const image = atob('/0//UQAvAAAAAAAIAAAACAAAAAAAAAAAAAAACAAAAAgAAAAAAAAAAAADBwEBBwEBBwEB/1IADAAAAAEAAwQEAAH/XAANQEBISFBISFBISFD/ZAAlAAFDcmVhdGVkIGJ5IE9wZW5KUEVHIHZlcnNpb24gMi41LjT/kAAKAAAAAABgAAH/k8fUBAMfz7QICL/H1AIIz8AICHvB84EAAs/ADAH/f8faCgACXUCsx8D5AYAJQF/H2goACRVURILH2goAF9fSbn/A+QIAFyyVn8faDAAXLJtN+6f/2Q==');
  const paint = 'q 64 0 0 64 0 0 cm /Image1 Do Q';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 64 64] /Contents 4 0 R /Resources << /XObject << /Image1 5 0 R >> >> >>',
    `<< /Length ${paint.length} >>\nstream\n${paint}\nendstream`,
    `<< /Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode /Length ${image.length} >>\nstream\n${image}\nendstream`,
  ];
  let pdf = '%PDF-1.5\n';
  const offsets = [];
  for (const [i, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Uint8Array.from(pdf, character => character.charCodeAt(0));
}

// What the model might return for SYLLABUS_PAGES, including two items it made up.
export const MODEL_OUTPUT = {
  deadlines: [
    { title: 'Midterm exam', kind: 'exam', date: '2026-10-21', time: '19:00', quote: 'Midterm exam: Wednesday, October 21, 7:00 PM' },
    { title: 'Project 1', kind: 'project', date: '2026-10-15', time: '23:59', quote: 'Project 1 due Thursday, October 15 at 11:59 PM' },
    { title: 'Final project demo', kind: 'presentation', date: '2026-12-03', time: null, quote: 'Final project demo: Friday, December 4 (in lab)' },
    { title: 'Homework 9', kind: 'assignment', date: '2026-11-20', time: '23:59', quote: 'Homework 9 is due November 20' },
  ],
  policies: {
    late_work: { summary: 'Projects can be up to 2 days late, losing 10% per day.', quote: 'Each project may be submitted up to 2 days late with a 10% penalty per day.' },
    attendance: { summary: 'Attendance is optional but lectures are not recorded.', quote: 'Attendance is not required, but lectures are not recorded.' },
    office_hours: { summary: 'Tuesdays 2 to 3:30 PM in LWSN 3133.', quote: 'office hours: Tuesdays 2:00-3:30 PM in LWSN 3133' },
    ai_use: { stance: 'restricted', summary: 'AI is fine for learning concepts, but no AI-written code.', quote: '\u201cYou may use AI tools to understand concepts, but you may not submit any code written by an AI tool.\u201d' },
    grading: [
      { component: 'Projects', weight_percent: 50, quote: 'Projects 50%' },
      { component: 'Midterm', weight_percent: 20, quote: 'Midterm 20%' },
      { component: 'Final exam', weight_percent: 25, quote: 'Final exam 25%' },
      { component: 'Participation', weight_percent: 5, quote: 'Participation 5%' },
    ],
  },
};

// A fake Brightspace built from recorded Purdue responses. It pages its enrollments and refuses one
// course's grades. With requireToken it also refuses cookie-only API calls, like some Brightspace setups.
export function fakeBrightspace({ requireToken = true } = {}) {
  const enrollments = fixture('myenrollments-200.json');
  const extraCourse = structuredClone(enrollments.Items[2]);
  Object.assign(extraCourse.OrgUnit, { Id: 1600001, Name: 'Fall 2026 CS 25200-LE1 LEC', Code: 'wl.202620.CS.25200.LE1' });
  Object.assign(extraCourse.Access, { CanAccess: true, StartDate: '2026-08-24T04:00:00.000Z', EndDate: '2026-12-20T04:59:00.000Z' });

  const routes = {
    '/d2l/api/versions/': [{ ProductCode: 'lp', LatestVersion: '1.62' }, { ProductCode: 'le', LatestVersion: '1.96' }],
    '/d2l/api/lp/1.62/users/whoami': { FirstName: 'Boiler', LastName: 'Maker' },
    '/d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3': { ...enrollments, PagingInfo: { Bookmark: 'page2', HasMoreItems: true } },
    '/d2l/api/lp/1.62/enrollments/myenrollments/?orgUnitTypeId=3&bookmark=page2': { PagingInfo: { Bookmark: null, HasMoreItems: false }, Items: [extraCourse] },
    '/d2l/api/le/1.96/412690/dropbox/folders/': fixture('dropbox-folders-412690.json'),
    '/d2l/api/le/1.96/440703/dropbox/folders/': fixture('dropbox-folders-440703.json'),
    '/d2l/api/le/1.96/1600001/dropbox/folders/': fixture('dropbox-folders-with-due-date.json'),
    '/d2l/api/le/1.96/412690/quizzes/': fixture('quizzes-412690.json'),
    '/d2l/api/le/1.96/440703/quizzes/': fixture('quizzes-440703.json'),
    '/d2l/api/le/1.96/1600001/quizzes/': fixture('quizzes-with-due-date.json'),
    '/d2l/api/le/1.96/412690/news/': fixture('news-412690.json'),
    '/d2l/api/le/1.96/440703/news/': fixture('news-440703.json'),
    '/d2l/api/le/1.96/1600001/news/': fixture('news-empty.json'),
    '/d2l/api/le/1.96/412690/grades/values/myGradeValues/': [],
    '/d2l/api/le/1.96/1600001/grades/values/myGradeValues/': [{ GradeObjectName: 'Quiz 1', DisplayedGrade: '9 / 10', PointsNumerator: 9, PointsDenominator: 10 }],
  };
  const toc = { Modules: [{ Title: 'Syllabus', Topics: [{ TopicId: 77, Title: 'CS 25200 Syllabus Fall 2026.pdf', TypeIdentifier: 'File', Url: '/content/enforced/1600001-CS25200/CS%2025200%20Syllabus%20Fall%202026.pdf' }], Modules: [] }] };
  const calendar = { Objects: [{ CalendarEventId: 5, Title: 'Midterm 1', StartDateTime: '2026-10-21T00:00:00.000Z', EndDateTime: '2026-10-21T02:00:00.000Z', IsAllDayEvent: false }], Next: null };

  const calls = [];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  async function fetchImpl(url, init = {}) {
    const path = url.slice(ORIGIN.length);
    const auth = init.headers?.Authorization ?? null;
    calls.push({ path, method: init.method ?? 'GET', auth, csrf: init.headers?.['X-Csrf-Token'] ?? null });

    if (path === '/d2l/lp/auth/oauth2/token') {
      return init.headers?.['X-Csrf-Token'] === 'xsrf-123' && init.body === 'scope=*:*:*'
        ? json({ access_token: 'jwt-abc', expires_in: 3600 })
        : json({ error: 'Not authenticated' }, 403);
    }
    if (requireToken && path.startsWith('/d2l/api/') && path !== '/d2l/api/versions/' && auth !== 'Bearer jwt-abc') return json({ title: 'Forbidden' }, 403);
    if (/\/lp\/1\.62\/courses\/\d+$/.test(path)) return json({ title: 'Not Found' }, 404);
    if (path === '/d2l/api/le/1.96/440703/grades/values/myGradeValues/') return json({ title: 'Forbidden' }, 403);
    if (path.endsWith('/content/toc')) return json(path.includes('/1600001/') ? toc : { Modules: [] });
    if (path.includes('/calendar/events/myEvents/')) return json(path.includes('/1600001/') ? calendar : { Objects: [], Next: null });
    if (path in routes) return json(routes[path]);
    return json({ title: 'Not Found' }, 404);
  }
  return { fetchImpl, calls };
}
