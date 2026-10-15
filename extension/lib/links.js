// Links that land on the exact thing: a PDF opens at the cited page, everything else at its Brightspace page.

import { BRIGHTSPACE_ORIGIN } from './sync.js';

export function pageLocation(location) {
  const value = String(location ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  const numbered = /^(page|slide|part)?\s*(\d+)$/.exec(value);
  return numbered ? `${numbered[1] || 'page'} ${Number(numbered[2])}` : value;
}

export const fileSourceKey = (fileKey, location) => `file:${fileKey}:${pageLocation(location)}`;

// The file_key read_course_file uses for a syllabus that was already read.
export function syllabusFileKey(record, snapshot) {
  if (!record) return null;
  const courseId = record.courseId ?? null;
  const id = record.topicId;
  if (record.source === 'upload' || id === 'upload') return null;
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
  const data = snapshot?.data?.find((d) => d.courseId === record.courseId);
  const key = syllabusFileKey(record, snapshot);
  const topic = key?.startsWith('overview:') ? data?.overview
    : data?.syllabusTab?.id === record.topicId ? data.syllabusTab
      : data?.content?.find((t) => String(t.id) === String(record.topicId));
  return { ...topic, ...record, fileHref: record.fileHref || topic?.fileHref, fileUrl: record.fileUrl || topic?.fileUrl, key };
}

// file: { url, fileHref, kind }; location: a page label like "page 3".
export function locationUrl(file, location) {
  if (!file) return null;
  const page = /^page (\d+)$/.exec(pageLocation(location))?.[1];
  if (page && file.fileHref && (file.kind === 'pdf' || /\.pdf$/i.test(file.fileHref))) return `${BRIGHTSPACE_ORIGIN}${file.fileHref}#page=${page}`;
  if (page && file.kind === 'pdf' && file.key && file.courseId) {
    const base = globalThis.chrome?.runtime?.getURL('document.html') ?? 'document.html';
    const params = new URLSearchParams({ course: String(file.courseId), file: file.key });
    return `${base}?${params}#page=${page}`;
  }
  return file.url ?? null;
}
