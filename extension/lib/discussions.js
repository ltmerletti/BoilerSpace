import { htmlToText } from './extract.js';

export const DISCUSSION_BATCH_SIZE = 30;
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

const text = (value) => htmlToText(String(value ?? '')).trim().slice(0, 40_000);
const staff = (role) => /^(staff|admin|instructor|teacher|tutor|ta)$/i.test(role ?? '');
const date = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;

export function matchDiscussionCourse(source, courses) {
  const raw = `${source.code ?? ''} ${source.name ?? ''}`.toUpperCase();
  const tokens = [...raw.matchAll(/\b([A-Z]{2,5})[.\s-]+(\d{3}(?:\d{2})?)\b/g)].map((m) => `${m[1]}${m[2].padEnd(5, '0')}`);
  const matches = courses.filter((course) => course.current && tokens.some((token) => {
    const label = `${course.code ?? ''} ${course.name ?? ''}`.toUpperCase();
    return [...label.matchAll(/\b([A-Z]{2,5})[.\s-]+(\d{3}(?:\d{2})?)\b/g)].some((m) => `${m[1]}${m[2].padEnd(5, '0')}` === token);
  }));
  return matches.length === 1 ? matches[0].id : null;
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
  const visit = (nodes, depth = 0) => {
    if (depth > 8) return;
    for (const node of nodes ?? []) {
      if (replies.length >= 100 || node.is_private || node.deleted_at) continue;
      replies.push({ id: String(node.id), text: text(node.content), role: role(node), endorsed: node.is_endorsed === true, createdAt: date(node.created_at) });
      visit(node.comments, depth + 1);
    }
  };
  visit(item.answers);
  visit(item.comments);
  return {
    id: String(item.id), key: `${source.id}:${item.id}`, sourceId: source.id, platform: 'ed',
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
  const visit = (nodes, depth = 0) => {
    if (depth > 8) return;
    for (const node of nodes ?? []) {
      if (replies.length >= 100 || ['deleted', 'private'].includes(node.status) || node.is_private || (node.tags ?? []).includes('private')) continue;
      const h = node.history?.[0] ?? node;
      if (h.content) replies.push({ id: String(node.id ?? replies.length), text: text(h.content), role: node.type === 'i_answer' ? 'instructor' : node.type === 's_answer' ? 'student' : 'unknown', endorsed: node.tag_good_prof === true, createdAt: date(h.created ?? node.created) });
      visit(node.children, depth + 1);
    }
  };
  visit(item.children);
  return {
    id: String(item.nr), key: `${source.id}:${item.nr}`, sourceId: source.id, platform: 'piazza',
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
