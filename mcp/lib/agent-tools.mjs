import { z } from 'zod';
import { createTools, AGENT_TOOLS } from '../../extension/lib/agent.js';
import { courseFiles } from '../../extension/lib/files.js';
import { readQuiz, findSyllabusTab } from '../../extension/lib/brightspace.js';
import { EXTRACTION_SCHEMA, validateExtraction } from '../../extension/lib/syllabus.js';
import { snapshotFromIndex } from './integrations.mjs';
import { CompanionError } from './errors.mjs';
import { workerRequest } from './worker.mjs';
import { digest } from './database.mjs';

export function sourceForTopic(database, topic) {
  return database.sources(topic.courseId, 'file').find(source => source.metadata.fileKey === topic.key || topic.key === `content:${source.id.split(':').at(-1)}` || topic.key === `overview:${topic.courseId}` && source.id.endsWith(':overview-attachment'));
}

export class AgentTools {
  constructor(service) { this.service = service; }
  async openFile(topic, { seeImages, location } = {}) {
    const { database, session } = this.service;
    let source = sourceForTopic(database, topic);
    if (!source && topic.text) return { kind: 'text', pages: [{ page: 1, label: topic.textLabel ?? 'overview', text: topic.text }] };
    if (!source) throw new CompanionError('source-not-found', 'List the current course files before opening a file.');
    if (seeImages) {
      if (!location) throw new CompanionError('invalid-arguments', 'Choose a page or slide in location to see its picture.');
      const pageNumber = Number(/(\d+)\s*$/.exec(location)?.[1]);
      if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > 2000) throw new CompanionError('invalid-arguments', 'Choose a page or slide numbered 1 to 2000.');
      const file = await (await session.client(AbortSignal.timeout(120000))).getFile(source.metadata.fileUrl);
      const rendered = await workerRequest(new URL('../workers/documents.mjs', import.meta.url), { ...file, fileName: file.fileName || source.title, operation: 'images', pageNumber });
      return { ...rendered, title: source.title, source: { url: source.url, sourceId: source.id, revision: source.revision } };
    }
    if (source.stale) {
      const job = this.service.indexCourse({ courseId: topic.courseId, sourceIds: [source.id] });
      let state;
      const deadline = Date.now() + 120000;
      do { await new Promise(resolve => setTimeout(resolve, 100)); state = database.job(job.id); }
      while (['queued', 'running'].includes(state.state) && !this.service.stopping && Date.now() < deadline);
      if (['queued', 'running'].includes(state.state)) throw new CompanionError('indexing-in-progress', `The file is still being indexed. Poll job_status for ${job.id}, then read it again.`, { jobId: job.id });
      if (state.state !== 'completed' || state.failures.length) throw new CompanionError('file-unavailable', state.failures[0]?.message ?? state.error?.message ?? 'The document could not be indexed.');
      source = database.source(source.id);
    }
    return { kind: /\.pptx?$/i.test(source.title) || database.pages(source.id)[0]?.label.startsWith('slide ') ? 'pptx' : 'pdf',
      warning: source.warning, pages: database.pages(source.id).map(page => {
        const parts = []; let offset = 0, result;
        do { result = database.read(source.id, page.ordinal, offset); parts.push(result.text); offset = result.nextOffset; } while (offset !== null);
        return { page: page.ordinal, label: page.label, text: parts.join('') };
      }) };
  }
  async run(name, args) {
    const { database } = this.service;
    const snapshot = snapshotFromIndex(database);
    if (name === 'read_course_file' && args.see_images) {
      const topic = snapshot.courses.flatMap(course => courseFiles(snapshot, course.id)).find(topic => topic.key === args.file_key);
      if (!topic) throw new CompanionError('source-not-found', 'Choose a file_key returned by list_course_files.');
      return this.openFile(topic, { seeImages: true, location: args.location });
    }
    const state = digest([database.get('corpusEpoch'), database.get('syllabi'), new Date().toLocaleDateString('en-US', { timeZone: 'America/Indiana/Indianapolis' })]);
    if (state !== this.state) {
      this.state = state;
      const syllabi = Object.fromEntries(Object.entries(database.get('syllabi') ?? {}).filter(([, record]) => { const source = database.source(record.sourceId); return source && !source.stale && source.contentHash === record.documentHash; }));
      this.tools = createTools({ snapshot, syllabi, discussions: database.get('discussions') ?? { sources: [] }, gradescope: database.get('gradescope'),
        readFile: (topic, options) => this.openFile(topic, options), cachedFile: () => null,
        readQuiz: async quiz => {
          const client = await this.service.session.client(AbortSignal.timeout(120000));
          return readQuiz(client, { courseId: quiz.courseId, quizId: quiz.id, le: snapshot.versions.le, dueAt: quiz.dueAt, endAt: quiz.endAt });
        } });
    }
    const result = await this.tools.run(name, args);
    if (result?.error) throw new CompanionError('tool-failed', result.error);
    // Citation IDs are scoped to this immutable snapshot, including across refreshes.
    const prefix = this.state.slice(0, 12);
    const relabel = value => Array.isArray(value) ? value.map(relabel) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, relabel(item)])) : typeof value === 'string' && /^S\d+$/.test(value) ? `${prefix}-${value}` : value;
    const sources = this.tools.sources.list.map(source => {
      if (!source.url?.startsWith('document.html')) return source;
      const topic = snapshot.courses.flatMap(course => courseFiles(snapshot, course.id)).find(topic => topic.key === source.file_key);
      return { ...source, url: topic?.url ?? null };
    });
    return { ...(Array.isArray(result) ? { items: relabel(result) } : relabel(result)), sources: relabel(sources) };
  }
  async discoverSyllabus(courseId, { refresh = false } = {}) {
    const { database, session } = this.service;
    this.service.course(courseId);
    const saved = database.source(`file:${courseId}:syllabus-tab`);
    const previous = database.get(`syllabus-source:${courseId}`);
    if (!refresh && saved && !saved.stale && previous) return { found: true, sourceId: saved.id, file_key: previous.id, title: saved.title, cached: true, indexedAt: saved.indexedAt };
    const versions = database.get('sync').versions;
    const topic = await findSyllabusTab(await session.client(AbortSignal.timeout(120000)), { courseId, ...versions, origin: 'https://purdue.brightspace.com',
      readTab: this.service.syllabusBrowser });
    if (!topic) {
      if (refresh && saved) database.transaction(() => {
        database.removePassages(saved.id);
        database.db.prepare('DELETE FROM sources WHERE id=?').run(saved.id);
        database.set(`syllabus-source:${courseId}`, null);
        database.set('corpusEpoch', (database.get('corpusEpoch') ?? 0) + 1);
      });
      return { found: false, note: 'No Syllabus tab was found. Use list_course_files to find an uploaded syllabus.' };
    }
    database.transaction(() => {
      database.set(`syllabus-source:${courseId}`, topic);
      const id = `file:${courseId}:syllabus-tab`;
      const metadata = { fileKey: topic.id, fileUrl: topic.fileUrl, inline: Boolean(topic.text) };
      const revision = digest([topic, metadata]);
      database.db.prepare(`INSERT INTO sources(id,course_id,kind,title,url,metadata,revision) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,revision=excluded.revision,url=excluded.url`).run(id, courseId, 'file', topic.title, topic.url, JSON.stringify(metadata), revision);
      if (topic.text) database.replacePages(id, revision, [{ label: topic.textLabel ?? 'Syllabus', text: topic.text }]);
      database.set('corpusEpoch', (database.get('corpusEpoch') ?? 0) + 1);
    });
    return { found: true, sourceId: `file:${courseId}:syllabus-tab`, file_key: topic.id, title: topic.title };
  }
  saveSyllabus({ course_id, source_id, document_hash, extraction }) {
    const { database } = this.service;
    const source = database.source(source_id);
    if (!source || source.courseId !== course_id || source.kind !== 'file' || source.stale || source.contentHash !== document_hash) throw new CompanionError('source-changed', 'Read the current syllabus document and pass its document hash before saving facts.');
    const pages = database.pages(source.id).map(page => {
      let offset = 0, result, text = '';
      do { result = database.read(source.id, page.ordinal, offset); text += result.text; offset = result.nextOffset; } while (offset !== null);
      return { page: page.ordinal, label: page.label, text };
    });
    const snapshot = snapshotFromIndex(database);
    const validated = validateExtraction(extraction, pages, { courseId: course_id, brightspaceItems: snapshot.data.filter(data => data.courseId === course_id).flatMap(data => [...data.assignments, ...data.quizzes]) });
    const record = { ...validated, status: 'done', courseId: course_id, sourceId: source.id, topicId: source.metadata.fileKey ?? (/^\d+$/.test(source.id.split(':').at(-1)) ? Number(source.id.split(':').at(-1)) : 'overview'), title: source.title,
      fileUrl: source.metadata.fileUrl, url: source.url, pages, documentHash: source.contentHash };
    database.set('syllabi', { ...(database.get('syllabi') ?? {}), [course_id]: record });
    return { saved: true, dropped: validated.dropped, note: 'Only quotes verified against the pinned syllabus text were retained.' };
  }
}

export function extensionToolRegistry(service) {
  const adapter = service.agentTools ??= new AgentTools(service);
  return Object.fromEntries(AGENT_TOOLS.map(({ function: tool }) => [tool.name, {
    description: tool.description, schema: z.fromJSONSchema(boundedSchema(tool.parameters)), run: args => adapter.run(tool.name, args),
  }]));
}
function boundedSchema(value) {
  if (Array.isArray(value)) return value.map(boundedSchema);
  if (!value || typeof value !== 'object') return value;
  const result = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, boundedSchema(item)]));
  if (result.type === 'string') result.maxLength ??= 2000;
  if (result.type === 'array') result.maxItems ??= 200;
  return result;
}
export const extractionSchema = z.fromJSONSchema(boundedSchema(EXTRACTION_SCHEMA));
