import { effectiveQuery } from './corpus.mjs';
import { passageKey } from '../retrieval/ranking.mjs';

export function questionParts(item) {
  const parts = item.query.split(/\band\b(?=\s+(?:what|how|which|where|are|is|can|do|does|why|when|am|should))/i);
  return parts.map((query) => effectiveQuery({ ...item, query }, 'history'));
}

export function interleave(rankings) {
  const result = [], seen = new Set();
  for (let rank = 0; rank < Math.max(0, ...rankings.map((r) => r.length)); rank++) for (const ranking of rankings) {
    const entry = ranking[rank];
    if (entry && !seen.has(passageKey(entry))) {
      seen.add(passageKey(entry)); result.push(entry);
    }
  }
  return result;
}
