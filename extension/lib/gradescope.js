import { dueDisplay, isValidDate, isValidTime } from './dates.js';
import { DOMParser } from '../vendor/linkedom/worker.js';
import { matchDiscussionCourse } from './discussions.js';

export const GRADESCOPE_ORIGIN = 'https://www.gradescope.com';
export const GRADESCOPE_SITES = ['https://www.gradescope.com/*'];
export const GRADESCOPE_REFRESH_MS = 20 * 60_000;

// Parse only course headings, assignment headings and date elements. Never use
// a row's textContent: its submission-status cell can contain a student's score.
function documentFromHtml(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const node of doc.querySelectorAll('.submissionStatus, [class*="--score"], [class*="--grade"], script, style, input, textarea')) node.remove();
  return doc;
}
const text = node => node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

export function gradescopeDate(value) {
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*([+-]\d{2}):?(\d{2})$/.exec(value ?? '');
  if (!match || !isValidDate(match[1]) || !isValidTime(match[2].slice(0, 5)) || Number(match[2].slice(6)) > 59) return null;
  const iso = `${match[1]}T${match[2]}${match[3]}:${match[4]}`;
  return Number.isFinite(Date.parse(iso)) ? new Date(iso).toISOString() : null;
}

export function parseGradescopeCourses(html) {
  const doc = documentFromHtml(html);
  const list = doc.querySelector('.courseList');
  if (!list) throw new Error('Gradescope did not return the course list. Sign in to Gradescope and reconnect.');
  return [...list.querySelectorAll('a.courseBox[href]')].flatMap(anchor => {
    const id = /^\/courses\/(\d+)\/?$/.exec(anchor.getAttribute('href'))?.[1];
    if (!id) return [];
    const name = text(anchor.querySelector('.courseBox--shortname'));
    if (!name) return [];
    const group = anchor.closest('.courseList--coursesForTerm');
    const term = group?.previousElementSibling?.matches('.courseList--term') ? text(group.previousElementSibling) : '';
    return [{ id: `gradescope:${id}`, remoteId: id, name, title: text(anchor.querySelector('.courseBox--name')), term, url: `${GRADESCOPE_ORIGIN}/courses/${id}` }];
  });
}

export function linkGradescopeCourse(course, courses) {
  if (course.linkOrigin !== 'manual') {
    course.courseId = matchDiscussionCourse({ name: `${course.name} ${course.title ?? ''} ${course.term ?? ''}` }, courses);
    course.linkOrigin = 'automatic';
  }
  return course;
}

export function currentGradescopeCourse(course, courses, now = new Date()) {
  const term = /\b(Fall|Spring|Summer|Winter)\s+(20\d{2})\b/i.exec(course.term);
  if (!term) return Boolean(matchDiscussionCourse({ name: `${course.name} ${course.title ?? ''}` }, courses));
  const month = now.getMonth();
  const season = month < 5 ? 'spring' : month < 7 ? 'summer' : 'fall';
  return Number(term[2]) === now.getFullYear() && term[1].toLowerCase() === season;
}

export function parseGradescopeAssignments(html, course) {
  const doc = documentFromHtml(html);
  const table = doc.querySelector('#assignments-student-table');
  if (!table) throw new Error('Gradescope did not return the student assignment list. Saved assignments have been kept.');
  return [...table.querySelectorAll('tbody tr')].flatMap(row => {
    const heading = row.querySelector('th');
    const title = text(heading);
    if (!title || row.querySelector('.dataTables_empty')) return [];
    const href = heading?.querySelector('a[href]')?.getAttribute('href');
    const match = /^\/courses\/(\d+)\/assignments\/(\d+)(?:\/|$)/.exec(href ?? '');
    const assignmentId = match?.[1] === course.remoteId ? match[2] : null;
    const dates = [...row.querySelectorAll('time[datetime]')];
    const late = node => /^late\b/i.test(node.getAttribute('aria-label') ?? '') || /^late\b/i.test(text(node));
    const due = dates.find(node => node.classList.contains('submissionTimeChart--dueDate') && !late(node));
    const release = dates.find(node => node.classList.contains('submissionTimeChart--releaseDate'));
    const lateDue = dates.find(late);
    return [{
      key: `${course.id}:${assignmentId ?? `title-${encodeURIComponent(title)}`}`,
      assignmentId, sourceId: course.id, courseId: course.courseId ?? null, title,
      url: assignmentId ? `${course.url}/assignments/${assignmentId}` : course.url,
      dueAt: gradescopeDate(due?.getAttribute('datetime')),
      releaseAt: gradescopeDate(release?.getAttribute('datetime')),
      lateDueAt: gradescopeDate(lateDue?.getAttribute('datetime')),
    }];
  });
}

export function gradescopeAssignments(data, courseId = null) {
  return (data?.courses ?? []).filter(course => !courseId || course.courseId === courseId)
    .flatMap(course => (course.assignments ?? []).map(item => ({ ...item, courseId: course.courseId ?? null, courseName: course.name })));
}

export function gradescopeDocuments(data) {
  return gradescopeAssignments(data).map(item => ({
    id: item.key, item_key: item.key, courseId: item.courseId, kind: 'assignment', title: item.title,
    label: `Gradescope · ${item.courseName}: ${item.title}`, url: item.url,
    text: `${item.title}\n${item.dueAt ? `Due: ${dueDisplay(item.dueAt)}` : 'No due date published.'}${item.lateDueAt ? `\nLate submissions until: ${dueDisplay(item.lateDueAt)}` : ''}`,
  }));
}

export async function gradescopeRequest(action, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'boilerspace-gradescope', action, ...args });
  if (!response?.ok) throw Object.assign(new Error(response?.error ?? 'The Gradescope reader did not respond.'), { needsReconnect: response?.needsReconnect });
  return response.data;
}
