import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { validateBenchmark } from './validate-benchmark.mjs';

process.umask(0o077);
const directory = process.argv[2];
if (!directory) throw new Error('Usage: node experiments/discussions/seal-benchmark.mjs PRIVATE_BENCHMARK_DIRECTORY');
const capture = '.verify-tmp/retrieval-discussions.json', development = '.verify-tmp/discussion-retrieval/cases.json';
const casesFile = path.join(directory, 'cases.json');
const result = validateBenchmark(JSON.parse(readFileSync(capture)).discussions, JSON.parse(readFileSync(casesFile)),
  { development: JSON.parse(readFileSync(development)), primaryCount: 300 });
const files = [capture, development, ...['cases.json', 'primary.json', 'challenges.json', 'diagnostics.json', 'annotations.mjs', 'candidate-decisions.json', 'audit.json'].map(f => path.join(directory, f)),
  ...['BENCHMARK_V2_PROTOCOL.md', 'benchmark-static-browser.mjs', 'corpus.mjs', 'dataset.mjs', 'lexical.mjs', 'static-embedding.mjs', 'statistics.mjs', 'validate-benchmark.mjs'].map(f => `experiments/discussions/${f}`),
  'experiments/retrieval/ranking.mjs',
  'experiments/retrieval/modern-js/node_modules/@huggingface/tokenizers/dist/tokenizers.mjs',
  ...['model-f16.safetensors', 'tokenizer.json', 'public-parity-f16.json'].map(f =>
    `.verify-tmp/discussion-retrieval/ram-research/RikkaBotan--stable-static-embedding-fast-retrieval-mrl-en-v2/${f}`)];
const seal = { version: 2, sealedAt: new Date().toISOString(), primaryQuestions: result.primaryQuestions,
  questions: result.questions, sources: result.sources,
  configurations: { representation: { unit: 'thread', size: 1000, overlap: 150 }, context: { budget: 6000, maxChunks: 12 },
    sse: { lexicalWeight: 1, characterWeight: 0, k: 10 }, character: { weights: [1, 0.5], k: 20 },
    model: { repo: 'RikkaBotan/stable-static-embedding-fast-retrieval-mrl-en-v2', revision: '928b418b2741b7f7b1b557a53845ac88ad5054c4', dimensions: 512, storage: 'float16' } },
  hashes: Object.fromEntries(files.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')])),
  limitations: ['Source-checked single-author synthetic questions, purposive topic/source quotas.',
    'Repeated facts can connect distinct threads; report source/topic-cluster sensitivity.',
    'Exact labeled-span coverage may reject an equally valid unlabeled source.',
    'No generated-answer or abstention accuracy is measured.'] };
writeFileSync(path.join(directory, 'sealed.json'), JSON.stringify(seal, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ sealedAt: seal.sealedAt, questions: seal.questions, primaryQuestions: seal.primaryQuestions, sources: seal.sources }));
