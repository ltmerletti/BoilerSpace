// Turns a sync snapshot plus syllabus results into the agenda the student sees.

import { dayKey, isValidDate, zonedToUtc } from './dates.js';
import { shortCourseLabel } from './courses.js';
import { usableRecord } from './syllabus.js';
import { locationUrl, syllabusFile } from './links.js';
import { deadlineIssue } from './deadline-status.js';

export { courseTitle, shortCourseLabel } from './courses.js';

export const isVisible = (item) => !item.isHidden && item.isActive !== false;

export const currentCourses = (snapshot) => (snapshot?.courses ?? []).filter((c) => c.current);

export function brightspaceItems(snapshot) {
  const out = [];
  const seenEvents = new Set();
  for (const data of snapshot?.data ?? []) {
    for (const item of [...data.assignments, ...data.quizzes]) {
      if (!isVisible(item) || !item.dueAt) continue;
      out.push({ key: `${item.kind}:${item.id}`, courseId: data.courseId, kind: item.kind, title: item.title, dueAt: item.dueAt, allDay: false, url: item.url, source: 'brightspace', item });
    }
    for (const event of data.events) {
      // Events linked to a dropbox folder or quiz duplicate the item itself.
      if (event.linkedTo || !event.startAt || seenEvents.has(event.id)) continue;
      seenEvents.add(event.id);
      out.push({ key: `event:${event.id}`, courseId: data.courseId, kind: 'event', title: event.title, dueAt: event.startAt, endAt: event.endAt, allDay: event.isAllDay, url: event.url ?? null, source: 'calendar', location: event.location });
    }
  }
  return out;
}

export function syllabusItems(syllabi, reviews = {}, snapshot = null) {
  const out = [];
  for (const record of Object.values(syllabi ?? {})) {
    const usable = usableRecord(record);
    if (!usable?.deadlines?.length) continue;
    const file = syllabusFile(usable, snapshot);
    for (const d of usable.deadlines) {
      const review = reviews[d.id];
      if (review === 'dismissed') continue;
      if (d.matchedItem && review !== 'confirmed') continue;
      if (deadlineIssue(d) && review !== 'confirmed') continue;
      out.push({
        key: d.id,
        courseId: d.courseId,
        kind: d.kind,
        title: d.title,
        dueAt: d.dueAt ?? zonedToUtc(d.date, '12:00'),
        allDay: !d.time,
        date: d.date,
        url: locationUrl(file, d.page),
        source: 'syllabus',
        confirmed: true,
        deadline: d,
      });
    }
  }
  return out;
}

export function agendaItems(snapshot, syllabi, reviews) {
  return [...brightspaceItems(snapshot), ...syllabusItems(syllabi, reviews, snapshot)].sort((a, b) => a.dueAt.localeCompare(b.dueAt));
}

export function itemDayKey(item) {
  return item.allDay && item.date && isValidDate(item.date) ? item.date : dayKey(item.dueAt);
}

export function groupByDay(items) {
  const groups = new Map();
  for (const item of items) {
    const key = itemDayKey(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

export function aiPolicyFor(syllabi, courseId) {
  return usableRecord(syllabi?.[courseId])?.policies?.aiUse ?? null;
}

export function calendarEvents(snapshot, syllabi, reviews) {
  const courses = new Map((snapshot?.courses ?? []).map((c) => [c.id, shortCourseLabel(c)]));
  return agendaItems(snapshot, syllabi, reviews)
    .filter((item) => item.source !== 'syllabus' || item.confirmed)
    .map((item) => {
      const label = courses.get(item.courseId) ?? '';
      const uid =
        item.source === 'syllabus' ? `${item.key}@boilerspace` : `bs-${item.courseId}-${item.key.replace(':', '-')}@boilerspace`;
      const kindWord = item.kind === 'event' ? '' : ` (${item.kind})`;
      const base = { uid, title: `${label}: ${item.title}${kindWord}`, url: item.url ?? undefined, location: item.location ?? undefined };
      if (item.allDay) return { ...base, allDayDate: itemDayKey(item) };
      return { ...base, start: item.dueAt, end: item.kind === 'event' ? item.endAt ?? item.dueAt : item.dueAt };
    });
}
