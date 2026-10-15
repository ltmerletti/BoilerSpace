// Opens course files on request (for the assistant), reusing syllabus text that was already read.

import { extractText, pagePicture } from './extract.js';
import { downloadTopicFile } from './sync.js';

const MAX_CACHED_FILES = 12;
const cache = new Map();

const findSyllabusRecord = (syllabi, topic) =>
  Object.values(syllabi).find(
    (r) =>
      r?.status === 'done' &&
      r.topicId !== undefined &&
      r.topicId !== 'overview' &&
      r.topicId === topic.id &&
      (!topic.courseId || r.courseId === topic.courseId) &&
      r.pages?.length,
  );

async function loadText(topic, syllabi, download) {
  const record = findSyllabusRecord(syllabi, topic);
  if (record) return { kind: record.kind, pages: record.pages, warning: record.warning ?? null };
  if (topic.text) return { kind: 'text', pages: [{ page: 1, label: topic.textLabel ?? 'overview', text: topic.text }], warning: null };
  if (!topic.fileUrl) {
    const host = topic.externalUrl ? new URL(topic.externalUrl).hostname : null;
    throw new Error(host ? `This item links outside Brightspace (${host}), so it can't be opened here.` : 'This item is not a file that can be opened.');
  }
  const key = `${topic.courseId ?? ''}:${topic.id}|${topic.updatedAt ?? ''}`;
  if (!cache.has(key)) {
    const loading = download(topic.fileUrl, { open: false }).then((file) => (Array.isArray(file.pages) ? file : extractText(file)));
    cache.set(key, loading);
    loading.catch(() => cache.delete(key));
    while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export async function readCourseFile(topic, { syllabi = {}, download = downloadTopicFile, seeImages = false, location = null } = {}) {
  const text = await loadText(topic, syllabi, download);
  if (!seeImages || !location || !topic.fileUrl) return text;
  try {
    const extra = await download(topic.fileUrl, { open: false, seeImages: true, location });
    let images = extra.images ?? [];
    if (!images.length && extra.bytes) {
      const picture = await pagePicture(extra.bytes, location);
      if (picture) images = [picture];
    }
    return images.length ? { ...text, images } : text;
  } catch (err) {
    return { ...text, warning: [text.warning, `Pictures could not be opened (${err.message}).`].filter(Boolean).join(' ') };
  }
}

export function getCachedCourseFile(topic, { syllabi = {} } = {}) {
  const record = findSyllabusRecord(syllabi, topic);
  if (record) return Promise.resolve({ kind: record.kind, pages: record.pages, warning: record.warning ?? null });
  if (topic.text) return Promise.resolve({ kind: 'text', pages: [{ page: 1, label: 'overview', text: topic.text }], warning: null });
  const key = `${topic.courseId ?? ''}:${topic.id}|${topic.updatedAt ?? ''}`;
  return cache.get(key) ?? null;
}
