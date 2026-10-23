import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CourseDatabase } from '../lib/database.mjs';
import { Retrieval, fuse } from '../lib/retrieval.mjs';
import { seed } from './fixtures.mjs';

test('the bundled encoder indexes locally and hybrid results retain scope and evidence hashes', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  for (const [id, text] of [['file:101:7', 'The distance between adjacent peaks of a wave is its wavelength.'], ['file:202:7', 'The processor stores recently used bytes in a memory cache.']]) db.savePages(id, db.source(id).revision, [{ label: 'slide 1', text }]);
  const retrieval = new Retrieval(db);
  try {
    await retrieval.index();
    const result = await retrieval.search('wave crests and wavelength', { courseId: 101, limit: 5 });
    assert.equal(result.method, 'bm25+potion-rrf');
    assert.ok(result.results.some(hit => hit.source.sourceId === 'file:101:7'));
    assert.ok(result.results.every(hit => hit.source.courseId === 101));
    assert.equal(result.results[0].source.hash.length, 64);
    assert.ok(db.unembedded().length === 0);
  } finally { retrieval.close(); db.close(); }
});

test('unavailable semantic retrieval falls back explicitly and fusion limits repeated page snippets', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  const retrieval = new Retrieval(db, { enabled: false });
  try {
    const result = await retrieval.search('orbit', { courseId: 101, limit: 5 });
    assert.equal(result.method, 'sqlite-fts5-bm25');
    assert.match(result.note, /unavailable/);
    assert.equal(result.results.length, 1);
    const hits = [0, 100, 200].map(offset => ({ source: { id: 'same-page' }, offset }));
    assert.equal(fuse(hits, hits, 10).length, 2);
  } finally { retrieval.close(); db.close(); }
});

test('a concurrent metadata change cannot mix old keyword results with new vectors', async () => {
  const db = new CourseDatabase(':memory:'); const next = seed(db);
  const retrieval = new Retrieval(db);
  retrieval.encode = async () => {
    next.data[0].assignments[0].instructions = 'Updated instructions';
    db.publish(next, (await import('../lib/service.mjs')).sourcesFromSnapshot(next));
    return [new Float32Array([1, 0])];
  };
  try { await assert.rejects(retrieval.search('orbit', { courseId: 101, limit: 5 }), { code: 'corpus-changed' }); }
  finally { retrieval.close(); db.close(); }
});

test('an encoder worker that exits can be recreated for the next request', async () => {
  const db = new CourseDatabase(':memory:'); seed(db);
  const retrieval = new Retrieval(db);
  try {
    assert.equal((await retrieval.encode(['wave frequency'])).length, 1);
    await retrieval.worker.terminate();
    assert.equal(retrieval.worker, null);
    assert.equal((await retrieval.encode(['wave frequency'])).length, 1);
  } finally { retrieval.close(); db.close(); }
});
