// Saves a benchmark capture: the synced course data plus the text of every course file, for testing the
// assistant offline. Grades, the student's name and contact details are left out.

import { currentCourses } from './planner.js';
import { readCourseFile } from './files.js';

const SKIP_EXTENSIONS = /\.(mp4|mov|m4v|avi|mkv|webm|mp3|m4a|wav|zip|rar|7z|png|jpe?g|gif|heic|exe|dmg)$/i;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /\(?\b\d{3}\)?[-. ]\d{3}[-. ]\d{4}\b/g;

export function scrub(value) {
  if (typeof value === 'string') return value.replace(EMAIL, '[email]').replace(PHONE, '[phone]');
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  return value;
}

function openableFiles(data, course) {
  const topics = (data.content ?? []).filter((t) => !t.isHidden && t.fileUrl && !SKIP_EXTENSIONS.test(t.title) && !SKIP_EXTENSIONS.test(t.fileHref ?? ''));
  if (data.overview?.fileUrl) topics.unshift({ id: 'overview', courseId: course.id, title: 'Course overview attachment', modulePath: [], fileUrl: data.overview.fileUrl });
  return topics;
}

export async function captureBenchmark({ snapshot, syllabi = {}, chats = [], onStatus = () => {}, readFile = readCourseFile }) {
  const courses = currentCourses(snapshot);
  const data = snapshot.data.filter((d) => courses.some((c) => c.id === d.courseId)).map(({ grades, ...rest }) => rest);
  const queue = data.flatMap((d) => openableFiles(d, courses.find((c) => c.id === d.courseId)));
  const files = [];
  for (const [i, topic] of queue.entries()) {
    onStatus(`Reading course files (${i + 1} of ${queue.length}): ${topic.title}`);
    const base = { courseId: topic.courseId, topicId: topic.id, title: topic.title, modulePath: topic.modulePath, fileHref: topic.fileHref ?? null };
    try {
      const { kind, pages, warning } = await readFile(topic, { syllabi });
      files.push({ ...base, kind, warning: warning ?? null, pages: pages.map(({ page, label, text }) => ({ page, label, text })) });
    } catch (err) {
      files.push({ ...base, error: err.message });
    }
  }
  const questions = chats.flatMap((chat) => chat.messages.filter((m) => m.role === 'user').map((m) => m.content));
  return scrub({
    version: 1,
    capturedAt: new Date().toISOString(),
    fetchedAt: snapshot.fetchedAt,
    origin: snapshot.origin,
    courses,
    data,
    syllabi: Object.fromEntries(courses.filter((c) => syllabi[c.id]).map((c) => [c.id, syllabi[c.id]])),
    files,
    questions,
  });
}
