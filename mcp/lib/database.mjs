import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync } from 'node:fs';
import { CompanionError } from './errors.mjs';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const parse = value => value ? JSON.parse(value) : null;
const LEASE_MS = 120_000;

export class CourseDatabase {
  constructor(file, { now = () => Date.now() } = {}) {
    this.now = now;
    if (file !== ':memory:' && existsSync(file) && lstatSync(file).isSymbolicLink()) throw new CompanionError('unsafe-directory', 'The index cannot be a symbolic link.');
    this.db = new DatabaseSync(file);
    if (this.db.prepare('PRAGMA user_version').get().user_version > 1) { this.db.close(); throw new CompanionError('index-version', 'This index was created by a newer companion. Upgrade before opening it.'); }
    if (file !== ':memory:' && process.platform !== 'win32') chmodSync(file, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS courses(id INTEGER PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY, course_id INTEGER NOT NULL, kind TEXT NOT NULL,
        title TEXT NOT NULL, url TEXT NOT NULL, metadata TEXT NOT NULL, revision TEXT NOT NULL,
        indexed_revision TEXT, content_hash TEXT, indexed_at TEXT, warning TEXT);
      CREATE TABLE IF NOT EXISTS pages(id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, label TEXT NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL,
        UNIQUE(source_id,ordinal));
      CREATE VIRTUAL TABLE IF NOT EXISTS passages USING fts5(text, source_id UNINDEXED, ordinal UNINDEXED, start UNINDEXED, tokenize='unicode61 remove_diacritics 2');
      CREATE TABLE IF NOT EXISTS vectors(passage_id INTEGER PRIMARY KEY, model TEXT NOT NULL, vector BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, args TEXT NOT NULL,
        state TEXT NOT NULL, cursor INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL DEFAULT 0,
        failures TEXT NOT NULL DEFAULT '[]', owner TEXT, lease_until INTEGER, cancelled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS sources_course ON sources(course_id,kind);
      CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state,lease_until);`);
    this.db.exec('PRAGMA user_version=1');
  }

  close() { this.db.close(); }
  get(key) { return parse(this.db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value); }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(key, JSON.stringify(value)); }
  transaction(write) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = write(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  courses() { return this.db.prepare('SELECT data FROM courses ORDER BY id').all().map(row => parse(row.data)); }
  sources(courseId = null, kind = null) {
    return this.db.prepare('SELECT * FROM sources WHERE (? IS NULL OR course_id=?) AND (? IS NULL OR kind=?) ORDER BY title,id').all(courseId, courseId, kind, kind).map(row => this.sourceResult(row));
  }
  source(id) { return this.sourceResult(this.db.prepare('SELECT * FROM sources WHERE id=?').get(id)); }
  sourceResult(row) {
    if (!row) return null;
    return { id: row.id, courseId: row.course_id, kind: row.kind, title: row.title, url: row.url, metadata: parse(row.metadata), revision: row.revision,
      indexedRevision: row.indexed_revision, contentHash: row.content_hash, indexedAt: row.indexed_at, warning: row.warning,
      stale: row.indexed_revision !== row.revision };
  }

  // Publish one coherent snapshot. Failed sections retain their previous sources;
  // successful sections remove deleted material and its search passages together.
  publish(snapshot, records) {
    this.transaction(() => {
      const currentIds = new Set(snapshot.courses.filter(course => course.current).map(course => course.id));
      const incoming = new Set(records.map(record => record.id));
      const failed = new Set(snapshot.errors.map(error => `${error.courseId}:${error.section}`));
      const section = { file: 'content', assignment: 'assignments', quiz: 'quizzes', announcement: 'announcements', event: 'calendar' };
      for (const existing of this.sources()) {
        if (incoming.has(existing.id)) continue;
        const sourceSection = existing.id.endsWith(':overview') || existing.id.endsWith(':overview-attachment') ? 'overview' : section[existing.kind];
        if (currentIds.has(existing.courseId) && failed.has(`${existing.courseId}:${sourceSection}`)) continue;
        this.removePassages(existing.id);
        this.db.prepare('DELETE FROM sources WHERE id=?').run(existing.id);
      }
      this.db.exec('DELETE FROM courses');
      for (const course of snapshot.courses.filter(course => course.current)) this.db.prepare('INSERT INTO courses VALUES (?,?)').run(course.id, JSON.stringify(course));
      for (const record of records) {
        const previous = this.source(record.id);
        this.db.prepare(`INSERT INTO sources(id,course_id,kind,title,url,metadata,revision) VALUES (?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET course_id=excluded.course_id,kind=excluded.kind,title=excluded.title,url=excluded.url,metadata=excluded.metadata,revision=excluded.revision`)
          .run(record.id, record.courseId, record.kind, record.title, record.url, JSON.stringify(record.metadata), record.revision);
        if (previous && previous.revision !== record.revision) {
          this.removePassages(record.id);
          this.db.prepare('DELETE FROM pages WHERE source_id=?').run(record.id);
        }
        if (record.text !== undefined && previous?.indexedRevision !== record.revision) this.replacePages(record.id, record.revision, [{ page: 1, label: 'posted instructions', text: record.text }]);
      }
      this.set('sync', { at: new Date(this.now()).toISOString(), errors: snapshot.errors, versions: snapshot.versions, revision: digest(records.map(record => [record.id, record.revision])) });
      this.set('corpusEpoch', (this.get('corpusEpoch') ?? 0) + 1);
    });
  }

  replacePages(id, revision, pages, warning = null) {
    const source = this.source(id);
    if (!source || source.revision !== revision) throw new CompanionError('source-changed', 'The source changed during indexing. Retry with the current course snapshot.');
    this.removePassages(id);
    this.db.prepare('DELETE FROM pages WHERE source_id=?').run(id);
    for (const [index, page] of pages.entries()) {
      this.db.prepare('INSERT INTO pages(source_id,ordinal,label,text,hash) VALUES (?,?,?,?,?)').run(id, index + 1, page.label, page.text, digest(page.text));
      for (let start = 0; start < page.text.length; start += 750) {
        this.db.prepare('INSERT INTO passages(text,source_id,ordinal,start) VALUES (?,?,?,?)').run(`${source.title}\n${page.text.slice(start, start + 900)}`, id, index + 1, start);
      }
    }
    this.db.prepare('UPDATE sources SET indexed_revision=?,content_hash=?,indexed_at=?,warning=? WHERE id=?')
      .run(revision, digest(pages.map(page => [page.label, page.text])), new Date(this.now()).toISOString(), warning, id);
  }

  savePages(id, revision, pages, warning) { this.transaction(() => { this.replacePages(id, revision, pages, warning); this.set('corpusEpoch', (this.get('corpusEpoch') ?? 0) + 1); }); }
  removePassages(id) {
    this.db.prepare('DELETE FROM vectors WHERE passage_id IN (SELECT rowid FROM passages WHERE source_id=?)').run(id);
    this.db.prepare('DELETE FROM passages WHERE source_id=?').run(id);
  }
  unembedded(limit = 32, model = null) {
    return this.db.prepare('SELECT rowid AS id,text FROM passages WHERE rowid NOT IN (SELECT passage_id FROM vectors WHERE ? IS NULL OR model=?) LIMIT ?').all(model, model, limit);
  }
  saveVectors(records, model) {
    this.transaction(() => {
      for (const record of records) {
        // Verify the text too: a concurrent sync can replace an FTS rowid.
        const current = this.db.prepare('SELECT text FROM passages WHERE rowid=?').get(record.id);
        if (current?.text === record.text) this.db.prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?)').run(record.id, model, Buffer.from(record.vector.buffer, record.vector.byteOffset, record.vector.byteLength));
      }
    });
  }
  vectorSearch(vector, model, { courseId = null, limit = 40 } = {}) {
    const rows = this.db.prepare(`SELECT passages.source_id,passages.ordinal,passages.start,passages.text,vector,pages.label,pages.hash
      FROM vectors JOIN passages ON passages.rowid=vectors.passage_id JOIN sources ON sources.id=passages.source_id
      JOIN pages ON pages.source_id=passages.source_id AND pages.ordinal=passages.ordinal
      WHERE vectors.model=? AND sources.indexed_revision=sources.revision AND (? IS NULL OR sources.course_id=?)`).iterate(model, courseId, courseId);
    const best = [];
    for (const row of rows) {
      const stored = new DataView(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength);
      if (stored.byteLength !== vector.length * 4) continue;
      let similarity = 0;
      for (let index = 0; index < vector.length; index++) similarity += vector[index] * stored.getFloat32(index * 4, true);
      best.push({ ...row, vector: undefined, similarity });
      best.sort((a, b) => b.similarity - a.similarity);
      if (best.length > limit) best.pop();
    }
    return best.map(row => ({ source: this.evidence(this.source(row.source_id), row.ordinal, row.label, row.hash), text: row.text, offset: row.start, score: row.similarity }));
  }
  pages(id) { return this.db.prepare('SELECT ordinal,label,length(text) AS characters,hash FROM pages WHERE source_id=? ORDER BY ordinal').all(id); }
  read(id, ordinal, offset = 0, limit = 12000) {
    const page = this.db.prepare('SELECT sources.*,pages.ordinal,pages.label,pages.text,pages.hash FROM pages JOIN sources ON sources.id=pages.source_id WHERE source_id=? AND ordinal=?').get(id, ordinal);
    if (!page) throw new CompanionError('page-not-found', 'That page does not exist. Read the document manifest to see available pages.');
    const source = this.sourceResult(page);
    if (source.stale) throw new CompanionError('not-indexed', 'This document is not indexed at its current revision. Call index_course first.');
    if (offset > page.text.length) throw new CompanionError('invalid-offset', 'The offset is past the end of this page.');
    return { source: this.evidence(source, page.ordinal, page.label, page.hash), text: page.text.slice(offset, offset + limit), offset,
      totalCharacters: page.text.length, nextOffset: offset + limit < page.text.length ? offset + limit : null };
  }
  evidence(source, ordinal, label, hash) {
    return { id: `${source.id}#${ordinal}:${hash.slice(0, 12)}`, sourceId: source.id, courseId: source.courseId, title: source.title,
      url: source.url, location: label, page: ordinal, hash, documentHash: source.contentHash, indexedAt: source.indexedAt, revision: source.revision };
  }
  search(query, { courseId = null, limit = 10 } = {}) {
    const terms = [...new Set(query.normalize('NFKD').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 24);
    if (!terms.length) return [];
    const match = terms.map(term => `"${term}"`).join(' OR ');
    const rows = this.db.prepare(`SELECT passages.source_id,passages.ordinal,passages.start,passages.text,bm25(passages) AS rank,
      pages.label,pages.hash FROM passages JOIN sources ON sources.id=passages.source_id
      JOIN pages ON pages.source_id=passages.source_id AND pages.ordinal=passages.ordinal
      WHERE passages MATCH ? AND sources.indexed_revision=sources.revision AND (? IS NULL OR sources.course_id=?)
      ORDER BY rank,passages.source_id,passages.ordinal,passages.start LIMIT ?`).all(match, courseId, courseId, limit);
    return rows.map(row => ({ source: this.evidence(this.source(row.source_id), row.ordinal, row.label, row.hash), text: row.text, offset: row.start, score: -row.rank }));
  }

  enqueue(kind, args = {}) {
    const scope = digest([kind, args]);
    return this.transaction(() => {
      const active = this.db.prepare("SELECT id FROM jobs WHERE scope=? AND state IN ('queued','running') AND cancelled=0").get(scope);
      if (active) return this.job(active.id);
      const id = randomUUID(), at = new Date(this.now()).toISOString();
      this.db.prepare('INSERT INTO jobs(id,kind,scope,args,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id, kind, scope, JSON.stringify(args), 'queued', at, at);
      return this.job(id);
    });
  }
  job(id, { includePlan = false } = {}) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) return null;
    const args = parse(row.args);
    const { plan, ...publicArgs } = args;
    return { id: row.id, kind: row.kind, args: includePlan ? args : publicArgs, ...(plan ? { plannedSources: plan.length } : {}), state: row.state, completed: row.cursor, total: row.total,
      failures: parse(row.failures), cancelled: !!row.cancelled, createdAt: row.created_at, updatedAt: row.updated_at, error: parse(row.error) };
  }
  jobs() { return this.db.prepare('SELECT id FROM jobs ORDER BY created_at DESC LIMIT 20').all().map(row => this.job(row.id)); }
  claim(owner) {
    return this.transaction(() => {
      this.db.prepare("UPDATE jobs SET state='cancelled' WHERE cancelled=1 AND (state='queued' OR lease_until<?)").run(this.now());
      const row = this.db.prepare("SELECT id FROM jobs WHERE cancelled=0 AND (state='queued' OR (state='running' AND lease_until<?)) ORDER BY created_at LIMIT 1").get(this.now());
      if (!row) return null;
      this.db.prepare("UPDATE jobs SET state='running',owner=?,lease_until=? WHERE id=?").run(owner, this.now() + LEASE_MS, row.id);
      return this.job(row.id, { includePlan: true });
    });
  }
  checkpoint(id, owner, fields = {}) {
    const job = this.job(id);
    if (!job) throw new CompanionError('job-not-found', 'No indexing job has that ID.');
    if (job.cancelled) throw new CompanionError('cancelled', 'This job was cancelled.');
    const result = this.db.prepare(`UPDATE jobs SET cursor=?,total=?,failures=?,lease_until=?,updated_at=?
      WHERE id=? AND owner=? AND state='running'`).run(fields.completed ?? job.completed, fields.total ?? job.total, JSON.stringify(fields.failures ?? job.failures), this.now() + LEASE_MS, new Date(this.now()).toISOString(), id, owner);
    if (!result.changes) throw new CompanionError('lease-lost', 'Another process owns this job.');
  }
  finish(id, owner, state = 'completed', error = null) {
    this.db.prepare('UPDATE jobs SET state=CASE WHEN cancelled=1 THEN \'cancelled\' ELSE ? END,error=?,owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND owner=?')
      .run(state, error ? JSON.stringify(error) : null, new Date(this.now()).toISOString(), id, owner);
  }
  cancel(id) {
    if (!this.job(id)) throw new CompanionError('job-not-found', 'No job has that ID.');
    this.db.prepare("UPDATE jobs SET cancelled=1,state=CASE WHEN state='queued' THEN 'cancelled' ELSE state END WHERE id=? AND state IN ('queued','running')").run(id);
    return this.job(id);
  }
  release(id, owner) { this.db.prepare("UPDATE jobs SET state=CASE WHEN cancelled=1 THEN 'cancelled' ELSE 'queued' END,owner=NULL,lease_until=NULL WHERE id=? AND owner=?").run(id, owner); }
  retry(id) {
    const job = this.job(id);
    if (!job) throw new CompanionError('job-not-found', 'No job has that ID.');
    if (!['failed', 'cancelled'].includes(job.state)) throw new CompanionError('job-active', 'Only failed or cancelled jobs can be resumed.');
    this.db.prepare("UPDATE jobs SET state='queued',cancelled=0,error=NULL,owner=NULL,lease_until=NULL WHERE id=? AND state IN ('failed','cancelled')").run(id);
    return this.job(id);
  }
}
