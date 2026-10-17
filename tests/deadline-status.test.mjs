import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateIsQuoted, deadlineIssue } from '../extension/lib/deadline-status.js';
import { agendaItems, calendarEvents } from '../extension/lib/planner.js';
import { pendingReviews } from '../extension/lib/syllabus.js';
import { createTools } from '../extension/lib/agent.js';

test('automatic dates require an explicit matching date in the supporting source', () => {
  for (const quote of ['October 21 at 7 PM', 'Oct. 21st, 2026', 'October 21,2026', 'October 21, 11 AM', 'October 21, 11:00', '21 October 2026', 'Due 10/21/2026', 'Due 10/21/26', 'Due 10/21', '2026-10-21']) assert.equal(dateIsQuoted(quote, '2026-10-21'), true, quote);
  for (const quote of ['October 2', 'October 21, 2025', 'October 21,2025', 'October 21, 1999', 'October 21,25', 'Marketing 21', '10/21/25', '10/21/1999', '10/21/123', '2025-10-21', 'Next Wednesday at 7 PM', '7:00 PM']) assert.equal(dateIsQuoted(quote, '2026-10-21'), false, quote);
  assert.equal(dateIsQuoted('February 30, 2026', '2026-02-30'), false);
});

test('clear syllabus dates appear and export automatically while conflicts use the Brightspace date', () => {
  const date = { id: 'syl-1', courseId: 1, title: 'Midterm', kind: 'exam', date: '2026-10-21', time: null, quote: 'Midterm October 21', page: 'page 1' };
  const snapshot = { courses: [{ id: 1, current: true, name: 'CS 25000' }], data: [{ courseId: 1, assignments: [], quizzes: [], events: [] }] };
  const syllabi = { 1: { status: 'done', courseId: 1, deadlines: [date] } };
  assert.equal(deadlineIssue(date), null);
  assert.equal(pendingReviews(syllabi, {}, new Date('2026-10-01')).length, 0);
  assert.equal(agendaItems(snapshot, syllabi, {}).length, 1);
  assert.equal(calendarEvents(snapshot, syllabi, {})[0].allDayDate, '2026-10-21');
  date.matchedItem = { key: 'event:5', dueAt: '2026-10-22T18:00:00Z' };
  date.dateDiffers = true;
  snapshot.data[0].events.push({ id: 5, title: 'Midterm', startAt: date.matchedItem.dueAt });
  assert.equal(agendaItems(snapshot, syllabi, {}).length, 1, 'conflicting syllabus dates do not duplicate a Brightspace event');
  assert.equal(agendaItems(snapshot, syllabi, {})[0].dueAt, date.matchedItem.dueAt);
  assert.equal(pendingReviews(syllabi, {}, new Date('2026-10-01')).length, 1, 'the discrepancy remains inspectable');
});

test('contradictory or unquoted dates stay out automatically and existing explicit choices remain honored', () => {
  const date = { id: 'syl-1', courseId: 1, title: 'Demo', kind: 'presentation', date: '2026-12-03', time: null, weekdayMismatch: true, quote: 'Friday, December 4', page: 'page 1' };
  const syllabi = { 1: { status: 'done', courseId: 1, deadlines: [date] } };
  assert.equal(agendaItems(null, syllabi, {}).length, 0);
  assert.equal(calendarEvents(null, syllabi, {}).length, 0);
  assert.equal(calendarEvents(null, syllabi, { 'syl-1': 'confirmed' }).length, 1);
  assert.equal(calendarEvents(null, syllabi, { 'syl-1': 'dismissed' }).length, 0);
});

test('Ask receives the same source conflict and Brightspace preference as the agenda', async () => {
  const deadline = { id: 'syl-1', courseId: 1, title: 'Midterm', kind: 'exam', date: '2026-10-21', time: null, quote: 'Midterm October 21', page: 'page 1', dateDiffers: true, matchedItem: { key: 'event:5', dueAt: '2026-10-22T18:00:00Z' } };
  const tools = createTools({ snapshot: { courses: [{ id: 1, current: true, name: 'CS 25000' }], data: [] }, syllabi: {
    1: { status: 'done', courseId: 1, title: 'Syllabus', pages: [{ label: 'page 1', text: deadline.quote }], deadlines: [deadline], policies: { aiUse: { stance: 'unclear' }, grading: [] } },
  } });
  const facts = await tools.run('get_syllabus_facts', { course_id: 1 });
  assert.equal(facts.syllabus_dates[0].warning, deadlineIssue(deadline));
  assert.match(facts.syllabus_dates[0].brightspace_due_display, /22/);
});
