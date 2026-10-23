import { Worker } from 'node:worker_threads';
import { CompanionError } from './errors.mjs';

const MODEL = 'potion-i8-796f9def';
const key = hit => `${hit.source.id}:${hit.offset}`;

export function fuse(lexical, semantic, limit) {
  const scores = new Map(), hits = new Map();
  for (const [ranking, weight] of [[lexical, 1], [semantic, 1]]) {
    for (const [rank, hit] of ranking.entries()) {
      const id = key(hit);
      scores.set(id, (scores.get(id) ?? 0) + weight / (20 + rank + 1));
      hits.set(id, hit);
    }
  }
  const perPage = new Map();
  return [...scores].sort((a, b) => b[1] - a[1]).flatMap(([id, score]) => {
    const hit = hits.get(id), page = hit.source.id;
    const count = perPage.get(page) ?? 0;
    if (count >= 2) return [];
    perPage.set(page, count + 1);
    return [{ ...hit, score }];
  }).slice(0, limit);
}

export class Retrieval {
  constructor(database, { enabled = true } = {}) { this.database = database; this.enabled = enabled; this.pending = new Map(); this.sequence = 0; }
  async encode(texts) {
    if (!this.enabled) throw new Error('Semantic retrieval is disabled');
    if (!this.worker) {
      const worker = new Worker(new URL('../workers/embeddings.mjs', import.meta.url), { execArgv: [], stdout: true, stderr: true });
      this.worker = worker;
      worker.stdout.resume(); worker.stderr.resume();
      this.ready = new Promise((resolve, reject) => {
        const fail = () => {
          clearTimeout(timer); reject(new Error('Embedding worker stopped'));
          if (this.worker === worker) this.close();
        };
        const timer = setTimeout(fail, 15000);
        worker.on('message', result => {
          if (result.ready || (result.error && result.id === undefined)) {
            clearTimeout(timer);
            if (result.ready) resolve(); else fail();
            return;
          }
          const request = this.pending.get(result.id);
          if (request) {
            this.pending.delete(result.id); clearTimeout(request.timer);
            if (result.error) request.reject(new Error('Embedding failed')); else request.resolve(result.vectors);
          }
        });
        worker.on('error', fail);
        worker.on('exit', fail);
      });
    }
    await this.ready;
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => { this.close(); }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ id, texts });
    });
  }
  async index(signal) {
    for (;;) {
      signal?.throwIfAborted();
      const batch = this.database.unembedded(32, MODEL);
      if (!batch.length) return;
      const vectors = await this.encode(batch.map(row => row.text));
      signal?.throwIfAborted();
      this.database.saveVectors(batch.map((row, index) => ({ ...row, vector: vectors[index] })), MODEL);
    }
  }
  async search(query, options) {
    const epoch = this.database.get('corpusEpoch');
    const lexical = this.database.search(query, { ...options, limit: 40 });
    try {
      const [vector] = await this.encode([query]);
      if (!vector.some(value => value !== 0)) throw new Error('No semantic tokens');
      const semantic = this.database.vectorSearch(vector, MODEL, { ...options, limit: 40 });
      if (epoch !== this.database.get('corpusEpoch')) throw new CompanionError('corpus-changed', 'The course index changed during retrieval. Search again for current evidence.');
      return { method: semantic.length ? 'bm25+potion-rrf' : 'sqlite-fts5-bm25', results: semantic.length ? fuse(lexical, semantic, options.limit) : lexical.slice(0, options.limit),
        ...(!semantic.length ? { note: 'Semantic vectors are not indexed yet. Finish an indexing job to enable hybrid search.' } : {}) };
    } catch (error) {
      if (error.code === 'corpus-changed' || epoch !== this.database.get('corpusEpoch')) throw new CompanionError('corpus-changed', 'The course index changed during retrieval. Search again for current evidence.');
      return { method: 'sqlite-fts5-bm25', results: lexical.slice(0, options.limit), note: 'The local semantic model is unavailable. These results use keyword search.' };
    }
  }
  close() {
    this.worker?.terminate().catch(() => {}); this.worker = null;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Retrieval stopped')); }
    this.pending.clear();
  }
}
