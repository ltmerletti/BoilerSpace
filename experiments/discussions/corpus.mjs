// Discussion-only representations. Character ranges keep answer labels independent of chunk size.
import { createHash } from 'node:crypto';

export function chunkRanges(text, { size = 900, overlap = 150, paragraphs = false } = {}) {
  if (!Number.isInteger(size) || size < 80 || !Number.isInteger(overlap) || overlap < 0 || overlap >= size) throw new Error('Invalid chunk size or overlap.');
  const ranges = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const boundary = paragraphs ? text.lastIndexOf('\n\n', end) : text.lastIndexOf(' ', end);
      if (boundary > start + size / 2) end = boundary;
    }
    ranges.push({ start, end });
    if (end === text.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return ranges;
}

export function discussionCorpus(discussions, options = {}) {
  const { unit = 'thread', questionChars = 240 } = options;
  if (!['thread', 'message'].includes(unit)) throw new Error('Unknown discussion representation.');
  const entries = [];
  for (const source of discussions.sources ?? []) for (const thread of source.threads ?? []) {
    const messages = [{ id: 'root', text: thread.text, role: thread.role, endorsed: thread.endorsed }, ...(thread.replies ?? [])];
    let chunkIndex = 0;
    const append = (body, segments, prefix = '', prefixSegments = [], role = thread.role) => {
      for (const { start, end } of chunkRanges(body, options)) {
        const own = segments.flatMap((segment) => {
          const from = Math.max(start, segment.textStart), to = Math.min(end, segment.textEnd);
          return to > from ? [{ ...segment, start: segment.start + from - segment.textStart,
            end: segment.start + to - segment.textStart, textStart: prefix.length + from - start, textEnd: prefix.length + to - start }] : [];
        });
        const text = prefix + body.slice(start, end);
        if (!text.trim()) continue;
        entries.push({ id: `discussion:${thread.key}`, discussion_key: thread.key, sourceId: source.id,
          courseId: source.courseId ?? null, kind: 'discussion', title: thread.title, label: `${source.name} #${thread.number}: ${thread.title}`,
          url: thread.url, text, role, createdAt: thread.createdAt, chunkIndex: chunkIndex++,
          segments: [...prefixSegments, ...own], platform: source.platform });
      }
    };
    if (unit === 'thread') {
      let text = '';
      const segments = [];
      for (const message of messages) {
        text += `${message.role}${message.endorsed ? ' endorsed' : ''}: `;
        const start = text.length;
        text += message.text ?? '';
        segments.push({ threadKey: thread.key, messageId: String(message.id), start: 0, end: (message.text ?? '').length, textStart: start, textEnd: text.length });
        text += '\n\n';
      }
      append(text, segments);
    } else {
      for (const message of messages) {
        const isReply = message.id !== 'root';
        const question = isReply ? (thread.text ?? '').slice(0, questionChars) : '';
        const prefix = question ? `Question: ${question}\n${message.role}${message.endorsed ? ' endorsed' : ''} reply: ` : `${message.role}: `;
        const prefixSegments = question ? [{ threadKey: thread.key, messageId: 'root', start: 0,
          end: question.length, textStart: 'Question: '.length, textEnd: 'Question: '.length + question.length }] : [];
        const body = message.text ?? '';
        append(body, [{ threadKey: thread.key, messageId: String(message.id), start: 0, end: body.length, textStart: 0, textEnd: body.length }], prefix, prefixSegments, message.role);
      }
    }
  }
  return entries;
}

export function resolveCases(discussions, cases) {
  const threads = new Map((discussions.sources ?? []).flatMap((s) => (s.threads ?? []).map((t) => [t.key, t])));
  const sourceOfThread = new Map((discussions.sources ?? []).flatMap((s) => (s.threads ?? []).map((t) => [t.key, s.id])));
  return cases.map((item) => ({ ...item, expected: item.expected.map((evidence) => {
    const thread = threads.get(evidence.threadKey);
    if (!thread) throw new Error(`Missing expected thread for ${item.id}`);
    if (item.sourceId && sourceOfThread.get(evidence.threadKey) !== item.sourceId) throw new Error(`Expected answer is outside the search scope for ${item.id}`);
    const messageId = String(evidence.messageId);
    const message = messageId === 'root' ? { text: thread.text } : thread.replies.find((r) => String(r.id) === messageId);
    const start = message?.text.indexOf(evidence.quote) ?? -1;
    if (start < 0 || !evidence.quote.length) throw new Error(`Missing expected answer span for ${item.id}`);
    return { ...evidence, messageId, start, end: start + evidence.quote.length };
  }) }));
}

export function effectiveQuery(item, mode = 'raw') {
  const history = mode === 'history' ? (item.history ?? []).filter((m) => m.role === 'user').slice(-2).map((m) => m.content) : [];
  return [...history, item.query].join('\n');
}

function covered(evidence, selected) {
  const intervals = selected.flatMap(({ entry, chars }) => entry.segments.flatMap((segment) => {
    if (segment.threadKey !== evidence.threadKey || segment.messageId !== evidence.messageId) return [];
    const end = Math.min(chars, segment.textEnd);
    return end > segment.textStart ? [[segment.start, segment.start + end - segment.textStart]] : [];
  })).sort((a, b) => a[0] - b[0]);
  let through = evidence.start;
  for (const [start, end] of intervals) {
    if (start > through) break;
    if (end > through) through = end;
    if (through >= evidence.end) return true;
  }
  return false;
}

export function contextSelection(ranking, { budget = 6000, maxChunks = 6, diversify = false } = {}) {
  let remaining = budget;
  const selected = [], threads = new Set();
  const candidates = diversify ? [...ranking.filter((e) => { if (threads.has(e.discussion_key)) return false; threads.add(e.discussion_key); return true; }),
    ...ranking.filter((e) => ranking.find((first) => first.discussion_key === e.discussion_key) !== e)] : ranking;
  for (const entry of candidates) {
    if (remaining < 80 || selected.length === maxChunks) break;
    const chars = Math.min(entry.text.length, remaining);
    selected.push({ entry, chars });
    remaining -= chars;
  }
  return selected;
}

export function evaluateRanking(item, ranking, options = {}) {
  if (!item.expected?.length) throw new Error(`No answer evidence for ${item.id}. Keep diagnostics separate.`);
  const first = (limit) => ranking.slice(0, limit).map((entry) => ({ entry, chars: entry.text.length }));
  const hit = (selected) => item.expected.filter((e) => covered(e, selected)).length;
  const context = contextSelection(ranking, options), found = hit(context);
  const rank = ranking.findIndex((entry) => hit([{ entry, chars: entry.text.length }]) > 0) + 1;
  return { id: item.id, kind: item.kind, sourceId: item.sourceId, rank,
    hitAt1: Number(hit(first(1)) > 0), hitAt5: Number(hit(first(5)) > 0), hitAt10: Number(hit(first(10)) > 0),
    allEvidenceAt5: Number(hit(first(5)) === item.expected.length),
    allEvidenceInContext: Number(found === item.expected.length), evidenceRecallInContext: found / item.expected.length,
    contextChars: context.reduce((sum, c) => sum + c.chars, 0) };
}

export function summarize(rows) {
  const average = (key) => rows.length ? rows.reduce((sum, row) => sum + row[key], 0) / rows.length : 0;
  return { cases: rows.length, hitAt1: average('hitAt1'), hitAt5: average('hitAt5'), hitAt10: average('hitAt10'),
    mrrAt10: rows.length ? rows.reduce((sum, r) => sum + (r.rank > 0 && r.rank <= 10 ? 1 / r.rank : 0), 0) / rows.length : 0,
    allEvidenceAt5: average('allEvidenceAt5'), allEvidenceInContext: average('allEvidenceInContext'),
    evidenceRecallInContext: average('evidenceRecallInContext'), meanContextChars: average('contextChars') };
}

export function partitionCases(items) {
  const parents = new Map();
  const find = (key) => {
    if (!parents.has(key)) parents.set(key, key);
    const parent = parents.get(key);
    if (parent !== key) parents.set(key, find(parent));
    return parents.get(key);
  };
  for (const item of items) {
    const keys = item.expected.map((e) => e.threadKey);
    for (const key of keys) {
      const roots = [find(keys[0]), find(key)].sort();
      parents.set(roots[1], roots[0]);
    }
  }
  return items.map((item) => ({ ...item, partition: createHash('sha256').update(find(item.expected[0].threadKey)).digest()[0] % 4 === 0 ? 'validation' : 'development' }));
}
