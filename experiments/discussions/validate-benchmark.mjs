import { resolveCases } from './corpus.mjs';

export function validateBenchmark(discussions, cases, { development = [], primaryCount } = {}) {
  const forbidden = new Set(development.flatMap(c => c.expected.map(e => e.threadKey)));
  const ids = new Set(), queries = new Set(), primaryThreads = new Set();
  const sources = new Map(discussions.sources.map(s => [s.id, s]));
  const resolved = resolveCases(discussions, cases);
  for (const item of resolved) {
    if (!item.id || ids.has(item.id)) throw new Error('Missing or duplicate case ID.');
    ids.add(item.id);
    if (!item.query?.trim() || queries.has(item.query.trim().toLowerCase())) throw new Error(`Missing or duplicate query: ${item.id}`);
    queries.add(item.query.trim().toLowerCase());
    if (!item.expected.length) throw new Error(`Empty evidence: ${item.id}. Keep diagnostics separate.`);
    if (!item.supportedAnswer?.trim() || !item.rationale?.trim() || !item.topic || !item.kind) throw new Error(`Incomplete annotation: ${item.id}`);
    const source = sources.get(item.sourceId);
    if (!source) throw new Error(`Unknown source: ${item.id}`);
    const ownThreads = new Set(item.expected.map(e => e.threadKey));
    for (const evidence of item.expected) {
      if (forbidden.has(evidence.threadKey)) throw new Error(`Development leakage: ${item.id}`);
      const thread = source.threads.find(t => t.key === evidence.threadKey);
      const message = evidence.messageId === 'root' ? thread : thread.replies.find(r => String(r.id) === evidence.messageId);
      if (message.role !== 'instructor') throw new Error(`Evidence is not staff-authored: ${item.id}`);
    }
    if (item.primary) {
      if (ownThreads.size !== 1 || primaryThreads.has([...ownThreads][0])) throw new Error(`Primary questions must use distinct threads: ${item.id}`);
      primaryThreads.add([...ownThreads][0]);
    }
  }
  if (primaryCount !== undefined && primaryThreads.size !== primaryCount) throw new Error(`Expected ${primaryCount} primary questions, got ${primaryThreads.size}.`);
  return { cases: resolved, questions: cases.length, primaryQuestions: primaryThreads.size,
    sources: Object.fromEntries([...sources.keys()].map(id => [id, cases.filter(c => c.primary && c.sourceId === id).length])) };
}
