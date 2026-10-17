// Fixed comparisons on the sealed discussion bank. Never select settings here.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { loadDataset } from './dataset.mjs';
import { localModel } from './local-model.mjs';
import { staticEncoder } from './static-embedding.mjs';
import { tableEncoder, maxSim, candidateUnion, rerankCandidates } from './semantic-methods.mjs';
import { lexicalIndex } from './lexical.mjs';
import { evaluateRanking, summarize } from './corpus.mjs';
import { comparePaired, holm } from './statistics.mjs';
import { cosine, fuseRanks, passageKey } from '../retrieval/ranking.mjs';
import { tokenize } from '../../extension/lib/search.js';
import { Tokenizer } from '../retrieval/modern-js/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs';

process.umask(0o077);
const directory = '.verify-tmp/discussion-retrieval/v2', output = `${directory}/extended`;
mkdirSync(output, { recursive: true });
const json = file => JSON.parse(readFileSync(file));
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const check = hashes => { for (const [file, digest] of Object.entries(hashes)) if (hash(file) !== digest) throw new Error(`Frozen input changed: ${file}`); };
const seal = json(`${directory}/sealed.json`); check(seal.hashes);
const dataset = loadDataset(undefined, { casesPath: `${directory}/cases.json`, preservePartitions: true });
const primary = dataset.cases.filter(c => c.primary), primaryIds = new Set(primary.map(c => c.id));
const primaryOnly = rows => rows.filter(r => primaryIds.has(r.id));
const positions = new Map(dataset.entries.map((e, i) => [passageKey(e), i]));
const sseAssets = '.verify-tmp/discussion-retrieval/ram-research/RikkaBotan--stable-static-embedding-fast-retrieval-mrl-en-v2';
const potionAssets = '.verify-tmp/retrieval-models/potion-retrieval-32M';
const colbertAssets = '.verify-tmp/discussion-retrieval/models/mixedbread-ai/mxbai-edge-colbert-v0-17m';
const planFile = `${output}/plan.json`, command = process.argv[2];

if (command === 'prepare') {
  const dense = json('experiments/discussions/models.json').filter(m => ['mxbai-xsmall-q4', 'mxbai-xsmall-q8', 'jina5-nano-q4', 'jina5-nano-q8'].includes(m.name)).map(spec => {
    const previous = json(`bench/runs/discussions/${spec.name}-thread.json`);
    if (previous.corpusHash !== dataset.corpusHash || JSON.stringify(previous.model) !== JSON.stringify(spec)) throw new Error(`Prior model identity mismatch: ${spec.name}`);
    const { lexicalWeight, characterWeight, k } = previous.chosen;
    const cache = `.verify-tmp/discussion-retrieval/vectors/${spec.name}-${dataset.corpusHash}.f32`;
    return { ...spec, blend: { lexicalWeight, characterWeight, k }, cache: existsSync(cache) ? cache : null };
  });
  const files = [import.meta.filename, 'experiments/discussions/semantic-methods.mjs', 'experiments/discussions/local-model.mjs',
    `${directory}/sealed.json`, `${directory}/frozen-results.json`, `${directory}/potion-public-parity.json`,
    `${potionAssets}/model.safetensors`, `${potionAssets}/tokenizer.json`,
    ...['onnx_config.json', 'tokenizer.json', 'model_int8.onnx'].map(f => `${colbertAssets}/${f}`),
    ...dense.flatMap(m => [`${m.directory}/${m.file}`, `${m.directory}/tokenizer.json`, ...(existsSync(`${m.directory}/${m.file}_data`) ? [`${m.directory}/${m.file}_data`] : []), ...(m.cache ? [m.cache] : [])])];
  if (hash(`${potionAssets}/model.safetensors`) !== '07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0') throw new Error('POTION differs from pinned published asset.');
  const plan = { at: new Date().toISOString(), corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
    scope: '330 sealed Ed/Piazza questions; 300 primary; known source; same chunks and 6000-character / 12-chunk context.',
    note: 'Exploratory extension after observing SSE/baseline results. Fixed old-development blends; no expanded-set parameter sweep. No answer generation or browser deployment claim.',
    dense, staticBlend: { lexicalWeight: 1, characterWeight: 0, k: 10 },
    potion: { revision: '6fc8051fab2a1e0ee76689cf08c853792ac285e7', maxTokens: 512 },
    colbert: { revision: '592c6417c1c6687572043408ed1ae5196bce16b1', originalCount: 20, originalWeight: 1, k: 20,
      semanticPool: 'Union top 50 BM25/character candidates and top 50 SSE semantic candidates; score every unique candidate, up to 100.',
      semanticBase: { weights: [1, 1], k: 10, limit: 100 } },
    statistics: 'Paired comparison to plain BM25; bootstrap by thread and source/topic. Holm adjustments across all new methods for each reported binary endpoint. Low-overlap quarter defined by query/gold-span token Jaccard, without retrieval outcomes.',
    hashes: Object.fromEntries([...new Set(files)].map(f => [f, hash(f)])) };
  writeFileSync(planFile, JSON.stringify(plan, null, 2), { flag: 'wx', mode: 0o600 });
  console.log('Prepared fixed extended comparison plan.'); process.exit(0);
}
const plan = json(planFile); check(plan.hashes);
if (dataset.queryHash !== plan.queryHash || dataset.corpusHash !== plan.corpusHash) throw new Error('Dataset differs from plan.');
const lexical = lexicalIndex(dataset.entries), characters = lexicalIndex(dataset.entries, { characters: true });
const lexicalTimes = [], bm25 = [], lexicalBase = [];
for (const [i, item] of dataset.cases.entries()) {
  const start = performance.now(), scope = { sourceId: item.sourceId };
  bm25.push(lexical.search(dataset.queries[i], scope));
  lexicalBase.push(fuseRanks([bm25[i], characters.search(dataset.queries[i], scope)], { weights: [1, 0.5], k: 20 }));
  lexicalTimes.push(performance.now() - start);
}
const evaluate = rankings => dataset.cases.map((item, i) => evaluateRanking(item, rankings[i], { budget: 6000, maxChunks: 12 }));
const timerSummary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: sorted.reduce((a, b) => a + b, 0) / sorted.length, p95: sorted[Math.ceil(sorted.length * 0.95) - 1] };
};
const method = (name, rankings, timing = null, extra = {}) => {
  const rows = evaluate(rankings);
  return { name, primary: summarize(primaryOnly(rows)), challenges: summarize(rows.filter(r => !primaryIds.has(r.id))), timing, ...extra,
    rows, rankings: rankings.map(list => list.map(e => positions.get(passageKey(e)))) };
};
const write = (name, value) => { writeFileSync(`${output}/${name}.json`, JSON.stringify({ at: new Date().toISOString(), corpusHash: dataset.corpusHash, queryHash: dataset.queryHash,
  planHash: hash(planFile), runtime: 'Node CPU; ONNX uses four threads. Cached document vectors exclude index construction. Native total RSS is not incremental browser RAM.',
  nativePeakRssBytes: process.resourceUsage().maxRSS * 1024, ...value }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ name, methods: value.methods?.map(m => ({ name: m.name, primary: m.primary, timing: m.timing })) }, null, 2)); };
const decodeVectors = (file, dimensions) => {
  const bytes = readFileSync(file), expected = dataset.entries.length * dimensions * 4;
  if (bytes.byteLength !== expected) throw new Error('Document vector cache shape mismatch.');
  return dataset.entries.map((_, i) => Float32Array.from({ length: dimensions }, (_, j) => bytes.readFloatLE((i * dimensions + j) * 4)));
};
const denseRanking = (vector, documents, sourceId) => dataset.entries.flatMap((entry, j) => entry.sourceId === sourceId ? [{ ...entry, score: cosine(documents[j], vector) }] : [])
  .sort((a, b) => b.score - a.score).slice(0, 50);
const bufferFor = file => { const bytes = readFileSync(file); return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); };

if (command === 'static') {
  const methods = [], sse = staticEncoder(new Tokenizer(json(`${sseAssets}/tokenizer.json`), {}), bufferFor(`${sseAssets}/model-f16.safetensors`));
  const tokenizerData = json(`${potionAssets}/tokenizer.json`), unknownId = tokenizerData.model.vocab[tokenizerData.model.unk_token];
  const potion = tableEncoder(new Tokenizer(tokenizerData, {}), bufferFor(`${potionAssets}/model.safetensors`), { unknownId });
  for (const probe of json(`${directory}/potion-public-parity.json`)) {
    const ids = new Tokenizer(tokenizerData, {}).encode(probe.text, { add_special_tokens: false }).ids.filter(id => id !== unknownId);
    if (JSON.stringify(ids) !== JSON.stringify(probe.ids) || cosine(probe.vector, potion.encode(probe.text)) < .999999) throw new Error('POTION Python/JS parity failed.');
  }
  for (const [name, encoder] of [['sse-f16', sse], ['potion-32m', potion]]) {
    const startIndex = performance.now(), documents = dataset.texts.map(t => encoder.encode(t)), indexMs = performance.now() - startIndex;
    encoder.encode('When is the assignment due?');
    const semantic = [], times = [];
    for (const [i, item] of dataset.cases.entries()) { const start = performance.now(); semantic.push(denseRanking(encoder.encode(dataset.queries[i]), documents, item.sourceId)); times.push(performance.now() - start); }
    const blend = plan.staticBlend, blendTimes = [], hybrid = semantic.map((list, i) => {
      const start = performance.now(), result = fuseRanks([list, bm25[i]], { weights: [1, blend.lexicalWeight], k: blend.k });
      blendTimes.push(times[i] + lexicalTimes[i] + performance.now() - start); return result;
    });
    methods.push(method(`${name}-pure`, semantic, timerSummary(times), { weightBytes: encoder.weightBytes, indexMs }),
      method(`${name}-hybrid`, hybrid, timerSummary(blendTimes)));
  }
  // Cross-runtime check: do not silently change the already measured SSE result.
  const previous = json(`${directory}/frozen-results.json`).rows, replay = methods.find(m => m.name === 'sse-f16-hybrid').rows;
  if (previous.some((r, i) => r.rank !== replay[i].rank || r.allEvidenceInContext !== replay[i].allEvidenceInContext)) throw new Error('SSE differs from frozen Chromium run.');
  write('static', { methods, parity: 'POTION public Python token IDs / NumPy mean pooling; SSE sealed Chromium per-query rank and completeness.' });
} else if (plan.dense.some(m => m.name === command)) {
  const spec = plan.dense.find(m => m.name === command), model = await localModel(spec);
  try {
    const startIndex = performance.now(), documents = spec.cache ? decodeVectors(spec.cache, spec.dimensions) : await Promise.all(dataset.texts.map(t => model.embed(t, spec.documentPrefix)));
    const indexMs = performance.now() - startIndex;
    await model.embed('When is the assignment due?', spec.queryPrefix);
    const semantic = [], times = [];
    for (const [i, item] of dataset.cases.entries()) {
      const start = performance.now(), vector = await model.embed(dataset.queries[i], spec.queryPrefix);
      semantic.push(denseRanking(vector, documents, item.sourceId)); times.push(performance.now() - start);
    }
    const hybridTimes = [], hybrid = semantic.map((list, i) => {
      const start = performance.now(), character = characters.search(dataset.queries[i], { sourceId: dataset.cases[i].sourceId }), blend = spec.blend;
      const rows = fuseRanks([list, bm25[i], character], { weights: [1, blend.lexicalWeight, blend.characterWeight], k: blend.k });
      hybridTimes.push(times[i] + lexicalTimes[i] + performance.now() - start); return rows;
    });
    write(command, { model: spec, fromDocumentCache: Boolean(spec.cache), indexMs, modelBytes: model.modelBytes,
      methods: [method(`${command}-pure`, semantic, timerSummary(times)), method(`${command}-hybrid`, hybrid, timerSummary(hybridTimes))] });
  } finally { await model.close(); }
} else if (command === 'colbert') {
  const config = json(`${colbertAssets}/onnx_config.json`), tokenizer = json(`${colbertAssets}/tokenizer.json`);
  const skipped = new Set(config.skiplist_words.map(w => tokenizer.model.vocab[w]).filter(Number.isInteger)), dimensions = config.embedding_dim;
  const model = await localModel({ directory: colbertAssets, file: 'model_int8.onnx', maxTokens: 512 });
  const encode = async (text, query = false) => {
    const tokens = await model.tokenize((query ? config.query_prefix : config.document_prefix) + (config.do_lower_case ? text.toLowerCase() : text), undefined,
      { max_length: query ? config.query_length : config.document_length });
    const tensor = (await model.run(tokens)).output;
    if (tensor.dims.at(-1) !== dimensions) throw new Error('ColBERT projection mismatch.');
    const values = [];
    for (let i = 0; i < tensor.dims[1]; i++) {
      if (!Number(tokens.attention_mask.data[i]) || (!query && skipped.has(Number(tokens.input_ids.data[i])))) continue;
      const vector = tensor.data.slice(i * dimensions, (i + 1) * dimensions), norm = Math.hypot(...vector);
      if (!norm || !Number.isFinite(norm)) throw new Error('Invalid ColBERT token norm.');
      for (const value of vector) values.push(value / norm);
    }
    return Float32Array.from(values);
  };
  try {
    // Regenerate from the pinned model instead of trusting the old unversioned cache.
    const startIndex = performance.now(), documents = [];
    for (const text of dataset.texts) documents.push(await encode(text));
    const indexMs = performance.now() - startIndex;
    const staticReport = json(`${output}/static.json`), semantic = staticReport.methods.find(m => m.name === 'sse-f16-pure').rankings.map(list => list.map(i => dataset.entries[i]));
    const semanticTimes = staticReport.methods.find(m => m.name === 'sse-f16-pure').timing;
    const rankings = { 'colbert-lexical-pure': [], 'colbert-lexical-hybrid': [], 'colbert-union-pure': [], 'colbert-union-hybrid': [] };
    const timing = Object.fromEntries(Object.keys(rankings).map(k => [k, []])), ceilings = { lexical: [], union: [] }, poolSizes = [];
    await encode('When is the assignment due?', true);
    for (const [i, item] of dataset.cases.entries()) {
      const start = performance.now(), query = await encode(dataset.queries[i], true), encodeMs = performance.now() - start;
      const base = lexicalBase[i], poolStart = performance.now(), union = candidateUnion([base, semantic[i]]);
      const expandedBase = fuseRanks([base, semantic[i]], plan.colbert.semanticBase), poolMs = performance.now() - poolStart;
      const scores = new Map(), score = entry => {
        const key = passageKey(entry); if (!scores.has(key)) scores.set(key, maxSim(query, documents[positions.get(key)], dimensions)); return scores.get(key);
      };
      const lexicalScoreStart = performance.now(); for (const e of base.slice(0, plan.colbert.originalCount)) score(e);
      const lexicalScoreMs = performance.now() - lexicalScoreStart;
      const unionStart = performance.now(); for (const e of union) score(e);
      const unionScoreMs = performance.now() - unionStart + lexicalScoreMs;
      const options = { count: plan.colbert.originalCount, k: plan.colbert.k };
      for (const hybrid of [false, true]) {
        const suffix = hybrid ? 'hybrid' : 'pure', originalWeight = hybrid ? plan.colbert.originalWeight : 0;
        let t = performance.now(); rankings[`colbert-lexical-${suffix}`].push(rerankCandidates(base, base, score, { ...options, originalWeight }));
        timing[`colbert-lexical-${suffix}`].push(lexicalTimes[i] + encodeMs + lexicalScoreMs + performance.now() - t);
        t = performance.now(); rankings[`colbert-union-${suffix}`].push(rerankCandidates(expandedBase, union, score, { count: union.length, k: plan.colbert.k, originalWeight }));
        // Semantic timing comes from the separate static process; record the component separately too.
        timing[`colbert-union-${suffix}`].push(lexicalTimes[i] + semanticTimes.mean + poolMs + encodeMs + unionScoreMs + performance.now() - t);
      }
      ceilings.lexical.push(evaluateRanking(item, base, { budget: 1e9, maxChunks: 1000 }).allEvidenceInContext);
      ceilings.union.push(evaluateRanking(item, union, { budget: 1e9, maxChunks: 1000 }).allEvidenceInContext); poolSizes.push(union.length);
    }
    write('colbert', { modelBytes: model.modelBytes, indexMs, indexBytes: documents.reduce((s, v) => s + v.byteLength, 0),
      timingNote: 'Lexical timings include measured lexical, encoding, MaxSim and reranking. Union sums measured ColBERT components and mean SSE retrieval from the separate process; not a browser end-to-end measurement.',
      methods: Object.entries(rankings).map(([name, lists]) => method(name, lists, timerSummary(timing[name]))), ceilings, poolSizes });
  } finally { await model.close(); }
} else if (command === 'report') {
  const files = ['static', ...plan.dense.map(m => m.name), 'colbert'], methods = [method('bm25', bm25), method('bm25-character', lexicalBase)];
  for (const name of files) {
    const report = json(`${output}/${name}.json`);
    if (report.planHash !== hash(planFile) || report.queryHash !== dataset.queryHash || report.corpusHash !== dataset.corpusHash) throw new Error('Incompatible extended result.');
    methods.push(...report.methods);
  }
  const overlap = primary.map(item => {
    const q = new Set(tokenize(dataset.queries[dataset.cases.findIndex(c => c.id === item.id)])), gold = new Set(tokenize(item.expected.map(e => e.quote).join(' ')));
    const shared = [...q].filter(t => gold.has(t)).length;
    return { id: item.id, score: shared / (q.size + gold.size - shared || 1) };
  }).sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));
  const lowIds = new Set(overlap.slice(0, Math.ceil(primary.length / 4)).map(x => x.id)), baseline = primaryOnly(methods[0].rows);
  const contrasts = methods.slice(1).map(m => ({ method: m.name, completeness: comparePaired(primary, primaryOnly(m.rows), baseline),
    firstResult: comparePaired(primary, primaryOnly(m.rows), baseline, { metric: 'hitAt1' }) }));
  const adjustedComplete = holm(contrasts.map(c => c.completeness.mcnemar.p)), adjustedFirst = holm(contrasts.map(c => c.firstResult.mcnemar.p));
  contrasts.forEach((c, i) => { c.holmCompletenessP = adjustedComplete[i]; c.holmFirstResultP = adjustedFirst[i]; });
  const compact = methods.map(m => ({ name: m.name, primary: m.primary, challenges: m.challenges,
    lowOverlap: summarize(m.rows.filter(r => lowIds.has(r.id))), timing: m.timing,
    rescues: primaryOnly(m.rows).filter((r, i) => r.allEvidenceInContext && !baseline[i].allEvidenceInContext).map(r => r.id),
    regressions: primaryOnly(m.rows).filter((r, i) => !r.allEvidenceInContext && baseline[i].allEvidenceInContext).map(r => r.id) }));
  const oracle = primary.map((c, i) => methods.some(m => primaryOnly(m.rows)[i].allEvidenceInContext));
  const colbert = json(`${output}/colbert.json`);
  write('summary', { methods: compact, contrasts, lowOverlap: { count: lowIds.size, threshold: overlap[lowIds.size - 1].score, cases: [...lowIds] },
    oracle: { successes: oracle.filter(Boolean).length, total: primary.length, note: 'Gold-selected union upper bound, not an executable selection policy.' },
    candidateCeilings: Object.fromEntries(Object.entries(colbert.ceilings).map(([name, values]) => [name, dataset.cases.filter(c => c.primary).reduce((sum, c) => sum + values[dataset.cases.findIndex(x => x.id === c.id)], 0)])) });
} else throw new Error('Use prepare, static, a registered dense model name, colbert, or report.');
