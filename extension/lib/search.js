// BM25 keyword search over synced course material. Small enough to rebuild on every question.

import { dueDisplay } from './dates.js';
import { shortCourseLabel } from './courses.js';
import { fileSourceKey, locationUrl, pageLocation, syllabusFile, syllabusFileKey } from './links.js';

const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const K1 = 1.2;
const B = 0.75;
const RELATIVE_CUTOFF = 0.35;

const STOPWORDS = new Set(
  'a an and are as at be but by can do does for from has have how i if in is it its me my of on or our so that the their them then there these this to was we what when where which who will with you your'.split(' '),
);

export function tokenize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t));
}

export function chunkText(text, { size = CHUNK_CHARS, overlap = CHUNK_OVERLAP } = {}) {
  if (text.length <= size) return [text];
  const chunks = [];
  for (let start = 0; start < text.length; start += size - overlap) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const space = text.lastIndexOf(' ', end);
      if (space > start + size / 2) end = space;
    }
    chunks.push(text.slice(start, end).trim());
    if (end >= text.length) break;
  }
  return chunks;
}

// docs: { id, courseId, kind, title, label, url, text }
export function buildIndex(docs, chunking = {}) {
  const entries = [];
  for (const doc of docs) {
    chunkText(doc.text ?? '', chunking).forEach((chunk, i) => {
      const tokens = tokenize(`${doc.title} ${chunk}`);
      if (!tokens.length) return;
      const tf = new Map();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      entries.push({ ...doc, chunkIndex: i, text: chunk, tf, length: tokens.length });
    });
  }
  const df = new Map();
  for (const e of entries) for (const t of e.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLength = entries.reduce((s, e) => s + e.length, 0) / (entries.length || 1);
  return { entries, df, avgLength };
}

export function search(index, query, { courseId = null, limit = 6, cutoff = RELATIVE_CUTOFF } = {}) {
  const terms = [...new Set(tokenize(query))];
  const pool = courseId ? index.entries.filter((e) => e.courseId === courseId) : index.entries;
  const n = index.entries.length;
  const scored = [];
  for (const entry of pool) {
    let score = 0;
    for (const term of terms) {
      const freq = entry.tf.get(term);
      if (!freq) continue;
      const df = index.df.get(term);
      const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
      score += (idf * freq * (K1 + 1)) / (freq + K1 * (1 - B + (B * entry.length) / index.avgLength));
    }
    if (score > 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  return scored
    .filter((s) => s.score >= top * cutoff)
    .slice(0, limit)
    .map(({ entry, score }) => ({ ...entry, tf: undefined, score: Math.round(score * 100) / 100 }));
}

function itemDetailsText(item) {
  const meta = [];
  if (item.dueAt) meta.push(`Due: ${dueDisplay(item.dueAt)}`);
  if (item.endAt) meta.push(`Available until: ${dueDisplay(item.endAt)}`);
  if (item.kind === 'assignment' && item.points != null) meta.push(`Points: ${item.points}`);
  if (item.kind === 'quiz') {
    if (item.timeLimitMinutes != null) meta.push(`Time limit: ${item.timeLimitMinutes} minutes`);
    if (item.attempts != null) meta.push(`Attempts allowed: ${item.attempts}`);
  }
  return [meta.join('. '), item.instructions ?? ''].filter(Boolean).join('\n');
}

export function documentsFromSnapshot(snapshot, syllabi = {}, { files = [] } = {}) {
  const docs = [];
  const courseName = new Map(snapshot.courses.map((c) => [c.id, shortCourseLabel(c)]));
  const fileLabel = (courseId, title) => {
    const course = courseName.get(courseId) ?? String(courseId);
    return title.toLowerCase().replace(/\s+/g, ' ').startsWith(course.toLowerCase()) ? title : `${course} ${title}`;
  };
  for (const data of snapshot.data) {
    const course = courseName.get(data.courseId);
    for (const item of [...data.assignments, ...data.quizzes]) {
      if (item.isHidden || item.isActive === false) continue;
      docs.push({
        id: `${item.kind}:${item.id}`,
        item_key: `${item.kind}:${item.id}`,
        courseId: data.courseId,
        kind: item.kind,
        title: item.title,
        label: `${course}: ${item.title}`,
        url: item.url,
        text: itemDetailsText(item),
      });
    }
    for (const a of data.announcements) {
      if (a.isHidden) continue;
      docs.push({ id: `announcement:${a.id}`, courseId: data.courseId, kind: 'announcement', title: a.title, label: `${course} announcement: ${a.title}`, url: a.url, text: a.body ?? '' });
    }
    if (data.syllabusTab && (data.syllabusTab.fileUrl || data.syllabusTab.text)) {
      docs.push({
        id: data.syllabusTab.id,
        file_key: data.syllabusTab.id,
        courseId: data.courseId,
        kind: 'content',
        title: data.syllabusTab.title,
        label: `${course} content: Syllabus`,
        url: data.syllabusTab.url,
        text: data.syllabusTab.text || 'syllabus',
      });
    }
    for (const t of data.content) {
      if (t.isHidden) continue;
      docs.push({ id: `content:${t.id}`, file_key: t.fileUrl ? `content:${t.id}` : undefined, courseId: data.courseId, kind: 'content', title: t.title, label: `${course} content: ${[...t.modulePath, t.title].join(' / ')}`, url: t.url, text: t.modulePath.join(' ') });
    }
  }
  const indexedSyllabusKeys = new Set();
  for (const [key, record] of Object.entries(syllabi)) {
    const usable = record?.status === 'done' ? record : record?.previous;
    if (!usable?.pages) continue;
    const courseId = usable.courseId ?? Number(key);
    const course = courseName.get(courseId);
    const file = syllabusFile(usable, snapshot);
    if (usable.topicId) indexedSyllabusKeys.add(`${courseId}:${usable.topicId}`);
    const fileKey = syllabusFileKey({ ...usable, courseId }, snapshot);
    for (const page of usable.pages) {
      docs.push({ id: `syllabus:${courseId}:${page.page}`, source_key: fileKey ? fileSourceKey(fileKey, page.label) : undefined, file_key: fileKey ?? undefined, location: pageLocation(page.label), courseId, kind: 'syllabus', title: usable.title, label: `${course} syllabus, ${pageLocation(page.label)}`, url: locationUrl(file, page.label), text: page.text });
    }
  }
  for (const f of files) {
    if (!f?.pages?.length || indexedSyllabusKeys.has(`${f.courseId}:${f.id}`)) continue;
    const fileKey = f.key ?? (f.id === 'overview' ? `overview:${f.courseId}` : `content:${f.id}`);
    const file = { ...f, key: fileKey };
    for (const page of f.pages) {
      if (!page.text) continue;
      docs.push({
        id: `file:${fileKey}:${page.label}`,
        source_key: fileSourceKey(fileKey, page.label),
        file_key: fileKey,
        courseId: f.courseId,
        kind: 'file',
        title: f.title,
        label: `${fileLabel(f.courseId, f.title)}, ${page.label}`,
        url: locationUrl(file, page.label),
        text: page.text,
        location: page.label,
      });
    }
  }
  return docs;
}
