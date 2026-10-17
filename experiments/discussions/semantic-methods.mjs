import { passageKey, fuseRanks } from '../retrieval/ranking.mjs';

export function maxSim(query, document, dimensions) {
  if (!Number.isInteger(dimensions) || dimensions < 1 || !query.length || !document.length || query.length % dimensions || document.length % dimensions) {
    throw new Error('Invalid token vectors for MaxSim.');
  }
  let score = 0;
  for (let q = 0; q < query.length; q += dimensions) {
    let best = -Infinity;
    for (let d = 0; d < document.length; d += dimensions) {
      let dot = 0;
      for (let j = 0; j < dimensions; j++) dot += query[q + j] * document[d + j];
      best = Math.max(best, dot);
    }
    score += best;
  }
  if (!Number.isFinite(score)) throw new Error('Nonfinite MaxSim score.');
  return score;
}

// Preserve each retriever's candidate allocation. A fusion cutoff alone can
// discard a semantic-only answer before the reranker ever sees it.
export function candidateUnion(rankings, perRetriever = 50) {
  if (!Number.isInteger(perRetriever) || perRetriever < 1) throw new Error('Invalid candidate allocation.');
  const seen = new Set();
  return rankings.flatMap(ranking => ranking.slice(0, perRetriever)).filter(entry => {
    const key = passageKey(entry);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

export function rerankCandidates(base, candidates, score, { count = candidates.length, originalWeight = 1, k = 20 } = {}) {
  const reranked = candidates.slice(0, count).map(entry => ({ ...entry, score: score(entry) })).sort((a, b) => b.score - a.score);
  if (originalWeight) return fuseRanks([reranked, base], { weights: [1, originalWeight], k });
  const seen = new Set(reranked.map(passageKey));
  return [...reranked, ...base.filter(entry => !seen.has(passageKey(entry)))].slice(0, 50);
}

// POTION's published table already includes its training-time token weights.
// Inference removes unknown tokens, averages rows, then L2 normalizes.
export function tableEncoder(tokenizer, buffer, { unknownId = null, maxTokens = 512 } = {}) {
  const headerBytes = Number(new DataView(buffer).getBigUint64(0, true));
  if (!Number.isSafeInteger(headerBytes) || headerBytes < 2 || headerBytes + 8 > buffer.byteLength) throw new Error('Invalid table header.');
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes))), info = header.embeddings;
  if (!info || info.dtype !== 'F32' || info.shape.length !== 2 || !info.shape.every(n => Number.isInteger(n) && n > 0)) throw new Error('Expected a float32 embeddings table.');
  const [vocabulary, dimensions] = info.shape, [start, end] = info.data_offsets;
  if (start < 0 || end - start !== vocabulary * dimensions * 4 || headerBytes + 8 + end > buffer.byteLength) throw new Error('Invalid table size.');
  const values = new Float32Array(buffer, headerBytes + 8 + start, vocabulary * dimensions);
  return { dimensions, weightBytes: buffer.byteLength, encode(text) {
    const ids = tokenizer.encode(text, { add_special_tokens: false }).ids.slice(0, maxTokens).filter(id => id !== unknownId);
    const vector = new Float64Array(dimensions);
    for (const id of ids) {
      if (!Number.isInteger(id) || id < 0 || id >= vocabulary) throw new Error('Token outside table vocabulary.');
      for (let j = 0; j < dimensions; j++) vector[j] += values[id * dimensions + j];
    }
    const norm = Math.hypot(...vector);
    if (!Number.isFinite(norm)) throw new Error('Nonfinite table embedding.');
    return Float32Array.from(vector, value => norm ? value / norm : 0);
  } };
}
