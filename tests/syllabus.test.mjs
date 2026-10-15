import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from '../extension/vendor/fflate/fflate.js';
import { installChrome, MODEL_OUTPUT, snapshotFixture, SYLLABUS_PAGES } from './helpers.mjs';
import { chooseSyllabus, locateQuote, matchToBrightspace, pendingReviews, processCourse, rankSyllabusCandidates, readUploadedSyllabus, syllabusCandidates, validateExtraction } from '../extension/lib/syllabus.js';
import { flattenToc } from '../extension/lib/brightspace.js';
import { agendaItems, calendarEvents, shortCourseLabel } from '../extension/lib/planner.js';

test('picks the syllabus file and ignores lecture slides', () => {
  const [best, ...rest] = rankSyllabusCandidates(snapshotFixture().data[0].content);
  assert.equal(best.id, 77);
  assert.equal(rest.length, 0);
});

test('finds syllabi posted as links to course files, outside links, or in the course overview', () => {
  const ORIGIN = 'https://purdue.brightspace.com';
  const toc = {
    Modules: [
      {
        Title: 'Course Information',
        Topics: [
          { TopicId: 1, Title: 'EAPS 32700 Fall 2026', TypeIdentifier: 'Link', Url: '/content/enforced/1700001-EAPS-32700/EAPS327_Syllabus_F26.pdf' },
          { TopicId: 2, Title: 'Syllabus (Google Doc)', TypeIdentifier: 'Link', Url: 'https://docs.google.com/document/d/abc' },
          { TopicId: 3, Title: 'Sneaky', TypeIdentifier: 'Link', Url: '/content/enforced/../d2l/api/lp/1.62/users/whoami' },
        ],
      },
    ],
  };
  const content = flattenToc(toc, 1700001, ORIGIN);
  assert.equal(content[0].fileUrl, '/content/enforced/1700001-EAPS-32700/EAPS327_Syllabus_F26.pdf');
  assert.equal(content[1].fileUrl, null);
  assert.equal(content[1].externalUrl, 'https://docs.google.com/document/d/abc');
  assert.equal(content[2].fileUrl, null, 'paths that climb out of course files are not downloadable');

  const ranked = rankSyllabusCandidates(content);
  assert.deepEqual(ranked.map((t) => t.id), [1, 2], 'a PDF whose file name says syllabus beats an outside link that can not be opened');

  const withOverview = syllabusCandidates({ content: [], overview: { text: '', hasAttachment: true, fileUrl: '/d2l/api/le/1.96/1700001/overview/attachment' } });
  assert.equal(withOverview[0].id, 'overview');
  const pasted = syllabusCandidates({ content: [], overview: { text: `Syllabus. ${'Grading and policies. '.repeat(60)}`, hasAttachment: false, fileUrl: null } });
  assert.equal(pasted[0].id, 'overview-text');

  const tab = { id: 'tab:12707056', title: 'Syllabus', fileUrl: '/d2l/api/le/1.96/6824/content/topics/12707056/file', url: 'https://purdue.brightspace.com/d2l/le/content/6824/viewContent/12707056/View' };
  const fromTab = syllabusCandidates({ content: [], syllabusTab: tab });
  assert.equal(fromTab[0].id, 'tab:12707056');
  const rendered = syllabusCandidates({ content: [], syllabusTab: { id: 'tab:9', title: 'Syllabus', text: 'Course schedule and policies.', url: 'https://purdue.brightspace.com/d2l/home/9' } });
  assert.equal(rendered[0].id, 'tab:9');
  const pdfWins = syllabusCandidates({ content, syllabusTab: tab });
  assert.equal(pdfWins[0].id, 1, 'a syllabus file in Content still wins over the Syllabus tab');
});

test('quotes must appear in the file, allowing dash, quote and ellipsis differences', () => {
  assert.equal(locateQuote('office hours: Tuesdays 2:00-3:30 PM in LWSN 3133', SYLLABUS_PAGES)?.label, 'page 1');
  assert.equal(locateQuote('Projects 50% ... Quizzes 5%', SYLLABUS_PAGES)?.label, 'page 2');
  assert.equal(locateQuote('Homework 9 is due November 20', SYLLABUS_PAGES), null);
  assert.equal(locateQuote('Quizzes 5% ... Projects 50%', SYLLABUS_PAGES), null, 'pieces must be in order');
});

test('validation drops invented items and flags dates that need a person to check', () => {
  const snapshot = snapshotFixture();
  const facts = validateExtraction(MODEL_OUTPUT, SYLLABUS_PAGES, { courseId: 1600001, brightspaceItems: snapshot.data[0].assignments });

  assert.deepEqual(facts.deadlines.map((d) => d.title), ['Project 1', 'Midterm exam', 'Final project demo']);
  assert.ok(facts.dropped.some((d) => d.what.includes('Homework 9')));
  assert.ok(facts.dropped.some((d) => d.what.includes('Participation')));

  const project = facts.deadlines.find((d) => d.title === 'Project 1');
  assert.equal(project.dueAt, '2026-10-16T03:59:00.000Z', '11:59 PM EDT is 03:59 UTC the next day');
  assert.equal(project.matchedItem.key, 'assignment:11');
  assert.equal(project.dateDiffers, false);

  const demo = facts.deadlines.find((d) => d.title === 'Final project demo');
  assert.equal(demo.weekdayMismatch, true, 'December 3, 2026 is a Thursday, but the quote says Friday');
  assert.equal(demo.page, 'page 3');

  assert.equal(facts.policies.aiUse.stance, 'restricted');
  assert.equal(facts.policies.aiUse.page, 'page 2');
  assert.ok(!facts.policies.aiUse.quote.startsWith('\u201c'), 'wrapping quote marks are removed');
  assert.equal(facts.policies.grading.length, 3);
  assert.equal(facts.policies.gradingAddsUp, false);
  assert.equal(facts.policies.officeHours.page, 'page 1');

  const record = { 1600001: { status: 'done', ...facts } };
  const pending = pendingReviews(record, {}, new Date('2026-10-13T16:00:00Z'));
  assert.deepEqual(pending.map((d) => d.title), ['Midterm exam', 'Final project demo']);
  assert.deepEqual(pendingReviews(record, {}, new Date('2026-11-01T16:00:00Z')).map((d) => d.title), ['Final project demo'], 'dates that already passed are not asked about');
});

test('matching needs similar titles and nearby dates', () => {
  const items = snapshotFixture().data[0].assignments;
  assert.equal(matchToBrightspace({ title: 'Project 2 (malloc)', date: '2026-11-05' }, items)?.item.id, 12);
  assert.equal(matchToBrightspace({ title: 'Project 2', date: '2026-12-20' }, items), null);
  assert.equal(matchToBrightspace({ title: 'Midterm', date: '2026-10-21' }, items), null);
});

function docxBytes(paragraphs) {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</w:t></w:r></w:p>`).join('');
  return zipSync({ 'word/document.xml': strToU8(`<?xml version="1.0"?><w:document><w:body>${body}</w:body></w:document>`) });
}

test('full pipeline: download in the Brightspace tab, read the DOCX, extract, verify and save', async () => {
  const file = docxBytes(SYLLABUS_PAGES.flatMap((p) => p.text.split('\n')));
  const messages = [];
  const data = installChrome({
    tabs: [{ id: 5, url: 'https://purdue.brightspace.com/d2l/home', status: 'complete' }],
    executeScript: async ({ world }) => [{ result: world === 'MAIN' ? 'xsrf-1' : null }],
    sendMessage: async (tabId, message) => {
      messages.push({ tabId, ...message });
      if (message.type === 'boilerspace-ping') return { ok: true };
      return { ok: true, result: { base64: Buffer.from(file).toString('base64'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Syllabus.docx' } };
    },
  });
  data.genai = { key: 'sk-test', model: 'gpt-oss:120b' };

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(MODEL_OUTPUT) } }] }), { headers: { 'Content-Type': 'application/json' } });
  };

  const snapshot = snapshotFixture();
  const record = await processCourse(snapshot, 1600001, { now: new Date('2026-10-13T12:00:00Z') });
  assert.equal(record.status, 'done', record.error);
  assert.equal(record.kind, 'docx');
  const download = messages.find((m) => m.type === 'boilerspace-download');
  assert.equal(download.tabId, 5);
  assert.equal(download.path, '/d2l/api/le/1.96/1600001/content/topics/77/file');
  assert.equal(download.xsrfToken, 'xsrf-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.response_format.json_schema.strict, true);
  assert.ok(requests[0].body.messages[1].content.includes('Midterm exam: Wednesday, October 21, 7:00 PM'));
  assert.ok(!JSON.stringify(requests[0].body).includes('9 / 10'), 'grades are never sent');
  assert.equal(data.syllabi[1600001].deadlines.length, 3);

  const again = await processCourse(snapshot, 1600001, { now: new Date('2026-10-13T13:00:00Z') });
  assert.equal(again.extractedAt, record.extractedAt);
  assert.equal(requests.length, 1, 'an unchanged syllabus is not sent again');

  const syllabi = data.syllabi;
  const midterm = syllabi[1600001].deadlines.find((d) => d.title === 'Midterm exam');
  assert.equal(midterm.matchedItem.key, 'event:41', 'matched to the Brightspace calendar event');
  assert.deepEqual(pendingReviews(syllabi, {}).map((d) => d.title), ['Final project demo']);

  const agenda = agendaItems(snapshot, syllabi, {});
  assert.ok(agenda.some((i) => i.source === 'syllabus' && i.title === 'Final project demo' && i.allDay));
  assert.ok(!agenda.some((i) => i.source === 'syllabus' && ['Project 1', 'Midterm exam'].includes(i.title)), 'dates Brightspace already has are not doubled');
  assert.ok(!calendarEvents(snapshot, syllabi, {}).some((e) => e.title.includes('Final project demo')), 'unconfirmed syllabus dates stay out of the calendar');

  const demo = syllabi[1600001].deadlines.find((d) => d.title === 'Final project demo');
  const confirmed = calendarEvents(snapshot, syllabi, { [demo.id]: 'confirmed' }).find((e) => e.title.includes('Final project demo'));
  assert.equal(confirmed.allDayDate, '2026-12-03');
  assert.equal(shortCourseLabel(snapshot.courses[0]), 'CS 25200');
});

test('a chosen file, an outside link and an uploaded syllabus are each handled', async () => {
  const file = docxBytes(SYLLABUS_PAGES.flatMap((p) => p.text.split('\n')));
  const downloads = [];
  const data = installChrome({
    tabs: [{ id: 5, url: 'https://purdue.brightspace.com/d2l/home', status: 'complete' }],
    sendMessage: async (_tabId, message) => {
      if (message.type === 'boilerspace-ping') return { ok: true };
      downloads.push(message.path);
      return { ok: true, result: { base64: Buffer.from(file).toString('base64'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', fileName: 'Notes.docx' } };
    },
  });
  data.genai = { key: 'sk-test', model: 'qwen3.8:27b' };
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(MODEL_OUTPUT) } }] }), { headers: { 'Content-Type': 'application/json' } });

  const snapshot = snapshotFixture();
  const ma = snapshot.data.find((d) => d.courseId === 1600002);
  ma.content = [
    { id: 90, courseId: 1600002, title: 'Syllabus', modulePath: ['Start'], type: 'Link', fileUrl: null, externalUrl: 'https://docs.google.com/document/d/x', url: 'https://purdue.brightspace.com/c/90', isHidden: false },
    { id: 91, courseId: 1600002, title: 'Week 1 notes.docx', modulePath: ['Week 1'], type: 'File', fileUrl: '/d2l/api/le/1.96/1600002/content/topics/91/file', url: 'https://purdue.brightspace.com/c/91', isHidden: false },
  ];
  const external = await processCourse(snapshot, 1600002, { now: new Date('2026-10-13T12:00:00Z') });
  assert.equal(external.status, 'external');
  assert.equal(downloads.length, 0);

  await chooseSyllabus(1600002, '91');
  const chosen = await processCourse(snapshot, 1600002, { now: new Date('2026-10-13T12:05:00Z') });
  assert.equal(chosen.status, 'done', chosen.error);
  assert.equal(chosen.chosen, true);
  assert.deepEqual(downloads, ['/d2l/api/le/1.96/1600002/content/topics/91/file']);

  const uploaded = await readUploadedSyllabus(snapshot, 1600002, { bytes: file, fileName: 'MA265 syllabus.docx', contentType: '' });
  assert.equal(uploaded.status, 'done');
  assert.equal(uploaded.source, 'upload');
  const kept = await processCourse(snapshot, 1600002, { force: true, now: new Date('2026-10-13T13:00:00Z') });
  assert.equal(kept.source, 'upload', 'an upload is not replaced by an automatic pick');
  assert.equal(downloads.length, 1);
});
