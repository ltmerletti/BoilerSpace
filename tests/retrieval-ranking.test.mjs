import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, fuseRanks, passageKey, rankingMetrics, uniqueDocuments, vectorSearch } from '../experiments/retrieval/ranking.mjs';

const entries = [
  { id: 'ed:one', chunkIndex: 0, courseId: 1, url: 'https://example.test/one', text: 'TA location' },
  { id: 'piazza:two', chunkIndex: 0, courseId: null, url: 'https://example.test/two', text: 'Separate class' },
  { id: 'ed:three', chunkIndex: 0, courseId: 2, url: 'https://example.test/three', text: 'Another class' },
];

test('semantic retrieval enforces course scope even when another course has a closer vector', () => {
  const vectors = [[1, 1], [1, 0], [1, 0]];
  const scoped = vectorSearch(entries, vectors, [1, 0], { courseId: 1 });
  assert.deepEqual(scoped.map((e) => e.id), ['ed:one']);
  assert.equal(scoped[0].url, entries[0].url, 'citations remain attached to the original passage');
  assert.equal(vectorSearch(entries, vectors, [1, 0]).length, 3, 'unlinked courses are searchable without a scope');
});

test('cosine handles zero vectors and rejects corrupt or incompatible cached embeddings', () => {
  assert.equal(cosine([0, 0], [1, 0]), 0);
  assert.equal(cosine([2, 0], [1, 0]), 1);
  assert.throws(() => cosine([1], [1, 2]), /dimensions/);
  assert.throws(() => cosine([NaN], [1]), /non-finite/);
  assert.throws(() => vectorSearch(entries, [], [1, 0]), /count/);
});

test('rank fusion rewards agreement without depending on incomparable raw score scales', () => {
  const [a, b, c] = entries;
  const combined = fuseRanks([[{ ...a, score: 5000 }, { ...b, score: 4000 }], [{ ...b, score: 0.8 }, { ...c, score: 0.7 }]]);
  assert.equal(combined[0].id, b.id);
  assert.equal(combined.length, 3);
  assert.equal(fuseRanks([[a, a], [b]])[0].score, fuseRanks([[a], [b]])[0].score, 'duplicates cannot boost one ranking');
});

test('source diversity removes repeated chunks without dropping distinct document citations', () => {
  const sameDocument = { ...entries[0], chunkIndex: 1 };
  assert.notEqual(passageKey(entries[0]), passageKey(sameDocument));
  assert.deepEqual(uniqueDocuments([entries[0], sameDocument, entries[1]]).map((e) => e.id), [entries[0].id, entries[1].id]);
});

test('retrieval metrics count misses and ranks beyond the evaluation window', () => {
  assert.deepEqual(rankingMetrics([{ rank: 1 }, { rank: 5 }, { rank: 0 }, { rank: 11 }]), { cases: 4, hitAt1: 0.25, hitAt5: 0.5, hitAt10: 0.5, mrrAt10: 0.3 });
  assert.equal(rankingMetrics([]).hitAt5, 0);
});
