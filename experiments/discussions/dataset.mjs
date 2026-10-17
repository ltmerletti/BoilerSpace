import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { discussionCorpus, effectiveQuery, partitionCases, resolveCases } from './corpus.mjs';

export function loadDataset(representation = { unit: 'thread', size: 1000, overlap: 150 }, { casesPath, preservePartitions = false } = {}) {
  const discussions = JSON.parse(readFileSync('.verify-tmp/retrieval-discussions.json')).discussions;
  const resolved = resolveCases(discussions, JSON.parse(readFileSync(casesPath ?? '.verify-tmp/discussion-retrieval/cases.json')));
  const cases = preservePartitions ? resolved : partitionCases(resolved);
  const entries = discussionCorpus(discussions, representation);
  const texts = entries.map((entry) => `${entry.title}\n${entry.text}`);
  const queries = cases.map((item) => effectiveQuery(item, 'history'));
  return { entries, texts, queries, cases, representation,
    corpusHash: createHash('sha256').update(JSON.stringify(texts)).digest('hex'),
    queryHash: createHash('sha256').update(JSON.stringify(queries)).digest('hex') };
}
