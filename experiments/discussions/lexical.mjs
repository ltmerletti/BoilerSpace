import { tokenize } from '../../extension/lib/search.js';

function characterTerms(text) {
  const normalized = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, ' ').trim();
  const terms = [];
  for (const word of normalized.split(' ')) {
    if (!word) continue;
    const padded = `^${word}$`;
    for (let i = 0; i < padded.length - 2; i++) terms.push(padded.slice(i, i + 3));
  }
  return terms;
}

const expansions = [
  ['ta', 'teaching assistant'], ['office hour', 'help session location'],
  ['crib sheet', 'cheatsheet cheat sheet notecard'], ['cheatsheet', 'crib sheet reference sheet'],
  ['midterm', 'exam test'], ['exam', 'midterm test'], ['deadline', 'due date submission'],
  ['header', 'include library'], ['segfault', 'segmentation fault debugger'],
  ['runtime', 'time complexity'], ['rvalue', 'r value move temporary'],
  ['kernel', 'jupyter notebook python r'], ['outside event', 'professional development pd'],
];

export function expandQuery(query) {
  const lower = query.toLowerCase();
  return [query, ...expansions.filter(([phrase]) => new RegExp(`\\b${phrase}\\b`).test(lower)).map(([, extra]) => extra)].join(' ');
}

export function lexicalIndex(entries, { characters = false, titleWeight = 1, k1 = 1.2, b = 0.75 } = {}) {
  const terms = characters ? characterTerms : tokenize;
  const rows = [], postings = new Map();
  for (const [index, entry] of entries.entries()) {
    const frequencies = new Map();
    for (const token of terms(entry.text)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const token of terms(entry.title)) frequencies.set(token, (frequencies.get(token) ?? 0) + titleWeight);
    const length = [...frequencies.values()].reduce((a, value) => a + value, 0);
    rows.push({ frequencies, length });
    for (const [token, frequency] of frequencies) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push([index, frequency]);
    }
  }
  const averageLength = rows.reduce((sum, row) => sum + row.length, 0) / (rows.length || 1);
  return {
    search(query, { sourceId = null, limit = 50, expand = false } = {}) {
      const scores = new Map();
      for (const token of new Set(terms(expand ? expandQuery(query) : query))) {
        const posting = postings.get(token) ?? [];
        const idf = Math.log(1 + (entries.length - posting.length + 0.5) / (posting.length + 0.5));
        for (const [index, frequency] of posting) {
          if (sourceId && entries[index].sourceId !== sourceId) continue;
          const increment = idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * rows[index].length / averageLength));
          scores.set(index, (scores.get(index) ?? 0) + increment);
        }
      }
      return [...scores].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([index, score]) => ({ ...entries[index], score }));
    },
  };
}

export function feedbackQuery(query, ranking, count = 6) {
  const original = new Set(tokenize(query)), frequencies = new Map();
  for (const entry of ranking.slice(0, 3)) for (const term of tokenize(entry.text)) {
    if (original.has(term) || term.length < 4 || /^\d/.test(term) || ['instructor', 'student', 'reply', 'question'].includes(term)) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return query + ' ' + [...frequencies].sort((a, b) => b[1] - a[1]).slice(0, count).map(([word]) => word).join(' ');
}
