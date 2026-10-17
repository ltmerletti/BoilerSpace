import { discussionPassages, discussionIndex, discussionContext } from './discussion-ranking.js';

// A single worker per panel owns the model. Idle panels release it; no course
// text, query history or derived vectors are written to another persistent store.
export class DiscussionSearchClient {
  constructor({ workerFactory = () => new Worker(new URL('./discussion-search-worker.js', import.meta.url), { type: 'module' }), idleMs = 60000, timeoutMs = 10000, retryMs = 30000 } = {}) {
    this.workerFactory = workerFactory; this.idleMs = idleMs; this.timeoutMs = timeoutMs; this.retryMs = retryMs; this.unavailableUntil = 0;
    this.nextId = 0; this.pending = new Map(); this.corpusHash = null; this.queue = Promise.resolve(); this.revision = 0;
  }

  dispose() {
    clearTimeout(this.idleTimer); this.worker?.terminate(); this.worker = null; this.corpusHash = null;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('Discussion search was stopped.')); }
    this.pending.clear();
  }

  request(data) {
    if (Date.now() < this.unavailableUntil) throw new Error('Discussion model retry is waiting.');
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      try { this.worker = this.workerFactory(); }
      catch (error) { this.unavailableUntil = Date.now() + this.retryMs; throw error; }
      this.worker.onmessage = ({ data }) => {
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id); clearTimeout(pending.timer);
        if (data.error) {
          pending.reject(new Error(data.error)); this.unavailableUntil = Date.now() + this.retryMs; this.dispose(); return;
        }
        pending.resolve(data.result);
        if (!this.pending.size) this.idleTimer = setTimeout(() => this.dispose(), this.idleMs);
      };
      this.worker.onerror = () => { this.unavailableUntil = Date.now() + this.retryMs; this.dispose(); };
    }
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.unavailableUntil = Date.now() + this.retryMs; this.dispose(); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.worker.postMessage({ id, ...data }); }
      catch { this.unavailableUntil = Date.now() + this.retryMs; this.dispose(); }
    });
  }

  search(entries, hash, query, scope, revision = this.revision) {
    const operation = this.queue.then(async () => {
      if (revision !== this.revision) throw new Error('Discussion data changed.');
      const result = await this.request({ hash, ...(hash !== this.corpusHash ? { entries } : {}), query, scope });
      if (revision !== this.revision) throw new Error('Discussion data changed.');
      this.corpusHash = hash;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

const client = new DiscussionSearchClient();
export function discussionSearchChanged(before, after) {
  if (before?.generation !== after?.generation) return true;
  return JSON.stringify(discussionPassages(before ?? { sources: [] })) !== JSON.stringify(discussionPassages(after ?? { sources: [] }));
}

// Storage changes include disconnects, edited posts, replies and course relinking.
// Stop in-flight reads before they can return a removed source's cached evidence.
globalThis.chrome?.storage?.onChanged?.addListener((changes, area) => {
  if (area === 'local' && changes.discussions && discussionSearchChanged(changes.discussions.oldValue, changes.discussions.newValue)) {
    client.revision++;
    client.dispose();
  }
});
globalThis.addEventListener?.('pagehide', () => client.dispose());

export function createDiscussionSearch(discussions, { searchClient = client } = {}) {
  const entries = discussionPassages(discussions), index = discussionIndex(entries);
  const revision = searchClient.revision;
  let hashPromise;
  return async (query, scope = {}) => {
    if (!entries.length || !String(query ?? '').trim()) return { results: [], method: 'bm25' };
    query = String(query).slice(0, 2000);
    try {
      if (!hashPromise) hashPromise = crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(entries)))
        .then(buffer => [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join(''));
      return await searchClient.search(entries, await hashPromise, query, scope, revision);
    } catch {
      if (revision !== searchClient.revision) {
        const error = new Error('Discussion posts changed while answering. Please try again with the updated posts.');
        error.code = 'discussion-data-changed';
        throw error;
      }
      return { results: discussionContext(index.rank(query, scope)), method: 'bm25',
        note: 'Semantic discussion search is unavailable; these discussion results use keyword search.' };
    }
  };
}
