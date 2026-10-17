// ONNX worker for the browser-compatible model formats. Inference is local CPU.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { AutoModel, AutoTokenizer, AutoConfig, env } from './node_modules/@huggingface/transformers/dist/transformers.node.mjs';

process.umask(0o077);
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const model = JSON.parse(option('--model'));
const cache = path.resolve(option('--cache'));
mkdirSync(cache, { recursive: true });
env.cacheDir = path.join(cache, 'onnx');
env.allowLocalModels = false;
const started = performance.now();
const config = await AutoConfig.from_pretrained(model.repo, { revision: model.revision });
if (model.textOnly) { config.vision_config = null; config.audio_config = null; }
const tokenizer = await AutoTokenizer.from_pretrained(model.repo, { revision: model.revision });
const encoder = await AutoModel.from_pretrained(model.repo, { config, revision: model.revision, dtype: model.dtype,
  device: 'cpu', session_options: { intraOpNumThreads: 4, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false } });
const loadMs = performance.now() - started;
env.allowRemoteModels = false;
const dataset = JSON.parse(readFileSync(option('--dataset')));
const signature = createHash('sha256').update(JSON.stringify({ schema: 1, model, runtime: '4.3.1',
  corpusHash: dataset.report.corpusHash, queries: dataset.queries.map((q) => q.query) })).digest('hex');
const destination = path.join(cache, `${model.name}-${signature}`);
mkdirSync(destination, { recursive: true });
async function encode(text, prefix) {
  const inputs = await tokenizer(prefix + text, { padding: true, truncation: true, max_length: model.maxTokens });
  const output = await encoder(inputs);
  const vector = output.sentence_embedding?.tolist()[0];
  if (!vector || vector.length !== model.dimensions || !vector.every(Number.isFinite)) throw new Error('Missing or invalid projected sentence embedding.');
  const norm = Math.hypot(...vector);
  if (!norm) throw new Error('Zero embedding.');
  return Float32Array.from(vector, (v) => v / norm);
}
const documents = path.join(destination, 'documents.f32');
const fromCache = existsSync(documents) && readFileSync(documents).length === dataset.texts.length * model.dimensions * 4;
let indexMs = 0;
if (!fromCache) {
  const indexing = performance.now();
  const vectors = new Float32Array(dataset.texts.length * model.dimensions);
  for (const [i, text] of dataset.texts.entries()) {
    vectors.set(await encode(text, model.documentPrefix), i * model.dimensions);
    if (i % 256 === 0) console.log(`${model.name}: ${i + 1}/${dataset.texts.length} passages`);
  }
  indexMs = performance.now() - indexing;
  writeFileSync(documents, Buffer.from(vectors.buffer), { mode: 0o600 });
}
const queryVectors = new Float32Array(dataset.queries.length * model.dimensions), latencies = [];
for (const [i, query] of dataset.queries.entries()) {
  const t = performance.now();
  queryVectors.set(await encode(query.query, model.queryPrefix), i * model.dimensions);
  latencies.push(performance.now() - t);
}
const queries = path.join(destination, 'queries.f32');
writeFileSync(queries, Buffer.from(queryVectors.buffer), { mode: 0o600 });
const metadata = { ...model, runtime: { transformersJs: '4.3.1' }, signature, corpusHash: dataset.report.corpusHash,
  documents, queries, fromCache, loadMs: Math.round(loadMs), indexMs: Math.round(indexMs),
  meanQueryMs: latencies.reduce((sum, v) => sum + v, 0) / latencies.length,
  peakRssBytes: process.resourceUsage().maxRSS * 1024 };
writeFileSync(option('--out'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
await encoder.dispose();
