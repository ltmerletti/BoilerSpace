import { htmlToText } from './extract.js';

export const DISCUSSION_BATCH_SIZE = 30;
export const DISCUSSION_CAPTURE_VERSION = 2;
export const DISCUSSION_SITES = {
  ed: ['https://edstem.org/*', 'https://us.edstem.org/*'],
  piazza: ['https://piazza.com/*'],
};
export const discussionName = (platform) => platform === 'ed' ? 'Ed' : 'Piazza';

export function parseDiscussionUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter an Ed or Piazza course URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use an HTTPS course URL.');
  const ed = url.hostname === 'edstem.org' && /^\/us\/courses\/(\d+)(?:\/|$)/.exec(url.pathname);
  if (ed) return { id: `ed:${ed[1]}`, platform: 'ed', remoteId: ed[1], url: `https://edstem.org/us/courses/${ed[1]}/discussion` };
  const piazza = url.hostname === 'piazza.com' && /^\/class\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname);
  if (piazza) return { id: `piazza:${piazza[1]}`, platform: 'piazza', remoteId: piazza[1], url: `https://piazza.com/class/${piazza[1]}` };
  throw new Error('This beta supports US Ed course URLs and Piazza class URLs.');
}

const text = (value) => htmlToText(String(value ?? '')).trim();
const staff = (role) => /^(staff|admin|instructor|teacher|tutor|ta)$/i.test(role ?? '');
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

function similarWord(left, right) {
  if (left === right) return true;
  if (Math.min(left.length, right.length) < 5 || Math.abs(left.length - right.length) > 1 || left.slice(0, 3) !== right.slice(0, 3)) return false;
  let i = 0, j = 0, edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (left.length >= right.length) i++;
    if (right.length >= left.length) j++;
  }
  return edits + (i < left.length || j < right.length ? 1 : 0) <= 1;
}

// Iterative preorder preserves reply order without dropping deeply nested comments.
function* publicReplies(nodes, children, privateNode) {
  const stack = [...(nodes ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (privateNode(node)) continue;
    yield node;
    const nested = node[children] ?? [];
    for (let i = nested.length - 1; i >= 0; i--) stack.push(nested[i]);
  }
}

export function matchDiscussionCourse(source, courses) {
  const label = (item) => `${item.code ?? ''} ${item.name ?? ''}`.toUpperCase();
  const codes = (value) => [...value.matchAll(/\b([A-Z]{2,5})[.\s_-]*(\d{3}(?:\d{2})?)\b/g)].map((match) => `${match[1]}${match[2].padEnd(5, '0')}`);
  const term = (value) => /\b(FALL|SPRING|SUMMER|WINTER)[\s._-]+(20\d{2})\b/.exec(value)?.slice(1).join(' ');
  const raw = label(source), identifiers = codes(raw), sourceTerm = term(raw);
  const years = (value) => value.match(/\b20\d{2}\b/g) ?? [];
  const sourceYears = years(raw);
  const candidates = courses.filter(course => course.current && (!sourceTerm || !term(label(course)) || sourceTerm === term(label(course))) &&
    (!sourceYears.length || !years(label(course)).length || sourceYears.some(year => years(label(course)).includes(year))));
  if (identifiers.length) {
    const matches = candidates.filter(course => codes(label(course)).some(code => identifiers.includes(code)));
    // Never fuzzy-match course numbers or guess between sections of the same course.
    return matches.length === 1 ? matches[0].id : null;
  }
  const words = (value) => new Set(value.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/).filter(word => word.length > 2 && !/^(fall|spring|summer|winter|course|discussion|lecture|lec|merge|section|purdue|university|the|and|for|with)$/.test(word)));
  const sourceWords = words(raw);
  if (sourceWords.size < 2) return null;
  const ranked = candidates.map(course => {
    const courseWords = words(label(course)), common = [...sourceWords].filter(word => [...courseWords].some(candidate => similarWord(word, candidate))).length;
    return { course, score: common / Math.max(sourceWords.size, courseWords.size), common };
  }).sort((a, b) => b.score - a.score);
  return ranked[0]?.common >= 2 && ranked[0].score >= 0.8 && ranked[0].score - (ranked[1]?.score ?? 0) >= 0.2 ? ranked[0].course.id : null;
}

export function reconcileDiscussionCourse(source, courses) {
  if (source.linkOrigin === 'manual' || (source.courseId && !source.linkOrigin)) return;
  source.courseId = matchDiscussionCourse(source, courses);
  source.linkOrigin = 'automatic';
}

export function normalizeEdThread(payload, source) {
  const item = payload.thread;
  if (!item || String(item.course_id) !== source.remoteId || item.is_private || item.deleted_at) return null;
  const users = new Map((payload.users ?? []).map((u) => [u.id, u.course_role]));
  const role = (node) => {
    const value = users.get(node.user_id) ?? node.user?.course_role;
    return staff(value) ? 'instructor' : value === 'student' ? 'student' : 'unknown';
  };
  const replies = [];
  for (const node of publicReplies([...(item.answers ?? []), ...(item.comments ?? [])], 'comments', (node) => node.is_private || node.deleted_at)) {
    replies.push({ id: String(node.id), text: text(node.content), role: role(node), endorsed: node.is_endorsed === true, createdAt: date(node.created_at) });
  }
  return {
    id: String(item.id), key: `${source.id}:${item.id}`, sourceId: source.id, platform: 'ed', captureVersion: DISCUSSION_CAPTURE_VERSION,
    number: item.number, title: text(item.title), text: text(item.content), role: role(item),
    endorsed: item.is_endorsed === true, pinned: item.is_pinned === true,
    createdAt: date(item.created_at), updatedAt: date(item.updated_at), replies,
    url: `${source.url}/${item.id}`,
  };
}

export function normalizePiazzaThread(item, source) {
  if (!item || !Number.isInteger(item.nr) || ['deleted', 'private'].includes(item.status) || item.is_private || (item.tags ?? []).includes('private')) return null;
  const latest = item.history?.[0];
  if (!latest) return null;
  const replies = [];
  for (const node of publicReplies(item.children, 'children', (node) => ['deleted', 'private'].includes(node.status) || node.is_private || (node.tags ?? []).includes('private'))) {
    const h = node.history?.[0] ?? node;
    if (h.content) replies.push({ id: String(node.id ?? replies.length), text: text(h.content), role: node.type === 'i_answer' ? 'instructor' : node.type === 's_answer' ? 'student' : 'unknown', endorsed: node.tag_good_prof === true, createdAt: date(h.created ?? node.created) });
  }
  return {
    id: String(item.nr), key: `${source.id}:${item.nr}`, sourceId: source.id, platform: 'piazza', captureVersion: DISCUSSION_CAPTURE_VERSION,
    number: item.nr, title: text(latest.subject), text: text(latest.content),
    role: (item.tags ?? []).includes('instructor-note') ? 'instructor' : 'unknown',
    endorsed: item.tag_good_prof === true, pinned: item.is_pinned === true,
    createdAt: date(item.created ?? latest.created), updatedAt: date(latest.created ?? item.created), replies,
    url: `${source.url}?cid=${item.nr}`,
  };
}

export function discussionDocuments(discussions = { sources: [] }) {
  return (discussions.sources ?? []).flatMap((source) => (source.threads ?? []).map((thread) => ({
    id: `discussion:${thread.key}`, discussion_key: thread.key, courseId: source.courseId ?? null,
    kind: 'discussion', title: thread.title,
    label: `${discussionName(source.platform)} · ${source.name} · #${thread.number}: ${thread.title}`,
    url: thread.url,
    text: [`Posted: ${thread.createdAt ?? 'unknown'}. Author role: ${thread.role}.`, thread.text, ...(thread.replies ?? []).map((r) => `${r.role} reply${r.endorsed ? ' (endorsed)' : ''}: ${r.text}`)].join('\n\n'),
  })));
}

export async function discussionRequest(action, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'boilerspace-discussions', action, ...args });
  if (!response?.ok) throw new Error(response?.error ?? 'The discussion reader did not respond.');
  return response.data;
}
