// Loads a benchmark capture into the { snapshot, syllabi, readFile } shape expected by ask().

import { readFileSync } from 'node:fs';

export const DEFAULT_CAPTURE_PATH = new URL('./data/capture.json', import.meta.url);

export function buildCaptureEnv(capture) {
  const snapshot = {
    courses: capture.courses ?? [],
    data: capture.data ?? [],
    origin: capture.origin ?? 'https://purdue.brightspace.com',
    fetchedAt: capture.fetchedAt ?? capture.capturedAt ?? null,
  };
  const syllabi = capture.syllabi ?? {};

  const byCourseAndTopic = new Map();
  const byTopic = new Map();
  for (const file of capture.files ?? []) {
    byCourseAndTopic.set(`${file.courseId}:${file.topicId}`, file);
    if (file.topicId !== 'overview') {
      byTopic.set(String(file.topicId), file);
    }
  }

  async function readFile(topic, { syllabi: syl = syllabi } = {}) {
    if (!topic) throw new Error('No topic provided to readFile.');
    // Reuse already-extracted syllabus record when matching topicId + courseId, mirroring readCourseFile.
    const record = Object.values(syl ?? {}).find(
      (r) => r?.status === 'done' && r.topicId === topic.id && (!topic.courseId || r.courseId === topic.courseId) && r.pages?.length,
    );
    if (record) return { kind: record.kind, pages: record.pages, warning: record.warning ?? null };

    if (topic.text) {
      return { kind: 'text', pages: [{ page: 1, label: 'overview', text: topic.text }], warning: null };
    }

    const entry =
      (topic.courseId !== undefined ? byCourseAndTopic.get(`${topic.courseId}:${topic.id}`) : null) ??
      byTopic.get(String(topic.id)) ??
      null;

    if (!entry) {
      if (!topic.fileUrl) {
        const host = topic.externalUrl ? new URL(topic.externalUrl).hostname : null;
        throw new Error(host ? `This item links outside Brightspace (${host}), so it can't be opened here.` : 'This item is not a file that can be opened.');
      }
      throw new Error(`File not found in capture for topic ${topic.id} (course ${topic.courseId ?? 'unknown'}).`);
    }

    if (entry.error) {
      throw new Error(entry.error);
    }

    return {
      kind: entry.kind,
      pages: entry.pages ?? [],
      warning: entry.warning ?? null,
    };
  }

  return { capture, snapshot, syllabi, readFile };
}

export function loadCapture(path = DEFAULT_CAPTURE_PATH) {
  const capture = JSON.parse(readFileSync(path, 'utf8'));
  return buildCaptureEnv(capture);
}
