import { DISCUSSION_BATCH_SIZE, DISCUSSION_CAPTURE_VERSION, reconcileDiscussionCourse, normalizeEdThread, normalizePiazzaThread, parseDiscussionUrl } from './discussions.js';
import { readDiscussionSite } from './discussions-page.js';
import { acquireDiscussionReader, discussionReaderKey, releaseDiscussionReader, retainDiscussionReaders, settleDiscussionReader } from './discussion-readers.js';

let queue = Promise.resolve();
const pending = new Map();

async function readSite(platform, args) {
  const { tab, key } = await acquireDiscussionReader(platform, args);
  try {
    let ready = false;
    for (let i = 0; i < 120; i++) {
      const current = await chrome.tabs.get(tab.id);
      // Firefox may still report the initial about:blank as complete after update().
      // Injection must wait until the tab has committed to an allowed site.
      const currentUrl = new URL(current.url ?? 'about:blank');
      const allowed = currentUrl.protocol === 'https:' && (platform === 'ed' ? ['edstem.org', 'us.edstem.org'].includes(currentUrl.hostname) : currentUrl.hostname === 'piazza.com');
      if (current.status === 'complete' && allowed) { ready = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('The discussion page took too long to load. Sign in and retry.');
    await settleDiscussionReader(key, tab.id);
    const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', func: readDiscussionSite, args: [{ platform, limit: DISCUSSION_BATCH_SIZE, ...args }] });
    if (result?.result?.error) throw new Error(result.result.error);
    if (!result?.result) throw new Error('The discussion site did not return data. Sign in and retry.');
    return result.result;
  } catch (error) {
    await releaseDiscussionReader(key);
    throw error;
  } finally {
    if (args.discover) await releaseDiscussionReader(key);
  }
}

const eligible = source => source.status === 'syncing' || !source.lastAttemptAt || Date.now() - Date.parse(source.lastAttemptAt) >= 20 * 60_000;
const selected = (source, sourceId) => !sourceId || (Array.isArray(sourceId) ? sourceId.includes(source.id) : source.id === sourceId);

export function handleDiscussionRequest(message) {
  const sourceIds = message.sourceId ? [...new Set(Array.isArray(message.sourceId) ? message.sourceId : [message.sourceId])].sort() : null;
  const key = JSON.stringify([message.action, message.platform, message.url, sourceIds, message.courseId, Boolean(message.force)]);
  if (pending.has(key)) return pending.get(key);
  const task = queue.catch(() => {}).then(async () => {
    try {
      const result = await perform(message);
      if (message.action === 'sync' || message.action === 'remove') {
        const keep = result.sources.filter(source => source.status === 'syncing' || (message.action === 'sync' && selected(source, message.sourceId) && eligible(source)))
          .map(source => discussionReaderKey(source.platform, source.remoteId));
        await retainDiscussionReaders(keep, result.generation);
      }
      return result;
    } catch (error) {
      await retainDiscussionReaders([], null);
      throw error;
    }
  }).finally(() => pending.delete(key));
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
    source.linkOrigin = 'manual';
    await save();
    return data;
  }
  if (action === 'connect') {
    let discovered;
    if (platform === 'ed') {
      const result = await readSite('ed', { discover: true, generation: data.generation });
      discovered = result.courses.map((c) => ({ ...parseDiscussionUrl(`https://edstem.org/us/courses/${c.remoteId}/discussion`), name: c.name, code: c.code }));
      if (!discovered.length) throw new Error('No active Ed courses were found in your account.');
    } else {
      if (url) {
        const source = parseDiscussionUrl(url);
        if (source.platform !== 'piazza') throw new Error('Enter a Piazza class URL.');
        const result = await readSite('piazza', { remoteId: source.remoteId, discover: true, generation: data.generation });
        const course = result.courses.find(course => course.remoteId === source.remoteId);
        if (!course) throw new Error('Sign into Piazza and open this class in this browser, then retry.');
        discovered = [{ ...source, name: course.name }];
      } else {
        const result = await readSite('piazza', { discover: true, generation: data.generation });
        discovered = result.courses.map(course => ({ ...parseDiscussionUrl(`https://piazza.com/class/${course.remoteId}`), name: course.name }));
        if (!discovered.length) throw new Error('Open a Piazza class in this browser to connect it, or add its class link.');
      }
    }
    for (const source of discovered) {
      if (!data.sources.some((s) => s.id === source.id)) {
        reconcileDiscussionCourse(source, all.snapshot?.courses ?? []);
        data.sources.push({ ...source, threads: [], status: 'connected' });
      }
    }
    await save();
    return { ...data, connectedIds: discovered.map((s) => s.id) };
  } else if (action !== 'sync') throw new Error('Unknown discussion action.');

  const sources = data.sources.filter(source => selected(source, sourceId));
  const previousLinks = sources.map(source => [source.courseId, source.linkOrigin]);
  for (const source of sources) reconcileDiscussionCourse(source, all.snapshot?.courses ?? []);
  if (sources.some((source, index) => source.courseId !== previousLinks[index][0] || source.linkOrigin !== previousLinks[index][1])) await save();
  if (force) {
    for (const source of sources) {
      // Resume a partial import; a completed history starts a fresh update sweep.
      if (!source.sync) source.sync = { offset: 0, seenIds: [], pageIds: [] };
      source.status = 'syncing';
      source.error = null;
    }
    await save();
  }
  const source = sources.find(eligible);
  if (!source) return { ...data, pending: false };
  source.sync ??= { offset: 0, seenIds: [], pageIds: [] };
  source.status = 'syncing';
  source.error = null;
  source.lastAttemptAt = new Date().toISOString();
  await save();
  try {
    const read = await readSite(source.platform, { remoteId: source.remoteId, generation: data.generation, offset: source.sync.offset,
      // Reread older captures once, even if the site's version has not changed.
      knownVersions: Object.fromEntries((source.threads ?? []).filter((t) => t.captureVersion === DISCUSSION_CAPTURE_VERSION).map((t) => [t.id, t.remoteVersion])) });
    if (!Array.isArray(read.pageIds) || !Array.isArray(read.seenIds) || !Number.isInteger(read.nextOffset) || read.nextOffset < source.sync.offset) throw new Error('The discussion reader returned an invalid page.');
    const signature = JSON.stringify(read.pageIds);
    const pageSignatures = new Set(source.sync.pageSignatures ?? []);
    // Pinned posts can reappear in later pages. Only an identical ordered page
    // (or an empty page claiming more results) indicates a pagination loop.
    if (read.hasMore && !read.errors?.length && (!read.pageIds.length || pageSignatures.has(signature))) throw new Error('Discussion pagination stopped advancing. Your saved posts are kept; retry the import.');
    if (read.pageIds.length) pageSignatures.add(signature);
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
    reconcileDiscussionCourse(source, all.snapshot?.courses ?? []);
    source.threads = [...threads.values()].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    source.sync = { offset: read.nextOffset, seenIds: [...seen], pageIds: [...new Set([...source.sync.pageIds, ...read.pageIds])], pageSignatures: [...pageSignatures] };
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
    await releaseDiscussionReader(discussionReaderKey(source.platform, source.remoteId));
    source.status = 'error';
    source.error = error.message;
  }
  await save();
  return { ...data, pending: sources.some(eligible) };
}
