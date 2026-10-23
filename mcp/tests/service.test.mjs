import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseDatabase } from '../lib/database.mjs';
import { CourseService, sourcesFromSnapshot } from '../lib/service.mjs';
import { CompanionError } from '../lib/errors.mjs';
import { seed, snapshot, noSemantics, waitJob } from './fixtures.mjs';

test('indexing saves evidence and reports incomplete coverage instead of pretending to have read everything', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  const service = new CourseService(db, { client: async () => ({ getFile: async () => ({ bytes: new Uint8Array([1]), contentType: 'application/pdf' }) }), save: async () => {} }, {
    retrieval: noSemantics, extract: async () => ({ pages: [{ label: 'page 1', text: 'Visible radiation has a wavelength and frequency.' }] }),
  });
  try {
    assert.equal(service.coverage(101).complete, false);
    const job = service.indexCourse({ courseId: 101 });
    assert.equal((await waitJob(db, job.id)).state, 'completed');
    assert.equal(service.coverage(101).complete, true);
    const manifest = service.readDocument({ sourceId: 'file:101:7' });
    const read = service.readDocument({ sourceId: manifest.source.id, page: 1, expectedHash: manifest.source.contentHash });
    assert.match(read.text, /wavelength/);
    assert.throws(() => service.readDocument({ sourceId: manifest.source.id, page: 1, expectedHash: '0'.repeat(64) }), { code: 'source-changed' });
  } finally { await service.close(); db.close(); }
});

test('unreadable files are explicit per-file failures and cannot produce complete coverage', async () => {
  const db = new CourseDatabase(':memory:'); const next = seed(db);
  next.data[0].content.push({ ...next.data[0].content[0], id: 8, fileUrl: null, externalUrl: 'https://example.edu/notes' });
  db.publish(next, sourcesFromSnapshot(next));
  const service = new CourseService(db, { client: async () => ({ getFile: async () => ({ bytes: new Uint8Array(), contentType: 'application/pdf' }) }), save: async () => {} }, {
    retrieval: noSemantics, extract: async () => { throw new CompanionError('unreadable-document', 'Fixture scan'); },
  });
  try {
    const job = await waitJob(db, service.indexCourse({ courseId: 101 }).id);
    assert.equal(job.failures.length, 2);
    assert.equal(service.coverage(101).complete, false);
  } finally { await service.close(); db.close(); }
});

test('metadata sync explicitly disables grade reads and never saves the profile record', async () => {
  const db = new CourseDatabase(':memory:');
  const service = new CourseService(db, { client: async () => ({}), save: async () => {} }, { retrieval: noSemantics, sync: async (_, options) => {
    assert.equal(options.includeGrades, false);
    return { ...snapshot(), user: { firstName: 'PROFILE_SENTINEL' } };
  } });
  try {
    assert.equal((await waitJob(db, service.refresh().id)).state, 'completed');
    assert.ok(!JSON.stringify(service.status()).includes('PROFILE_SENTINEL'));
    assert.equal(db.courses().length, 2);
  } finally { await service.close(); db.close(); }
});

test('expired sign-in stops a job without discarding indexed material; retry resumes after login', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  let expired = true;
  const service = new CourseService(db, { client: async () => {
    if (expired) throw new CompanionError('sign-in-required', 'Run login');
    return { getFile: async () => ({ bytes: new Uint8Array([1]) }) };
  }, save: async () => {} }, { retrieval: noSemantics, extract: async () => ({ pages: [{ label: 'page 1', text: 'Recovered content' }] }) });
  try {
    const job = await waitJob(db, service.indexCourse({ courseId: 101 }).id);
    assert.equal(job.state, 'failed'); assert.equal(job.error.code, 'sign-in-required');
    assert.ok(db.source('assignment:101:1'));
    expired = false;
    assert.equal((await waitJob(db, service.retry(job.id).id)).state, 'completed');
    assert.equal(service.coverage(101).complete, true);
  } finally { await service.close(); db.close(); }
});

test('selective indexing rejects cross-course IDs and does not fetch unselected documents', async () => {
  const db = new CourseDatabase(':memory:'); const next = seed(db);
  next.data[0].content.push({ ...next.data[0].content[0], id: 8 });
  db.publish(next, sourcesFromSnapshot(next));
  let downloads = 0;
  const service = new CourseService(db, { client: async () => ({ getFile: async () => { downloads++; return {}; } }), save: async () => {} }, {
    retrieval: noSemantics, extract: async () => ({ pages: [{ label: 'page 1', text: 'Selective evidence' }] }),
  });
  try {
    assert.throws(() => service.indexCourse({ courseId: 101, sourceIds: ['file:202:7'] }), { code: 'source-not-found' });
    const job = await waitJob(db, service.indexCourse({ courseId: 101, sourceIds: ['file:101:8'] }).id);
    assert.equal(downloads, 1);
    assert.equal(job.plannedSources, 1);
    assert.equal(job.args.plan, undefined, 'tool progress does not repeat the full indexing plan');
    assert.equal(db.source('file:101:7').stale, true);
  } finally { await service.close(); db.close(); }
});

test('shutdown releases a checkpoint and a new service resumes without re-downloading finished files', async () => {
  const db = new CourseDatabase(':memory:'); const next = seed(db);
  next.data[0].content.push({ ...next.data[0].content[0], id: 8 });
  db.publish(next, sourcesFromSnapshot(next));
  let downloads = 0, secondStarted;
  const started = new Promise(resolve => { secondStarted = resolve; });
  const session = { client: async signal => ({ getFile: async () => {
    if (++downloads === 1) return {};
    secondStarted();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }), save: async () => {} };
  const options = { retrieval: noSemantics, extract: async () => ({ pages: [{ label: 'page 1', text: 'Durable evidence' }] }) };
  const first = new CourseService(db, session, options);
  const job = first.indexCourse({ courseId: 101 });
  await started;
  await first.close();
  assert.equal(db.job(job.id).state, 'queued');
  assert.equal(db.job(job.id).completed, 1);
  const second = new CourseService(db, { client: async () => ({ getFile: async () => { downloads++; return {}; } }), save: async () => {} }, options);
  try {
    second.start();
    assert.equal((await waitJob(db, job.id)).state, 'completed');
    assert.equal(downloads, 3, 'one successful file, one interrupted request, and its retry');
  } finally { await second.close(); db.close(); }
});

test('cancelling a running download aborts its request and retains existing evidence', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  let ready;
  const started = new Promise(resolve => { ready = resolve; });
  const service = new CourseService(db, { client: async signal => ({ getFile: async () => {
    ready();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } }) }, { retrieval: noSemantics });
  try {
    const job = service.indexCourse({ courseId: 101 });
    await started;
    service.cancel(job.id);
    assert.equal((await waitJob(db, job.id)).state, 'cancelled');
    assert.ok(db.read('assignment:101:1', 1).text.length > 0);
  } finally { await service.close(); db.close(); }
});

test('research packets respect text budgets, keep multiple sources, and reject an index changed during retrieval', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  const sources = ['assignment:101:1', 'file:101:7'];
  for (const id of sources) db.savePages(id, db.source(id).revision, [{ label: 'page 1', text: 'evidence '.repeat(2000) }]);
  let mutate = false;
  const retrieval = { ...noSemantics, search: async () => {
    if (mutate) db.savePages(sources[0], db.source(sources[0]).revision, [{ label: 'page 1', text: 'Changed evidence' }]);
    return { method: 'fixture', results: sources.map(id => ({ ...db.read(id, 1), offset: 0 })) };
  } };
  const service = new CourseService(db, {}, { retrieval });
  try {
    const packet = await service.researchContext({ query: 'evidence', courseId: 101, maxCharacters: 3000 });
    assert.equal(packet.evidence.length, 2);
    assert.equal(packet.characters, 3000);
    assert.ok(packet.evidence.every(item => item.nextOffset !== null && item.source.hash.length === 64));
    mutate = true;
    await assert.rejects(service.researchContext({ query: 'evidence', courseId: 101 }), { code: 'corpus-changed' });
  } finally { await service.close(); db.close(); }
});
