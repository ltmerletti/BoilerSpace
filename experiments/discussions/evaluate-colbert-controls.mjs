import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { localModel } from './local-model.mjs';
import { loadDataset } from './dataset.mjs';
import { lexicalIndex } from './lexical.mjs';
import { maxSim, candidateUnion } from './semantic-methods.mjs';
import { fuseRanks, passageKey } from '../retrieval/ranking.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { comparePaired, holm } from './statistics.mjs';

process.umask(0o077);
const directory = '.verify-tmp/discussion-retrieval/v2', output = `${directory}/extended`;
const json = p => JSON.parse(readFileSync(p)), hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const plan = json(`${output}/candidate-controls-plan.json`), originalPlan = json(`${output}/plan.json`);
if (hash(`${output}/plan.json`) !== plan.sourcePlanHash) throw new Error('Original comparison plan changed.');
for (const [p, h] of Object.entries({ ...json(`${directory}/sealed.json`).hashes, ...originalPlan.hashes })) if (hash(p) !== h) throw new Error(`Changed input ${p}`);
const runnerHash = hash(import.meta.filename);
const data = loadDataset(undefined, { casesPath: `${directory}/cases.json`, preservePartitions: true });
const assets = '.verify-tmp/discussion-retrieval/models/mixedbread-ai/mxbai-edge-colbert-v0-17m';
const config = json(`${assets}/onnx_config.json`), tokenizer = json(`${assets}/tokenizer.json`);
const skipped = new Set(config.skiplist_words.map(t => tokenizer.model.vocab[t]).filter(Number.isInteger)), dimensions = config.embedding_dim;
const model = await localModel({ directory: assets, file: 'model_int8.onnx', maxTokens: 512 });
const encode = async (text, query = false) => {
  const tokens = await model.tokenize((query ? config.query_prefix : config.document_prefix) + text.toLowerCase(), undefined, { max_length: query ? config.query_length : config.document_length });
  const tensor = (await model.run(tokens)).output, values = [];
  for (let i = 0; i < tensor.dims[1]; i++) {
    if (!Number(tokens.attention_mask.data[i]) || (!query && skipped.has(Number(tokens.input_ids.data[i])))) continue;
    const v = tensor.data.slice(i * dimensions, (i + 1) * dimensions), norm = Math.hypot(...v);
    for (const value of v) values.push(value / norm);
  }
  return Float32Array.from(values);
};
try {
  const documents = []; for (const text of data.texts) documents.push(await encode(text));
  const positions = new Map(data.entries.map((e, i) => [passageKey(e), i]));
  const sse = json(`${output}/static.json`).methods.find(m => m.name === 'sse-f16-pure').rankings.map(list => list.map(i => data.entries[i]));
  const lexical = lexicalIndex(data.entries), characters = lexicalIndex(data.entries, { characters: true });
  const rows = Object.fromEntries(plan.configurations.map(c => [c.name, []])), ceilings = Object.fromEntries(plan.configurations.map(c => [c.name, 0]));
  for (const [i, item] of data.cases.entries()) {
    const scope = { sourceId: item.sourceId, limit: 100 }, query = data.queries[i];
    const keyword = fuseRanks([lexical.search(query, scope), characters.search(query, scope)], { weights: [1, .5], k: 20, limit: 100 });
    const combined = fuseRanks([keyword, sse[i]], { weights: [1, 1], k: 10, limit: 150 });
    const vector = await encode(query, true), cache = new Map();
    const score = entry => {
      const key = passageKey(entry);
      if (!cache.has(key)) cache.set(key, maxSim(vector, documents[positions.get(key)], dimensions));
      return cache.get(key);
    };
    for (const c of plan.configurations) {
      const allocation = c.semantic ? candidateUnion([keyword, sse[i]], c.size / 2) : keyword.slice(0, c.size);
      const pool = c.semantic ? candidateUnion([allocation, combined], 150).slice(0, c.size) : allocation;
      const ranking = pool.map(e => ({ ...e, score: score(e) })).sort((a, b) => b.score - a.score);
      rows[c.name].push(evaluateRanking(item, ranking, plan.context));
      if (item.primary) ceilings[c.name] += evaluateRanking(item, pool, { budget: 1e9, maxChunks: 1000 }).allEvidenceInContext;
    }
  }
  const primary = data.cases.filter(c => c.primary), ids = new Set(primary.map(c => c.id)), only = rows => rows.filter(r => ids.has(r.id));
  const contrasts = [50, 100].map(size => ({ size, completeness: comparePaired(primary, only(rows[`colbert-mixed-${size}`]), only(rows[`colbert-keyword-${size}`])),
    firstResult: comparePaired(primary, only(rows[`colbert-mixed-${size}`]), only(rows[`colbert-keyword-${size}`]), { metric: 'hitAt1' }) }));
  const completeP = holm(contrasts.map(c => c.completeness.mcnemar.p)), firstP = holm(contrasts.map(c => c.firstResult.mcnemar.p));
  contrasts.forEach((c, i) => { c.holmCompletenessP = completeP[i]; c.holmFirstResultP = firstP[i]; });
  const methods = Object.entries(rows).map(([name, rows]) => ({ name, primary: summarize(only(rows)), challenges: summarize(rows.filter(r => !ids.has(r.id))), rows }));
  const report = { at: new Date().toISOString(), plan, runnerHash, corpusHash: data.corpusHash, queryHash: data.queryHash, methods, contrasts, ceilings,
    note: 'Matched 50/100 candidate caps, same model and pure MaxSim ranking. Exploratory follow-up; no latency or deployment memory claim.' };
  writeFileSync(`${output}/candidate-controls.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ methods: methods.map(m => ({ ...m, rows: undefined })), contrasts, ceilings }, null, 2));
} finally { await model.close(); }
