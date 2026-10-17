import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readVectorFile } from '../experiments/retrieval/vector-file.mjs';
import { vectorSearch } from '../experiments/retrieval/ranking.mjs';

function fixture(t, numbers) {
  const directory = mkdtempSync(path.join(tmpdir(), 'boilerspace-vectors-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'vectors.f32');
  const bytes = Buffer.alloc(numbers.length * 4);
  numbers.forEach((number, i) => bytes.writeFloatLE(number, i * 4));
  writeFileSync(filename, bytes);
  return filename;
}

test('external embeddings retain their row order and course scope', (t) => {
  const vectors = readVectorFile(fixture(t, [0, 1, 1, 0, 1, 0]), 3, 2);
  const entries = [{ id: 'other-course', courseId: 2 }, { id: 'answer', courseId: 1 }, { id: 'duplicate-vector', courseId: 2 }];
  assert.deepEqual(vectorSearch(entries, vectors, [1, 0], { courseId: 1 }).map((r) => r.id), ['answer']);
  assert.deepEqual([...vectors[0]], [0, 1]);
});

test('rejects incomplete or mismatched external vector files', (t) => {
  const filename = fixture(t, [1, 2, 3]);
  assert.throws(() => readVectorFile(filename, 2, 2), /dimensions/);
  assert.throws(() => readVectorFile(filename, 1, 0), /shape/);
});

test('rejects non-finite values from external embedding runtimes', (t) => {
  assert.throws(() => readVectorFile(fixture(t, [NaN, 0]), 1, 2), /Non-finite/);
  assert.throws(() => readVectorFile(fixture(t, [0, Infinity]), 1, 2), /Non-finite/);
});
