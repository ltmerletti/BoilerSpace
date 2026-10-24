import { randomUUID } from 'node:crypto';
import { ProviderSession } from './providers.mjs';
import { CompanionError } from './errors.mjs';
import { digest } from './database.mjs';
import { readDiscussionSite } from '../../extension/lib/discussions-api.js';
import { createDiscussionSync } from '../../extension/lib/discussions-sync.js';
import { createGradescopeSync, fetchGradescopePage } from '../../extension/lib/gradescope-sync.js';

export function snapshotFromIndex(database) {
  const courses = database.courses();
  const text = source => database.pages(source.id).map(page => {
    let offset = 0, result, full = '';
    do { result = database.read(source.id, page.ordinal, offset); full += result.text; offset = result.nextOffset; } while (offset !== null);
    return full;
  }).join('\n');
  return { origin: 'https://purdue.brightspace.com', versions: database.get('sync')?.versions, courses, data: courses.map(course => {
    const sources = database.sources(course.id);
    const items = kind => sources.filter(source => source.kind === kind).map(source => ({ ...source.metadata, id: Number(source.id.split(':').at(-1)), kind,
      courseId: course.id, title: source.title, url: source.url, instructions: text(source), body: text(source), description: text(source) }));
    return { courseId: course.id, assignments: items('assignment'), quizzes: items('quiz'), announcements: items('announcement'), events: items('event'), grades: [],
      content: sources.filter(source => source.kind === 'file' && /^file:\d+:\d+$/.test(source.id)).map(source => ({ ...source.metadata, id: Number(source.id.split(':').at(-1)), courseId: course.id, title: source.title, url: source.url })),
      overview: (() => { const attachment = sources.find(source => source.id.endsWith(':overview-attachment')); const source = sources.find(source => source.id.endsWith(':overview')); return source || attachment ? { text: source ? text(source) : '', fileUrl: attachment?.metadata.fileUrl, hasAttachment: !!attachment } : null; })(),
      syllabusTab: database.get(`syllabus-source:${course.id}`),
    };
  }) };
}

function discussionRecords(data) {
  return (data?.sources ?? []).flatMap(source => (source.threads ?? []).map(thread => {
    const record = { id: `discussion:${source.courseId ?? 0}:${source.platform}_${source.remoteId}_${thread.id}`, courseId: source.courseId,
      title: thread.title, url: thread.url, metadata: { discussionKey: thread.key, platform: source.platform, integrationId: source.id, replyIds: thread.replies.map(reply => reply.id) },
      pages: [{ label: `post · ${thread.role}${thread.endorsed ? ' · endorsed' : ''}`, text: thread.text },
        ...thread.replies.map(reply => ({ label: `reply ${reply.id} · ${reply.role}${reply.endorsed ? ' · endorsed' : ''}`, text: reply.text }))] };
    return { ...record, revision: digest(record) };
  }));
}
function gradescopeRecords(data) {
  return (data?.courses ?? []).flatMap(source => (source.assignments ?? []).map(item => {
    const record = { id: `gradescope:${source.courseId ?? 0}:${source.remoteId}_${digest(item.key).slice(0, 20)}`, courseId: source.courseId,
      title: item.title, url: item.url, metadata: { integrationId: source.id, key: item.key, dueAt: item.dueAt, releaseAt: item.releaseAt, lateDueAt: item.lateDueAt },
      pages: [{ label: 'published assignment dates', text: `${item.title}\nRelease: ${item.releaseAt ?? 'not published'}\nDue: ${item.dueAt ?? 'not published'}\nLate cutoff: ${item.lateDueAt ?? 'not published'}` }] };
    return { ...record, revision: digest(record) };
  }));
}

export class Integrations {
  constructor(database, directory, { sessions = {}, reader = readDiscussionSite, now = () => new Date() } = {}) {
    this.database = database; this.directory = directory; this.sessions = sessions; this.reader = reader; this.now = now;
    const write = (key, value) => {
      database.set(key, value);
      if (key === 'discussions') database.replaceIntegration('discussion', discussionRecords(value));
      if (key === 'gradescope') database.replaceIntegration('gradescope', gradescopeRecords(value));
    };
    this.storage = {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, key === 'snapshot' ? snapshotFromIndex(database) : database.get(key)])),
      set: async values => database.transaction(() => {
        for (const [key, value] of Object.entries(values)) write(key, value);
      }),
      compareAndSet: async (key, expectedGeneration, value) => database.transaction(() => {
        if (database.get(key)?.generation !== expectedGeneration) throw new CompanionError('integration-changed', 'The integration changed during this import. Start a new import for its current connection.');
        write(key, value);
      }),
      remove: async key => this.storage.set({ [key]: null }),
    };
  }
  session(site) { return this.sessions[site] ??= new ProviderSession(this.directory, site); }
  status() {
    const discussions = this.database.get('discussions');
    const gradescope = this.database.get('gradescope');
    return { discussions: (discussions?.sources ?? []).map(({ threads, sync, ...source }) => ({ ...source, importing: !!sync, offset: sync?.offset, savedPosts: threads?.length ?? 0 })),
      gradescope: gradescope ? { status: gradescope.status, syncedAt: gradescope.lastSyncedAt, needsReconnect: gradescope.needsReconnect, error: gradescope.error,
        courses: gradescope.courses.map(({ assignments, ...course }) => ({ ...course, assignments: assignments.length })) } : null };
  }
  async run(job, signal, progress) {
    const site = job.args.platform;
    const session = this.session(site);
    const fetcher = (url, options) => session.fetch(url, options, signal);
    if (site === 'gradescope') {
      const sync = createGradescopeSync(route => fetchGradescopePage(route, fetcher), this.now, { storage: this.storage, hasAccess: async () => true });
      const data = await sync({ action: this.database.get('gradescope') ? 'sync' : 'connect', force: true });
      signal.throwIfAborted(); progress({ completed: data.courses.length, total: data.courses.length });
      if (data.status === 'error') throw new CompanionError(data.needsReconnect ? 'sign-in-required' : 'integration-failed', data.error);
      return;
    }
    const sync = createDiscussionSync(args => this.reader(args, { hasAccess: async () => true, fetchImpl: fetcher,
      getEdToken: () => session.edToken(false, signal), renewEdToken: (_, force) => session.edToken(force, signal), clearAuth: async () => {},
      sleep: ms => new Promise((resolve, reject) => { const abort = () => { clearTimeout(timer); reject(signal.reason); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort(); }),
    }), { storage: this.storage, clearAuth: async () => {} });
    let ids = job.args.sourceIds;
    if (!ids) ids = (await sync({ action: 'connect', platform: site, url: job.args.url })).connectedIds;
    let first = true, retries = 0;
    for (;;) {
      signal.throwIfAborted();
      const data = await sync({ action: 'sync', platform: site, sourceId: ids, force: first }); first = false;
      signal.throwIfAborted();
      const selected = data.sources.filter(source => ids.includes(source.id));
      progress({ completed: selected.reduce((sum, source) => sum + source.threads.length, 0) });
      const failed = selected.find(source => source.status === 'error');
      if (failed) {
        if (!failed.needsReconnect && /timeout|timed out|fetch failed|HTTP (?:429|5\d\d)/i.test(failed.error) && retries++ < 3) {
          failed.status = 'syncing'; failed.lastAttemptAt = null; failed.error = null;
          await this.storage.compareAndSet('discussions', data.generation, data);
          continue;
        }
        throw new CompanionError(failed.needsReconnect ? 'sign-in-required' : 'integration-failed', failed.error);
      }
      retries = 0;
      if (selected.every(source => source.historyComplete && !source.sync)) break;
    }
  }
  enqueue(args) {
    if (args.platform === 'gradescope' && (args.sourceIds || args.url)) throw new CompanionError('invalid-arguments', 'Gradescope imports current courses together. Omit sourceIds and url.');
    if (args.platform === 'ed' && args.url) throw new CompanionError('invalid-arguments', 'Ed discovers active courses from the signed-in account. Omit url.');
    if (args.sourceIds?.some(id => !this.database.get('discussions')?.sources.some(source => source.id === id && source.platform === args.platform))) throw new CompanionError('source-not-found', 'Choose source IDs from list_discussions for this platform.');
    return this.database.enqueue('integration', args);
  }
  async link({ platform, sourceId, courseId }) {
    if (courseId !== null && !this.database.courses().some(course => course.id === courseId)) throw new CompanionError('course-not-found', 'Choose a current Brightspace course, or null to unlink.');
    const key = platform === 'gradescope' ? 'gradescope' : 'discussions', data = this.database.get(key);
    const source = (platform === 'gradescope' ? data?.courses : data?.sources)?.find(source => source.id === sourceId && (platform === 'gradescope' || source.platform === platform));
    if (!source) throw new CompanionError('source-not-found', 'No integration has that source ID.');
    source.courseId = courseId; source.linkOrigin = 'manual'; data.generation = randomUUID();
    await this.storage.set({ [key]: data });
    return this.status();
  }
  async disconnect(platform) {
    const key = platform === 'gradescope' ? 'gradescope' : 'discussions', data = this.database.get(key);
    if (key === 'discussions' && data) { data.sources = data.sources.filter(source => source.platform !== platform); data.generation = randomUUID(); }
    await this.storage.set({ [key]: key === 'gradescope' ? null : data });
    await this.session(platform).logout();
    return this.status();
  }
}
