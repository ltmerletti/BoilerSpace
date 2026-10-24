import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CourseDatabase } from '../lib/database.mjs';
import { sourcesFromSnapshot } from '../lib/service.mjs';
import { seed, snapshot } from './fixtures.mjs';

test('page citations pin text, locations, revisions and continuation offsets', () => {
  const db = new CourseDatabase(':memory:');
  try {
    seed(db);
    const id = 'file:101:7', source = db.source(id);
    const text = 'Wavelength and frequency. '.repeat(800);
    db.savePages(id, source.revision, [{ label: 'slide 14', text }]);
    const hits = db.search('wavelength', { courseId: 101, limit: 2 });
    assert.equal(hits.length, 2);
    assert.equal(hits[0].source.location, 'slide 14');
    assert.equal(hits[0].source.hash.length, 64);
    const first = db.read(id, 1), second = db.read(id, 1, first.nextOffset);
    assert.equal(first.text + second.text, text);
    assert.equal(second.nextOffset, null);
    assert.equal(db.search('wavelength', { courseId: 202 }).length, 0);
    assert.deepEqual(db.search('" OR 1=1; DROP TABLE pages; --'), []);
  } finally { db.close(); }
});

test('changed and deleted sources invalidate old passages and embeddings atomically', () => {
  const db = new CourseDatabase(':memory:');
  try {
    const original = seed(db), id = 'file:101:7', source = db.source(id);
    db.savePages(id, source.revision, [{ label: 'page 1', text: 'obsolete evidence' }]);
    const batch = db.unembedded();
    db.saveVectors(batch.map(row => ({ ...row, vector: new Float32Array([1, 0]) })), 'fixture');
    original.data[0].content[0].updatedAt = '2026-10-02';
    db.publish(original, sourcesFromSnapshot(original));
    assert.equal(db.search('obsolete').length, 0);
    assert.equal(db.source(id).stale, true);
    assert.equal(db.pages(id).length, 0);
    assert.equal(db.vectorSearch(new Float32Array([1, 0]), 'fixture').some(hit => hit.source.sourceId === id), false);
    original.data[0].content = [];
    db.publish(original, sourcesFromSnapshot(original));
    assert.equal(db.source(id), null);
  } finally { db.close(); }
});

test('partial section failure keeps saved evidence; failed publication rolls back completely', () => {
  const db = new CourseDatabase(':memory:');
  try {
    seed(db);
    const next = snapshot();
    next.data[0].content = [];
    next.errors = [{ courseId: 101, section: 'content', status: 503, message: 'Fixture outage' }];
    db.publish(next, sourcesFromSnapshot(next));
    assert.ok(db.source('file:101:7'));
    assert.equal(db.get('sync').errors.length, 1);
    assert.throws(() => db.publish(snapshot(), [{ id: 'broken' }]));
    assert.ok(db.source('file:101:7'));
    assert.equal(db.get('sync').errors.length, 1);
  } finally { db.close(); }
});

test('durable leases prevent duplicate workers and resume from a saved cursor after a crash', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'boilerspace-db-'));
  let now = 1000;
  const file = path.join(directory, 'index.sqlite');
  const first = new CourseDatabase(file, { now: () => now });
  const second = new CourseDatabase(file, { now: () => now });
  try {
    const job = first.enqueue('index', { courseId: 101 });
    assert.equal(second.enqueue('index', { courseId: 101 }).id, job.id);
    assert.equal(first.claim('worker-one').id, job.id);
    assert.equal(second.claim('worker-two'), null);
    first.checkpoint(job.id, 'worker-one', { completed: 4, total: 10 });
    now += 120001;
    assert.equal(second.claim('worker-two').completed, 4);
    assert.throws(() => first.checkpoint(job.id, 'worker-one'), { code: 'lease-lost' });
    second.cancel(job.id);
    assert.throws(() => second.checkpoint(job.id, 'worker-two'), { code: 'cancelled' });
    second.finish(job.id, 'worker-two');
    assert.equal(first.job(job.id).state, 'cancelled');
    assert.equal(first.retry(job.id).completed, 4);
  } finally { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }); }
});
