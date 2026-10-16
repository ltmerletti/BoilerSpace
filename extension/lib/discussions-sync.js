import { DISCUSSION_BATCH_SIZE, DISCUSSION_SITES, matchDiscussionCourse, normalizeEdThread, normalizePiazzaThread, parseDiscussionUrl } from './discussions.js';
import { readDiscussionSite } from './discussions-page.js';

let queue = Promise.resolve();
const pending = new Map();

async function readSite(platform, args) {
  const origins = DISCUSSION_SITES[platform];
  if (!origins || !(await chrome.permissions.contains({ origins }))) throw new Error(`Allow ${platform === 'ed' ? 'Ed' : 'Piazza'} access in Settings → Discussions (beta).`);
  const tabs = await chrome.tabs.query({ url: origins });
  const url = platform === 'ed' ? 'https://edstem.org/us/' : `https://piazza.com/class/${args.remoteId}`;
  let tab = tabs.find((t) => platform === 'ed' || new URL(t.url).pathname === `/class/${args.remoteId}`);
  const created = !tab;
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
  }
  try {
    if (created) await chrome.tabs.update(tab.id, { url });
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete') { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('The discussion page took too long to load. Sign in and retry.');
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readDiscussionSite, args: [{ platform, limit: DISCUSSION_BATCH_SIZE, ...args }] });
    if (result?.result?.error) throw new Error(result.result.error);
    if (!result?.result) throw new Error('The discussion site did not return data. Sign in and retry.');
    return result.result;
  } finally {
    if (created) await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

export function handleDiscussionRequest(message) {
  const key = JSON.stringify([message.action, message.platform, message.url, message.sourceId, message.courseId, message.force]);
  if (pending.has(key)) return pending.get(key);
  const task = queue.catch(() => {}).then(() => perform(message)).finally(() => pending.delete(key));
  queue = task;
  pending.set(key, task);
  return task;
}

async function perform({ action, platform, url, sourceId, courseId, force = false }) {
  const all = await chrome.storage.local.get(['discussions', 'snapshot']);
  if (!all.discussions && action !== 'connect') return { sources: [], pending: false };
  const data = all.discussions ?? { sources: [] };
  if (!data.generation) {
    data.generation = crypto.randomUUID();
    await chrome.storage.local.set({ discussions: data });
  }
  const save = async () => {
    const current = (await chrome.storage.local.get('discussions')).discussions;
    if (current?.generation !== data.generation) throw new Error('Discussion sync was cancelled because its saved data was cleared.');
    await chrome.storage.local.set({ discussions: data });
  };
  if (action === 'remove') {
    data.sources = data.sources.filter((s) => s.id !== sourceId);
    await save();
    return data;
  }
  if (action === 'link') {
    const source = data.sources.find((s) => s.id === sourceId);
    if (!source) throw new Error('Discussion course not found.');
    if (courseId !== null && !all.snapshot?.courses.some((c) => c.id === courseId && c.current)) throw new Error('Choose a current Brightspace course.');
    source.courseId = courseId;
    await save();
    return data;
  }
  if (action === 'connect') {
    let discovered;
    if (platform === 'ed') {
      const result = await readSite('ed', { discover: true });
      discovered = result.courses.map((c) => ({ ...parseDiscussionUrl(`https://edstem.org/us/courses/${c.remoteId}/discussion`), name: c.name, code: c.code }));
      if (!discovered.length) throw new Error('No active Ed courses were found in your account.');
    } else {
      const source = parseDiscussionUrl(url);
      if (source.platform !== 'piazza') throw new Error('Enter a Piazza class URL.');
      discovered = [{ ...source, name: 'Piazza course' }];
    }
    for (const source of discovered) {
      if (!data.sources.some((s) => s.id === source.id)) data.sources.push({ ...source, courseId: matchDiscussionCourse(source, all.snapshot?.courses ?? []), threads: [], status: 'connected' });
    }
    await save();
    return { ...data, connectedIds: discovered.map((s) => s.id) };
  } else if (action !== 'sync') throw new Error('Unknown discussion action.');

  const sources = data.sources.filter((s) => !sourceId || (Array.isArray(sourceId) ? sourceId.includes(s.id) : s.id === sourceId));
  if (force) {
    for (const source of sources) {
      // Resume a partial import; a completed history starts a fresh update sweep.
      if (!source.sync) source.sync = { offset: 0, seenIds: [], pageIds: [] };
      source.status = 'syncing';
      source.error = null;
    }
    await save();
  }
  const eligible = (s) => s.status === 'syncing' || !s.lastAttemptAt || Date.now() - Date.parse(s.lastAttemptAt) >= 20 * 60_000;
  const source = sources.find(eligible);
  if (!source) return { ...data, pending: false };
  source.sync ??= { offset: 0, seenIds: [], pageIds: [] };
  source.status = 'syncing';
  source.error = null;
  source.lastAttemptAt = new Date().toISOString();
  await save();
  try {
    const read = await readSite(source.platform, { remoteId: source.remoteId, offset: source.sync.offset,
      knownVersions: Object.fromEntries((source.threads ?? []).map((t) => [t.id, t.remoteVersion])) });
    if (!Array.isArray(read.pageIds) || !Array.isArray(read.seenIds) || !Number.isInteger(read.nextOffset) || read.nextOffset < source.sync.offset) throw new Error('The discussion reader returned an invalid page.');
    const previousPages = new Set(source.sync.pageIds);
    if (read.hasMore && !read.errors?.length && (!read.pageIds.length || read.pageIds.every((id) => previousPages.has(id)))) throw new Error('Discussion pagination stopped advancing. Your saved posts are kept; retry the import.');
    const normalize = source.platform === 'ed' ? normalizeEdThread : normalizePiazzaThread;
    const threads = new Map((source.threads ?? []).map((t) => [t.id, t]));
    const seen = new Set([...source.sync.seenIds, ...read.seenIds]);
    for (const payload of read.threads) {
      const id = String(source.platform === 'ed' ? payload.thread?.id : payload.nr);
      const thread = normalize(payload, source);
      if (thread) threads.set(id, { ...thread, remoteVersion: read.versions[id] });
      else { threads.delete(id); seen.delete(id); }
    }
    source.name = read.name || source.name;
    source.threads = [...threads.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    source.sync = { offset: read.nextOffset, seenIds: [...seen], pageIds: [...new Set([...source.sync.pageIds, ...read.pageIds])] };
    source.checkedCount = source.sync.pageIds.length;
    source.warning = null;
    if (read.errors?.length) throw new Error(read.errors[0]);
    if (!read.hasMore) {
      source.threads = source.threads.filter((t) => seen.has(t.id));
      source.lastSyncedAt = new Date().toISOString();
      source.historyComplete = true;
      source.sync = null;
      source.status = 'done';
      delete source.hasMore;
    }
  } catch (error) {
    source.status = 'error';
    source.error = error.message;
  }
  await save();
  return { ...data, pending: sources.some(eligible) };
}
