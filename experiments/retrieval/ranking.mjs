// Retrieval helpers shared by the local model comparison and its regression tests.
export const passageKey = (entry) => `${entry.id}:${entry.chunkIndex}`;

export function cosine(a, b) {
  if (!a.length || a.length !== b.length) throw new Error('Embedding dimensions do not match.');
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new Error('Embedding contains a non-finite value.');
    dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i];
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

export function vectorSearch(entries, vectors, query, { courseId = null, limit = 50 } = {}) {
  if (entries.length !== vectors.length) throw new Error('Embedding count does not match passages.');
  return entries.flatMap((entry, i) => courseId !== null && entry.courseId !== courseId ? [] : [{ ...entry, score: cosine(vectors[i], query) }])
    .sort((a, b) => b.score - a.score).slice(0, limit);
}

// Reciprocal rank fusion combines rankings without pretending BM25 and cosine share a scale.
export function fuseRanks(rankings, { limit = 50, k = 60, weights = rankings.map(() => 1) } = {}) {
  if (weights.length !== rankings.length || weights.some((w) => !Number.isFinite(w) || w < 0)) {
    throw new Error('Rank-fusion weights must be finite, nonnegative, and match the ranking count.');
  }
  if (!Number.isFinite(k) || k <= 0) throw new Error('Rank-fusion k must be positive.');
  const merged = new Map();
  for (const [source, ranking] of rankings.entries()) {
    if (!weights[source]) continue;
    const seen = new Set();
    ranking.forEach((entry, rank) => {
      const key = passageKey(entry);
      if (seen.has(key)) return;
      seen.add(key);
      const hit = merged.get(key) ?? { ...entry, score: 0 };
      hit.score += weights[source] / (k + rank + 1);
      merged.set(key, hit);
    });
  }
  return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export function uniqueDocuments(results, limit = 6) {
  const seen = new Set();
  return results.filter((entry) => {
    if (seen.has(entry.id)) return false;
    seen.add(entry.id);
    return true;
  }).slice(0, limit);
}

export function rankingMetrics(rows) {
  const count = rows.length;
  const mean = (fn) => count ? rows.reduce((sum, row) => sum + fn(row), 0) / count : 0;
  return { cases: count, hitAt1: mean((r) => r.rank === 1), hitAt5: mean((r) => r.rank > 0 && r.rank <= 5),
    hitAt10: mean((r) => r.rank > 0 && r.rank <= 10), mrrAt10: mean((r) => r.rank > 0 && r.rank <= 10 ? 1 / r.rank : 0) };
}
