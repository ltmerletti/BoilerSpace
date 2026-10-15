// Links that land on the exact thing: a PDF opens at the cited page, everything else at its Brightspace page.

import { BRIGHTSPACE_ORIGIN } from './sync.js';

// The file_key read_course_file uses for a syllabus that was already read.
export function syllabusFileKey(record, snapshot) {
  if (!record) return null;
  const courseId = record.courseId ?? null;
  const id = record.topicId;
  if (id === 'overview' || id === 'overview-text') return courseId == null ? null : `overview:${courseId}`;
  if (typeof id === 'number' || (typeof id === 'string' && /^\d+$/.test(id))) return `content:${id}`;
  if (typeof id === 'string' && /^(tab:|content:|overview:)/.test(id)) return id;
  const data = snapshot?.data?.find((d) => d.courseId === courseId);
  const titled = data?.content?.find((t) => t.fileUrl && t.title === record.title);
  if (titled) return `content:${titled.id}`;
  if (data?.syllabusTab && (data.syllabusTab.fileUrl || data.syllabusTab.text)) return data.syllabusTab.id;
  if (data?.overview?.fileUrl || data?.overview?.text) return courseId == null ? null : `overview:${courseId}`;
  return null;
}

// Older syllabus records were saved before fileHref existed, so fall back to the synced topic.
export function syllabusFile(record, snapshot) {
  if (!record) return null;
  if (record.fileHref || !snapshot) return record;
  const topic = snapshot.data?.find((d) => d.courseId === record.courseId)?.content?.find((t) => t.id === record.topicId);
  return topic?.fileHref ? { ...record, fileHref: topic.fileHref } : record;
}

// file: { url, fileHref, kind }; location: a page label like "page 3".
export function locationUrl(file, location) {
  if (!file) return null;
  const page = /^page (\d+)$/.exec(location ?? '')?.[1];
  if (page && file.fileHref && (file.kind === 'pdf' || /\.pdf$/i.test(file.fileHref))) return `${BRIGHTSPACE_ORIGIN}${file.fileHref}#page=${page}`;
  return file.url ?? null;
}
