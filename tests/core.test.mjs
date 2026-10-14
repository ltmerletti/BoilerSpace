import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDaysToKey, dayKey, daysFromToday, dueDisplay, isValidDate, relativeDay, zonedToUtc } from '../extension/lib/dates.js';
import { buildCalendar, escapeText, foldLine } from '../extension/lib/ics.js';
import { diffSnapshots, mergeChanges } from '../extension/lib/changes.js';

test('wall-clock times in West Lafayette convert to UTC across DST', () => {
  assert.equal(zonedToUtc('2026-10-15', '09:00'), '2026-10-15T13:00:00.000Z');
  assert.equal(zonedToUtc('2026-12-01', '23:59'), '2026-12-02T04:59:00.000Z');
  // 2:30 AM does not exist on March 14, 2027, so it moves to 3:30 AM EDT.
  assert.equal(zonedToUtc('2027-03-14', '02:30'), '2027-03-14T07:30:00.000Z');
  // 1:30 AM happens twice on November 1, 2026; the first (EDT) one is used.
  assert.equal(zonedToUtc('2026-11-01', '01:30'), '2026-11-01T05:30:00.000Z');
  assert.throws(() => zonedToUtc('2026-02-30', '10:00'));
});

test('day keys and relative days use Indiana time, not UTC', () => {
  assert.equal(dayKey('2026-10-16T03:30:00Z'), '2026-10-15');
  const now = new Date('2026-10-13T16:00:00Z');
  assert.equal(daysFromToday('2026-10-16T03:30:00Z', now), 2);
  assert.equal(daysFromToday('2026-10-13', now), 0);
  assert.equal(relativeDay('2026-10-14T12:00:00Z', now), 'tomorrow');
  assert.equal(relativeDay('2026-10-10T12:00:00Z', now), '3 days ago');
  assert.equal(addDaysToKey('2026-12-31', 1), '2027-01-01');
  assert.equal(isValidDate('2027-02-29'), false);
});

test('due labels carry the correct weekday for the model to copy', () => {
  assert.match(dueDisplay('2026-10-15T13:00:00Z'), /^Thu, Oct 15, 2026, 9:00\sAM ET$/);
  assert.equal(dueDisplay('2026-10-22', { allDay: true }), 'Thu, Oct 22, 2026 (all day)');
  assert.equal(dueDisplay(null), null);
});

test('ICS text is escaped and long lines fold at 75 octets without splitting characters', () => {
  assert.equal(escapeText('a,b;c\\d\ne'), 'a\\,b\\;c\\\\d\\ne');
  const line = `SUMMARY:${'Café résumé '.repeat(12)}`;
  const folded = foldLine(line);
  const encoder = new TextEncoder();
  for (const part of folded.split('\r\n')) assert.ok(encoder.encode(part).length <= 75);
  assert.equal(folded.replace(/\r\n /g, ''), line);
});

test('calendar export writes timed events in UTC and all-day events as dates', () => {
  const ics = buildCalendar(
    [
      { uid: 'bs-1-assignment-9@boilerspace', title: 'CS 25200: Project 1, part A', start: '2026-10-16T03:59:00.000Z', url: 'https://purdue.brightspace.com/x' },
      { uid: 'syl-1-abc@boilerspace', title: 'CS 25200: Midterm', allDayDate: '2026-10-21' },
      { uid: 'syl-1-abc@boilerspace', title: 'duplicate', allDayDate: '2026-10-21' },
      { uid: 'no-date@boilerspace', title: 'no date' },
    ],
    { now: new Date('2026-10-13T12:00:00Z') },
  );
  assert.ok(ics.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(ics), 'every line ends in CRLF');
  assert.equal(ics.match(/BEGIN:VEVENT/g).length, 2);
  assert.match(ics, /DTSTART:20261016T035900Z\r\nDTEND:20261016T035900Z/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022/);
  assert.match(ics, /SUMMARY:CS 25200: Project 1\\, part A/);
  assert.match(ics, /DTSTAMP:20261013T120000Z/);
});

function snapshot({ assignments = [], quizzes = [], announcements = [], content = [] }, fetchedAt = '2026-10-13T12:00:00.000Z') {
  return { fetchedAt, data: [{ courseId: 1, assignments, quizzes, announcements, content, events: [], grades: [] }] };
}

test('changes: nothing on first sync, then new items, moved due dates, announcements and files', () => {
  const hw = { kind: 'assignment', id: 1, courseId: 1, title: 'HW 1', dueAt: '2026-10-16T03:59:00.000Z', url: 'u1' };
  const before = snapshot({ assignments: [hw], content: [{ id: 5, courseId: 1, title: 'Syllabus.pdf', updatedAt: '2026-08-20T00:00:00Z' }] });
  assert.deepEqual(diffSnapshots(null, before), []);

  const after = snapshot(
    {
      assignments: [{ ...hw, dueAt: '2026-10-18T03:59:00.000Z' }, { kind: 'assignment', id: 2, courseId: 1, title: 'HW 2', dueAt: null, url: 'u2' }, { kind: 'assignment', id: 3, courseId: 1, title: 'Hidden', isHidden: true }],
      quizzes: [{ kind: 'quiz', id: 7, courseId: 1, title: 'Draft quiz', isActive: false }],
      announcements: [{ id: 9, courseId: 1, title: 'Exam room', url: 'a9' }],
      content: [
        { id: 5, courseId: 1, title: 'Syllabus.pdf', updatedAt: '2026-10-12T00:00:00Z' },
        { id: 6, courseId: 1, title: 'Lecture 12.pdf', updatedAt: null },
      ],
    },
    '2026-10-13T13:00:00.000Z',
  );
  const changes = diffSnapshots(before, after);
  assert.deepEqual(changes.map((c) => c.type).sort(), ['announcement', 'due-changed', 'file-updated', 'new', 'new-file']);
  const moved = changes.find((c) => c.type === 'due-changed');
  assert.equal(moved.from, '2026-10-16T03:59:00.000Z');
  assert.equal(moved.to, '2026-10-18T03:59:00.000Z');

  const merged = mergeChanges(changes, diffSnapshots(before, after));
  assert.equal(merged.length, changes.length, 'the same change is not listed twice');
});
