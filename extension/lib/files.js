// Opens course files on request (for the assistant), reusing syllabus text that was already read.

import { extractText } from './extract.js';
import { downloadTopicFile } from './sync.js';

const MAX_CACHED_FILES = 12;
const cache = new Map();

export async function readCourseFile(topic, { syllabi = {}, download = downloadTopicFile } = {}) {
  const record = Object.values(syllabi).find((r) => r?.status === 'done' && r.topicId === topic.id && r.pages?.length);
  if (record) return { kind: record.kind, pages: record.pages, warning: record.warning ?? null };
  if (topic.text) return { kind: 'text', pages: [{ page: 1, label: 'overview', text: topic.text }], warning: null };
  if (!topic.fileUrl) {
    const host = topic.externalUrl ? new URL(topic.externalUrl).hostname : null;
    throw new Error(host ? `This item links outside Brightspace (${host}), so it can't be opened here.` : 'This item is not a file that can be opened.');
  }
  const key = `${topic.id}|${topic.updatedAt ?? ''}`;
  if (!cache.has(key)) {
    const loading = download(topic.fileUrl, { open: false }).then(extractText);
    cache.set(key, loading);
    loading.catch(() => cache.delete(key));
    while (cache.size > MAX_CACHED_FILES) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}
