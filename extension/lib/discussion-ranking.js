import { tokenize } from './search.js';

export const DISCUSSION_CONTEXT_CHARS = 6000;

// Keep replies with their question, preserving roles in every indexed thread.
export function discussionPassages(discussions = { sources: [] }) {
  const entries = [];
  for (const source of discussions.sources ?? []) for (const thread of source.threads ?? []) {
    const messages = [{ text: thread.text, role: thread.role, endorsed: thread.endorsed }, ...(thread.replies ?? [])];
    let body = '';
    const spans = messages.map(message => {
      const prefix = `${message.role}${message.endorsed ? ' endorsed' : ''}: `;
      const start = body.length;
      body += `${prefix}${message.text ?? ''}\n\n`;
      return { id: message.id, start, textStart: start + prefix.length, end: body.length };
    });
    let chunkIndex = 0, firstSpan = 0;
    for (let start = 0; start < body.length;) {
      let end = Math.min(body.length, start + 1000);
      if (end < body.length) {
        const boundary = body.lastIndexOf(' ', end);
        if (boundary > start + 500) end = boundary;
      }
      const text = body.slice(start, end);
      while (firstSpan < spans.length && spans[firstSpan].end <= start) firstSpan++;
      const targets = [];
      for (let i = firstSpan; i < spans.length && spans[i].start < end; i++) {
        const span = spans[i];
        targets.push({ ...(span.id !== undefined ? { reply_id: span.id } : {}), offset: Math.max(0, start - span.textStart - 300) });
      }
      if (text.trim()) entries.push({ id: `discussion:${thread.key}`, discussion_key: thread.key, sourceId: source.id,
        courseId: source.courseId ?? null, kind: 'discussion', title: thread.title,
        label: `${source.name} #${thread.number}: ${thread.title}`, url: thread.url, text, chunkIndex: chunkIndex++,
        read_targets: targets });
      if (end === body.length) break;
      start = Math.max(start + 1, end - 150);
    }
  }
  return entries;
}

export function discussionIndex(entries) {
  const postings = new Map(), lengths = [];
  for (const [index, entry] of entries.entries()) {
    const frequencies = new Map();
    for (const token of [...tokenize(entry.text), ...tokenize(entry.title)]) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    lengths.push([...frequencies.values()].reduce((a, b) => a + b, 0));
    for (const [term, count] of frequencies) {
      if (!postings.has(term)) postings.set(term, []);
      postings.get(term).push([index, count]);
    }
  }
  const averageLength = lengths.reduce((a, b) => a + b, 0) / (entries.length || 1);
  const scoped = (index, { sourceId, courseId }) => (!sourceId || entries[index].sourceId === sourceId) && (courseId == null || entries[index].courseId === courseId);
  return {
    entries,
    keyword(query, scope = {}) {
      const scores = new Map();
      for (const term of new Set(tokenize(query))) {
        const list = postings.get(term) ?? [], idf = Math.log(1 + (entries.length - list.length + .5) / (list.length + .5));
        for (const [index, frequency] of list) {
          if (!scoped(index, scope)) continue;
          const value = idf * frequency * 2.2 / (frequency + 1.2 * (.25 + .75 * lengths[index] / averageLength));
          scores.set(index, (scores.get(index) ?? 0) + value);
        }
      }
      return [...scores].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([index]) => index);
    },
    rank(query, scope = {}, { encoder, vectors } = {}) {
      if (!String(query).trim()) return [];
      const keyword = this.keyword(query, scope);
      if (!encoder || !vectors) return keyword.map(i => entries[i]);
      const vector = encoder.encode(query), dims = encoder.dimensions;
      if (vectors.length !== entries.length * dims) throw new Error('Discussion vectors do not match the corpus.');
      if (!vector.some(v => v !== 0)) return keyword.map(i => entries[i]);
      const semantic = [];
      for (let index = 0; index < entries.length; index++) {
        if (!scoped(index, scope)) continue;
        let score = 0;
        for (let j = 0; j < dims; j++) score += vector[j] * vectors[index * dims + j];
        semantic.push([index, score]);
      }
      semantic.sort((a, b) => b[1] - a[1]);
      const fused = new Map();
      for (const ranking of [semantic.slice(0, 50).map(([index]) => index), keyword]) for (const [rank, index] of ranking.entries()) fused.set(index, (fused.get(index) ?? 0) + 1 / (10 + rank + 1));
      return [...fused].sort((a, b) => b[1] - a[1]).slice(0, 50).map(([index]) => entries[index]);
    },
  };
}

export function discussionContext(ranking) {
  let remaining = DISCUSSION_CONTEXT_CHARS;
  const result = [];
  for (const entry of ranking) {
    if (remaining < 80 || result.length === 12) break;
    const text = entry.text.slice(0, remaining);
    result.push({ ...entry, text }); remaining -= text.length;
  }
  return result;
}
